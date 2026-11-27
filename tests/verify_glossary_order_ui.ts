import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';

async function buildTestEpub(outPath: string): Promise<void> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Glossary Chronological Order E2E Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="Text/ch1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>Chapter 2</text></navLabel><content src="Text/ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`
  );

  // Chapter 1 spans 2 chunks (> 3000 chars total) so we test multi-chunk Prefix Caching too
  const p1 = `${'Narrative introduction sentence for part one. '.repeat(55)}Zebra and Alex discussed 1984 and heroin in detail.`;
  const p2 = `${'Continuation narrative paragraph for part two. '.repeat(55)}Later Alpha met 007 while Zebra, Alex, 1984, heroin, and heroin reappeared.`;
  zip.file(
    'OEBPS/Text/ch1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 1</h1><p>${p1}</p><p>${p2}</p></body></html>`
  );

  // Chapter 2 mentions all prior terms + Beta so posterior filter keeps every candidate
  zip.file(
    'OEBPS/Text/ch2.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 2</h1><p>In the finale, Zebra, 1984, Alex, Alpha, 007, and Beta concluded the case against heroin.</p></body></html>`
  );

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(outPath, buf);
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not respond at ${url} within ${timeoutMs}ms`);
}

function createMockLlmHandler() {
  const translationSystemPrompts: string[] = [];
  const optimizerSystemPrompts: string[] = [];
  let translationCallIndex = 0;

  const translationReplies = [
    '<translation>[B1] 第一章\n\n[B2] 第一段译文，提及斑马、亚历克斯和一九八四。</translation><glossary>Zebra=斑马\n1984=一九八四\nheroin=海洛因\nAlex=亚历克斯(女)</glossary>',
    '<translation>[B1] 第二段译文，提及阿尔法和邦德。</translation><glossary>Alpha=阿尔法\n007=邦德</glossary>',
    '<translation>[B1] 第二章\n\n[B2] 终章译文，提及贝塔。</translation><glossary>Beta=贝塔</glossary>',
  ];

  const handlePayload = (payload: any): string => {
    const messages: Array<{ role: string; content: string }> = payload.messages || [];
    const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
    const userMsg = messages.find((m) => m.role === 'user')?.content || '';

    if (sysMsg.includes('EPUB book structure classifier')) {
      return JSON.stringify({ category: 'content', disposition: 'translate', reason: 'mock' });
    }
    if (sysMsg.includes('CSS') || sysMsg.includes('Heti') || userMsg.includes('classes')) {
      return '{}';
    }
    if (sysMsg.includes('术语表审查专家')) {
      optimizerSystemPrompts.push(sysMsg);
      // Intentionally scramble output alphabetically, add Markdown bullets/backticks/full-width ＝,
      // drop heroin, strip (女), and add commentary. Also echo BulkNewTerm / ＡＬＰＨＡ when present in input.
      const lines = [
        'Note: cleaned glossary below',
        '- `007`=邦德',
        '2. **1984**＝一九八四',
        '* alex=亚历克斯',
        '- Alpha -> 阿尔法',
        '• Beta：贝塔',
        '- Zebra=斑马',
      ];
      if (userMsg.includes('BulkNewTerm')) {
        lines.splice(1, 0, '- BulkNewTerm=纯文本新增');
      }
      if (userMsg.includes('ＡＬＰＨＡ')) {
        lines.push('- ＡＬＰＨＡ=全角重复');
      }
      return lines.join('\n');
    }
    translationSystemPrompts.push(sysMsg);
    return translationReplies[translationCallIndex++] || translationReplies[translationReplies.length - 1];
  };

  return {
    baseUrl: 'https://mock-llm.translit.test/v1',
    translationSystemPrompts,
    optimizerSystemPrompts,
    handlePayload,
  };
}

async function readGlossaryTableRows(page: any): Promise<Array<{ key: string; value: string }>> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const out: Array<{ key: string; value: string }> = [];
    for (const row of rows) {
      const inputs = row.querySelectorAll('input[type="text"]');
      if (inputs.length >= 2) {
        out.push({
          key: (inputs[0] as HTMLInputElement).value,
          value: (inputs[1] as HTMLInputElement).value,
        });
      }
    }
    return out;
  });
}

async function main() {
  const tmpEpub = path.join(os.tmpdir(), `translit_glossary_order_e2e_${Date.now()}.epub`);
  await buildTestEpub(tmpEpub);
  const mockLlm = createMockLlmHandler();

  const port = 4181;
  const serverUrl = `http://127.0.0.1:${port}/`;
  const viteBin = path.resolve('node_modules/vite/bin/vite.js');
  const viteProc = spawn(
    process.execPath,
    [viteBin, 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { stdio: 'ignore' }
  );

  let browser;
  try {
    await waitForServer(serverUrl, 30000);
    browser = await chromium.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.route('**/__api_proxy', async (route) => {
      const postData = route.request().postData() || '{}';
      const payload = JSON.parse(postData);
      const content = mockLlm.handlePayload(payload);
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-translit-proxy': '1',
        },
        body: JSON.stringify({
          id: 'mock-chatcmpl',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      });
    });

    await page.goto(serverUrl, { waitUntil: 'networkidle' });

    // Clean state and seed API profile pointing to local mock server
    await page.evaluate(async (apiBaseUrl: string) => {
      const dbs = (await window.indexedDB.databases?.()) || [];
      for (const db of dbs) {
        if (db.name) window.indexedDB.deleteDatabase(db.name);
      }
      localStorage.clear();
      localStorage.setItem(
        'translit_api_profiles',
        JSON.stringify({
          activeProfileId: 'mock-prof',
          profiles: [
            {
              id: 'mock-prof',
              name: 'Mock LLM',
              baseUrl: apiBaseUrl,
              apiKey: 'sk-mock-key',
              modelName: 'mock-model',
              updatedAt: Date.now(),
            },
          ],
        })
      );
    }, mockLlm.baseUrl);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Disable two-step proofreading so chunk size is 3000 (2 chunks for Ch1 + 1 chunk for Ch2)
    const twoStepLabel = page.locator('label[title*="两步"]').first();
    if ((await twoStepLabel.count()) > 0) {
      await twoStepLabel.click();
    } else {
      await page.locator('label:has-text("两步翻译")').click();
    }

    // Upload test EPUB
    const fileInput = page.locator('input[type="file"][accept*=".epub"]').first();
    await fileInput.setInputFiles(tmpEpub);
    await page.getByRole('button', { name: /章节目录 \(2\)/ }).waitFor({ timeout: 10000 });

    // Start translation
    await page.getByRole('button', { name: /继续翻译|开始翻译/ }).click();

    // Wait for completion ("重新导出" button or status "已完成")
    await page.locator('text=全部完成').waitFor({ timeout: 20000 });

    // 1. Verify Prefix Caching invariant across translation chunks
    assert.equal(mockLlm.translationSystemPrompts.length, 3, 'Expected 3 translation chunk calls');
    assert.ok(
      mockLlm.translationSystemPrompts[1].endsWith(
        'CURRENT GLOSSARY:\nZebra=斑马\n1984=一九八四\nheroin=海洛因\nAlex=亚历克斯(女)'
      ),
      `Chunk 1 glossary mismatch: ${mockLlm.translationSystemPrompts[1].slice(-150)}`
    );
    assert.ok(
      mockLlm.translationSystemPrompts[2].startsWith(mockLlm.translationSystemPrompts[1]),
      'Chunk 2 system prompt MUST start with exact Chunk 1 system prompt (Prefix Caching)'
    );
    assert.ok(
      mockLlm.translationSystemPrompts[2].endsWith(
        'CURRENT GLOSSARY:\nZebra=斑马\n1984=一九八四\nheroin=海洛因\nAlex=亚历克斯(女)\nAlpha=阿尔法\n007=邦德'
      ),
      `Chunk 2 glossary mismatch: ${mockLlm.translationSystemPrompts[2].slice(-200)}`
    );
    console.log('  [PASS] Multi-chunk translation preserved chronological Prefix Caching');

    // 2. Open Glossary tab and check UI table order (NOT alphabetical!)
    await page.getByRole('button', { name: /全书术语库 \(7\)/ }).click();
    await page.waitForTimeout(200);

    const rowsAfterTranslate = await readGlossaryTableRows(page);
    assert.deepEqual(
      rowsAfterTranslate.map((r) => r.key),
      ['Zebra', '1984', 'heroin', 'Alex', 'Alpha', '007', 'Beta']
    );
    console.log('  [PASS] Glossary UI table renders in strict chronological order');

    // Check bulk text view order matches table order
    await page.getByRole('button', { name: '切换纯文本' }).click();
    const bulkTextBeforeClean = await page.locator('textarea').last().inputValue();
    assert.equal(
      bulkTextBeforeClean,
      'Zebra=斑马\n1984=一九八四\nheroin=海洛因\nAlex=亚历克斯(女)\nAlpha=阿尔法\n007=邦德\nBeta=贝塔'
    );
    await page.getByRole('button', { name: '切换表格' }).click();

    // 3. Click "智能去重净化" (mock LLM scrambles alphabetically & strips gender tag!)
    await page.getByRole('button', { name: /智能去重净化/ }).click();
    await page.getByRole('button', { name: /全书术语库 \(6\)/ }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(200);

    assert.equal(mockLlm.optimizerSystemPrompts.length, 1);
    const rowsAfterClean = await readGlossaryTableRows(page);
    assert.deepEqual(rowsAfterClean, [
      { key: 'Zebra', value: '斑马' },
      { key: '1984', value: '一九八四' },
      { key: 'Alex', value: '亚历克斯(女)' },
      { key: 'Alpha', value: '阿尔法' },
      { key: '007', value: '邦德' },
      { key: 'Beta', value: '贝塔' },
    ]);
    console.log('  [PASS] Smart Deduplication ("智能去重净化") preserved strict chronological order & gender tags');

    // 4. Reload browser page and verify real IndexedDB restores exact chronological order
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /全书术语库 \(6\)/ }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /全书术语库 \(6\)/ }).click();
    await page.waitForTimeout(200);

    const rowsAfterReload = await readGlossaryTableRows(page);
    assert.deepEqual(
      rowsAfterReload.map((r) => r.key),
      ['Zebra', '1984', 'Alex', 'Alpha', '007', 'Beta']
    );
    console.log('  [PASS] Real IndexedDB reload restored strict chronological order');

    // 5. Test in-place rename (to alphabetically first key) + add term at tail + save + reload
    const secondKeyInput = page.locator('table tbody tr').nth(1).locator('input[type="text"]').first();
    await secondKeyInput.click();
    await secondKeyInput.fill('AAA_InPlace');
    await secondKeyInput.blur();

    await page.getByRole('button', { name: /新增术语/ }).click();
    const lastRow = page.locator('table tbody tr').last();
    const lastKeyInput = lastRow.locator('input[type="text"]').first();
    const lastValInput = lastRow.locator('input[type="text"]').nth(1);
    await lastKeyInput.click();
    await lastKeyInput.fill('000_AddedLast');
    await lastKeyInput.blur();
    await lastValInput.fill('末尾新词');

    await page.getByRole('button', { name: /保存修改/ }).click();
    await page.waitForTimeout(300);

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /全书术语库 \(7\)/ }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /全书术语库 \(7\)/ }).click();
    await page.waitForTimeout(200);

    const rowsAfterManualEdit = await readGlossaryTableRows(page);
    assert.deepEqual(
      rowsAfterManualEdit.map((r) => r.key),
      ['Zebra', 'AAA_InPlace', 'Alex', 'Alpha', '007', 'Beta', '000_AddedLast']
    );
    console.log('  [PASS] Manual in-place rename & append preserved chronological order across reload');

    // 6. Test legacy v3 IndexedDB (plain string values) automatic chronological migration on reload
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('epub_translator_db', 3);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('glossary', 'readwrite');
          const store = tx.objectStore('glossary');
          store.clear();
          // Seed legacy plain-string values (no `order` metadata)
          store.put('斑马', 'Zebra');
          store.put('一九八四', '1984');
          store.put('亚历克斯(女)', 'Alex');
          store.put('阿尔法', 'Alpha');
          store.put('邦德', '007');
          store.put('贝塔', 'Beta');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    });

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /全书术语库 \(6\)/ }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /全书术语库 \(6\)/ }).click();
    await page.waitForTimeout(200);

    const rowsAfterLegacyMigration = await readGlossaryTableRows(page);
    assert.deepEqual(
      rowsAfterLegacyMigration.map((r) => r.key),
      ['Zebra', '1984', 'Alex', 'Alpha', '007', 'Beta']
    );
    console.log('  [PASS] Legacy v3 IndexedDB plain-string glossary auto-migrated to chronological order');

    // 7. Bulk Edit -> Toggle to Table View preserves edits & Smart Cleanup cleans unsaved edits in order
    await page.getByRole('button', { name: '切换纯文本' }).click();
    const bulkArea = page.locator('textarea').last();
    const currentBulk = await bulkArea.inputValue();
    await bulkArea.fill(`${currentBulk}\nＡＬＰＨＡ=全角重复\nBulkNewTerm=纯文本新增`);

    // Switch back to Table View WITHOUT clicking Save -> edits must NOT vanish!
    await page.getByRole('button', { name: '切换表格' }).click();
    await page.waitForTimeout(150);
    const rowsAfterBulkToggle = await readGlossaryTableRows(page);
    assert.deepEqual(
      rowsAfterBulkToggle.map((r) => r.key),
      ['Zebra', '1984', 'Alex', 'Alpha', '007', 'Beta', 'ＡＬＰＨＡ', 'BulkNewTerm']
    );

    // Click Smart Cleanup directly on unsaved edits -> deduplicates ＡＬＰＨＡ to Alpha's slot & keeps BulkNewTerm at tail
    await page.getByRole('button', { name: /智能去重净化/ }).click();
    await page.getByRole('button', { name: /全书术语库 \(7\)/ }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(200);
    const rowsAfterUnsavedCleanup = await readGlossaryTableRows(page);
    assert.deepEqual(
      rowsAfterUnsavedCleanup.map((r) => r.key),
      ['Zebra', '1984', 'Alex', 'Alpha', '007', 'Beta', 'BulkNewTerm']
    );
    console.log('  [PASS] Bulk->Table toggle & Smart Cleanup on unsaved edits preserved exact chronological order');

    // 8. Direct key rename + immediate Save click WITHOUT explicit blur first
    const firstKeyInput = page.locator('table tbody tr').nth(1).locator('input[type="text"]').first();
    await firstKeyInput.click();
    await firstKeyInput.fill('000_DirectSave');
    // Click Save immediately without calling blur()
    await page.getByRole('button', { name: /保存修改/ }).click();
    await page.waitForTimeout(300);

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /全书术语库 \(7\)/ }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /全书术语库 \(7\)/ }).click();
    await page.waitForTimeout(200);
    const rowsAfterDirectSave = await readGlossaryTableRows(page);
    assert.deepEqual(
      rowsAfterDirectSave.map((r) => r.key),
      ['Zebra', '000_DirectSave', 'Alex', 'Alpha', '007', 'Beta', 'BulkNewTerm']
    );
    console.log('  [PASS] Direct rename + immediate Save click persisted in-place chronological order');

    // 9. Bulk Edit -> Manual Sync ("联动已译章节") works directly from Bulk Edit mode
    await page.getByRole('button', { name: '切换纯文本' }).click();
    const bulkAreaSync = page.locator('textarea').last();
    const bulkForSync = await bulkAreaSync.inputValue();
    await bulkAreaSync.fill(bulkForSync.replace('Zebra=斑马', 'Zebra=黑斑马'));
    await page.getByRole('button', { name: '联动已译章节' }).click();
    await page.waitForTimeout(300);

    const ch1TranslatedAfterSync = await page.evaluate(async () => {
      return await new Promise<string>((resolve, reject) => {
        const req = indexedDB.open('epub_translator_db', 3);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('chapters', 'readonly');
          const store = tx.objectStore('chapters');
          const allReq = store.getAll();
          allReq.onsuccess = () => {
            const chapters = (allReq.result || []).sort((a: any, b: any) => a.index - b.index);
            db.close();
            resolve(chapters[0]?.translatedMarkdown || '');
          };
          allReq.onerror = () => reject(allReq.error);
        };
      });
    });
    assert.ok(
      ch1TranslatedAfterSync.includes('黑斑马'),
      `Expected Chapter 1 translation to sync "黑斑马", got: ${ch1TranslatedAfterSync}`
    );
    console.log('  [PASS] Manual Sync ("联动已译章节") from Bulk Edit mode persisted & updated translated chapters');

    assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
    console.log('\n[PASS] ALL_GLOSSARY_ORDER_UI_E2E_TESTS_SUCCESSFUL\n');
  } finally {
    if (browser) await browser.close();
    if (viteProc.pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /pid ${viteProc.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // ignore
        }
      } else {
        viteProc.kill('SIGTERM');
      }
    }
    if (fs.existsSync(tmpEpub)) fs.unlinkSync(tmpEpub);
  }
}

main().catch((err) => {
  console.error('Glossary Order UI E2E test failed:', err);
  process.exit(1);
});
