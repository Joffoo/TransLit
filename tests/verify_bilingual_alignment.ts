import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  EpubService,
  splitMarkdownIntoBlocks,
  alignMarkdownBlocks
} from '../services/epubService';
import { Chapter } from '../types';

async function runBilingualTests() {
  console.log('--- Running Bilingual Alignment & Export Verification ---');

  const epubService = new EpubService();

  // Test 1: Markdown block splitting
  console.log('  Testing splitMarkdownIntoBlocks...');
  const md = `# Chapter 1: The Call

This is paragraph 1.
With multiple lines in same paragraph.

![Image](images/pic1.jpg)

> Blockquote line 1
> Blockquote line 2

- List item 1
- List item 2

\`\`\`python
def hello():
    print("world")
\`\`\`

---

Final paragraph.`;

  const blocks = splitMarkdownIntoBlocks(md);
  assert.equal(blocks.length, 8, `Expected 8 blocks, got ${blocks.length}`);
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[2].type, 'image');
  assert.equal(blocks[3].type, 'blockquote');
  assert.equal(blocks[4].type, 'list');
  assert.equal(blocks[5].type, 'code');
  assert.equal(blocks[6].type, 'hr');
  assert.equal(blocks[7].type, 'paragraph');
  console.log('  [OK] Markdown block splitting accurate across all block types');

  // Test 2: 1-to-1 paragraph alignment
  console.log('  Testing alignMarkdownBlocks: 1-to-1 match...');
  const sBlocks1 = splitMarkdownIntoBlocks(`# Chapter 1\n\nParagraph one.\n\nParagraph two.`);
  const tBlocks1 = splitMarkdownIntoBlocks(`# 第一章\n\n第一段。\n\n第二段。`);
  const pairs1 = alignMarkdownBlocks(sBlocks1, tBlocks1);
  assert.equal(pairs1.length, 3, `Expected 3 pairs, got ${pairs1.length}`);
  assert.equal(pairs1[0].type, 'heading');
  assert.equal(pairs1[0].sourceContent, '# Chapter 1');
  assert.equal(pairs1[0].targetContent, '# 第一章');
  assert.equal(pairs1[1].sourceContent, 'Paragraph one.');
  assert.equal(pairs1[1].targetContent, '第一段。');
  assert.equal(pairs1[2].sourceContent, 'Paragraph two.');
  assert.equal(pairs1[2].targetContent, '第二段。');
  console.log('  [OK] 1-to-1 alignment passed');

  // Test 3: 2-to-1 merge alignment
  console.log('  Testing alignMarkdownBlocks: 2-to-1 merge...');
  const sBlocks2 = splitMarkdownIntoBlocks(`Sentence A.\n\nSentence B.\n\nParagraph three.`);
  const tBlocks2 = splitMarkdownIntoBlocks(`句子A和句子B合在一起。\n\n第三段。`);
  const pairs2 = alignMarkdownBlocks(sBlocks2, tBlocks2);
  assert.equal(pairs2.length, 2, `Expected 2 pairs, got ${pairs2.length}`);
  assert.ok(pairs2[0].sourceContent?.includes('Sentence A.') && pairs2[0].sourceContent?.includes('Sentence B.'));
  assert.equal(pairs2[0].targetContent, '句子A和句子B合在一起。');
  assert.equal(pairs2[1].sourceContent, 'Paragraph three.');
  assert.equal(pairs2[1].targetContent, '第三段。');
  console.log('  [OK] 2-to-1 merge alignment passed');

  // Test 4: 1-to-2 split alignment
  console.log('  Testing alignMarkdownBlocks: 1-to-2 split...');
  const sBlocks3 = splitMarkdownIntoBlocks(`A very long English paragraph containing two distinct thoughts.\n\nNext paragraph is short.`);
  const tBlocks3 = splitMarkdownIntoBlocks(`这是一个很长的段落，包含第一部分翻译思想。\n\n紧接着是第二部分翻译思想。\n\n下一段很短。`);
  const pairs3 = alignMarkdownBlocks(sBlocks3, tBlocks3);
  assert.equal(pairs3.length, 2, `Expected 2 pairs, got ${pairs3.length}`);
  assert.ok(pairs3[0].targetContent?.includes('第一部分') && pairs3[0].targetContent?.includes('第二部分'));
  assert.equal(pairs3[1].sourceContent, 'Next paragraph is short.');
  assert.equal(pairs3[1].targetContent, '下一段很短。');
  console.log('  [OK] 1-to-2 split alignment passed');

  // Test 5: Image preservation without misalignment
  console.log('  Testing image standalone handling...');
  const sBlocks4 = splitMarkdownIntoBlocks(`![Diagram](diagram.png)\n\nExplanation of diagram.`);
  const tBlocks4 = splitMarkdownIntoBlocks(`图表说明。`);
  const pairs4 = alignMarkdownBlocks(sBlocks4, tBlocks4);
  assert.equal(pairs4.length, 2);
  assert.equal(pairs4[0].type, 'image');
  assert.equal(pairs4[1].sourceContent, 'Explanation of diagram.');
  assert.equal(pairs4[1].targetContent, '图表说明。');
  console.log('  [OK] Standalone image handled cleanly');

  // Test 6: renderChapterEpub3Html in 'source_first' mode
  console.log('  Testing renderChapterEpub3Html source_first...');
  const sourceMd = `# Chapter 1\n\nDavid arrived at the station with his suitcase.\n\nHe checked his ticket__FN_REF_fn-1__.`;
  const targetMd = `# 第一章\n\n大卫提着行李箱到达了车站。\n\n他查看了自己的车票__FN_REF_fn-1__。`;
  const fns = {
    'fn-1': {
      key: 'notes.xhtml#fn1',
      sourceFile: 'notes.xhtml',
      originalId: 'fn1',
      label: '1',
      html: 'Platform 9 3/4',
      plainText: 'Platform 9 3/4',
      paragraphs: ['Platform 9 3/4'],
      referencedByChapters: [0]
    }
  };

  const htmlSourceFirst = await epubService.renderChapterEpub3Html(
    targetMd,
    fns,
    { 'fn-1': '九又四分之三站台' },
    sourceMd,
    'source_first'
  );

  assert.ok(htmlSourceFirst.includes('class="bilingual-pair"'), 'Expected .bilingual-pair');
  assert.ok(htmlSourceFirst.includes('class="bilingual-source"'), 'Expected .bilingual-source');
  assert.ok(htmlSourceFirst.includes('class="bilingual-target"'), 'Expected .bilingual-target');
  assert.ok(htmlSourceFirst.includes('David arrived at the station'), 'Expected English text');
  assert.ok(htmlSourceFirst.includes('大卫提着行李箱到达了车站'), 'Expected Chinese text');

  // Check ordering: source should come before target in source_first mode
  const srcIdx = htmlSourceFirst.indexOf('David arrived at the station');
  const tgtIdx = htmlSourceFirst.indexOf('大卫提着行李箱到达了车站');
  assert.ok(srcIdx < tgtIdx, 'In source_first mode, source text must appear before target text');

  // Check footnote popup integration
  assert.ok(htmlSourceFirst.includes('epub:type="noteref"'), 'Expected footnote anchor');
  assert.ok(htmlSourceFirst.includes('footnote-popup'), 'Expected footnote aside');
  assert.ok(htmlSourceFirst.includes('九又四分之三站台'), 'Expected translated footnote text');
  console.log('  [OK] source_first rendering & footnote popup verified');

  // Test 7: renderChapterEpub3Html in 'target_first' mode
  console.log('  Testing renderChapterEpub3Html target_first...');
  const htmlTargetFirst = await epubService.renderChapterEpub3Html(
    targetMd,
    fns,
    { 'fn-1': '九又四分之三站台' },
    sourceMd,
    'target_first'
  );

  const tgtIdx2 = htmlTargetFirst.indexOf('大卫提着行李箱到达了车站');
  const srcIdx2 = htmlTargetFirst.indexOf('David arrived at the station');
  assert.ok(tgtIdx2 < srcIdx2, 'In target_first mode, target text must appear before source text');
  console.log('  [OK] target_first ordering verified');

  // Test 8: Full EPUB generation with bilingual CSS
  console.log('  Testing generateEpub with bilingual mode...');
  const dummyZip = new JSZip();
  dummyZip.file('mimetype', 'application/epub+zip');
  dummyZip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const opfContent = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Novel</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="pub-id">test-123</dc:identifier>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;
  dummyZip.file('OEBPS/content.opf', opfContent);
  dummyZip.file('OEBPS/ch1.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body><h1>Chapter 1</h1><p>Original body</p></body>
</html>`);
  dummyZip.file('OEBPS/style.css', 'body { color: black; }');

  const chapter: Chapter = {
    id: 'ch1',
    index: 0,
    fileName: 'ch1.xhtml',
    title: 'Chapter 1',
    content: '<h1>Chapter 1</h1><p>Original body</p>',
    markdown: '# Chapter 1\n\nOriginal body',
    slottedMarkdown: '# Chapter 1\n\nOriginal body',
    translatedMarkdown: '# 第一章\n\n翻译正文'
  };

  const epubBlob = await epubService.generateEpub(
    [chapter],
    dummyZip,
    'OEBPS/content.opf',
    'OEBPS/',
    ['OEBPS/style.css'],
    'Test Novel',
    'Chinese (Simplified)',
    undefined,
    [],
    'source_first'
  );

  assert.ok(epubBlob.size > 0, 'Blob must not be empty');

  // Inspect generated zip
  const generatedZip = await new JSZip().loadAsync(await epubBlob.arrayBuffer());
  const updatedOpf = await generatedZip.file('OEBPS/content.opf')!.async('string');
  assert.ok(updatedOpf.includes('Test Novel【TransLit-双语-原文在前】'), 'OPF title must reflect bilingual mode');

  const updatedCss = await generatedZip.file('OEBPS/style.css')!.async('string');
  assert.ok(updatedCss.includes('.bilingual-pair'), 'CSS must include bilingual styles');

  const updatedXhtml = await generatedZip.file('OEBPS/ch1.xhtml')!.async('string');
  assert.ok(updatedXhtml.includes('class="bilingual-pair"'), 'XHTML must contain bilingual structure');
  assert.ok(updatedXhtml.includes('Original body'), 'XHTML must contain source');
  assert.ok(updatedXhtml.includes('翻译正文'), 'XHTML must contain target');
  console.log('  [OK] generateEpub bilingual packaging & CSS verified');

  console.log('\n[PASS] ALL_BILINGUAL_TESTS_SUCCESSFUL');
}

runBilingualTests().catch((err) => {
  console.error('[FAIL] Bilingual verification failed:', err);
  process.exit(1);
});
