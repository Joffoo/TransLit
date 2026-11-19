import { spawnSync } from 'node:child_process';

const TESTS = [
  'tests/verify_api_profiles.ts',
  'tests/verify_bilingual_alignment.ts',
  'tests/verify_dom_mutation.ts',
  'tests/verify_footnote_pipeline.ts',
  'tests/verify_general_epub_parsing.ts',
  'tests/verify_glossary_filter.ts',
  'tests/verify_glossary_sync.ts',
  'tests/verify_heti_and_pseudo_headings.ts',
  'tests/verify_language_detection.ts',
  'tests/verify_skip_and_reference.ts',
];

const passed: string[] = [];
const failed: string[] = [];

for (const testFile of TESTS) {
  console.log(`\n=== Running ${testFile} ===`);
  const result = spawnSync(process.execPath, [...process.execArgv, testFile], {
    stdio: 'inherit',
  });
  if (result.status === 0) {
    passed.push(testFile);
    console.log(`[PASS] ${testFile}`);
  } else {
    failed.push(`${testFile} (exit ${result.status ?? 'null'})`);
    console.error(`[FAIL] ${testFile} (exit ${result.status ?? 'null'})`);
  }
}

console.log(`\n=== Summary: ${passed.length}/${TESTS.length} passed ===`);
if (failed.length > 0) {
  console.error(`Failed tests:\n - ${failed.join('\n - ')}`);
  process.exit(1);
}
