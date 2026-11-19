import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { EpubService } from '../services/epubService';
import { PageClassifier } from '../services/pageClassifier';
import {
  isFootnoteSourceChapter,
  isChapterEffectivelySkippable,
  isChapterEffectivelyReference,
  isChapterNonTranslatable
} from '../utils/chapterUtils';
import { Chapter } from '../types';

function makeChapter(overrides: Partial<Chapter>): Chapter {
  return {
    id: 'ch-1',
    index: 0,
    fileName: 'Text/ch1.xhtml',
    title: 'Chapter 1',
    content: '<html><body><p>Hello world.</p></body></html>',
    markdown: 'Hello world.',
    slottedMarkdown: 'Hello world.',
    ...overrides
  };
}

async function runTests() {
  console.log('--- 1. Testing chapterUtils (smartSkip & user_override & footnoteSource) ---');

  const localSkip = makeChapter({
    isSkippable: true,
    isReference: false,
    classification: {
      category: 'copyright',
      disposition: 'skip',
      reason: 'Copyright',
      stage: 'local_rule',
      confidence: 0.97
    }
  });
  assert.equal(isChapterEffectivelySkippable(localSkip, true), true);
  assert.equal(isChapterEffectivelySkippable(localSkip, false), false);
  assert.equal(isChapterEffectivelyReference(localSkip, true), false);
  assert.equal(isChapterNonTranslatable(localSkip, true), true);
  assert.equal(isChapterNonTranslatable(localSkip, false), false);

  const userSkip = makeChapter({
    isSkippable: true,
    isReference: false,
    classification: {
      category: 'content',
      disposition: 'skip',
      reason: 'User override',
      stage: 'user_override',
      confidence: 1
    }
  });
  assert.equal(isChapterEffectivelySkippable(userSkip, true), true);
  assert.equal(isChapterEffectivelySkippable(userSkip, false), true, 'user_override skip must apply even when smartSkip=false');
  assert.equal(isChapterNonTranslatable(userSkip, false), true);

  const localRef = makeChapter({
    isSkippable: false,
    isReference: true,
    classification: {
      category: 'media_only',
      disposition: 'keep_original',
      reason: 'Media only',
      stage: 'local_rule',
      confidence: 0.99
    }
  });
  assert.equal(isChapterEffectivelyReference(localRef, true), true);
  assert.equal(isChapterEffectivelyReference(localRef, false), false);
  assert.equal(isChapterNonTranslatable(localRef, true), true);
  assert.equal(isChapterNonTranslatable(localRef, false), false);

  const userRef = makeChapter({
    isSkippable: false,
    isReference: true,
    classification: {
      category: 'content',
      disposition: 'keep_original',
      reason: 'User override',
      stage: 'user_override',
      confidence: 1
    }
  });
  assert.equal(isChapterEffectivelyReference(userRef, true), true);
  assert.equal(isChapterEffectivelyReference(userRef, false), true, 'user_override keep_original must apply even when smartSkip=false');
  assert.equal(isChapterNonTranslatable(userRef, false), true);

  const fnSource = makeChapter({
    isFootnoteSource: true,
    isSkippable: true, // Even if polluted
    isReference: true,
    classification: {
      category: 'footnote_source',
      disposition: 'system_footnote_source',
      reason: 'Notes',
      stage: 'local_rule',
      confidence: 1,
      isSystemProtected: true
    }
  });
  assert.equal(isFootnoteSourceChapter(fnSource), true);
  assert.equal(isChapterEffectivelySkippable(fnSource, true), false, 'Footnote source must never be skippable');
  assert.equal(isChapterEffectivelyReference(fnSource, true), false, 'Footnote source is system protected, not reference');
  assert.equal(isChapterNonTranslatable(fnSource, true), true);
  assert.equal(isChapterNonTranslatable(fnSource, false), true);

  console.log('  [OK] chapterUtils passed');

  console.log('--- 2. Testing PageClassifier Stage 2 user_override protection ---');
  const classifier = new PageClassifier();
  const ambiguousCh = makeChapter({
    id: 'preface',
    fileName: 'Text/preface.xhtml',
    title: 'Preface',
    content: '<html><body><h1>Preface</h1><p>Short preface text.</p></body></html>',
    classification: {
      category: 'ambiguous',
      disposition: 'translate',
      reason: 'Transition page',
      stage: 'local_rule',
      confidence: 0.55
    }
  });
  const overriddenCh = makeChapter({
    ...ambiguousCh,
    isReference: true,
    classification: {
      category: 'ambiguous',
      disposition: 'keep_original',
      reason: 'User set',
      stage: 'user_override',
      confidence: 1
    }
  });
  let aiCalledForOverridden = false;
  await classifier.classifyAmbiguousPagesAi([overriddenCh], async () => {
    aiCalledForOverridden = true;
    return { category: 'content', disposition: 'translate', reason: 'Should not run' };
  });
  assert.equal(aiCalledForOverridden, false, 'Stage 2 AI must not overwrite user_override');
  assert.equal(classifier.shouldTranslateChapterFootnotes(localRef, true), false);
  assert.equal(classifier.shouldTranslateChapterFootnotes(localRef, false), true, 'smartSkip=false should allow translating local_rule reference footnotes');
  assert.equal(classifier.shouldTranslateChapterFootnotes(userRef, false), false, 'user_override reference must keep footnotes untranslated even when smartSkip=false');
  console.log('  [OK] PageClassifier user_override & shouldTranslateChapterFootnotes passed');

  console.log('--- 3. Testing EpubService.generateEpub excludeFileNames & isReference ---');
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
    <dc:title>Test Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="copy" href="Text/copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="appcopy" href="Appendix/copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="refch" href="Text/ref.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="nav"/>
    <itemref idref="copy"/>
    <itemref idref="ch1"/>
    <itemref idref="refch"/>
    <itemref idref="appcopy"/>
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
    <navPoint id="np2" playOrder="2"><navLabel><text>Chapter 1</text></navLabel><content src="Text/ch1.xhtml"/></navPoint>
    <navPoint id="np3" playOrder="3"><navLabel><text>Reference</text></navLabel><content src="Text/ref.xhtml"/></navPoint>
    <navPoint id="np4" playOrder="4"><navLabel><text>Appendix Copyright</text></navLabel><content src="Appendix/copyright.xhtml"/></navPoint>
  </navMap>
</ncx>`
  );
  zip.file(
    'OEBPS/Text/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="copyright.xhtml">Copyright</a></li>
      <li><a href="ch1.xhtml">Chapter 1</a></li>
      <li><a href="ref.xhtml">Reference</a></li>
      <li><a href="../Appendix/copyright.xhtml">Appendix Copyright</a></li>
    </ol>
  </nav>
</body>
</html>`
  );
  const copyrightXhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Copyright 2025 All rights reserved.</p></body></html>`;
  const appCopyXhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Appendix Legal Note.</p></body></html>`;
  const ch1Xhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Original chapter one paragraph.</p></body></html>`;
  const refXhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Keep this reference text in English.<a href="notes.xhtml#fn1">1</a></p></body></html>`;
  const notesXhtml = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p id="fn1">Original English footnote 1.</p></body></html>`;

  zip.file('OEBPS/Text/copyright.xhtml', copyrightXhtml);
  zip.file('OEBPS/Appendix/copyright.xhtml', appCopyXhtml);
  zip.file('OEBPS/Text/ch1.xhtml', ch1Xhtml);
  zip.file('OEBPS/Text/ref.xhtml', refXhtml);
  zip.file('OEBPS/Text/notes.xhtml', notesXhtml);

  const epubService = new EpubService();
  const chapters: Chapter[] = [
    makeChapter({
      id: 'ch1',
      index: 1,
      fileName: 'Text/ch1.xhtml',
      title: 'Chapter 1',
      content: ch1Xhtml,
      markdown: 'Original chapter one paragraph.',
      slottedMarkdown: 'Original chapter one paragraph.',
      translatedMarkdown: '第一章原文段落译文。',
      isReference: false
    }),
    makeChapter({
      id: 'refch',
      index: 2,
      fileName: 'Text/ref.xhtml',
      title: 'Reference',
      content: refXhtml,
      markdown: 'Keep this reference text in English.[1](#fn-refch-1)',
      slottedMarkdown: 'Keep this reference text in English.[[__FN_REF_fn-refch-1__]]',
      translatedMarkdown: '不应该被使用的译文',
      internalizedFootnotes: {
        'fn-refch-1': {
          key: 'Text/notes.xhtml#fn1',
          sourceFile: 'Text/notes.xhtml',
          originalId: 'fn1',
          namespaceId: 'refch-1',
          label: '1',
          html: '<p>Original English footnote 1.</p>',
          plainText: 'Original English footnote 1.',
          paragraphs: ['Original English footnote 1.'],
          referencedByChapters: [2]
        }
      },
      translatedFootnotes: {
        'fn-refch-1': '不应该被使用的译文注释'
      },
      isReference: true
    }),
    makeChapter({
      id: 'appcopy',
      index: 3,
      fileName: 'Appendix/copyright.xhtml',
      title: 'Appendix Copyright',
      content: appCopyXhtml,
      markdown: 'Appendix Legal Note.',
      slottedMarkdown: 'Appendix Legal Note.',
      isReference: true
    }),
    makeChapter({
      id: 'notes',
      index: 4,
      fileName: 'Text/notes.xhtml',
      title: 'Notes',
      content: notesXhtml,
      markdown: '',
      isFootnoteSource: true,
      isSystemProtected: true
    })
  ];

  const outBlob = await epubService.generateEpub(
    chapters,
    zip,
    'OEBPS/content.opf',
    'OEBPS/',
    [],
    'Test Book',
    'Chinese',
    undefined,
    ['Text/copyright.xhtml', 'Text/notes.xhtml'], // notes.xhtml must be protected even if passed here
    'source_first',
    false
  );

  const outZip = await JSZip.loadAsync(await outBlob.arrayBuffer());
  assert.equal(outZip.file('OEBPS/Text/copyright.xhtml'), null, 'Excluded chapter must be removed from ZIP');
  assert.notEqual(outZip.file('OEBPS/Text/notes.xhtml'), null, 'Footnote source must NEVER be removed from ZIP');

  const outOpf = await outZip.file('OEBPS/content.opf')!.async('string');
  assert.equal(outOpf.includes('Text/copyright.xhtml'), false, 'Excluded chapter must be removed from OPF manifest');
  assert.equal(outOpf.includes('idref="copy"'), false, 'Excluded chapter must be removed from OPF spine');
  assert.equal(outOpf.includes('Appendix/copyright.xhtml'), true, 'Same-basename file in another dir must remain in OPF');

  const outNcx = await outZip.file('OEBPS/toc.ncx')!.async('string');
  assert.equal(outNcx.includes('Text/copyright.xhtml'), false, 'Excluded chapter must be removed from toc.ncx');
  assert.equal(outNcx.includes('Appendix/copyright.xhtml'), true, 'Same-basename file in another dir must remain in toc.ncx');

  const outNav = await outZip.file('OEBPS/Text/nav.xhtml')!.async('string');
  assert.equal(outNav.includes('href="copyright.xhtml"'), false, 'Excluded chapter must be removed from nav.xhtml');
  assert.equal(outNav.includes('../Appendix/copyright.xhtml'), true, 'Same-basename file in another dir must remain in nav.xhtml');

  const outRef = await outZip.file('OEBPS/Text/ref.xhtml')!.async('string');
  assert.equal(outRef.includes('Keep this reference text in English.'), true, 'Reference chapter must keep original text');
  assert.equal(outRef.includes('不应该被使用的译文'), false, 'Reference chapter must NOT include translation');
  assert.equal(outRef.includes('Original English footnote 1.'), true, 'Reference chapter with internalized footnotes must keep original footnote text');
  assert.equal(outRef.includes('不应该被使用的译文注释'), false, 'Reference chapter must NOT include stale translatedFootnotes');
  assert.equal(outRef.includes('epub:type="footnote"'), true, 'Reference chapter with internalized footnotes must emit EPUB3 popup aside');

  const outCh1 = await outZip.file('OEBPS/Text/ch1.xhtml')!.async('string');
  assert.equal(outCh1.includes('第一章原文段落译文。'), true, 'Normal chapter must be translated');

  console.log('  [OK] EpubService.generateEpub excludeFileNames & isReference passed');
  console.log('\n[PASS] ALL_SKIP_AND_REFERENCE_VERIFICATIONS_SUCCESSFUL');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
