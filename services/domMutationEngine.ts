import { BilingualMode, FootnoteNode } from '../types';
import { parseHtmlDocument } from '../utils/domAdapter';
import {
  createFootnoteSlot,
  extractFootnoteSlots,
  validateAndRepairSlots
} from './footnotePool';

export interface TranslatableDomBlock {
  index: number;
  tagName: string;
  className: string;
  id: string;
  isHeadingLike: boolean;
  slottedText: string;
  footnoteIds: string[];
  leadingAnchorHtmls: string[];
}

export interface DomExtractionResult {
  blocks: TranslatableDomBlock[];
  payloadText: string;
}

export interface CssClassProfile {
  className: string;
  fontSizeEm?: number;
  fontWeight?: 'bold' | 'normal';
  fontStyle?: 'italic' | 'normal';
  textAlign?: 'center' | 'right' | 'left' | 'justify';
  textIndentEm?: number;
  marginTopEm?: number;
  marginBottomEm?: number;
  marginLeftEm?: number;
  textTransform?: 'uppercase' | 'capitalize' | 'lowercase' | 'none';
  fontVariant?: 'small-caps' | 'normal';
  letterSpacingEm?: number;
  hasBorder?: boolean;
  displayNone?: boolean;
}

export interface ElementVisualStyle {
  fontSizeEm?: number;
  fontWeight?: 'bold' | 'normal';
  fontStyle?: 'italic' | 'normal';
  textAlign?: 'center' | 'right' | 'left' | 'justify';
  textIndentEm?: number;
  marginTopEm?: number;
  marginBottomEm?: number;
  marginLeftEm?: number;
  textTransform?: 'uppercase' | 'capitalize' | 'lowercase' | 'none';
  fontVariant?: 'small-caps' | 'normal';
  letterSpacingEm?: number;
  hasBorder?: boolean;
  displayNone?: boolean;
}

export interface DomMutationOptions {
  internalizedFootnotes?: Record<string, FootnoteNode>;
  translatedFootnotes?: Record<string, string>;
  sourcePayloadWithSlots?: string;
  bilingualMode?: BilingualMode;
  wereadMode?: boolean;
  imagesRelPath?: string;
  cssProfiles?: Map<string, CssClassProfile>;
  applyChineseTypography?: boolean;
  isStreaming?: boolean;
}

export interface StructuralTreeDiffResult {
  diffCount: number;
  diffs: string[];
}

const LEAF_CANDIDATE_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'TD',
  'TH',
  'DT',
  'DD',
  'FIGCAPTION',
  'BLOCKQUOTE',
  'PRE',
  'DIV'
]);

const BLOCK_LEVEL_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'DL',
  'DT',
  'DD',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'BLOCKQUOTE',
  'PRE',
  'DIV',
  'SECTION',
  'ARTICLE',
  'ASIDE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'NAV',
  'FIGURE',
  'FIGCAPTION',
  'HR'
]);

const EXCLUDED_PSEUDO_HEADING_CLASSES = /\b(caption|fig|figcaption|bib\d*|toc\d*|copyright|epigraph|dedication|footnote|noteref|quote)\b/i;

const INLINE_WRAPPER_TAGS = new Set([
  'SPAN',
  'A',
  'B',
  'STRONG',
  'I',
  'EM',
  'BIG',
  'SMALL',
  'FONT',
  'U'
]);

/**
 * Converts a CSS length or font-size keyword into an approximate em multiplier.
 */
export function parseCssLengthToEm(raw: string | undefined | null): number | undefined {
  if (!raw) return undefined;
  const val = raw.trim().toLowerCase().replace(/!important$/i, '').trim();
  if (!val || val === 'auto' || val === 'inherit' || val === 'initial' || val === 'unset' || val === 'normal') {
    return undefined;
  }
  if (val === '0' || /^0(?:\.0+)?(?:em|rem|px|pt|%|ex|ch|cm|mm|in)$/.test(val)) {
    return 0;
  }
  const keywordMap: Record<string, number> = {
    'xx-large': 1.6,
    'x-large': 1.35,
    'large': 1.18,
    'larger': 1.2,
    'medium': 1.0,
    'small': 0.88,
    'x-small': 0.78,
    'xx-small': 0.68,
    'smaller': 0.85
  };
  if (val in keywordMap) return keywordMap[val];

  const m = val.match(/^(-?\d*\.?\d+)\s*(em|rem|%|pt|px|ex)?$/);
  if (!m) return undefined;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return undefined;
  const unit = m[2] || '';

  switch (unit) {
    case 'em':
    case 'rem':
      return num;
    case '%':
      return num / 100;
    case 'pt':
      return num / 12;
    case 'px':
      return num / 16;
    case 'ex':
      return num * 0.5;
    case '':
      // Unitless font-size or numeric indent 0
      return num === 0 ? 0 : undefined;
    default:
      return undefined;
  }
}

function parseCssDeclarations(declText: string): Partial<ElementVisualStyle> {
  const result: Partial<ElementVisualStyle> = {};
  const declarations = declText.split(';');
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const rawVal = decl
      .slice(colonIdx + 1)
      .replace(/!important/gi, '')
      .trim()
      .toLowerCase();
    if (!prop || !rawVal) continue;

    switch (prop) {
      case 'font-size': {
        const em = parseCssLengthToEm(rawVal);
        if (em !== undefined) result.fontSizeEm = em;
        break;
      }
      case 'font-weight': {
        if (rawVal === 'bold' || rawVal === 'bolder') {
          result.fontWeight = 'bold';
        } else if (rawVal === 'normal' || rawVal === 'lighter') {
          result.fontWeight = 'normal';
        } else {
          const w = parseInt(rawVal, 10);
          if (Number.isFinite(w)) {
            result.fontWeight = w >= 600 ? 'bold' : 'normal';
          }
        }
        break;
      }
      case 'font-style': {
        if (rawVal === 'italic' || rawVal === 'oblique') {
          result.fontStyle = 'italic';
        } else if (rawVal === 'normal') {
          result.fontStyle = 'normal';
        }
        break;
      }
      case 'text-align': {
        if (rawVal === 'center' || rawVal === 'right' || rawVal === 'left' || rawVal === 'justify') {
          result.textAlign = rawVal;
        }
        break;
      }
      case 'text-indent': {
        const em = parseCssLengthToEm(rawVal);
        if (em !== undefined) result.textIndentEm = em;
        break;
      }
      case 'margin-top': {
        const em = parseCssLengthToEm(rawVal);
        if (em !== undefined) result.marginTopEm = em;
        break;
      }
      case 'margin-bottom': {
        const em = parseCssLengthToEm(rawVal);
        if (em !== undefined) result.marginBottomEm = em;
        break;
      }
      case 'margin-left': {
        const em = parseCssLengthToEm(rawVal);
        if (em !== undefined) result.marginLeftEm = em;
        break;
      }
      case 'margin': {
        const parts = rawVal.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
          const v = parseCssLengthToEm(parts[0]);
          if (v !== undefined) {
            result.marginTopEm = v;
            result.marginBottomEm = v;
            result.marginLeftEm = v;
          }
        } else if (parts.length === 2) {
          const tb = parseCssLengthToEm(parts[0]);
          const lr = parseCssLengthToEm(parts[1]);
          if (tb !== undefined) {
            result.marginTopEm = tb;
            result.marginBottomEm = tb;
          }
          if (lr !== undefined) result.marginLeftEm = lr;
        } else if (parts.length === 3) {
          const t = parseCssLengthToEm(parts[0]);
          const lr = parseCssLengthToEm(parts[1]);
          const b = parseCssLengthToEm(parts[2]);
          if (t !== undefined) result.marginTopEm = t;
          if (lr !== undefined) result.marginLeftEm = lr;
          if (b !== undefined) result.marginBottomEm = b;
        } else if (parts.length >= 4) {
          const t = parseCssLengthToEm(parts[0]);
          const b = parseCssLengthToEm(parts[2]);
          const l = parseCssLengthToEm(parts[3]);
          if (t !== undefined) result.marginTopEm = t;
          if (b !== undefined) result.marginBottomEm = b;
          if (l !== undefined) result.marginLeftEm = l;
        }
        break;
      }
      case 'border':
      case 'border-top':
      case 'border-bottom':
      case 'border-left':
      case 'border-right': {
        if (rawVal !== 'none' && rawVal !== '0' && !/^0\b/.test(rawVal)) {
          result.hasBorder = true;
        }
        break;
      }
      case 'display': {
        if (rawVal === 'none') {
          result.displayNone = true;
        } else if (result.displayNone) {
          result.displayNone = false;
        }
        break;
      }
      case 'text-transform': {
        if (rawVal === 'uppercase' || rawVal === 'capitalize' || rawVal === 'lowercase' || rawVal === 'none') {
          result.textTransform = rawVal;
        }
        break;
      }
      case 'font-variant': {
        if (rawVal.includes('small-caps')) {
          result.fontVariant = 'small-caps';
        } else if (rawVal === 'normal') {
          result.fontVariant = 'normal';
        }
        break;
      }
      case 'letter-spacing': {
        const em = parseCssLengthToEm(rawVal);
        if (em !== undefined) result.letterSpacingEm = em;
        break;
      }
    }
  }
  return result;
}

/**
 * Parses EPUB stylesheet strings to extract per-class typographic profiles
 * (font sizes, weights, italics, alignments, indents, margins).
 */
