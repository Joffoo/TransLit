import assert from 'node:assert/strict';
import {
  buildBookStyleCensus,
  parseStyleClassificationResponse,
  deriveLocalStyleRoles,
  StyleClassifier
} from '../services/styleClassifier';
import { buildAdaptiveChineseTypographyCss } from '../services/epubService';
import { DomMutationEngine, parseEpubCssProfiles } from '../services/domMutationEngine';
import { BookStyleRoleMap } from '../types';
import { parseHtmlDocument } from '../utils/domAdapter';

const FORBIDDEN_HARDCODED_HEX = [
  '#2e5b60',
  '#412938',
  '#a2906a',
  '#2c2c2c',
  '#4a4a4a',
  '#555555',
  '#1a1a1a',
  '#f5f5f3',
  '#f6f6f4',
  '#d4d4d4'
];

function runTests() {
  console.log('--- Running StyleClassifier & Pure Heti Monochrome Verification ---');

  // 1. Realistic fixture modeled on "I Am Not a Robot" CSS & HTML patterns
  const bookCss = `
    .indent { text-indent: 1.5em; margin: 0; }
    .cnab1 { font-size: 1.4em; font-weight: bold; text-align: center; margin-top: 2em; text-indent: 0; }
    .centert { font-size: 0.9em; font-weight: bold; text-align: center; font-variant: small-caps; text-indent: 0; margin-top: 1.2em; margin-bottom: 0; }
    .center { font-size: 0.9em; font-weight: bold; text-align: center; font-variant: small-caps; text-indent: 0; margin-top: 0; margin-bottom: 0; }
    .centerb { font-size: 0.9em; font-weight: bold; text-align: center; font-variant: small-caps; text-indent: 0; margin-top: 0; margin-bottom: 1.2em; }
    .centertb { font-size: 0.9em; font-weight: bold; text-align: center; font-variant: small-caps; text-indent: 0; margin-top: 2em; margin-bottom: 2em; }
    .stickupcap { font-size: 1.5em; font-weight: bold; }
    .copy { font-size: 0.85em; text-indent: 0; }
    .image_caption { font-size: 0.88em; text-align: center; font-style: italic; text-indent: 0; }
    .italics { font-style: italic; }
  `;

  // Generate noise filler classes to verify rare n=1 styled classes (.centert/.center/.centerb/.centertb/.stickupcap) survive capping
  const noiseCss = Array.from({ length: 30 }, (_, i) => `.plainfiller${i} { margin-top: 0.2em; }`).join('\n');
  const fullCss = `${bookCss}\n${noiseCss}`;

  const chHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h2 class="cnab1"><a href="Contents.xhtml#c8">Are You My AI?</a></h2>
  <p class="indent"><span class="stickupcap">I</span>t’s a little odd to start this high-tech expedition standing in front of a historical plaque.</p>
  <p class="centert">IN THIS BUILDING DURING THE SUMMER OF 1956</p>
  <p class="center">the Dartmouth Summer Research Project on Artificial Intelligence</p>
  <p class="centerb">Founding of Artificial Intelligence as a Research Discipline</p>
  <p class="indent">You might imagine this plaque resting beneath a sprawling maple tree.</p>
  <p class="centertb">AI IS CREATING INTELLIGENT MACHINES THAT CAN THINK, SEE, LEARN, AND ACT LIKE HUMANS—AND POTENTIALLY EXCEED HUMAN CAPABILITY.</p>
  <p class="indent">That is <span class="italics">really</span> all you need to remember.</p>
  <p class="image_caption">Fig 1. Historical bronze plaque at Dartmouth Hall.</p>
  <p class="copy">Copyright © 2025 by Author Name. All rights reserved.</p>
  ${Array.from({ length: 30 }, (_, i) => `<p class="plainfiller${i}">Neutral prose paragraph ${i} with enough words to be non-empty.</p>`).join('\n  ')}
</body>
</html>`;

  const candidates = buildBookStyleCensus([chHtml], [fullCss], 60);
  const candByName = new Map(candidates.map((c) => [c.cls, c]));

  // Neutral body classes should be filtered out
  assert.ok(!candByName.has('indent'), 'Neutral indented body .indent should be excluded from candidates');

  // Rare n=1 styled classes MUST survive prioritization
  for (const rareCls of ['centert', 'center', 'centerb', 'centertb', 'stickupcap', 'copy', 'image_caption', 'italics']) {
    assert.ok(candByName.has(rareCls), `Styled class .${rareCls} must survive census filtering & prioritization`);
  }

  // Cross-class visual run tracking: .centert/.center/.centerb form a 3-line consecutive run
  assert.equal(candByName.get('centert')?.maxConsecutiveRun, 3, 'Expected .centert maxConsecutiveRun === 3');
  assert.equal(candByName.get('center')?.maxConsecutiveRun, 3, 'Expected .center maxConsecutiveRun === 3');
  assert.equal(candByName.get('centerb')?.maxConsecutiveRun, 3, 'Expected .centerb maxConsecutiveRun === 3');
  assert.equal(candByName.get('stickupcap')?.scope, 'inline', 'Expected .stickupcap scope === inline');

  console.log('  [OK] buildBookStyleCensus rare-class survival & cross-class run tracking passed');

  // 2. Test deriveLocalStyleRoles (zero-token deterministic fallback)
  const localRoles = deriveLocalStyleRoles(candidates);
  assert.equal(localRoles.centert?.role, 'quote', 'Local role for .centert must be quote');
  assert.equal(localRoles.centert?.align, 'center');
  assert.equal(localRoles.center?.role, 'quote', 'Local role for .center must be quote');
  assert.equal(localRoles.centerb?.role, 'quote', 'Local role for .centerb must be quote');
  assert.equal(localRoles.centertb?.role, 'callout', 'Local role for bold centered sentence .centertb must be callout');
  assert.equal(localRoles.centertb?.weight, 'bold');
  assert.equal(localRoles.centertb?.align, 'center');
  assert.equal(localRoles.stickupcap?.role, 'dropcap', 'Local role for .stickupcap must be dropcap');
  assert.equal(localRoles.stickupcap?.scope, 'inline');
  assert.equal(localRoles.copy?.role, 'meta', 'Local role for .copy must be meta');
  assert.equal(localRoles.image_caption?.role, 'caption', 'Local role for .image_caption must be caption');
  assert.equal(localRoles.italics?.role, 'emphasis', 'Local role for .italics must be emphasis');
  console.log('  [OK] deriveLocalStyleRoles passed');

  // 3. Test parseStyleClassificationResponse normalization, scope safety & JSON unwrapping
  const aiRawResponse = `<think>Analyzing classes carefully...</think>
\`\`\`json
{
  "centert": {"role": "quote", "align": "center"},
  "center": {"role": "quote", "align": "center"},
  "centerb": {"role": "quote", "align": "center"},
  "centertb": {"role": "callout", "align": "center", "weight": "bold"},
  "stickupcap": {"role": "dropcap"},
  "italics": {"role": "h2"},
  "centert_wrong_inline": {"role": "quote"},
  "copy": {"role": "invalid_role_xyz"}
}
\`\`\``;
  const parsedAiRoles = parseStyleClassificationResponse(aiRawResponse, candidates);
  assert.equal(parsedAiRoles.centert?.role, 'quote');
  assert.equal(parsedAiRoles.centert?.align, 'center');
  assert.equal(parsedAiRoles.centertb?.role, 'callout');
  assert.equal(parsedAiRoles.centertb?.weight, 'bold');
  assert.equal(parsedAiRoles.stickupcap?.role, 'dropcap');
  assert.equal(parsedAiRoles.stickupcap?.scope, 'inline');
  assert.equal(parsedAiRoles.italics, undefined, 'Inline class given block role h2 must be rejected');
  assert.equal(parsedAiRoles.centert_wrong_inline, undefined, 'Unknown class must be discarded');
  assert.equal(parsedAiRoles.copy, undefined, 'Invalid role name must be discarded');
  console.log('  [OK] parseStyleClassificationResponse strict validation passed');

  // 4. Test Pure Heti CSS & DOM Mutation integration with BookStyleRoleMap
  const bookStyleRoles: BookStyleRoleMap = {
    centert: { role: 'quote', scope: 'block', align: 'center' },
    center: { role: 'quote', scope: 'block', align: 'center' },
    centerb: { role: 'quote', scope: 'block', align: 'center' },
    centertb: { role: 'callout', scope: 'block', align: 'center', weight: 'bold' },
    stickupcap: { role: 'dropcap', scope: 'inline' },
    italics: { role: 'emphasis', scope: 'inline' },
    copy: { role: 'meta', scope: 'block' },
    image_caption: { role: 'caption', scope: 'block' }
  };

  const hetiCss = buildAdaptiveChineseTypographyCss([fullCss], bookStyleRoles);
  const lowerCss = hetiCss.toLowerCase();
  for (const forbiddenHex of FORBIDDEN_HARDCODED_HEX) {
    assert.ok(
      !lowerCss.includes(forbiddenHex),
      `Pure Heti CSS must NOT contain hardcoded color ${forbiddenHex}`
    );
  }
  assert.ok(hetiCss.includes('color: inherit;'), 'Headings and body roles must use color: inherit');
  assert.ok(
    hetiCss.includes('h1 a, h2 a, h3 a, h4 a') && hetiCss.includes('color: inherit !important;') && hetiCss.includes('text-decoration: none !important;'),
    'Heading links must inherit color and strip underline'
  );
  assert.ok(hetiCss.includes('blockquote em, blockquote i'), 'CSS must invert nested KaiTi em/i back to SongTi');
  assert.ok(
    hetiCss.includes('.stickupcap') && /font-weight:\s*inherit\s*!important/.test(hetiCss),
    'Dropcap .stickupcap rule must neutralize font-weight cleanly'
  );
  assert.ok(
    /\[data-translit-role="quote-line"\][^}]*font-weight:\s*normal\s*!important/.test(hetiCss),
    'quote-line must enforce font-weight: normal !important against bold publisher rules'
  );
  assert.ok(
    /ol\[data-translit-list="none"\][\s\S]*list-style-type:\s*none\s*!important;[\s\S]*padding-left:\s*0\s*!important;/.test(hetiCss),
    'Pure Heti CSS must suppress duplicate list markers and outer padding for data-translit-list="none"'
  );

  // Extract payload using bookStyleRoles: NO `#` heading prefix on plaque lines or .centertb!
  const engine = new DomMutationEngine();
  const cssProfiles = parseEpubCssProfiles([fullCss]);
  const minimalXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h2 class="cnab1"><a href="Contents.xhtml#c8">Are You My AI?</a></h2>
  <p class="indent"><span class="stickupcap">I</span>t’s a little odd standing here.</p>
  <p class="centert">IN THIS BUILDING DURING THE SUMMER OF 1956</p>
  <p class="center">the Dartmouth Summer Research Project</p>
  <p class="centerb">Founding of Artificial Intelligence</p>
  <p class="centertb">AI is creating intelligent machines that can think like humans.</p>
  <p class="copy">Copyright 2025</p>
