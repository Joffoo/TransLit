import {
  BilingualMode,
  BookStyleRoleMap,
  CssClassSemanticMapping,
  FootnoteNode
} from '../types';
import { parseHtmlDocument } from '../utils/domAdapter';
import {
  createFootnoteSlot,
  extractFootnoteSlots,
  stripLeakedFootnoteDefinitions,
  validateAndRepairSlots
} from './footnotePool';
import { stripBlockProtocolMarkers } from '../utils/blockProtocol';
import {
  BLOCK_LEVEL_TAGS,
  LEAF_CANDIDATE_TAGS,
  NON_TRANSLATABLE_SUBTREE_TAGS,
  EMPTY_MARKER_VOID_TAGS,
  FOOTNOTE_INLINE_TAG_SET,
  LEAF_INLINE_TAG_SET,
  STRIP_SHELL_HTML_TAGS,
  buildBlockDescendantIndex,
  isBlockBoundaryElement
} from '../utils/htmlStructure';

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
  paddingLeftEm?: number;
  listStyleNone?: boolean;
  textTransform?: 'uppercase' | 'capitalize' | 'lowercase' | 'none';
  fontVariant?: 'small-caps' | 'normal';
  letterSpacingEm?: number;
  hasBorder?: boolean;
  hasBorderBottom?: boolean;
  isInlineOnly?: boolean;
  inlineDisplayBlock?: boolean;
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
  paddingLeftEm?: number;
  listStyleNone?: boolean;
  textTransform?: 'uppercase' | 'capitalize' | 'lowercase' | 'none';
  fontVariant?: 'small-caps' | 'normal';
  letterSpacingEm?: number;
  hasBorder?: boolean;
  hasBorderBottom?: boolean;
  displayBlock?: boolean;
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
  bookStyleRoles?: BookStyleRoleMap;
  applyChineseTypography?: boolean;
  isStreaming?: boolean;
}

export interface StructuralTreeDiffResult {
  diffCount: number;
  diffs: string[];
}

export const EXCLUDED_PSEUDO_HEADING_CLASSES =
  /(?:^|[\s_-])(?:caption|fig|figcaption|bib|toc|copyright|epigraph|dedication|footnote|endnote|noteref|note|quote|blockquote|bq|extract|ext|callout|box|sidebar|plaque|inscription|verse|poem|poetry|letter|motto|sign|signature|attribution|credit|dropcap|stickupcap|initial|firstletter)\d*(?:$|[\s_-])/i;

