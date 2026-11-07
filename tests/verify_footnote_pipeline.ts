import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { FootnoteResolver } from '../services/footnoteResolver';
import { PageClassifier, LightweightPagePayload } from '../services/pageClassifier';
import {
  FootnotePool,
  FOOTNOTE_SLOT_PROMPT_CONSTRAINT,
  createFootnoteSlot,
  validateAndRepairSlots,
  isPureUrlOrCode
} from '../services/footnotePool';
import { EpubService } from '../services/epubService';
import { Chapter, FootnoteNode, AppConfig } from '../types';
import { AiService } from '../services/geminiService';

async function runSlice1Tests() {
  console.log('--- Running Slice 1: FootnoteResolver Verification ---');

  const files: Record<string, string> = {
    'Text/chapter1.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1: The Arrival</h1>
  <p>David walked into the IRS Regional Examination Center<a href="notes.xhtml#fn1">[1]</a> and sat down.</p>
  <p>He reviewed the tax code manual<a href="notes.xhtml#fn2">[2]</a> and noticed an internal cross-reference<a href="notes.xhtml#fn1">[1]</a> again.</p>
</body>
</html>`,
    'Text/chapter2.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
  <h1>Chapter 2: The Audit</h1>
  <p>Later that afternoon, the same center<a href="notes.xhtml#fn1">[1]</a> issued a new memorandum.</p>
</body>
</html>`,
    'Text/notes.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Notes</title></head>
<body>
  <h1>Notes</h1>
  <div class="footnotes">
    <p id="fn1"><a href="chapter1.xhtml#ref1">1.</a> The Peoria REC (Regional Examination Center) was established in 1965.</p>
    <p>It employed over 800 rote examiners during peak season.</p>
    <p>See also internal archive box 42.</p>
    <p id="fn2"><a href="chapter1.xhtml#ref2">2.</a> Internal Revenue Manual § 4.10.2, revised 1981.</p>
  </div>
</body>
</html>`
  };

  const resolver = new FootnoteResolver();
  const result = resolver.resolveAll(files, [
    'Text/chapter1.xhtml',
    'Text/chapter2.xhtml',
    'Text/notes.xhtml'
  ]);

  // 1. Topology Index check
  assert.ok(result.topology.has('Text/notes.xhtml#fn1'), 'Topology should index Text/notes.xhtml#fn1');
  assert.ok(result.topology.has('Text/notes.xhtml#fn2'), 'Topology should index Text/notes.xhtml#fn2');

  // 2. Multi-paragraph boundary extraction check
  const fn1Node = result.topology.get('Text/notes.xhtml#fn1')!;
  assert.equal(fn1Node.paragraphs.length, 3, 'fn1 should capture all 3 sibling paragraphs until fn2');
  assert.ok(fn1Node.plainText.includes('Peoria REC'), 'fn1 should include first paragraph');
  assert.ok(fn1Node.plainText.includes('800 rote examiners'), 'fn1 should include second paragraph');
  assert.ok(fn1Node.plainText.includes('archive box 42'), 'fn1 should include third paragraph');
  assert.ok(!fn1Node.plainText.includes('Internal Revenue Manual'), 'fn1 must stop before fn2');

  // 3. Cross-file link internalization & chapter namespace check
  const ch1Resolved = result.chapters['Text/chapter1.xhtml'];
  assert.ok(ch1Resolved, 'Chapter 1 should be resolved');
  assert.ok(
    ch1Resolved.html.includes('href="#fn-0-1"') && ch1Resolved.html.includes('epub:type="noteref"'),
    'Chapter 1 should rewrite notes.xhtml#fn1 to #fn-0-1 with epub:type="noteref"'
  );
  assert.ok(
    ch1Resolved.html.includes('href="#fn-0-2"'),
    'Chapter 1 should rewrite notes.xhtml#fn2 to #fn-0-2'
  );
  assert.ok(
    !ch1Resolved.html.includes('notes.xhtml#fn1'),
    'Chapter 1 should not contain raw cross-file link notes.xhtml#fn1'
  );

  // Chapter 2 namespace check (prevent global ID collision)
  const ch2Resolved = result.chapters['Text/chapter2.xhtml'];
  assert.ok(
    ch2Resolved.html.includes('href="#fn-1-1"'),
    'Chapter 2 should rewrite notes.xhtml#fn1 to its own chapter-namespaced #fn-1-1'
  );

  // 4. Standalone footnote file protection & 0-Offset placeholder check
  assert.ok(
    result.footnoteSourceFiles.has('Text/notes.xhtml'),
    'Text/notes.xhtml should be identified as a standalone footnote source file'
  );
  const zeroOffsetHtml = result.zeroOffsetPlaceholders['Text/notes.xhtml'];
  assert.ok(zeroOffsetHtml, 'Should generate 0-Offset placeholder for Text/notes.xhtml');
  assert.ok(
    zeroOffsetHtml.includes('data-zero-offset="true"') && !zeroOffsetHtml.includes('800 rote examiners'),
    '0-Offset placeholder should be a clean valid XHTML skeleton without drained note content'
  );

  console.log('  [OK] Global pre-scan & topology index (Map<fileRelativePath#id, FootnoteNode>)');
  console.log('  [OK] Multi-paragraph sibling boundary extraction (3 paragraphs captured for #fn1)');
  console.log('  [OK] Cross-file link internalization & chapter-scoped namespacing (#fn-0-1, #fn-1-1)');
  console.log('  [OK] Standalone footnote source protection & 0-Offset XHTML placeholder generation');
  console.log('✓ Slice 1 (FootnoteResolver) passed!');
}

async function runSlice2Tests() {
  console.log('--- Running Slice 2: PageClassifier Verification ---');

  const sampleChapters: Chapter[] = [
    {
      id: 'cov',
      index: 0,
      fileName: 'Text/cover.xhtml',
      title: 'Cover',
      content: '<html><body><div class="cover"><img src="../Images/cover.jpg" alt="cover"/></div></body></html>',
      markdown: '![cover](../Images/cover.jpg)'
    },
    {
      id: 'cip',
      index: 1,
      fileName: 'Text/copyright.xhtml',
      title: 'Copyright',
      content: '<html><body><p>Copyright © 2011 by David Foster Wallace. All rights reserved. ISBN 978-0-316-07423-0. Library of Congress Cataloging-in-Publication Data.</p></body></html>',
      markdown: 'Copyright © 2011 by David Foster Wallace. All rights reserved. ISBN 978-0-316-07423-0.'
    },
    {
      id: 'toc',
      index: 2,
      fileName: 'Text/toc.xhtml',
      title: 'Contents',
      content: '<html><body><nav epub:type="toc"><h1>Table of Contents</h1><ol><li><a href="ch1.xhtml">Chapter 1</a></li><li><a href="ch2.xhtml">Chapter 2</a></li></ol></nav></body></html>',
      markdown: '# Table of Contents\n1. [Chapter 1](ch1.xhtml)\n2. [Chapter 2](ch2.xhtml)'
    },
    {
      id: 'ded',
      index: 3,
      fileName: 'Text/front_01.xhtml',
      title: 'Editor Note',
      content: `<html><body><h1>Author's Foreword</h1><p>${'This foreword explains the archival assembling of the manuscript after 2008. '.repeat(8)}</p></body></html>`,
      markdown: `# Author's Foreword\n\n${'This foreword explains the archival assembling of the manuscript after 2008. '.repeat(8)}`
    },
    {
      id: 'ch1',
      index: 4,
      fileName: 'Text/ch1.xhtml',
      title: 'Chapter 1',
      content: `<html><body><h1>Chapter 1</h1><p>${'Pastures of flattened rye and wild oats stretched to the horizon under a pale sky. '.repeat(35)}</p></body></html>`,
      markdown: `# Chapter 1\n\n${'Pastures of flattened rye and wild oats stretched to the horizon under a pale sky. '.repeat(35)}`,
      internalizedFootnotes: {
        '4-1': {
          key: 'Text/notes.xhtml#fn1',
          sourceFile: 'Text/notes.xhtml',
          originalId: 'fn1',
          namespaceId: '4-1',
          label: '1',
          html: '<p>Footnote 1 content</p>',
          plainText: 'Footnote 1 content',
          paragraphs: ['Footnote 1 content'],
          referencedByChapters: [4]
        }
      }
    },
    {
      id: 'notes',
      index: 5,
      fileName: 'Text/notes.xhtml',
      title: 'Notes',
      content: '<html><body><h1>Notes</h1><p id="fn1">1. Footnote 1 content</p></body></html>',
      markdown: '# Notes\n\n1. Footnote 1 content',
      isFootnoteSource: true
    }
  ];

  const classifier = new PageClassifier();

  // Stage 1: Zero-latency local rule classification
  const stage1Chapters = classifier.classifyChaptersLocal(sampleChapters);

  assert.equal(stage1Chapters[0].classification?.category, 'media_only', 'Cover should be media_only');
  assert.equal(stage1Chapters[0].classification?.disposition, 'keep_original', 'Media-only should default to keep_original');
  assert.equal(stage1Chapters[0].isReference, true, 'Media-only sets isReference=true');
  assert.equal(stage1Chapters[0].isSkippable, false, 'Media-only sets isSkippable=false');

  assert.equal(stage1Chapters[1].classification?.category, 'copyright', 'CIP page should be copyright');
  assert.equal(stage1Chapters[1].classification?.disposition, 'skip', 'Copyright page should default to skip');
  assert.equal(stage1Chapters[1].isSkippable, true, 'Copyright page sets isSkippable=true');

  assert.equal(stage1Chapters[2].classification?.category, 'toc', 'TOC page should be toc');
  assert.equal(stage1Chapters[2].classification?.disposition, 'system_toc', 'TOC page should default to system_toc');

  assert.equal(stage1Chapters[3].classification?.category, 'ambiguous', 'Transition page should be marked ambiguous for Stage 2 AI');

  assert.equal(stage1Chapters[4].classification?.category, 'content', 'Long narrative chapter should be content');
  assert.equal(stage1Chapters[4].classification?.disposition, 'translate', 'Narrative chapter should default to translate');

  assert.equal(stage1Chapters[5].classification?.category, 'footnote_source', 'Standalone notes page should be footnote_source');
  assert.equal(stage1Chapters[5].classification?.disposition, 'system_footnote_source', 'Standalone notes page should be system_footnote_source');
  assert.equal(stage1Chapters[5].isSystemProtected, true, 'Standalone notes page should be system protected');

  // Stage 2: Lightweight AI progressive async verdict
  const capturedPayloads: LightweightPagePayload[] = [];
  const stage2Chapters = await classifier.classifyAmbiguousPagesAi(
    stage1Chapters,
    async (payload) => {
      capturedPayloads.push(payload);
      return {
        category: 'front_matter',
        disposition: 'translate',
        reason: 'Foreword by author is essential narrative content',
        confidence: 0.95
      };
    }
  );

  assert.equal(capturedPayloads.length, 1, 'Only the 1 ambiguous transition page should trigger Stage 2 AI');
  assert.equal(capturedPayloads[0].title, 'Editor Note');
  assert.ok(capturedPayloads[0].wordCount > 0, 'Payload must include wordCount');
  assert.ok(capturedPayloads[0].snippet.length <= 200, 'Payload snippet must be strictly <= 200 chars');
  assert.equal(stage2Chapters[3].classification?.stage, 'lightweight_ai', 'Stage should update to lightweight_ai');
  assert.equal(stage2Chapters[3].classification?.disposition, 'translate');

  // Lifecycle decoupling: Footnote translation follows host body chapter, NOT standalone notes file
  stage2Chapters[5].isSkippable = true; // Even if someone tries to skip notes.xhtml
  assert.equal(
    classifier.shouldTranslateChapterFootnotes(stage2Chapters[4]),
    true,
    'Chapter 1 footnotes must be translated because Chapter 1 is translated, regardless of notes.xhtml status'
  );

  console.log('  [OK] Stage 1 zero-latency DOM/keyword rules (media_only, copyright, toc, footnote_source, content, ambiguous)');
  console.log('  [OK] Stage 2 lightweight AI async verdict (payload strictly { title, wordCount, snippet <= 200 chars })');
  console.log('  [OK] Footnote translation lifecycle bound to host body chapter, decoupled from standalone notes file');
  console.log('✓ Slice 2 (PageClassifier) passed!');
}

