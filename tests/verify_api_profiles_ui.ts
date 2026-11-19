import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE_URL = process.env.TRANSLIT_TEST_URL || 'http://127.0.0.1:4173/';

async function main() {
  console.log(`=== Starting Multi-API Profile UI Verification (${BASE_URL}) ===`);
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    console.error('PAGE ERROR:', err.message);
    pageErrors.push(err.message);
  });

  // 1. Seed legacy translit_api_config before app boots to test migration in browser
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const dbs = (await window.indexedDB.databases?.()) || [];
    for (const db of dbs) {
      if (db.name) window.indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
    localStorage.setItem(
      'translit_api_config',
      JSON.stringify({
        baseUrl: 'https://api.legacy.example/v1',
        apiKey: 'sk-legacy-browser-key',
        modelName: 'legacy-model-v1',
      })
    );
  });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // Collapsed header should show migrated profile name + model
  const headerText = await page.locator('button:has-text("API 接口配置")').textContent();
  assert.ok(headerText?.includes('默认配置'), `Expected 默认配置 in header, got: ${headerText}`);
  assert.ok(headerText?.includes('legacy-model-v1'), `Expected legacy-model-v1 in header, got: ${headerText}`);

  // Expand API settings
  await page.click('button:has-text("API 接口配置")');
  await page.waitForTimeout(200);

  // Verify migrated fields
  assert.equal(await page.inputValue('input[placeholder*="NVIDIA DeepSeek"]'), '默认配置');
  assert.equal(await page.inputValue('input[placeholder*="integrate.api.nvidia.com"]'), 'https://api.legacy.example/v1');
  assert.equal(await page.inputValue('input[placeholder*="minimaxai"]'), 'legacy-model-v1');
  assert.equal(await page.inputValue('input[placeholder="请输入接口密钥"]'), 'sk-legacy-browser-key');

  // 2. Create a new profile
  await page.click('button:has-text("新建")');
  await page.fill('input[placeholder*="NVIDIA DeepSeek"]', 'OpenAI 主力');
  await page.fill('input[placeholder*="integrate.api.nvidia.com"]', 'https://api.openai.com/v1');
  await page.fill('input[placeholder*="minimaxai"]', 'gpt-4.1-mini');
  await page.fill('input[placeholder="请输入接口密钥"]', 'sk-openai-test-999');

  // 3. Duplicate it and change model
  await page.click('button:has-text("复制")');
  assert.equal(await page.inputValue('input[placeholder*="NVIDIA DeepSeek"]'), 'OpenAI 主力 (副本)');
  await page.fill('input[placeholder*="NVIDIA DeepSeek"]', 'OpenAI 备用模型');
  await page.fill('input[placeholder*="minimaxai"]', 'gpt-4o');

  // 4. Switch back to 默认配置 via select dropdown
  const profileSelect = page.locator('select[aria-label="选择已保存的 API 配置"]');
  const optionCount = await profileSelect.locator('option').count();
  assert.equal(optionCount, 3, 'Should have 3 saved profiles');

  const firstOptionValue = await profileSelect.locator('option').first().getAttribute('value');
  assert.ok(firstOptionValue);
  await profileSelect.selectOption(firstOptionValue);
  assert.equal(await page.inputValue('input[placeholder*="NVIDIA DeepSeek"]'), '默认配置');
  assert.equal(await page.inputValue('input[placeholder*="minimaxai"]'), 'legacy-model-v1');
  assert.equal(await page.inputValue('input[placeholder="请输入接口密钥"]'), 'sk-legacy-browser-key');

  // 5. Switch to OpenAI 主力 and reload page to verify persistence
  const secondOptionValue = await profileSelect.locator('option').nth(1).getAttribute('value');
  assert.ok(secondOptionValue);
  await profileSelect.selectOption(secondOptionValue);
  await page.waitForTimeout(200);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const reloadedHeader = await page.locator('button:has-text("API 接口配置")').textContent();
  assert.ok(reloadedHeader?.includes('OpenAI 主力'), `Expected OpenAI 主力 after reload, got: ${reloadedHeader}`);
  assert.ok(reloadedHeader?.includes('gpt-4.1-mini'), `Expected gpt-4.1-mini after reload, got: ${reloadedHeader}`);

  await page.click('button:has-text("API 接口配置")');
  assert.equal(await page.inputValue('input[placeholder="请输入接口密钥"]'), 'sk-openai-test-999');

  // 6. Test API key visibility toggle
  const keyInput = page.locator('input[placeholder="请输入接口密钥"]');
  assert.equal(await keyInput.getAttribute('type'), 'password');
  await page.click('button[title="显示密钥"]');
  assert.equal(await keyInput.getAttribute('type'), 'text');
  await page.click('button[title="隐藏密钥"]');
  assert.equal(await keyInput.getAttribute('type'), 'password');

  // 7. Test blank profile name normalization on blur
  const nameInput = page.locator('input[placeholder*="NVIDIA DeepSeek"]');
  await nameInput.fill('   ');
  await nameInput.blur();
  assert.equal(await nameInput.inputValue(), '未命名配置');

  // 8. Test 2-step delete confirmation and deleting all remaining profiles
  await page.click('button:has-text("删除")');
  await page.click('button:has-text("确认删除")');
  const remainingCount = await page.locator('select[aria-label="选择已保存的 API 配置"] option').count();
  assert.equal(remainingCount, 2, 'Should have 2 profiles left after deletion');

  for (let i = 0; i < 2; i++) {
    await page.click('button:has-text("删除")');
    await page.click('button:has-text("确认删除")');
  }
  assert.equal(await page.locator('select[aria-label="选择已保存的 API 配置"]').count(), 0);

  // Reload and ensure deleted profiles are NOT resurrected
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const emptyHeader = await page.locator('button:has-text("API 接口配置")').textContent();
  assert.ok(emptyHeader?.includes('未配置'), `Expected 未配置 after deleting all profiles, got: ${emptyHeader}`);

  assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
  await browser.close();
  console.log('ALL Multi-API Profile UI tests passed!');
}

main().catch((err) => {
  console.error('UI test failed:', err);
  process.exit(1);
});
