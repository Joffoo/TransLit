import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  DomMutationEngine,
  parseEpubCssProfiles,
  getHeadingMarkdownLevel,
  applyHetiTextTypography,
  restoreHeadingPrefixesFromSource,
  computeStructuralTreeDiff
} from '../services/domMutationEngine';
import {
  EpubService,
  buildAdaptiveChineseTypographyCss,
  splitMarkdownIntoBlocks,
  alignMarkdownBlocks
} from '../services/epubService';
import { parseHtmlDocument } from '../utils/domAdapter';

async function runTests() {
  console.log('--- Running Heti & Pseudo-Heading Typesetting Verification ---');

  const engine = new DomMutationEngine();
  const epubService = new EpubService();

  // =========================================================================
  // Scene A: The Pale King (.calibre8/.calibre9/.bold) + 8-level nested blockquote + anti-italic contamination
  // =========================================================================
  console.log('  [Scene A] Testing Calibre visual pseudo-headings, italic non-contamination & 8-level blockquote collapse...');
  const paleKingCss = `
    .calibre5 { text-decoration: underline; color: #0000ee; }
    .calibre8 { display: block; margin-top: 3em; text-indent: 0; }
    .calibre9 { font-size: 1.29167em; }
    .bold { font-weight: bold; }
    .calibre12 { display: block; margin: 0 40pt; }
    .calibre16 { display: block; margin: 1em 40pt; }
    .calibre17 { display: block; text-align: center; text-indent: 0; }
  `;

  const profilesA = parseEpubCssProfiles([paleKingCss]);
  assert.ok(profilesA.has('calibre8'), 'Expected .calibre8 profile');
  assert.equal(profilesA.get('calibre8')?.marginTopEm, 3, 'Expected .calibre8 margin-top 3em');
  assert.equal(profilesA.get('calibre8')?.textIndentEm, 0, 'Expected .calibre8 text-indent 0');
  assert.equal(profilesA.get('calibre9')?.fontSizeEm, 1.29167, 'Expected .calibre9 font-size 1.29167em');
  assert.equal(profilesA.get('bold')?.fontWeight, 'bold', 'Expected .bold weight bold');

  const paleKingXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <p class="calibre8"><a class="calibre5" href="toc.html"><span class="calibre9"><span class="bold">§2</span></span></a></p>
  <blockquote class="calibre16">
    <blockquote class="calibre12">
      <blockquote class="calibre16">
        <blockquote class="calibre12">
          <blockquote class="calibre16">
            <blockquote class="calibre12">
              <blockquote class="calibre16">
                <blockquote class="calibre12">
                  <p class="calibre17">Deeply nested quote text.</p>
                </blockquote>
              </blockquote>
            </blockquote>
          </blockquote>
        </blockquote>
      </blockquote>
    </blockquote>
  </blockquote>
</body>
</html>`;

  const docA = parseHtmlDocument(paleKingXhtml);
  const headingEl = docA.querySelector('p.calibre8')!;
  const levelA = getHeadingMarkdownLevel(headingEl, profilesA);
  assert.equal(levelA, 2, `Expected p.calibre8 with .calibre9 + .bold to be detected as heading level 2, got ${levelA}`);

  const extractedA = engine.extractTranslatablePayload(paleKingXhtml, {}, profilesA);
  assert.equal(extractedA.blocks.length, 2, 'Expected 2 translatable leaf blocks');
  assert.ok(
    extractedA.blocks[0].slottedText.startsWith('## '),
    `Expected extracted heading to have "## " prefix, got "${extractedA.blocks[0].slottedText}"`
  );

  // Check adaptive CSS does NOT contaminate .calibre5 / .calibre8 with KaiTi italic rule
  const adaptiveCssA = buildAdaptiveChineseTypographyCss([paleKingCss]);
  const italicRuleMatch = adaptiveCssA.match(/\/\*\s*Chinese Typography Standard:[^*]*\*\/\s*([^{]+)\{/);
  assert.ok(italicRuleMatch, 'Expected italic rule in adaptive CSS');
  assert.ok(
    !italicRuleMatch[1].includes('.calibre8') && !italicRuleMatch[1].includes('.calibre5'),
    `Adaptive CSS must NOT apply KaiTi italic rule to .calibre5 or .calibre8 in The Pale King! Got: ${italicRuleMatch[1]}`
  );
  // Check .calibre8 IS protected from body 2em text-indent & receives text-indent: 0 !important
  assert.ok(
    adaptiveCssA.includes(':not(.calibre8)'),
    'Expected .calibre8 to be excluded from 2em paragraph indent rule'
  );
  assert.ok(
    adaptiveCssA.includes('.calibre8') && /text-indent:\s*0\s*!important/.test(adaptiveCssA),
    'Expected .calibre8 to have text-indent: 0 !important protection'
  );

  // Mutate in place & check 8-level blockquote collapsed to 1 blockquote + structuralTreeDiff === 0
  const mutatedA = engine.mutateDomInPlace(paleKingXhtml, '第二节\n\n深层嵌套的引文内容。', {
    cssProfiles: profilesA
  });
  const mutatedDocA = parseHtmlDocument(mutatedA);
  const bqCount = mutatedDocA.querySelectorAll('blockquote').length;
  assert.equal(bqCount, 1, `Expected 8 nested blockquotes to collapse into 1, got ${bqCount}`);
  assert.ok(mutatedA.includes('第二节'), 'Expected translated heading text in mutated DOM');
  assert.ok(mutatedA.includes('深层嵌套的引文内容。'), 'Expected translated blockquote paragraph in mutated DOM');

  const diffA = computeStructuralTreeDiff(paleKingXhtml, mutatedA);
  assert.equal(diffA.diffCount, 0, `Expected structuralTreeDiff === 0, got diffs: ${diffA.diffs.join('; ')}`);
  console.log('  [OK] Scene A passed');

  // =========================================================================
  // Scene B: The Mezzanine & Hikikomori centering, right-alignment & hanging indent protection
  // =========================================================================
  console.log('  [Scene B] Testing center/right align & negative hanging-indent preservation...');
  const mixedPublisherCss = `
    .h1 { font-size: xx-large; text-indent: 0; }
    .h2 { font-size: x-large; text-indent: 0; }
    .halftitle { font-size: 1.4em; text-align: center; }
    .bib1 { text-indent: -1.5em; margin-left: 1.5em; }
    .bulletlist { text-indent: -0.4em; margin-left: 1.2em; }
    .numberlisth { text-indent: -1.3em; margin-left: 1.3em; }
    .textright { text-align: right; }
    .textcenter { text-align: center; }
    .calibre5 { font-style: italic; }
  `;

  const adaptiveCssB = buildAdaptiveChineseTypographyCss([mixedPublisherCss]);
  // Verify negative hanging indents, centered/right classes, and pseudo-headings are excluded from p:not(...) 2em rule
  for (const cls of ['h1', 'h2', 'halftitle', 'bib1', 'bulletlist', 'numberlisth', 'textright', 'textcenter']) {
    assert.ok(
      adaptiveCssB.includes(`:not(.${cls})`),
      `Expected :not(.${cls}) in 2em indent rule`
    );
  }
  // Verify hanging indent classes (.bib1, .bulletlist, .numberlisth) are NOT forced to text-indent: 0 !important
  const headingSection = adaptiveCssB.split('/* Preserve non-indented')[0] + adaptiveCssB.split('/* Chinese Typography Standard')[0];
  const zeroIndentBlocks = adaptiveCssB.match(/[^}]+text-indent:\s*0\s*!important[^}]*\}/g) || [];
  const allZeroIndentSelectors = zeroIndentBlocks.join('\n');
  for (const hangCls of ['.bib1', '.bulletlist', '.numberlisth']) {
    assert.ok(
      !allZeroIndentSelectors.includes(hangCls),
      `Hanging indent class ${hangCls} must NOT be forced to text-indent: 0 !important`
    );
  }
  // Verify .calibre5 (which actually has font-style: italic in this book) IS picked up dynamically for KaiTi
  const italicRuleB = adaptiveCssB.match(/\/\*\s*Chinese Typography Standard:[^*]*\*\/\s*([^{]+)\{/);
  assert.ok(italicRuleB && italicRuleB[1].includes('.calibre5'), 'Expected .calibre5 italic class to be detected dynamically when CSS declares font-style: italic');
  // Verify inline style pseudo-heading detection even without class
  const inlinePseudoHtml = `<p style="font-size: 1.45em; font-weight: bold; text-align: center;">Chapter One</p>`;
  const inlineEl = parseHtmlDocument(inlinePseudoHtml).querySelector('p')!;
  assert.equal(getHeadingMarkdownLevel(inlineEl), 1, 'Expected inline large bold centered <p> to be detected as H1');

  // Extreme edge cases for Multi-Dimensional Weighted Feature Scoring Engine
  const smallCapsHeadingEl = parseHtmlDocument(
    `<p style="font-variant: small-caps; text-align: center; text-indent: 0;">The Early Years</p>`
  ).querySelector('p')!;
  assert.ok(
    getHeadingMarkdownLevel(smallCapsHeadingEl) > 0,
    'Expected centered small-caps 1.0em subheading to be detected as heading'
  );

  const letterSpacedBoldEl = parseHtmlDocument(
    `<p style="font-weight: bold; text-indent: 0; letter-spacing: 0.08em;">Background</p>`
  ).querySelector('p')!;
  assert.ok(
    getHeadingMarkdownLevel(letterSpacedBoldEl) > 0,
    'Expected letter-spaced bold 1.0em subheading to be detected as heading'
  );

  const quotedDialogueEl = parseHtmlDocument(
    `<p style="font-weight: bold; text-indent: 0;">“Watch out!”</p>`
  ).querySelector('p')!;
  assert.equal(
    getHeadingMarkdownLevel(quotedDialogueEl),
    0,
    'Short bold dialogue in quotes must NOT be misclassified as heading'
  );

  const rightAlignedSigEl = parseHtmlDocument(
    `<p style="font-weight: bold; text-align: right; text-indent: 0;">— Tamaki Saitō</p>`
  ).querySelector('p')!;
  assert.equal(
    getHeadingMarkdownLevel(rightAlignedSigEl),
    0,
    'Right-aligned signature starting with dash must NOT be misclassified as heading'
  );

  void headingSection;
  console.log('  [OK] Scene B passed');

  // =========================================================================
  // Scene C: Heading prefix restoration when LLM omits `#` + Bilingual DP alignment
  // =========================================================================
  console.log('  [Scene C] Testing missing-# heading restoration & bilingual DP alignment...');
  const srcMdC = `# Chapter 1\n\nBody paragraph.`;
  const tgtMdC = `第一章\n\n正文段落。`;
  const restoredC = restoreHeadingPrefixesFromSource(srcMdC, tgtMdC);
  assert.equal(restoredC, `# 第一章\n\n正文段落。`, `Expected restored heading prefix, got "${restoredC}"`);

  // Also test alignMarkdownBlocks directly WITHOUT pre-restoring `#` (simulating raw un-prefixed LLM output)
  const sBlocksC = splitMarkdownIntoBlocks(srcMdC);
  const tBlocksRawC = splitMarkdownIntoBlocks(tgtMdC); // target block 0 is 'paragraph' because no `#`
  const alignedC = alignMarkdownBlocks(sBlocksC, tBlocksRawC);
  assert.equal(alignedC.length, 2, `Expected 2 aligned pairs (heading + paragraph), got ${alignedC.length}`);
  assert.equal(alignedC[0].type, 'heading', 'Expected pair 0 type to be heading');
  assert.equal(alignedC[0].sourceContent, '# Chapter 1');
  assert.equal(alignedC[0].targetContent, '# 第一章', 'Expected alignMarkdownBlocks to restore `# ` onto unprefixed heading');

  // Render full bilingual EPUB3 HTML and verify <h1> appears for BOTH source and target
  const bilingualHtmlC = await epubService.renderBilingualChapterEpub3Html(tgtMdC, {}, {}, srcMdC, 'source_first');
  assert.ok(bilingualHtmlC.includes('<h1>Chapter 1</h1>'), `Expected <h1>Chapter 1</h1> in bilingual HTML, got:\n${bilingualHtmlC}`);
  assert.ok(bilingualHtmlC.includes('<h1>第一章</h1>'), `Expected <h1>第一章</h1> in bilingual HTML, got:\n${bilingualHtmlC}`);

  // Also test DomMutationEngine DP alignment when LLM splits an earlier paragraph (M = N + 1) before an unprefixed heading
  const engineC = new DomMutationEngine();
  const dpSources = [
    'In most cases of social withdrawal, it may seem that hikikomori patients are avoiding the rest of the world, when in fact they harbor a strong desire to interact with others. In most cases of schizophrenia, however, the patient is trying to completely avoid all contact.',
    '## Student Apathy and Retreat Neurosis',
    '“Student apathy” is one of the most important factors in nonattendance at school, which is one of the most obvious problematic behaviors associated with withdrawal.'
  ];
  const dpTargetsWithSplit = [
    '绝大多数社会退缩案例中，蛰居者表面上看起来像是在回避外部世界，但内心深处其实对与人交往抱有强烈的渴望。',
    '然而在多数精神分裂症病例中，患者往往是极力想要彻底断绝与外界的接触。',
    '学生无动力症与退却神经症',
    '前面提到，拒学是与退缩相关的诸多问题行为中最显而易见的一种，“学生无动力症”正是导致拒学的关键诱因之一。'
  ];
  const dpAligned = engineC.alignTargetParagraphsToDomBlocks(
    dpSources,
    dpTargetsWithSplit,
    [false, true, false]
  );
  assert.equal(
    dpAligned[1],
    '学生无动力症与退却神经症',
    `Heading slot must stay anchored to heading translation despite earlier 1-to-2 split, got "${dpAligned[1]}"`
  );
  assert.ok(
    dpAligned[2].startsWith('前面提到'),
    `First paragraph after heading must stay aligned to body slot, got "${dpAligned[2]}"`
  );
  console.log('  [OK] Scene C passed');

  // =========================================================================
  // Scene D: Heti text micro-typography normalization (including Arabic numerals & idempotency)
  // =========================================================================
  console.log('  [Scene D] Testing Heti text CJK-Latin/Digit Pangu spacing, idempotency & punctuation normalization...');
  const rawHetiInput = '<p>在1996年11月使用AI技术--真的很好...对吧 ， 朋友 ！<a href="#fn-1" data-fn-id="1"><sup>[1]</sup></a></p>';
  const expectedHetiOutput = '<p>在 1996 年 11 月使用 AI 技术——真的很好……对吧，朋友！<a href="#fn-1" data-fn-id="1"><sup>[1]</sup></a></p>';
  const actualHetiOutput = applyHetiTextTypography(rawHetiInput);
  assert.equal(actualHetiOutput, expectedHetiOutput, `Heti text output mismatch:\nExpected: ${expectedHetiOutput}\nActual:   ${actualHetiOutput}`);

  // Explicit idempotency check (calling twice must NOT produce double spaces)
  assert.equal(
    applyHetiTextTypography(expectedHetiOutput),
    expectedHetiOutput,
    'applyHetiTextTypography must be 100% idempotent when spaces already exist'
  );

  // Percentage / temperature symbols and preview footnote tokens [注1]
  assert.equal(
    applyHetiTextTypography('提升了50%以上，温度达37℃左右 [注1](#fn-1)'),
    '提升了 50% 以上，温度达 37℃ 左右 [注1](#fn-1)',
    'Expected Pangu spacing with %/℃ and preserved [注1] token'
  );

  // Also verify footnote slots are never altered
  const slotInput = '这是__FN_REF_1-1__测试AI文本。';
  assert.equal(applyHetiTextTypography(slotInput), '这是__FN_REF_1-1__测试 AI 文本。');
  console.log('  [OK] Scene D passed');

  // =========================================================================
  // Scene E: Heti CSS properties & full end-to-end parseEpub -> generateEpub check
  // =========================================================================
  console.log('  [Scene E] Testing Heti CSS properties & end-to-end EPUB parse/export...');
  const defaultEnhancementCss = buildAdaptiveChineseTypographyCss();
  for (const requiredToken of [
    'line-break: strict',
    'overflow-wrap: break-word',
    'hanging-punctuation: allow-end',
    'text-spacing-trim: space-first',
    'text-autospace: normal',
    'blockquote blockquote',
    'font-size: 0.95em !important;',
    'font-size: 0.96em !important;',
    'text-underline-offset: 0.25em'
  ]) {
    assert.ok(
      defaultEnhancementCss.includes(requiredToken),
      `Expected default Heti enhancement CSS to include "${requiredToken}"`
    );
  }
  assert.ok(
    !defaultEnhancementCss.includes('word-break: break-all'),
    'Enhancement CSS must NOT contain word-break: break-all'
  );

  // Full ZIP end-to-end test using The Pale King pattern
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Pale King Sample</dc:title><dc:language>en</dc:language></metadata>
  <manifest>
    <item id="css" href="stylesheet.css" media-type="text/css"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`
  );
  zip.file('OEBPS/stylesheet.css', paleKingCss);
  zip.file('OEBPS/ch1.xhtml', paleKingXhtml);

  const origBuf = await zip.generateAsync({ type: 'uint8array' });
  const parsed = await epubService.parseEpub(origBuf);
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0].title, '§2', `Expected chapter title "§2" detected from CSS pseudo-heading, got "${parsed.chapters[0].title}"`);
  assert.ok(parsed.chapters[0].markdown.startsWith('## '), `Expected parsed markdown to start with "## ", got "${parsed.chapters[0].markdown}"`);

  // Simulate LLM translation WITHOUT `#`
  parsed.chapters[0].translatedMarkdown = '第二节\n\n深层嵌套的AI引文--真的很好。';

  const exportZipLoader = new JSZip();
  const workingZip = await exportZipLoader.loadAsync(origBuf);
  const outBlob = await epubService.generateEpub(
    parsed.chapters,
    workingZip,
    parsed.opfPath,
    parsed.opfDir,
    parsed.cssFiles,
    'The Pale King',
    'Chinese'
  );

  const outZip = await new JSZip().loadAsync(await outBlob.arrayBuffer());
  const outCss = await outZip.file('OEBPS/stylesheet.css')!.async('string');
  const outXhtml = await outZip.file('OEBPS/ch1.xhtml')!.async('string');

  assert.ok(outCss.includes('line-break: strict'), 'Exported CSS missing Heti line-break: strict');
  assert.ok(!outCss.includes('word-break: break-all'), 'Exported CSS must not contain word-break: break-all');
  assert.ok(outCss.includes('blockquote blockquote'), 'Exported CSS missing nested blockquote reset');
  assert.ok(outCss.includes('em, i, cite {'), `Expected clean italic selector without .calibre8 contamination in exported CSS`);
  assert.ok(outXhtml.includes('AI 引文——真的很好。'), `Expected Heti micro-typography applied in exported XHTML, got:\n${outXhtml}`);

  const outDoc = parseHtmlDocument(outXhtml);
  assert.equal(outDoc.querySelectorAll('blockquote').length, 1, 'Exported XHTML should collapse 8 nested blockquotes into 1');
  console.log('  [OK] Scene E passed');

  // =========================================================================
  // Scene F: Offline Consecutive Short-Line Veto, Bold Non-Headings & Exemptions
  // =========================================================================
  console.log('  [Scene F] Testing offline consecutive short-line veto, bold non-headings & exemptions...');
  const sceneFCss = `
    .centert { font-size: 0.9em; font-weight: bold; text-align: center; font-variant: small-caps; text-indent: 0; margin-top: 1em; }
    .center { font-size: 0.9em; font-weight: bold; text-align: center; font-variant: small-caps; text-indent: 0; }
    .centerb { font-size: 0.9em; font-weight: bold; text-align: center; font-variant: small-caps; text-indent: 0; margin-bottom: 1em; }
    .bold-lead { font-weight: bold; text-indent: 0; }
    .takeaway { font-weight: bold; text-align: center; text-indent: 0; }
    .bold { font-weight: bold; }
    .stickupcap { font-size: 1.5em; font-weight: bold; }
    .box { border-left: 2px solid #888; padding-left: 1em; font-weight: bold; text-indent: 0; }
  `;
  const profilesF = parseEpubCssProfiles([sceneFCss]);
  const offlineCssF = buildAdaptiveChineseTypographyCss([sceneFCss]);

  // Verify .bold-lead is in bold selector and NOT in heading selector; .stickupcap is neutralized
  const headingMatchF = offlineCssF.match(/\/\*\s*Semantic Headings & Publisher Pseudo-Headings\s*\*\/\s*([\s\S]*?)\{/);
  assert.ok(headingMatchF && !headingMatchF[1].includes('.bold-lead'), 'Bold non-indented prose .bold-lead must NOT become a CSS heading');
  assert.ok(
    /strong,\s*b[^}]*\.bold-lead/.test(offlineCssF),
    'Bold non-indented prose .bold-lead must be preserved in bold CSS rule'
  );
  assert.ok(
    offlineCssF.includes('.stickupcap') && /font-weight:\s*inherit\s*!important/.test(offlineCssF),
    'Offline CSS must neutralize .stickupcap dropcap weight'
  );

  // Offline 3-line plaque without bookStyleRoles -> vetoed from headings & stamped quote-line
  const plaqueOfflineXhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
    <p><span class="stickupcap">I</span>t began in front of a plaque:</p>
    <p class="centert">IN THIS BUILDING DURING THE SUMMER OF 1956</p>
    <p class="center">the Dartmouth Summer Research Project on Artificial Intelligence</p>
    <p class="centerb">Founding of Artificial Intelligence as a Research Discipline</p>
    <p class="bold-lead">Remember how this technology evolved.</p>
    <p class="takeaway">Read this book to understand how AI tries to imitate the way we do things.</p>
    <div class="box"><p class="bold-lead">Boxed note</p></div>
    <blockquote><p style="font-weight: bold; text-transform: uppercase;">QUOTED TITLE LINE</p></blockquote>
    <p>Inline <span class="bold">bold phrase</span> inside body.</p>
  </body></html>`;

  const extractedF = engine.extractTranslatablePayload(plaqueOfflineXhtml, {}, profilesF);
  for (const blk of extractedF.blocks) {
    assert.ok(!blk.slottedText.startsWith('#'), `Block "${blk.slottedText}" must NOT be extracted as heading`);
  }

  const mutatedF = engine.mutateDomInPlace(plaqueOfflineXhtml, [
    '一切始于一块牌匾前：',
    '1956 年夏天在此楼举行',
    '达特茅斯夏季人工智能研究项目',
    '人工智能作为一门研究学科的创立',
    '请记住这项技术是如何演变的。',
    '阅读这本书，你就能理解人工智能是如何试图模仿我们做事的方式的。',
    '文本框注释',
    '引文标题行',
    '正文中的<b>粗体短语</b>。'
  ].join('\n\n'), { cssProfiles: profilesF });
  const docF = parseHtmlDocument(mutatedF);
  assert.equal(docF.querySelector('p.centert')?.getAttribute('data-translit-role'), 'quote-line');
  assert.equal(docF.querySelector('p.centert')?.getAttribute('data-translit-quote-pos'), 'first');
  assert.equal(docF.querySelector('p.centert')?.getAttribute('data-translit-align'), 'center');
  assert.equal(docF.querySelector('p.center')?.getAttribute('data-translit-quote-pos'), 'mid');
  assert.equal(docF.querySelector('p.centerb')?.getAttribute('data-translit-quote-pos'), 'last');
  assert.notEqual(docF.querySelector('p.bold-lead')?.getAttribute('data-translit-role'), 'h2');
  assert.notEqual(docF.querySelector('blockquote p')?.getAttribute('data-translit-role'), 'h2');

  // 2-line exemptions preserved: CHAPTER 1 + title AND chapter-opening 1.4em display title
  const exemptXhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
    <p style="font-weight: bold; text-align: center; text-transform: uppercase; letter-spacing: 0.08em; text-indent: 0;">CHAPTER 1</p>
    <p style="font-weight: bold; text-align: center; font-variant: small-caps; text-indent: 0;">The Rise of Machines</p>
    <p style="font-size: 1.4em; font-weight: bold; text-align: center; text-indent: 0;">PART ONE</p>
    <p style="font-size: 1.4em; font-weight: bold; text-align: center; text-indent: 0;">A New Dawn</p>
    <p>Opening narrative paragraph.</p>
  </body></html>`;
  const extractedExempt = engine.extractTranslatablePayload(exemptXhtml);
  assert.ok(extractedExempt.blocks[0].slottedText.startsWith('#'), 'CHAPTER 1 must remain heading');
  assert.ok(extractedExempt.blocks[1].slottedText.startsWith('#'), 'Subtitle immediately after CHAPTER 1 must remain heading');
  assert.ok(extractedExempt.blocks[2].slottedText.startsWith('#'), 'Chapter-opening 1.4em line 1 must remain heading');
  assert.ok(extractedExempt.blocks[3].slottedText.startsWith('#'), 'Chapter-opening 1.4em line 2 must remain heading');
  console.log('  [OK] Scene F passed');

  // =========================================================================
  // Scene G: 4->1 DP Merge Zero English Leak, Structural Isomorphism & Quote-Pos Re-indexing
  // =========================================================================
  console.log('  [Scene G] Testing 4->1 DP merge zero English leak & quote-pos re-indexing...');
  const plaqueBookRoles = {
    centert: { role: 'quote' as const, scope: 'block' as const, align: 'center' as const },
    center: { role: 'quote' as const, scope: 'block' as const, align: 'center' as const },
    centerb: { role: 'quote' as const, scope: 'block' as const, align: 'center' as const },
    centertb: { role: 'callout' as const, scope: 'block' as const, align: 'center' as const, weight: 'bold' as const }
  };
  const mergeXhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
    <p class="indent">I stared at a heavy bronze slab with gold-colored lettering: __FN_REF_8-1__</p>
    <p class="centert">IN THIS BUILDING DURING THE SUMMER OF 1956</p>
    <p class="center">the Dartmouth Summer Research Project on Artificial Intelligence</p>
    <p class="centerb">Founding of Artificial Intelligence as a Research Discipline</p>
    <p class="indent">You might imagine this plaque beneath a maple tree.</p>
    <p class="centertb">AI is creating intelligent machines that can think like humans.</p>
  </body></html>`;

  // Clean up test literal footnote placeholder inside source DOM so it uses normal <a> noteref
  const realMergeXhtml = mergeXhtml.replace(
    '__FN_REF_8-1__',
    '<a epub:type="noteref" href="#fn-8-1" data-fn-id="8-1">[1]</a>'
  );
  const mergedTranslation4to1 = [
    '我盯着一块沉重的青铜牌匾，上面刻着金字：“1956 年夏天在此楼举行达特茅斯夏季人工智能研究项目；人工智能作为一门研究学科的创立。”__FN_REF_8-1__',
    '你也许会想象它立在枫树下。',
    '人工智能是创造能够像人类一样思考的智能机器。'
  ].join('\n\n');

  const mutated4to1 = engine.mutateDomInPlace(realMergeXhtml, mergedTranslation4to1, {
    internalizedFootnotes: {
      '8-1': {
        key: 'Notes.xhtml#fn1',
        sourceFile: 'Notes.xhtml',
        originalId: 'fn1',
        namespaceId: '8-1',
        label: '1',
        html: '<p>Dartmouth proposal, 1955.</p>',
        plainText: 'Dartmouth proposal, 1955.',
        paragraphs: ['Dartmouth proposal, 1955.'],
        referencedByChapters: [8]
      }
    },
    translatedFootnotes: { '8-1': '1955 年达特茅斯提案。' },
    cssProfiles: profilesF,
    bookStyleRoles: plaqueBookRoles
  });

  assert.ok(!mutated4to1.includes('In This Building'), '4->1 merge must NOT leak untranslated English back into DOM');
  assert.ok(!mutated4to1.includes('IN THIS BUILDING'), '4->1 merge must NOT leak original uppercase English back into DOM');
  assert.ok(!mutated4to1.includes('Dartmouth Summer'), '4->1 merge must NOT leak middle plaque English line');
  const doc4to1 = parseHtmlDocument(mutated4to1);
  assert.equal(doc4to1.querySelector('p.centert')?.getAttribute('data-translit-merged'), 'true');
  assert.equal(doc4to1.querySelector('p.center')?.getAttribute('data-translit-merged'), 'true');
  assert.equal(doc4to1.querySelector('p.centerb')?.getAttribute('data-translit-merged'), 'true');
  assert.ok(
    doc4to1.querySelector('p.centertb')?.textContent?.includes('人工智能是创造能够像人类一样思考的智能机器'),
    '.centertb callout must stay aligned onto the definition sentence (never shifted)'
  );
  const diffG = computeStructuralTreeDiff(realMergeXhtml, mutated4to1);
  assert.equal(diffG.diffCount, 0, `4->1 merge with data-translit-merged must maintain structuralTreeDiff === 0, got: ${diffG.diffs.join('; ')}`);

  // Partial plaque merge leaving only 1 visible plaque line -> re-index data-translit-quote-pos to "single"
  const partialMergeTranslation = [
    '我盯着青铜牌匾：__FN_REF_8-1__',
    '1956 年夏天达特茅斯人工智能研究项目创立大会在此举行。',
    '你也许会想象它立在枫树下。',
    '人工智能是创造能够像人类一样思考的智能机器。'
  ].join('\n\n');
  const mutatedPartial = engine.mutateDomInPlace(realMergeXhtml, partialMergeTranslation, {
    internalizedFootnotes: {
      '8-1': {
        key: 'Notes.xhtml#fn1',
        sourceFile: 'Notes.xhtml',
        originalId: 'fn1',
        namespaceId: '8-1',
        label: '1',
        html: '<p>Dartmouth proposal.</p>',
        plainText: 'Dartmouth proposal.',
        paragraphs: ['Dartmouth proposal.'],
        referencedByChapters: [8]
      }
    },
    translatedFootnotes: { '8-1': '达特茅斯提案。' },
    cssProfiles: profilesF,
    bookStyleRoles: plaqueBookRoles
  });
  const docPartial = parseHtmlDocument(mutatedPartial);
  const visibleQuoteLines = Array.from(docPartial.querySelectorAll('[data-translit-role="quote-line"]'))
    .filter((el) => el.getAttribute('data-translit-merged') !== 'true');
  assert.equal(visibleQuoteLines.length, 1, 'Expected 1 remaining visible quote-line after 3->1 merge');
  assert.equal(
    visibleQuoteLines[0].getAttribute('data-translit-quote-pos'),
    'single',
    'Remaining single visible quote-line must be re-indexed to data-translit-quote-pos="single"'
  );
  console.log('  [OK] Scene G passed');

  console.log('ALL HETI & PSEUDO-HEADING TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
