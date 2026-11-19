import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Dev-only middleware plugin: intercepts /__api_proxy requests and
 * forwards them server-side to bypass browser CORS restrictions.
 * The real target URL is passed via the X-Target-Url request header.
 * This plugin only runs during `vite dev` and is never included in production builds.
 */
function apiProxyPlugin(): Plugin {
  return {
    name: 'translit-api-proxy',
    configureServer(server) {
      server.middlewares.use('/__api_proxy', async (req: IncomingMessage, res: ServerResponse) => {
        const targetUrl = req.headers['x-target-url'] as string | undefined;
        if (!targetUrl) {
          res.writeHead(400);
          res.end('Missing X-Target-Url header');
          return;
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(targetUrl);
        } catch {
          res.writeHead(400);
          res.end('Invalid X-Target-Url header');
          return;
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          res.writeHead(400);
          res.end('Unsupported X-Target-Url protocol');
          return;
        }

        // Collect request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);

        // Forward to actual API endpoint (Node.js fetch is not browser-sandboxed)
        const forwardHeaders: Record<string, string> = {
          'content-type': req.headers['content-type'] ?? 'application/json',
        };
        if (req.headers['authorization']) {
          forwardHeaders['authorization'] = req.headers['authorization'] as string;
        }

        try {
          const apiRes = await fetch(parsedUrl.toString(), {
            method: req.method ?? 'POST',
            headers: forwardHeaders,
            body: body.length > 0 ? body : undefined,
          });

          res.writeHead(apiRes.status, {
            'content-type': apiRes.headers.get('content-type') || 'application/json',
          });
          const text = await apiRes.text();
          res.end(text);
        } catch (err: any) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'Proxy error', detail: String(err?.message ?? err) }));
        }
      });
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