async function runSlice3And4Tests() {
  console.log('--- Running Slice 3 & 4: FootnotePool & Context-Aware Chunker Verification ---');

  // 1. Opaque Slotting & Prompt Constraint check
  assert.equal(createFootnoteSlot('0-1'), '__FN_REF_0-1__');
  assert.ok(
    FOOTNOTE_SLOT_PROMPT_CONSTRAINT.includes('__FN_REF_{id}__'),
    'Prompt constraint must explicitly mention __FN_REF_{id}__'
  );

  // Repair & validation check when LLM mangles casing/spacing or drops a slot
  const validationRes = validateAndRepairSlots(
    'Hello __FN_REF_0-1__ and __FN_REF_0-2__.',
    '你好 __fn_ref_ 0-1 __ 以及遗漏了第二个。'
  );
  assert.equal(validationRes.isValidAfterRepair, true);
  assert.ok(validationRes.repairedText.includes('__FN_REF_0-1__'), 'Should normalize mangled slot');
  assert.ok(validationRes.repairedText.includes('__FN_REF_0-2__'), 'Should recover dropped slot');

  // 2. Global FootnoteTranslationPool & Context-Aware Chunking + Oversized Footnote Shunting
  const giantParagraphs = [
    'Giant footnote paragraph 1: Historical tax statute analysis of 1965. '.repeat(6),
    'Giant footnote paragraph 2: Administrative procedures and regional sub-clauses. '.repeat(6),
    'Giant footnote paragraph 3: Final judicial review notes and archival citations. '.repeat(6)
  ];

  const internalizedFootnotes: Record<string, FootnoteNode> = {
    '0-1': {
      key: 'Text/notes.xhtml#fn1',
      sourceFile: 'Text/notes.xhtml',
      originalId: 'fn1',
      namespaceId: '0-1',
      label: '1',
      html: '<p>Short note about Peoria REC.</p>',
      plainText: 'Short note about Peoria REC.',
      paragraphs: ['Short note about Peoria REC.'],
      referencedByChapters: [0]
    },
    '0-2': {
      key: 'Text/notes.xhtml#fn2',
      sourceFile: 'Text/notes.xhtml',
      originalId: 'fn2',
      namespaceId: '0-2',
      label: '2',
      html: giantParagraphs.map((p) => `<p>${p}</p>`).join(''),
      plainText: giantParagraphs.join('\n\n'),
      paragraphs: giantParagraphs,
      referencedByChapters: [0]
    }
  };

  const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h1>Chapter 1</h1>
  <p>Paragraph A introduces the Peoria facility<a id="fnref-0-1" href="#fn-0-1" epub:type="noteref" class="noteref" data-fn-id="0-1">[1]</a> in detail. ${'More narrative text here. '.repeat(10)}</p>
  <p>Paragraph B cites the giant statutory note<a id="fnref-0-2" href="#fn-0-2" epub:type="noteref" class="noteref" data-fn-id="0-2">[2]</a> for reference.</p>
  <p>Paragraph C in a later chunk cites the first note<a id="fnref-0-1-2" href="#fn-0-1" epub:type="noteref" class="noteref" data-fn-id="0-1">[1]</a> a second time! ${'Closing narrative text here. '.repeat(10)}</p>
</body>
</html>`;

  const pool = new FootnotePool({
    maxChunkChars: 450,
    oversizedFootnoteThresholdChars: 500
  });

  // Build context-aware chunks from XHTML blocks
  const blocks = pool.parseChapterToBlocks(chapterHtml, internalizedFootnotes);
  assert.ok(blocks.length >= 3, 'Should parse chapter into top-level blocks');
  assert.ok(
    blocks.some((b) => b.slottedMarkdown.includes('__FN_REF_0-1__')),
    'Block should replace noteref anchor with __FN_REF_0-1__ slot'
  );

  // Track how many times each footnote is sent for translation vs reference context
  const translatedFootnoteCalls: string[] = [];
  const referenceContextHits: string[] = [];

  // Mock translateChunk(string) -> Promise<string>
  const mockTranslateChunk = async (payload: string): Promise<string> => {
    if (payload.includes('[FOOTNOTES_TO_TRANSLATE]')) {
      const matches = [...payload.matchAll(/\[FN_DEF:([^\]]+)\]([\s\S]*?)\[\/FN_DEF\]/g)];
      for (const m of matches) {
        translatedFootnoteCalls.push(m[1]);
      }
    }
    if (payload.includes('[FOOTNOTES_REFERENCE_ONLY]')) {
      const refMatches = [...payload.matchAll(/\[FN_REF_CTX:([^\]]+)\]/g)];
      for (const m of refMatches) {
        referenceContextHits.push(m[1]);
      }
    }

    // Deterministically translate main content and pending footnotes while keeping __FN_REF_{id}__ intact
    return payload
      .replace(/Paragraph A introduces the Peoria facility/g, '段落A介绍了皮奥里亚中心')
      .replace(/Paragraph B cites the giant statutory note/g, '段落B引用了巨型法规注脚')
      .replace(/Paragraph C in a later chunk cites the first note/g, '后序切片中的段落C再次引用了第一条注脚')
      .replace(/Short note about Peoria REC\./g, '关于皮奥里亚审查中心的简短注释。')
      .replace(/Giant footnote paragraph 1/g, '巨型注脚第一段')
      .replace(/Giant footnote paragraph 2/g, '巨型注脚第二段')
      .replace(/Giant footnote paragraph 3/g, '巨型注脚第三段');
  };

  const chapterTranslationResult = await pool.translateChapterWithPool(
    chapterHtml,
    internalizedFootnotes,
    mockTranslateChunk
  );

  // Verify 0-1 was translated ONCE (in Chunk 1) and passed as READ-ONLY REFERENCE in the later chunk!
  const fn01TranslateCount = translatedFootnoteCalls.filter((id) => id === '0-1').length;
  assert.equal(fn01TranslateCount, 1, 'Footnote 0-1 must only be translated ONCE across chunks');
  assert.ok(
    referenceContextHits.includes('0-1'),
    'Subsequent chunk citing 0-1 must receive it in [FOOTNOTES_REFERENCE_ONLY]'
  );

  // Verify oversized footnote 0-2 was shunted and translated in split sub-chunks, then reassembled
  const translatedFn02 = pool.getTranslatedFootnote('0-2', 'Text/notes.xhtml#fn2');
  assert.ok(translatedFn02, 'Oversized footnote 0-2 should be stored in pool');
  assert.ok(
    translatedFn02.translatedText.includes('巨型注脚第一段') &&
      translatedFn02.translatedText.includes('巨型注脚第三段'),
    'Oversized footnote 0-2 should have all paragraphs translated and reassembled'
  );
  assert.equal(
    translatedFn02.wasOversizedShunted,
    true,
    'Oversized footnote 0-2 should be marked as shunted'
  );

  // Verify translated body preserves all __FN_REF_{id}__ slots
  assert.ok(
    chapterTranslationResult.slottedTranslatedMarkdown.includes('__FN_REF_0-1__') &&
      chapterTranslationResult.slottedTranslatedMarkdown.includes('__FN_REF_0-2__'),
    'Translated markdown must preserve all __FN_REF_{id}__ slots'
  );

  console.log('  [OK] Opaque footnote slotting (__FN_REF_{id}__) & deterministic slot validation/repair');
  console.log('  [OK] Global FootnoteTranslationPool deduplication (first appearance translated; subsequent chunks injected as [FOOTNOTES_REFERENCE_ONLY])');
  console.log('  [OK] Oversized footnote token-budget shunting & multi-chunk reassembly');
  console.log('  [OK] Top-level block mapping & dual-channel translateChunk(string) -> Promise<string> contract');
  console.log('✓ Slice 3 & 4 (FootnotePool & Context-Aware Chunker) passed!');
}

async function runSlice5EndToEndTests() {
  console.log('--- Running Slice 5: Full End-to-End EPUB 3 Native Popup & 0-Offset Verification ---');

  const inputZip = new JSZip();
  inputZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  inputZip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  inputZip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Pale King</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:12345678-1234-1234-1234-1234567890ab</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="Styles/styles.css" media-type="text/css"/>
    <item id="cip" href="Text/copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="Text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cip"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="notes"/>
  </spine>
</package>`
  );

  inputZip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>Copyright</text></navLabel>
      <content src="Text/copyright.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-2" playOrder="2">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="Text/chapter1.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-3" playOrder="3">
      <navLabel><text>Chapter 2</text></navLabel>
      <content src="Text/chapter2.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-4" playOrder="4">
      <navLabel><text>Notes</text></navLabel>
      <content src="Text/notes.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
  );

  inputZip.file('OEBPS/Styles/styles.css', 'body { font-family: serif; }');

  inputZip.file(
    'OEBPS/Text/copyright.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Copyright</title></head>
<body>
  <p>Copyright © 2011 by David Foster Wallace. All rights reserved. ISBN 978-0-316-07423-0.</p>
</body>
</html>`
  );

  inputZip.file(
    'OEBPS/Text/chapter1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1</h1>
  <p>Claude Sylvanshine arrived at the Peoria Regional Examination Center<a href="notes.xhtml#fn1">1</a> in the morning.</p>
  <p>He studied the tax regulations<a href="notes.xhtml#fn2">2</a> all afternoon.</p>
</body>
</html>`
  );

  inputZip.file(
    'OEBPS/Text/chapter2.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
  <h1>Chapter 2</h1>
  <p>Meanwhile, Leonard Stecyk also reported to the same center<a href="notes.xhtml#fn1">1</a> on Monday.</p>
</body>
</html>`
  );

  inputZip.file(
    'OEBPS/Text/notes.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Notes</title></head>
<body>
  <h1 id="notes-top">Notes</h1>
  <div class="footnotes">
    <p id="fn1"><a href="chapter1.xhtml#r1">1.</a> The Peoria REC is located at 047 Industry Way.</p>
    <p>It processes Midwest returns.</p>
    <p id="fn2"><a href="chapter1.xhtml#r2">2.</a> See IRC Section 61(a) regarding gross income.</p>
  </div>
</body>
</html>`
  );

  const epubArrayBuffer = await inputZip.generateAsync({ type: 'arraybuffer' });
  const epubService = new EpubService();

  // 1. Parse EPUB (runs FootnoteResolver + PageClassifier Stage 1)
  const parsed = await epubService.parseEpub(epubArrayBuffer as any);
  assert.equal(parsed.chapters.length, 4, 'Should extract 4 spine chapters');

  const cipChapter = parsed.chapters[0];
  const ch1 = parsed.chapters[1];
  const ch2 = parsed.chapters[2];
  const notesCh = parsed.chapters[3];

  assert.equal(cipChapter.isSkippable, true, 'Copyright page should be marked skippable');
  assert.equal(notesCh.isFootnoteSource, true, 'notes.xhtml should be marked isFootnoteSource');
  assert.equal(notesCh.isSystemProtected, true, 'notes.xhtml should be marked isSystemProtected');
  assert.ok(
    ch1.internalizedFootnotes && Object.keys(ch1.internalizedFootnotes).length === 2,
    'Chapter 1 should have 2 internalized footnotes'
  );
  assert.ok(
    ch2.internalizedFootnotes && Object.keys(ch2.internalizedFootnotes).length === 1,
    'Chapter 2 should have 1 internalized footnote'
  );

  // 2. Translate chapters using shared FootnotePool
  const pool = new FootnotePool();
  const mockTranslate = async (payload: string): Promise<string> => {
    return payload
      .replace(/Claude Sylvanshine arrived at the Peoria Regional Examination Center/g, '克劳德·西尔万夏恩抵达了皮奥里亚区域审查中心')
      .replace(/in the morning\./g, '在清晨时分。')
      .replace(/He studied the tax regulations/g, '他研读了税务条例')
      .replace(/all afternoon\./g, '整整一个下午。')
      .replace(/Meanwhile, Leonard Stecyk also reported to the same center/g, '与此同时，伦纳德·斯泰西克也向同一中心报到')
      .replace(/on Monday\./g, '在周一那天。')
      .replace(/The Peoria REC is located at 047 Industry Way\./g, '皮奥里亚审查中心位于工业大道047号。')
      .replace(/It processes Midwest returns\./g, '该中心负责处理中西部税表。')
      .replace(/See IRC Section 61\(a\) regarding gross income\./g, '参见《国内税收法典》第61(a)条关于总收入之规定。');
  };

  for (const ch of [ch1, ch2]) {
    const res = await pool.translateChapterWithPool(
      ch.content,
      ch.internalizedFootnotes || {},
      mockTranslate
    );
    ch.translatedMarkdown = res.slottedTranslatedMarkdown;
    ch.proofreadMarkdown = res.slottedTranslatedMarkdown;
    ch.translatedFootnotes = res.translatedFootnotes;
  }

  // 3. Generate EPUB 3 output
  const reloadedZip = await new JSZip().loadAsync(epubArrayBuffer);
  const excludeFileNames = parsed.chapters
    .filter((c) => c.isSkippable && !c.isFootnoteSource)
    .map((c) => c.fileName);

  const outputBlob = await epubService.generateEpub(
    parsed.chapters.filter((c) => !c.isSkippable || c.isFootnoteSource),
    reloadedZip,
    parsed.opfPath,
    parsed.opfDir,
    parsed.cssFiles,
    'The Pale King',
    'Chinese (Simplified)',
    undefined,
    excludeFileNames
  );

  const outputBuffer = await outputBlob.arrayBuffer();
  const outZip = await new JSZip().loadAsync(outputBuffer);

  // 4. Verify OPF upgraded to EPUB 3.0
  const outOpf = await outZip.file('OEBPS/content.opf')!.async('string');
  assert.ok(
    /version=["']3\.0["']/i.test(outOpf),
    'OPF version should be automatically upgraded to 3.0'
  );

  // 5. Verify Chapter 1 XHTML has xmlns:epub, standard noteref, and <aside epub:type="footnote">
  const outCh1 = await outZip.file('OEBPS/Text/chapter1.xhtml')!.async('string');
  assert.ok(
    outCh1.includes('xmlns:epub="http://www.idpf.org/2007/ops"'),
    'Generated XHTML must include xmlns:epub="http://www.idpf.org/2007/ops"'
  );
  assert.ok(
    outCh1.includes('<a id="fnref-1-1" href="#fn-1-1" epub:type="noteref" class="noteref"><sup>[1]</sup></a>'),
    `Chapter 1 must contain standard EPUB 3 noteref anchor for note 1-1. Actual outCh1:\n${outCh1}`
  );
  assert.ok(
    outCh1.includes('<aside id="fn-1-1" epub:type="footnote" class="footnote-popup">'),
    'Chapter 1 must contain standard <aside id="fn-1-1" epub:type="footnote" class="footnote-popup">'
  );
  assert.ok(
    outCh1.includes('<a href="#fnref-1-1" class="footnote-backref">[1]</a>'),
    'Chapter 1 aside must contain <a href="#fnref-1-1" class="footnote-backref">[1]</a>'
  );
  assert.ok(
    outCh1.includes('皮奥里亚审查中心位于工业大道047号。') &&
      outCh1.includes('该中心负责处理中西部税表。'),
    'Chapter 1 aside must contain the translated multi-paragraph footnote text'
  );
  assert.ok(
    !outCh1.includes('<section class="footnotes"'),
    'Chapter 1 must NOT use legacy <section class="footnotes">'
  );

  // 6. Verify CSS includes EPUB 3 popup footnote rules
  const outCss = await outZip.file('OEBPS/Styles/styles.css')!.async('string');
  assert.ok(
    outCss.includes('.footnote-popup') &&
      outCss.includes('.noteref') &&
      outCss.includes('.footnote-backref'),
    'Stylesheet must include EPUB 3 popup footnote CSS rules'
  );

  // 7. Verify 0-Offset placeholder for notes.xhtml (retained in ZIP, OPF, and NCX!)
  const outNotesFile = outZip.file('OEBPS/Text/notes.xhtml');
  assert.ok(
    outNotesFile,
    'Standalone notes.xhtml MUST NOT be physically deleted from ZIP (0-Offset guarantee)'
  );
  const outNotesHtml = await outNotesFile.async('string');
  assert.ok(
    outNotesHtml.includes('data-zero-offset="true"'),
    'Drained notes.xhtml must contain the 0-Offset XHTML placeholder'
  );
  assert.ok(
    outOpf.includes('Text/notes.xhtml'),
    'OPF manifest must retain Text/notes.xhtml'
  );
  const outNcx = await outZip.file('OEBPS/toc.ncx')!.async('string');
  assert.ok(
    outNcx.includes('Text/notes.xhtml'),
    'toc.ncx must retain Text/notes.xhtml without dead links'
  );
  assert.equal(
    outZip.file('OEBPS/Text/copyright.xhtml'),
    null,
    'Skipped copyright.xhtml should be removed from ZIP'
  );

  console.log('  [OK] OPF 2.0 -> EPUB 3.0 header auto-upgrade & XHTML xmlns:epub="http://www.idpf.org/2007/ops" injection');
  console.log('  [OK] Standard EPUB 3 noteref anchor (<a id="fnref-{id}" href="#fn-{id}" epub:type="noteref" class="noteref"><sup>[{n}]</sup></a>)');
  console.log('  [OK] Standard EPUB 3 popup aside (<aside id="fn-{id}" epub:type="footnote" class="footnote-popup">)');
  console.log('  [OK] Popup CSS rules injected into stylesheet (.footnote-popup, .noteref, .footnote-backref)');
  console.log('  [OK] 0-Offset placeholder preserved in ZIP, content.opf (Manifest/Spine), and toc.ncx');
  console.log('✓ Slice 5 (Full E2E EPUB 3 Native Popup & 0-Offset Packaging) passed!');
}

