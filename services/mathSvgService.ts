import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { MathML } from 'mathjax-full/js/input/mathml.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

let initialized = false;
let adaptor: ReturnType<typeof liteAdaptor> | null = null;
let texDoc: ReturnType<typeof mathjax.document> | null = null;
let mmlDoc: ReturnType<typeof mathjax.document> | null = null;

function ensureMathJaxInitialized(): void {
  if (initialized) return;
  adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const svgJax = new SVG({ fontCache: 'none' });
  texDoc = mathjax.document('', {
    InputJax: new TeX({ packages: AllPackages }),
    OutputJax: svgJax
  });
  mmlDoc = mathjax.document('', {
    InputJax: new MathML(),
    OutputJax: new SVG({ fontCache: 'none' })
  });
  initialized = true;
}

/**
 * Normalizes MathJax <mjx-container> output into a clean, EPUB3-XHTML-valid <svg>
 * (wrapped in <span class="translit-math-block"> when display=true) using `currentColor`
 * and `ex` units so it scales with reader font size and adapts to dark/sepia themes.
 */
function extractCleanMathSvg(containerHtml: string, display: boolean): string {
  const svgMatch = containerHtml.match(/<svg\b[\s\S]*?<\/svg>/i);
  if (!svgMatch) return '';

  let svg = svgMatch[0]
    .replace(/\brole=["']img["']\s*/gi, '')
    .replace(/\bfocusable=["']false["']\s*/gi, '')
    .replace(/\bxmlns:xlink=/gi, 'xmlns:xlink=');

  if (!/\bxmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(svg)) {
    svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const roleClass = display ? 'translit-math-svg translit-math-svg-block' : 'translit-math-svg translit-math-svg-inline';
  if (/\bclass=["']([^"']*)["']/i.test(svg)) {
    svg = svg.replace(/\bclass=["']([^"']*)["']/i, (_m, existing) => `class="${existing} ${roleClass}"`);
  } else {
    svg = svg.replace(/^<svg\b/i, `<svg class="${roleClass}"`);
  }

  // Ensure XHTML self-closing / valid XML attributes (MathJax liteAdaptor already emits valid XML,
  // but normalize any stray HTML entities if present).
  svg = svg.replace(/&nbsp;/g, '&#160;');

  if (display) {
    return `<span class="translit-math-block">${svg}</span>`;
  }
  return svg;
}

/**
 * Renders a LaTeX math expression into a self-contained inline or block SVG string.
 */
export function renderLatexToSvg(tex: string, display: boolean): string {
  const trimmed = (tex || '').trim();
  if (!trimmed) return '';
  try {
    ensureMathJaxInitialized();
    const node = texDoc!.convert(trimmed, { display });
    const html = adaptor!.innerHTML(node);
    const cleaned = extractCleanMathSvg(html, display);
    return cleaned || (display ? `$$${trimmed}$$` : `$${trimmed}$`);
  } catch (e) {
    console.warn('MathJax TeX->SVG render error:', e);
    return display ? `$$${trimmed}$$` : `$${trimmed}$`;
  }
}

/**
 * Renders a MathML `<math>...</math>` string into a self-contained inline or block SVG string.
 */
export function renderMathMlToSvg(mathMl: string, displayOverride?: boolean): string {
  const raw = (mathMl || '').trim();
  if (!raw) return '';
  try {
    ensureMathJaxInitialized();
    const isBlock =
      displayOverride !== undefined
        ? displayOverride
        : /\bdisplay\s*=\s*["']block["']/i.test(raw);

    // Strip any <annotation> / <annotation-xml> siblings inside <semantics> if needed, or let MathJax MathML handle it
    const node = mmlDoc!.convert(raw, { display: isBlock });
    const html = adaptor!.innerHTML(node);
    const cleaned = extractCleanMathSvg(html, isBlock);
    return cleaned || raw;
  } catch (e) {
    console.warn('MathJax MathML->SVG render error:', e);
    return raw;
  }
}

function stampMathBlockContainers(xhtml: string): string {
  if (!xhtml || !xhtml.includes('translit-math-block')) return xhtml;
  return xhtml.replace(
    /<(p|div)\b([^>]*)>\s*(<span class="translit-math-block">[\s\S]*?<\/span>)\s*<\/\1>/gi,
    (_m, tagName: string, attrs: string, span: string) => {
      const updatedAttrs = /\bdata-translit-role=/i.test(attrs)
        ? attrs.replace(/\bdata-translit-role=["'][^"']*["']/gi, 'data-translit-role="math-block"')
        : `${attrs} data-translit-role="math-block"`;
      return `<${tagName}${updatedAttrs}>${span}</${tagName}>`;
    }
  );
}

/**
 * Converts any remaining `<math>...</math>` elements inside an XHTML chapter into
 * self-contained EPUB3-compatible `<svg>` elements, and stamps `data-translit-role="math-block"`
 * on `<p>`/`<div>` containers that hold only a block math formula.
 */
export function convertMathElementsInXhtmlToSvg(xhtml: string): string {
  if (!xhtml || !/<(?:[a-z0-9_-]+:)?math\b/i.test(xhtml)) {
    return stampMathBlockContainers(xhtml);
  }

  const updated = xhtml.replace(
    /<(?:([a-z0-9_-]+):)?math\b([^>]*)>([\s\S]*?)<\/(?:\1:)?math>/gi,
    (fullMatch, prefix: string | undefined, attrs: string, inner: string) => {
      const normalizedMath = prefix
        ? `<math${attrs}>${inner.replace(new RegExp(`<(/?)${prefix}:`, 'gi'), '<$1')}</math>`
        : fullMatch;
      const isBlock = /\bdisplay\s*=\s*["']block["']/i.test(attrs);
      return renderMathMlToSvg(normalizedMath, isBlock);
    }
  );

  return stampMathBlockContainers(updated);
}

/**
 * Converts LaTeX `$...$` and `$$...$$` expressions in plain/HTML text segments to SVG
 * while protecting HTML tags, entities, URLs, code blocks, and currency like `$10 and $20`.
 */
export function convertLatexInTextToSvg(htmlOrText: string): string {
  if (!htmlOrText || !htmlOrText.includes('$')) return htmlOrText;

  // Protect <code>, <pre>, <svg>, <script>, <style>, and existing tags
  const tokenRegex = /(<(?:code|pre|svg|script|style)\b[^>]*>[\s\S]*?<\/(?:code|pre|svg|script|style)>|<[^>]+>)/gi;
  const parts = htmlOrText.split(tokenRegex);

  for (let i = 0; i < parts.length; i += 2) {
    let seg = parts[i];
    if (!seg || !seg.includes('$')) continue;

    // 1. Block math $$...$$
    seg = seg.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
      return renderLatexToSvg(tex, true);
    });

    // 2. Inline math $...$ with currency guard (no leading/trailing space, not followed by digit)
    seg = seg.replace(/\$(?!\s)([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_m, tex: string) => {
      return renderLatexToSvg(tex, false);
    });

    parts[i] = seg;
  }

  return parts.join('');
}
