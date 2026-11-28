import assert from 'node:assert/strict';
import {
  DomMutationEngine,
  computeStructuralTreeDiff,
  parseEpubCssProfiles,
  sanitizeInlineXhtmlForLeaf
} from '../services/domMutationEngine';
import { EpubService, buildAdaptiveChineseTypographyCss } from '../services/epubService';
import { expandXhtmlSelfClosingTags, parseHtmlDocument, parseXmlDocument } from '../utils/domAdapter';

async function runTests() {
  const engine = new DomMutationEngine();

  // Slice 1 (Seam 1): Mid-paragraph pagebreak spans and empty anchors must be stripped from payloadText
  {
    const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <p class="CO" id="ch1"><span aria-label="3" epub:type="pagebreak" id="pg_3" role="doc-pagebreak"/>A bus came which was going to the ferry, but because I <span aria-label="4" epub:type="pagebreak" id="pg_4" role="doc-pagebreak"/>hesitated before getting on, he drove angrily away.<a id="anchor_5"></a></p>
</body>
</html>`;

    const result = engine.extractTranslatablePayload(xhtml);
    assert.equal(result.blocks.length, 1);
    const payload = result.blocks[0].slottedText;
    assert.ok(!payload.includes('doc-pagebreak'), `Expected pagebreak span stripped, got: ${payload}`);
    assert.ok(!payload.includes('<span'), `Expected no raw empty span in payload, got: ${payload}`);
    assert.ok(!payload.includes('<a id="anchor_5"'), `Expected empty anchor stripped, got: ${payload}`);
    assert.ok(
      payload.includes('because I hesitated before getting on'),
      `Expected clean sentence without tag interruption, got: ${payload}`
    );
    console.log('[OK] Slice 1: Mid-paragraph pagebreak/empty anchor stripping');
  }

  // Slice 2 (Seam 2): Orphan [^id] without backing definition must NOT emit empty <aside> or noteref links
  {
    const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <p class="CO" id="ch1">A bus came which was going to the ferry, but because I hesitated before getting on, he drove angrily away.</p>
</body>
</html>`;

    const hallucinatedTranslation = '来了一辆去渡轮的公交车，因为我在上车前[^1]犹豫了[^2]，他生气地开走。';
    const mutatedBilingual = engine.mutateDomInPlace(xhtml, hallucinatedTranslation, {
      internalizedFootnotes: {},
      translatedFootnotes: {},
      bilingualMode: 'source_first'
    });

    assert.ok(!mutatedBilingual.includes('<aside'), `Expected no empty <aside> in bilingual output, got:\n${mutatedBilingual}`);
    assert.ok(!mutatedBilingual.includes('epub:type="noteref"'), `Expected no noteref link for orphan [^1], got:\n${mutatedBilingual}`);
    assert.ok(!mutatedBilingual.includes('[^1]') && !mutatedBilingual.includes('[^2]'), `Expected orphan [^id] stripped, got:\n${mutatedBilingual}`);

    const epubService = new EpubService();
    const renderedFallback = await epubService.renderBilingualChapterEpub3Html(
      hallucinatedTranslation,
      {},
      {},
      'A bus came which was going to the ferry.',
      'source_first'
    );
    assert.ok(!renderedFallback.includes('<aside'), `Expected no empty <aside> in renderBilingualChapterEpub3Html, got:\n${renderedFallback}`);
    assert.ok(!renderedFallback.includes('epub:type="noteref"'), `Expected no noteref in renderBilingualChapterEpub3Html, got:\n${renderedFallback}`);

    console.log('[OK] Slice 2: Orphan [^id] suppressed (no empty <aside> or noteref)');
  }

  // Slice 3 (Seam 3): Chapter-opener body class (margin-top >= 2em, text-indent: 0, normal weight, font-size < 1.15em)
  // must NOT be added to CSS headingSelectors, while genuine short headings still get data-translit-role="h1~h4"
  {
    const sampleCss = `
      p.CO { font-size: 0.892em; font-weight: normal; margin-top: 5em; text-indent: 0em; text-align: justify; }
      p.chap-big { font-size: 1.45em; font-weight: normal; text-indent: 0em; }
    `;
    const generatedCss = buildAdaptiveChineseTypographyCss([sampleCss]);

    // Extract the heading rule block
    const headingRuleMatch = generatedCss.match(/\/\*\s*Semantic Headings & Publisher Pseudo-Headings\s*\*\/\s*([\s\S]*?)\{/);
    assert.ok(headingRuleMatch, 'Expected heading rule block in generated CSS');
    const headingSelectorBlock = headingRuleMatch[1];

    assert.ok(
      !headingSelectorBlock.includes('.CO'),
      `Expected .CO NOT to be in headingSelectors, got:\n${headingSelectorBlock}`
    );
    assert.ok(
      headingSelectorBlock.includes('.chap-big'),
      `Expected .chap-big (font-size >= 1.15em) to remain in headingSelectors`
    );
    assert.ok(
      generatedCss.includes(':not(.CO)'),
      `Expected .CO to remain protected in noIndentClasses (:not(.CO))`
    );

    // Verify DOM node-level stamping still promotes a short centered/large heading while keeping long p.CO as body
    const profiles = parseEpubCssProfiles([sampleCss]);
    const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <p style="font-size: 1.4em; font-weight: bold; text-align: center;">Part One</p>
  <p class="CO">A book about how difficult it is to change, why we don’t want to, and what is going on in our brain. A book can be about more than one thing.</p>
</body>
</html>`;
    const mutated = engine.mutateDomInPlace(chapterHtml, '第一部分\n\n一本关于改变有多难的书。', {
      cssProfiles: profiles,
      bilingualMode: 'none'
    });
    assert.ok(mutated.includes('data-translit-role="h1"') || mutated.includes('data-translit-role="h2"'), 'Expected short heading to get data-translit-role="h1/h2"');
    assert.ok(mutated.includes('<p class="CO" data-translit-role="body">'), `Expected long p.CO to get data-translit-role="body", got:\n${mutated}`);

    console.log('[OK] Slice 3: Body class p.CO not misclassified as heading in CSS or DOM');
  }

  // Slice 4: Self-closing non-void XHTML tags (<script .../>, <style .../>) must NOT swallow <body>,
  // while foreign <svg><path .../></svg> remains untouched
  {
    const koboXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" class="vrtl">
<head>
  <meta charset="UTF-8"/>
  <title>言語化するための小説思考</title>
  <script xmlns="http://www.w3.org/1999/xhtml" type="text/javascript" src="../../js/kobo.js"/>
  <style type="text/css"/>
</head>
<body class="main-top">
  <div class="main">
    <p><span class="koboSpan" id="kobo.1.1">将棋の放送対局を見ていると、画面上にＡＩによる形勢判断が表示される。</span></p>
    <p><span class="koboSpan" id="kobo.2.1">「この機能、小説にもあったらなあ」</span></p>
    <p><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0"/></svg></p>
    <p>図版の説明文</p>
  </div>
</body>
</html>`;

    const expanded = expandXhtmlSelfClosingTags(koboXhtml);
    assert.ok(expanded.includes('></script>'), 'Self-closing <script .../> must be expanded');
    assert.ok(expanded.includes('></style>'), 'Self-closing <style .../> must be expanded');
    assert.ok(expanded.includes('<path d="M0 0"/>'), 'Foreign <svg><path .../></svg> must remain self-closing in expandXhtmlSelfClosingTags');

    const extracted = engine.extractTranslatablePayload(koboXhtml);
    assert.equal(
      extracted.blocks.length,
      3,
      `Expected 3 body blocks despite <script .../> in <head>, got ${extracted.blocks.length}`
    );
    assert.ok(extracted.payloadText.includes('将棋の放送対局'));
    assert.ok(extracted.payloadText.includes('図版の説明文'));

    const mutated = engine.mutateDomInPlace(
      koboXhtml,
      '看将棋电视转播时，屏幕上会显示 AI 的形势判断。\n\n“要是小说也能有这个功能就好了”\n\n插图说明文字',
      { bilingualMode: 'none' }
    );
    assert.ok(mutated.includes('<svg') && mutated.includes('d="M0 0"'), 'Standalone <svg> block must remain intact');
    assert.ok(mutated.includes('看将棋电视转播时'), 'Body text must be mutated in-place');

    console.log('[OK] Slice 4: Self-closing <script .../> & <style .../> expanded without swallowing <body>');
  }

  // Slice 5: EPUB3 <hgroup> + <span role="doc-pagebreak"/> + display:block heading spans (Why We Click pattern)
  {
    const whyCss = `
      span.CN { font-size: 1.083em; display: block; text-align: center; }
      span.CT { font-size: 1.667em; display: block; text-align: center; }
      span.CST { font-size: 0.979em; display: block; text-align: center; }
      .eSANS_Gotham_Black_B_11 { font-weight: bold; }
      p.CO { font-size: 0.979em; text-indent: 0em; }
    `;
    const profiles = parseEpubCssProfiles([whyCss]);
    assert.equal(profiles.get('CN')?.inlineDisplayBlock, true, 'span.CN must have inlineDisplayBlock=true');
    assert.equal(profiles.get('CT')?.inlineDisplayBlock, true, 'span.CT must have inlineDisplayBlock=true');
    assert.equal(profiles.get('CST')?.inlineDisplayBlock, true, 'span.CST must have inlineDisplayBlock=true');
    assert.notEqual(profiles.get('CO')?.inlineDisplayBlock, true, 'p.CO must not set inlineDisplayBlock');

    const whyCh2Xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body epub:type="bodymatter">
  <section aria-labelledby="ch2" epub:type="chapter" role="doc-chapter">
    <span aria-label="16" epub:type="pagebreak" id="pg_16" role="doc-pagebreak"/>
    <hgroup>
      <h1 class="CHAPTER" id="ch2">
        <span class="CN"><a href="contents.xhtml#c_ch2"><span class="eSANS_Gotham_Black_B_11">2</span></a></span>
        <span class="CT"><a href="contents.xhtml#c_ch2"><span class="eSANS_Gotham_Book_11">Love at First Sync</span></a></span>
        <span class="CST" role="doc-subtitle"><a href="contents.xhtml#c_ch2">THE HIDDEN DYNAMICS OF ATTRACTION</a></span>
      </h1>
    </hgroup>
    <p class="CO">If there were a Hollywood Walk of Fame for matchmaking, Yaacov Deyo would certainly have a star.</p>
  </section>
</body>
</html>`;

    const extracted = engine.extractTranslatablePayload(whyCh2Xhtml, {}, profiles);
    assert.equal(extracted.blocks.length, 2, `Expected 2 blocks (h1 + p.CO), got ${extracted.blocks.length}`);
    assert.equal(extracted.blocks[0].tagName, 'h1');
    assert.equal(extracted.blocks[0].isHeadingLike, true);
    assert.equal(
      extracted.blocks[0].slottedText,
      '# <b>2</b><br/>Love at First Sync<br/>THE HIDDEN DYNAMICS OF ATTRACTION'
    );
    assert.ok(
      !extracted.payloadText.includes('<hgroup') && !extracted.payloadText.includes('<h1'),
      `Payload must not leak <hgroup> or <h1>, got:\n${extracted.payloadText}`
    );

    const zhTranslation = [
      '<b>2</b><br/>一拍即合的爱<br/>吸引力的隐秘动力学',
      '如果好莱坞星光大道专为媒人设一颗星，雅各夫·德约必定名列其中。'
    ].join('\n\n');

    const mutatedMono = engine.mutateDomInPlace(whyCh2Xhtml, zhTranslation, {
      cssProfiles: profiles,
      bilingualMode: 'none'
    });
    assert.ok(!mutatedMono.includes('&lt;hgroup') && !mutatedMono.includes('&lt;h1'), 'Monolingual output must not escape <hgroup>/<h1>');
    assert.equal(
      parseXmlDocument(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${mutatedMono}</body></html>`).getElementsByTagName('parsererror').length,
      0,
      'Monolingual output must be valid XML'
    );
    assert.equal(computeStructuralTreeDiff(whyCh2Xhtml, mutatedMono).diffCount, 0, 'Monolingual Tree-Diff must be 0');
    const monoDoc = parseHtmlDocument(mutatedMono);
    assert.equal(monoDoc.querySelector('hgroup > h1.CHAPTER#ch2')?.getAttribute('data-translit-role'), 'h1');
    assert.ok(monoDoc.querySelector('h1.CHAPTER')?.innerHTML.includes('一拍即合的爱'));

    const mutatedBi = engine.mutateDomInPlace(whyCh2Xhtml, zhTranslation, {
      cssProfiles: profiles,
      bilingualMode: 'source_first'
    });
    assert.ok(!mutatedBi.includes('&lt;hgroup') && !mutatedBi.includes('&lt;h1'), 'Bilingual output must not escape <hgroup>/<h1>');
    const biDoc = parseHtmlDocument(mutatedBi);
    assert.equal(biDoc.querySelectorAll('h1.CHAPTER').length, 2, 'Bilingual mode must clone h1.CHAPTER cleanly inside hgroup');

    console.log('[OK] Slice 5: <hgroup> + display:block heading spans (Why We Click pattern)');
  }

  // Slice 6: Life in Perspective <aside><hgroup> & inline display:block span.heading_breakf
  {
    const lipCss = `
      span.heading_breakf { display: block; }
    `;
    const profiles = parseEpubCssProfiles([lipCss]);
    const lipXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <section>
    <h1 class="h1fm" id="prologue_hd">PROLOGUE <span class="heading_breakf">THE DAY I REWROTE MY FUTURE</span></h1>
    <aside class="box">
      <hgroup>
        <h2 class="boxh"><span class="bline">Your Preparation Checklist:</span></h2>
        <p class="boxsubh" role="doc-subtitle"><span aria-label="76" id="page_76" role="doc-pagebreak"/>What Needs to Be in Place</p>
      </hgroup>
      <p class="boxno">The following checklist summarizes what we covered.</p>
    </aside>
  </section>
</body>
</html>`;

    const extracted = engine.extractTranslatablePayload(lipXhtml, {}, profiles);
    assert.equal(extracted.blocks.length, 4, `Expected 4 blocks (h1, h2, p.boxsubh, p.boxno), got ${extracted.blocks.length}`);
    assert.equal(extracted.blocks[0].slottedText, '# PROLOGUE<br/>THE DAY I REWROTE MY FUTURE');
    assert.equal(extracted.blocks[1].slottedText, '## Your Preparation Checklist:');
    assert.equal(extracted.blocks[2].slottedText, 'What Needs to Be in Place');
    assert.equal(extracted.blocks[3].slottedText, 'The following checklist summarizes what we covered.');

    const mutated = engine.mutateDomInPlace(
      lipXhtml,
      '序幕<br/>我改写未来的那一天\n\n你的准备清单：\n\n开始前需要就绪的事项\n\n以下清单总结了我们讨论的内容。',
      { cssProfiles: profiles }
    );
    assert.equal(computeStructuralTreeDiff(lipXhtml, mutated).diffCount, 0, 'Aside + hgroup Tree-Diff must be 0');
    console.log('[OK] Slice 6: <aside><hgroup> & display:block heading_breakf');
  }

  // Slice 7: Unknown wrapper element containing blocks & symmetric inline tag purification
  {
    const wrapperAndInlineXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <section>
    <custom-epub-wrapper>
      <h2>Section Title</h2>
      <p>Visit us<wbr/><pagebreak id="pb_1"/> for <cite>Hamlet</cite>, <del>old</del><ins>new</ins>, <kbd>Ctrl+C</kbd>, and <time datetime="2026-01-01">today</time>.</p>
    </custom-epub-wrapper>
  </section>
</body>
</html>`;
    const extracted = engine.extractTranslatablePayload(wrapperAndInlineXhtml);
    assert.equal(extracted.blocks.length, 2, 'Unknown wrapper containing blocks must descend cleanly to <h2> and <p>');
    assert.equal(extracted.blocks[0].slottedText, '## Section Title');
    assert.equal(
      extracted.blocks[1].slottedText,
      'Visit us for <i>Hamlet</i>, oldnew, <code>Ctrl+C</code>, and today.'
    );
    const mutated = engine.mutateDomInPlace(
      wrapperAndInlineXhtml,
      '章节标题\n\n请访问我们以查看<i>《哈姆雷特》</i>、新旧版本、<code>Ctrl+C</code> 以及今日内容。'
    );
    assert.equal(computeStructuralTreeDiff(wrapperAndInlineXhtml, mutated).diffCount, 0);
    assert.ok(!mutated.includes('&lt;wbr') && !mutated.includes('&lt;pagebreak') && !mutated.includes('&lt;cite'));

    // Output defense-in-depth in sanitizeInlineXhtmlForLeaf: strips leaked HTML shells while preserving literal math/internal brackets
    assert.equal(
      sanitizeInlineXhtmlForLeaf('<hgroup><h1 class="CHAPTER" id="ch2">2 Love at First Sync</h1></hgroup><wbr/>'),
      '2 Love at First Sync'
    );
    assert.equal(
      sanitizeInlineXhtmlForLeaf('First line<br class="calibre19"/>Second line'),
      'First line<br/>Second line'
    );
    assert.equal(
      sanitizeInlineXhtmlForLeaf('x < y & <internal>'),
      'x &lt; y &amp; &lt;internal&gt;'
    );

    // refreshChapterPayloadIfNeeded auto-heals legacy cached chapters containing <hgroup> / <h1>
    const epubService = new EpubService();
    const staleChapter = {
      id: 'ch2',
      index: 2,
      fileName: 'xhtml/chapter2.xhtml',
      title: '2. Love at First Sync',
      content: `<html xmlns="http://www.w3.org/1999/xhtml"><body><section><hgroup><h1 class="CHAPTER" id="ch2">2 Love at First Sync</h1></hgroup><p>Body text.</p></section></body></html>`,
      markdown: '<hgroup> <h1 class="CHAPTER" id="ch2"> 2 Love at First Sync </h1> </hgroup>\n\nBody text.',
      slottedMarkdown: '<hgroup> <h1 class="CHAPTER" id="ch2"> 2 Love at First Sync </h1> </hgroup>\n\nBody text.'
    };
    assert.equal(epubService.refreshChapterPayloadIfNeeded(staleChapter), true);
    assert.equal(staleChapter.markdown, '# 2 Love at First Sync\n\nBody text.');
    console.log('[OK] Slice 7: Unknown block wrapper, inline purification, sanitizer defense, and cache refresh');
  }

  // Slice 8: Strict XML serialization safety for &nbsp; / \u00a0 and HTML5 void tags (<col/>, <wbr/>)
  {
    const nbspAndVoidXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <p>Alpha\u00a0Beta and Gamma.</p>
  <table class="data"><colgroup><col class="c1"/></colgroup><tbody><tr><td class="bor1">\u00a0</td></tr></tbody></table>
</body>
</html>`;

    const extracted = engine.extractTranslatablePayload(nbspAndVoidXhtml);
    assert.ok(extracted.blocks.length >= 1, 'Expected paragraph block extracted');
    const mutated = engine.mutateDomInPlace(nbspAndVoidXhtml, '阿尔法\u00a0贝塔与伽马。', {
      bilingualMode: 'none'
    });
    assert.ok(!/&nbsp;/i.test(mutated), `Output must not contain &nbsp; undefined XML entity:\n${mutated}`);
    assert.ok(mutated.includes('&#160;'), `Output should use numeric &#160; for non-breaking spaces:\n${mutated}`);
    assert.ok(/<col class="c1"\/>/.test(mutated), `Output must keep <col/> self-closed for XHTML:\n${mutated}`);

    const xmlDoc = parseXmlDocument(
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${mutated}</body></html>`
    );
    assert.equal(
      xmlDoc.getElementsByTagName('parsererror').length,
      0,
      `Strict XML parse failed on &nbsp;/<col/> output:\n${mutated}`
    );
    console.log('[OK] Slice 8: Strict XML safety for &nbsp; (&#160;) and void tags (<col/>)');
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
