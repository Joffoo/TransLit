import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { DomMutationEngine, computeStructuralTreeDiff } from '../services/domMutationEngine';
import { EpubService } from '../services/epubService';
import { FootnoteResolver } from '../services/footnoteResolver';
import { parseHtmlDocument, parseXmlDocument } from '../utils/domAdapter';
import { FootnoteNode } from '../types';

async function runSeam1Tests() {
  console.log('--- Running Seam 1: DOM In-Place Mutation & Structural Isomorphism (Tree-Diff == 0) ---');

  const engine = new DomMutationEngine();

  const sampleXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Hikikomori</title></head>
<body class="calibre">
  <div class="calibre1" id="calibre_pb_0"></div>
  <div class="chapter" id="c001">
    <table class="title2">
      <tr class="calibre18">
        <td class="bor1"><a id="p17" class="calibre4"></a>1</td>
        <td class="top"><small class="calibre6">WHAT IS SOCIAL WITHDRAWAL?</small></td>
      </tr>
    </table>
    <div id="c001-sec1-001" class="calibre15">
      <p class="sec1-titlea">Tragedies of Indifference</p>
      <p class="flush-left">In November 1996 a tragic incident took place according to the <i class="calibre5">Asahi Shinbun</i><a id="fnref-1-1" href="#fn-1-1" epub:type="noteref" class="noteref" data-fn-id="1-1">[1]</a>.</p>
      <p class="indent">Does it make you uncomfortable that I have described such a tragic incident right away?</p>
    </div>
  </div>
</body>
</html>`;

  const internalizedFootnotes: Record<string, FootnoteNode> = {
    '1-1': {
      key: 'text/part0022.html#c001_nt-1',
      sourceFile: 'text/part0022.html',
      originalId: 'c001_nt-1',
      namespaceId: '1-1',
      label: '1',
      html: '<p>Saitō Tamaki, 1998.</p>',
      plainText: 'Saitō Tamaki, 1998.',
      paragraphs: ['Saitō Tamaki, 1998.'],
      referencedByChapters: [1]
    }
  };

  // 1. Extract translatable blocks from DOM without flattening tags (immutable chapter number td.bor1 is skipped)
  const extraction = engine.extractTranslatablePayload(sampleXhtml, internalizedFootnotes);
  assert.equal(
    extraction.blocks.length,
    4,
    `Expected 4 translatable leaf blocks (top, sec1-titlea, flush-left, indent; immutable bor1 skipped), got ${extraction.blocks.length}`
  );
  assert.ok(
    extraction.payloadText.includes('__FN_REF_1-1__'),
    'Extracted payload must preserve footnote slot __FN_REF_1-1__'
  );
  assert.ok(
    extraction.payloadText.includes('<i class="calibre5">Asahi Shinbun</i>') ||
      extraction.payloadText.includes('<i>Asahi Shinbun</i>'),
    'Extracted payload must preserve inline italic markup'
  );

  // Simulate AI translation of the extracted payload
  const translatedPayload = extraction.payloadText
    .replace('WHAT IS SOCIAL WITHDRAWAL?', '什么是社会性退缩？')
    .replace('Tragedies of Indifference', '冷漠的悲剧')
    .replace(
      /In November 1996 a tragic incident took place according to the <i[^>]*>Asahi Shinbun<\/i>__FN_REF_1-1__\./,
      '据<i class="calibre5">《朝日新闻》</i>__FN_REF_1-1__报道，1996年11月发生了一起悲剧事件。'
    )
    .replace(
      'Does it make you uncomfortable that I have described such a tragic incident right away?',
      '我一上来就描述这样一起悲剧事件，是否让你感到不适？'
    );

  // 2. Mutate DOM in-place (Monolingual)
  const mutatedBodyHtml = engine.mutateDomInPlace(sampleXhtml, translatedPayload, {
    internalizedFootnotes,
    translatedFootnotes: { '1-1': '斋藤环，1998年。' },
    sourcePayloadWithSlots: extraction.payloadText,
    bilingualMode: 'none',
    wereadMode: false,
    imagesRelPath: '../Images/'
  });

  // 3. Verify Structural Tree-Diff == 0 (excluding injected footnote popup asides and noteref children)
  const diffResult = computeStructuralTreeDiff(sampleXhtml, mutatedBodyHtml);
  assert.equal(
    diffResult.diffCount,
    0,
    `Expected Structural Tree-Diff == 0, but got ${diffResult.diffCount} diffs:\n${diffResult.diffs.join('\n')}`
  );

  // 4. Verify all original classes and nested tags are 100% preserved
  const mutatedDoc = parseHtmlDocument(mutatedBodyHtml);
  assert.ok(mutatedDoc.querySelector('table.title2'), 'table.title2 must be preserved');
  assert.ok(mutatedDoc.querySelector('td.bor1 a#p17.calibre4'), 'td.bor1 and anchor #p17.calibre4 must be preserved');
  assert.ok(mutatedDoc.querySelector('td.top small.calibre6'), 'td.top > small.calibre6 must be preserved');
  assert.equal(
    mutatedDoc.querySelector('td.top small.calibre6')?.textContent?.trim(),
    '什么是社会性退缩？',
    'Heading inside td.top > small.calibre6 must be translated in-place'
  );
  assert.equal(
    mutatedDoc.querySelector('p.sec1-titlea')?.textContent?.trim(),
    '冷漠的悲剧',
    'Pseudo-heading p.sec1-titlea must retain its class and have translated text'
  );
  assert.ok(
    mutatedDoc.querySelector('p.flush-left i.calibre5')?.textContent?.includes('《朝日新闻》'),
    'Inline <i class="calibre5"> inside p.flush-left must be preserved'
  );
  assert.ok(
    mutatedDoc.querySelector('p.flush-left a#fnref-1-1[href="#fn-1-1"]'),
    'Footnote noteref link inside p.flush-left must be rendered'
  );
  assert.ok(
    mutatedDoc.querySelector('aside#fn-1-1.footnote-popup')?.textContent?.includes('斋藤环，1998年。'),
    'Footnote popup aside #fn-1-1 must be appended at end of body'
  );

  // 5. Verify Conclusion empty number cell (title-num-empty), subtitle (h2), and generic non-Calibre title table
  const conclusionXhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
    <table class="title2"><tr>
      <td class="bor1"><a id="p177"></a>&nbsp;</td>
      <td class="calibre24"><p class="top1"><small>CONCLUSION</small></p><p class="top2"><i>Steps for the Future</i></p></td>
    </tr></table>
    <p class="flush-left">Opening paragraph.</p>
  </body></html>`;
  const conclusionExt = engine.extractTranslatablePayload(conclusionXhtml);
  assert.equal(conclusionExt.blocks.length, 3, 'Conclusion should extract 3 blocks (top1, top2, flush-left)');
  const conclusionMutated = parseHtmlDocument(
    engine.mutateDomInPlace(conclusionXhtml, '结语\n\n面向未来的应对之策\n\n开篇段落。')
  );
  assert.equal(
    conclusionMutated.querySelector('td.bor1')?.getAttribute('data-translit-role'),
    'title-num-empty',
    'Empty &nbsp; number cell in Conclusion must be tagged title-num-empty'
  );
  assert.equal(
    conclusionMutated.querySelector('p.top1')?.getAttribute('data-translit-role'),
    'h1',
    'Conclusion main title p.top1 must be tagged h1'
  );
  assert.equal(
    conclusionMutated.querySelector('p.top2')?.getAttribute('data-translit-role'),
    'h2',
    'Conclusion subtitle p.top2 must be tagged h2'
  );

  const genericTableXhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
    <table><tr><td>IV</td><td>The Theory of Everything</td></tr></table>
    <p>Body text.</p>
  </body></html>`;
  const genericExt = engine.extractTranslatablePayload(genericTableXhtml);
  assert.equal(genericExt.blocks.length, 2, 'Generic 1-row 2-col title table must skip pure Roman number IV');
  const genericMutated = parseHtmlDocument(
    engine.mutateDomInPlace(genericTableXhtml, '万物理论\n\n正文。')
  );
  assert.equal(
    genericMutated.querySelector('table')?.getAttribute('data-translit-role'),
    'title-table',
    'Generic 1-row 2-col chapter title table must be recognized as title-table'
  );
  assert.equal(
    genericMutated.querySelector('td')?.getAttribute('data-translit-role'),
    'title-num',
    'Generic chapter Roman number cell must be tagged title-num and preserved'
  );
  assert.equal(genericMutated.querySelector('td')?.textContent?.trim(), 'IV');

  // 6. Verify legacy cached translation starting with "第二章" aligns cleanly without shifting td.top
  const legacyCh2Xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
    <table class="title2"><tr><td class="bor1">2</td><td class="top"><small>THE SYMPTOMS AND DEVELOPMENT OF SOCIAL WITHDRAWAL</small></td></tr></table>
    <p class="sec1-titlea">Statistical Surveys of Social Withdrawal</p>
    <p class="flush-left">In the previous chapter I outlined social withdrawal.</p>
  </body></html>`;
  const legacyCh2Mutated = parseHtmlDocument(
    engine.mutateDomInPlace(
      legacyCh2Xhtml,
      '第二章\n\n社交退缩的症状与演变\n\n关于社会退缩的统计调查\n\n在上一章中，我大致勾勒了社会退缩的整体面貌。'
    )
  );
  assert.equal(legacyCh2Mutated.querySelector('td.bor1')?.textContent?.trim(), '2');
  assert.equal(
    legacyCh2Mutated.querySelector('td.top')?.textContent?.trim(),
    '社交退缩的症状与演变',
    'Legacy cached "第二章" prefix must not shift into td.top'
  );
  assert.equal(
    legacyCh2Mutated.querySelector('p.sec1-titlea')?.textContent?.trim(),
    '关于社会退缩的统计调查',
    'p.sec1-titlea must stay aligned with its section heading'
  );

  // Regression: sanitizeTargetHtml preserves bold <b> inline tags
  assert.equal(
    engine.sanitizeTargetHtml('这是<b>重要内容</b>'),
    '这是<b>重要内容</b>',
    'sanitizeTargetHtml must preserve valid <b> tags'
  );

  // Regression: 1->3 paragraph split alignment preserves all translated segments
  const splitAligned = engine.alignTargetParagraphsToDomBlocks(
    ['A single long source paragraph.'],
    ['第一段。', '第二段。', '第三段。'],
    [false]
  );
  assert.ok(
    splitAligned[0].includes('第一段。') &&
      splitAligned[0].includes('第二段。') &&
      splitAligned[0].includes('第三段。'),
    '1->3 paragraph alignment must merge all three translated segments into block 0'
  );

  // Regression: XML-unsafe chars inside translated footnotes are escaped while balanced inline <i> tags survive
  const escapedFnHtml = engine.mutateDomInPlace(
    '<p>Hi<a href="#fn-1" data-fn-id="1">[1]</a></p>',
    '你好__FN_REF_1__',
    {
      internalizedFootnotes: {
        '1': {
          key: 'n#1',
          sourceFile: 'n',
          originalId: '1',
          label: '1',
          html: 'R&amp;D',
          plainText: 'R&D <internal> & <i>italic</i>',
          paragraphs: ['R&D <internal> & <i>italic</i>'],
          referencedByChapters: [0],
        },
      },
      translatedFootnotes: {
        '1': 'R&D 部门 <内部> & <i>斜体</i>',
      },
    }
  );
  assert.ok(
    escapedFnHtml.includes('R&amp;D 部门 &lt;内部&gt; &amp; <i>斜体</i>'),
    'Footnote aside must escape bare & and non-whitelisted angle brackets while keeping balanced inline tags'
  );

  console.log('  [OK] Translatable leaf blocks extracted without flattening DOM tree');
  console.log('  [OK] Structural Tree-Diff == 0 verified on complex Calibre table/pseudo-heading DOM');
  console.log('  [OK] Inline tags (<i class="calibre5">), anchors (<a id="p17">), and footnote popups preserved');
  console.log('✓ Seam 1 passed!');
}

