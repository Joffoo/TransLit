import assert from 'node:assert/strict';
import http from 'node:http';
import worker, { handleApiProxyRequest } from '../cloudflare/worker';
import { onRequest as pagesOnRequest } from '../functions/__api_proxy';
import {
  AiService,
  buildApiEndpointCandidates,
  canUseSameOriginApiProxy,
  fetchViaProxyOrDirect,
} from '../services/geminiService';
import { AppConfig } from '../types';

async function main() {
  // 1. Unit tests for buildApiEndpointCandidates
  assert.deepEqual(
    buildApiEndpointCandidates('https://origincoder.com/', 'models'),
    ['https://origincoder.com/v1/models', 'https://origincoder.com/models'],
    'Bare origin with trailing slash should try /v1/models first then /models'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('https://origincoder.com', 'chat/completions'),
    ['https://origincoder.com/v1/chat/completions', 'https://origincoder.com/chat/completions'],
    'Bare origin without slash should try /v1/chat/completions first then /chat/completions'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('origincoder.com', 'models'),
    ['https://origincoder.com/v1/models', 'https://origincoder.com/models'],
    'Scheme-less domain should normalize to https:// and try /v1/models then /models'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('localhost:11434', 'models'),
    ['http://localhost:11434/v1/models', 'http://localhost:11434/models'],
    'Scheme-less localhost should normalize to http:// and try /v1/models then /models'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('https://origincoder.com/v1/', 'models'),
    ['https://origincoder.com/v1/models'],
    'Explicit /v1 baseUrl should produce single candidate'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('https://open.bigmodel.cn/api/paas/v4', 'chat/completions'),
    ['https://open.bigmodel.cn/api/paas/v4/chat/completions'],
    'Custom version path should be preserved as-is'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('https://generativelanguage.googleapis.com/v1beta/openai', 'models'),
    ['https://generativelanguage.googleapis.com/v1beta/openai/models'],
    'OpenAI-compatible /v1beta/openai path should produce single candidate'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('https://openrouter.ai/api', 'models'),
    ['https://openrouter.ai/api/models', 'https://openrouter.ai/api/v1/models'],
    'Custom sub-path without version segment should try <path>/models then <path>/v1/models'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('https://origincoder.com/v1/chat/completions', 'models'),
    ['https://origincoder.com/v1/models'],
    'Accidental /chat/completions suffix in baseUrl should be stripped cleanly'
  );
  assert.deepEqual(
    buildApiEndpointCandidates('   ', 'models'),
    [],
    'Blank baseUrl should return empty candidates'
  );

  // 2. Start a real local upstream HTTP server that simulates a CORS-hostile API gateway
  //    (rejects any request containing an Origin header with 403 Forbidden, just like origincoder.com preflight)
  let rootOnlyMode = false;
  let rootOnlyHtml400Mode = false;
  const upstreamServer = http.createServer(async (req, res) => {
    if (req.headers['origin']) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('CORS Origin header rejected by upstream');
      return;
    }

    if (req.headers['authorization'] !== 'Bearer sk-test-valid') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'INVALID_API_KEY', message: 'Invalid API key' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf-8');

    if (req.method === 'GET' && rootOnlyHtml400Mode && req.url === '/v1/models') {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>400 Bad Route</body></html>');
      return;
    }

    if (req.method === 'GET' && !rootOnlyMode && !rootOnlyHtml400Mode && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'minimaxai/minimax-m2.1' }, { id: 'deepseek-ai/deepseek-v3.2' }],
        })
      );
      return;
    }

    if (req.method === 'GET' && (rootOnlyMode || rootOnlyHtml400Mode) && req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'custom-root-model' }],
        })
      );
      return;
    }

    if (req.method === 'POST' && !rootOnlyMode && req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(rawBody || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `<translation>Pong (${parsed.model})</translation>` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: req.url }));
  });

  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const addr = upstreamServer.address();
  assert.ok(addr && typeof addr === 'object');
  const upstreamOrigin = `http://127.0.0.1:${addr.port}`;

  try {
    // 3. Test Cloudflare Worker & Pages Function edge cases and security guards
    {
      // OPTIONS preflight
      const optRes = await handleApiProxyRequest(
        new Request('https://translit.joffoo.workers.dev/__api_proxy', {
          method: 'OPTIONS',
          headers: { Origin: 'https://translit.joffoo.workers.dev' },
        })
      );
      assert.equal(optRes.status, 204);
      assert.equal(optRes.headers.get('x-translit-proxy'), '1');
      assert.equal(
        optRes.headers.get('access-control-allow-origin'),
        'https://translit.joffoo.workers.dev'
      );

      // Unsupported method (DELETE)
      const delRes = await handleApiProxyRequest(
        new Request('https://translit.joffoo.workers.dev/__api_proxy', {
          method: 'DELETE',
          headers: { 'X-Target-Url': `${upstreamOrigin}/v1/models` },
        })
      );
      assert.equal(delRes.status, 405);
      assert.equal(delRes.headers.get('x-translit-proxy'), '1');

      // Missing X-Target-Url
      const missingRes = await handleApiProxyRequest(
        new Request('https://translit.joffoo.workers.dev/__api_proxy', {
          method: 'GET',
        })
      );
      assert.equal(missingRes.status, 400);

      // Invalid URL
      const invalidRes = await handleApiProxyRequest(
        new Request('https://translit.joffoo.workers.dev/__api_proxy', {
          method: 'GET',
          headers: { 'X-Target-Url': 'not a valid url' },
        })
      );
      assert.equal(invalidRes.status, 400);

      // Disallowed protocol
      const protoRes = await handleApiProxyRequest(
        new Request('https://translit.joffoo.workers.dev/__api_proxy', {
          method: 'GET',
          headers: { 'X-Target-Url': 'file:///etc/passwd' },
        })
      );
      assert.equal(protoRes.status, 400);

      // Cloud metadata SSRF protection (including trailing-dot FQDN, ECS link-local, IPv4-mapped IPv6)
      for (const forbiddenUrl of [
        'http://169.254.169.254/latest/meta-data/',
        'http://169.254.170.2/v2/credentials',
        'http://metadata.google.internal./computeMetadata/v1/',
        'http://[::ffff:169.254.169.254]/latest/meta-data/',
        'http://100.100.100.200/latest/meta-data/',
      ]) {
        const ssrfRes = await handleApiProxyRequest(
          new Request('https://translit.joffoo.workers.dev/__api_proxy', {
            method: 'GET',
            headers: { 'X-Target-Url': forbiddenUrl },
          })
        );
        assert.equal(ssrfRes.status, 403, `Expected 403 for SSRF target ${forbiddenUrl}`);
      }

      // Self-proxy recursion guard (including double-slash path and hop header)
      for (const selfTarget of [
        'https://translit.joffoo.workers.dev/__api_proxy',
        'https://translit.joffoo.workers.dev//__api_proxy',
        'https://translit.joffoo.workers.dev///__api_proxy/sub',
      ]) {
        const selfRes = await handleApiProxyRequest(
          new Request('https://translit.joffoo.workers.dev/__api_proxy', {
            method: 'GET',
            headers: { 'X-Target-Url': selfTarget },
          })
        );
        assert.equal(selfRes.status, 400, `Expected 400 for self-proxy target ${selfTarget}`);
      }

      const hopLoopRes = await handleApiProxyRequest(
        new Request('https://translit.joffoo.workers.dev/__api_proxy', {
          method: 'GET',
          headers: {
            'X-Target-Url': `${upstreamOrigin}/v1/models`,
            'x-translit-proxy-hop': '1',
          },
        })
      );
      assert.equal(hopLoopRes.status, 400, 'Expected 400 when x-translit-proxy-hop is already present');

      // Static asset delegation for non-proxy routes on Cloudflare Worker
      const assetRes = await worker.fetch(
        new Request('https://translit.joffoo.workers.dev/assets/app.js'),
        {
          ASSETS: {
            async fetch() {
              return new Response('console.log("asset");', { status: 200 });
            },
          },
        }
      );
      assert.equal(assetRes.status, 200);
      assert.equal(await assetRes.text(), 'console.log("asset");');

      // Cloudflare Pages Function onRequest forwarding (strips Origin header so upstream succeeds)
      const pagesRes = await pagesOnRequest({
        request: new Request('https://translit.pages.dev/__api_proxy', {
          method: 'GET',
          headers: {
            Origin: 'https://translit.pages.dev',
            Authorization: 'Bearer sk-test-valid',
            'X-Target-Url': `${upstreamOrigin}/v1/models`,
          },
        }),
      });
      assert.equal(pagesRes.status, 200);
      assert.equal(pagesRes.headers.get('x-translit-proxy'), '1');
      assert.equal(pagesRes.headers.get('access-control-expose-headers'), 'x-translit-proxy');
      const pagesData = await pagesRes.json();
      assert.equal(pagesData.data.length, 2);
    }

    // 4. End-to-end AiService in simulated browser environment routing through Cloudflare Worker
    const originalWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;

    try {
      (globalThis as any).window = {
        location: {
          protocol: 'https:',
          origin: 'https://translit.joffoo.workers.dev',
        },
      };
      assert.equal(canUseSameOriginApiProxy(), true);

      // Route browser relative `/__api_proxy` calls into our Cloudflare Worker `worker.fetch`
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (typeof input === 'string' && input.startsWith('/__api_proxy')) {
          const req = new Request(`https://translit.joffoo.workers.dev${input}`, {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string>),
              // Simulate browser automatically attaching Origin header
              Origin: 'https://translit.joffoo.workers.dev',
            },
          });
          return worker.fetch(req);
        }
        return originalFetch(input, init);
      };

      // Verify fetchViaProxyOrDirect preserves Headers instance (new Headers(...))
      const headersInstanceRes = await fetchViaProxyOrDirect(`${upstreamOrigin}/v1/models`, {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer sk-test-valid' }),
      });
      assert.equal(headersInstanceRes.status, 200);

      const baseConfig: AppConfig = {
        // Bare origin without /v1 (just like user's screenshot: "https://origincoder.com/")
        baseUrl: `${upstreamOrigin}/`,
        apiKey: 'sk-test-valid',
        modelName: 'minimaxai/minimax-m2.1',
        sourceLanguage: 'English',
        enableGlossary: false,
        enableProofreading: false,
        smartSkip: true,
        useRecommendedPrompts: true,
        additionalContext: '',
      };

      const service = new AiService(baseConfig);
      const models = await service.fetchModels();
      assert.deepEqual(models, ['deepseek-ai/deepseek-v3.2', 'minimaxai/minimax-m2.1']);

      const connected = await service.testConnection();
      assert.equal(connected, true);

      // Scenario B1: Upstream only mounts `/models` (404 on `/v1/models`) -> automatic fallback
      rootOnlyMode = true;
      const rootModels = await service.fetchModels();
      assert.deepEqual(rootModels, ['custom-root-model']);
      rootOnlyMode = false;

      // Scenario B2: Upstream returns 400 with HTML error page on `/v1/models` and serves `/models` -> automatic fallback
      rootOnlyHtml400Mode = true;
      const htmlFallbackModels = await service.fetchModels();
      assert.deepEqual(htmlFallbackModels, ['custom-root-model']);
      rootOnlyHtml400Mode = false;

      // Scenario B3: 404 on all candidates fails fast without 28s exponential backoff
      const missingService = new AiService({
        ...baseConfig,
        baseUrl: `${upstreamOrigin}/nonexistent-v1`,
      });
      const t0 = Date.now();
      await assert.rejects(() => missingService.testConnection(), /API Error 404/);
      const elapsedMs = Date.now() - t0;
      assert.ok(elapsedMs < 1500, `404 should fail fast without retry backoff (took ${elapsedMs}ms)`);

      // Scenario C: Pure static host where `/__api_proxy` is not mounted (returns 405 or S3 403 XML without x-translit-proxy)
      //             -> automatic fallback to direct fetch
      for (const staticStatus of [405, 403, 501]) {
        let directFetchCalled = false;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          if (typeof input === 'string' && input.startsWith('/__api_proxy')) {
            return new Response('<Error>MethodNotAllowed</Error>', {
              status: staticStatus,
              headers: { 'content-type': 'application/xml' },
            });
          }
          directFetchCalled = true;
          return originalFetch(input, init);
        };

        const fallbackModels = await service.fetchModels();
        assert.equal(
          directFetchCalled,
          true,
          `Should fall back to direct fetch when /__api_proxy returns static ${staticStatus}`
        );
        assert.deepEqual(fallbackModels, ['deepseek-ai/deepseek-v3.2', 'minimaxai/minimax-m2.1']);
      }

      // Scenario D: Proxy-originated 502 (x-translit-proxy: 1 + x-translit-proxy-error: 1) falls back to direct fetch;
      //             upstream 502 without x-translit-proxy-error does NOT double-fetch;
      //             if direct fetch also fails (CORS/network), caller receives original proxy 502 detail.
      {
        let directCalls = 0;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          if (typeof input === 'string' && input.startsWith('/__api_proxy')) {
            return new Response(JSON.stringify({ error: 'Proxy error', detail: 'fetch failed (ECONNREFUSED)' }), {
              status: 502,
              headers: {
                'content-type': 'application/json',
                'x-translit-proxy': '1',
                'x-translit-proxy-error': '1',
              },
            });
          }
          directCalls += 1;
          return originalFetch(input, init);
        };

        const recovered = await fetchViaProxyOrDirect(`${upstreamOrigin}/v1/models`, {
          method: 'GET',
          headers: { Authorization: 'Bearer sk-test-valid' },
        });
        assert.equal(directCalls, 1, 'Should retry directly once on proxy-originated 502');
        assert.equal(recovered.status, 200);
        const recData = await recovered.json();
        assert.equal(recData.data.length, 2);

        // When direct fallback also fails (e.g. CORS error thrown), preserve original 502 proxy diagnostic
        globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
          if (typeof input === 'string' && input.startsWith('/__api_proxy')) {
            return new Response(JSON.stringify({ error: 'Proxy error', detail: 'fetch failed (ETIMEDOUT)' }), {
              status: 502,
              headers: {
                'content-type': 'application/json',
                'x-translit-proxy': '1',
                'x-translit-proxy-error': '1',
              },
            });
          }
          throw new TypeError('Failed to fetch (simulated CORS error)');
        };

        const preserved502 = await fetchViaProxyOrDirect(`${upstreamOrigin}/v1/models`, {
          method: 'GET',
          headers: { Authorization: 'Bearer sk-test-valid' },
        });
        assert.equal(preserved502.status, 502);
        const errBody = await preserved502.json();
        assert.equal(errBody.detail, 'fetch failed (ETIMEDOUT)');

        // Upstream 502 without x-translit-proxy-error must NOT trigger redundant direct fetch
        let upstreamDirectCalls = 0;
        globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
          if (typeof input === 'string' && input.startsWith('/__api_proxy')) {
            return new Response('Bad Gateway from upstream', {
              status: 502,
              headers: {
                'content-type': 'text/plain',
                'x-translit-proxy': '1',
              },
            });
          }
          upstreamDirectCalls += 1;
          return originalFetch(input);
        };

        const upstream502 = await fetchViaProxyOrDirect(`${upstreamOrigin}/v1/models`, {
          method: 'GET',
          headers: { Authorization: 'Bearer sk-test-valid' },
        });
        assert.equal(upstreamDirectCalls, 0, 'Upstream 502 without x-translit-proxy-error must not re-fetch');
        assert.equal(upstream502.status, 502);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  } finally {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }

  console.log('ALL CORS proxy & Cloudflare Worker verification tests passed!');
}

main().catch((err) => {
  console.error('verify_cors_proxy failed:', err);
  process.exit(1);
});
