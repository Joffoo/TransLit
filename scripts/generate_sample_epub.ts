import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';

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

  // 3. OEBPS/content.opf (Intentionally EPUB 2.0 to test 3.0 auto-upgrade)
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>TransLit Test: The Pale King Sample</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:translit-test-sample-001</dc:identifier>
    <dc:creator>David Foster Wallace</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="Styles/styles.css" media-type="text/css"/>
    <item id="cip" href="Text/copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="foreword" href="Text/foreword.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="Text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cip"/>
    <itemref idref="foreword"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="notes"/>
  </spine>
</package>`
  );

  // 4. OEBPS/toc.ncx
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>Copyright</text></navLabel>
      <content src="Text/copyright.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-2" playOrder="2">
      <navLabel><text>Author's Foreword</text></navLabel>
      <content src="Text/foreword.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-3" playOrder="3">
      <navLabel><text>Chapter 1: The REC Center</text></navLabel>
      <content src="Text/chapter1.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-4" playOrder="4">
      <navLabel><text>Chapter 2: Examination Shift</text></navLabel>
      <content src="Text/chapter2.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-5" playOrder="5">
      <navLabel><text>Endnotes</text></navLabel>
      <content src="Text/notes.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
  );

  // 5. CSS
  zip.file('OEBPS/Styles/styles.css', 'body { font-family: Georgia, serif; line-height: 1.6; margin: 5%; }');

  // 6. Test File 1: Copyright / CIP (Should be auto-classified as skip)
  zip.file(
    'OEBPS/Text/copyright.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Copyright</title></head>
<body>
  <h2>Copyright Information</h2>
  <p>Copyright © 2011 by David Foster Wallace. All rights reserved.</p>
  <p>First Edition: April 2011</p>
  <p>ISBN 978-0-316-07423-0</p>
  <p>Library of Congress Cataloging-in-Publication Data</p>
</body>
</html>`
  );

  // 7. Test File 2: Foreword (Ambiguous page testing stage 2)
  zip.file(
    'OEBPS/Text/foreword.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Author's Foreword</title></head>
<body>
  <h1>Author's Foreword</h1>
  <p>The manuscript that follows is essentially non-fictional, assembled from various administrative records and personal accounts collected during the late 1980s.</p>
</body>
</html>`
  );

  // 8. Test File 3: Chapter 1 (Cross-file footnote refs: fn1, fn2, and repeated fn1)
  zip.file(
    'OEBPS/Text/chapter1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1: The REC Center</h1>
  <p>Pastures of flattened rye and wild oats stretched toward the horizon. Claude Sylvanshine arrived at the Peoria Regional Examination Center<a href="notes.xhtml#fn1">[1]</a> on a chilly Tuesday morning.</p>
  <p>Inside the examination hall, rows of clerks were reviewing standard 1040 deductions under the strict provisions of the federal tax manual<a href="notes.xhtml#fn2">[2]</a>.</p>
  <p>He remembered that this same Peoria facility<a href="notes.xhtml#fn1">[1]</a> had been designed specifically to process high-volume Midwest filings.</p>
</body>
</html>`
  );

  // 9. Test File 4: Chapter 2 (Re-referencing fn1 to test global pool cache deduplication)
  zip.file(
    'OEBPS/Text/chapter2.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
  <h1>Chapter 2: Examination Shift</h1>
  <p>By late afternoon, Leonard Stecyk had also reported for duty at the very same Peoria REC<a href="notes.xhtml#fn1">[1]</a>.</p>
  <p>The fluorescent lamps hummed quietly across the floor as audit folders were opened in unison.</p>
</body>
</html>`
  );

  // 10. Test File 5: Notes.xhtml (Standalone footnote source with multi-paragraph sibling notes)
  zip.file(
    'OEBPS/Text/notes.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Notes</title></head>
<body>
  <h1 id="notes-heading">Notes</h1>
  <div class="footnotes">
    <p id="fn1"><a href="chapter1.xhtml#ref1">1.</a> The Peoria REC (Regional Examination Center) was established in 1965 at 047 Industry Way.</p>
    <p>During peak filing seasons, the facility employed over eight hundred rote examiners and support personnel.</p>
    <p>For additional background, see Midwest Regional Archive Record Group 42, Boxes 11–14.</p>
    <p id="fn2"><a href="chapter1.xhtml#ref2">2.</a> Internal Revenue Manual § 4.10.2, revised November 1981, covering itemized adjustments and miscellaneous casualty losses.</p>
  </div>
</body>
</html>`
  );

  const outputPath = path.resolve(process.cwd(), 'sample_footnote_test.epub');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(outputPath, buffer);
  console.log(`[SUCCESS] Sample EPUB created at: ${outputPath}`);
}

createSampleEpub().catch(console.error);