async function runSeam2Tests() {
  console.log('--- Running Seam 2: In-Place Bilingual DOM Cloning & Dual Footnote Mirrors ---');

  const engine = new DomMutationEngine();

  const sampleXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body class="calibre">
  <div class="chapter" id="c001">
    <table class="title2">
      <tr class="calibre18">
        <td class="bor1">1</td>
        <td class="top"><small class="calibre6">WHAT IS SOCIAL WITHDRAWAL?</small></td>
      </tr>
    </table>
    <div id="c001-sec1-001" class="calibre15">
      <p class="sec1-titlea">Tragedies of Indifference</p>
      <p class="flush-left">First paragraph citing note<a id="fnref-1-1" href="#fn-1-1" epub:type="noteref" class="noteref" data-fn-id="1-1">[1]</a>.</p>
    </div>
  </div>
</body>
</html>`;

  const internalizedFootnotes: Record<string, FootnoteNode> = {
    '1-1': {
      key: 'text/part0022.html#c001_nt-1',
      sourceFile: 'text/part0022.html',
      originalId: 'c001_nt-1',
      namespaceId: '1-1',
      label: '1',
      html: '<p>English footnote text.</p>',
      plainText: 'English footnote text.',
      paragraphs: ['English footnote text.'],
      referencedByChapters: [1]
    }
  };

  const extraction = engine.extractTranslatablePayload(sampleXhtml, internalizedFootnotes);
  const translatedPayload = extraction.payloadText
    .replace('WHAT IS SOCIAL WITHDRAWAL?', '什么是社会性退缩？')
    .replace('Tragedies of Indifference', '冷漠的悲剧')
    .replace('First paragraph citing note__FN_REF_1-1__.', '第一段引用了注释__FN_REF_1-1__。');

  const bilingualHtml = engine.mutateDomInPlace(sampleXhtml, translatedPayload, {
    internalizedFootnotes,
    translatedFootnotes: { '1-1': '中文注释内容。' },
    sourcePayloadWithSlots: extraction.payloadText,
    bilingualMode: 'source_first',
    wereadMode: false,
    imagesRelPath: '../Images/'
  });

  const doc = parseHtmlDocument(bilingualHtml);

  // Verify pseudo-heading p.sec1-titlea is cloned in-place with original class preserved on BOTH source and target!
  const sec1Nodes = Array.from(doc.querySelectorAll('p.sec1-titlea'));
  assert.equal(sec1Nodes.length, 2, 'Bilingual mode must produce 2 p.sec1-titlea nodes (source + cloned target)');
  assert.ok(sec1Nodes[0].classList.contains('bilingual-source'), 'First node in source_first must have .bilingual-source');
  assert.ok(sec1Nodes[1].classList.contains('bilingual-target'), 'Second node in source_first must have .bilingual-target');
  assert.equal(sec1Nodes[0].textContent?.trim(), 'Tragedies of Indifference');
  assert.equal(sec1Nodes[1].textContent?.trim(), '冷漠的悲剧');

  // Verify paragraph footnote links: source points to #fn-src-1-1, target points to #fn-1-1
  const flushNodes = Array.from(doc.querySelectorAll('p.flush-left'));
  assert.equal(flushNodes.length, 2, 'Bilingual mode must produce 2 p.flush-left nodes');
  const srcLink = flushNodes[0].querySelector('a.noteref');
  const tgtLink = flushNodes[1].querySelector('a.noteref');
  assert.equal(srcLink?.getAttribute('href'), '#fn-src-1-1', 'Source paragraph footnote link must point to #fn-src-1-1');
  assert.equal(tgtLink?.getAttribute('href'), '#fn-1-1', 'Target paragraph footnote link must point to #fn-1-1');

  // Verify dual footnote asides
  assert.ok(
    doc.querySelector('aside#fn-src-1-1')?.textContent?.includes('English footnote text.'),
    'Must generate #fn-src-1-1 aside with English footnote'
  );
  assert.ok(
    doc.querySelector('aside#fn-1-1')?.textContent?.includes('中文注释内容。'),
    'Must generate #fn-1-1 aside with Chinese footnote'
  );

  console.log('  [OK] In-place bilingual node cloning preserves original classes (.sec1-titlea, .flush-left) on both source & target');
  console.log('  [OK] Dual footnote mirrors (#fn-src-1-1 and #fn-1-1) accurately wired');
  console.log('✓ Seam 2 passed!');
}

async function runSeam3Tests() {
  console.log('--- Running Seam 3: Zero-CSS Fallback, KaTeX Currency Guard & Multi-Paragraph Same-Page Cleanup ---');

  const epubService = new EpubService();

  // 3a. Zero-CSS minimal EPUB auto-generates translit.css, links it in OPF & XHTML, places mimetype first & STORE
  const inZip = new JSZip();
  inZip.file('META-INF/container.xml', '<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  inZip.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title id="t1">Zero CSS Book</dc:title><dc:language id="l1">en</dc:language></metadata><manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>');
  inZip.file('OEBPS/text/ch1.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch1</title></head><body><p>Hello world<a href="#fn-1" data-fn-id="1">[1]</a></p></body></html>');
  inZip.file('mimetype', 'application/epub+zip');

  const ch1Xhtml = await inZip.file('OEBPS/text/ch1.xhtml')!.async('string');
  const blob = await epubService.generateEpub(
    [{
      id: 'ch1',
      fileName: 'text/ch1.xhtml',
      title: 'Ch1',
      index: 0,
      content: ch1Xhtml,
      markdown: 'Hello world__FN_REF_1__',
      slottedMarkdown: 'Hello world__FN_REF_1__',
      translatedMarkdown: '你好，世界__FN_REF_1__',
      internalizedFootnotes: {
        '1': {
          key: 'n#1',
          sourceFile: 'n',
          originalId: '1',
          label: '1',
          html: 'R&amp;D',
          plainText: 'R&D',
          paragraphs: ['R&D'],
          referencedByChapters: [0],
        },
      },
      translatedFootnotes: { '1': 'R&D 注释 & <标签> 测试' },
    }],
    inZip,
    'OEBPS/content.opf',
    'OEBPS/',
    [],
    'Zero CSS Book',
    'Chinese (Simplified)'
  );

  const outBuf = Buffer.from(await blob.arrayBuffer());
  assert.equal(outBuf.subarray(30, 38).toString('utf8'), 'mimetype', 'First ZIP local header must be mimetype');
  assert.equal(outBuf.readUInt16LE(8), 0, 'mimetype must be uncompressed STORE');

  const outZip = await JSZip.loadAsync(outBuf);
  const generatedCss = await outZip.file('OEBPS/translit.css')?.async('string');
  assert.ok(generatedCss && generatedCss.includes('.footnote-popup'), 'Empty-CSS EPUB must generate OEBPS/translit.css');

  const outOpf = await outZip.file('OEBPS/content.opf')!.async('string');
  assert.ok(outOpf.includes('href="translit.css"'), 'OPF manifest must register translit.css');
  assert.match(outOpf, /<dc:title id="t1">Zero CSS Book【TransLit】<\/dc:title>/);
  assert.match(outOpf, /<dc:language id="l1">zh<\/dc:language>/);

  const outCh1 = await outZip.file('OEBPS/text/ch1.xhtml')!.async('string');
  assert.ok(outCh1.includes('href="../translit.css"'), 'Chapter in OEBPS/text/ must link ../translit.css');
  assert.ok(outCh1.includes('R&amp;D 注释 &amp; &lt;标签&gt; 测试'), 'Aside footnote must escape XML special chars');
  assert.equal(parseXmlDocument(outCh1).getElementsByTagName('parsererror').length, 0, 'Generated XHTML must have 0 parsererror');

  // 3b. KaTeX inlineMath must render real formulas but never match currency amounts ($10 and $20)
  const mathAndCurrencyHtml = await epubService.renderChapterEpub3Html(
    'Einstein wrote $E = mc^2$ while tickets cost $10 and $20 today.',
    {},
    {}
  );
  assert.ok(mathAndCurrencyHtml.includes('<math'), 'True inline LaTeX $E = mc^2$ must render MathML');
  assert.ok(
    mathAndCurrencyHtml.includes('$10 and $20'),
    `Currency values must remain plain text without math parsing, got: ${mathAndCurrencyHtml}`
  );

  // 3c. FootnoteResolver must remove ALL continuation paragraphs of internalized same-page multi-paragraph footnotes
  const resolver = new FootnoteResolver();
  const samePageHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <p>Body paragraph cites a multi-paragraph note.<a href="#fn-1">[1]</a></p>
  <hr/>
  <p id="fn-1">[1] First paragraph of same-page footnote.</p>
  <p>Second continuation paragraph of same-page footnote.</p>
</body>
</html>`;
  const topo = resolver.scanTopology({ 'ch1.xhtml': samePageHtml });
  const resolved = resolver.internalizeChapterFootnotes(samePageHtml, 'ch1.xhtml', 0, topo);
  const resolvedDoc = parseHtmlDocument(resolved.html);
  const bodyText = resolvedDoc.body?.textContent || '';
  assert.equal(bodyText.includes('First paragraph of same-page footnote'), false, 'First para of internalized same-page note must be removed from body');
  assert.equal(bodyText.includes('Second continuation paragraph of same-page footnote'), false, 'Continuation para of internalized same-page note must also be removed from body');

  console.log('  [OK] Zero-CSS EPUB fallback stylesheet generation & XHTML linkage verified');
  console.log('  [OK] KaTeX inline formula vs currency ($10 and $20) separation verified');
  console.log('  [OK] Multi-paragraph same-page footnote cleanup verified');
  console.log('✓ Seam 3 passed!');
}

async function main() {
  await runSeam1Tests();
  await runSeam2Tests();
  await runSeam3Tests();
  console.log('\n[PASS] ALL_DOM_MUTATION_SEAM_TESTS_SUCCESSFUL');
}

main().catch((err) => {
  console.error('[FAIL] DOM Mutation verification failed:', err);
  process.exit(1);
});
