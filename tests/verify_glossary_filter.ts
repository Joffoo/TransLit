import assert from 'node:assert/strict';
import {
  filterGlossaryDeltaByPosterior,
  generateEnglishSearchForms,
  mergeChunkGlossaries,
  normalizeTextForGlossarySearch,
  reconcileGlossaryDrift
} from '../utils/glossaryUtils.ts';
import { buildPosteriorTextForChapter } from '../utils/chapterUtils.ts';
import { AiService } from '../services/geminiService.ts';
import { AppConfig, Chapter, FootnoteNode } from '../types.ts';

async function runTests() {
  // 1. Case-insensitive deduplication against currentGlossary and within delta
  {
    const res = filterGlossaryDeltaByPosterior(
      'citadel=堡垒\nCitadel=城堡\nValkyrie=女武神',
      'Citadel=旧堡垒',
      'The valkyrie flew over the citadel.'
    );
    assert.equal(res.filteredText, 'Valkyrie=女武神');
    assert.equal(res.originalCount, 3);
    assert.equal(res.filteredCount, 1);
  }

  // 2. Short ASCII word-boundary guard (no false positives from "start", "part", "action")
  {
    const res = filterGlossaryDeltaByPosterior(
      'Art=艺术\nIon=离子\nArc=弧光',
      '',
      'At the start of the action, a part of the march began.'
    );
    assert.equal(res.filteredText, '');
    assert.equal(res.filteredCount, 0);

    const resExact = filterGlossaryDeltaByPosterior(
      'Art=艺术\nIon=离子',
      '',
      'The arts and ions were studied.'
    );
    assert.equal(resExact.filteredText, 'Art=艺术\nIon=离子');
    assert.equal(resExact.filteredCount, 2);
  }

  // 3. Multi-word phrase generic word filtering ("White House" vs "Alexander Pierce")
  {
    const res = filterGlossaryDeltaByPosterior(
      'White House=白宫\nAlexander Pierce=亚历山大·皮尔斯\nDark Forest=黑暗森林',
      '',
      'He painted the house white in the dark forest, and Pierce arrived.'
    );
    // "White House" does NOT appear contiguously, and both "white" & "house" are generic words.
    // "Pierce" is distinctive, and "dark forest" appears contiguously.
    assert.equal(res.filteredText, 'Alexander Pierce=亚历山大·皮尔斯\nDark Forest=黑暗森林');
  }

  // 4. Morphological variants without false "cit -> citizen" match
  {
    const forms = generateEnglishSearchForms('cities');
    assert.ok(forms.includes('city'));

    const noCitizen = filterGlossaryDeltaByPosterior(
      'City=城市\nWolf=狼\nRunning=奔跑',
      '',
      'Every citizen saw the wolves run.'
    );
    // "City" must NOT match "citizen"; "Wolf" matches "wolves"; "Running" matches "run"
    assert.equal(noCitizen.filteredText, 'Wolf=狼\nRunning=奔跑');
  }

  // 5. Pre-lowercased multi-slice posterior & empty posterior final-chapter safety & CJK
  {
    const precomputed = filterGlossaryDeltaByPosterior(
      '三体=Three-Body\n面壁者=Wallfacer\n一次性词=Once',
      '',
      { lowerTexts: ['', '面壁者计划启动了'] }
    );
    assert.equal(precomputed.filteredText, '面壁者=Wallfacer');

    const finalChapter = filterGlossaryDeltaByPosterior(
      'EpilogueTerm=尾声词',
      '',
      { lowerTexts: ['', '   '] }
    );
    assert.equal(finalChapter.filteredText, 'EpilogueTerm=尾声词');
  }

  // 7. mergeChunkGlossaries: empty, sparse, deduplication, and legacy format
  {
    assert.equal(mergeChunkGlossaries(undefined), '');
    assert.equal(mergeChunkGlossaries([]), '');
    assert.equal(mergeChunkGlossaries(['', '   ', undefined]), '');

    const sparse = mergeChunkGlossaries([
      'TermA=术语A\nTermB=术语B',
      undefined,
      '   ',
      'terma=术语A2\nTermC=术语C'
    ]);
    assert.equal(sparse, 'TermA=术语A\nTermB=术语B\nTermC=术语C');

    const legacy = mergeChunkGlossaries([
      'SOURCE: Alpha | TARGET: 阿尔法',
      'Beta: 贝塔'
    ]);
    assert.equal(legacy, 'Alpha=阿尔法\nBeta=贝塔');
  }

  // 8. Tiered posterior thresholds: lowercase common terms need >= 3 occurrences, capitalized proper nouns need >= 1
  {
    const res = filterGlossaryDeltaByPosterior(
      'heroin=海洛因\nrepugnance=反感\ntradeoffs=权衡\nKahneman=卡尼曼\nIVF=体外受精',
      '',
      [
        'heroin is banned, and heroin causes harm.',
        'repugnance shapes markets and repugnance varies.',
        'Every tradeoff involves tradeoffs, and another tradeoff matters.',
        'Kahneman studied decisions with IVF.'
      ].join(' ')
    );
    // heroin: 2 hits (< 3 -> dropped), repugnance: 2 hits (< 3 -> dropped),
    // tradeoffs: 3 hits via morphological forms tradeoff/tradeoffs (>= 3 -> kept),
    // Kahneman & IVF: capitalized proper nouns with 1 hit (>= 1 -> kept)
    assert.equal(res.filteredText, 'tradeoffs=权衡\nKahneman=卡尼曼\nIVF=体外受精');
  }

  // 9. Lowercase multi-word phrase requires >= 3 contiguous hits (no single-word fallback)
  {
    const res = filterGlossaryDeltaByPosterior(
      'black market=黑市\nmoral hazard=道德风险',
      '',
      'A black market appeared. Another black market grew, while market prices shifted. Moral hazard happened, moral hazard grew, and moral hazard persisted.'
    );
    assert.equal(res.filteredText, 'moral hazard=道德风险');
  }

  // 10. Short capitalized entity (2-3 words) vs long phrase (4+ words)
  {
    const resDrop = filterGlossaryDeltaByPosterior(
      'Danny Kahneman=丹尼·卡尼曼\nProceedings of the National Academy of Sciences=《美国国家科学院院刊》\nAmerica: The Jesuit Review=《美国：耶稣会评论》',
      '',
      'Kahneman later wrote about national sciences and an america review.'
    );
    // Danny Kahneman kept via surname "Kahneman"; 4+ word titles dropped because only isolated words appeared
    assert.equal(resDrop.filteredText, 'Danny Kahneman=丹尼·卡尼曼');

    const resAcronym = filterGlossaryDeltaByPosterior(
      'Proceedings of the National Academy of Sciences=《美国国家科学院院刊》\nAmerica: The Jesuit Review=《美国：耶稣会评论》',
      '',
      'A 2019 study in PNAS confirmed this, and America: The Jesuit Review also covered it.'
    );
    assert.equal(
      resAcronym.filteredText,
      'Proceedings of the National Academy of Sciences=《美国国家科学院院刊》\nAmerica: The Jesuit Review=《美国：耶稣会评论》'
    );
  }

  // 11. 3-word capitalized person names & case-sensitive component / acronym guards
  {
    const res = filterGlossaryDeltaByPosterior(
      [
        'Alan Page Fiske=艾伦·佩奇·菲斯克',
        'Alvin E. Roth=阿尔文·罗斯',
        'John Maynard Keynes=约翰·梅纳德·凯恩斯',
        'World Health Organization=世界卫生组织',
        'Food and Drug Administration=美国食品药品监督管理局',
        'Moral Economics=道德经济学'
      ].join('\n'),
      '',
      [
        'Turn to page 42 to see Alan Greenspan discuss who made the decision.',
        'Later, Alvin Roth and Keynes published a study reviewed by the FDA.',
        'People debated moral issues and economics separately.'
      ].join(' ')
    );
    // - Alan Page Fiske: "page" is lowercase/generic/middle word; "Alan" is first name of 3-word name -> DROPPED
    // - Alvin E. Roth: matched via "Alvin Roth" (First Last) -> KEPT
    // - John Maynard Keynes: matched via capitalized surname "Keynes" -> KEPT
    // - World Health Organization: acronym "WHO" must NOT match lowercase "who" -> DROPPED
    // - Food and Drug Administration: acronym "FDA" matches uppercase "FDA" -> KEPT
    // - Moral Economics: "moral" & "economics" are lowercase/generic -> DROPPED
    assert.equal(
      res.filteredText,
      [
        'Alvin E. Roth=阿尔文·罗斯',
        'John Maynard Keynes=约翰·梅纳德·凯恩斯',
        'Food and Drug Administration=美国食品药品监督管理局'
      ].join('\n')
    );

    // Surname possessive ("Fiske's") IS capitalized and keeps Alan Page Fiske
    const resPossessive = filterGlossaryDeltaByPosterior(
      'Alan Page Fiske=艾伦·佩奇·菲斯克',
      '',
      "In later chapters, Fiske's relational models theory reappears."
    );
    assert.equal(resPossessive.filteredText, 'Alan Page Fiske=艾伦·佩奇·菲斯克');
  }

  // 12. Full-width <-> half-width ASCII normalization & deduplication (Japanese EPUBs)
  {
    assert.equal(normalizeTextForGlossarySearch('ＡＩとＳＦとｗｅｂ２０２４'), 'AIとSFとweb2024');

    const res = filterGlossaryDeltaByPosterior(
      'AI=人工智能\nＡＩ=人工知能\nSF=科幻\nPC=个人电脑\nLINE=LINE',
      'PC=电脑',
      '最近のＡＩ技術はＳＦ小説のようだ。また、train や email には一致しない。'
    );
    // AI matches full-width ＡＩ; duplicate full-width ＡＩ deduplicated against AI;
    // SF matches ＳＦ; PC deduplicated against currentGlossary; LINE not present -> dropped.
    assert.equal(res.filteredText, 'AI=人工智能\nSF=科幻');

    // Reverse direction: full-width key against half-width posterior & existing half-width glossary
    const rev = filterGlossaryDeltaByPosterior(
      'ＡＩ=人工智能\nＳＮＳ=社交媒体',
      'AI=已存在',
      'Modern SNS platforms grew rapidly.'
    );
    assert.equal(rev.filteredText, 'ＳＮＳ=社交媒体');
  }

  // 13. Casing verification against source + posterior catches LLM-capitalized ordinary words
  {
    const sourceText = [
      '# Chapter 4: Alcohol and Drugs',
      'Heroin is widely banned. People debate tradeoffs when buying heroin or cake.',
      'A black market emerged quickly. Meanwhile, Kahneman and Dr. Roth studied IVF.',
      'A Valkyrie appeared in the story.'
    ].join('\n');

    const posteriorText = [
      'Heroin causes harm, and heroin remains illegal.',
      'Every tradeoff has tradeoffs, and another tradeoff appears later.',
      'Someone ate a cake once.',
      'A black market appeared twice: this black market grew.',
      'Later, Kahneman cited Roth on IVF, and a lone valkyrie flew away.'
    ].join(' ');

    const res = filterGlossaryDeltaByPosterior(
      [
        'Heroin=海洛因',
        'Tradeoffs=权衡',
        'Cake=蛋糕',
        'Black Market=黑市',
        'Kahneman=卡尼曼',
        'Roth=罗斯',
        'IVF=体外受精',
        'Valkyrie=女武神'
      ].join('\n'),
      '',
      posteriorText,
      { sourceText }
    );
    // - Heroin: sentence-start cap + lowercase -> demoted to >= 3, posterior has 2 -> DROPPED
    // - Tradeoffs: always lowercase -> demoted to >= 3, posterior has 3 (tradeoff/tradeoffs/tradeoff) -> KEPT
    // - Cake: always lowercase -> demoted to >= 3, posterior has 1 -> DROPPED
    // - Black Market: always lowercase -> demoted to >= 3 contiguous, posterior has 2 -> DROPPED
    // - Kahneman / Roth / IVF: genuine proper nouns / acronym -> KEPT
    // - Valkyrie: capitalized mid-sentence ("A Valkyrie") in source -> KEPT
    assert.equal(
      res.filteredText,
      [
        'Tradeoffs=权衡',
        'Kahneman=卡尼曼',
        'Roth=罗斯',
        'IVF=体外受精',
        'Valkyrie=女武神'
      ].join('\n')
    );
  }

  // 14. buildPosteriorTextForChapter excludes footnote-source/skippable/reference & includes internalized footnotes
  {
    const makeFn = (id: string, key: string, plainText: string): FootnoteNode => ({
      key,
      sourceFile: 'notes.xhtml',
      originalId: id,
      namespaceId: id,
      label: id,
      html: `<p>${plainText}</p>`,
      plainText,
      paragraphs: [plainText],
      referencedByChapters: [0]
    });

    const chapters: Chapter[] = [
      {
        id: 'ch0',
        index: 0,
        fileName: 'ch0.xhtml',
        title: 'Intro',
        content: '',
        markdown: 'Intro discusses Moral Economics__FN_REF_0-1__.',
        slottedMarkdown: 'Intro discusses Moral Economics__FN_REF_0-1__.',
        internalizedFootnotes: {
          '0-1': makeFn('0-1', 'notes.xhtml#n1', 'Alan Page Fiske and America: The Jesuit Review.')
        }
      },
      {
        id: 'ch1',
        index: 1,
        fileName: 'ch1.xhtml',
        title: 'Chapter 1',
        content: '',
        markdown: 'Chapter 1 body mentions Roth__FN_REF_1-1__.',
        slottedMarkdown: 'Chapter 1 body mentions Roth__FN_REF_1-1__.',
        internalizedFootnotes: {
          '1-1': makeFn('1-1', 'notes.xhtml#n2', 'See Kahneman on kidney exchanges.')
        }
      },
      {
        id: 'ref',
        index: 2,
        fileName: 'index.xhtml',
        title: 'Index',
        content: '',
        markdown: 'Fiske, Alan Page, 12; America: The Jesuit Review, 14',
        isReference: true
      },
      {
        id: 'notes',
        index: 3,
        fileName: 'notes.xhtml',
        title: 'Notes',
        content: '',
        markdown: 'Alan Page Fiske and America: The Jesuit Review. See Kahneman on kidney exchanges.',
        isFootnoteSource: true,
        isSystemProtected: true
      }
    ];

    const posteriorAfterIntro = buildPosteriorTextForChapter(chapters, 0, true);
    assert.ok(posteriorAfterIntro.includes('Chapter 1 body mentions Roth'));
    assert.ok(posteriorAfterIntro.includes('See Kahneman on kidney exchanges.'));
    assert.equal(posteriorAfterIntro.includes('Alan Page Fiske'), false, 'Drained Notes & Index must NOT leak into posterior');
    assert.equal(posteriorAfterIntro.includes('America: The Jesuit Review'), false, 'One-off Intro footnote must NOT self-match via Notes');

    const posteriorAfterCh1 = buildPosteriorTextForChapter(chapters, 1, true);
    assert.equal(posteriorAfterCh1, '', 'Last translatable chapter followed only by Reference/Notes must have empty posterior');
  }

  // 15. AiService.translateContent wires sourceText casing verification & chapter-local posterior footnotes
  {
    const origFetch = globalThis.fetch;
    let callIdx = 0;
    const mockResponses = [
      '<translation>[B1] 第一块关于蛋糕、卡尼曼和ＡＩ的译文__FN_REF_0-1__。\n\n[FN_DEF:0-1]\n来自艾伦·佩奇·菲斯克的注脚。\n[/FN_DEF]</translation><glossary>Cake=蛋糕\nKahneman=卡尼曼\nAlan Page Fiske=艾伦·佩奇·菲斯克\nAI=人工智能\nSpecialConcept=特殊概念</glossary>',
      '<translation>[B1] 第二块译文__FN_REF_0-2__。\n\n[FN_DEF:0-2]\n特殊概念在后文注脚中出现。\n[/FN_DEF]</translation><glossary></glossary>'
    ];

    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: mockResponses[callIdx++] || mockResponses[1] } }]
        })
    });

    try {
      const cfg: AppConfig = {
        apiKey: 'test-key',
        baseUrl: 'https://mock.local/v1',
        modelName: 'mock-model',
        sourceLanguage: 'English',
        additionalContext: '',
        enableProofreading: false,
        useRecommendedPrompts: false,
        smartSkip: true,
        enableGlossary: true
      };
      const ai = new AiService(cfg);
      const chunk1 = `${'A'.repeat(2400)} We bought a cake and met Kahneman about AI__FN_REF_0-1__.`;
      const chunk2 = `${'B'.repeat(2400)} Later, a cake appeared once, Kahneman spoke, and ＡＩ evolved__FN_REF_0-2__.`;
      const content = `${chunk1}\n\n${chunk2}`;
      const internalized: Record<string, FootnoteNode> = {
        '0-1': {
          key: 'notes#1',
          sourceFile: 'notes.xhtml',
          originalId: '1',
          namespaceId: '0-1',
          label: '1',
          html: '<p>Alan Page Fiske wrote on page 10.</p>',
          plainText: 'Alan Page Fiske wrote on page 10.',
          paragraphs: ['Alan Page Fiske wrote on page 10.'],
          referencedByChapters: [0]
        },
        '0-2': {
          key: 'notes#2',
          sourceFile: 'notes.xhtml',
          originalId: '2',
          namespaceId: '0-2',
          label: '2',
          html: '<p>See SpecialConcept in appendix.</p>',
          plainText: 'See SpecialConcept in appendix.',
          paragraphs: ['See SpecialConcept in appendix.'],
          referencedByChapters: [0]
        }
      };

      const res = await ai.translateContent(
        content,
        'Chinese (Simplified)',
        'System',
        undefined,
        [],
        [],
        '',
        'Turn to page 99 for more details.',
        internalized
      );

      // Cake (lowercase in source, only 1 hit in posterior) -> DROPPED
      // Alan Page Fiske (only in chunk 0's own footnote + "page" lowercase in posterior) -> DROPPED
      // Kahneman (capitalized proper noun in chunk 2) -> KEPT
      // AI (matches full-width ＡＩ in chunk 2) -> KEPT
      // SpecialConcept (matches chunk 2's chapter-local internalized footnote 0-2) -> KEPT
      assert.equal(
        res.glossary,
        'Kahneman=卡尼曼\nAI=人工智能\nSpecialConcept=特殊概念'
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 16. 3-word organizations: case-sensitive acronym support & institutional generic-word guard
  {
    const resKeep = filterGlossaryDeltaByPosterior(
      [
        'World Health Organization=世界卫生组织',
        'International Monetary Fund=国际货币基金组织',
        'World Trade Center=世界贸易中心',
        'Internal Revenue Service=美国国税局'
      ].join('\n'),
      '',
      'The WHO and IMF issued a joint report near the WTC, while the IRS updated tax rules.'
    );
    assert.equal(
      resKeep.filteredText,
      [
        'World Health Organization=世界卫生组织',
        'International Monetary Fund=国际货币基金组织',
        'World Trade Center=世界贸易中心',
        'Internal Revenue Service=美国国税局'
      ].join('\n')
    );

    const resDropGenericAndAllCaps = filterGlossaryDeltaByPosterior(
      [
        'World Health Organization=世界卫生组织',
        'Internal Revenue Service=美国国税局'
      ].join('\n'),
      '',
      'PART II: WHO WE ARE\nThe National Health Service discussed who leads the Organization.'
    );
    // "WHO" inside ALL-CAPS heading run "WHO WE ARE" + generic "Service"/"Organization" must NOT keep either org
    assert.equal(resDropGenericAndAllCaps.filteredText, '');
  }

  // 17. 4-word person names with generational/degree suffixes (Jr., PhD) vs non-suffixed titles
  {
    const res = filterGlossaryDeltaByPosterior(
      [
        'Martin Luther King Jr.=马丁·路德·金',
        'John F. Kennedy Jr.=小约翰·肯尼迪',
        'Oliver Wendell Holmes Jr.=小奥利弗·温德尔·霍姆斯',
        'Alvin E. Roth, PhD=阿尔文·罗斯博士',
        'America: The Jesuit Review=《美国：耶稣会评论》'
      ].join('\n'),
      '',
      'Martin Luther King inspired millions. JFK, Holmes, and Roth were cited alongside a Jesuit article.'
    );
    assert.equal(
      res.filteredText,
      [
        'Martin Luther King Jr.=马丁·路德·金',
        'John F. Kennedy Jr.=小约翰·肯尼迪',
        'Oliver Wendell Holmes Jr.=小奥利弗·温德尔·霍姆斯',
        'Alvin E. Roth, PhD=阿尔文·罗斯博士'
      ].join('\n')
    );

    // Generic surname "King" alone must NOT keep "Martin Luther King Jr."
    const resGenericKing = filterGlossaryDeltaByPosterior(
      'Martin Luther King Jr.=马丁·路德·金',
      '',
      'The King signed a decree.'
    );
    assert.equal(resGenericKing.filteredText, '');
  }

  // 18. Hyphenated Title-Case demotion, multi-word plural matching, and plain Title-Case heading guard
  {
    const res = filterGlossaryDeltaByPosterior(
      [
        'Self-Interest=自利',
        'Cost-Benefit=成本效益',
        'AI-Powered=AI驱动',
        'Black Markets=黑市',
        'Kidney Exchanges=肾脏交换',
        'Heroin=海洛因'
      ].join('\n'),
      '',
      [
        'People act in self-interest once and run one cost-benefit check.',
        'An AI-Powered assistant helped once.',
        'A black market appeared. The black market grew. Another black market thrived.',
        'A kidney exchange happened once, and heroin appeared once.'
      ].join(' '),
      {
        sourceText: [
          'Chapter 4: Alcohol and Heroin',
          'People pursue self-interest, cost-benefit analysis, black markets, kidney exchanges, and heroin.'
        ].join('\n')
      }
    );
    // - Self-Interest & Cost-Benefit: hyphenated ordinary words demoted to >= 3, only 1 hit -> DROPPED
    // - AI-Powered: contains acronym "AI", not simple Title-Case -> KEPT
    // - Black Markets: demoted to >= 3, matches 3x "black market" via phrase plural forms -> KEPT
    // - Kidney Exchanges: demoted to >= 3, only 1x "kidney exchange" -> DROPPED
    // - Heroin: plain Title-Case heading "Chapter 4: Alcohol and Heroin" ignored -> demoted, 1 hit -> DROPPED
    assert.equal(res.filteredText, 'AI-Powered=AI驱动\nBlack Markets=黑市');
  }

  // 19. Width-normalized deduplication in mergeChunkGlossaries & drift detection in reconcileGlossaryDrift
  {
    assert.equal(
      mergeChunkGlossaries(['AI=人工智能\nSF=科幻', 'ＡＩ=人工知能\nＳＮＳ=社交媒体']),
      'AI=人工智能\nSF=科幻\nＳＮＳ=社交媒体'
    );

    const drift = reconcileGlossaryDrift(
      '人工知能正在改变世界。',
      'ＡＩ=人工知能',
      'AI=人工智能'
    );
    assert.equal(drift.fixedText, '人工智能正在改变世界。');
    assert.equal(drift.fixes.length, 1);
  }

  console.log('✅ All filterGlossaryDeltaByPosterior & mergeChunkGlossaries tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
