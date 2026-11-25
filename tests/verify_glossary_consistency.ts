import assert from 'node:assert/strict';
import {
  reconcileGlossaryDrift,
  safeReplaceKeyword,
  detectGlossaryChanges,
  filterSafeCascadeChanges
} from '../utils/glossaryUtils.ts';

function runTests() {
  console.log('--- Running Glossary Consistency & Drift Guard Verification ---');

  // 1. Untranslated ASCII leak & lowercase speaker label fixed even when deltaGlossary is empty
  {
    const currentGlossary = [
      'Robotaxi=机器人出租车',
      'Ash=阿什(男)',
      'Joanna=乔安娜(女)',
      'The Great Gen AI Experiment=伟大的生成式 AI 实验'
    ].join('\n');

    const chunkText = [
      '特斯拉也在其车辆和 Robotaxi 上提供自动驾驶技术。',
      '<b>ash：</b>嘿，乔安娜，最近怎么样？',
      '<b>joanna：</b>我在看 The Great Gen AI Experiment。',
      '另外 Ashley 没有受到影响。'
    ].join('\n');

    const res = reconcileGlossaryDrift(chunkText, '', currentGlossary);
    assert.ok(res.fixedText.includes('车辆和 机器人出租车 上'), 'Robotaxi should be unified');
    assert.ok(res.fixedText.includes('<b>阿什：</b>'), 'lowercase speaker label ash： should be unified');
    assert.ok(res.fixedText.includes('<b>乔安娜：</b>'), 'lowercase speaker label joanna： should be unified');
    assert.ok(res.fixedText.includes('伟大的生成式 AI 实验。'), 'multi-word title should be unified');
    assert.ok(res.fixedText.includes('Ashley 没有受到影响'), 'Ashley must not be corrupted by Ash');
    assert.equal(res.fixes.length, 4);
    console.log('  [PASS] Untranslated leak & speaker label guard works even with empty deltaGlossary');
  }

  // 2. Parenthetical English glosses and self-containing glosses (e.g. LLM=大语言模型（LLM）) are never nested/corrupted
  {
    const currentGlossary = 'LLM=大语言模型（LLM）\nAsh=阿什(男)';
    const chunkText = '阿什（Ash）和 Ash 一起测试了大语言模型（LLM）以及独立的 LLM。';

    const res = reconcileGlossaryDrift(chunkText, '', currentGlossary);
    assert.equal(
      res.fixedText,
      '阿什（Ash）和 阿什 一起测试了大语言模型（LLM）以及独立的 大语言模型。'
    );
    console.log('  [PASS] Parenthetical glosses (阿什（Ash） & 大语言模型（LLM）) protected while standalone LLM unified');
  }

  // 3. Delta drift reconciliation protects footnote slots & HTML tags
  {
    const currentGlossary = 'Robotaxi=机器人出租车';
    const deltaGlossary = 'Robotaxi=无人出租车';
    const chunkText = '<p class="无人出租车">豆荚状的无人出租车__FN_REF_fn-1__准备出发。</p>';
    const footnotes: Record<string, string> = {
      'fn-1': '关于无人出租车的注释。'
    };

    const res = reconcileGlossaryDrift(chunkText, deltaGlossary, currentGlossary, footnotes);
    assert.equal(
      res.fixedText,
      '<p class="无人出租车">豆荚状的机器人出租车__FN_REF_fn-1__准备出发。</p>'
    );
    assert.equal(footnotes['fn-1'], '关于机器人出租车的注释。');
    console.log('  [PASS] Delta drift reconciliation protects HTML attributes & footnote slots');
  }

  // 4. Late-discovered term retroactive cascading safety filter
  {
    const newlyAdded = {
      Ash: '阿什(男)',
      LLM: '大语言模型（LLM）',
      AI: '人工智能',
      Waymo: 'Waymo'
    };
    const rawChanges = detectGlossaryChanges({}, newlyAdded);
    const safeChanges = filterSafeCascadeChanges(rawChanges);

    assert.equal(safeChanges.length, 2);
    assert.equal(safeChanges[0].sourceKey, 'Ash');
    assert.equal(safeChanges[0].oldTarget, 'Ash');
    assert.equal(safeChanges[0].newTarget, '阿什');
    assert.equal(safeChanges[1].sourceKey, 'LLM');
    assert.equal(safeChanges[1].oldTarget, 'LLM');
    assert.equal(safeChanges[1].newTarget, '大语言模型');

    const priorChunk = '打开了 Ash。\n<b>ash：</b>你好。\n阿什（Ash）在场。大语言模型（LLM）和独立 LLM。';
    const r1 = safeReplaceKeyword(
      priorChunk,
      safeChanges[0].oldTarget,
      safeChanges[0].newTarget,
      { caseInsensitive: true }
    );
    const r2 = safeReplaceKeyword(
      r1.replacedText,
      safeChanges[1].oldTarget,
      safeChanges[1].newTarget,
      { caseInsensitive: true }
    );
    assert.equal(r1.count, 2);
    assert.equal(r2.count, 1);
    assert.equal(r2.replacedText, '打开了 阿什。\n<b>阿什：</b>你好。\n阿什（Ash）在场。大语言模型（LLM）和独立 大语言模型。');
    console.log('  [PASS] Late-discovered term retroactive cascading & safety filter verified');
  }

  console.log('\n[PASS] ALL_GLOSSARY_CONSISTENCY_TESTS_SUCCESSFUL\n');
}

runTests();