const INLINE_CSS_SELECTOR_TAGS = new Set([
  'SPAN',
  'A',
  'B',
  'STRONG',
  'I',
  'EM',
  'SMALL',
  'BIG',
  'SUP',
  'SUB',
  'U',
  'ABBR',
  'CITE',
  'CODE',
  'FONT'
]);

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
          if (prop === 'border-bottom') {
            result.hasBorderBottom = true;
          }
        }
        break;
      }
      case 'display': {
        if (rawVal === 'none') {
          result.displayNone = true;
          result.displayBlock = false;
        } else {
          if (result.displayNone) {
            result.displayNone = false;
          }
          result.displayBlock =
            rawVal === 'block' || rawVal === 'list-item' || rawVal === 'flex' || rawVal === 'grid';
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
      case 'padding-left': {
        const em = parseCssLengthToEm(rawVal);
        if (em !== undefined) result.paddingLeftEm = em;
        break;
      }
      case 'list-style-type':
      case 'list-style': {
        result.listStyleNone = /\bnone\b/.test(rawVal);
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

  const mergeProfile = (
    className: string,
    parsed: Partial<ElementVisualStyle>,
    isInlineSelectorTag: boolean,
    targetTag: string
  ) => {
    const existing = profiles.get(className) || { className };
    if (parsed.fontSizeEm !== undefined) existing.fontSizeEm = parsed.fontSizeEm;
    if (parsed.fontWeight !== undefined) existing.fontWeight = parsed.fontWeight;
    if (parsed.fontStyle !== undefined) existing.fontStyle = parsed.fontStyle;
    if (parsed.textAlign !== undefined) existing.textAlign = parsed.textAlign;
    if (parsed.textIndentEm !== undefined) existing.textIndentEm = parsed.textIndentEm;
    if (parsed.marginTopEm !== undefined) existing.marginTopEm = parsed.marginTopEm;
    if (parsed.marginBottomEm !== undefined) existing.marginBottomEm = parsed.marginBottomEm;
    if (parsed.marginLeftEm !== undefined) existing.marginLeftEm = parsed.marginLeftEm;
    if (parsed.paddingLeftEm !== undefined) existing.paddingLeftEm = parsed.paddingLeftEm;
    if (parsed.listStyleNone !== undefined) existing.listStyleNone = parsed.listStyleNone;
    if (parsed.textTransform !== undefined) existing.textTransform = parsed.textTransform;
    if (parsed.fontVariant !== undefined) existing.fontVariant = parsed.fontVariant;
    if (parsed.letterSpacingEm !== undefined) existing.letterSpacingEm = parsed.letterSpacingEm;
    if (parsed.hasBorder !== undefined) existing.hasBorder = parsed.hasBorder;
    if (parsed.hasBorderBottom !== undefined) existing.hasBorderBottom = parsed.hasBorderBottom;
    if (parsed.displayNone !== undefined) existing.displayNone = parsed.displayNone;
    if (parsed.displayBlock !== undefined && (!targetTag || isInlineSelectorTag)) {
      existing.inlineDisplayBlock = parsed.displayBlock;
    }
    if (isInlineSelectorTag) {
      if (existing.isInlineOnly === undefined) existing.isInlineOnly = true;
    } else {
      existing.isInlineOnly = false;
    }
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
        const tagMatch = targetCompound.match(/^([A-Za-z][A-Za-z0-9]*)/);
        const targetTag = tagMatch ? tagMatch[1].toUpperCase() : '';
        const isInlineSelectorTag = Boolean(targetTag && INLINE_CSS_SELECTOR_TAGS.has(targetTag));
        const classMatches = targetCompound.match(/\.([A-Za-z_-][A-Za-z0-9_-]*)/g);
        if (!classMatches) continue;

        for (const clsToken of classMatches) {
          const className = clsToken.slice(1);
          mergeProfile(className, parsed, isInlineSelectorTag, targetTag);
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
      if (p.paddingLeftEm !== undefined) style.paddingLeftEm = p.paddingLeftEm;
      if (p.listStyleNone !== undefined) style.listStyleNone = p.listStyleNone;
      if (p.hasBorder !== undefined) style.hasBorder = p.hasBorder;
      if (p.hasBorderBottom !== undefined) style.hasBorderBottom = p.hasBorderBottom;
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

/**
 * Returns an element's visible text with Japanese/CJK `<ruby>` phonetic annotations
 * (`<rt>`, `<rp>`, `<rtc>`) excluded. Fast-paths to `el.textContent` when no ruby nodes exist.
 */
export function getCleanElementText(el: Element | null | undefined): string {
  if (!el) return '';
  if (!el.querySelector('rt, rp, rtc')) {
    return el.textContent || '';
  }
  const clone = el.cloneNode(true) as Element;
  for (const rubyMeta of Array.from(clone.querySelectorAll('rt, rp, rtc'))) {
    rubyMeta.remove();
  }
  return clone.textContent || '';
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
  if (EMPTY_MARKER_VOID_TAGS.has(tag)) {
    const text = (el.textContent || '').replace(/\u00a0/g, '').trim();
    return text.length === 0 && !el.querySelector('img, svg, image');
  }
  if (tag !== 'A' && tag !== 'SPAN') return false;
  if (isNoterefAnchor(el)) return false;
  const text = (el.textContent || '').replace(/\u00a0/g, '').trim();
  if (text.length > 0) return false;
  if (el.querySelector('img, svg, image')) return false;
  return Boolean(
    el.getAttribute('id') ||
      el.getAttribute('name') ||
      el.getAttribute('role') ||
      el.getAttribute('epub:type') ||
      el.getAttribute('aria-label')
  );
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

const INLINE_STYLE_ROLES = new Set<string>(['emphasis', 'strong', 'dropcap', 'code', 'ignore']);

export function resolveElementBookStyleMapping(
  el: Element,
  bookStyleRoles?: BookStyleRoleMap
): CssClassSemanticMapping | undefined {
  if (!bookStyleRoles) return undefined;
  const clsList = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  if (clsList.length === 0) return undefined;

  const isInlineEl = INLINE_CSS_SELECTOR_TAGS.has((el.tagName || '').toUpperCase());
  let sawIgnore = false;

  for (const cls of clsList) {
    const mapping = bookStyleRoles[cls];
    if (!mapping) continue;
    const isInlineRole = INLINE_STYLE_ROLES.has(mapping.role);
    if (mapping.scope === 'inline' && !isInlineEl) continue;
    if (mapping.scope === 'block' && isInlineEl) continue;
    if (!mapping.scope && isInlineEl !== isInlineRole && mapping.role !== 'ignore') continue;
    if (mapping.role === 'ignore') {
      sawIgnore = true;
      continue;
    }
    return mapping;
  }

  return sawIgnore ? { role: 'ignore', scope: isInlineEl ? 'inline' : 'block' } : undefined;
}

type HeadingDetectionLayer = 'none' | 'native' | 'ai-style' | 'semantic-class' | 'visual-heuristic';

interface HeadingDetectionResult {
  level: number;
  layer: HeadingDetectionLayer;
  isHeadingLikeAnchor: boolean;
}

const STANDALONE_STRUCTURAL_LABEL_RE =
  /^(?:§\s*\d+|Chapter\s+[\dIVXLCDM]+|Chapter\s+(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)|Part\s+[\dIVXLCDM]+|Part\s+(?:One|Two|Three|Four|Five|Six)|Section\s+[\dIVXLCDM]+|Book\s+[\dIVXLCDM]+|第[零一二三四五六七八九十百千万\d]+[章节篇部卷]|(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)\.?|\d{1,3}\.?)$/i;

function detectHeadingWithLayer(
  el: Element,
  cssProfiles?: Map<string, CssClassProfile>,
  bookStyleRoles?: BookStyleRoleMap
): HeadingDetectionResult {
  const tag = (el.tagName || '').toUpperCase();
  const hMatch = tag.match(/^H([1-6])$/);
  if (hMatch) {
    return { level: Number(hMatch[1]), layer: 'native', isHeadingLikeAnchor: true };
  }

  const cls = el.getAttribute('class') || '';
  const parentTable = el.closest('table');
  if (parentTable && !isStructuralTitleTable(parentTable)) {
    return { level: 0, layer: 'native', isHeadingLikeAnchor: false };
  }
  if (parentTable && isStructuralTitleTable(parentTable)) {
    if (isImmutableNumberCell(el) || /\b(bor1?|num)\b/i.test(cls)) {
      return { level: 0, layer: 'native', isHeadingLikeAnchor: false };
    }
    if (/\b(top-int1|top2|subtitle|subhead)\b/i.test(cls)) {
      return { level: 2, layer: 'native', isHeadingLikeAnchor: true };
    }
    const cell = el.closest('td, th');
    if (cell && el !== cell) {
      const siblingBlocks = Array.from(cell.children).filter((c) =>
        BLOCK_LEVEL_TAGS.has((c.tagName || '').toUpperCase())
      );
      if (siblingBlocks.indexOf(el) > 0) {
        return { level: 2, layer: 'native', isHeadingLikeAnchor: true };
      }
    }
    return { level: 1, layer: 'native', isHeadingLikeAnchor: true };
  }

  // Layer 1.5: Whole-book AI / semantic style mapping
  const mappedStyle = resolveElementBookStyleMapping(el, bookStyleRoles);
  if (mappedStyle && mappedStyle.role !== 'ignore') {
    if (
      mappedStyle.role === 'h1' ||
      mappedStyle.role === 'h2' ||
      mappedStyle.role === 'h3' ||
      mappedStyle.role === 'h4'
    ) {
      return {
        level: Number(mappedStyle.role.slice(1)),
        layer: 'ai-style',
        isHeadingLikeAnchor: true
      };
    }
    if (mappedStyle.role === 'subtitle') {
      return { level: 2, layer: 'ai-style', isHeadingLikeAnchor: true };
    }
    if (mappedStyle.role === 'kicker') {
      return { level: 0, layer: 'ai-style', isHeadingLikeAnchor: true };
    }
    return { level: 0, layer: 'ai-style', isHeadingLikeAnchor: false };
  }

  // Layer 2: Explicit semantic heading class names
  if (
    /\b(part-title[a-z0-9]*|fm-title[a-z0-9]*|bm-title[a-z0-9]*|book-title|halftitle|half-title|chap-title[a-z0-9]*|chapter-title[a-z0-9]*|chapter-head|chapter-number|top-int\b|top\b|title1\b|h1\b)/i.test(
      cls
    )
  ) {
    return { level: 1, layer: 'semantic-class', isHeadingLikeAnchor: true };
  }
  if (
    /\b(sec1-title[a-z0-9]*|sec-title[a-z0-9]*|section-title|sub-title|subtitle\b|head\b|heading\b|title2\b|authorleft\b|h2\b)/i.test(
      cls
    )
  ) {
    return { level: 2, layer: 'semantic-class', isHeadingLikeAnchor: true };
  }
  if (/\b(sec2-title[a-z0-9]*|sec3-title[a-z0-9]*|subhead\b|h3\b|h4\b)/i.test(cls)) {
    return { level: 3, layer: 'semantic-class', isHeadingLikeAnchor: true };
  }

  // Layer 3: Multi-dimensional weighted visual feature scoring for pseudo-headings
  if (tag !== 'P' && tag !== 'DIV') {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }
  if (el.closest('blockquote')) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }
  if (EXCLUDED_PSEUDO_HEADING_CLASSES.test(cls)) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }

  const rawText = getCleanElementText(el).replace(/[\s\u00a0]+/g, ' ').trim();
  if (rawText.length === 0 || rawText.length > 120) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }
  // Hard negative text guards: salutations, dialogue quotes, dash attributions, multi-sentence prose
  if (/[,;，；:：—\-]$/.test(rawText)) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }
  if (/^["“‘「『'].*["”’」』']$/.test(rawText) || /^[-—–―]\s*/.test(rawText)) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }
  const internalSentenceBreaks = rawText.slice(0, -1).match(/[.!?。！？](?:\s|$)/g)?.length || 0;
  if (internalSentenceBreaks > 1 || (rawText.length > 60 && internalSentenceBreaks > 0)) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }
  const isStructuralPrefix =
    /^(?:§\s*\d+|Chapter\s+[\dIVXLCDM]+|Part\s+[\dIVXLCDM]+|Section\s+[\dIVXLCDM]+|第[零一二三四五六七八九十百千万\d]+[章节篇部卷]|(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)\.?|\d{1,2}\.\s+\S)/i.test(
      rawText
    );
  if (rawText.length > 45 && /[.。]$/.test(rawText) && !isStructuralPrefix) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }

  const style = resolveElementVisualStyle(el, cssProfiles);
  if (style.displayNone) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
  }
  // Negative text-indent indicates hanging-indent bib/toc/list; > 0.5em indicates standard indented body paragraph
  if (style.textIndentEm !== undefined && (style.textIndentEm < 0 || style.textIndentEm > 0.5)) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
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
    Boolean(style.hasBorderBottom);

  if (!hasVisualSignal) {
    return { level: 0, layer: 'none', isHeadingLikeAnchor: false };
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

  if (style.textIndentEm === 0) score += 0.4;

  if (
    style.textTransform === 'uppercase' ||
    style.fontVariant === 'small-caps' ||
    (style.letterSpacingEm ?? 0) >= 0.05 ||
    style.hasBorderBottom ||
    isAllCapsText
  ) {
    score += 1.2;
  }

  if (isStructuralPrefix) score += 1.8;

  if (/[.。!！]$/.test(rawText) && !isStructuralPrefix) score -= 1.6;

  let level = 0;
  if (fs >= 1.35 && score >= 3.5) level = 1;
  else if (score >= 3.0) level = 2;
  else if (score >= 2.3) level = 3;

  return level > 0
    ? { level, layer: 'visual-heuristic', isHeadingLikeAnchor: true }
    : { level: 0, layer: 'none', isHeadingLikeAnchor: false };
}

export function getHeadingMarkdownLevel(
  el: Element,
  cssProfiles?: Map<string, CssClassProfile>,
  bookStyleRoles?: BookStyleRoleMap
): number {
  return detectHeadingWithLayer(el, cssProfiles, bookStyleRoles).level;
}

export function isHeadingLikeElement(
  el: Element,
  cssProfiles?: Map<string, CssClassProfile>,
  bookStyleRoles?: BookStyleRoleMap
): boolean {
  const res = detectHeadingWithLayer(el, cssProfiles, bookStyleRoles);
  if (res.level > 0 || res.isHeadingLikeAnchor) return true;
  if (el.closest('table.title1, table.title2')) return true;
  return false;
}

export interface LeafHeadingAnalysis {
  headingLevels: Map<Element, number>;
  isHeadingLikeMap: Map<Element, boolean>;
  vetoedQuoteRuns: Element[][];
  vetoedQuotePos: Map<Element, 'first' | 'mid' | 'last' | 'single'>;
}

function getQuoteVisualSignature(
  el: Element,
  cssProfiles?: Map<string, CssClassProfile>
): {
  fs: number;
  bold: boolean;
  italic: boolean;
  align: string;
  caps: boolean;
  hasSignal: boolean;
} | null {
  const tag = (el.tagName || '').toUpperCase();
  if ((tag !== 'P' && tag !== 'DIV') || el.closest('blockquote')) return null;
  const cls = el.getAttribute('class') || '';
  if (EXCLUDED_PSEUDO_HEADING_CLASSES.test(cls)) return null;
  const rawText = getCleanElementText(el).replace(/[\s\u00a0]+/g, ' ').trim();
  if (rawText.length === 0 || rawText.length > 120) return null;

  const style = resolveElementVisualStyle(el, cssProfiles);
  if (style.displayNone) return null;
  if (style.textIndentEm !== undefined && (style.textIndentEm < 0 || style.textIndentEm > 0.5)) {
    return null;
  }

  const fs = style.fontSizeEm ?? 1;
  const bold = style.fontWeight === 'bold';
  const italic = style.fontStyle === 'italic';
  const align = style.textAlign || 'left';
  const isAllCapsText =
    rawText.length >= 4 &&
    rawText.length <= 80 &&
    /[A-Z]{3,}/.test(rawText) &&
    rawText === rawText.toUpperCase() &&
    !/^[0-9\W]+$/.test(rawText);
  const caps =
    style.fontVariant === 'small-caps' || style.textTransform === 'uppercase' || isAllCapsText;

  const hasSignal =
    fs > 1.04 ||
    bold ||
    italic ||
    align === 'center' ||
    caps ||
    (style.letterSpacingEm ?? 0) >= 0.05 ||
    Boolean(style.hasBorderBottom);

  if (!hasSignal) return null;
  return { fs, bold, italic, align, caps, hasSignal };
}

function quoteVisualSignaturesMatch(
  a: NonNullable<ReturnType<typeof getQuoteVisualSignature>>,
  b: NonNullable<ReturnType<typeof getQuoteVisualSignature>>
): boolean {
  return (
    Math.abs(a.fs - b.fs) <= 0.1 &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.align === b.align &&
    a.caps === b.caps
  );
}

/**
 * Resolves heading levels for a sequence of leaf elements while applying batch-level
 * consecutive short-line veto on Layer 3 visual-heuristic runs (preserving native h1-h6,
 * semantic heading classes, AI style mappings, and genuine structural double-line titles).
 */
export function resolveLeafHeadingAnalysis(
  leafElements: Element[],
  cssProfiles?: Map<string, CssClassProfile>,
  bookStyleRoles?: BookStyleRoleMap
): LeafHeadingAnalysis {
  const headingLevels = new Map<Element, number>();
  const isHeadingLikeMap = new Map<Element, boolean>();
  const vetoedQuoteRuns: Element[][] = [];
  const vetoedQuotePos = new Map<Element, 'first' | 'mid' | 'last' | 'single'>();

  const detections = leafElements.map((el) =>
    detectHeadingWithLayer(el, cssProfiles, bookStyleRoles)
  );
  leafElements.forEach((el, idx) => {
    const det = detections[idx];
    headingLevels.set(el, det.level);
    isHeadingLikeMap.set(
      el,
      det.level > 0 || det.isHeadingLikeAnchor || Boolean(el.closest('table.title1, table.title2'))
    );
  });

  // Precompute DOM order indices & separator positions to detect intervening img/hr/figure/table between leaf siblings
  const separatorOrders: number[] = [];
  const leafStartOrder = new Map<Element, number>();
  const leafEndOrder = new Map<Element, number>();
  const rootBody = leafElements[0]?.ownerDocument?.body;
  if (rootBody) {
    let seq = 0;
    const leafSet = new Set(leafElements);
    const walkOrder = (node: Element, insideLeaf: boolean) => {
      const start = ++seq;
      const isLeaf = leafSet.has(node);
      if (isLeaf) leafStartOrder.set(node, start);

      const tag = (node.tagName || '').toUpperCase();
      const cls = node.getAttribute('class') || '';
      if (
        !insideLeaf &&
        !isLeaf &&
        (tag === 'HR' ||
          tag === 'FIGURE' ||
          tag === 'TABLE' ||
          tag === 'SVG' ||
          (tag === 'IMG' && !/\bqqreader-footnote\b/i.test(cls)))
      ) {
        separatorOrders.push(start);
      }

      for (const child of Array.from(node.children)) {
        walkOrder(child, insideLeaf || isLeaf);
      }

      const end = ++seq;
      if (isLeaf) leafEndOrder.set(node, end);
    };
    walkOrder(rootBody, false);
  }

  const hasSeparatorBetween = (a: Element, b: Element): boolean => {
    const endA = leafEndOrder.get(a);
    const startB = leafStartOrder.get(b);
    if (endA === undefined || startB === undefined) return false;
    for (const sepSeq of separatorOrders) {
      if (sepSeq > endA && sepSeq < startB) return true;
    }
    return false;
  };

  // 1. Group explicit AI-mapped `quote` runs (outside <blockquote>) so adjacent quote paragraphs render seamlessly
  let i = 0;
  while (i < leafElements.length) {
    const mapped = resolveElementBookStyleMapping(leafElements[i], bookStyleRoles);
    if (mapped?.role === 'quote' && !leafElements[i].closest('blockquote, table')) {
      const run: Element[] = [leafElements[i]];
      let j = i + 1;
      while (j < leafElements.length) {
        const nextEl = leafElements[j];
        const nextMapped = resolveElementBookStyleMapping(nextEl, bookStyleRoles);
        if (
          nextMapped?.role !== 'quote' ||
          nextEl.closest('blockquote, table') ||
          hasSeparatorBetween(leafElements[j - 1], nextEl)
        ) {
          break;
        }
        run.push(nextEl);
        j++;
      }
      vetoedQuoteRuns.push(run);
      if (run.length === 1) {
        vetoedQuotePos.set(run[0], 'single');
      } else {
        run.forEach((node, idx) => {
          vetoedQuotePos.set(node, idx === 0 ? 'first' : idx === run.length - 1 ? 'last' : 'mid');
        });
      }
      i = j;
    } else {
      i++;
    }
  }

  // 2. Consecutive short-line veto for Layer 3 visual-heuristic runs
  i = 0;
  while (i < leafElements.length) {
    const det = detections[i];
    if (det.layer === 'native' || det.layer === 'semantic-class' || det.layer === 'ai-style') {
      i++;
      continue;
    }
    const sig = getQuoteVisualSignature(leafElements[i], cssProfiles);
    if (!sig) {
      i++;
      continue;
    }

    const runIndices: number[] = [i];
    let j = i + 1;
    while (j < leafElements.length) {
      const nextDet = detections[j];
      if (
        nextDet.layer === 'native' ||
        nextDet.layer === 'semantic-class' ||
        nextDet.layer === 'ai-style' ||
        hasSeparatorBetween(leafElements[j - 1], leafElements[j])
      ) {
        break;
      }
      const nextSig = getQuoteVisualSignature(leafElements[j], cssProfiles);
      if (!nextSig || !quoteVisualSignaturesMatch(sig, nextSig)) {
        break;
      }
      runIndices.push(j);
      j++;
    }

    const hasVisualHeadingCandidate = runIndices.some(
      (idx) => detections[idx].layer === 'visual-heuristic' && (headingLevels.get(leafElements[idx]) || 0) > 0
    );

    if (runIndices.length >= 2 && hasVisualHeadingCandidate) {
      const firstEl = leafElements[runIndices[0]];
      const firstText = (firstEl.textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      const firstStyle = resolveElementVisualStyle(firstEl, cssProfiles);
      const isExemptTwoLine =
        runIndices.length === 2 &&
        (STANDALONE_STRUCTURAL_LABEL_RE.test(firstText) ||
          (runIndices[0] === 0 && (firstStyle.fontSizeEm ?? 1) >= 1.35));

      if (!isExemptTwoLine) {
        const runEls = runIndices.map((idx) => leafElements[idx]);
        for (const el of runEls) {
          headingLevels.set(el, 0);
          isHeadingLikeMap.set(el, false);
        }
        vetoedQuoteRuns.push(runEls);
        runEls.forEach((el, rIdx) => {
          vetoedQuotePos.set(
            el,
            rIdx === 0 ? 'first' : rIdx === runEls.length - 1 ? 'last' : 'mid'
          );
        });
      }
    }

    i = j;
  }

  return { headingLevels, isHeadingLikeMap, vetoedQuoteRuns, vetoedQuotePos };
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
    /(<[^>]+>|https?:\/\/[^\s)>\]]+|__FN_REF_[A-Za-z0-9_-]+__|__IMG_\d+__|__MATH_\d+__|\{\{TRANSLITFNSLOT:[A-Za-z0-9_-]+\}\}|\[\^(?:fn-)?[A-Za-z0-9_-]+\]|\[注\d+\](?:\([^)]*\))?|&[a-zA-Z0-9#]+;)/g;
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

  const compareElements = (
    a: Element,
    b: Element,
    path: string,
    blockDescA: Set<Element>,
    blockDescB: Set<Element>
  ) => {
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
    const isLeafA = LEAF_CANDIDATE_TAGS.has(tagA) && !blockDescA.has(a);
    const isLeafB = LEAF_CANDIDATE_TAGS.has(tagB) && !blockDescB.has(b);
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
      compareElements(childrenA[i], childrenB[i], `${path}/${tagA}[${i}]`, blockDescA, blockDescB);
    }
  };

  if (origDoc.body || mutDoc.body) {
    const engine = new DomMutationEngine();
    if (origDoc.body) {
      engine.decomposeBlockquotes(origDoc.body);
      engine.normalizeMixedContentContainers(origDoc.body);
    }
    if (mutDoc.body) {
      engine.decomposeBlockquotes(mutDoc.body);
      engine.normalizeMixedContentContainers(mutDoc.body);
    }
  }

  if (origDoc.body && mutDoc.body) {
    const blockDescA = buildBlockDescendantIndex(origDoc.body, isFootnotePopupElement);
    const blockDescB = buildBlockDescendantIndex(mutDoc.body, isFootnotePopupElement);
    compareElements(origDoc.body, mutDoc.body, '/BODY', blockDescA, blockDescB);
  }

  return {
    diffCount: diffs.length,
    diffs
  };
}

interface InlineXhtmlSanitizeOptions {
  allowedTags: ReadonlySet<string>;
  allowClassAttr: boolean;
  stripUnmatchedAllowedTags: boolean;
  stripDisallowedHtmlShells?: boolean;
  allowSafeVoidImg?: boolean;
}

function buildSafeVoidImgHtml(attrsText: string): string | null {
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  const safeParts: string[] = [];
  let hasSafeSrc = false;
  let m: RegExpExecArray | null;

  const escapeAttr = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  while ((m = attrRe.exec(attrsText)) !== null) {
    const name = m[1].toLowerCase();
    const rawVal = (m[2] ?? m[3] ?? m[4] ?? '').replace(/^[“”‘’]+|[“”‘’]+$/g, '').trim();
    if (name === 'src') {
      if (!rawVal || /^(?:javascript|vbscript|data\s*:\s*text\/html):/i.test(rawVal)) {
        return null;
      }
      hasSafeSrc = true;
      safeParts.push(`src="${escapeAttr(rawVal)}"`);
    } else if (name === 'alt' || name === 'class' || name === 'role' || name === 'width' || name === 'height') {
      if (name === 'class' && !/^[A-Za-z0-9 _-]*$/.test(rawVal)) continue;
      safeParts.push(`${name}="${escapeAttr(rawVal)}"`);
    }
  }

  if (!hasSafeSrc) return null;
  return `<img ${safeParts.join(' ')}/>`;
}

function sanitizeInlineXhtmlCore(text: string, options: InlineXhtmlSanitizeOptions): string {
  if (!text) return '';
  const safeAmps = text.replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/gi,
    '&amp;'
  );

  type Token =
    | { kind: 'text'; raw: string }
    | {
        kind: 'tag';
        raw: string;
        tagName?: string;
        normalizedAttr?: string;
        normalizedVoidHtml?: string;
        isClose?: boolean;
        isVoidBr?: boolean;
        isAllowedInline?: boolean;
        stripShell?: boolean;
        valid?: boolean;
      };

  const tokens: Token[] = [];
  const pushDisallowedTag = (rawTag: string) => {
    const shellMatch = options.stripDisallowedHtmlShells
      ? rawTag.match(/^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?\/?\s*>$/)
      : null;
    const stripShell = Boolean(
      shellMatch && STRIP_SHELL_HTML_TAGS.has(shellMatch[1].toLowerCase())
    );
    tokens.push({ kind: 'tag', raw: rawTag, isAllowedInline: false, stripShell, valid: false });
  };

  const tagRe = /<[^<>]*>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(safeAmps)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', raw: safeAmps.slice(lastIndex, match.index) });
    }
    const rawTag = match[0];
    if (/^<\s*br(?:\s+[^<>]*)?\/?\s*>$/i.test(rawTag)) {
      tokens.push({ kind: 'tag', raw: rawTag, tagName: 'br', isVoidBr: true, valid: true });
    } else if (options.allowSafeVoidImg && /^<\s*img\b[^>]*>$/i.test(rawTag)) {
      const attrsMatch = rawTag.match(/^<\s*img\b([\s\S]*?)\/?\s*>$/i);
      const safeImgHtml = attrsMatch ? buildSafeVoidImgHtml(attrsMatch[1]) : null;
      if (safeImgHtml) {
        tokens.push({
          kind: 'tag',
          raw: rawTag,
          tagName: 'img',
          normalizedVoidHtml: safeImgHtml,
          valid: true
        });
      } else {
        tokens.push({ kind: 'tag', raw: rawTag, isAllowedInline: false, stripShell: true, valid: false });
      }
    } else {
      const closeMatch = rawTag.match(/^<\s*\/\s*([a-zA-Z0-9]+)\s*>$/);
      if (closeMatch && options.allowedTags.has(closeMatch[1].toLowerCase())) {
        tokens.push({
          kind: 'tag',
          raw: rawTag,
          tagName: closeMatch[1].toLowerCase(),
          isClose: true,
          isAllowedInline: true,
          valid: false
        });
      } else if (!options.allowClassAttr) {
        const openNoAttrMatch = rawTag.match(/^<\s*([a-zA-Z0-9]+)\s*>$/);
        if (openNoAttrMatch && options.allowedTags.has(openNoAttrMatch[1].toLowerCase())) {
          tokens.push({
            kind: 'tag',
            raw: rawTag,
            tagName: openNoAttrMatch[1].toLowerCase(),
            isClose: false,
            isAllowedInline: true,
            valid: false
          });
        } else {
          pushDisallowedTag(rawTag);
        }
      } else {
        const openMatch = rawTag.match(/^<\s*([a-zA-Z0-9]+)(?:\s+([^>]*))?>$/);
        const tagLower = openMatch ? openMatch[1].toLowerCase() : '';
        if (openMatch && options.allowedTags.has(tagLower)) {
          const attrs = (openMatch[2] || '').trim();
          let normalizedAttr = '';
          if (attrs && !/\/\s*$/.test(attrs)) {
            const clsMatch = attrs.match(
              /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i
            );
            const rawCls = clsMatch ? clsMatch[1] ?? clsMatch[2] ?? clsMatch[3] ?? '' : '';
            const cleanCls = rawCls.replace(/^[“”'‘’`]+|[“”'‘’`]+$/g, '').trim();
            if (cleanCls && /^[A-Za-z0-9 _-]+$/.test(cleanCls)) {
              normalizedAttr = ` class="${cleanCls}"`;
            }
          }
          if (/\/\s*$/.test(attrs)) {
            // Drop self-closing non-void inline tags like `<span />`
            tokens.push({
              kind: 'tag',
              raw: rawTag,
              tagName: tagLower,
              isAllowedInline: true,
              valid: false
            });
          } else {
            tokens.push({
              kind: 'tag',
              raw: rawTag,
              tagName: tagLower,
              normalizedAttr,
              isClose: false,
              isAllowedInline: true,
              valid: false
            });
          }
        } else {
          pushDisallowedTag(rawTag);
        }
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
    if (tok.kind !== 'tag' || !tok.tagName || tok.isVoidBr || tok.normalizedVoidHtml) continue;
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
        if (tok.normalizedVoidHtml) return tok.normalizedVoidHtml;
        return tok.isClose
          ? `</${tok.tagName}>`
          : `<${tok.tagName}${tok.normalizedAttr || ''}>`;
      }
      if (tok.kind === 'tag' && (tok.stripShell || (options.stripUnmatchedAllowedTags && tok.isAllowedInline))) {
        return '';
      }
      return tok.raw.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    })
    .join('');
}

function stripRubyMarkup(html: string): string {
  if (!html || !/<\/?(?:ruby|rt|rp|rb|rtc)\b/i.test(html)) return html;
  return html
    .replace(/<(?:rt|rp|rtc)\b[^>]*\/\s*>/gi, '')
    .replace(/<rtc\b[^>]*>[\s\S]*?<\/\s*rtc\s*>/gi, '')
    .replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<(?:rt|rp|rtc)\b[^>]*>[^<]*(?=<\/?\s*(?:ruby|rb|rt|rp|rtc)\b)/gi, '')
    .replace(/<\/?\s*(?:ruby|rb|rt|rp|rtc)\b[^>]*>/gi, '');
}

/**
 * Sanitizes footnote prose so it is strictly well-formed XHTML inside `<aside>` elements:
 * - Escapes bare `&` characters not part of valid XML entities.
 * - Preserves balanced, attribute-free inline formatting tags (`i`, `em`, `b`, `strong`, `sup`, `sub`, `u`, `small`, `code`) and `<br/>`.
 * - Escapes unclosed, mismatched, or arbitrary angle-bracket text (e.g. `<internal>`, `x < y`).
 */
export function sanitizeFootnoteTextForXhtml(text: string): string {
  return sanitizeInlineXhtmlCore(stripRubyMarkup(text), {
    allowedTags: FOOTNOTE_INLINE_TAG_SET,
    allowClassAttr: false,
    stripUnmatchedAllowedTags: false
  });
}

/**
 * Sanitizes inline markup inside translated leaf blocks so arbitrary LLM output is guaranteed
 * to be well-formed XHTML:
 * - Strips any leaked `<ruby>` / `<rt>` / `<rp>` / `<rtc>` furigana tags while keeping base text.
 * - Rescues unclosed opening tags missing `>` before text + closing tag (e.g. `<span class="“stickupcap”" 站</span>`).
 * - Normalizes curly quotes inside allowed `class` attributes and strips unsafe/unknown attributes.
 * - Preserves balanced inline formatting tags (`i`, `em`, `b`, `strong`, `sup`, `sub`, `u`, `small`, `code`, `span`) and `<br/>`.
 * - Strips unmatched/orphan inline HTML tags while escaping literal angle-bracket prose (`x < y`, `<internal>`).
 */
export function sanitizeInlineXhtmlForLeaf(html: string): string {
  if (!html) return '';
  const rescued = stripRubyMarkup(html)
    .replace(
      /<(span|i|em|b|strong|sup|sub|u|small|code)\b[^<>]*?\s+([^<>\s=]+)<=""\s*\1="">/gi,
      '$2'
    )
    .replace(
      /<(span|i|em|b|strong|sup|sub|u|small|code)\b(?:\s+[a-zA-Z_:][\w:.-]*\s*=\s*(?:"[^"<>\r\n]*"|'[^'<>\r\n]*'|[^\s"'=<>`]+))*(?:\s+|(?<=["']))([^<>]*?)<\/\s*\1\s*>/gi,
      '$2'
    )
    .replace(
      /<(span|i|em|b|strong|sup|sub|u|small|code)\s+([^<>"'=]*?)<\/\s*\1\s*>/gi,
      '$2'
    );

  return sanitizeInlineXhtmlCore(rescued, {
    allowedTags: LEAF_INLINE_TAG_SET,
    allowClassAttr: true,
    stripUnmatchedAllowedTags: true,
    stripDisallowedHtmlShells: true,
    allowSafeVoidImg: true
  });
}

function recoverSingleNewlineBoundaries(
  paragraphs: string[],
  sourceBlocks: Array<{ isHeadingLike: boolean }>
): string[] {
  if (paragraphs.length >= sourceBlocks.length) return paragraphs;
  const hasHeadingBlocks = sourceBlocks.some((b) => b.isHeadingLike);
  const listMarkerRe = /^(?:\d{1,3}[.．、\)](?!\d)|\(\d{1,3}\)|\[\d{1,3}\]|[-*•·])\s*\S/;
  const mdHeadingRe = /^#{1,6}\s+\S/;
  const expanded: string[] = [];

  for (const para of paragraphs) {
    const lines = para
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length <= 1) {
      expanded.push(para);
      continue;
    }

    const chunks: string[] = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const prev = chunks[chunks.length - 1];
      const curr = lines[i];
      const prevLastLine = prev.split(/\r?\n/).pop()?.trim() || '';
      const prevPlain = prevLastLine.replace(/^#{1,6}\s+/, '').trim();
      const prevEndsSentence = /[。！？.!?：:;；]$/.test(prevPlain);
      const isListBoundary = listMarkerRe.test(curr);
      const isMdHeadingBoundary = mdHeadingRe.test(prevLastLine) || mdHeadingRe.test(curr);
      const isShortHeadingBeforeBody =
        hasHeadingBlocks &&
        !listMarkerRe.test(prevLastLine) &&
        prevPlain.length > 0 &&
        prevPlain.length <= 35 &&
        !prevEndsSentence &&
        !mdHeadingRe.test(prevLastLine) &&
        (curr.length > prevPlain.length * 1.3 || /[。！？.!?]$/.test(curr));

      if (isListBoundary || isMdHeadingBoundary || isShortHeadingBeforeBody) {
        chunks.push(curr);
      } else {
        chunks[chunks.length - 1] = `${prev}\n${curr}`;
      }
    }
    expanded.push(...chunks);
  }

  return expanded;
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
   * Wraps contiguous runs of loose inline text/tags inside mixed-content containers
   * (e.g. `<li>lead text<p>continuation</p></li>`) into `<p data-translit-mixed-run="true">`
   * so leaf block extraction never skips leading inline text next to a nested `<p>`.
   */
  public normalizeMixedContentContainers(root: Element): void {
    const doc = root.ownerDocument;
    if (!doc) return;

    const SKIP_MIXED_CONTAINER_TAGS = new Set([
      'BODY',
      'HEAD',
      'HTML',
      'SCRIPT',
      'STYLE',
      'SVG',
      'MATH',
      'TABLE',
      'THEAD',
      'TBODY',
      'TFOOT',
      'TR',
      'UL',
      'OL',
      'DL',
      'NAV',
      'HGROUP',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'P',
      'PRE',
      'FIGURE',
      'DETAILS',
      'SUMMARY',
      'FIELDSET',
      'COLGROUP'
    ]);

    const blockDescIndex = buildBlockDescendantIndex(root, isFootnotePopupElement);

    for (const container of Array.from(root.querySelectorAll('*'))) {
      if (!container.isConnected) continue;
      if (isFootnotePopupElement(container) || container.closest('aside, nav, script, style, svg, math')) {
        continue;
      }
      const tag = (container.tagName || '').toUpperCase();
      if (SKIP_MIXED_CONTAINER_TAGS.has(tag)) continue;

      const childElements = Array.from(container.children).filter((c) => !isFootnotePopupElement(c));
      const hasBlockChild = childElements.some((c) => isBlockBoundaryElement(c, blockDescIndex));
      if (!hasBlockChild) continue;

      const childNodes = Array.from(container.childNodes);
      let inlineRun: ChildNode[] = [];

      const flushInlineRun = () => {
        if (inlineRun.length === 0) return;
        const hasVisibleInlineContent = inlineRun.some((n) => {
          if (n.nodeType === 3) {
            return (n.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0;
          }
          if (n.nodeType === 1) {
            if (isEmptyPagebreakAnchor(n)) return false;
            const elem = n as Element;
            if (EMPTY_MARKER_VOID_TAGS.has((elem.tagName || '').toUpperCase())) return false;
            if (isNoterefAnchor(elem)) return true;
            if ((elem.tagName || '').toUpperCase() === 'IMG') return true;
            return (elem.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0;
          }
          return false;
        });

        if (hasVisibleInlineContent) {
          const wrapper = doc.createElement('p');
          wrapper.setAttribute('data-translit-mixed-run', 'true');
          wrapper.setAttribute('data-translit-indent', 'none');
          container.insertBefore(wrapper, inlineRun[0]);
          for (const node of inlineRun) {
            wrapper.appendChild(node);
          }
        }
        inlineRun = [];
      };

      for (const node of childNodes) {
        if (
          node.nodeType === 1 &&
          isBlockBoundaryElement(node as Element, blockDescIndex)
        ) {
          flushInlineRun();
        } else {
          inlineRun.push(node);
        }
      }
      flushInlineRun();
    }
  }

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
  public collectTranslatableLeafElements(
    body: Element,
    cssProfiles?: Map<string, CssClassProfile>
  ): Element[] {
    const results: Element[] = [];
    const blockDescIndex = buildBlockDescendantIndex(body, isFootnotePopupElement);

    const walk = (el: Element) => {
      if (isFootnotePopupElement(el)) return;

      const tag = (el.tagName || '').toUpperCase();
      if (NON_TRANSLATABLE_SUBTREE_TAGS.has(tag)) {
        return;
      }

      if (el !== body) {
        if (el.hasAttribute('hidden')) return;
        if (resolveElementVisualStyle(el, cssProfiles).displayNone === true) return;
      }

      const childElements = Array.from(el.children).filter((c) => !isFootnotePopupElement(c));
      if (blockDescIndex.has(el)) {
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
   * - Purifies inline `<span>` elements using CSS profiles & AI style roles so class/dropcap noise never leaks to the LLM
   * - Keeps clean semantic formatting tags (`<i>`, `<b>`, `<em>`, `<strong>`, `<code>`, etc.) intact
   */
  public extractLeafBlockContent(
    el: Element,
    bookStyleRoles?: BookStyleRoleMap,
    cssProfiles?: Map<string, CssClassProfile>
  ): {
    slottedText: string;
    leadingAnchorHtmls: string[];
    footnoteIds: string[];
    inlineImageHtmls: string[];
    inlineMathHtmls: string[];
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
    const inlineImageHtmls: string[] = [];
    const inlineMathHtmls: string[] = [];

    if (targetContainer.firstElementChild) {
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

      // 3.5. Replace inline <img> elements with opaque __IMG_{idx}__ slots so LLM never sees or corrupts image URLs/attributes
      for (const img of Array.from(targetContainer.querySelectorAll('img'))) {
        if (img.classList.contains('qqreader-footnote')) continue;
        const imgOuter = (img.cloneNode(true) as Element).outerHTML.replace(
          /<img\b([^>]*)>/gi,
          (m, attrs) => (attrs.trim().endsWith('/') ? m : `<img${attrs}/>`)
        );
        const imgIdx = inlineImageHtmls.length;
        inlineImageHtmls.push(imgOuter);
        img.replaceWith(targetContainer.ownerDocument!.createTextNode(`__IMG_${imgIdx}__`));
      }

      // 3.6. Replace inline <math> elements with opaque __MATH_{idx}__ slots so LLM never corrupts or escapes MathML tags
      for (const mathEl of Array.from(targetContainer.querySelectorAll('math'))) {
        if (mathEl.parentElement?.closest('math')) continue;
        const mathOuter = (mathEl.cloneNode(true) as Element).outerHTML;
        const mathIdx = inlineMathHtmls.length;
        inlineMathHtmls.push(mathOuter);
        mathEl.replaceWith(targetContainer.ownerDocument!.createTextNode(`__MATH_${mathIdx}__`));
      }

      // 4. Strip mid-paragraph invisible pagebreak spans and empty metadata anchors so the LLM never sees or hallucinates on them
      const inlineMetaNodes = Array.from(targetContainer.querySelectorAll('a, span'));
      for (const metaNode of inlineMetaNodes) {
        if (isEmptyPagebreakAnchor(metaNode)) {
          metaNode.remove();
        }
      }

      // 4.5. Unwrap remaining non-noteref inline <a> elements (e.g. doc-backlink / internal cross-refs)
      // so raw `<a class="..." href="..." role="doc-backlink">` never leaks to the LLM;
      // any non-noteref `<a id="...">` anchors are preserved in-place on write-back.
      for (const anchor of Array.from(targetContainer.querySelectorAll('a')).reverse()) {
        if (!anchor.parentNode || isNoterefAnchor(anchor)) continue;
        anchor.replaceWith(...Array.from(anchor.childNodes));
      }

      // 4.6. Strip Japanese/CJK <ruby> furigana annotations (<rt>, <rp>, <rtc>) and unwrap <ruby>/<rb>
      // so phonetic readings never leak into translatable LLM payloads or break glossary matching.
      for (const rubyMeta of Array.from(targetContainer.querySelectorAll('rt, rp, rtc'))) {
        rubyMeta.remove();
      }
      for (const rubyWrap of Array.from(targetContainer.querySelectorAll('ruby, rb')).reverse()) {
        if (!rubyWrap.parentNode) continue;
        rubyWrap.replaceWith(...Array.from(rubyWrap.childNodes));
      }

      // 5. Purify remaining <span> elements (deepest-first) using CSS profiles + AI style roles:
      // dropcap / ignore / empty / decorative / body / smallcaps spans are unwrapped or removed;
      // emphasis / strong / code spans are normalized to bare <i> / <b> / <code> tags.
      const doc = targetContainer.ownerDocument!;
      const spans = Array.from(targetContainer.querySelectorAll('span')).reverse();
      for (const span of spans) {
        if (!span.parentNode || span.getAttribute('data-translit-role') === 'footnote-popup') {
          continue;
        }
        if (span.childNodes.length === 0) {
          const emptyClsTokens = (span.getAttribute('class') || '').split(/\s+/).filter(Boolean);
          let hasHorizontalSpacing = false;
          if (cssProfiles) {
            for (const c of emptyClsTokens) {
              const prof = cssProfiles.get(c);
              if (
                prof &&
                ((prof.paddingLeftEm !== undefined && prof.paddingLeftEm > 0) ||
                  (prof.marginLeftEm !== undefined && prof.marginLeftEm > 0))
              ) {
                hasHorizontalSpacing = true;
                break;
              }
            }
          }
          const emptyInlineStyle = span.getAttribute('style');
          if (!hasHorizontalSpacing && emptyInlineStyle) {
            const parsedInline = parseCssDeclarations(emptyInlineStyle);
            if (
              (parsedInline.paddingLeftEm !== undefined && parsedInline.paddingLeftEm > 0) ||
              (parsedInline.marginLeftEm !== undefined && parsedInline.marginLeftEm > 0)
            ) {
              hasHorizontalSpacing = true;
            }
          }
          if (hasHorizontalSpacing) {
            span.replaceWith(doc.createTextNode(' '));
          } else {
            span.remove();
          }
          continue;
        }

        const mapped = resolveElementBookStyleMapping(span, bookStyleRoles);
        const cls = span.getAttribute('class') || '';
        const clsTokens = cls.split(/\s+/).filter(Boolean);

        let ownFontStyle: 'italic' | 'normal' | undefined;
        let ownFontWeight: 'bold' | 'normal' | undefined;
        let ownDisplayBlock = false;
        if (cssProfiles) {
          for (const c of clsTokens) {
            const prof = cssProfiles.get(c);
            if (!prof) continue;
            if (prof.fontStyle !== undefined) ownFontStyle = prof.fontStyle;
            if (prof.fontWeight !== undefined) ownFontWeight = prof.fontWeight;
            if (prof.inlineDisplayBlock !== undefined) ownDisplayBlock = prof.inlineDisplayBlock;
          }
        }
        const inlineStyleAttr = span.getAttribute('style');
        if (inlineStyleAttr) {
          const inlineParsed = parseCssDeclarations(inlineStyleAttr);
          if (inlineParsed.fontStyle !== undefined) ownFontStyle = inlineParsed.fontStyle;
          if (inlineParsed.fontWeight !== undefined) ownFontWeight = inlineParsed.fontWeight;
          if (inlineParsed.displayBlock !== undefined) ownDisplayBlock = inlineParsed.displayBlock;
        }

        const spanRoleAttr = `${span.getAttribute('role') || ''} ${span.getAttribute('epub:type') || ''}`;
        const isBlockBreakSpan =
          ownDisplayBlock || /\b(?:doc-subtitle|subtitle)\b/i.test(spanRoleAttr);

        if (isBlockBreakSpan && span.parentNode) {
          const hasVisibleSpanContent =
            (span.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0 ||
            Boolean(span.querySelector('img, math'));
          if (hasVisibleSpanContent) {
            const isSignificantSibling = (n: ChildNode): boolean => {
              if (n.nodeType === 3) {
                return (n.textContent || '').replace(/[\s\u00a0]+/g, '').length > 0;
              }
              if (n.nodeType === 1) {
                if (isEmptyPagebreakAnchor(n)) return false;
                const t = ((n as Element).tagName || '').toUpperCase();
                if (EMPTY_MARKER_VOID_TAGS.has(t)) return false;
                return true;
              }
              return false;
            };

            let prevSig: ChildNode | null = span.previousSibling;
            while (prevSig && !isSignificantSibling(prevSig)) {
              prevSig = prevSig.previousSibling;
            }
            if (
              prevSig &&
              !(prevSig.nodeType === 1 && ((prevSig as Element).tagName || '').toUpperCase() === 'BR')
            ) {
              span.parentNode.insertBefore(doc.createElement('br'), span);
            }

            let nextSig: ChildNode | null = span.nextSibling;
            while (nextSig && !isSignificantSibling(nextSig)) {
              nextSig = nextSig.nextSibling;
            }
            if (
              nextSig &&
              !(nextSig.nodeType === 1 && ((nextSig as Element).tagName || '').toUpperCase() === 'BR')
            ) {
              span.parentNode.insertBefore(doc.createElement('br'), span.nextSibling);
            }
          }
        }

        const isDropcapOrIgnore =
          mapped?.role === 'dropcap' ||
          mapped?.role === 'ignore' ||
          /(?:^|[\s_-])(?:dropcap|stickupcap|initial|firstletter)\d*(?:$|[\s_-])/i.test(cls);

        if (isDropcapOrIgnore) {
          span.replaceWith(...Array.from(span.childNodes));
          continue;
        }

        const isCode =
          mapped?.role === 'code' ||
          /(?:^|[\s_-])(?:code|mono|monospace|tt)\d*(?:$|[\s_-])/i.test(cls);
        if (isCode) {
          const codeEl = doc.createElement('code');
          codeEl.append(...Array.from(span.childNodes));
          span.replaceWith(codeEl);
          continue;
        }

        const isItalic =
          mapped?.role === 'emphasis' ||
          (ownFontStyle === 'italic' && mapped?.role !== 'body' && mapped?.role !== 'meta') ||
          /(?:^|[\s_-])(?:italic|italics|emph|emphasis)\d*(?:$|[\s_-])/i.test(cls);
        const isBold =
          mapped?.role === 'strong' ||
          (ownFontWeight === 'bold' && mapped?.role !== 'body' && mapped?.role !== 'meta') ||
          /(?:^|[\s_-])(?:bold|strong)\d*(?:$|[\s_-])/i.test(cls);

        if (isBold && isItalic) {
          const bEl = doc.createElement('b');
          const iEl = doc.createElement('i');
          iEl.append(...Array.from(span.childNodes));
          bEl.appendChild(iEl);
          span.replaceWith(bEl);
        } else if (isItalic) {
          const iEl = doc.createElement('i');
          iEl.append(...Array.from(span.childNodes));
          span.replaceWith(iEl);
        } else if (isBold) {
          const bEl = doc.createElement('b');
          bEl.append(...Array.from(span.childNodes));
          span.replaceWith(bEl);
        } else {
          span.replaceWith(...Array.from(span.childNodes));
        }
      }

      // 5.5. Universal non-canonical inline tag purification (deepest-first):
      // Keep only canonical leaf inline tags (i, em, b, strong, sup, sub, u, small, code, br),
      // convert cite/dfn/var -> <i>, kbd/samp -> <code>, remove empty marker tags (wbr/pagebreak),
      // and unwrap all remaining phrasing/shell elements so raw HTML never leaks to the LLM.
      for (const node of Array.from(targetContainer.querySelectorAll('*')).reverse()) {
        if (!node.parentNode) continue;
        if (node.getAttribute('data-translit-role') === 'footnote-popup') continue;
        const tagUpper = (node.tagName || '').toUpperCase();
        const tagLower = tagUpper.toLowerCase();
        if (tagLower === 'svg' || node.closest('svg, math')) continue;
        if (LEAF_INLINE_TAG_SET.has(tagLower) || tagLower === 'br') continue;

        if (EMPTY_MARKER_VOID_TAGS.has(tagUpper)) {
          node.remove();
          continue;
        }

        if (tagLower === 'cite' || tagLower === 'dfn' || tagLower === 'var') {
          const iEl = doc.createElement('i');
          iEl.append(...Array.from(node.childNodes));
          node.replaceWith(iEl);
        } else if (tagLower === 'kbd' || tagLower === 'samp') {
          const codeEl = doc.createElement('code');
          codeEl.append(...Array.from(node.childNodes));
          node.replaceWith(codeEl);
        } else if (node.childNodes.length === 0) {
          node.remove();
        } else {
          node.replaceWith(...Array.from(node.childNodes));
        }
      }
    }

    const slottedText = targetContainer.innerHTML
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*<br\s*\/?>\s*/gi, '<br/>')
      .replace(/^(?:<br\/>)+|(?:<br\/>)+$/gi, '')
      .trim();
    const footnoteIds = Array.from(new Set(extractFootnoteSlots(slottedText)));

    return {
      slottedText,
      leadingAnchorHtmls,
      footnoteIds,
      inlineImageHtmls,
      inlineMathHtmls
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
    cssProfiles?: Map<string, CssClassProfile>,
    bookStyleRoles?: BookStyleRoleMap,
    headingAnalysis?: LeafHeadingAnalysis
  ): void {
    const setRole = (el: Element | null, role: string) => {
      if (!el) return;
      el.setAttribute('data-translit-role', role);
    };

    const analysis =
      headingAnalysis || resolveLeafHeadingAnalysis(leafElements, cssProfiles, bookStyleRoles);

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
                const lvl = getHeadingMarkdownLevel(child, cssProfiles, bookStyleRoles);
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
      if (parentTable) {
        if (isStructuralTitleTable(parentTable)) {
          continue;
        }
        const isHeaderCell = Boolean(el.closest('th, thead'));
        setRole(el, isHeaderCell ? 'table-header' : 'table-cell');
        const cellStyle = resolveElementVisualStyle(el, cssProfiles);
        const mappedCell = resolveElementBookStyleMapping(el, bookStyleRoles);
        const effAlign = mappedCell?.align || cellStyle.textAlign;
        if (effAlign === 'center' || effAlign === 'right' || effAlign === 'left') {
          el.setAttribute('data-translit-align', effAlign);
        }
        if (mappedCell?.weight === 'bold' || cellStyle.fontWeight === 'bold') {
          el.setAttribute('data-translit-weight', 'bold');
        }
        continue;
      }

      const mappedStyle = resolveElementBookStyleMapping(el, bookStyleRoles);
      const quotePos = analysis.vetoedQuotePos.get(el);
      const style = resolveElementVisualStyle(el, cssProfiles);

      if (quotePos) {
        setRole(el, 'quote-line');
        el.setAttribute('data-translit-quote-pos', quotePos);
        const effAlign = mappedStyle?.align || style.textAlign;
        if (effAlign === 'center' || effAlign === 'right' || effAlign === 'left') {
          el.setAttribute('data-translit-align', effAlign);
        }
        continue;
      }

      const headingLevel = analysis.headingLevels.get(el) ?? 0;

      if (headingLevel > 0) {
        if (mappedStyle?.role === 'subtitle') {
          setRole(el, 'subtitle');
        } else if (headingLevel === 1) {
          setRole(el, 'h1');
        } else if (headingLevel === 2) {
          setRole(el, 'h2');
        } else if (headingLevel === 3) {
          setRole(el, 'h3');
        } else {
          setRole(el, 'h4');
        }
        if (mappedStyle?.align) {
          el.setAttribute('data-translit-align', mappedStyle.align);
        }
        continue;
      }

      if (mappedStyle && mappedStyle.role !== 'ignore') {
        const insideBlockquote = Boolean(el.closest('blockquote'));
        if (mappedStyle.role === 'quote' && insideBlockquote) {
          if (mappedStyle.align) {
            el.setAttribute('data-translit-align', mappedStyle.align);
          }
          if (mappedStyle.weight === 'bold') {
            el.setAttribute('data-translit-weight', 'bold');
          }
          if (mappedStyle.indent === 'none') {
            el.setAttribute('data-translit-indent', 'none');
          }
          continue;
        }

        const mappedRole = mappedStyle.role === 'quote' ? 'quote-line' : mappedStyle.role;
        if (tag === 'LI' && mappedRole === 'hanging') {
          continue;
        }
        if (
          mappedRole !== 'body' ||
          (tag === 'P' && !el.closest('blockquote, li, table, figcaption'))
        ) {
          setRole(el, mappedRole);
        }
        if (mappedStyle.align) {
          el.setAttribute('data-translit-align', mappedStyle.align);
        }
        if (
          mappedStyle.weight === 'bold' ||
          (style.fontWeight === 'bold' &&
            (mappedStyle.role === 'callout' ||
              mappedStyle.role === 'body' ||
              mappedStyle.role === 'attribution' ||
              mappedStyle.role === 'meta'))
        ) {
          el.setAttribute('data-translit-weight', 'bold');
        }
        if (mappedStyle.indent === 'none') {
          el.setAttribute('data-translit-indent', 'none');
        }
        continue;
      }

      if (/(?:^|[\s_-])(?:verse|poem|poetry)\d*(?:$|[\s_-])/i.test(cls)) {
        setRole(el, 'verse');
        continue;
      }

      if (/(?:^|[\s_-])(?:epigraph|dedication|motto)\d*(?:$|[\s_-])/i.test(cls)) {
        setRole(el, 'epigraph');
        if (style.textAlign === 'center') {
          el.setAttribute('data-translit-align', 'center');
        }
        continue;
      }

      if (
        tag !== 'LI' &&
        ((style.textIndentEm !== undefined && style.textIndentEm < 0) ||
          /(?:^|[\s_-])(?:bib|ref|reference|ind|inda|toc|hang)\d*(?:$|[\s_-])/i.test(cls))
      ) {
        setRole(el, 'hanging');
        continue;
      }

      if (
        tag === 'FIGCAPTION' ||
        tag === 'CAPTION' ||
        /(?:^|[\s_-])(?:caption|img-caption|fig-caption)\d*(?:$|[\s_-])/i.test(cls)
      ) {
        setRole(el, 'caption');
        continue;
      }

      if (style.fontWeight === 'bold') {
        el.setAttribute('data-translit-weight', 'bold');
      }

      if (style.textAlign === 'center' || /\b(center|centered|halftitle|half-title)\b/i.test(cls)) {
        setRole(el, 'center');
        continue;
      }

      if (
        style.textAlign === 'right' ||
        /(?:^|[\s_-])(?:right|signature|dateline|author-right|attribution)\d*(?:$|[\s_-])/i.test(cls)
      ) {
        setRole(el, 'right');
        continue;
      }

      if (style.textIndentEm === 0 && style.fontWeight === 'bold') {
        el.setAttribute('data-translit-indent', 'none');
      }

      if (tag === 'P' && !el.closest('blockquote, li, table, figcaption')) {
        setRole(el, 'body');
      }
    }

    for (const listEl of Array.from(root.querySelectorAll('ol, ul'))) {
      if (isFootnotePopupElement(listEl) || listEl.closest('aside')) continue;
      const listStyle = resolveElementVisualStyle(listEl, cssProfiles);
      const directLis = Array.from(listEl.children).filter(
        (c) => (c.tagName || '').toUpperCase() === 'LI'
      );
      const hasHangingChild = directLis.some(
        (li) => li.getAttribute('data-translit-role') === 'hanging'
      );
      const nonEmptyLis = directLis.filter(
        (li) => (li.textContent || '').replace(/[\s\u00a0]+/g, '').trim().length > 0
      );
      const manualNumCount = nonEmptyLis.filter((li) =>
        /^\s*(?:\d+[.．、\)]|\(\d+\)|\[\d+\])/.test(li.textContent || '')
      ).length;
      const hasManualNumbering =
        (listEl.tagName || '').toUpperCase() === 'OL' &&
        nonEmptyLis.length > 0 &&
        manualNumCount * 2 >= nonEmptyLis.length;

      if (listStyle.listStyleNone === true || hasHangingChild || hasManualNumbering) {
        listEl.setAttribute('data-translit-list', 'none');
      }
    }

    for (const li of Array.from(root.querySelectorAll('li'))) {
      if (isFootnotePopupElement(li) || li.closest('aside')) continue;
      if (resolveElementVisualStyle(li, cssProfiles).listStyleNone === true) {
        li.setAttribute('data-translit-list', 'none');
      }
    }
  }

  private stampInlineSemanticRoles(root: Element, bookStyleRoles?: BookStyleRoleMap): void {
    for (const inlineEl of Array.from(
      root.querySelectorAll(
        'span[class], a[class], b[class], strong[class], i[class], em[class], small[class], big[class], code[class]'
      )
    )) {
      if (isNoterefAnchor(inlineEl) || isFootnotePopupElement(inlineEl)) continue;
      const mappedInline = resolveElementBookStyleMapping(inlineEl, bookStyleRoles);
      if (mappedInline) {
        if (mappedInline.role === 'ignore') continue;
        if (
          mappedInline.role === 'dropcap' ||
          mappedInline.role === 'emphasis' ||
          mappedInline.role === 'strong' ||
          mappedInline.role === 'code'
        ) {
          inlineEl.setAttribute('data-translit-role', mappedInline.role);
          continue;
        }
      }
      const cls = inlineEl.getAttribute('class') || '';
      if (/(?:^|[\s_-])(?:dropcap|stickupcap|initial|firstletter)\d*(?:$|[\s_-])/i.test(cls)) {
        inlineEl.setAttribute('data-translit-role', 'dropcap');
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
    cssProfiles?: Map<string, CssClassProfile>,
    bookStyleRoles?: BookStyleRoleMap
  ): DomExtractionResult {
    const doc = parseHtmlDocument(xhtml);
    if (!doc.body) {
      return { blocks: [], payloadText: '' };
    }

    this.decomposeBlockquotes(doc.body);
    this.normalizeMixedContentContainers(doc.body);

    const leafElements = this.collectTranslatableLeafElements(doc.body, cssProfiles);
    const analysis = resolveLeafHeadingAnalysis(leafElements, cssProfiles, bookStyleRoles);
    const blocks: TranslatableDomBlock[] = [];

    leafElements.forEach((el) => {
      const { slottedText, leadingAnchorHtmls, footnoteIds } = this.extractLeafBlockContent(
        el,
        bookStyleRoles,
        cssProfiles
      );
      if (!slottedText) return;

      const headingLevel = analysis.headingLevels.get(el) ?? 0;
      const formattedSlottedText =
        headingLevel > 0 && !/^#{1,6}\s/.test(slottedText)
          ? `${'#'.repeat(headingLevel)} ${slottedText}`
          : slottedText;

      blocks.push({
        index: blocks.length,
        tagName: el.tagName.toLowerCase(),
        className: el.getAttribute('class') || '',
        id: el.getAttribute('id') || '',
        isHeadingLike: Boolean(analysis.isHeadingLikeMap.get(el)),
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
      bookStyleRoles,
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

    const knownFnIds = Object.keys(internalizedFootnotes);
    if (knownFnIds.length > 0 && cleanTarget) {
      const strippedLeaks = stripLeakedFootnoteDefinitions(cleanTarget, knownFnIds);
      if (strippedLeaks.cleanedText !== cleanTarget) {
        cleanTarget = strippedLeaks.cleanedText;
        for (const [fnId, fnText] of Object.entries(strippedLeaks.extractedDefs)) {
          if (!inlineTranslatedNotes[fnId] && fnText) {
            inlineTranslatedNotes[fnId] = fnText;
          }
        }
      }
    }

    const doc = parseHtmlDocument(originalXhtml);
    if (!doc.body) {
      return { html: originalXhtml, leafCount: 0 };
    }

    this.decomposeBlockquotes(doc.body);
    this.normalizeMixedContentContainers(doc.body);

    // Remove any pre-existing footnote popup asides to avoid duplication
    for (const existingAside of Array.from(doc.body.children)) {
      if (isFootnotePopupElement(existingAside)) {
        existingAside.remove();
      }
    }

    const leafElements = this.collectTranslatableLeafElements(doc.body, cssProfiles);
    if (leafElements.length === 0) {
      return { html: doc.body.innerHTML, leafCount: 0 };
    }

    const headingAnalysis = resolveLeafHeadingAnalysis(leafElements, cssProfiles, bookStyleRoles);
    this.stampSemanticRoleClasses(doc.body, leafElements, cssProfiles, bookStyleRoles, headingAnalysis);

    const extractedSourceBlocks = leafElements.map((el, idx) => {
      const { slottedText, leadingAnchorHtmls, footnoteIds, inlineImageHtmls, inlineMathHtmls } =
        this.extractLeafBlockContent(el, bookStyleRoles, cssProfiles);
      return {
        index: idx,
        el,
        slottedText,
        leadingAnchorHtmls,
        footnoteIds,
        inlineImageHtmls,
        inlineMathHtmls,
        isHeadingLike: Boolean(headingAnalysis.isHeadingLikeMap.get(el))
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

    if (!isPartialStream && rawTargetParagraphs.length < extractedSourceBlocks.length) {
      rawTargetParagraphs = recoverSingleNewlineBoundaries(
        rawTargetParagraphs,
        extractedSourceBlocks
      );
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

    const renderInlineImageSlots = (
      htmlFragment: string,
      inlineImageHtmls: string[],
      inlineMathHtmls?: string[]
    ): string => {
      let out = htmlFragment;
      if (inlineImageHtmls && inlineImageHtmls.length > 0) {
        out = out.replace(/__IMG_\s*(\d+)\s*__/gi, (full, idxStr) => {
          const idx = Number(idxStr);
          return inlineImageHtmls[idx] ?? full;
        });
        if (inlineImageHtmls.length === 1 && !/<img\b/i.test(out)) {
          out = `${inlineImageHtmls[0]}${out}`;
        }
      }
      if (inlineMathHtmls && inlineMathHtmls.length > 0) {
        out = out.replace(/__MATH_\s*(\d+)\s*__/gi, (full, idxStr) => {
          const idx = Number(idxStr);
          return inlineMathHtmls[idx] ?? full;
        });
        if (inlineMathHtmls.length === 1 && !/<math\b/i.test(out)) {
          out = `${out}${inlineMathHtmls[0]}`;
        }
      }
      return out;
    };

    const isBilingual = bilingualMode === 'source_first' || bilingualMode === 'target_first';

    for (let i = 0; i < extractedSourceBlocks.length; i++) {
      const blockInfo = extractedSourceBlocks[i];
      const el = blockInfo.el;
      const isUntranslatedStreamTail = isPartialStream && i >= rawTargetParagraphs.length;
      const targetRaw = alignedTargetTexts[i] ?? blockInfo.slottedText;
      const isMergedEmpty =
        !isUntranslatedStreamTail && rawTargetParagraphs.length > 0 && targetRaw.trim() === '';
      const shouldFormatTargetHeti = applyChineseTypography && !isUntranslatedStreamTail;

      if (!isBilingual) {
        if (isMergedEmpty) {
          this.writeHtmlIntoLeafElement(el, '');
          el.setAttribute('data-translit-merged', 'true');
          continue;
        }
        // Monolingual In-Place Mutation: keep element, classes, IDs, leading anchors, and inner wrapper shell intact
        const formattedTarget = this.formatInlineMarkup(targetRaw);
        const renderedTargetHtml = renderInlineImageSlots(
          renderFootnoteSlotsInHtml(
            shouldFormatTargetHeti ? applyHetiTextTypography(formattedTarget) : formattedTarget,
            false
          ),
          blockInfo.inlineImageHtmls,
          blockInfo.inlineMathHtmls
        );
        this.writeHtmlIntoLeafElement(el, renderedTargetHtml);
      } else {
        // Bilingual In-Place Cloning
        const renderedSourceHtml = renderInlineImageSlots(
          renderFootnoteSlotsInHtml(
            this.formatInlineMarkup(blockInfo.slottedText),
            true
          ),
          blockInfo.inlineImageHtmls,
          blockInfo.inlineMathHtmls
        );
        if (isMergedEmpty) {
          el.classList.add('bilingual-source');
          this.writeHtmlIntoLeafElement(el, renderedSourceHtml);
          continue;
        }
        const formattedTarget = this.formatInlineMarkup(targetRaw);
        const renderedTargetHtml = renderInlineImageSlots(
          renderFootnoteSlotsInHtml(
            shouldFormatTargetHeti ? applyHetiTextTypography(formattedTarget) : formattedTarget,
            false
          ),
          blockInfo.inlineImageHtmls,
          blockInfo.inlineMathHtmls
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

    // Re-index quote-line positions across visible (non-merged) nodes in each quote run
    for (const run of headingAnalysis.vetoedQuoteRuns) {
      const visible = run.filter((node) => node.getAttribute('data-translit-merged') !== 'true');
      if (visible.length === 1) {
        visible[0].setAttribute('data-translit-quote-pos', 'single');
      } else if (visible.length > 1) {
        visible.forEach((node, idx) => {
          node.setAttribute(
            'data-translit-quote-pos',
            idx === 0 ? 'first' : idx === visible.length - 1 ? 'last' : 'mid'
          );
        });
      }
    }

    // Stamp inline semantic roles AFTER leaf HTML writes so surviving inline spans retain roles
    this.stampInlineSemanticRoles(doc.body, bookStyleRoles);

    // Serialize body innerHTML cleanly for strict XML/EPUB3:
    // HTML5 innerHTML serializes \u00a0 as &nbsp; (invalid without a DTD in strict XML) and strips "/>" on void tags.
    let htmlBody = doc.body.innerHTML
      .replace(/&nbsp;/gi, '&#160;')
      .replace(
        /<(br|hr|img|col|wbr|source|track|area|base|embed|input|link|meta|param)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi,
        (m, tag, attrs) => (attrs.trim().endsWith('/') ? m : `<${tag}${attrs}/>`)
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
    if (!removeLeadingPagebreakAnchors) {
      const hostId = (el.getAttribute('id') || '').trim();
      const seenSavedIds = new Set<string>(
        savedAnchors.map((a) => (a.getAttribute('id') || '').trim()).filter(Boolean)
      );
      if (hostId) seenSavedIds.add(hostId);

      for (const anchor of Array.from(innerWrapper.querySelectorAll('a[id]'))) {
        if (isNoterefAnchor(anchor)) continue;
        const aid = (anchor.getAttribute('id') || '').trim();
        if (!aid || seenSavedIds.has(aid)) continue;
        seenSavedIds.add(aid);
        const preservedAnchor = el.ownerDocument!.createElement('a');
        preservedAnchor.setAttribute('id', aid);
        savedAnchors.push(preservedAnchor);
      }
    }
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
    return stripBlockProtocolMarkers(html)
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
    const withMarkdownInline = sanitized
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
    return sanitizeInlineXhtmlForLeaf(withMarkdownInline);
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
    if (N === M) {
      const aligned = [...targetTexts];
      for (let i = 0; i < N - 1; i++) {
        const s0 = sourceTexts[i].replace(/^#{1,6}\s+/, '').trim();
        const s1 = sourceTexts[i + 1].replace(/^#{1,6}\s+/, '').trim();
        const t0 = aligned[i].replace(/^#{1,6}\s+/, '').trim();
        const t1 = aligned[i + 1].replace(/^#{1,6}\s+/, '').trim();

        const bodyThenHeadingSwapped =
          !isHeadingFlags[i] &&
          isHeadingFlags[i + 1] &&
          s0.length > 80 &&
          s1.length <= 60 &&
          t0.length > 0 &&
          t0.length <= 35 &&
          t1.length > 65 &&
          t1.length >= t0.length * 2.5;

        const headingThenBodySwapped =
          isHeadingFlags[i] &&
          !isHeadingFlags[i + 1] &&
          s0.length <= 60 &&
          s1.length > 80 &&
          t0.length > 65 &&
          t1.length > 0 &&
          t1.length <= 35 &&
          t0.length >= t1.length * 2.5;

        if (bodyThenHeadingSwapped || headingThenBodySwapped) {
          const tmp = aligned[i];
          aligned[i] = aligned[i + 1];
          aligned[i + 1] = tmp;
          i++;
        }
      }
      return aligned;
    }

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
          cost += 300;
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
      } else if (sIndices.length > 1) {
        cost += 10 * (sIndices.length - 1);
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
        // 2, 3, or 4 source blocks <- 1 target paragraph (e.g. merged multi-line plaque/quote)
        for (const sMerge of [2, 3, 4]) {
          if (i + sMerge <= N && j + 1 <= M) {
            const sIdxList: number[] = [];
            for (let k = 0; k < sMerge; k++) sIdxList.push(i + k);
            const c = cur + scorePair(sIdxList, [j]);
            if (c < dp[i + sMerge][j + 1].cost) {
              dp[i + sMerge][j + 1] = { cost: c, prevI: i, prevJ: j };
            }
          }
        }
        // 1 source block <- 0 target paragraphs (merged away; never inject untranslated source back into target)
        const cSkip = cur + 55;
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
        // Proportional fallback: preserve all M target segments without leaking untranslated source text
        for (let k = 0; k < N; k++) {
          const startIdx = Math.floor((k * M) / N);
          const endIdx = Math.floor(((k + 1) * M) / N);
          if (endIdx > startIdx) {
            result[k] = targetTexts.slice(startIdx, endIdx).join(' ');
          } else {
            result[k] = '';
          }
        }
        return result;
      }
      const { prevI, prevJ } = step;
      const sCount = currI - prevI;
      const tCount = currJ - prevJ;

      if (sCount === 1 && tCount >= 1) {
        result[prevI] = targetTexts.slice(prevJ, currJ).join(' ');
      } else if (sCount >= 2 && tCount === 1) {
        result[prevI] = targetTexts[prevJ];
        for (let k = 1; k < sCount; k++) {
          result[prevI + k] = '';
        }
      } else if (sCount === 1 && tCount === 0) {
        result[prevI] = '';
      }

      currI = prevI;
      currJ = prevJ;
    }

    return result;
  }
}
