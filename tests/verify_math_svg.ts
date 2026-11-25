import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { EpubService, buildAdaptiveChineseTypographyCss } from '../services/epubService';
import { parseXmlDocument } from '../utils/domAdapter';
import {
  renderLatexToSvg,
  renderMathMlToSvg,
  convertLatexInTextToSvg,
  convertMathElementsInXhtmlToSvg
} from '../services/mathSvgService';

async function main() {
  console.log('--- Running MathJax SVG EPUB End-to-End Verification ---');

  // 1. Unit tests: LaTeX -> SVG (inline & block)
  const inlineSvg = renderLatexToSvg('E = mc^2', false);
  assert.ok(inlineSvg.includes('<svg'), 'Inline LaTeX must render <svg>');
  assert.ok(inlineSvg.includes('translit-math-svg-inline'), 'Inline SVG must carry inline class');
  assert.ok(inlineSvg.includes('currentColor'), 'SVG must use currentColor for reader theme adaptation');
  assert.ok(/vertical-align:\s*-?[\d.]+ex/.test(inlineSvg), 'Inline SVG must include ex baseline alignment');
  assert.ok(!inlineSvg.includes('translit-math-block'), 'Inline SVG must not be wrapped in block span');

  const blockSvg = renderLatexToSvg('\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', true);
  assert.ok(blockSvg.startsWith('<span class="translit-math-block"><svg'), 'Block LaTeX must be wrapped in .translit-math-block');
  assert.ok(blockSvg.includes('translit-math-svg-block'), 'Block SVG must carry block class');

  // 2. Unit tests: MathML -> SVG
  const mmlInline = renderMathMlToSvg(
    '<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup><mo>=</mo><msup><mi>c</mi><mn>2</mn></msup></math>'
  );
  assert.ok(mmlInline.includes('<svg') && mmlInline.includes('translit-math-svg-inline'), 'Inline MathML must render inline SVG');

  const mmlBlock = renderMathMlToSvg(
    '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mfrac><mrow><mo>-</mo><mi>b</mi></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></math>'
  );
  assert.ok(mmlBlock.includes('translit-math-block') && mmlBlock.includes('translit-math-svg-block'), 'Block MathML must render block SVG');

  // 3. Currency guard in convertLatexInTextToSvg
  const mixedText = '门票价格为 $10 和 $20，但质能方程是 $E = mc^2$。';
  const convertedMixed = convertLatexInTextToSvg(mixedText);
  assert.ok(convertedMixed.includes('$10 和 $20'), 'Currency must remain untouched');
  assert.ok(convertedMixed.includes('<svg') && !convertedMixed.includes('$E = mc^2$'), 'Inline LaTeX must become SVG');

  // 4. XHTML <math> replacement + math-block role stamping
  const rawXhtml = `<?xml version="1.0" encoding="utf-8"?>
  <html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <p>行内公式：<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>α</mi><mo>+</mo><mi>β</mi></math>。</p>
    <p><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mfrac><mn>1</mn><mn>2</mn></mfrac></math></p>
  </body>
  </html>`;
  const convertedXhtml = convertMathElementsInXhtmlToSvg(rawXhtml);
  assert.ok(!/<math\b/i.test(convertedXhtml), 'All <math> elements must be converted to SVG');
  assert.ok(convertedXhtml.includes('data-translit-role="math-block"'), 'Single block-math <p> must receive data-translit-role="math-block"');
  assert.equal(parseXmlDocument(convertedXhtml).getElementsByTagName('parsererror').length, 0, 'Converted XHTML must be valid XML');

  // 5. CSS rules check
  const css = buildAdaptiveChineseTypographyCss();
  assert.ok(css.includes('svg:not(.translit-math-svg)'), 'Global svg rule must exclude .translit-math-svg');
  assert.ok(css.includes('.translit-math-block'), 'CSS must include .translit-math-block');
  assert.ok(css.includes('[data-translit-role="math-block"]'), 'CSS must include [data-translit-role="math-block"]');

  // 6. Full EPUB round-trip with a math-heavy EPUB3 book (both MathML and LaTeX)
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
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
    <dc:identifier id="uid">math-svg-test</dc:identifier>
    <dc:title>Physics &amp; Math Sample</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`
  );
  zip.file(
    'OEBPS/text/ch1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Relativity and Calculus</h1>
  <p>Einstein showed that <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>, while tickets cost $10 and $20.</p>
  <p><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><msubsup><mo>∫</mo><mn>0</mn><mo>∞</mo></msubsup><msup><mi>e</mi><mrow><mo>-</mo><msup><mi>x</mi><mn>2</mn></msup></mrow></msup><mi>d</mi><mi>x</mi><mo>=</mo><mfrac><msqrt><mi>π</mi></msqrt><mn>2</mn></mfrac></math></p>
</body>
</html>`
  );

  const epubBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  const epubService = new EpubService();
  const parsed = await epubService.parseEpub(epubBuffer as any);
  assert.equal(parsed.chapters.length, 1);

  // Simulate translated markdown containing both inline and block LaTeX
  parsed.chapters[0].translatedMarkdown = [
    '# 相对论与微积分',
    '爱因斯坦证明了质能方程 $E = mc^2$，而门票只要 $10 和 $20。',
    '$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$'
  ].join('\n\n');

  const origZip = await JSZip.loadAsync(epubBuffer);
  const outBlob = await epubService.generateEpub(
    parsed.chapters,
    origZip,
    parsed.opfPath,
    parsed.opfDir,
    parsed.cssFiles,
    'Physics & Math Sample',
    'Chinese'
  );
  const outBuf = await outBlob.arrayBuffer();
  const outZip = await JSZip.loadAsync(outBuf);
  const outCh1 = await outZip.file('OEBPS/text/ch1.xhtml')!.async('string');

  assert.ok(!/<math\b/i.test(outCh1), 'Exported EPUB chapter must have zero <math> tags remaining');
  assert.ok(outCh1.includes('translit-math-svg-inline'), 'Exported EPUB chapter must contain inline math SVG');
  assert.ok(outCh1.includes('translit-math-svg-block'), 'Exported EPUB chapter must contain block math SVG');
  assert.ok(outCh1.includes('data-translit-role="math-block"'), 'Exported EPUB chapter must stamp math-block on block formula <p>');
  assert.ok(outCh1.includes('$10') && outCh1.includes('$20'), 'Exported EPUB chapter must preserve currency $10 and $20');
  assert.equal(parseXmlDocument(outCh1).getElementsByTagName('parsererror').length, 0, 'Exported EPUB chapter must have 0 XML parsererrors');

  console.log('ALL MATH SVG TESTS PASSED!');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
