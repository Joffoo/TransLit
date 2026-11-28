import assert from 'node:assert/strict';
import http from 'node:http';
import worker from '../cloudflare/worker';
import { AiService, consumeChatCompletionResponse } from '../services/geminiService';
import { AppConfig, TokenUsage } from '../types';

function makeChunkedSseResponse(
  chunks: Uint8Array[],
  contentType: string = 'text/event-stream; charset=utf-8'
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

async function main() {
  console.log('--- Running SSE Streaming Verification Tests ---');

  const encoder = new TextEncoder();
  const baseConfig: AppConfig = {
    apiKey: 'sk-test-sse',
    baseUrl: 'https://mock.translit.local/v1',
    modelName: 'mock-reasoning-model',
    sourceLanguage: 'Japanese',
    additionalContext: '',
    enableProofreading: false,
    useRecommendedPrompts: false,
    smartSkip: true,
    enableGlossary: false,
  };

  // 1. Standard SSE + multibyte UTF-8 character split across chunks + reasoning_content + comments + split usage
  {
    const frame1 =
      ': OPENROUTER PROCESSING\n\n' +
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"内部思考过程不应该泄露"}}],"usage":{"prompt_tokens":120,"prompt_tokens_details":{"cached_tokens":80}}}\n\n' +
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"<translation>[B1] 你好"}}]}\n\n';
    const splitChar = '世'; // 3-byte UTF-8: 0xE4 0xB8 0x96
    const frame2Prefix = encoder.encode('data: {"id":"1","choices":[{"index":0,"delta":{"content":"');
    const splitCharBytes = encoder.encode(splitChar);
    const frame2Suffix = encoder.encode(
      '界</translation>"}}]}\n\n' +
        'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"id":"1","choices":[],"usage":{"completion_tokens":45,"completion_tokens_details":{"reasoning_tokens":30},"total_tokens":165}}\n\n' +
        'data: [DONE]\n\n'
    );

    const chunk1 = new Uint8Array([
      ...encoder.encode(frame1),
      ...frame2Prefix,
      splitCharBytes[0],
    ]);
    const chunk2 = new Uint8Array([
      splitCharBytes[1],
      splitCharBytes[2],
      ...frame2Suffix,
    ]);

    const res = makeChunkedSseResponse([chunk1, chunk2]);
    const parsed = await consumeChatCompletionResponse(res);
    assert.equal(parsed.content, '<translation>[B1] 你好世界</translation>');
    assert.ok(!parsed.content.includes('内部思考过程'), 'reasoning_content must never leak into content');
    assert.deepEqual(parsed.usage, {
      promptTokens: 120,
      cachedTokens: 80,
      completionTokens: 45,
      reasoningTokens: 30,
      totalTokens: 165,
    });
    console.log('  [OK] SSE UTF-8 split across chunks, reasoning isolation, comments & split usage');
  }

  // 2. Mislabeled Content-Type: text/plain SSE auto-detection
  {
    const payload =
      'data: {"choices":[{"delta":{"content":"Pong"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const res = makeChunkedSseResponse([encoder.encode(payload)], 'text/plain; charset=utf-8');
    const parsed = await consumeChatCompletionResponse(res);
    assert.equal(parsed.content, 'Pong');
    console.log('  [OK] Mislabeled text/plain SSE stream auto-detected');
  }

  // 3. Non-streaming application/json fallback (real Response & body-less mock object)
  {
    const jsonRes = new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Non-streamed response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    const parsedA = await consumeChatCompletionResponse(jsonRes);
    assert.equal(parsedA.content, 'Non-streamed response');
    assert.equal(parsedA.usage?.totalTokens, 14);

    const bodylessMock = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: 'Bodyless mock response' } }],
        }),
    } as unknown as Response;
    const parsedB = await consumeChatCompletionResponse(bodylessMock);
    assert.equal(parsedB.content, 'Bodyless mock response');
    console.log('  [OK] Non-streaming JSON Response & body-less mock fallback');
  }

  // 4. Mid-stream SSE error frame throws API Stream Error (not silent empty/success)
  {
    const errPayload =
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
      'data: {"error":{"message":"Upstream overloaded","code":503}}\n\n';
    const res = makeChunkedSseResponse([encoder.encode(errPayload)]);
    await assert.rejects(
      () => consumeChatCompletionResponse(res),
      /API Stream Error: Upstream overloaded/
    );
    console.log('  [OK] Mid-stream SSE error frame rejected cleanly');
  }

  // 5. Premature stream truncation without finish_reason or [DONE] throws
  {
    const truncatedPayload = 'data: {"choices":[{"delta":{"content":"半截译文"}}]}\n\n';
    const res = makeChunkedSseResponse([encoder.encode(truncatedPayload)]);
    await assert.rejects(
      () => consumeChatCompletionResponse(res),
      /API stream ended unexpectedly before completion/
    );
    console.log('  [OK] Premature SSE stream truncation rejected cleanly');
  }

  const origFetch = globalThis.fetch;
  const origWindow = (globalThis as any).window;

  try {
    // 6. Graceful stream_options 400 downgrade & caching on AiService instance
    {
      const seenBodies: any[] = [];
      (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        seenBodies.push(body);
        if (body.stream_options) {
          return new Response(
            JSON.stringify({ error: { message: "Unknown parameter: 'stream_options'" } }),
            { status: 400, headers: { 'content-type': 'application/json' } }
          );
        }
        const sse =
          'data: {"choices":[{"delta":{"content":"<translation>[B1] 降级成功</translation>"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n';
        return makeChunkedSseResponse([encoder.encode(sse)]);
      };

      const svc = new AiService(baseConfig);
      const res1 = await svc.translateContent('Hello world.', 'Chinese (Simplified)', 'Translate.');
      assert.equal(res1.content, '降级成功');
      assert.equal(seenBodies.length, 2, 'First call should downgrade after 400 on stream_options');
      assert.equal(seenBodies[0].stream, true);
      assert.deepEqual(seenBodies[0].stream_options, { include_usage: true });
      assert.equal(seenBodies[1].stream, true);
      assert.equal('stream_options' in seenBodies[1], false);

      const res2 = await svc.translateContent('Second call.', 'Chinese (Simplified)', 'Translate.');
      assert.equal(res2.content, '降级成功');
      assert.equal(seenBodies.length, 3, 'Second call should omit stream_options immediately');
      assert.equal(seenBodies[2].stream, true);
      assert.equal('stream_options' in seenBodies[2], false);
      console.log('  [OK] Graceful stream_options 400 downgrade & per-instance caching');
    }

    // 7. Graceful stream 400 downgrade to non-streaming & caching on AiService instance
    {
      const seenBodies: any[] = [];
      (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        seenBodies.push(body);
        if (body.stream) {
          return new Response(
            JSON.stringify({ error: { message: 'Unsupported parameter: stream must be false' } }),
            { status: 400, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '<translation>[B1] 非流式回退</translation>' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      const svc = new AiService(baseConfig);
      const res1 = await svc.translateContent('Hello.', 'Chinese (Simplified)', 'Translate.');
      assert.equal(res1.content, '非流式回退');
      assert.equal(seenBodies.length, 2);
      assert.equal(seenBodies[0].stream, true);
      assert.equal('stream' in seenBodies[1], false);

      const res2 = await svc.translateContent('World.', 'Chinese (Simplified)', 'Translate.');
      assert.equal(res2.content, '非流式回退');
      assert.equal(seenBodies.length, 3);
      assert.equal('stream' in seenBodies[2], false);
      console.log('  [OK] Graceful stream 400 downgrade & per-instance caching');
    }

    // 8. End-to-end local HTTP SSE server -> Cloudflare Worker /__api_proxy -> AiService
    {
      const capturedBodies: any[] = [];
      const sseServer = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));

        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(': keepalive\n\n');
        await new Promise((r) => setTimeout(r, 15));
        res.write(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n'
        );
        await new Promise((r) => setTimeout(r, 15));
        res.write(
          'data: {"choices":[{"delta":{"content":"<translation>[B1] 流式代理译文"}}]}\n\n'
        );
        await new Promise((r) => setTimeout(r, 15));
        res.write(
          'data: {"choices":[{"delta":{"content":"完成</translation>"},"finish_reason":"stop"}]}\n\n'
        );
        res.write(
          'data: {"choices":[],"usage":{"prompt_tokens":200,"prompt_tokens_details":{"cached_tokens":150},"completion_tokens":40,"completion_tokens_details":{"reasoning_tokens":25},"total_tokens":240}}\n\n'
        );
        res.end('data: [DONE]\n\n');
      });

      await new Promise<void>((resolve) => sseServer.listen(0, '127.0.0.1', resolve));
      const addr = sseServer.address();
      assert.ok(addr && typeof addr === 'object');
      const serverOrigin = `http://127.0.0.1:${addr.port}`;

      try {
        (globalThis as any).window = {
          location: { protocol: 'https:', origin: 'https://translit.joffoo.workers.dev' },
        };

        let proxyCacheControl: string | null = null;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          if (typeof input === 'string' && input.startsWith('/__api_proxy')) {
            const proxyRes = await worker.fetch(
              new Request(`https://translit.joffoo.workers.dev${input}`, {
                ...init,
                headers: {
                  ...(init?.headers as Record<string, string>),
                  Origin: 'https://translit.joffoo.workers.dev',
                },
              })
            );
            proxyCacheControl = proxyRes.headers.get('cache-control');
            return proxyRes;
          }
          return origFetch(input, init);
        };

        const usages: TokenUsage[] = [];
        const svc = new AiService(
          { ...baseConfig, baseUrl: `${serverOrigin}/v1` },
          (u) => usages.push(u)
        );
        const translated = await svc.translateContent(
          'Original paragraph.',
          'Chinese (Simplified)',
          'Translate accurately.'
        );

        assert.equal(translated.content, '流式代理译文完成');
        assert.equal(proxyCacheControl, 'no-cache, no-transform');
        assert.equal(capturedBodies.length, 1);
        assert.equal(capturedBodies[0].stream, true);
        assert.deepEqual(capturedBodies[0].stream_options, { include_usage: true });
        assert.equal(usages.length, 1);
        assert.deepEqual(usages[0], {
          promptTokens: 200,
          cachedTokens: 150,
          completionTokens: 40,
          reasoningTokens: 25,
          totalTokens: 240,
        });
        console.log('  [OK] End-to-end HTTP SSE -> Cloudflare Worker -> AiService verified');
      } finally {
        await new Promise<void>((resolve) => sseServer.close(() => resolve()));
      }
    }
  } finally {
    globalThis.fetch = origFetch;
    if (origWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = origWindow;
    }
  }

  console.log('\n[PASS] ALL_SSE_STREAMING_TESTS_SUCCESSFUL');
}

main().catch((err) => {
  console.error('[FAIL] SSE streaming verification failed:', err);
  process.exit(1);
});
