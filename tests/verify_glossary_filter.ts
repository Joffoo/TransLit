import assert from 'node:assert/strict';
import { filterGlossaryDeltaByPosterior, generateEnglishSearchForms } from '../utils/glossaryUtils.ts';

function runTests() {
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

  console.log('✅ All filterGlossaryDeltaByPosterior tests passed!');
}

runTests();
