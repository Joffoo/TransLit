import assert from 'node:assert/strict';
import {
  encodeBlocksForWire,
  decodeBlocksFromWire,
  stripBlockProtocolMarkers
} from '../utils/blockProtocol';
import { splitTextIntoChunks } from '../services/geminiService';
import { FootnotePool } from '../services/footnotePool';
import { FootnoteNode } from '../types';

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

  console.log('\n[PASS] ALL_BLOCK_PROTOCOL_TESTS_SUCCESSFUL');
}

main().catch((err) => {
  console.error('[FAIL] Block-ID protocol verification failed:', err);
  process.exit(1);
});
