import assert from 'node:assert/strict';
import {
  encodeBlocksForWire,
  decodeBlocksFromWire,
  stripBlockProtocolMarkers
} from '../utils/blockProtocol';
import { AiService, splitTextIntoChunks } from '../services/geminiService';
import { FootnotePool } from '../services/footnotePool';
import { AppConfig, FootnoteNode } from '../types';

async function main() {
  console.log('--- Running Block-ID Protocol & Heading-Aware Chunking Verification ---');

  // 1. encodeBlocksForWire strips # / ## on the wire and assigns deterministic 1-based [Bk] IDs
  const extractedChunk = [
    '# Are You My AI?',
    'It’s a little odd standing in front of a historical plaque.',
    'IN THIS BUILDING DURING THE SUMMER OF 1956',
    'the Dartmouth Summer Research Project'
  ].join('\n\n');

  const encoded = encodeBlocksForWire(extractedChunk);
  assert.equal(encoded.blockCount, 4);
  assert.deepEqual(encoded.encodedText.split('\n\n'), [
    '[B1] Are You My AI?',
    '[B2] It’s a little odd standing in front of a historical plaque.',
    '[B3] IN THIS BUILDING DURING THE SUMMER OF 1956',
    '[B4] the Dartmouth Summer Research Project'
  ]);
  console.log('  [OK] encodeBlocksForWire encodes 1..N blocks cleanly without # heading conflict');

  // 2. decodeBlocksFromWire: canonical decode, swapped order recovery, full-width/inline recovery, internal \n\n collapse
  const cleanDecoded = decodeBlocksFromWire(
    [
      '[B1] 你是我的 AI 吗？',
      '[B2] 站在一块历史铭牌前多少有点奇怪。',
      '[B3] 1956 年夏，在这座建筑内',
      '[B4] 达特茅斯夏季人工智能研究项目'
    ].join('\n\n'),
    4
  );
  assert.equal(cleanDecoded.usedBlockProtocol, true);
  assert.equal(cleanDecoded.outOfOrderCount, 0);
  assert.deepEqual(cleanDecoded.missingIds, []);
  assert.equal(cleanDecoded.decodedText.split('\n\n').length, 4);

  // Swapped blocks ([B3] emitted before [B2]) + internal blank line inside [B4] -> reordered & folded to <br/>
  const swappedRes = decodeBlocksFromWire(
    [
      '[B1] 标题',
      '',
      '[B3] 这是后面的小标题？',
      '',
      '[B2] 这是前面原本很长的正文段落。',
      '',
      '[B4] 第一行信件',
      '',
      '第二行落款'
    ].join('\n'),
    4
  );
  assert.equal(swappedRes.usedBlockProtocol, true);
  assert.equal(swappedRes.outOfOrderCount, 1);
  assert.deepEqual(swappedRes.decodedText.split('\n\n'), [
    '标题',
    '这是前面原本很长的正文段落。',
    '这是后面的小标题？',
    '第一行信件<br/>第二行落款'
  ]);

  // Inline / single-newline / full-width brackets (`【B1】`, `〔B2〕`)
  const inlineFullwidthRes = decodeBlocksFromWire('【B1】第一块正文内容 〔B2〕第二块正文内容', 2);
  assert.equal(inlineFullwidthRes.usedBlockProtocol, true);
  assert.deepEqual(inlineFullwidthRes.decodedText.split('\n\n'), [
    '第一块正文内容',
    '第二块正文内容'
  ]);

  // Missing [B2] handled cleanly without breaking order
  const missingOneRes = decodeBlocksFromWire('[B1] 一\n\n[B3] 三', 3);
  assert.equal(missingOneRes.usedBlockProtocol, true);
  assert.deepEqual(missingOneRes.matchedIds, [1, 3]);
  assert.deepEqual(missingOneRes.missingIds, [2]);
  assert.deepEqual(missingOneRes.decodedText.split('\n\n'), ['一', '三']);

  // Legacy fallback without [Bk] markers
  const legacyRes = decodeBlocksFromWire('第一段译文。\n\n第二段译文。', 2);
  assert.equal(legacyRes.usedBlockProtocol, false);
  assert.equal(legacyRes.decodedText, '第一段译文。\n\n第二段译文。');

  // Stray prefix stripper
  assert.equal(stripBlockProtocolMarkers('[B1] 示例\n【B2】正文'), '示例\n正文');
  console.log('  [OK] decodeBlocksFromWire reorder, inline/fullwidth split, <br/> fold & legacy fallback verified');

  // 3. Heading-aware splitTextIntoChunks never orphans a trailing `## Heading` at the end of a chunk
  const longParaA = 'A'.repeat(720);
  const longParaB = 'B'.repeat(720);
  const headingLine = '## 1. Why Would Anyone Choose to Live This Way?';
  const followingBody = 'Because the future! '.repeat(25).trim();
  const trailingBody = 'And more text continues here. '.repeat(20).trim();
  const introLikePayload = [longParaA, longParaB, headingLine, followingBody, trailingBody].join('\n\n');

  const chunks = splitTextIntoChunks(introLikePayload, 1600);
  assert.ok(chunks.length >= 2, `Expected multiple chunks, got ${chunks.length}`);
  for (let i = 0; i < chunks.length - 1; i++) {
    const chunkParas = chunks[i].split(/\n\n/).map((p) => p.trim()).filter(Boolean);
    const lastPara = chunkParas[chunkParas.length - 1] || '';
    assert.ok(
      !/^#{1,6}\s+\S/.test(lastPara),
      `Chunk ${i} must NOT end with orphaned heading "${lastPara}"`
    );
  }
  const headingChunk = chunks.find((c) => c.includes(headingLine))!;
  assert.ok(
    headingChunk.includes(followingBody),
    'Heading chunk must keep its immediately following body paragraph in the same chunk'
  );
  console.log('  [OK] splitTextIntoChunks heading-non-orphaning verified');

  // 4. End-to-end FootnotePool.parseDualChannelResponse + swapped [B1]/[B2]/[B3] + [FN_DEF] + leaked 〔2〕
  const pool = new FootnotePool();
  const fn1: FootnoteNode = {
    key: 'notes.xhtml#fn1',
    sourceFile: 'notes.xhtml',
    originalId: 'fn1',
    namespaceId: '0-1',
    label: '1',
    html: '<p>Bill Gates on TV.</p>',
    plainText: 'Bill Gates on TV.',
    paragraphs: ['Bill Gates on TV.'],
    referencedByChapters: [0]
  };
  const fn2: FootnoteNode = {
    key: 'notes.xhtml#fn2',
    sourceFile: 'notes.xhtml',
    originalId: 'fn2',
    namespaceId: '0-2',
    label: '2',
    html: '<p>Google CEO quote.</p>',
    plainText: 'Google CEO quote.',
    paragraphs: ['Google CEO quote.'],
    referencedByChapters: [0]
  };

  const sourceOrig = [
    'This long opening body paragraph asks whether AI everywhere is progress.__FN_REF_0-1__',
    '## 1. Why Would Anyone Choose to Live This Way?',
    'Because the future executive hype is everywhere.__FN_REF_0-2__'
  ].join('\n\n');

  const modelResp = [
    '[MAIN_CONTENT]',
    '[B2] 为什么会有人选择这样生活？',
    '',
    '[B1] 这段很长的正文探讨 AI 无处不在究竟算不算进步__FN_REF_0-1__。',
    '',
    '[B3] 因为高管们口中的未来近在眼前〔2〕。',
    '',
    '〔2〕谷歌 CEO 关于 AI 重要性的演讲。',
    '[/MAIN_CONTENT]',
    '',
    '[FN_DEF:0-1]比尔·盖茨在《今夜秀》上的访谈。[/FN_DEF]'
  ].join('\n');

  const dualRes = pool.parseDualChannelResponse(modelResp, sourceOrig, [fn1, fn2]);
  const outBlocks = dualRes.translatedBody.split('\n\n');
  assert.equal(outBlocks.length, 3, `Expected 3 reordered blocks, got ${outBlocks.length}`);
  assert.ok(outBlocks[0].includes('这段很长的正文') && outBlocks[0].includes('__FN_REF_0-1__'));
  assert.equal(outBlocks[1], '为什么会有人选择这样生活？');
  assert.ok(outBlocks[2].includes('因为高管们口中的未来') && outBlocks[2].includes('__FN_REF_0-2__'));
  assert.equal(dualRes.translatedFootnotes['0-1'], '比尔·盖茨在《今夜秀》上的访谈。');
  assert.equal(dualRes.translatedFootnotes['0-2'], '谷歌 CEO 关于 AI 重要性的演讲。');
  console.log('  [OK] FootnotePool + Block-ID + 〔n〕 end-to-end coordination verified');

  // 5. AiService collapse guard: greeting retry recovery, short-chunk meta-response isolation, and partial block drop
  const mockConfig: AppConfig = {
    apiKey: 'test-key',
    baseUrl: 'https://mock.translit.local/v1',
    modelName: 'mock-model',
    sourceLanguage: 'English',
    enableGlossary: false,
    enableProofreading: false,
    smartSkip: true,
    useRecommendedPrompts: true,
    additionalContext: ''
  };
  const origFetch = globalThis.fetch;
  try {
    // 5a: Long multi-block chunk gets "Hello! How can I help you today?" -> retries with compact prompt -> succeeds
    let callIdx = 0;
    (globalThis as any).fetch = async () => {
      callIdx++;
      const content =
        callIdx === 1
          ? 'Hello! How can I help you today?'
          : '<translation>\n[B1] 第二章\n\n[B2] 生殖\n\n[B3] 这是关于现代社会与生殖技术的引言段落，篇幅较长用于验证。\n</translation>';
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const svcA = new AiService(mockConfig);
    const longChunk = [
      'Chapter 2',
      'REPRODUCTION',
      'Here is a long introductory paragraph about modern reproductive technologies and moral economics that easily exceeds two hundred characters in total length.'
    ].join('\n\n');
    let fallbackA = false;
    const resA = await svcA.translateContent(
      longChunk,
      'Chinese (Simplified)',
      'Translate carefully.',
      async (_cur, _tot, _chunkRes, _g, isFallback) => {
        if (isFallback) fallbackA = true;
      }
    );
    assert.equal(callIdx, 2, 'Collapsed greeting response must trigger compact-prompt retry');
    assert.equal(fallbackA, false, 'Successful retry must clear fallback');
    assert.ok(resA.content.includes('第二章') && resA.content.includes('生殖'));

    // 5b: Short chunk (< 120 chars) getting Chinese "no content received" -> isolated as fallback with reason
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '抱歉，我没有收到需要翻译的内容，请提供文本。' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    const svcB = new AiService(mockConfig);
    const shortChunk = 'Mary Portas: My brother is the father of my son.';
    let fallbackB = false;
    let reasonB = '';
    const resB = await svcB.translateContent(
      shortChunk,
      'Chinese (Simplified)',
      'Translate carefully.',
      async (_cur, _tot, _chunkRes, _g, isFallback, stats) => {
        if (isFallback) {
          fallbackB = true;
          reasonB = stats?.fallbackReason || '';
        }
      }
    );
    assert.equal(fallbackB, true, 'Short-chunk meta-response must trigger fallback isolation');
    assert.ok(reasonB.includes('没有收到需要翻译的内容'), `Expected snippet in fallbackReason, got: ${reasonB}`);
    assert.equal(resB.content, shortChunk, 'Fallback must preserve original source chunk');

    // 5c: Partial [B1]-only drop on a 6-block chunk -> isolated as fallback
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '<translation>\n[B1] 第二章\n</translation>' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    const svcC = new AiService(mockConfig);
    const sixBlocks = [
      'Chapter 2',
      'REPRODUCTION',
      'Paragraph one with substantial English prose discussing the historical context of assisted reproduction.',
      'Paragraph two discussing legal frameworks and cross-border fertility clinics in California.',
      'Paragraph three examining moral repugnance and market boundaries in modern society.',
      'Paragraph four concluding the introductory section of the second chapter.'
    ].join('\n\n');
    let fallbackC = false;
    let reasonC = '';
    const resC = await svcC.translateContent(
      sixBlocks,
      'Chinese (Simplified)',
      'Translate carefully.',
      async (_cur, _tot, _chunkRes, _g, isFallback, stats) => {
        if (isFallback) {
          fallbackC = true;
          reasonC = stats?.fallbackReason || '';
        }
      }
    );
    assert.equal(fallbackC, true, 'Partial 1/6 block drop must trigger fallback isolation');
    assert.ok(reasonC.includes('Severe block drop'), `Expected Severe block drop reason, got: ${reasonC}`);
    assert.equal(resC.content, sixBlocks, 'Partial block drop fallback must preserve original blocks');
    console.log('  [OK] AiService collapse guard (greeting retry, short meta-response, partial block drop) verified');
  } finally {
    globalThis.fetch = origFetch;
  }

  console.log('\n[PASS] ALL_BLOCK_PROTOCOL_TESTS_SUCCESSFUL');
}

main().catch((err) => {
  console.error('[FAIL] Block-ID protocol verification failed:', err);
  process.exit(1);
});
