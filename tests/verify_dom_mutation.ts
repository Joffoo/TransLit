import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  DomMutationEngine,
  computeStructuralTreeDiff,
  parseEpubCssProfiles,
  sanitizeFootnoteTextForXhtml,
  sanitizeInlineXhtmlForLeaf
} from '../services/domMutationEngine';
import { EpubService } from '../services/epubService';
import { FootnoteResolver } from '../services/footnoteResolver';
import { PageClassifier } from '../services/pageClassifier';
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
  assert.ok(
    mathAndCurrencyHtml.includes('<svg') && mathAndCurrencyHtml.includes('translit-math-svg'),
    'True inline LaTeX $E = mc^2$ must render self-contained SVG'
  );
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

  // 3d. Inline XHTML grammar barrier rescues malformed LLM tags & protects XHTML well-formedness
  assert.equal(
    sanitizeInlineXhtmlForLeaf('<span class="“stickupcap”" 站</span>在一历史纪念牌前'),
    '站在一历史纪念牌前',
    'Malformed unclosed opening <span ... 站</span> must rescue inner text without broken attributes'
  );
  assert.equal(
    sanitizeInlineXhtmlForLeaf('<span class="“stickupcap”" 站<="" span="">在一历史纪念牌前'),
    '站在一历史纪念牌前',
    'Browser-serialized broken <span ... <="" span=""> must also rescue inner text'
  );
  assert.equal(
    sanitizeInlineXhtmlForLeaf('<i class="calibre5">Asahi Shinbun</i>'),
    '<i class="calibre5">Asahi Shinbun</i>',
    'Valid inline <i class="calibre5"> tag must be preserved'
  );
  assert.equal(
    sanitizeInlineXhtmlForLeaf('x < y & z > 0'),
    'x &lt; y &amp; z &gt; 0',
    'Literal comparison operators and bare & must be XML-escaped'
  );
  assert.equal(
    sanitizeInlineXhtmlForLeaf('文本</span>结束与<i><b>混合</i>'),
    '文本结束与<i>混合</i>',
    'Orphan closing and unclosed inner tags must be stripped cleanly'
  );

  // 3e. Single-newline list & heading boundary recovery aligns Notes items 1-to-1
  const notesXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h1 class="cnab">Notes</h1>
  <p class="notes-intro">Unless otherwise indicated, all quotations are from the text.</p>
  <h2 class="notes-sec">INTRODUCTION</h2>
  <ol class="notes-list">
    <li class="note"><span class="note-num">1.</span> Note item one.</li>
    <li class="note"><span class="note-num">2.</span> Note item two.</li>
    <li class="note"><span class="note-num">3.</span> Note item three.</li>
    <li class="note"><span class="note-num">4.</span> Note item four.</li>
    <li class="note"><span class="note-num">5.</span> Note item five.</li>
    <li class="note"><span class="note-num">6.</span> Note item six.</li>
  </ol>
</body>
</html>`;
  const singleNewlineNotesTranslation = [
    '# 注释',
    '除非另有说明，所有引文均出自正文。',
    [
      '引言',
      '1. 第一条注释。',
      '2. 第二条注释。',
      '3. 第三条注释。',
      '4. 第四条注释。',
      '5. 第五条注释。',
      '6. 第六条注释。'
    ].join('\n')
  ].join('\n\n');
  const notesEngine = new DomMutationEngine();
  const mutatedNotes = notesEngine.mutateDomInPlace(notesXhtml, singleNewlineNotesTranslation);
  assert.equal(
    parseXmlDocument(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${mutatedNotes}</body></html>`).getElementsByTagName('parsererror').length,
    0,
    'Mutated Notes XHTML must parse with zero XML errors'
  );
  const notesDoc = parseHtmlDocument(mutatedNotes);
  assert.equal(notesDoc.querySelector('h2.notes-sec')?.textContent?.trim(), '引言');
  const noteItems = Array.from(notesDoc.querySelectorAll('li.note'));
  assert.equal(noteItems.length, 6, 'Notes list must retain 6 <li> items');
  assert.equal(noteItems[0].textContent?.trim(), '1. 第一条注释。', 'First <li> must NOT swallow items 2..6');
  assert.equal(noteItems[1].textContent?.trim(), '2. 第二条注释。');
  assert.equal(noteItems[5].textContent?.trim(), '6. 第六条注释。');

  // 3f. Non-noteref <a role="doc-backlink" id="en000"> must unwrap cleanly at input, preserve #en000 on write-back, and strip shell <a> on output
  const backlinkNotesXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <ol class="notes-list">
    <li class="note"><a class="a1" href="9780063446625_Introduction.xhtml#ren000" id="en000" role="doc-backlink"><span class="a2">1</span></a>.<span class="spn"></span><i>The Tonight Show</i>: Bill Gates.</li>
  </ol>
