import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';
import { isForbiddenTargetHost, isSelfProxyPath } from './cloudflare/worker';

let cachedEnvProxyAgent: unknown | null | undefined = undefined;

async function getEnvProxyDispatcher(parsedUrl: URL): Promise<unknown | undefined> {
  const hostname = parsedUrl.hostname.trim().toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  ) {
    return undefined;
  }

  const hasProxyEnv = Boolean(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy
  );
  if (!hasProxyEnv) return undefined;

  if (cachedEnvProxyAgent !== undefined) {
    return cachedEnvProxyAgent ?? undefined;
  }

  try {
    const undiciModName: string = 'undici';
    const undici: any = await import(/* @vite-ignore */ undiciModName);
    cachedEnvProxyAgent = undici?.EnvHttpProxyAgent ? new undici.EnvHttpProxyAgent() : null;
  } catch {
    cachedEnvProxyAgent = null;
  }
  return cachedEnvProxyAgent ?? undefined;
}

function attachApiProxyMiddleware(middlewares: {
  use: (route: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void;
}) {
  middlewares.use('/__api_proxy', async (req: IncomingMessage, res: ServerResponse) => {
    const baseHeaders: Record<string, string> = {
      'access-control-allow-origin': (req.headers['origin'] as string) || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, X-Api-Key, X-Target-Url',
      'access-control-expose-headers': 'x-translit-proxy',
      'access-control-max-age': '86400',
      vary: 'Origin',
      'x-translit-proxy': '1',
    };

    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204, baseHeaders);
      res.end();
      return;
    }

    if (method !== 'GET' && method !== 'POST') {
      res.writeHead(405, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const rawTargetUrl = req.headers['x-target-url'] as string | undefined;
    const targetUrl = rawTargetUrl?.trim();
    if (!targetUrl) {
      res.writeHead(400, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Missing X-Target-Url header');
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      res.writeHead(400, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid X-Target-Url header');
      return;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      res.writeHead(400, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unsupported X-Target-Url protocol');
      return;
    }
    if (isForbiddenTargetHost(parsedUrl.hostname)) {
      res.writeHead(403, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden X-Target-Url host');
      return;
    }
    if (
      isSelfProxyPath(parsedUrl.pathname) ||
      req.headers['x-translit-proxy-hop'] === '1'
    ) {
      res.writeHead(400, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Cannot proxy to /__api_proxy');
      return;
    }

    // Collect request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    // Forward to actual API endpoint (Node.js fetch is not browser-sandboxed)
    const forwardHeaders: Record<string, string> = {
      accept: (req.headers['accept'] as string) || 'application/json',
      'user-agent': (req.headers['user-agent'] as string) || 'TransLit-Proxy/2.0',
      'x-translit-proxy-hop': '1',
    };
    if (req.headers['content-type']) {
      forwardHeaders['content-type'] = req.headers['content-type'] as string;
    } else if (method === 'POST') {
      forwardHeaders['content-type'] = 'application/json';
    }
    if (req.headers['authorization']) {
      forwardHeaders['authorization'] = req.headers['authorization'] as string;
    }
    if (req.headers['x-api-key']) {
      forwardHeaders['x-api-key'] = req.headers['x-api-key'] as string;
    }

    const baseFetchInit: RequestInit = {
      method,
      headers: forwardHeaders,
      body: method === 'POST' && body.length > 0 ? body : undefined,
    };

    try {
      const dispatcher = await getEnvProxyDispatcher(parsedUrl);
      let apiRes: Response;
      if (dispatcher) {
        try {
          apiRes = await fetch(parsedUrl.toString(), {
            ...baseFetchInit,
            dispatcher,
          } as RequestInit);
        } catch {
          apiRes = await fetch(parsedUrl.toString(), baseFetchInit);
        }
      } else {
        apiRes = await fetch(parsedUrl.toString(), baseFetchInit);
      }

      res.writeHead(apiRes.status, {
        ...baseHeaders,
        'content-type': apiRes.headers.get('content-type') || 'application/json',
      });
      const text = await apiRes.text();
      res.end(text);
    } catch (err: any) {
      const causeMsg = err?.cause?.code || err?.cause?.message || '';
      const baseMsg = String(err?.message ?? err);
      const detail = causeMsg ? `${baseMsg} (${causeMsg})` : baseMsg;
      res.writeHead(502, {
        ...baseHeaders,
        'content-type': 'application/json',
        'x-translit-proxy-error': '1',
        'access-control-expose-headers': 'x-translit-proxy, x-translit-proxy-error',
      });
      res.end(JSON.stringify({ error: 'Proxy error', detail }));
    }
  });
}

/**
 * Local Vite dev & preview middleware plugin: intercepts /__api_proxy requests and
 * forwards them server-side to bypass browser CORS restrictions.
 * In Cloudflare Workers/Pages production, the same /__api_proxy contract is served
 * by cloudflare/worker.ts and functions/__api_proxy.ts.
 */
function apiProxyPlugin(): Plugin {
  return {
    name: 'translit-api-proxy',
    configureServer(server) {
      attachApiProxyMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachApiProxyMiddleware(server.middlewares);
    },
  };
}

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '127.0.0.1',
      },
      build: {
        rollupOptions: {
          output: {
            manualChunks: {
              'react-vendor': ['react', 'react-dom'],
              'epub-vendor': ['jszip', 'marked', 'katex', 'franc-min'],
              'ui-vendor': ['react-markdown', 'lucide-react'],
            },
          },
        },
      },
      plugins: [react(), apiProxyPlugin()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
