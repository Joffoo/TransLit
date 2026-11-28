export interface CloudflareWorkerEnv {
  ASSETS?: {
    fetch(request: Request | string): Promise<Response>;
  };
}

const FORBIDDEN_TARGET_HOSTS = new Set([
  '0.0.0.0',
  '100.100.100.200',
  '169.254.169.254',
  'metadata.google.internal',
  '[fd00:ec2::254]',
]);

export function isForbiddenTargetHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!lower) return true;
  if (FORBIDDEN_TARGET_HOSTS.has(lower)) return true;
  if (lower.startsWith('169.254.')) return true;
  if (/^\[::ffff:(?:a9fe:|169\.254\.)/i.test(lower)) return true;
  if (lower.endsWith('.internal')) return true;
  return false;
}

export function isSelfProxyPath(pathname: string): boolean {
  const normalized = (pathname || '').replace(/\/+/g, '/');
  return normalized === '/__api_proxy' || normalized.startsWith('/__api_proxy/');
}

function buildProxyCorsHeaders(request: Request): Record<string, string> {
  return {
    'access-control-allow-origin': request.headers.get('origin') || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Api-Key, X-Target-Url',
    'access-control-expose-headers': 'x-translit-proxy',
    'access-control-max-age': '86400',
    'vary': 'Origin',
    'x-translit-proxy': '1',
  };
}

export async function handleApiProxyRequest(request: Request): Promise<Response> {
  const baseHeaders = buildProxyCorsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: baseHeaders,
    });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        ...baseHeaders,
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  const targetUrl = request.headers.get('x-target-url')?.trim();
  if (!targetUrl) {
    return new Response('Missing X-Target-Url header', {
      status: 400,
      headers: {
        ...baseHeaders,
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return new Response('Invalid X-Target-Url header', {
      status: 400,
      headers: {
        ...baseHeaders,
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return new Response('Unsupported X-Target-Url protocol', {
      status: 400,
      headers: {
        ...baseHeaders,
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (isForbiddenTargetHost(parsedUrl.hostname)) {
    return new Response('Forbidden X-Target-Url host', {
      status: 403,
      headers: {
        ...baseHeaders,
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (
    isSelfProxyPath(parsedUrl.pathname) ||
    request.headers.get('x-translit-proxy-hop') === '1'
  ) {
    return new Response('Cannot proxy to /__api_proxy', {
      status: 400,
      headers: {
        ...baseHeaders,
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  const forwardHeaders = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) {
    forwardHeaders.set('content-type', contentType);
  } else if (request.method === 'POST') {
    forwardHeaders.set('content-type', 'application/json');
  }

  const authorization = request.headers.get('authorization');
  if (authorization) {
    forwardHeaders.set('authorization', authorization);
  }

  const xApiKey = request.headers.get('x-api-key');
  if (xApiKey) {
    forwardHeaders.set('x-api-key', xApiKey);
  }

  forwardHeaders.set('accept', request.headers.get('accept') || 'application/json');
  forwardHeaders.set('user-agent', request.headers.get('user-agent') || 'TransLit-Proxy/2.0');
  forwardHeaders.set('x-translit-proxy-hop', '1');

  const bodyBuffer = request.method === 'POST' ? await request.arrayBuffer() : undefined;
  const body = bodyBuffer && bodyBuffer.byteLength > 0 ? bodyBuffer : undefined;

  try {
    const apiRes = await fetch(parsedUrl.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body,
      redirect: 'follow',
    });

    const upstreamContentType = apiRes.headers.get('content-type') || 'application/json';
    const responseHeaders = new Headers(baseHeaders);
    responseHeaders.set('content-type', upstreamContentType);
    if (upstreamContentType.toLowerCase().includes('text/event-stream')) {
      responseHeaders.set('cache-control', 'no-cache, no-transform');
      responseHeaders.set('x-accel-buffering', 'no');
    }

    return new Response(apiRes.body, {
      status: apiRes.status,
      statusText: apiRes.statusText,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: 'Proxy error',
        detail: String(err?.message ?? err),
      }),
      {
        status: 502,
        headers: {
          ...baseHeaders,
          'content-type': 'application/json',
          'x-translit-proxy-error': '1',
          'access-control-expose-headers': 'x-translit-proxy, x-translit-proxy-error',
        },
      }
    );
  }
}

export default {
  async fetch(request: Request, env?: CloudflareWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (isSelfProxyPath(url.pathname)) {
      return handleApiProxyRequest(request);
    }

    if (env?.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
