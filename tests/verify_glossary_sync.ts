import assert from 'node:assert/strict';
import { safeReplaceKeyword, detectGlossaryChanges } from '../utils/glossaryUtils';

async function testGlossarySync() {
  console.log('--- Testing Glossary Sync & Safe Replace Mechanism ---');

  // Test 1: Chinese target term replacement
  const text1 = '在斯普劳尔的大街上，斯普劳尔的居民们行色匆匆。';
  const res1 = safeReplaceKeyword(text1, '斯普劳尔', '蔓延城');
  assert.equal(res1.count, 2);
  assert.equal(res1.replacedText, '在蔓延城的大街上，蔓延城的居民们行色匆匆。');
  console.log('  [PASS] Standard Chinese term replacement');

  // Test 2: Footnote slots and syntax protection
  const text2 = '进入赛博空间{{TRANSLITFNSLOT:fn-1}}，代码`const Matrix = 1;`在运行，见[Matrix](https://example.com/Matrix)，图片![Matrix](img/Matrix.png)。';
  const res2 = safeReplaceKeyword(text2, 'Matrix', '黑客帝国');
  assert.equal(res2.count, 1); // Only the display text inside [Matrix] is replaced!
  assert.equal(res2.replacedText, '进入赛博空间{{TRANSLITFNSLOT:fn-1}}，代码`const Matrix = 1;`在运行，见[黑客帝国](https://example.com/Matrix)，图片![Matrix](img/Matrix.png)。');
  console.log('  [PASS] Syntax, footnote slots, URLs, and code blocks protected');

  // Test 3: ASCII word boundaries safety
  const text3 = 'The AI model is not a TRAIN or EMAIL or Category.';
  const res3 = safeReplaceKeyword(text3, 'AI', '人工智能');
  assert.equal(res3.count, 1);
  assert.equal(res3.replacedText, 'The 人工智能 model is not a TRAIN or EMAIL or Category.');
  console.log('  [PASS] ASCII word boundary prevents substring corruption');

  // Test 4: detectGlossaryChanges on target modification
  const oldMap = { 'Sprawl': '斯普劳尔', 'Wintermute': '冬寂' };
  const newMap = { 'Sprawl': '蔓延城', 'Wintermute': '冬寂' };
  const changes = detectGlossaryChanges(oldMap, newMap);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].sourceKey, 'Sprawl');
  assert.equal(changes[0].oldTarget, '斯普劳尔');
  assert.equal(changes[0].newTarget, '蔓延城');
  console.log('  [PASS] Target modification detected');

  // Test 5: detectGlossaryChanges on new term added
  const newMap2 = { 'Sprawl': '斯普劳尔', 'Wintermute': '冬寂', 'Neuromancer': '神经漫游者' };
  const changes2 = detectGlossaryChanges(oldMap, newMap2);
  assert.equal(changes2.length, 1);
  assert.equal(changes2[0].sourceKey, 'Neuromancer');
  assert.equal(changes2[0].oldTarget, 'Neuromancer');
  assert.equal(changes2[0].newTarget, '神经漫游者');
  console.log('  [PASS] Newly added term detected for untranslated source cascading');

  // Test 6: detectGlossaryChanges ignores empty placeholder keys
  const newMap3 = { ...oldMap, '新词条_1': '' };
  const changes3 = detectGlossaryChanges(oldMap, newMap3);
  assert.equal(changes3.length, 0);
  console.log('  [PASS] Blank placeholder terms ignored');

  // Test 7: detectGlossaryChanges strips parenthetical gender/context notes
  const changes4 = detectGlossaryChanges(
    { Alex: '亚历克斯(女)' },
    { Alex: '艾利克斯(女)' }
  );
  assert.equal(changes4.length, 1);
  assert.equal(changes4[0].oldTarget, '亚历克斯');
  assert.equal(changes4[0].newTarget, '艾利克斯');
  console.log('  [PASS] Parenthetical gender notes stripped for glossary sync');

  console.log('\n[PASS] ALL_GLOSSARY_SYNC_TESTS_SUCCESSFUL\n');
}

testGlossarySync().catch(err => {
  console.error(err);
  process.exit(1);
});
