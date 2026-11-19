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
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>UI Skip &amp; Reference Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="copy" href="Text/copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="media" href="Text/media.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="copy"/>
    <itemref idref="media"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="notes"/>
  </spine>
</package>`
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Copyright</text></navLabel><content src="Text/copyright.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>Cover Illustration</text></navLabel><content src="Text/media.xhtml"/></navPoint>
    <navPoint id="np3" playOrder="3"><navLabel><text>Chapter 1</text></navLabel><content src="Text/ch1.xhtml"/></navPoint>
    <navPoint id="np4" playOrder="4"><navLabel><text>Chapter 2</text></navLabel><content src="Text/ch2.xhtml"/></navPoint>
    <navPoint id="np5" playOrder="5"><navLabel><text>Notes</text></navLabel><content src="Text/notes.xhtml"/></navPoint>
  </navMap>
</ncx>`
  );
  zip.file(
    'OEBPS/Text/copyright.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Copyright 2025 All rights reserved. ISBN 978-0-00-000000-0.</p></body></html>`
  );
  zip.file(
    'OEBPS/Text/media.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="cover.jpg" alt="Cover"/></body></html>`
  );
  zip.file(
    'OEBPS/Text/ch1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 1</h1><p>This is the first real narrative chapter with enough words to be classified as standard content.<a href="notes.xhtml#fn1">1</a></p></body></html>`
  );
  zip.file(
    'OEBPS/Text/ch2.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 2</h1><p>This is the second real narrative chapter with plenty of English prose for testing reference mode.</p></body></html>`
  );
  zip.file(
    'OEBPS/Text/notes.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Notes</h1><p id="fn1">Footnote one explanation.</p></body></html>`
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

async function main() {
  const tmpEpub = path.join(os.tmpdir(), `translit_ui_test_${Date.now()}.epub`);
  await buildTestEpub(tmpEpub);

  const port = 4179;
  const serverUrl = `http://127.0.0.1:${port}/`;
  const viteProc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { stdio: 'ignore', shell: process.platform === 'win32' }
  );

  let browser;
  try {
    await waitForServer(serverUrl);
    browser = await chromium.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(serverUrl, { waitUntil: 'networkidle' });

    // Upload the generated EPUB
    const fileInput = page.locator('input[type="file"][accept*=".epub"]').first();
    await fileInput.setInputFiles(tmpEpub);

    // Wait for chapters to be extracted and switch to Chapter List tab
    const chaptersTab = page.getByRole('button', { name: /章节目录 \(5\)/ });
    await chaptersTab.waitFor({ timeout: 10000 });
    await chaptersTab.click();

    // Verify initial smartSkip=true classification badges:
    // 1. Copyright -> 已跳过
    // 2. Cover Illustration -> 保持原文
    // 3. Chapter 1 -> 未翻译
    // 4. Chapter 2 -> 未翻译
    // 5. Notes -> 系统注释源文件 • 0偏移保护 + 已锁定
    const chapterCards = page.locator('div.group.border.rounded-none.p-4');
    await chapterCards.first().waitFor({ timeout: 5000 });
    assert.equal(await chapterCards.count(), 5, 'Should render 5 chapter cards');

    const card0Text = await chapterCards.nth(0).innerText();
    const card1Text = await chapterCards.nth(1).innerText();
    const card2Text = await chapterCards.nth(2).innerText();
    const card3Text = await chapterCards.nth(3).innerText();
    const card4Text = await chapterCards.nth(4).innerText();

    assert.ok(card0Text.includes('已跳过'), `Copyright card should show 已跳过, got: ${card0Text}`);
    assert.ok(card1Text.includes('保持原文'), `Media card should show 保持原文, got: ${card1Text}`);
    assert.ok(card2Text.includes('未翻译'), `Ch1 card should show 未翻译, got: ${card2Text}`);
    assert.ok(card3Text.includes('未翻译'), `Ch2 card should show 未翻译, got: ${card3Text}`);
    assert.ok(card4Text.includes('系统注释源文件') && card4Text.includes('已锁定'), `Notes card should be locked footnote source, got: ${card4Text}`);

    // Toggle Ch2 (index 3) to 保持原文
    await chapterCards.nth(3).locator('button[title="保持原文（不翻译）"]').click({ force: true });
    await page.waitForTimeout(200);
    const card3AfterRef = await chapterCards.nth(3).innerText();
    assert.ok(card3AfterRef.includes('保持原文'), `Ch2 should now show 保持原文, got: ${card3AfterRef}`);
    assert.equal(await chapterCards.nth(3).locator('button[title="恢复翻译"]').count(), 1, 'Ch2 button title should flip to 恢复翻译');

    // Toggle Ch1 (index 2) to 跳过此章节
    await chapterCards.nth(2).locator('button[title="跳过此章节"]').click({ force: true });
    await page.waitForTimeout(200);
    const card2AfterSkip = await chapterCards.nth(2).innerText();
    assert.ok(card2AfterSkip.includes('已跳过'), `Ch1 should now show 已跳过, got: ${card2AfterSkip}`);

    // Now all 5 chapters are non-translatable -> footer counter should show 5/5 章
    const footerCounter = page.locator('span', { hasText: /\/5 章 · 术语/ });
    const footerText1 = await footerCounter.innerText();
    assert.ok(footerText1.includes('5/5 章'), `Footer should show 5/5 章 when all 5 are skipped/reference/fnSource, got: ${footerText1}`);

    // Toggle 智能跳页 (smartSkip) OFF in SettingsPanel
    const smartSkipLabel = page.locator('label[title="自动识别并跳过扉页、版权页、目录等"]');
    await smartSkipLabel.click();
    await page.waitForTimeout(300);

    // Local-rule Copyright (0) and Media (1) should revert to 未翻译,
    // while user_override Ch1 (2) remains 已跳过 and Ch2 (3) remains 保持原文!
    const card0AfterOff = await chapterCards.nth(0).innerText();
    const card1AfterOff = await chapterCards.nth(1).innerText();
    const card2AfterOff = await chapterCards.nth(2).innerText();
    const card3AfterOff = await chapterCards.nth(3).innerText();

    assert.ok(card0AfterOff.includes('未翻译'), `Local-rule copyright should revert to 未翻译 when smartSkip=false, got: ${card0AfterOff}`);
    assert.ok(card1AfterOff.includes('未翻译'), `Local-rule media should revert to 未翻译 when smartSkip=false, got: ${card1AfterOff}`);
    assert.ok(card2AfterOff.includes('已跳过'), `User-override Ch1 must stay 已跳过 when smartSkip=false, got: ${card2AfterOff}`);
    assert.ok(card3AfterOff.includes('保持原文'), `User-override Ch2 must stay 保持原文 when smartSkip=false, got: ${card3AfterOff}`);

    // Footer counter should now show 3/5 章 (Ch1 skipped + Ch2 reference + Notes fnSource)
    const footerText2 = await footerCounter.innerText();
    assert.ok(footerText2.includes('3/5 章'), `Footer should show 3/5 章 when smartSkip=false, got: ${footerText2}`);

    assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
    console.log('[PASS] ALL_SKIP_AND_REFERENCE_UI_E2E_VERIFICATIONS_SUCCESSFUL');
  } finally {
    if (browser) await browser.close();
    if (viteProc.pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /pid ${viteProc.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // ignore if already exited
        }
      } else {
        viteProc.kill('SIGTERM');
      }
    }
    if (fs.existsSync(tmpEpub)) fs.unlinkSync(tmpEpub);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