</body>
</html>`;
  const extractedBacklink = notesEngine.extractTranslatablePayload(backlinkNotesXhtml);
  assert.equal(
    extractedBacklink.blocks[0].slottedText,
    '1.<i>The Tonight Show</i>: Bill Gates.',
    'extractLeafBlockContent must unwrap non-noteref doc-backlink <a> and inner decorative spans'
  );
  assert.equal(
    sanitizeInlineXhtmlForLeaf('<a class="a1" href="Intro.xhtml#ren000" id="en000" role="doc-backlink">1</a>.<i>《今夜秀》</i>：比尔·盖茨。'),
    '1.<i>《今夜秀》</i>：比尔·盖茨。',
    'sanitizeInlineXhtmlForLeaf must strip disallowed shell <a> tags instead of escaping them into literal text'
  );
  const mutatedBacklink = notesEngine.mutateDomInPlace(
    backlinkNotesXhtml,
    '<a class="a1" href="Intro.xhtml#ren000" id="en000">1</a>.<i>《今夜秀》</i>：比尔·盖茨。'
  );
  assert.equal(
    computeStructuralTreeDiff(
      backlinkNotesXhtml,
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>${mutatedBacklink}</body></html>`
    ).diffCount,
    0,
    'Notes backlink mutation must keep structural Tree-Diff == 0'
  );
  const backlinkDoc = parseHtmlDocument(mutatedBacklink);
  assert.ok(backlinkDoc.querySelector('li.note a#en000'), 'Preserved empty <a id="en000"> anchor must survive write-back');
  assert.ok(!mutatedBacklink.includes('&lt;a'), `Exported XHTML must not contain escaped &lt;a, got: ${mutatedBacklink}`);

  // 3f-2. Publisher CSS list-style-type: none + empty spacer .spn { padding-left: 0.5em } + hand-numbered fallback without CSS
  const notesCssProfiles = parseEpubCssProfiles([
    '.note-list { list-style-type: none; padding: 0em; } .note { text-indent: -1.25em; } .spn { padding-left: 0.5em; }'
  ]);
  const extractedWithCss = notesEngine.extractTranslatablePayload(backlinkNotesXhtml, {}, notesCssProfiles);
  assert.equal(
    extractedWithCss.blocks[0].slottedText,
    '1. <i>The Tonight Show</i>: Bill Gates.',
    'Empty horizontal spacer <span class="spn"></span> must emit a single space instead of cramping 1.Text'
  );
  const mutatedListWithCss = notesEngine.mutateDomInPlace(
    backlinkNotesXhtml,
    '1. <i>《今夜秀》</i>：比尔·盖茨。',
    { cssProfiles: notesCssProfiles }
  );
  assert.equal(
    parseHtmlDocument(mutatedListWithCss).querySelector('ol.notes-list')?.getAttribute('data-translit-list'),
    'none',
    'CSS-less hand-numbered or hanging <ol.notes-list> must receive data-translit-list="none"'
  );
  const noteListXhtmlWithCss = backlinkNotesXhtml.replace('class="notes-list"', 'class="note-list"');
  const mutatedNoteList = notesEngine.mutateDomInPlace(
    noteListXhtmlWithCss,
    '1. <i>《今夜秀》</i>：比尔·盖茨。',
    { cssProfiles: notesCssProfiles }
  );
  assert.equal(
    parseHtmlDocument(mutatedNoteList).querySelector('ol.note-list')?.getAttribute('data-translit-list'),
    'none',
    '<ol class="note-list"> with list-style-type: none must receive data-translit-list="none"'
  );
  const manualNoCssOl = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><ol><li>1. First note.</li><li>2. Second note.</li></ol></body></html>`;
  const mutatedManualNoCss = notesEngine.mutateDomInPlace(manualNoCssOl, '1. 第一条。\n\n2. 第二条。');
  assert.equal(
    parseHtmlDocument(mutatedManualNoCss).querySelector('ol')?.getAttribute('data-translit-list'),
    'none',
    'Hand-numbered <ol> without CSS must still receive data-translit-list="none"'
  );

  // 3g. N === M adjacent heading/body inversion guard protects Introduction-style swapped paragraph + <h2>
  const introSwapXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <p class="indent">Was my life really going to be better with AI everywhere? How was I even supposed to put AI everywhere? Or was I about to find out that this AI narrative is Silicon Valley betting big?</p>
  <h2 class="h3">1. Why Would Anyone Choose to Live This Way?</h2>
  <p class="noindent">Because the future! I wanted to live in the future that everyone kept insisting was right around the corner.</p>
</body>
</html>`;
  const swappedTranslation = [
    '为什么会有人选择这样生活？',
    '当人工智能无处不在时，我的生活真的会更好吗？我到底该怎么让人工智能无处不在？还是说我即将发现，这整套叙事不过是硅谷的又一次大胆豪赌？',
    '因为未来！我想生活在每个人都坚称近在眼前的那个未来里。'
  ].join('\n\n');
  const repairedIntro = notesEngine.mutateDomInPlace(introSwapXhtml, swappedTranslation);
  const introDoc = parseHtmlDocument(repairedIntro);
  assert.equal(
    introDoc.querySelector('h2.h3')?.textContent?.trim(),
    '为什么会有人选择这样生活？',
    'Swapped short heading must be restored back into <h2>'
  );
  assert.ok(
    (introDoc.querySelector('p.indent')?.textContent || '').includes('当人工智能无处不在时'),
    'Swapped long body paragraph must be restored back into <p.indent>'
  );

  // 3h. Inline <img> inside leaf <p> must be slotted cleanly and safe cached <img> tags must render instead of escaping to literal text
  const inlineImgXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <p class="score"><img alt="" class="inline" role="presentation" src="../images/com02.jpg"/>Score: 6/10</p>