export function parseEpubCssProfiles(cssTexts: string[]): Map<string, CssClassProfile> {
  const profiles = new Map<string, CssClassProfile>();
  if (!cssTexts || cssTexts.length === 0) return profiles;

  const mergeProfile = (className: string, parsed: Partial<ElementVisualStyle>) => {
    const existing = profiles.get(className) || { className };
    if (parsed.fontSizeEm !== undefined) existing.fontSizeEm = parsed.fontSizeEm;
    if (parsed.fontWeight !== undefined) existing.fontWeight = parsed.fontWeight;
    if (parsed.fontStyle !== undefined) existing.fontStyle = parsed.fontStyle;
    if (parsed.textAlign !== undefined) existing.textAlign = parsed.textAlign;
    if (parsed.textIndentEm !== undefined) existing.textIndentEm = parsed.textIndentEm;
    if (parsed.marginTopEm !== undefined) existing.marginTopEm = parsed.marginTopEm;
    if (parsed.marginBottomEm !== undefined) existing.marginBottomEm = parsed.marginBottomEm;
    if (parsed.marginLeftEm !== undefined) existing.marginLeftEm = parsed.marginLeftEm;
    if (parsed.textTransform !== undefined) existing.textTransform = parsed.textTransform;
    if (parsed.fontVariant !== undefined) existing.fontVariant = parsed.fontVariant;
    if (parsed.letterSpacingEm !== undefined) existing.letterSpacingEm = parsed.letterSpacingEm;
    if (parsed.hasBorder !== undefined) existing.hasBorder = parsed.hasBorder;
    if (parsed.displayNone !== undefined) existing.displayNone = parsed.displayNone;
    profiles.set(className, existing);
  };

  for (const rawCss of cssTexts) {
    if (!rawCss) continue;
    // Strip CSS comments
    const cleanCss = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
    // Extract flat selector { declarations } blocks, unwrapping @media blocks if needed
    const strippedAtBlocks = cleanCss
      .replace(/@(?:font-face|page|keyframes|webkit-keyframes)\s*[^{]*\{[\s\S]*?\}/gi, '')
      .replace(/@(?:charset|import|namespace)\s+[^;]+;/gi, '');

    const ruleRegex = /([^{}@]+)\{([^{}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRegex.exec(strippedAtBlocks)) !== null) {
      const selectorGroup = match[1].trim();
      const declText = match[2].trim();
      if (!selectorGroup || !declText) continue;

      const parsed = parseCssDeclarations(declText);
      if (Object.keys(parsed).length === 0) continue;

      const selectors = selectorGroup.split(',');
      for (const rawSel of selectors) {
        const sel = rawSel.trim();
        if (!sel) continue;
        // Skip pseudo-elements/stateful rules like .dropcap::first-letter or a:hover
        if (/(?:::?first-letter|::?first-line|::?before|::?after|:hover|:active|:visited)\b/i.test(sel)) {
          continue;
        }
        // Only apply rules to classes present in the rightmost compound selector
        const compoundParts = sel.split(/[\s>+~]+/).filter(Boolean);
        if (compoundParts.length === 0) continue;
        const targetCompound = compoundParts[compoundParts.length - 1];
        const classMatches = targetCompound.match(/\.([A-Za-z_-][A-Za-z0-9_-]*)/g);
        if (!classMatches) continue;

        for (const clsToken of classMatches) {
          const className = clsToken.slice(1);
          mergeProfile(className, parsed);
        }
      }
    }
  }

  return profiles;
}

/**
 * Resolves the effective visual styling of an element by inspecting its classes, inline style,
 * HTML alignment attributes, and single-significant-child inline wrapper chain (<span>, <a>, <b>, etc.).
 */
export function resolveElementVisualStyle(
  el: Element,
  cssProfiles?: Map<string, CssClassProfile>
): ElementVisualStyle {
  const style: ElementVisualStyle = {};

  const applyPartial = (p?: Partial<ElementVisualStyle>, allowFontBoostOnly = false) => {
    if (!p) return;
    if (p.fontSizeEm !== undefined) {
      if (!allowFontBoostOnly || style.fontSizeEm === undefined || p.fontSizeEm > style.fontSizeEm) {
        style.fontSizeEm = p.fontSizeEm;
      }
    }
    if (p.fontWeight !== undefined) {
      if (!allowFontBoostOnly || p.fontWeight === 'bold') {
        style.fontWeight = p.fontWeight;
      }
    }
    if (p.fontStyle !== undefined) style.fontStyle = p.fontStyle;
    if (p.textTransform !== undefined) {
      if (!allowFontBoostOnly || p.textTransform === 'uppercase') {
        style.textTransform = p.textTransform;
      }
    }
    if (p.fontVariant !== undefined) {
      if (!allowFontBoostOnly || p.fontVariant === 'small-caps') {
        style.fontVariant = p.fontVariant;
      }
    }
    if (p.letterSpacingEm !== undefined) {
      if (!allowFontBoostOnly || p.letterSpacingEm > 0) {
        style.letterSpacingEm = p.letterSpacingEm;
      }
    }
    if (!allowFontBoostOnly) {
      if (p.textAlign !== undefined) style.textAlign = p.textAlign;
      if (p.textIndentEm !== undefined) style.textIndentEm = p.textIndentEm;
      if (p.marginTopEm !== undefined) style.marginTopEm = p.marginTopEm;
      if (p.marginBottomEm !== undefined) style.marginBottomEm = p.marginBottomEm;
      if (p.marginLeftEm !== undefined) style.marginLeftEm = p.marginLeftEm;
      if (p.hasBorder !== undefined) style.hasBorder = p.hasBorder;
      if (p.displayNone !== undefined) style.displayNone = p.displayNone;
    }
  };

  const applyElementAttrs = (node: Element, allowFontBoostOnly = false) => {
    const clsList = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    if (cssProfiles) {
      for (const cls of clsList) {
        applyPartial(cssProfiles.get(cls), allowFontBoostOnly);
      }
    }
    const alignAttr = (node.getAttribute('align') || '').trim().toLowerCase();
    if (
      !allowFontBoostOnly &&
      (alignAttr === 'center' || alignAttr === 'right' || alignAttr === 'left' || alignAttr === 'justify')
    ) {
      style.textAlign = alignAttr;
    }
    const inlineStyle = node.getAttribute('style');
    if (inlineStyle) {
      applyPartial(parseCssDeclarations(inlineStyle), allowFontBoostOnly);
    }
  };

  applyElementAttrs(el, false);

  // Inspect single-significant-child inline wrapper chain (e.g. <p class="calibre8"><a class="calibre5"><span class="calibre9"><span class="bold">§2</span></span></a></p>)
  let curr: Element = el;
  for (let depth = 0; depth < 4; depth++) {
    const significantNodes = Array.from(curr.childNodes).filter((n) => {
      if (n.nodeType === 3) {
        return (n.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0;
      }
      if (n.nodeType === 1) {
        const childEl = n as Element;
        const childNode: Node = childEl;
        if (isEmptyPagebreakAnchor(childNode)) return false;
        const tag = (childEl.tagName || '').toUpperCase();
        if (tag === 'BR') return false;
        return true;
      }
      return false;
    });

    if (significantNodes.length !== 1 || significantNodes[0].nodeType !== 1) {
      break;
    }

    const onlyChild = significantNodes[0] as Element;
    const tag = (onlyChild.tagName || '').toUpperCase();
    if (!INLINE_WRAPPER_TAGS.has(tag)) {
      break;
    }

    if (tag === 'B' || tag === 'STRONG') {
      style.fontWeight = 'bold';
    } else if (tag === 'I' || tag === 'EM') {
      style.fontStyle = 'italic';
    } else if (tag === 'BIG') {
      style.fontSizeEm = Math.max(style.fontSizeEm ?? 1, 1.2);
    } else if (tag === 'SMALL') {
      if (style.fontSizeEm === undefined) style.fontSizeEm = 0.88;
    }

    applyElementAttrs(onlyChild, true);
    curr = onlyChild;
  }

  return style;
}

function escapeXml(unsafe: any): string {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

function isFootnotePopupElement(el: Element): boolean {
  const tagName = (el.tagName || '').toUpperCase();
  const epubType = el.getAttribute('epub:type') || el.getAttribute('role') || '';
  const cls = el.getAttribute('class') || '';
  if (tagName === 'ASIDE' && /\b(footnote|doc-footnote|endnote|doc-endnote)\b/i.test(epubType)) {
    return true;
  }
  if (
    cls.split(/\s+/).includes('footnote-popup') ||
    el.hasAttribute('data-footnote-internalized')
  ) {
    return true;
  }
  return false;
}

function isNoterefAnchor(el: Element): boolean {
  if ((el.tagName || '').toUpperCase() !== 'A') return false;
  const epubType = el.getAttribute('epub:type') || el.getAttribute('role') || '';
  const cls = el.getAttribute('class') || '';
  const href = el.getAttribute('href') || '';
  return (
    epubType === 'noteref' ||
    epubType === 'doc-noteref' ||
    cls.split(/\s+/).includes('noteref') ||
    Boolean(el.getAttribute('data-fn-id')) ||
    href.startsWith('#fn-')
  );
}

function isEmptyPagebreakAnchor(node: Node): node is Element {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  const tag = (el.tagName || '').toUpperCase();
  if (tag !== 'A' && tag !== 'SPAN') return false;
  if (isNoterefAnchor(el)) return false;
  const text = (el.textContent || '').replace(/\u00a0/g, '').trim();
  if (text.length > 0) return false;
  if (el.querySelector('img, svg, image')) return false;
  return Boolean(el.getAttribute('id') || el.getAttribute('name') || el.getAttribute('role'));
}

function isStructuralTitleTable(table: Element): boolean {
  const cls = table.getAttribute('class') || '';
  if (/\btitle[12]\b/i.test(cls) || table.getAttribute('data-translit-role') === 'title-table') {
    return true;
  }
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === table
  );
  if (rows.length !== 1) return false;
  const cells = Array.from(rows[0].children).filter((c) => {
    const t = (c.tagName || '').toUpperCase();
    return t === 'TD' || t === 'TH';
  });
  if (cells.length !== 2) return false;
  const leftText = (cells[0].textContent || '').replace(/[\s\u00a0]+/g, '').trim();
  const rightText = (cells[1].textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
  const leftIsEmptyOrNum =
    leftText.length === 0 || /^(?:\d{1,3}|[IVXLCDM]{1,6})\.?$/i.test(leftText);
  return (
    leftIsEmptyOrNum &&
    rightText.length > 0 &&
    rightText.length <= 160 &&
    !cells[1].querySelector('table')
  );
}

function isImmutableNumberCell(el: Element): boolean {
  const tag = (el.tagName || '').toUpperCase();
  if (tag !== 'TD' && tag !== 'TH') return false;
  const table = el.closest('table');
  if (!table || !isStructuralTitleTable(table)) return false;
  const row = el.closest('tr');
  if (!row) return false;
  const cells = Array.from(row.children).filter((c) => {
    const t = (c.tagName || '').toUpperCase();
    return t === 'TD' || t === 'TH';
  });
  const cls = el.getAttribute('class') || '';
  const isLeftNumCell = cells[0] === el || /\b(bor1?|num)\b/i.test(cls);
  if (!isLeftNumCell) return false;
  if (Array.from(el.querySelectorAll('a')).some((a) => isNoterefAnchor(a))) return false;
  const text = (el.textContent || '').replace(/[\s\u00a0]+/g, '').trim();
  return text.length === 0 || /^(?:\d{1,3}|[IVXLCDM]{1,6})\.?$/i.test(text);
}

export function getHeadingMarkdownLevel(
  el: Element,
  cssProfiles?: Map<string, CssClassProfile>
): number {
  const tag = (el.tagName || '').toUpperCase();
  const hMatch = tag.match(/^H([1-6])$/);
  if (hMatch) return Number(hMatch[1]);

  const cls = el.getAttribute('class') || '';
  const parentTable = el.closest('table');
  if (parentTable && isStructuralTitleTable(parentTable)) {
    if (isImmutableNumberCell(el) || /\b(bor1?|num)\b/i.test(cls)) return 0;
    if (/\b(top-int1|top2|subtitle|subhead)\b/i.test(cls)) return 2;
    const cell = el.closest('td, th');
    if (cell && el !== cell) {
      const siblingBlocks = Array.from(cell.children).filter((c) =>
        BLOCK_LEVEL_TAGS.has((c.tagName || '').toUpperCase())
      );
      if (siblingBlocks.indexOf(el) > 0) return 2;
    }
    return 1;
  }

  // Layer 2: Explicit semantic heading class names
  if (
    /\b(part-title[a-z0-9]*|fm-title[a-z0-9]*|bm-title[a-z0-9]*|book-title|halftitle|half-title|chap-title[a-z0-9]*|chapter-title[a-z0-9]*|chapter-head|chapter-number|top-int\b|top\b|title1\b|h1\b)/i.test(
      cls
    )
  ) {
    return 1;
  }
  if (
    /\b(sec1-title[a-z0-9]*|sec-title[a-z0-9]*|section-title|sub-title|subtitle\b|head\b|heading\b|title2\b|authorleft\b|h2\b)/i.test(
      cls
    )
  ) {
    return 2;
  }
  if (/\b(sec2-title[a-z0-9]*|sec3-title[a-z0-9]*|subhead\b|h3\b|h4\b)/i.test(cls)) {
    return 3;
  }

  // Layer 3: Multi-dimensional weighted visual feature scoring for pseudo-headings
  if (tag !== 'P' && tag !== 'DIV' && tag !== 'BLOCKQUOTE') {
    return 0;
  }
  if (EXCLUDED_PSEUDO_HEADING_CLASSES.test(cls)) {
    return 0;
  }

  const rawText = (el.textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
  if (rawText.length === 0 || rawText.length > 120) {
    return 0;
  }
  // Hard negative text guards: salutations, dialogue quotes, dash attributions, multi-sentence prose
  if (/[,;，；:：—\-]$/.test(rawText)) {
    return 0;
  }
  if (/^["“‘「『'].*["”’」』']$/.test(rawText) || /^[-—–―]\s*/.test(rawText)) {
    return 0;
  }
  const internalSentenceBreaks = rawText.slice(0, -1).match(/[.!?。！？](?:\s|$)/g)?.length || 0;
  if (internalSentenceBreaks > 1 || (rawText.length > 60 && internalSentenceBreaks > 0)) {
    return 0;
  }
  const isStructuralPrefix =
    /^(?:§\s*\d+|Chapter\s+[\dIVXLCDM]+|Part\s+[\dIVXLCDM]+|Section\s+[\dIVXLCDM]+|第[零一二三四五六七八九十百千万\d]+[章节篇部卷]|(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)\.?|\d{1,2}\.\s+\S)/i.test(
      rawText
    );
  if (rawText.length > 45 && /[.。]$/.test(rawText) && !isStructuralPrefix) {
    return 0;
  }

  const style = resolveElementVisualStyle(el, cssProfiles);
  if (style.displayNone) return 0;
  // Negative text-indent indicates hanging-indent bib/toc/list; > 0.5em indicates standard indented body paragraph
  if (style.textIndentEm !== undefined && (style.textIndentEm < 0 || style.textIndentEm > 0.5)) {
    return 0;
  }

  const fs = style.fontSizeEm ?? 1;
  const mt = style.marginTopEm ?? 0;
  const mb = style.marginBottomEm ?? 0;
  const isAllCapsText =
    rawText.length >= 4 &&
    rawText.length <= 80 &&
    /[A-Z]{3,}/.test(rawText) &&
    rawText === rawText.toUpperCase() &&
    !/^[0-9\W]+$/.test(rawText);

  const hasVisualSignal =
    fs > 1.04 ||
    style.fontWeight === 'bold' ||
    style.textAlign === 'center' ||
    mt >= 1.0 ||
    style.textTransform === 'uppercase' ||
    style.fontVariant === 'small-caps' ||
    (style.letterSpacingEm ?? 0) >= 0.05 ||
    Boolean(style.hasBorder);

  if (!hasVisualSignal) {
    return 0;
  }

  let score = 0;

  if (fs >= 1.6) score += 4.5;
  else if (fs >= 1.35) score += 3.6;
  else if (fs >= 1.15) score += 2.2;
  else if (fs >= 1.05) score += 1.0;
  else if (fs < 0.9 && style.fontVariant !== 'small-caps' && style.textTransform !== 'uppercase') {
    score -= 2.0;
  }

  if (style.fontWeight === 'bold') score += 1.5;

  if (style.textAlign === 'center') score += 1.5;
  else if (style.textAlign === 'right') score -= 1.5;

  if (mt >= 2.0) score += 1.5;
  else if (mt >= 1.0) score += 0.9;
  if (mb >= 1.0) score += 0.5;

  if (style.textIndentEm === 0) score += 0.8;

  if (
    style.textTransform === 'uppercase' ||
    style.fontVariant === 'small-caps' ||
    (style.letterSpacingEm ?? 0) >= 0.05 ||
    style.hasBorder ||
    isAllCapsText
  ) {
    score += 1.2;
  }

  if (isStructuralPrefix) score += 1.8;

  if (/[.。]$/.test(rawText) && !isStructuralPrefix) score -= 1.2;

  if (fs >= 1.35 && score >= 3.5) return 1;
  if (score >= 3.0) return 2;
  if (score >= 2.3) return 3;

  return 0;
}

export function isHeadingLikeElement(
  el: Element,
  cssProfiles?: Map<string, CssClassProfile>
): boolean {
  if (getHeadingMarkdownLevel(el, cssProfiles) > 0) return true;
  if (el.closest('table.title1, table.title2')) return true;
  return false;
}

/**
 * Applies Heti (赫蹏) / W3C CLREQ micro-typography rules to plain text segments while
 * leaving HTML tags, entities, URLs, preview note badges, and footnote slots untouched:
 * 1. Normalizes `--` -> `——` and `...` -> `……` adjacent to CJK characters/punctuation.
 * 2. Strips redundant horizontal whitespace next to full-width CJK punctuation.
 * 3. Inserts a single space between CJK ideographs and Latin letters / Arabic numerals (idempotent).
 */
export function applyHetiTextTypography(htmlOrText: string): string {
  if (!htmlOrText) return htmlOrText;

  const tokenRegex =
    /(<[^>]+>|https?:\/\/[^\s)>\]]+|__FN_REF_[A-Za-z0-9_-]+__|\{\{TRANSLITFNSLOT:[A-Za-z0-9_-]+\}\}|\[\^(?:fn-)?[A-Za-z0-9_-]+\]|\[注\d+\](?:\([^)]*\))?|&[a-zA-Z0-9#]+;)/g;
  const parts = htmlOrText.split(tokenRegex);

  for (let i = 0; i < parts.length; i += 2) {
    let seg = parts[i];
    if (!seg) continue;

    // 1. Convert ASCII -- / ... adjacent to CJK characters or CJK punctuation
    seg = seg
      .replace(/([\u4e00-\u9fa5\u3001-\u303f\uff01-\uffef])--+/g, '$1——')
      .replace(/--+([\u4e00-\u9fa5\u3001-\u303f\uff01-\uffef])/g, '——$1')
      .replace(/([\u4e00-\u9fa5\u3001-\u303f\uff01-\uffef])\.{3,}/g, '$1……')
      .replace(/\.{3,}([\u4e00-\u9fa5\u3001-\u303f\uff01-\uffef])/g, '……$1');

    // 2. Clean redundant horizontal spaces around full-width CJK punctuation (preserving newlines)
    seg = seg
      .replace(/[ \t]+([，。！？；：、（）《》〈〉「」『』【】〔〕……])/g, '$1')
      .replace(/([，。！？；：、（）《》〈〉「」『』【】〔〕……])[ \t]+/g, '$1')
      .replace(/([\u4e00-\u9fa5])[ \t]+——/g, '$1——')
      .replace(/——[ \t]+([\u4e00-\u9fa5])/g, '——$1')
      .replace(/([“‘])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1')
      .replace(/([\u4e00-\u9fa5])[ \t]+([”’])/g, '$1$2');

    // 3. Pangu spacing between CJK characters and Latin letters / Arabic numerals
    // (Idempotent: only matches zero-distance CJK<->alphanumeric boundaries)
    seg = seg
      .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([A-Za-z0-9][%‰℃°]?)([\u4e00-\u9fa5])/g, '$1 $2');

    parts[i] = seg;
  }

  return parts.join('');
}

/**
 * Restores ATX Markdown heading prefixes (`# `, `## `, etc.) from aligned source Markdown blocks
 * onto translated Markdown blocks where the LLM omitted heading markers per prompt rules.
 */
export function restoreHeadingPrefixesFromSource(
  sourceMarkdown: string,
  targetMarkdown: string
): string {
  if (!sourceMarkdown || !targetMarkdown) return targetMarkdown;

  const srcBlocks = sourceMarkdown
    .split(/\r?\n\s*\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const tgtBlocks = targetMarkdown
    .split(/\r?\n\s*\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (srcBlocks.length === 0 || tgtBlocks.length === 0) return targetMarkdown;

  const isAlreadyHeading = (text: string) => /^#{1,6}\s/.test(text);

  if (srcBlocks.length === tgtBlocks.length) {
    const restored = tgtBlocks.map((tgt, idx) => {
      const m = srcBlocks[idx].match(/^(#{1,6})\s+/);
      if (m && !isAlreadyHeading(tgt) && !tgt.includes('\n') && tgt.length <= 160) {
        return `${m[1]} ${tgt}`;
      }
      return tgt;
    });
    return restored.join('\n\n');
  }

  // Fallback when block counts differ: safely restore leading heading block 0 if unambiguously a short title
  const firstMatch = srcBlocks[0].match(/^(#{1,6})\s+/);
  if (
    firstMatch &&
    !isAlreadyHeading(tgtBlocks[0]) &&
    !tgtBlocks[0].includes('\n') &&
    tgtBlocks[0].length <= 80 &&
    !/[。！？.!?]$/.test(tgtBlocks[0])
  ) {
    tgtBlocks[0] = `${firstMatch[1]} ${tgtBlocks[0]}`;
    return tgtBlocks.join('\n\n');
  }

  return targetMarkdown;
}

export function isImageOrDividerElement(el: Element): boolean {
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'HR' || tag === 'IMG' || tag === 'SVG' || tag === 'FIGURE') return true;

  // Check if el contains an <img> or <svg> or <image> or <hr>
  const hasVisual = el.querySelector('img, svg, image, hr') !== null;
  if (hasVisual) {
    // Check if there is actual non-anchor, non-footnote text
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('img, svg, image, hr').forEach((n) => n.remove());
    Array.from(clone.childNodes).forEach((n) => {
      if (isEmptyPagebreakAnchor(n) || (n.nodeType === 1 && isFootnotePopupElement(n as Element))) {
        n.remove();
      }
    });
    const remainingText = (clone.textContent || '').replace(/[\s\u00a0]+/g, '').trim();
    if (remainingText.length === 0) {
      return true;
    }
  }

  // Pure divider/line classes without translatable text
  const cls = (el.getAttribute('class') || '').toLowerCase();
  if (/\b(line|divider|separator|rule|ornament|asterisk)\b/.test(cls)) {
    const rawText = (el.textContent || '').replace(/[\s\u00a0]+/g, '').trim();
    if (!rawText || /^[*_~—\-#•·•\u2022\u2014]+$/.test(rawText)) {
      return true;
    }
  }

  return false;
}

/**
 * Computes structural DOM tree differences between original XHTML and mutated XHTML,
 * ignoring text content differences, footnote popup `<aside>` additions, and noteref anchor internals.
 */
export function computeStructuralTreeDiff(
  originalXhtml: string,
  mutatedXhtml: string
): StructuralTreeDiffResult {
  const origDoc = parseHtmlDocument(originalXhtml);
  const mutDoc = parseHtmlDocument(mutatedXhtml);

  const diffs: string[] = [];

  const getFilteredElementChildren = (parent: Element): Element[] => {
    return Array.from(parent.children).filter((child) => !isFootnotePopupElement(child));
  };

  const compareElements = (a: Element, b: Element, path: string) => {
    const tagA = a.tagName.toUpperCase();
    const tagB = b.tagName.toUpperCase();
    if (tagA !== tagB) {
      diffs.push(`${path}: tag mismatch <${tagA}> vs <${tagB}>`);
      return;
    }

    const clsA = (a.getAttribute('class') || '').trim();
    const clsB = (b.getAttribute('class') || '').trim();
    const isRootBodyComparison =
      tagA === 'BODY' &&
      tagB === 'BODY' &&
      (!/<body\b/i.test(originalXhtml) || !/<body\b/i.test(mutatedXhtml));
    if (!isRootBodyComparison && !isNoterefAnchor(a) && !isNoterefAnchor(b) && clsA !== clsB) {
      diffs.push(`${path}<${tagA}>: class mismatch "${clsA}" vs "${clsB}"`);
    }

    const idA = a.getAttribute('id') || '';
    const idB = b.getAttribute('id') || '';
    if (!isRootBodyComparison && !isNoterefAnchor(a) && !isNoterefAnchor(b) && idA !== idB) {
      diffs.push(`${path}<${tagA}>: id mismatch "${idA}" vs "${idB}"`);
    }

    // Do not recurse inside noteref anchors (since noteref may wrap <sup>[1]</sup> or <img class="qqreader-footnote"/>)
    if (isNoterefAnchor(a) || isNoterefAnchor(b)) {
      return;
    }

    const childrenA = getFilteredElementChildren(a);
    const childrenB = getFilteredElementChildren(b);

    // For translatable leaf blocks, we have already verified tag, class, and id on the block container.
    // Text formatting internals (e.g. <i>, <b>, <span>) vary with target translation and are not structural skeleton diffs.
    const isLeafA = LEAF_CANDIDATE_TAGS.has(tagA) && !childrenA.some((c) => BLOCK_LEVEL_TAGS.has(c.tagName.toUpperCase()));
    const isLeafB = LEAF_CANDIDATE_TAGS.has(tagB) && !childrenB.some((c) => BLOCK_LEVEL_TAGS.has(c.tagName.toUpperCase()));
    if (isLeafA && isLeafB) {
      return;
    }

    if (childrenA.length !== childrenB.length) {
      diffs.push(
        `${path}<${tagA}>: child element count mismatch ${childrenA.length} vs ${childrenB.length} (${childrenA.map((c) => c.tagName).join(',')} vs ${childrenB.map((c) => c.tagName).join(',')})`
      );
      return;
    }

    for (let i = 0; i < childrenA.length; i++) {
      compareElements(childrenA[i], childrenB[i], `${path}/${tagA}[${i}]`);
    }
  };

  if (origDoc.body || mutDoc.body) {
    const engine = new DomMutationEngine();
    if (origDoc.body) engine.decomposeBlockquotes(origDoc.body);
    if (mutDoc.body) engine.decomposeBlockquotes(mutDoc.body);
  }

  if (origDoc.body && mutDoc.body) {
    compareElements(origDoc.body, mutDoc.body, '/BODY');
  }

  return {
    diffCount: diffs.length,
    diffs
  };
}

/**
 * Sanitizes footnote prose so it is strictly well-formed XHTML inside `<aside>` elements:
 * - Escapes bare `&` characters not part of valid XML entities.
 * - Preserves balanced, attribute-free inline formatting tags (`i`, `em`, `b`, `strong`, `sup`, `sub`, `u`, `small`, `code`) and `<br/>`.
 * - Escapes unclosed, mismatched, or arbitrary angle-bracket text (e.g. `<internal>`, `x < y`).
 */
export function sanitizeFootnoteTextForXhtml(text: string): string {
  if (!text) return '';
  const safeAmps = text.replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/gi,
    '&amp;'
  );

  type Token =
    | { kind: 'text'; raw: string }
    | { kind: 'tag'; raw: string; tagName?: string; isClose?: boolean; isVoidBr?: boolean; valid?: boolean };

  const tokens: Token[] = [];
  const tagRe = /<[^<>]*>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(safeAmps)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', raw: safeAmps.slice(lastIndex, match.index) });
    }
    const rawTag = match[0];
    if (/^<\s*br\s*\/?\s*>$/i.test(rawTag)) {
      tokens.push({ kind: 'tag', raw: rawTag, tagName: 'br', isVoidBr: true, valid: true });
    } else {
      const fmtMatch = rawTag.match(/^<\s*(\/?)\s*(i|em|b|strong|sup|sub|u|small|code)\s*>$/i);
      if (fmtMatch) {
        tokens.push({
          kind: 'tag',
          raw: rawTag,
          tagName: fmtMatch[2].toLowerCase(),
          isClose: fmtMatch[1] === '/',
          valid: false
        });
      } else {
        tokens.push({ kind: 'tag', raw: rawTag, valid: false });
      }
    }
    lastIndex = tagRe.lastIndex;
  }

  if (lastIndex < safeAmps.length) {
    tokens.push({ kind: 'text', raw: safeAmps.slice(lastIndex) });
  }

  const stack: Array<{ tok: Extract<Token, { kind: 'tag' }>; tagName: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind !== 'tag' || !tok.tagName || tok.isVoidBr) continue;
    if (!tok.isClose) {
      stack.push({ tok, tagName: tok.tagName });
    } else {
      let matchPos = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].tagName === tok.tagName) {
          matchPos = s;
          break;
        }
      }
      if (matchPos !== -1) {
        const openEntry = stack[matchPos];
        stack.length = matchPos; // Any unclosed inner tags stay valid:false
        openEntry.tok.valid = true;
        tok.valid = true;
      }
    }
  }

  return tokens
    .map((tok) => {
      if (tok.kind === 'tag' && tok.valid) {
        if (tok.isVoidBr) return '<br/>';
        return tok.isClose ? `</${tok.tagName}>` : `<${tok.tagName}>`;
      }
      return tok.raw.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    })
    .join('');
}

/**
 * Builds a standard EPUB 3 `<aside epub:type="footnote">` block with XML-safe paragraph content.
 */
export function buildFootnoteAsideHtml(
  id: string,
  displayNum: number,
  rawText: string,
  isSourceMirror: boolean = false
): string {
  const asideId = isSourceMirror ? `fn-src-${id}` : `fn-${id}`;
  const backrefHref = isSourceMirror ? `#fnref-src-${id}` : `#fnref-${id}`;
  const paragraphs = (rawText || '')
    .split(/\n{2,}/)
    .map((p) => sanitizeFootnoteTextForXhtml(p.trim()))
    .filter(Boolean);

  if (paragraphs.length <= 1) {
    const singleText = paragraphs[0] || '';
    return `<aside id="${asideId}" epub:type="footnote" class="footnote-popup duokan-footnote-content footnote-content">\n  <p class="footnote-content duokan-footnote-item">\n    <a href="${backrefHref}" class="footnote-backref">[${displayNum}]</a> ${singleText}\n  </p>\n</aside>`;
  }

  const firstPara = `<p class="footnote-content duokan-footnote-item">\n    <a href="${backrefHref}" class="footnote-backref">[${displayNum}]</a> ${paragraphs[0]}\n  </p>`;
  const restParas = paragraphs
    .slice(1)
    .map((p) => `<p class="footnote-content duokan-footnote-item">${p}</p>`)
    .join('\n  ');
  return `<aside id="${asideId}" epub:type="footnote" class="footnote-popup duokan-footnote-content footnote-content">\n  ${firstPara}\n  ${restParas}\n</aside>`;
}

export class DomMutationEngine {
  /**
   * Decomposes blockquotes containing internal <br/> separators into discrete child blocks (<p>).
   * This ensures that multi-line dialogues, interviews, or discrete thoughts inside <blockquote>
   * maintain their individual block identities during translation and in-place DOM mutation.
   */
  public decomposeBlockquotes(root: Element): void {
    const blockquotes =
      (root.tagName || '').toUpperCase() === 'BLOCKQUOTE'
        ? [root]
        : Array.from(root.querySelectorAll('blockquote'));

    for (const bq of blockquotes) {
      if (bq !== root && !bq.isConnected) continue;

      // Collapse redundant single-child nested <blockquote> chains (e.g. 8-level Calibre blockquotes)
      while (true) {
        const hasDirectTextNode = Array.from(bq.childNodes).some(
          (n) => n.nodeType === 3 && (n.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0
        );
        if (hasDirectTextNode) break;

        const significantChildren = Array.from(bq.children).filter((c) => {
          const childNode: Node = c;
          return !isFootnotePopupElement(c) && !isEmptyPagebreakAnchor(childNode);
        });
        if (
          significantChildren.length !== 1 ||
          significantChildren[0].tagName.toUpperCase() !== 'BLOCKQUOTE'
        ) {
          break;
        }

        const innerBq = significantChildren[0];
        if (!bq.getAttribute('id') && innerBq.getAttribute('id')) {
          bq.setAttribute('id', innerBq.getAttribute('id')!);
        }
        const mergedClasses = Array.from(
          new Set([
            ...(bq.getAttribute('class') || '').split(/\s+/).filter(Boolean),
            ...(innerBq.getAttribute('class') || '').split(/\s+/).filter(Boolean)
          ])
        );
        if (mergedClasses.length > 0) {
          bq.setAttribute('class', mergedClasses.join(' '));
        }

        const preservedAnchors = Array.from(bq.childNodes).filter((n) => isEmptyPagebreakAnchor(n));
        const innerChildren = Array.from(innerBq.childNodes);
        bq.replaceChildren(...preservedAnchors, ...innerChildren);
      }

      const children = Array.from(bq.childNodes);
      for (const child of children) {
        if (child.nodeType === 1) {
          const el = child as Element;
          if (el.querySelector('br')) {
            const groups: Node[][] = [];
            let currentGroup: Node[] = [];

            for (const node of Array.from(el.childNodes)) {
              if (node.nodeType === 1 && (node as Element).tagName.toUpperCase() === 'BR') {
                if (currentGroup.length > 0) {
                  groups.push(currentGroup);
                  currentGroup = [];
                }
              } else {
                currentGroup.push(node);
              }
            }
            if (currentGroup.length > 0) {
              groups.push(currentGroup);
            }

            const newElements: Element[] = [];
            let isFirst = true;
            for (const grp of groups) {
              const hasContent = grp.some((n) => {
                if (n.nodeType === 3) return (n.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0;
                if (n.nodeType === 1) return true;
                return false;
              });
              if (!hasContent) continue;

              const newEl = el.ownerDocument!.createElement(el.tagName.toLowerCase());
              for (const attr of Array.from(el.attributes)) {
                if (attr.name.toLowerCase() === 'id' && !isFirst) continue;
                newEl.setAttribute(attr.name, attr.value);
              }
              for (const node of grp) {
                newEl.appendChild(node);
              }
              newElements.push(newEl);
              isFirst = false;
            }

            if (newElements.length > 1) {
              el.replaceWith(...newElements);
            }
          }
        }
      }

      // Also check if blockquote directly has <br> children without paragraph wrappers
      const directBrs = Array.from(bq.children).filter((c) => c.tagName.toUpperCase() === 'BR');
      const hasDirectText = Array.from(bq.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0
      );
      if (directBrs.length > 0 && hasDirectText) {
        const groups: Node[][] = [];
        let currentGroup: Node[] = [];
        for (const node of Array.from(bq.childNodes)) {
          if (node.nodeType === 1 && (node as Element).tagName.toUpperCase() === 'BR') {
            if (currentGroup.length > 0) {
              groups.push(currentGroup);
              currentGroup = [];
            }
          } else {
            currentGroup.push(node);
          }
        }
        if (currentGroup.length > 0) groups.push(currentGroup);

        const newElements: Element[] = [];
        for (const grp of groups) {
          const hasContent = grp.some((n) => {
            if (n.nodeType === 3) return (n.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0;
            if (n.nodeType === 1) return true;
            return false;
          });
          if (!hasContent) continue;

          const p = bq.ownerDocument!.createElement('p');
          for (const node of grp) {
            p.appendChild(node);
          }
          newElements.push(p);
        }
        if (newElements.length > 1) {
          bq.replaceChildren(...newElements);
        }
      }
    }
  }

  /**
   * Collects all translatable leaf block elements in DOM tree order.
   * Preserves exact element references so we can either extract their inline HTML
   * or mutate them in-place without losing any parent containers, tables, or classes.
   */
  public collectTranslatableLeafElements(body: Element): Element[] {
    const results: Element[] = [];

    const walk = (el: Element) => {
      if (isFootnotePopupElement(el)) return;

      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'MATH') {
        return;
      }

      const childElements = Array.from(el.children).filter((c) => !isFootnotePopupElement(c));
      const hasBlockChild = childElements.some((c) =>
        BLOCK_LEVEL_TAGS.has((c.tagName || '').toUpperCase())
      );

      if (hasBlockChild) {
        for (const child of childElements) {
          walk(child);
        }
        return;
      }

      if (LEAF_CANDIDATE_TAGS.has(tag)) {
        if (isImageOrDividerElement(el) || isImmutableNumberCell(el)) {
          return;
        }
        const text = (el.textContent || '').replace(/\u00a0/g, ' ').trim();
        const hasNoteref = Array.from(el.querySelectorAll('a')).some((a) => isNoterefAnchor(a));
        if (text.length > 0 || hasNoteref) {
          results.push(el);
        }
      } else {
        for (const child of childElements) {
          walk(child);
        }
      }
    };

    walk(body);
    return results;
  }

  /**
   * Serializes the inner content of a leaf block element for translation:
   * - Separates leading empty pagebreak anchors (`<a id="p17" class="calibre4"></a>`) so the LLM never sees or drops them
   * - Unwraps single outer inline wrapper (`<small class="calibre6">...</small>`) if it wraps the entire leaf block
   * - Converts `<a epub:type="noteref">` into opaque `__FN_REF_{id}__` slots
   * - Keeps inline formatting tags (`<i>`, `<b>`, `<em>`, `<strong>`, etc.) intact
   */
  public extractLeafBlockContent(el: Element): {
    slottedText: string;
    leadingAnchorHtmls: string[];
    footnoteIds: string[];
  } {
    const clone = el.cloneNode(true) as Element;
    const leadingAnchorHtmls: string[] = [];

    // 1. Extract leading empty pagebreak anchors and leading nbsp/whitespace
    while (clone.firstChild) {
      const first = clone.firstChild;
      if (first.nodeType === 3) {
        const raw = first.textContent || '';
        const stripped = raw.replace(/^[\s\u00a0]+/, '');
        if (stripped.length === 0) {
          clone.removeChild(first);
          continue;
        } else {
          first.textContent = stripped;
          break;
        }
      } else if (isEmptyPagebreakAnchor(first)) {
        leadingAnchorHtmls.push((first as Element).outerHTML);
        clone.removeChild(first);
      } else {
        break;
      }
    }

    // 2. If the remaining content is a single outer wrapper element (<small>, <span>) with no sibling text,
    // we can unwrap its children during serialization and mutate inside that wrapper on write-back!
    const targetContainer = this.resolveInnerWrapperTarget(clone);

    // 3. Replace footnote anchors with __FN_REF_{id}__ text nodes
    const anchors = Array.from(targetContainer.querySelectorAll('a'));
    for (const a of anchors) {
      if (isNoterefAnchor(a)) {
        const dataFnId = a.getAttribute('data-fn-id');
        const href = a.getAttribute('href') || '';
        let rawId = dataFnId || '';
        if (!rawId && href.startsWith('#')) {
          rawId = href.slice(1).replace(/^fn-/, '');
        }
        if (rawId) {
          const slot = createFootnoteSlot(rawId);
          const textNode = targetContainer.ownerDocument!.createTextNode(slot);
          a.replaceWith(textNode);
        }
      }
    }

    // 4. Strip mid-paragraph invisible pagebreak spans and empty metadata anchors so the LLM never sees or hallucinates on them
    const inlineMetaNodes = Array.from(targetContainer.querySelectorAll('a, span'));
    for (const metaNode of inlineMetaNodes) {
      if (isEmptyPagebreakAnchor(metaNode)) {
        metaNode.remove();
      }
    }

    const slottedText = targetContainer.innerHTML
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const footnoteIds = Array.from(new Set(extractFootnoteSlots(slottedText)));

    return {
      slottedText,
      leadingAnchorHtmls,
      footnoteIds
    };
  }

  /**
   * Stamps canonical `data-translit-role` attributes onto recognized DOM elements so
   * the pure Heti preset stylesheet can style every bookish element uniformly without
   * altering original `class` attributes or relying on messy publisher/Calibre CSS rules.
   */
  private stampSemanticRoleClasses(
    root: Element,
    leafElements: Element[],
    cssProfiles?: Map<string, CssClassProfile>
  ): void {
    const setRole = (el: Element | null, role: string) => {
      if (!el) return;
      el.setAttribute('data-translit-role', role);
    };

    for (const table of Array.from(root.querySelectorAll('table'))) {
      if (isStructuralTitleTable(table)) {
        setRole(table, 'title-table');
        const cells = Array.from(table.querySelectorAll('td, th')).filter(
          (c) => c.closest('table') === table
        );
        for (const cell of cells) {
          if (isImmutableNumberCell(cell)) {
            const hasVisibleNum =
              (cell.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0;
            setRole(cell, hasVisibleNum ? 'title-num' : 'title-num-empty');
          } else {
            const blockChildren = Array.from(cell.children).filter((c) =>
              BLOCK_LEVEL_TAGS.has((c.tagName || '').toUpperCase())
            );
            if (blockChildren.length === 0) {
              setRole(cell, 'h1');
            } else {
              blockChildren.forEach((child, idx) => {
                const lvl = getHeadingMarkdownLevel(child, cssProfiles);
                if (lvl === 2 || (lvl === 0 && idx > 0)) {
                  setRole(child, 'h2');
                } else {
                  setRole(child, idx === 0 ? 'h1' : 'h2');
                }
              });
            }
          }
        }
      } else {
        setRole(table, 'data-table');
      }
    }

    for (const el of leafElements) {
      const tag = (el.tagName || '').toUpperCase();
      const cls = el.getAttribute('class') || '';
      const parentTable = el.closest('table');
      if (parentTable && isStructuralTitleTable(parentTable)) {
        continue;
      }
      const headingLevel = getHeadingMarkdownLevel(el, cssProfiles);

      if (headingLevel === 1) {
        setRole(el, 'h1');
        continue;
      }
      if (headingLevel === 2) {
        setRole(el, 'h2');
        continue;
      }
      if (headingLevel === 3) {
        setRole(el, 'h3');
        continue;
      }
      if (headingLevel >= 4) {
        setRole(el, 'h4');
        continue;
      }

      if (/\b(epigraph|dedication|verse|poem|motto)\b/i.test(cls)) {
        setRole(el, 'epigraph');
        continue;
      }

      const style = resolveElementVisualStyle(el, cssProfiles);
      if (
        (style.textIndentEm !== undefined && style.textIndentEm < 0) ||
        /\b(bib\d*|ref|reference|ind|inda|toc\d*)\b/i.test(cls)
      ) {
        setRole(el, 'hanging');
        continue;
      }

      if (
        tag === 'FIGCAPTION' ||
        tag === 'CAPTION' ||
        /\b(caption|img-caption|fig-caption)\b/i.test(cls)
      ) {
        setRole(el, 'caption');
        continue;
      }

      if (style.textAlign === 'center' || /\b(center|centered|halftitle|half-title)\b/i.test(cls)) {
        setRole(el, 'center');
        continue;
      }

      if (
        style.textAlign === 'right' ||
        /\b(right|signature|dateline|author-right)\b/i.test(cls)
      ) {
        setRole(el, 'right');
        continue;
      }

      if (tag === 'P' && !el.closest('blockquote, li, table, figcaption')) {
        setRole(el, 'body');
      }
    }
  }

  /**
   * If an element's non-whitespace content (after leading empty anchors) consists of a single
   * inline wrapper like `<small class="calibre6">TEXT</small>`, returns that `<small>` element
   * so we preserve the `<small class="calibre6">` shell in the DOM!
   */
  public resolveInnerWrapperTarget(el: Element): Element {
    let curr = el;
    while (true) {
      const significantNodes = Array.from(curr.childNodes).filter((n) => {
        if (n.nodeType === 3) {
          return (n.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0;
        }
        if (n.nodeType === 1) {
          return !isEmptyPagebreakAnchor(n);
        }
        return false;
      });

      if (significantNodes.length === 1 && significantNodes[0].nodeType === 1) {
        const onlyChild = significantNodes[0] as Element;
        const tag = (onlyChild.tagName || '').toUpperCase();
        if (
          !isNoterefAnchor(onlyChild) &&
          (tag === 'SMALL' || tag === 'SPAN' || tag === 'BIG' || tag === 'A')
        ) {
          curr = onlyChild;
          continue;
        }
      }
      break;
    }
    return curr;
  }

  /**
   * Extracts all translatable leaf blocks from an XHTML string and returns a paragraph-separated
   * payload compatible with existing chunkers, AI prompts, and FootnotePool.
   */
  public extractTranslatablePayload(
    xhtml: string,
    _internalizedFootnotes: Record<string, FootnoteNode> = {},
    cssProfiles?: Map<string, CssClassProfile>
  ): DomExtractionResult {
    const doc = parseHtmlDocument(xhtml);
    if (!doc.body) {
      return { blocks: [], payloadText: '' };
    }

    this.decomposeBlockquotes(doc.body);

    const leafElements = this.collectTranslatableLeafElements(doc.body);
    const blocks: TranslatableDomBlock[] = [];

    leafElements.forEach((el) => {
      const { slottedText, leadingAnchorHtmls, footnoteIds } = this.extractLeafBlockContent(el);
      if (!slottedText) return;

      const headingLevel = getHeadingMarkdownLevel(el, cssProfiles);
      const formattedSlottedText =
        headingLevel > 0 && !/^#{1,6}\s/.test(slottedText)
          ? `${'#'.repeat(headingLevel)} ${slottedText}`
          : slottedText;

      blocks.push({
        index: blocks.length,
        tagName: el.tagName.toLowerCase(),
        className: el.getAttribute('class') || '',
        id: el.getAttribute('id') || '',
        isHeadingLike: isHeadingLikeElement(el, cssProfiles),
        slottedText: formattedSlottedText,
        footnoteIds,
        leadingAnchorHtmls
      });
    });

    const payloadText = blocks.map((b) => b.slottedText).join('\n\n');
    return { blocks, payloadText };
  }

  /**
   * Mutates the original XHTML DOM in-place using the translated payload text.
   * - Preserves 100% of original DOM hierarchy, tags, classes, and IDs.
   * - In monolingual mode (`bilingualMode: 'none'`), replaces text inside each leaf block in-place.
   * - In bilingual mode (`source_first` / `target_first`), clones each leaf block in-place,
   *   keeps original classes on both source and target nodes, and appends `.bilingual-source` / `.bilingual-target`.
   * - Appends standard EPUB 3 `<aside epub:type="footnote">` popups at the end of `<body>`.
   */
  public mutateDomInPlace(
    originalXhtml: string,
    translatedPayload: string,
    options: DomMutationOptions = {}
  ): string {
    return this.mutateDomInPlaceWithStats(originalXhtml, translatedPayload, options).html;
  }

  public mutateDomInPlaceWithStats(
    originalXhtml: string,
    translatedPayload: string,
    options: DomMutationOptions = {}
  ): { html: string; leafCount: number } {
    const {
      internalizedFootnotes = {},
      translatedFootnotes = {},
      sourcePayloadWithSlots,
      bilingualMode = 'none',
      wereadMode = false,
      imagesRelPath = 'Images/',
      cssProfiles,
      applyChineseTypography = true,
      isStreaming = false
    } = options;

    // 1. Clean dual-channel wrapper tags & salvage inline footnote definitions from translatedPayload
    const inlineTranslatedNotes: Record<string, string> = { ...translatedFootnotes };
    let cleanTarget = translatedPayload || '';

    cleanTarget = cleanTarget.replace(
      /(?:\[|【)\s*FN_DEF[:：]\s*([^\]】]+?)\s*(?:\]|】)([\s\S]*?)(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|(?=(?:\[|【)\s*FN_DEF[:：])|$)/gi,
      (_, rawId, text) => {
        const cleanId = String(rawId).trim().replace(/^fn-/, '');
        inlineTranslatedNotes[cleanId] = String(text).trim();
        return '';
      }
    );
    cleanTarget = cleanTarget
      .replace(
        /(?:\[|【)\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)|$)/gi,
        ''
      )
      .replace(
        /(?:\[|【)\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)|$)/gi,
        ''
      )
      .replace(/(?:\[|【)\s*[\/／]?\s*MAIN_CONTENT\s*(?:\]|】)/gi, '');

    cleanTarget = cleanTarget.replace(
      /(?:^|\n)(?:\[|【|〔)\s*\^\s*(?:fn-)?([^\]】〕]+?)\s*(?:\]|】|〕)[:：][ \t]*([\s\S]*?)(?=(?:\n(?:\[|【|〔)\s*\^\s*(?:fn-)?)|(?:\n\n(?!\s{2,}))|$)/g,
      (_, rawId, defText) => {
        const cleanId = String(rawId).trim().replace(/^fn-/, '');
        if (!inlineTranslatedNotes[cleanId]) {
          inlineTranslatedNotes[cleanId] = String(defText).trim();
        }
        return '';
      }
    );

    const doc = parseHtmlDocument(originalXhtml);
    if (!doc.body) {
      return { html: originalXhtml, leafCount: 0 };
    }

    this.decomposeBlockquotes(doc.body);

    // Remove any pre-existing footnote popup asides to avoid duplication
    for (const existingAside of Array.from(doc.body.children)) {
      if (isFootnotePopupElement(existingAside)) {
        existingAside.remove();
      }
    }

    const leafElements = this.collectTranslatableLeafElements(doc.body);
    if (leafElements.length === 0) {
      return { html: doc.body.innerHTML, leafCount: 0 };
    }

    this.stampSemanticRoleClasses(doc.body, leafElements, cssProfiles);

    const extractedSourceBlocks = leafElements.map((el, idx) => {
      const { slottedText, leadingAnchorHtmls, footnoteIds } = this.extractLeafBlockContent(el);
      return {
        index: idx,
        el,
        slottedText,
        leadingAnchorHtmls,
        footnoteIds,
        isHeadingLike: isHeadingLikeElement(el, cssProfiles)
      };
    });
    const nonEmptyLeafCount = extractedSourceBlocks.filter((b) => b.slottedText.length > 0).length;

    const sourceSlottedTexts = extractedSourceBlocks.map((b) => b.slottedText);
    const effectiveSourceText =
      sourcePayloadWithSlots || sourceSlottedTexts.join('\n\n');

    // Sanitize rogue markdown block markers, images, and split dialogues merged with >>, >, or multi-line >
    const sanitizeBlockStructure = (raw: string) =>
      raw
        .replace(/!\[.*?\]\(.*?\)[\s\u00a0]*/g, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/(?:\r?\n)[ \t]*(?:>+[ \t]*)+/g, '\n\n')
        .replace(/\s*>>+\s*/g, '\n\n')
        .replace(/([。！？!?…\u201d\u300d\u300f])[ \t]*>+[ \t]*/g, '$1\n\n')
        .replace(/(?<=\s)>+[ \t]+/g, '\n\n')
        .replace(/^(?:[ \t]*>+[ \t]*)+/gm, '')
        .replace(/(?:^|[ \t]+)>+(?:[ \t]*>)*[ \t]*$/gm, '');

    cleanTarget = sanitizeBlockStructure(cleanTarget);

    let rawTargetParagraphs = cleanTarget
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const isPartialStream =
      isStreaming && rawTargetParagraphs.length > 0 && rawTargetParagraphs.length < extractedSourceBlocks.length;

    if (!isPartialStream && effectiveSourceText && cleanTarget) {
      const repaired = validateAndRepairSlots(effectiveSourceText, cleanTarget);
      if (repaired.repairedText !== cleanTarget) {
        cleanTarget = sanitizeBlockStructure(repaired.repairedText);
        rawTargetParagraphs = cleanTarget
          .split(/\r?\n\s*\r?\n/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
      }
    }

    rawTargetParagraphs = rawTargetParagraphs.map((p) => this.sanitizeTargetHtml(p));

    // Backwards-compatibility for pre-existing cached translations generated before
    // `isImmutableNumberCell` skipped `title-num` cells: if the first block is inside a
    // `title-table` with a skipped `title-num` cell and `rawTargetParagraphs[0]` is a
    // standalone chapter-number token (e.g. "第二章", "2", "Chapter 2"), consume it so
    // the cached title and body paragraphs align 1-to-1 without shifting.
    if (
      !isPartialStream &&
      rawTargetParagraphs.length > 1 &&
      extractedSourceBlocks.length > 0 &&
      extractedSourceBlocks[0].el.closest('[data-translit-role="title-table"]')?.querySelector('[data-translit-role="title-num"]')
    ) {
      const firstTargetClean = rawTargetParagraphs[0].replace(/^#{1,6}\s+/, '').trim();
      const firstSourceClean = sourceSlottedTexts[0].replace(/^#{1,6}\s+/, '').trim();
      const isStandaloneChapNum =
        /^(?:第\s*[零一二三四五六七八九十百千万\d]+\s*[章节部篇]|[Cc]hapter\s+\d+|(?:\d+|[IVXLCDM]+)\.?)$/i;
      if (isStandaloneChapNum.test(firstTargetClean) && !isStandaloneChapNum.test(firstSourceClean)) {
        rawTargetParagraphs = rawTargetParagraphs.slice(1);
      }
    }

    // Align extractedSourceBlocks (N) with rawTargetParagraphs (M)
    const alignedTargetTexts = isPartialStream
      ? [
          ...rawTargetParagraphs,
          ...sourceSlottedTexts.slice(rawTargetParagraphs.length)
        ]
      : this.alignTargetParagraphsToDomBlocks(
          sourceSlottedTexts,
          rawTargetParagraphs,
          extractedSourceBlocks.map((b) => b.isHeadingLike)
        );

    // Track footnote citations in chapter order
    const orderedIds: string[] = [];
    const idToDisplayNumber = new Map<string, number>();
    const idCitationCount = new Map<string, number>();

    const hasBackingFootnote = (id: string): boolean => {
      const text =
        inlineTranslatedNotes[id] ||
        inlineTranslatedNotes[`fn-${id}`] ||
        internalizedFootnotes[id]?.plainText ||
        internalizedFootnotes[`fn-${id}`]?.plainText ||
        '';
      return text.trim().length > 0;
    };

    const getDisplayNum = (id: string) => {
      let num = idToDisplayNumber.get(id);
      if (!num) {
        num = orderedIds.length + 1;
        idToDisplayNumber.set(id, num);
        orderedIds.push(id);
      }
      return num;
    };

    const renderFootnoteSlotsInHtml = (
      htmlFragment: string,
      isSourceInBilingual: boolean
    ): string => {
      const replacer = (_match: string, rawId: string) => {
        const id = String(rawId).trim().replace(/^fn-/, '');
        if (!hasBackingFootnote(id)) {
          return '';
        }
        const displayNum = getDisplayNum(id);
        const countKey = isSourceInBilingual ? `src-${id}` : `tgt-${id}`;
        const prevCount = idCitationCount.get(countKey) || 0;
        idCitationCount.set(countKey, prevCount + 1);

        const refIdAttr = isSourceInBilingual
          ? prevCount === 0
            ? `fnref-src-${id}`
            : `fnref-src-${id}-${prevCount + 1}`
          : prevCount === 0
            ? `fnref-${id}`
            : `fnref-${id}-${prevCount + 1}`;
        const hrefTarget = isSourceInBilingual ? `#fn-src-${id}` : `#fn-${id}`;

        if (wereadMode) {
          const rawNoteText = isSourceInBilingual
            ? internalizedFootnotes[id]?.plainText ||
              internalizedFootnotes[`fn-${id}`]?.plainText ||
              inlineTranslatedNotes[id] ||
              ''
            : inlineTranslatedNotes[id] ||
              inlineTranslatedNotes[`fn-${id}`] ||
              internalizedFootnotes[id]?.plainText ||
              internalizedFootnotes[`fn-${id}`]?.plainText ||
              '';
          const cleanAlt = escapeXml(rawNoteText.replace(/\s+/g, ' ').trim());
          return `<a id="${refIdAttr}" href="${hrefTarget}" epub:type="noteref" class="noteref duokan-footnote footnote" data-num="${displayNum}"><img class="qqreader-footnote" src="${imagesRelPath}note.png" alt="${cleanAlt}"/></a>`;
        }

        return `<a id="${refIdAttr}" href="${hrefTarget}" epub:type="noteref" class="noteref duokan-footnote footnote" data-num="${displayNum}"><sup>[${displayNum}]</sup></a>`;
      };

      return htmlFragment
        .replace(/__FN_REF_([A-Za-z0-9_-]+?)__/g, replacer)
        .replace(/\{\{TRANSLITFNSLOT:([A-Za-z0-9_-]+)\}\}/g, replacer)
        .replace(/\[\^(?:fn-)?([A-Za-z0-9_-]+)\]/g, replacer);
    };

    const isBilingual = bilingualMode === 'source_first' || bilingualMode === 'target_first';

    for (let i = 0; i < extractedSourceBlocks.length; i++) {
      const blockInfo = extractedSourceBlocks[i];
      const el = blockInfo.el;
      const isUntranslatedStreamTail = isPartialStream && i >= rawTargetParagraphs.length;
      const targetRaw = alignedTargetTexts[i] ?? blockInfo.slottedText;
      const shouldFormatTargetHeti = applyChineseTypography && !isUntranslatedStreamTail;

      if (!isBilingual) {
        // Monolingual In-Place Mutation: keep element, classes, IDs, leading anchors, and inner wrapper shell intact
        const formattedTarget = this.formatInlineMarkup(targetRaw);
        const renderedTargetHtml = renderFootnoteSlotsInHtml(
          shouldFormatTargetHeti ? applyHetiTextTypography(formattedTarget) : formattedTarget,
          false
        );
        this.writeHtmlIntoLeafElement(el, renderedTargetHtml);
      } else {
        // Bilingual In-Place Cloning
        const renderedSourceHtml = this.formatInlineMarkup(
          renderFootnoteSlotsInHtml(blockInfo.slottedText, true)
        );
        const formattedTarget = this.formatInlineMarkup(targetRaw);
        const renderedTargetHtml = renderFootnoteSlotsInHtml(
          shouldFormatTargetHeti ? applyHetiTextTypography(formattedTarget) : formattedTarget,
          false
        );

        // If source and target are identical (e.g. pure number "1" in table.title2 td.bor1), do not duplicate!
        if (
          blockInfo.slottedText.trim() === targetRaw.trim() &&
          /^[\d\W]+$/.test(blockInfo.slottedText.trim())
        ) {
          this.writeHtmlIntoLeafElement(el, renderedTargetHtml);
          continue;
        }

        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'TD' || tag === 'TH') {
          // Inside a table cell (e.g., <td class="top"><small class="calibre6">...</small></td>),
          // clone the inner content block inside the same <td> and insert a <br/> so they stack vertically!
          const innerTarget = this.resolveInnerWrapperTarget(el);
          if (innerTarget !== el) {
            const sourceInner = innerTarget;
            const targetInner = innerTarget.cloneNode(true) as Element;
            const brEl = doc.createElement('br');
            this.stripIdsFromClone(targetInner);
            sourceInner.classList.add('bilingual-source');
            targetInner.classList.add('bilingual-target');
            sourceInner.innerHTML = renderedSourceHtml;
            targetInner.innerHTML = renderedTargetHtml;
            if (bilingualMode === 'source_first') {
              sourceInner.insertAdjacentElement('afterend', brEl);
              brEl.insertAdjacentElement('afterend', targetInner);
            } else {
              sourceInner.insertAdjacentElement('beforebegin', targetInner);
              targetInner.insertAdjacentElement('afterend', brEl);
            }
          } else {
            const srcDiv = doc.createElement('div');
            srcDiv.className = 'bilingual-source';
            srcDiv.innerHTML = renderedSourceHtml;
            const tgtDiv = doc.createElement('div');
            tgtDiv.className = 'bilingual-target';
            tgtDiv.innerHTML = renderedTargetHtml;
            this.writeHtmlIntoLeafElement(
              el,
              bilingualMode === 'source_first'
                ? `${srcDiv.outerHTML}\n${tgtDiv.outerHTML}`
                : `${tgtDiv.outerHTML}\n${srcDiv.outerHTML}`
            );
          }
        } else if (tag === 'LI' || tag === 'DT' || tag === 'DD') {
          const sourceEl = el;
          const targetEl = el.cloneNode(true) as Element;
          this.stripIdsFromClone(targetEl);

          sourceEl.classList.add('bilingual-source');
          targetEl.classList.add('bilingual-target');

          this.writeHtmlIntoLeafElement(sourceEl, renderedSourceHtml);
          this.writeHtmlIntoLeafElement(targetEl, renderedTargetHtml, true);

          if (bilingualMode === 'source_first') {
            sourceEl.insertAdjacentElement('afterend', targetEl);
          } else {
            sourceEl.insertAdjacentElement('beforebegin', targetEl);
          }
        } else {
          // Standard block (<p class="sec1-titlea">, <p class="flush-left">, <h1>, <blockquote>, etc.):
          // Clone the exact DOM element in-place so BOTH source and target keep original classes,
          // wrapped inside a <div class="bilingual-pair"> container!
          const sourceEl = el;
          const targetEl = el.cloneNode(true) as Element;
          this.stripIdsFromClone(targetEl);

          sourceEl.classList.add('bilingual-source');
          targetEl.classList.add('bilingual-target');

          this.writeHtmlIntoLeafElement(sourceEl, renderedSourceHtml);
          this.writeHtmlIntoLeafElement(targetEl, renderedTargetHtml, true);

          const pairWrapper = doc.createElement('div');
          pairWrapper.className = 'bilingual-pair';
          sourceEl.parentNode?.insertBefore(pairWrapper, sourceEl);

          if (bilingualMode === 'source_first') {
            pairWrapper.appendChild(sourceEl);
            pairWrapper.appendChild(targetEl);
          } else {
            pairWrapper.appendChild(targetEl);
            pairWrapper.appendChild(sourceEl);
          }
        }
      }
    }

    // Serialize body innerHTML and normalize XHTML self-closing void tags
    let htmlBody = doc.body.innerHTML
      .replace(/<br\b([^>]*)>/gi, (m, attrs) =>
        attrs.trim().endsWith('/') ? m : `<br${attrs}/>`
      )
      .replace(/<hr\b([^>]*)>/gi, (m, attrs) =>
        attrs.trim().endsWith('/') ? m : `<hr${attrs}/>`
      )
      .replace(/<img\b([^>]*)>/gi, (m, attrs) =>
        attrs.trim().endsWith('/') ? m : `<img${attrs}/>`
      );

    // Append standard EPUB 3 <aside epub:type="footnote" class="footnote-popup"> nodes
    if (orderedIds.length > 0) {
      const asideBlocks: string[] = [];
      for (const id of orderedIds) {
        const displayNum = idToDisplayNumber.get(id)!;

        // Target (translated) footnote aside
        const rawTargetText =
          inlineTranslatedNotes[id] ||
          inlineTranslatedNotes[`fn-${id}`] ||
          internalizedFootnotes[id]?.plainText ||
          internalizedFootnotes[`fn-${id}`]?.plainText ||
          '';
        asideBlocks.push(buildFootnoteAsideHtml(id, displayNum, rawTargetText, false));

        // In bilingual mode, also emit source (original) footnote aside (#fn-src-{id})
        if (isBilingual) {
          const rawSourceText =
            internalizedFootnotes[id]?.plainText ||
            internalizedFootnotes[`fn-${id}`]?.plainText ||
            inlineTranslatedNotes[id] ||
            '';
          asideBlocks.push(buildFootnoteAsideHtml(id, displayNum, rawSourceText, true));
        }
      }

      htmlBody = `${htmlBody.trim()}\n\n${asideBlocks.join('\n\n')}`;
    }

    return { html: htmlBody, leafCount: nonEmptyLeafCount };
  }

  private writeHtmlIntoLeafElement(
    el: Element,
    newInnerHtml: string,
    removeLeadingPagebreakAnchors: boolean = false
  ): void {
    // Preserve leading empty pagebreak anchors (<a id="p17" class="calibre4"></a>) on the primary element
    const savedAnchors: Element[] = [];
    while (el.firstChild) {
      const first = el.firstChild;
      if (first.nodeType === 3) {
        const raw = first.textContent || '';
        const stripped = raw.replace(/^[\s\u00a0]+/, '');
        if (stripped.length === 0) {
          el.removeChild(first);
          continue;
        } else {
          break;
        }
      } else if (isEmptyPagebreakAnchor(first)) {
        if (!removeLeadingPagebreakAnchors) {
          savedAnchors.push(first.cloneNode(true) as Element);
        }
        el.removeChild(first);
      } else {
        break;
      }
    }

    const innerWrapper = this.resolveInnerWrapperTarget(el);
    if (innerWrapper !== el) {
      innerWrapper.innerHTML = newInnerHtml;
    } else {
      el.innerHTML = newInnerHtml;
    }

    // Re-prepend saved pagebreak anchors to `el`
    for (let i = savedAnchors.length - 1; i >= 0; i--) {
      el.insertBefore(savedAnchors[i], el.firstChild);
    }
  }

  private stripIdsFromClone(el: Element): void {
    if (el.hasAttribute('id')) {
      el.removeAttribute('id');
    }
    for (const child of Array.from(el.querySelectorAll('[id], a[name]'))) {
      child.removeAttribute('id');
      child.removeAttribute('name');
    }
  }

  public sanitizeTargetHtml(html: string): string {
    return html
      .replace(/!\[.*?\]\(.*?\)[\s\u00a0]*/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/(?:\r?\n)[ \t]*(?:>+[ \t]*)+/g, '<br/>')
      .replace(/\s*>>+\s*/g, '<br/>')
      .replace(/([。！？!?…\u201d\u300d\u300f])[ \t]*>+[ \t]*/g, '$1<br/>')
      .replace(/(?<=\s)>+[ \t]+/g, '')
      .replace(/^(?:[ \t]*>+[ \t]*)+/gm, '')
      .replace(/(?:^|[ \t]+)>+(?:[ \t]*>)*[ \t]*$/gm, '')
      .trim();
  }

  private formatInlineMarkup(text: string): string {
    const sanitized = this.sanitizeTargetHtml(text);
    // Convert any accidental Markdown **bold** or *italic* emitted by LLM into HTML tags
    return sanitized
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  }

  /**
   * Aligns M translated paragraphs back onto the N original DOM leaf blocks.
   * When N === M (the 99% case), performs a direct 1-to-1 mapping.
   * When N !== M (e.g. LLM merged or split a paragraph), uses dynamic programming
   * weighted by footnote slot overlap, heading constraints, and length ratio so every
   * original DOM block receives its corresponding translated text without dropping anything.
   */
  public alignTargetParagraphsToDomBlocks(
    sourceTexts: string[],
    targetTexts: string[],
    isHeadingFlags: boolean[]
  ): string[] {
    const N = sourceTexts.length;
    const M = targetTexts.length;

    if (N === 0) return [];
    if (M === 0) return [...sourceTexts];
    if (N === M) return [...targetTexts];

    // DP to map M target paragraphs onto N source DOM blocks
    const dp: Array<Array<{ cost: number; prevI: number; prevJ: number }>> = [];
    for (let i = 0; i <= N; i++) {
      dp[i] = [];
      for (let j = 0; j <= M; j++) {
        dp[i][j] = { cost: Infinity, prevI: -1, prevJ: -1 };
      }
    }
    dp[0][0] = { cost: 0, prevI: -1, prevJ: -1 };

    const scorePair = (sIndices: number[], tIndices: number[]): number => {
      const sText = sIndices.map((idx) => sourceTexts[idx]).join(' ');
      const tText = tIndices.map((idx) => targetTexts[idx]).join(' ');
      let cost = 0;

      const sClean = sText.replace(/^#{1,6}\s+/, '').trim();
      const tClean = tText.replace(/^#{1,6}\s+/, '').trim();

      // Heading blocks strongly anchor 1-to-1 alignment and reject body paragraphs
      const hasHeading = sIndices.some((idx) => isHeadingFlags[idx]);
      if (hasHeading) {
        if (sIndices.length > 1 || tIndices.length > 1) {
          cost += 120;
        } else {
          const sEndsSentence = /[。！？.!?]$/.test(sClean);
          const tEndsSentence = /[。！？.!?]$/.test(tClean);
          const isShortTitleLike = tClean.length > 0 && tClean.length <= 45 && (!tEndsSentence || sEndsSentence);
          if (isShortTitleLike) {
            cost -= 45;
          } else {
            cost += 140;
          }
        }
      } else {
        if (
          sIndices.length === 1 &&
          tIndices.length === 1 &&
          sClean.length > 80 &&
          tClean.length > 0 &&
          tClean.length <= 28 &&
          !/[。！？.!?]$/.test(tClean)
        ) {
          cost += 65;
        }
      }

      // Footnote slot match bonus
      const sSlots = new Set(extractFootnoteSlots(sText));
      const tSlots = new Set(extractFootnoteSlots(tText));
      for (const slot of sSlots) {
        if (tSlots.has(slot)) {
          cost -= 40;
        } else {
          cost += 25;
        }
      }

      // Length ratio (English/Latin -> CJK averages ~2.3x character count)
      const diff = Math.abs(sClean.length - tClean.length * 2.3) / Math.max(sClean.length, 16);
      cost += Math.min(diff * 14, 35);

      if (sIndices.length === 1 && tIndices.length === 1) {
        cost -= 5;
      } else {
        cost += 12;
      }

      return cost;
    };

    for (let i = 0; i < N; i++) {
      for (let j = 0; j <= M; j++) {
        const cur = dp[i][j].cost;
        if (cur === Infinity) continue;

        // 1 source block <- 1 target paragraph
        if (j + 1 <= M) {
          const c = cur + scorePair([i], [j]);
          if (c < dp[i + 1][j + 1].cost) {
            dp[i + 1][j + 1] = { cost: c, prevI: i, prevJ: j };
          }
        }
        // 1 source block <- 2 target paragraphs
        if (j + 2 <= M) {
          const c = cur + scorePair([i], [j, j + 1]);
          if (c < dp[i + 1][j + 2].cost) {
            dp[i + 1][j + 2] = { cost: c, prevI: i, prevJ: j };
          }
        }
        // 1 source block <- 3 target paragraphs
        if (j + 3 <= M) {
          const c = cur + scorePair([i], [j, j + 1, j + 2]);
          if (c < dp[i + 1][j + 3].cost) {
            dp[i + 1][j + 3] = { cost: c, prevI: i, prevJ: j };
          }
        }
        // 2 source blocks <- 1 target paragraph
        if (i + 2 <= N && j + 1 <= M) {
          const c = cur + scorePair([i, i + 1], [j]);
          if (c < dp[i + 2][j + 1].cost) {
            dp[i + 2][j + 1] = { cost: c, prevI: i, prevJ: j };
          }
        }
        // 1 source block <- 0 target paragraphs (fallback to empty or source if target exhausted)
        const cSkip = cur + 35;
        if (cSkip < dp[i + 1][j].cost) {
          dp[i + 1][j] = { cost: cSkip, prevI: i, prevJ: j };
        }
      }
    }

    const result = new Array<string>(N).fill('');
    let currI = N;
    let currJ = M;

    while (currI > 0) {
      const step = dp[currI][currJ];
      if (!step || step.prevI === -1) {
        // Proportional fallback: preserve all M target segments across N source slots
        for (let k = 0; k < N; k++) {
          const startIdx = Math.floor((k * M) / N);
          const endIdx = Math.floor(((k + 1) * M) / N);
          if (endIdx > startIdx) {
            result[k] = targetTexts.slice(startIdx, endIdx).join(' ');
          } else {
            result[k] = targetTexts[Math.min(startIdx, M - 1)] ?? sourceTexts[k];
          }
        }
        return result;
      }
      const { prevI, prevJ } = step;
      const sCount = currI - prevI;
      const tCount = currJ - prevJ;

      if (sCount === 1 && tCount >= 1) {
        result[prevI] = targetTexts.slice(prevJ, currJ).join(' ');
      } else if (sCount === 2 && tCount === 1) {
        const combined = targetTexts[prevJ];
        // Split combined Chinese paragraph at midpoint sentence boundary if possible
        const mid = Math.floor(combined.length / 2);
        const punctIdx = combined.indexOf('。', mid - 15);
        if (punctIdx > 0 && punctIdx < combined.length - 1) {
          result[prevI] = combined.slice(0, punctIdx + 1).trim();
          result[prevI + 1] = combined.slice(punctIdx + 1).trim();
        } else {
          result[prevI] = combined;
          result[prevI + 1] = '';
        }
      } else if (sCount === 1 && tCount === 0) {
        result[prevI] = sourceTexts[prevI];
      }

      currI = prevI;
      currJ = prevJ;
    }

    return result;
  }
}