</body>
</html>`;

  const extracted = engine.extractTranslatablePayload(minimalXhtml, {}, cssProfiles, bookStyleRoles);
  assert.ok(extracted.blocks[0].slottedText.startsWith('## '), 'h2.cnab1 must keep ## heading prefix');
  assert.equal(
    extracted.blocks[1].slottedText,
    'It’s a little odd standing here.',
    'extractLeafBlockContent must unwrap <span class="stickupcap">I</span> so LLM sees clean word'
  );
  assert.ok(!extracted.blocks[2].slottedText.startsWith('#'), '.centert must NOT extract as heading');
  assert.ok(!extracted.blocks[3].slottedText.startsWith('#'), '.center must NOT extract as heading');
  assert.ok(!extracted.blocks[4].slottedText.startsWith('#'), '.centerb must NOT extract as heading');
  assert.ok(!extracted.blocks[5].slottedText.startsWith('#'), '.centertb must NOT extract as heading');

  // Verify span purification: dropcap unwrapped, empty decorative span removed, italics span normalized to <i>
  const spanNoiseXhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <p class="indent"><span class="stickupcap">I</span>t’s <span class="bk"></span><span class="italics">really</span> odd.</p>
</body></html>`;
  const purifiedExtract = engine.extractTranslatablePayload(spanNoiseXhtml, {}, cssProfiles, bookStyleRoles);
  assert.equal(
    purifiedExtract.blocks[0].slottedText,
    'It’s <i>really</i> odd.',
    'Input purification must drop empty span.bk, unwrap dropcap span, and normalize span.italics -> <i>'
  );

  // 4a. Monolingual with retained inline <span class="stickupcap"> + block role stamping
  const translatedPayloadWithRetainedSpan = [
    '你是我的 AI 吗？',
    '<span class="stickupcap">站</span>在这块牌匾前多少有些奇怪。',
    '1956 年夏天在此楼举行',
    '达特茅斯夏季人工智能研究项目',
    '人工智能作为一门研究学科的创立',
    '人工智能是创造能够像人类一样思考的智能机器。',
    '版权所有 2025'
  ].join('\n\n');

  const mutated = engine.mutateDomInPlace(minimalXhtml, translatedPayloadWithRetainedSpan, {
    cssProfiles,
    bookStyleRoles
  });
  const doc = parseHtmlDocument(mutated);
  assert.equal(doc.querySelector('h2.cnab1')?.getAttribute('data-translit-role'), 'h2');
  assert.equal(doc.querySelector('span.stickupcap')?.getAttribute('data-translit-role'), 'dropcap');
  assert.equal(doc.querySelector('p.centert')?.getAttribute('data-translit-role'), 'quote-line');
  assert.equal(doc.querySelector('p.centert')?.getAttribute('data-translit-quote-pos'), 'first');
  assert.equal(doc.querySelector('p.centert')?.getAttribute('data-translit-align'), 'center');
  assert.equal(doc.querySelector('p.center')?.getAttribute('data-translit-role'), 'quote-line');
  assert.equal(doc.querySelector('p.center')?.getAttribute('data-translit-quote-pos'), 'mid');
  assert.equal(doc.querySelector('p.centerb')?.getAttribute('data-translit-role'), 'quote-line');
  assert.equal(doc.querySelector('p.centerb')?.getAttribute('data-translit-quote-pos'), 'last');
  assert.equal(doc.querySelector('p.centertb')?.getAttribute('data-translit-role'), 'callout');
  assert.equal(doc.querySelector('p.centertb')?.getAttribute('data-translit-weight'), 'bold');
  assert.equal(doc.querySelector('p.centertb')?.getAttribute('data-translit-align'), 'center');
  assert.equal(doc.querySelector('p.copy')?.getAttribute('data-translit-role'), 'meta');

  // 4b. Bilingual source_first purifies Western dropcap span out of source payload & renders clean English source
  const bilingualMutated = engine.mutateDomInPlace(minimalXhtml, [
    '你是我的 AI 吗？',
    '站在这块牌匾前多少有些奇怪。',
    '1956 年夏天在此楼举行',
    '达特茅斯夏季人工智能研究项目',
    '人工智能作为一门研究学科的创立',
    '人工智能是创造能够像人类一样思考的智能机器。',
    '版权所有 2025'
  ].join('\n\n'), {
    cssProfiles,
    bookStyleRoles,
    bilingualMode: 'source_first'
  });
  const biDoc = parseHtmlDocument(bilingualMutated);
  assert.equal(
    biDoc.querySelector('.bilingual-source span.stickupcap'),
    null,
    'Purified bilingual source must unwrap <span class="stickupcap"> into clean English text'
  );
  assert.equal(
    biDoc.querySelector('p.indent.bilingual-source')?.textContent?.trim(),
    'It’s a little odd standing here.',
    'Bilingual source p.indent must read "It’s a little odd standing here." cleanly'
  );
  assert.equal(
    biDoc.querySelector('.bilingual-target span.stickupcap'),
    null,
    'Plain Chinese target translation should cleanly render without Western dropcap span'
  );
  assert.equal(
    biDoc.querySelector('p.indent.bilingual-target')?.getAttribute('data-translit-role'),
    'body',
    'Plain Chinese target p.indent should have data-translit-role="body"'
  );

  // 4c. Nested <blockquote><p class="block">...</p></blockquote> must NOT double-stamp quote-line;
  //     and bold CSS property on .centertb must survive even when AI JSON omits "weight": "bold"
  const aiOmittedWeightRoles: BookStyleRoleMap = {
    block: { role: 'quote', scope: 'block' },
    centertb: { role: 'callout', scope: 'block', align: 'center' }
  };
  const cssWithCentertb = buildAdaptiveChineseTypographyCss([fullCss], aiOmittedWeightRoles);
  assert.ok(
    cssWithCentertb.includes('blockquote [data-translit-role="quote-line"]'),
    'Pure Heti CSS must include defense-in-depth reset for quote-line inside blockquote'
  );
  const boldRuleMatch = cssWithCentertb.match(/(?:strong,\s*b[^{]*)\{/);
  assert.ok(
    boldRuleMatch && boldRuleMatch[0].includes('.centertb'),
    'Bold CSS class .centertb mapped to callout must be kept in boldSelectors even when AI omits weight'
  );

  const nestedBqXhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
    <blockquote><p class="block">Inside blockquote paragraph.</p></blockquote>
    <p class="centertb">Bold centered definition sentence.</p>
  </body></html>`;
  const nestedMutated = engine.mutateDomInPlace(
    nestedBqXhtml,
    '引言块内部段落。\n\n加粗居中定义句。',
    {
      cssProfiles,
      bookStyleRoles: aiOmittedWeightRoles
    }
  );
  const nestedDoc = parseHtmlDocument(nestedMutated);
  assert.notEqual(
    nestedDoc.querySelector('blockquote p.block')?.getAttribute('data-translit-role'),
    'quote-line',
    'Paragraph inside <blockquote> must NOT receive quote-line (avoids double left borders)'
  );
  assert.equal(
    nestedDoc.querySelector('p.centertb')?.getAttribute('data-translit-weight'),
    'bold',
    'p.centertb with CSS font-weight: bold must preserve data-translit-weight="bold" even when AI omits weight'
  );

  // Verify Class-based StyleClassifier wrapper
  const sc = new StyleClassifier();
  const localRes = sc.classifyLocal([chHtml], [fullCss]);
  assert.equal(localRes.roles.centertb?.role, 'callout');

  console.log('  [OK] Pure Heti CSS & DOM Mutation with BookStyleRoleMap passed');
  console.log('ALL STYLE CLASSIFIER TESTS PASSED!');
}

runTests();