</body>
</html>`;
  const extractedImg = notesEngine.extractTranslatablePayload(inlineImgXhtml);
  assert.equal(
    extractedImg.blocks[0].slottedText,
    '__IMG_0__Score: 6/10',
    'Inline <img> must be replaced with __IMG_0__ slot before sending to LLM'
  );
  const mutatedImgFromSlot = notesEngine.mutateDomInPlace(inlineImgXhtml, '__IMG_0__评分：6/10');
  assert.ok(
    mutatedImgFromSlot.includes('<img alt="" class="inline" role="presentation" src="../images/com02.jpg"/>') &&
      !mutatedImgFromSlot.includes('&lt;img'),
    `__IMG_0__ must rehydrate back to real <img> tag, got: ${mutatedImgFromSlot}`
  );
  assert.equal(
    sanitizeInlineXhtmlForLeaf('<img alt="" class="inline" role="presentation" src="../images/com02.jpg" onerror="alert(1)">评分：6/10'),
    '<img alt="" class="inline" role="presentation" src="../images/com02.jpg"/>评分：6/10',
    'Cached safe inline <img> must render as valid self-closing XHTML without unsafe handlers'
  );
  assert.equal(
    sanitizeInlineXhtmlForLeaf('<img src="javascript:alert(1)">评分：6/10'),
    '评分：6/10',
    'Unsafe javascript: image src must be stripped'
  );

  // 3i. Mixed-content <li> with direct inline text/tags + nested <p> must extract & translate BOTH runs without leaving English
  const mixedLiXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <ul class="bullet">
    <li class="bul1t"><span class="scb">low-level physical actions.</span> This is the “body” part—actually <i>doing</i> the thing in the world.
      <p class="bul1p">However, with this method, the robot is limited to what it sees humans do.</p>
    </li>
  </ul>
</body>
</html>`;
  const mixedExtracted = notesEngine.extractTranslatablePayload(mixedLiXhtml);
  assert.equal(mixedExtracted.blocks.length, 2, 'Mixed <li> + nested <p> must extract 2 blocks instead of skipping lead text');
  assert.ok(mixedExtracted.blocks[0].slottedText.includes('low-level physical actions.'));
  assert.ok(mixedExtracted.blocks[1].slottedText.includes('However, with this method'));
  const mixedMutated = notesEngine.mutateDomInPlace(
    mixedLiXhtml,
    '<b>低层物理动作。</b>这是“身体”部分——也就是真正在现实世界里<i>动手去做</i>。\n\n然而，采用这种方法时，机器人会受限于它所见人类做过的事情。'
  );
  assert.ok(
    mixedMutated.includes('低层物理动作') &&
      mixedMutated.includes('采用这种方法时') &&
      !/low-level physical actions/i.test(mixedMutated),
    `Mixed-content <li> lead text must be translated cleanly, got:\n${mixedMutated}`
  );
  assert.equal(
    computeStructuralTreeDiff(
      mixedLiXhtml,
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>${mixedMutated}</body></html>`
    ).diffCount,
    0,
    'Mixed-content <li> normalization must keep structural Tree-Diff == 0'
  );

  // 3j. Japanese <ruby> furigana annotations (<rt>, <rp>, <rtc>) must be stripped cleanly across DOM, bilingual mode, footnotes & cache refresh
  const japaneseRubyXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h1><ruby><span class="koboSpan">序</span><rt>じょ</rt><span class="koboSpan">章</span><rt>しょう</rt></ruby></h1>
  <p><ruby><span class="koboSpan" id="kobo.16.1">伽</span><rt>とぎ</rt><span class="koboSpan" id="kobo.17.1">話</span><rt>ばなし</rt></ruby>と<ruby><rb>宮内悠介</rb><rp>（</rp><rt>みやうちゆうすけ</rt><rp>）</rp><rtc>みょうじ</rtc></ruby>の作品を読む。</p>
</body>
</html>`;
  const rubyExtracted = notesEngine.extractTranslatablePayload(japaneseRubyXhtml);
  assert.equal(rubyExtracted.blocks.length, 2);
  assert.equal(rubyExtracted.blocks[0].slottedText, '# 序章', 'Heading <ruby> must strip <rt> readings cleanly');
  assert.equal(
    rubyExtracted.blocks[1].slottedText,
    '伽話と宮内悠介の作品を読む。',
    'Body <ruby> must strip <rt>/<rp>/<rtc> and unwrap <ruby>/<rb>/<span> cleanly'
  );
  assert.equal(/<ruby|<rt|<rp|<rtc/i.test(rubyExtracted.payloadText), false, 'Payload must contain zero ruby markup');

  const rubyMonoMutated = notesEngine.mutateDomInPlace(
    japaneseRubyXhtml,
    '序章\n\n阅读童话故事与宫内悠介的作品。'
  );
  assert.equal(
    computeStructuralTreeDiff(
      japaneseRubyXhtml,
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>${rubyMonoMutated}</body></html>`
    ).diffCount,
    0,
    'Japanese ruby monolingual mutation must keep structural Tree-Diff == 0'
  );
  assert.equal(
    parseXmlDocument(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${rubyMonoMutated}</body></html>`).getElementsByTagName('parsererror').length,
    0,
    'Japanese ruby monolingual XHTML must parse with zero XML errors'
  );

  const rubyBilingualMutated = notesEngine.mutateDomInPlace(
    japaneseRubyXhtml,
    '序章\n\n阅读童话故事与宫内悠介的作品。',
    { bilingualMode: 'source_first' }
  );
  assert.equal(
    rubyBilingualMutated.includes('&lt;ruby') || rubyBilingualMutated.includes('&lt;rt'),
    false,
    `Bilingual source must NOT leak escaped &lt;ruby&gt;/&lt;rt&gt;, got: ${rubyBilingualMutated}`
  );
  assert.ok(
    rubyBilingualMutated.includes('伽話と宮内悠介の作品を読む。') &&
      rubyBilingualMutated.includes('阅读童话故事与宫内悠介的作品。'),
    'Bilingual mode must preserve clean Japanese source and Chinese target'
  );

  assert.equal(
    sanitizeInlineXhtmlForLeaf('<ruby>伽<rt>とぎ</rt>話<rt>ばなし</rt></ruby>を読む'),
    '伽話を読む',
    'sanitizeInlineXhtmlForLeaf must strip leaked <ruby>/<rt> markup'
  );
  assert.equal(
    sanitizeInlineXhtmlForLeaf('<ruby>漢<rt/>字<rt>じ</rt></ruby>と<ruby>漢<rt>かん<rb>字<rt>じ</ruby>'),
    '漢字と漢字',
    'stripRubyMarkup must handle self-closing <rt/> and HTML5 optional-closing <rt> without deleting base kanji or leaking furigana'
  );
  assert.equal(
    sanitizeFootnoteTextForXhtml('<ruby>三条宗近<rp>(</rp><rt>さんじょうむねちか</rt><rp>)</rp></ruby>注'),
    '三条宗近注',
    'sanitizeFootnoteTextForXhtml must strip leaked <ruby>/<rt>/<rp> markup'
  );

  // Nested inline formatting and footnote anchor inside <ruby>
  const nestedRubyXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <p><ruby><b>漢</b><rt>かん</rt></ruby>と<ruby><a epub:type="noteref" data-fn-id="0-1" href="#fn-0-1">注</a><rt>ちゅう</rt></ruby>の確認。</p>
</body>
</html>`;
  const nestedRubyExtracted = notesEngine.extractTranslatablePayload(nestedRubyXhtml);
  assert.equal(
    nestedRubyExtracted.blocks[0].slottedText,
    '<b>漢</b>と__FN_REF_0-1__の確認。',
    'Nested <b> and noteref <a> inside <ruby> must survive furigana stripping'
  );

  const jpFnHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <p>本文<a href="#fn-1">[1]</a></p>
  <p id="fn-1">[1] <ruby>伽<rt>とぎ</rt>話<rt>ばなし</rt></ruby>の解説。</p>
</body>
</html>`;
  const jpTopo = resolver.scanTopology({ 'jp.xhtml': jpFnHtml });
  assert.equal(
    jpTopo.get('jp.xhtml#fn-1')?.plainText,
    '伽話の解説。',
    'FootnoteResolver must strip <rt> furigana from Japanese footnote plainText'
  );

  const legacyRubyChapter = {
    id: 'jp1',
    index: 0,
    fileName: 'jp1.xhtml',
    title: '序章',
    content: japaneseRubyXhtml,
    markdown: '# <ruby>序<rt>じょ</rt>章<rt>しょう</rt></ruby>\n\n<ruby>伽<rt>とぎ</rt>話<rt>ばなし</rt></ruby>',
    slottedMarkdown: '# <ruby>序<rt>じょ</rt>章<rt>しょう</rt></ruby>\n\n<ruby>伽<rt>とぎ</rt>話<rt>ばなし</rt></ruby>'
  };
  assert.equal(
    epubService.refreshChapterPayloadIfNeeded(legacyRubyChapter),
    true,
    'refreshChapterPayloadIfNeeded must refresh legacy cached chapters containing <ruby>/<rt>'
  );
  assert.equal(legacyRubyChapter.markdown.includes('<rt>'), false);
  assert.ok(legacyRubyChapter.markdown.includes('伽話と宮内悠介の作品を読む。'));

  const pageClassifier = new PageClassifier();
  const rubyPayload = pageClassifier.buildLightweightPayload(legacyRubyChapter);
  assert.equal(
    rubyPayload.snippet.includes('とぎ') || rubyPayload.snippet.includes('みやうち'),
    false,
    `PageClassifier snippet must exclude <rt> furigana, got: ${rubyPayload.snippet}`
  );
  assert.ok(rubyPayload.snippet.includes('伽話と宮内悠介の作品を読む。'));

  console.log('  [OK] Zero-CSS EPUB fallback stylesheet generation & XHTML linkage verified');
  console.log('  [OK] KaTeX inline formula vs currency ($10 and $20) separation verified');
  console.log('  [OK] Multi-paragraph same-page footnote cleanup verified');
  console.log('  [OK] Inline XHTML grammar barrier, backlink <a> purification, heading swap guard & Notes recovery verified');
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
