import fs from 'fs';
import JSZip from 'jszip';

async function validateFullEpub() {
  const buf = fs.readFileSync('Life in Perspective - Tiago Forte【TransLit】.epub');
  const zip = await JSZip.loadAsync(buf);

  console.log('--- Validating all XHTML files in Life in Perspective 【TransLit】 ---');
  let untranslatedFootnotes = 0;
  for (const [filename, file] of Object.entries(zip.files)) {
    if (filename.endsWith('.xhtml') || filename.endsWith('.html')) {
      const text = await file.async('string');
      // check for aside footnotes
      const asides = text.match(/<aside[\s\S]*?<\/aside>/g) || [];
      for (const a of asides) {
        const idMatch = a.match(/id="([^"]+)"/);
        const id = idMatch ? idMatch[1] : 'unknown';
        const content = a.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const hasZh = /[\u4e00-\u9fa5]/.test(content);
        const isUrl = /https?:\/\//.test(content) && content.length < 80;
        if (!hasZh && !isUrl) {
          untranslatedFootnotes++;
          console.warn(`WARN: Footnote without Chinese in ${filename} (${id}): ${content}`);
        }
      }

      // Check for untranslated chapters (chapters that are in English)
      if (filename.includes('/ch') && !filename.includes('notes')) {
        const bodyContent = text.replace(/<aside[\s\S]*?<\/aside>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const zhCount = (bodyContent.match(/[\u4e00-\u9fa5]/g) || []).length;
        const totalCount = bodyContent.length;
        const ratio = totalCount > 0 ? (zhCount / totalCount).toFixed(2) : '0';
        console.log(`${filename}: zh chars=${zhCount} total chars=${totalCount} (zh ratio=${ratio})`);
      }
    }
  }
  console.log(`Validation complete. Untranslated non-URL footnotes: ${untranslatedFootnotes}`);
}

validateFullEpub().catch(console.error);
