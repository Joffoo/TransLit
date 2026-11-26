import assert from 'node:assert/strict';
import { DomMutationEngine, parseEpubCssProfiles } from '../services/domMutationEngine';
import { EpubService, buildAdaptiveChineseTypographyCss } from '../services/epubService';
import { expandXhtmlSelfClosingTags } from '../utils/domAdapter';

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
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
