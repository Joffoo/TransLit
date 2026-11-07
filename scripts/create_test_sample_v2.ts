import fs from 'fs';
import JSZip from 'jszip';

async function createSampleEpub() {
  const zip = new JSZip();

  // 1. mimetype (must be uncompressed STORE)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // 2. META-INF/container.xml
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  // 3. OEBPS/content.opf
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>TransLit Footnote Test Sample v2</dc:title>
    <dc:creator>TransLit Verification Suite</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:translit-footnote-sample-v2-test</dc:identifier>
    <meta property="dcterms:modified">2026-11-07T12:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="Styles/style.css" media-type="text/css"/>
    <item id="ch01" href="Text/ch01.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch02" href="Text/ch02.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch03" href="Text/ch03.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch01"/>
    <itemref idref="ch02"/>
    <itemref idref="ch03"/>
    <itemref idref="notes"/>
  </spine>
</package>`
  );

  // 4. OEBPS/toc.ncx
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:translit-footnote-sample-v2-test"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>TransLit Footnote Test Sample v2</text></docTitle>
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>Chapter 1: The Power of Perspective</text></navLabel>
      <content src="Text/ch01.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-2" playOrder="2">
      <navLabel><text>Chapter 2: The Annual Review Habit</text></navLabel>
      <content src="Text/ch02.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-3" playOrder="3">
      <navLabel><text>Chapter 3: Taking Action</text></navLabel>
      <content src="Text/ch03.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-4" playOrder="4">
      <navLabel><text>Notes</text></navLabel>
      <content src="Text/notes.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
  );

  // 5. CSS
  zip.file(
    'OEBPS/Styles/style.css',
    `body { font-family: sans-serif; line-height: 1.6; margin: 1.5em; }
h1, h2 { color: #2c3e50; }
p { margin-bottom: 1em; }
.noteref { font-size: 0.8em; vertical-align: super; text-decoration: none; }`
  );

  // 6. Chapter 1 (Contains 1 cross-file footnote to notes.xhtml#fn1)
  zip.file(
    'OEBPS/Text/ch01.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Chapter 1: The Power of Perspective</title>
  <link rel="stylesheet" type="text/css" href="../Styles/style.css"/>
</head>
<body>
  <h1>Chapter 1: The Power of Perspective</h1>
  <p>Most people move through life focused solely on the immediate challenges right in front of them. When we step back and zoom out, the trajectory of our entire year comes into vivid clarity<a id="ref-1" href="notes.xhtml#fn1" epub:type="noteref" class="noteref">[1]</a>.</p>
  <p>Perspective is not just a passive lens; it is an active practice that shapes our daily priorities and emotional well-being.</p>
</body>
</html>`
  );

  // 7. Chapter 2 (Contains 3 cross-file footnotes in ONE chunk to test multi-footnote chunking: #fn2, #fn3, #fn4)
  zip.file(
    'OEBPS/Text/ch02.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Chapter 2: The Annual Review Habit</title>
  <link rel="stylesheet" type="text/css" href="../Styles/style.css"/>
</head>
<body>
  <h1>Chapter 2: The Annual Review Habit</h1>
  <p>Establishing an annual reflection ritual creates a psychological clean slate known as the Fresh Start Effect<a id="ref-2" href="notes.xhtml#fn2" epub:type="noteref" class="noteref">[1]</a>. It allows us to consign past mistakes to a previous chapter of our lives.</p>
  <p>Rather than cramming your review into a single grueling day, many practitioners prefer spreading the process over several relaxed weeks<a id="ref-3" href="notes.xhtml#fn3" epub:type="noteref" class="noteref">[2]</a>.</p>
  <p>In fact, recent surveys reveal that over two-thirds of first-time reviewers had never conducted a structured review before<a id="ref-4" href="notes.xhtml#fn4" epub:type="noteref" class="noteref">[3]</a>, yet produced remarkable breakthroughs.</p>
</body>
</html>`
  );

  // 8. Chapter 3 (Contains 2 footnotes: 1 descriptive + 1 citation link: #fn5, #fn6)
  zip.file(
    'OEBPS/Text/ch03.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Chapter 3: Taking Action</title>
  <link rel="stylesheet" type="text/css" href="../Styles/style.css"/>
</head>
<body>
  <h1>Chapter 3: Taking Action</h1>
  <p>Accountability and companionship make the review journey far more enjoyable and sustainable<a id="ref-5" href="notes.xhtml#fn5" epub:type="noteref" class="noteref">[1]</a>.</p>
  <p>For more concrete examples and companion tools, explore our online repository<a id="ref-6" href="notes.xhtml#fn6" epub:type="noteref" class="noteref">[2]</a> to jumpstart your next cycle.</p>
</body>
</html>`
  );

  // 9. notes.xhtml (Standalone footnote source with 6 footnotes)
  zip.file(
    'OEBPS/Text/notes.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Notes</title>
  <link rel="stylesheet" type="text/css" href="../Styles/style.css"/>
</head>
<body>
  <h1>Notes</h1>
  <div class="footnotes">
    <p id="fn1"><a href="ch01.xhtml#ref-1">1.</a> By analogy to peak resource extraction, human attention has definitive limits that demand periodic replenishment.</p>
    
    <p id="fn2"><a href="ch02.xhtml#ref-2">2.</a> Research by psychologist John C. Norcross indicates that setting formal resolutions at temporal landmarks increases success rates tenfold compared to informal desires.</p>
    
    <p id="fn3"><a href="ch02.xhtml#ref-3">3.</a> Lauren Forte observes that shifting the review period around the Lunar New Year provides greater psychological distance from holiday stress.</p>
    
    <p id="fn4"><a href="ch02.xhtml#ref-4">4.</a> In a comprehensive survey of over 500 students, 69 percent had never maintained a regular year-end reflection practice.</p>
    
    <p id="fn5"><a href="ch03.xhtml#ref-5">5.</a> Community review groups show an 82 percent higher completion rate when paired with an accountability partner.</p>
    
    <p id="fn6"><a href="ch03.xhtml#ref-6">6.</a> See the Annual Review Toolkit at https://lifeinperspective.com/toolkit for free downloadable templates and audio guides.</p>
  </div>
</body>
</html>`
  );

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  const targetFile = 'sample_footnote_test_v2.epub';
  fs.writeFileSync(targetFile, buffer);
  console.log(`Created test sample EPUB: ${targetFile} (${buffer.length} bytes)`);
}

createSampleEpub().catch(console.error);