async function runSlice6RealWorldEpub3RegressionTests() {
  console.log('--- Running Slice 6: Real-World EPUB 3 Regression Verification (Simon & Schuster / Pagebreak / Backlink / Index) ---');

  const files: Record<string, string> = {
    'xhtml/ch01.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Chapter 1: Why You Can’t See Your Own Life Clearly</title></head>
<body>
  <section aria-labelledby="ch01_hd" role="doc-chapter">
    <span aria-label="10" id="page_10" role="doc-pagebreak"/>
    <h1 id="ch01_hd">Chapter 1: Why You Can’t See Your Own Life Clearly</h1>
    <p>This is what psychotherapists call<span id="note1"/> “unresolved trauma” in daily life.<sup class="sup"><a href="#footnote-025" id="footnote-025-backlink" role="doc-noteref">1</a></sup></p>
    <aside class="box">
      <p class="boxh">Sidebar Box</p>
      <p class="box1">Even inside a callout box, footnotes work<sup class="sup"><a href="#footnote-024" id="footnote-024-backlink" role="doc-noteref">2</a></sup> seamlessly.</p>
    </aside>
    <section role="doc-endnotes">
      <hr class="fn-hr"/>
      <ol class="fnlist">
        <li class="footnote1"><a href="ch01.xhtml#footnote-025-backlink" id="footnote-025" role="doc-backlink">1</a> By analogy to Peak Oil, attention has limits.</li>
        <li class="footnote"><a href="ch01.xhtml#footnote-024-backlink" id="footnote-024" role="doc-backlink">2</a> As one of my students put it, perspective matters.</li>
      </ol>
    </section>
  </section>
</body>
</html>`,
    'xhtml/ch04_sub02.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Diagram</title></head>
<body>
  <section role="doc-chapter">
    <span aria-label="77" id="page_77" role="doc-pagebreak"/>
    <figure class="large" id="det02">
      <img alt="Diagram" src="../images/f0077-01.jpg"/>
      <figcaption><a href="longdesc.xhtml#desc02">Description 2</a></figcaption>
    </figure>
  </section>
</body>
</html>`,
    'xhtml/endnotes.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Notes</title></head>
<body>
  <section aria-labelledby="endnotes_hd" role="doc-endnotes">
    <h1 id="endnotes_hd">Notes</h1>
    <ol class="Notes">
      <li class="ennote"><a href="ch01.xhtml#note1"><i>This is what psychotherapists call</i></a>: Oliver Burkeman, Four Thousand Weeks.</li>
    </ol>
  </section>
</body>
</html>`,
    'xhtml/index.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Index</title></head>
<body>
  <section aria-labelledby="index_hd" role="doc-index">
    <h1 id="index_hd">Index</h1>
    <p class="ind">A, <a class="indref" href="ch01.xhtml#page_10">10</a></p>
  </section>
</body>
</html>`,
    'xhtml/longdesc.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Image Descriptions</title></head>
<body>
  <section aria-labelledby="longdesc_hd">
    <h1 id="longdesc_hd">Image Descriptions</h1>
    <div class="longdesc" id="desc02">
      <p>Full text description of diagram 2.</p>
      <p><a href="ch04_sub02.xhtml#det02">Return to image.</a></p>
    </div>
  </section>
</body>
</html>`
  };

  const resolver = new FootnoteResolver();
  const res = resolver.resolveAll(files, [
    'xhtml/ch01.xhtml',
    'xhtml/ch04_sub02.xhtml',
    'xhtml/endnotes.xhtml',
    'xhtml/index.xhtml',
    'xhtml/longdesc.xhtml'
  ]);

  // 1. None of these files should be marked as a drained 0-Offset footnote source!
  assert.equal(
    res.footnoteSourceFiles.size,
    0,
    'No chapter or unreferenced endnotes file should be falsely marked as a 0-Offset drained footnote source'
  );

  // 2. ch01.xhtml must internalize both #footnote-025 and #footnote-024, and strip <section role="doc-endnotes">
  const ch1 = res.chapters['xhtml/ch01.xhtml'];
  assert.equal(
    Object.keys(ch1.internalizedFootnotes).length,
    2,
    'ch01.xhtml must internalize both same-page doc-noteref footnotes even when anchor has id="*-backlink"'
  );
  assert.ok(
    !ch1.html.includes('By analogy to Peak Oil'),
    'Drained same-page <section role="doc-endnotes"> must be removed from ch01.xhtml body'
  );

  // 3. index.xhtml and endnotes.xhtml must have 0 internalized footnotes
  assert.equal(
    Object.keys(res.chapters['xhtml/index.xhtml'].internalizedFootnotes).length,
    0,
    'index.xhtml page links (#page_10) must never be internalized as footnotes'
  );
  assert.equal(
    Object.keys(res.chapters['xhtml/endnotes.xhtml'].internalizedFootnotes).length,
    0,
    'endnotes.xhtml outgoing quote links (ch01.xhtml#note1) must never internalize body paragraphs'
  );

  console.log('  [OK] Self-closing XHTML tags (<span id="page_10"/>, <span id="note1"/>) expanded without swallowing DOM siblings');
  console.log('  [OK] In-text <a role="doc-noteref" id="footnote-025-backlink"> accurately internalized and <section role="doc-endnotes"> cleaned up');
  console.log('  [OK] Unreferenced bibliographic endnotes.xhtml preserved intact (never overwritten with 0-Offset placeholder)');
  console.log('  [OK] Index (#page_10) and Longdesc (#desc02) links ignored by footnote resolver');
  console.log('✓ Slice 6 (Real-World EPUB 3 Regression Verification) passed!');
}

async function runSlice7Tests() {
  console.log('--- Running Slice 7: Real-World Dual-Channel Footnote Robustness Suite ---');

  const pool = new FootnotePool();

  const fn28_1: FootnoteNode = {
    key: 'Text/notes.xhtml#fn1',
    sourceFile: 'Text/notes.xhtml',
    originalId: 'fn1',
    namespaceId: '28-1',
    label: '1',
    html: '<p>Original footnote 1 content</p>',
    plainText: 'Original footnote 1 content',
    paragraphs: ['Original footnote 1 content'],
    referencedByChapters: [28]
  };

  const fn28_2: FootnoteNode = {
    key: 'Text/notes.xhtml#fn2',
    sourceFile: 'Text/notes.xhtml',
    originalId: 'fn2',
    namespaceId: '28-2',
    label: '2',
    html: '<p>Original footnote 2 content</p>',
    plainText: 'Original footnote 2 content',
    paragraphs: ['Original footnote 2 content'],
    referencedByChapters: [28]
  };

  // 1. Scenario 1: Full-width colon & Chinese brackets support (【FN_DEF：...】)
  const resp1 = `
[MAIN_CONTENT]
第一段正文__FN_REF_28-1__，第二段正文__FN_REF_28-2__。
[/MAIN_CONTENT]

【FN_DEF：28-1】
全角中文括号与全角冒号测试内容
【/FN_DEF】

[FN_DEF: 28-2]
半角括号与多余空格测试内容
[/FN_DEF]
`;
  const parsed1 = pool.parseDualChannelResponse(
    resp1,
    '第一段正文__FN_REF_28-1__，第二段正文__FN_REF_28-2__。',
    [fn28_1, fn28_2]
  );
  assert.equal(
    parsed1.translatedFootnotes['28-1'],
    '全角中文括号与全角冒号测试内容',
    'Scenario 1: Should extract 【FN_DEF：28-1】 with full-width colon and Chinese brackets'
  );
  assert.equal(
    parsed1.translatedFootnotes['28-2'],
    '半角括号与多余空格测试内容',
    'Scenario 1: Should extract [FN_DEF: 28-2] with whitespace'
  );
  assert.ok(
    !parsed1.translatedBody.includes('FN_DEF'),
    'Scenario 1: translatedBody must not leak FN_DEF tags'
  );

  // 2. Scenario 2: Standard Markdown footnote syntax ([^1]: / [^28-1]:)
  const resp2 = `
[MAIN_CONTENT]
正文段落__FN_REF_28-1__与__FN_REF_28-2__。
[/MAIN_CONTENT]

[^28-1]: 标准Markdown命名空间脚注1
[^28-2]: 标准Markdown命名空间脚注2
`;
  const parsed2 = pool.parseDualChannelResponse(
    resp2,
    '正文段落__FN_REF_28-1__与__FN_REF_28-2__。',
    [fn28_1, fn28_2]
  );
  assert.equal(
    parsed2.translatedFootnotes['28-1'],
    '标准Markdown命名空间脚注1',
    'Scenario 2: Should extract standard markdown syntax [^28-1]:'
  );
  assert.equal(
    parsed2.translatedFootnotes['28-2'],
    '标准Markdown命名空间脚注2',
    'Scenario 2: Should extract standard markdown syntax [^28-2]:'
  );
  assert.ok(
    !parsed2.translatedBody.includes('[^28-1]:'),
    'Scenario 2: translatedBody must strip markdown footnote definitions'
  );

  // 3. Scenario 3: Natural number mapping (Level 2) & In-slice position fallback (Level 3)
  const resp3Natural = `
[MAIN_CONTENT]
自然序号正文__FN_REF_28-1__与__FN_REF_28-2__。
[/MAIN_CONTENT]

[FN_DEF: 1]
自然数字1映射到28-1
[/FN_DEF]

[FN_DEF: 2]
自然数字2映射到28-2
[/FN_DEF]
`;
  const parsed3Natural = pool.parseDualChannelResponse(
    resp3Natural,
    '自然序号正文__FN_REF_28-1__与__FN_REF_28-2__。',
    [fn28_1, fn28_2]
  );
  assert.equal(
    parsed3Natural.translatedFootnotes['28-1'],
    '自然数字1映射到28-1',
    'Scenario 3: Level 2 natural number "1" must map to "28-1"'
  );
  assert.equal(
    parsed3Natural.translatedFootnotes['28-2'],
    '自然数字2映射到28-2',
    'Scenario 3: Level 2 natural number "2" must map to "28-2"'
  );

  const resp3Positional = `
[MAIN_CONTENT]
位置回退正文__FN_REF_28-1__与__FN_REF_28-2__。
[/MAIN_CONTENT]

[FN_DEF: alpha]
第一条位置回退内容
[/FN_DEF]

[FN_DEF: beta]
第二条位置回退内容
[/FN_DEF]
`;
  const parsed3Positional = pool.parseDualChannelResponse(
    resp3Positional,
    '位置回退正文__FN_REF_28-1__与__FN_REF_28-2__。',
    [fn28_1, fn28_2]
  );
  assert.equal(
    parsed3Positional.translatedFootnotes['28-1'],
    '第一条位置回退内容',
    'Scenario 3: Level 3 position index 0 must map to "28-1"'
  );
  assert.equal(
    parsed3Positional.translatedFootnotes['28-2'],
    '第二条位置回退内容',
    'Scenario 3: Level 3 position index 1 must map to "28-2"'
  );

  // 4. Scenario 4: Salvaging leaked footnotes from <translation_draft> or outside </translation>
  const dummyConfig: AppConfig = {
    apiKey: 'mock-key',
    baseUrl: 'https://mock.api',
    modelName: 'mock-model',
    sourceLanguage: 'English',
    enableGlossary: false,
    enableProofreading: true,
    smartSkip: true,
    useRecommendedPrompts: true,
    additionalContext: ''
  };
  const aiService = new AiService(dummyConfig);

  const rawTwoStepLeaked = `
<think>思考内容</think>
<translation_draft>
初稿正文
[FN_DEF:28-1]
草稿标签内遗留的脚注1
[/FN_DEF]
</translation_draft>
<translation>
第二步：最终审校润色后的内容
这是润色后的正文__FN_REF_28-1__与__FN_REF_28-2__。
</translation>
[FN_DEF:28-2]
闭合标签外部遗留的脚注2
[/FN_DEF]
[^28-3]: 外部遗留的Markdown脚注3
`;
  const parsedResponse = (aiService as any).parseResponse(rawTwoStepLeaked);
  assert.ok(
    parsedResponse.translation.includes('[FN_DEF:28-1]'),
    'Scenario 4: Leaked [FN_DEF:28-1] in <translation_draft> must be salvaged into result.translation'
  );
  assert.ok(
    parsedResponse.translation.includes('草稿标签内遗留的脚注1'),
    'Scenario 4: Salvaged draft footnote text must be preserved'
  );
  assert.ok(
    parsedResponse.translation.includes('[FN_DEF:28-2]'),
    'Scenario 4: Leaked [FN_DEF:28-2] outside </translation> must be salvaged into result.translation'
  );
  assert.ok(
    parsedResponse.translation.includes('闭合标签外部遗留的脚注2'),
    'Scenario 4: Salvaged trailing footnote text must be preserved'
  );
  assert.ok(
    parsedResponse.translation.includes('[^28-3]: 外部遗留的Markdown脚注3'),
    'Scenario 4: Salvaged trailing markdown footnote must be preserved'
  );

  // 5. Scenario 5: Slot repair when LLM emits [^1], [^2] in translated body
  const originalChunkText = '第一段原文__FN_REF_28-1__。\n\n第二段原文__FN_REF_28-2__。';
  const llmMarkdownTranslated = '第一段译文[^1]。\n\n第二段译文[^2]。';
  const slotRepairResult = validateAndRepairSlots(originalChunkText, llmMarkdownTranslated);

  assert.equal(
    slotRepairResult.repairedText,
    '第一段译文__FN_REF_28-1__。\n\n第二段译文__FN_REF_28-2__。',
    'Scenario 5: [^1] and [^2] must map in-place to __FN_REF_28-1__ and __FN_REF_28-2__'
  );
  assert.equal(
    slotRepairResult.missingIds.length,
    0,
    'Scenario 5: missingIds must be empty after in-place mapping'
  );
  assert.ok(
    !slotRepairResult.repairedText.endsWith('__FN_REF_28-1____FN_REF_28-2__'),
    'Scenario 5: Must never append duplicate trailing slot markers to paragraph end'
  );

  // Scenario 5b: LLM simplified __FN_REF_28-1__ to __FN_REF_1__ in translated body
  const llmNaturalSlotText = '第一段译文__FN_REF_1__。\n\n第二段译文__FN_REF_2__。';
  const naturalSlotRepair = validateAndRepairSlots(originalChunkText, llmNaturalSlotText);
  assert.equal(
    naturalSlotRepair.repairedText,
    '第一段译文__FN_REF_28-1__。\n\n第二段译文__FN_REF_28-2__。',
    'Scenario 5b: Simplified __FN_REF_1__ must map in-place to __FN_REF_28-1__'
  );
  assert.equal(
    naturalSlotRepair.missingIds.length,
    0,
    'Scenario 5b: missingIds must be empty after in-place natural-number slot repair'
  );

  // 6. Scenario 6: Pure URL / Code footnote adoption & Pool rehydration
  const fn13_1: FootnoteNode = {
    key: 'Text/ch13.xhtml#fn1',
    sourceFile: 'Text/ch13.xhtml',
    originalId: 'fn1',
    namespaceId: '13-1',
    label: '1',
    html: '<p>https://www.irs.gov/pub/irs-pdf/p17.pdf</p>',
    plainText: 'https://www.irs.gov/pub/irs-pdf/p17.pdf',
    paragraphs: ['https://www.irs.gov/pub/irs-pdf/p17.pdf'],
    referencedByChapters: [13]
  };

  assert.equal(isPureUrlOrCode('https://www.irs.gov/pub/irs-pdf/p17.pdf'), true, 'Should detect pure URL');
  assert.equal(isPureUrlOrCode('<https://www.irs.gov/pub/irs-pdf/p17.pdf>'), true, 'Should detect markdown autolink URL');
  assert.equal(isPureUrlOrCode('`SELECT * FROM users`'), true, 'Should detect inline code');
  assert.equal(isPureUrlOrCode('Ordinary English sentence without links'), false, 'Ordinary sentence is not pure URL/code');

  const resp6Url = `
[MAIN_CONTENT]
参见国税局出版物__FN_REF_13-1__。
[/MAIN_CONTENT]

[FN_DEF:13-1]
https://www.irs.gov/pub/irs-pdf/p17.pdf
[/FN_DEF]
`;
  const parsed6 = pool.parseDualChannelResponse(
    resp6Url,
    '参见国税局出版物__FN_REF_13-1__。',
    [fn13_1]
  );
  assert.equal(
    parsed6.translatedFootnotes['13-1'],
    'https://www.irs.gov/pub/irs-pdf/p17.pdf',
    'Scenario 6: Verbatim URL in FN_DEF must be adopted as valid translation'
  );

  // Scenario 6b: Chinese-bracket multiline markdown footnote syntax
  const respMdChinese = `
[MAIN_CONTENT]
中文全角括号段落__FN_REF_28-1__。
[/MAIN_CONTENT]

【^28-1】：全角中文括号定义
这是第二行内容。
`;
  const parsedMdChinese = pool.parseDualChannelResponse(
    respMdChinese,
    '中文全角括号段落__FN_REF_28-1__。',
    [fn28_1]
  );
  assert.equal(
    parsedMdChinese.translatedFootnotes['28-1'],
    '全角中文括号定义\n这是第二行内容。',
    'Scenario 6b: Chinese brackets multiline markdown definition must be extracted'
  );
  assert.ok(
    !parsedMdChinese.translatedBody.includes('【^28-1】：'),
    'Scenario 6b: Chinese brackets definition must be stripped from body'
  );

  // FootnotePool restoreFromChapters test
  const testPool = new FootnotePool();
  const mockChapters: any[] = [
    {
      index: 0,
      translatedFootnotes: {
        '28-1': '已翻译的第28章脚注1',
        '28-2': '已翻译的第28章脚注2'
      },
      internalizedFootnotes: {
        '28-1': fn28_1,
        '28-2': fn28_2
      }
    }
  ];
  testPool.restoreFromChapters(mockChapters);
  const restored1 = testPool.getTranslatedFootnote('28-1');
  assert.ok(restored1, 'Restored pool must find 28-1');
  assert.equal(restored1?.translatedText, '已翻译的第28章脚注1');
  const restoredByCanonical = testPool.getTranslatedFootnote('anything', 'Text/notes.xhtml#fn2');
  assert.ok(restoredByCanonical, 'Restored pool must find canonical key Text/notes.xhtml#fn2');
  assert.equal(restoredByCanonical?.translatedText, '已翻译的第28章脚注2');

  console.log('  [OK] Scenario 1: Full-width colon & Chinese brackets (【FN_DEF：...】) parsed accurately');
  console.log('  [OK] Scenario 2: Standard Markdown footnote syntax ([^1]: / [^28-1]:) parsed & stripped from body');
  console.log('  [OK] Scenario 3: Natural number mapping (Level 2) and in-slice position index fallback (Level 3)');
  console.log('  [OK] Scenario 4: Leaked footnotes salvaged from <translation_draft> and after </translation>');
  console.log('  [OK] Scenario 5: Slot repair maps [^1], [^2] in-place without duplicate trailing markers');
  console.log('  [OK] Scenario 6: Pure URL/code adoption & FootnotePool restoreFromChapters rehydration');
  console.log('✓ Slice 7 (Real-World Dual-Channel Footnote Robustness Suite) passed!');
}

async function main() {
  await runSlice1Tests();
  await runSlice2Tests();
  await runSlice3And4Tests();
  await runSlice5EndToEndTests();
  await runSlice6RealWorldEpub3RegressionTests();
  await runSlice7Tests();
  console.log('\n[PASS] ALL_PIPELINE_VERIFICATIONS_SUCCESSFUL');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

