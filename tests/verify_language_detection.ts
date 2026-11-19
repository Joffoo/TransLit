import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { detectBookLanguage } from '../services/languageDetectionService.ts';
import { EpubService } from '../services/epubService.ts';

async function buildMinimalEpub(dcLanguage: string, xhtmlBody: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
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
    <dc:identifier id="uid">test-id</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:language>${dcLanguage}</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`
  );
  zip.file(
    'OEBPS/ch1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter 1</title></head>
  <body>${xhtmlBody}</body>
</html>`
  );
  return zip.generateAsync({ type: 'uint8array' });
}

async function runTests() {
  // Slice 1: Detects Japanese text from chapter markdown
  {
    const res = detectBookLanguage([
      {
        originalMarkdown:
          '# 第一章\n\n吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。',
      },
    ]);
    assert.deepEqual(res, { language: 'Japanese', source: 'text' });
  }

  // Slice 2: Detects extended languages (Dutch, French) even when OPF metadata is wrong
  {
    const dutchRes = detectBookLanguage(
      [
        {
          originalMarkdown:
            '[[NOTE_1]] Het was een koude en heldere dag in april, en de klokken sloegen dertien. Winston Smith, met zijn kin op zijn borst gedrukt om aan de guurheid te ontsnappen.',
        },
      ],
      'en'
    );
    assert.deepEqual(dutchRes, { language: 'Dutch', source: 'text' });

    const frenchRes = detectBookLanguage(
      [
        {
          originalMarkdown:
            'Longtemps, je me suis couché de bonne heure. Parfois, à peine ma bougie éteinte, mes yeux se fermaient si vite que je n’avais pas le temps de me dire.',
        },
      ],
      'en-US'
    );
    assert.deepEqual(frenchRes, { language: 'French', source: 'text' });
  }

  // Slice 3: Falls back to normalized <dc:language> when text is too short / image-only, then 'English'
  {
    const metaFallback = detectBookLanguage(
      [{ originalMarkdown: '![cover](cover.jpg)' }],
      'de-DE'
    );
    assert.deepEqual(metaFallback, { language: 'German', source: 'metadata' });

    const defaultFallback = detectBookLanguage(
      [{ originalMarkdown: '' }],
      'und'
    );
    assert.deepEqual(defaultFallback, { language: 'English', source: 'fallback' });

    // Regression: footnote slots inside short Japanese text must be stripped cleanly without skewing toward English
    const jpWithSlots = detectBookLanguage(
      [{ originalMarkdown: '東京の街__FN_REF_1-1__を歩く{{TRANSLITFNSLOT:2-1}}。これは日本語の文章__FN_REF_3-2__であり、翻訳テスト__FN_REF_4-1__です{{TRANSLITFNSLOT:5-1}}。' }],
      'en'
    );
    assert.deepEqual(jpWithSlots, { language: 'Japanese', source: 'text' });
  }

  // Seam 2: parseEpub extracts <dc:language> and detects language from EPUB archive
  {
    const epubService = new EpubService();

    // Text detection overrides mismatched <dc:language>
    const frenchBytes = await buildMinimalEpub(
      'en',
      '<p>Longtemps, je me suis couché de bonne heure. Parfois, à peine ma bougie éteinte, mes yeux se fermaient si vite que je n’avais pas le temps de me dire.</p>'
    );
    const frenchParsed = await epubService.parseEpub(frenchBytes);
    assert.equal(frenchParsed.detectedLanguage, 'French');
    assert.equal(frenchParsed.detectedLanguageSource, 'text');

    // Image-only chapter falls back to <dc:language>
    const koreanBytes = await buildMinimalEpub('ko-KR', '<p><img src="page1.png" alt=""/></p>');
    const koreanParsed = await epubService.parseEpub(koreanBytes);
    assert.equal(koreanParsed.detectedLanguage, 'Korean');
    assert.equal(koreanParsed.detectedLanguageSource, 'metadata');
  }

  console.log('All language detection tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
