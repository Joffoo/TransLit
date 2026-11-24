import JSZip from 'jszip';
import { marked } from 'marked';
import katex from 'katex';
import { Chapter, FootnoteNode, BilingualMode, BookStyleRoleMap } from '../types';
import {
  parseHtmlDocument,
  parseXmlDocument,
  serializeXmlNode,
  normalizeEpubFilePath,
  resolveRelativeEpubHref
} from '../utils/domAdapter';
import { FootnoteResolver } from './footnoteResolver';
import { PageClassifier } from './pageClassifier';
import { stripLeakedFootnoteDefinitions, validateAndRepairSlots } from './footnotePool';
import {
  DomMutationEngine,
  CssClassProfile,
  EXCLUDED_PSEUDO_HEADING_CLASSES,
  parseEpubCssProfiles,
  resolveLeafHeadingAnalysis,
  applyHetiTextTypography,
  restoreHeadingPrefixesFromSource,
  buildFootnoteAsideHtml
} from './domMutationEngine';
import { detectBookLanguage, LanguageDetectionSource } from './languageDetectionService';

// Register LaTeX Math Extension for Marked
const mathExtension = {
  extensions: [
    {
      name: 'blockMath',
      level: 'block',
      start(src: string) {
        return src.indexOf('$$');
      },
      tokenizer(src: string) {
        const rule = /^\$\$([\s\S]*?)\$\$/;
        const match = rule.exec(src);
        if (match) {
          return {
            type: 'blockMath',
            raw: match[0],
            text: match[1].trim()
          };
        }
      },
      renderer(token: any) {
        try {
          return katex.renderToString(token.text, {
            displayMode: true,
            output: 'mathml',
            throwOnError: false
          });
        } catch (e) {
          console.warn('KaTeX block render error:', e);
          return token.raw;
        }
      }
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start(src: string) {
        return src.indexOf('$');
      },
      tokenizer(src: string) {
        const rule = /^\$(?!\s)([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/;
        const match = rule.exec(src);
        if (match) {
          return {
            type: 'inlineMath',
            raw: match[0],
            text: match[1].trim()
          };
        }
      },
      renderer(token: any) {
        try {
          return katex.renderToString(token.text, {
            displayMode: false,
            output: 'mathml',
            throwOnError: false
          });
        } catch {
          return token.raw;
        }
      }
    }
  ]
};

marked.use(mathExtension as any);

// Helper to escape XML
const escapeXml = (unsafe: any): string => {
  if (unsafe === null || unsafe === undefined) return '';
  const str = String(unsafe);
  return str.replace(/[<>&'"]/g, (c) => {
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
};

export const NOTE_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAuElEQVR4nM1VywnAIAz11HG8uYUbePHgGO7aUSyFFMSm5sVqaeChB3kxefkY8wezITobYrIhZsJ5d29JNyLbbYjlATu92bTkXiDmHHmUPCmIWyTk56PkF/hIKOeatPTSddeExHpLfiFzDsTfn4ZG0ZI7hLg9BbjagVg5takrqpf/nsE6IAIPRJDhFA1qkGCRB6qo3IbhpCbjy/SrRls7KszqYadpOqhyBCfrFk6jyZqVyTibv/Rn2QG/v+KfstxrygAAAABJRU5ErkJggg==';

export const EPUB3_POPUP_FOOTNOTE_CSS = `
  /* EPUB 3 Native Popup Footnotes & Universal Reader Fallback (WeRead, Apple Books, Duokan) */
  a.noteref, a.duokan-footnote, a.footnote {
    display: inline !important;
    color: inherit;
    opacity: 0.78;
    text-decoration: none !important;
    border: none !important;
    border-bottom: none !important;
    outline: none !important;
    font-size: 0.85em;
    line-height: 1 !important;
    padding: 0 1px !important;
    margin: 0 !important;
    cursor: pointer;
    vertical-align: baseline;
    -webkit-tap-highlight-color: transparent;
  }
  a.noteref:focus, a.noteref:active, a.noteref:hover,
  .qqreader-footnote:focus, .qqreader-footnote:active {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
  }
  a.noteref sup, a.duokan-footnote sup, a.footnote sup {
    font-size: 0.85em;
    vertical-align: super;
    line-height: 0;
  }
  /* WeChat Reading (qqreader) native footnote icon popup style - strict inline placement */
  img.qqreader-footnote, .qqreader-footnote {
    display: inline-block !important;
    width: 0.9em !important;
    height: 0.9em !important;
    max-width: 0.9em !important;
    max-height: 0.9em !important;
    margin: 0 0.12em !important;
    padding: 0 !important;
    border: none !important;
    border-bottom: none !important;
    outline: none !important;
    box-shadow: none !important;
    vertical-align: 0.05em !important;
    cursor: pointer;
  }
  aside.footnote-popup, aside.duokan-footnote-content, aside.footnote-content {
    display: block;
    margin-top: 1.5em;
    padding-top: 0.75em;
    border-top: 1px dashed rgba(128, 128, 128, 0.32);
    font-size: 0.9em;
    line-height: 1.6;
    color: inherit;
    opacity: 0.80;
  }
  aside.footnote-popup p.footnote-content, .duokan-footnote-item {
    text-indent: 0;
    margin: 0.4em 0;
    text-align: justify;
  }
  a.footnote-backref {
    color: inherit;
    font-weight: 700;
    margin-right: 0.4em;
    text-decoration: none;
    border-bottom: none;
  }
  .translit-zero-offset-placeholder {
    margin: 3em 1em;
    padding: 1.5em;
    border: 1px dashed rgba(128, 128, 128, 0.32);
    color: inherit;
    opacity: 0.75;
    font-size: 0.9em;
    text-align: center;
  }
`;

export const HETI_SERIF_FONT_STACK =
  '"Heti Song", "Songti SC", "STSong", "Source Han Serif SC", "Source Han Serif CN", "Noto Serif SC", "Noto Serif CJK SC", "SimSun", "PMingLiU", serif';

const HETI_SANS_FONT_STACK =
  '"Heti Hei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", "Source Han Sans CN", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

const HETI_KAI_FONT_STACK =
  '"Kaiti SC", "STKaiti", "KaiTi", "楷体", "SimKai", "BiauKai", "FZKai-Z03S", "DK-Kaiti", "LXGW WenKai", "FangSong", "STFangsong", serif';

const STATIC_HEADING_CLASSES = [
  'sec1-titlea',
  'sec1-title',
  'sec2-titlea',
  'sec2-title',
  'sec3-titlea',
  'part-title',
  'fm-title',
  'bm-title1a',
  'bm-title1',
  'bm-title',
  'top',
  'top-int',
  'top-int1',
  'book-title',
  'book-subtitle',
  'half-title',
  'halftitle',
  'chap-title',
  'chapter-title',
  'title1',
  'title2',
  'h1',
  'h2',
  'h3',
  'h4',
  'authorleft'
];

const STATIC_ZERO_INDENT_ALIGN_CLASSES = [
  'book-author',
  'aut',
  'caption',
  'figcaption',
  'image',
  'image1',
  'fig',
  'flush-right',
  'textcenter',
  'textright',
  'center',
  'right',
  'noindent',
  'no-indent',
  'dedication',
  'epigraph',
  'copyright',
  'cotx',
  'cotx1',
  'line'
];

const STATIC_HANGING_OR_SPECIAL_NO_INDENT_CLASSES = [
  'bib',
  'bib1',
  'hang',
  'ind',
  'inda',
  'toc',
  'toc1',
  'toc2',
  'toc2a',
  'footnote-content',
  'duokan-footnote-item',
  'bilingual-source',
  'bilingual-heading'
];

/**
 * Builds Pure Heti (赫蹏) + CLREQ-compliant Chinese typography CSS tailored to the EPUB's
 * own classes and optional whole-book semantic role mappings (`bookStyleRoles`).
 * - Inherits host reader ink/paper colors cleanly across light, sepia, green, dark, and E-ink themes.
 * - Uses typography hierarchy (typeface, scale, weight, whitespace) & opacity/alpha gray hairlines instead of hardcoded colors.
 * - Separates genuine headings from bold body/callout paragraphs and preserves bold classes dynamically.
 */
export function buildAdaptiveChineseTypographyCss(
  originalCssTexts?: string[],
  bookStyleRoles?: BookStyleRoleMap
): string {
  const hasProvidedCss = Array.isArray(originalCssTexts);
  const profiles: Map<string, CssClassProfile> = hasProvidedCss
    ? parseEpubCssProfiles(originalCssTexts)
    : new Map<string, CssClassProfile>();

  const italicSelectors = new Set<string>(['em', 'i', 'cite']);
  const boldSelectors = new Set<string>(['strong', 'b']);
  const dropcapSelectors = new Set<string>(['[data-translit-role="dropcap"]']);

  if (!hasProvidedCss) {
    italicSelectors.add('.calibre5');
    italicSelectors.add('.calibre8');
  } else {
    for (const [cls, profile] of profiles.entries()) {
      const mapped = bookStyleRoles?.[cls];
      if (mapped) {
        if (mapped.role === 'emphasis') {
          italicSelectors.add(`.${cls}`);
        } else if (
          mapped.role === 'strong' ||
          mapped.weight === 'bold' ||
          (profile.fontWeight === 'bold' &&
            (mapped.role === 'callout' ||
              mapped.role === 'body' ||
              mapped.role === 'attribution' ||
              mapped.role === 'meta'))
        ) {
          boldSelectors.add(`.${cls}`);
        } else if (mapped.role === 'dropcap') {
          dropcapSelectors.add(`.${cls}`);
        }
        continue;
      }

      if (/dropcap|stickupcap|initial|firstletter/i.test(cls)) {
        dropcapSelectors.add(`.${cls}`);
        continue;
      }

      if (
        profile.fontStyle === 'italic' &&
        profile.fontWeight !== 'bold' &&
        (profile.fontSizeEm === undefined || profile.fontSizeEm < 1.15) &&
        !/title|head|h[1-6]/i.test(cls)
      ) {
        italicSelectors.add(`.${cls}`);
      } else if (
        profile.fontWeight === 'bold' &&
        (profile.fontSizeEm === undefined || profile.fontSizeEm < 1.15) &&
        !/title|head|h[1-6]|cn|ct|fmbm_head/i.test(cls)
      ) {
        boldSelectors.add(`.${cls}`);
      }
    }
  }

  const headingSelectors = new Set<string>(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  for (const cls of STATIC_HEADING_CLASSES) {
    headingSelectors.add(`.${cls}`);
  }

  const dynamicHeadingNotRoles =
    ':not([data-translit-role="body"]):not([data-translit-role="center"]):not([data-translit-role="right"]):not([data-translit-role="epigraph"]):not([data-translit-role="quote-line"]):not([data-translit-role="callout"]):not([data-translit-role="verse"]):not([data-translit-role="attribution"]):not([data-translit-role="meta"]):not([data-translit-role="hanging"]):not([data-translit-role="caption"])';

  const zeroIndentAlignClasses = new Set<string>(STATIC_ZERO_INDENT_ALIGN_CLASSES);
  const noIndentClasses = new Set<string>([
    ...STATIC_HEADING_CLASSES,
    ...STATIC_ZERO_INDENT_ALIGN_CLASSES,
    ...STATIC_HANGING_OR_SPECIAL_NO_INDENT_CLASSES
  ]);

  if (bookStyleRoles) {
    for (const [cls, mapped] of Object.entries(bookStyleRoles)) {
      if (mapped.scope === 'inline' || mapped.role === 'ignore') continue;
      if (
        mapped.role === 'h1' ||
        mapped.role === 'h2' ||
        mapped.role === 'h3' ||
        mapped.role === 'h4'
      ) {
        headingSelectors.add(`.${cls}${dynamicHeadingNotRoles}`);
        noIndentClasses.add(cls);
      } else if (mapped.role === 'body') {
        if (mapped.indent === 'none' || mapped.align === 'center' || mapped.align === 'right') {
          noIndentClasses.add(cls);
          zeroIndentAlignClasses.add(cls);
        }
      } else {
        noIndentClasses.add(cls);
        if (
          mapped.role === 'kicker' ||
          mapped.role === 'subtitle' ||
          mapped.role === 'epigraph' ||
          mapped.role === 'attribution' ||
          mapped.role === 'callout' ||
          mapped.role === 'caption' ||
          mapped.role === 'meta' ||
          mapped.role === 'divider' ||
          mapped.align === 'center' ||
          mapped.align === 'right'
        ) {
          zeroIndentAlignClasses.add(cls);
        }
      }
    }
  }

  for (const [cls, profile] of profiles.entries()) {
    const mapped = bookStyleRoles?.[cls];
    if (mapped && mapped.role !== 'ignore') {
      continue;
    }

    const isHangingIndent = profile.textIndentEm !== undefined && profile.textIndentEm < 0;
    const isCenterOrRight = profile.textAlign === 'center' || profile.textAlign === 'right';
    const isZeroIndentSectionOpener =
      profile.textIndentEm === 0 && (profile.marginTopEm ?? 0) >= 2.0;
    const isExcludedPseudoHeading = EXCLUDED_PSEUDO_HEADING_CLASSES.test(cls);
    const isVisualPseudoHeading =
      !isHangingIndent &&
      !isExcludedPseudoHeading &&
      !profile.isInlineOnly &&
      profile.fontSizeEm !== undefined &&
      profile.fontSizeEm >= 1.15;

    if (isHangingIndent) {
      noIndentClasses.add(cls);
    } else if (isVisualPseudoHeading) {
      headingSelectors.add(`.${cls}${dynamicHeadingNotRoles}`);
      noIndentClasses.add(cls);
    } else if (isCenterOrRight) {
      zeroIndentAlignClasses.add(cls);
      noIndentClasses.add(cls);
    } else if (isZeroIndentSectionOpener || (profile.fontWeight === 'bold' && profile.textIndentEm === 0)) {
      noIndentClasses.add(cls);
    }
  }

  const notChain = Array.from(noIndentClasses)
    .map((cls) => `:not(.${cls})`)
    .join('');
  const headingSelectorList = Array.from(headingSelectors).join(',\n  ');
  const zeroIndentSelectorList = Array.from(zeroIndentAlignClasses)
    .map((cls) => `.${cls}`)
    .join(',\n  ');
  const italicSelectorList = Array.from(italicSelectors).join(', ');
  const boldSelectorList = Array.from(boldSelectors).join(', ');
  const dropcapSelectorList = Array.from(dropcapSelectors).join(', ');

  return `
  /* TransLit Chinese Bookish Typography Enhancement (Pure Heti + CLREQ Monochrome Preset) */
  body, .calibre {
    /* Leave body font-family undeclared so e-readers (NeoReader, Apple Books, Kindle, WeRead) apply user-selected fonts without "Replace All Fonts". */
    font-size: 100%;
    line-height: 1.8;
    text-align: justify;
    text-justify: inter-ideograph;
    line-break: strict;
    word-break: normal;
    overflow-wrap: break-word;
    hanging-punctuation: allow-end;
    text-spacing-trim: space-first;
    text-autospace: normal;
    -webkit-font-smoothing: antialiased;
    margin: 0;
    padding: 0;
  }

  /* Semantic Headings & Publisher Pseudo-Headings */
  ${headingSelectorList},
  [data-translit-role="h1"], [data-translit-role="h2"],
  [data-translit-role="h3"], [data-translit-role="h4"] {
    font-family: ${HETI_SANS_FONT_STACK};
    font-weight: 700;
    color: inherit;
    line-height: 1.45;
    text-align: left;
    text-indent: 0 !important;
    page-break-after: avoid;
    break-after: avoid;
  }
  h1 a, h2 a, h3 a, h4 a,
  [data-translit-role="h1"] a, [data-translit-role="h2"] a,
  [data-translit-role="h3"] a, [data-translit-role="h4"] a {
    color: inherit !important;
    text-decoration: none !important;
  }
  h1, [data-translit-role="h1"] {
    font-size: 1.45em;
    letter-spacing: 0.04em;
    margin: 1.8em 0 0.85em;
  }
  h2, [data-translit-role="h2"] {
    font-size: 1.22em;
    margin: 1.5em 0 0.65em;
  }
  h3, [data-translit-role="h3"] {
    font-size: 1.08em;
    margin: 1.25em 0 0.5em;
  }
  h4, h5, h6, [data-translit-role="h4"] {
    font-size: 1em;
    margin: 1.1em 0 0.4em;
  }
  [data-translit-role="kicker"] {
    font-family: ${HETI_SANS_FONT_STACK};
    font-size: 0.88em;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: inherit;
    opacity: 0.72;
    margin: 1.8em 0 0.25em;
    text-indent: 0 !important;
    page-break-after: avoid;
    break-after: avoid;
  }
  [data-translit-role="subtitle"] {
    font-family: ${HETI_KAI_FONT_STACK};
    font-size: 1.05em;
    font-weight: 400;
    color: inherit;
    opacity: 0.78;
    margin: -0.35em 0 1.2em;
    text-indent: 0 !important;
    page-break-after: avoid;
    break-after: avoid;
  }

  /* Chapter Title Tables (e.g. Calibre table.title1 / table.title2) */
  [data-translit-role="title-table"], table.title1, table.title2 {
    width: 100%;
    border-collapse: collapse;
    margin: 1.5em 0 1.4em;
    border: none;
  }
  [data-translit-role="title-num-empty"] {
    display: none !important;
  }
  [data-translit-role="title-num"], table.title1 td.bor1, table.title2 td.bor1,
  table.title1 td.bor, table.title2 td.bor {
    border: none;
    border-right: 2px solid rgba(128, 128, 128, 0.45);
    padding: 0 0.65em 0 0;
    font-family: ${HETI_SANS_FONT_STACK};
    font-weight: 700;
    font-size: 1.45em;
    line-height: 1.4;
    color: inherit;
    vertical-align: middle;
    width: auto;
    white-space: nowrap;
    text-align: right;
    text-indent: 0 !important;
  }
  [data-translit-role="title-table"] td:last-child,
  table.title1 td:last-child, table.title2 td:last-child {
    border: none;
    padding: 0 0 0 0.75em;
    text-align: left;
    vertical-align: middle;
  }
  [data-translit-role="title-num-empty"] + td:last-child {
    padding-left: 0 !important;
  }
  [data-translit-role="title-table"] [data-translit-role="h1"],
  table.title1 td.top, table.title2 td.top {
    font-size: 1.45em !important;
    font-weight: 700;
    line-height: 1.4;
    margin: 0 !important;
    color: inherit;
  }
  [data-translit-role="title-table"] [data-translit-role="h1"] small,
  table.title1 td.top small, table.title2 td.top small {
    font-size: 1em !important;
  }
  [data-translit-role="title-table"] [data-translit-role="h2"],
  [data-translit-role="title-table"] .top-int1 {
    font-size: 1.05em !important;
    font-weight: 600;
    line-height: 1.5;
    margin: 0.35em 0 0 !important;
    color: inherit;
    opacity: 0.78;
    font-family: ${HETI_SANS_FONT_STACK} !important;
  }
  [data-translit-role="title-table"] i,
  [data-translit-role="title-table"] em {
    font-family: inherit !important;
    font-style: normal;
  }

  /* Preserve non-indented centered, right-aligned, caption, and signature blocks */
  ${zeroIndentSelectorList},
  [data-translit-role="center"], [data-translit-role="right"],
  [data-translit-role="attribution"], [data-translit-role="caption"],
  [data-translit-role="divider"], [data-translit-role="meta"],
  [data-translit-role="callout"] {
    text-indent: 0 !important;
  }
  [data-translit-role="center"] {
    text-align: center !important;
    margin: 1.1em 0;
  }
  [data-translit-role="center"] + [data-translit-role="center"] {
    margin-top: 0.35em;
  }
  [data-translit-role="right"], [data-translit-role="attribution"] {
    text-align: right !important;
    font-family: ${HETI_KAI_FONT_STACK};
    font-size: 0.9em;
    color: inherit;
    opacity: 0.78;
    margin: 0.45em 0 1.2em;
  }
  [data-translit-role="epigraph"] {
    font-family: ${HETI_KAI_FONT_STACK};
    font-size: 0.94em;
    color: inherit;
    opacity: 0.85;
    margin: 1.2em 1.8em;
    line-height: 1.75;
    text-indent: 0 !important;
  }
  [data-translit-role="verse"] {
    font-family: ${HETI_KAI_FONT_STACK};
    font-size: 0.95em;
    color: inherit;
    line-height: 1.7;
    text-align: left !important;
    padding-left: 2em !important;
    text-indent: -2em !important;
    margin: 0.15em 0;
  }
  [data-translit-role="callout"] {
    font-size: 0.94em;
    line-height: 1.72;
    color: inherit;
    padding: 0.8em 1em;
    margin: 1.2em 0;
    border: 1px solid rgba(128, 128, 128, 0.24);
    background-color: rgba(128, 128, 128, 0.06);
    text-indent: 0 !important;
  }
  [data-translit-role="meta"] {
    font-size: 0.86em;
    line-height: 1.62;
    color: inherit;
    opacity: 0.76;
    text-indent: 0 !important;
    margin: 0.35em 0;
  }
  [data-translit-role="hanging"] {
    padding-left: 2em !important;
    text-indent: -2em !important;
    font-size: 0.92em;
    line-height: 1.7;
    margin: 0.45em 0;
    list-style: none !important;
    list-style-type: none !important;
  }

  /* Neutralize Western dropcaps for Chinese typography */
  ${dropcapSelectorList} {
    float: none !important;
    font-size: 1em !important;
    font-weight: inherit !important;
    line-height: inherit !important;
    font-variant: normal;
    margin: 0 !important;
    padding: 0 !important;
    vertical-align: baseline !important;
  }

  /* Chinese Typography Standard: Upright KaiTi/FangSong for italics without fake slanted CJK glyphs */
  ${italicSelectorList} {
    font-style: normal;
    font-family: ${HETI_KAI_FONT_STACK};
  }
  [data-translit-role="emphasis"] {
    font-style: normal;
    font-family: ${HETI_KAI_FONT_STACK};
  }
  ${boldSelectorList}, [data-translit-role="strong"], [data-translit-weight="bold"] {
    font-weight: 700;
    color: inherit;
  }
  [data-translit-role="code"] {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.88em;
    background-color: rgba(128, 128, 128, 0.08);
    padding: 0.1em 0.3em;
    border-radius: 2px;
  }

  /* Heti Inline Details: Keep footnote superscripts from inflating line height & offset proper-noun underlines */
  sup, sub {
    line-height: 0;
    font-size: 0.75em;
    vertical-align: baseline;
    position: relative;
  }
  sup { top: -0.5em; }
  sub { bottom: -0.25em; }
  u {
    text-decoration: underline;
    text-underline-offset: 0.25em;
    text-decoration-thickness: 1px;
  }
  abbr[title] {
    text-decoration: underline dotted;
    text-underline-offset: 0.25em;
  }

  /* Blockquote & Quote Lines: Pure Heti Upright KaiTi with hairline theme-adaptive border */
  blockquote {
    font-style: normal;
    font-family: ${HETI_KAI_FONT_STACK};
    font-size: 0.95em !important;
    color: inherit;
    margin: 1.4em 0 1.4em 0.8em !important;
    padding: 0.55em 1em 0.55em 1.15em !important;
    border: none !important;
    border-left: 2px solid rgba(128, 128, 128, 0.38) !important;
    background-color: rgba(128, 128, 128, 0.05);
  }

  /* Prevent border and box stacking inside nested blockquotes (e.g. Calibre multi-level blockquotes) */
  blockquote blockquote {
    font-size: 1em !important;
    border-left: none !important;
    background-color: transparent !important;
    padding: 0 !important;
    margin: 0.3em 0 0.3em 1em !important;
  }

  blockquote p {
    font-family: inherit;
    font-size: 1em !important;
    color: inherit;
    line-height: 1.75;
    margin: 0.5em 0 !important;
    text-indent: 2em !important;
  }
  blockquote p[data-translit-role="center"],
  blockquote p[data-translit-align="center"] {
    text-indent: 0 !important;
    text-align: center !important;
  }

  [data-translit-role="quote-line"] {
    font-style: normal;
    font-family: ${HETI_KAI_FONT_STACK} !important;
    font-size: 0.95em !important;
    font-weight: normal !important;
    font-variant: normal !important;
    color: inherit;
    line-height: 1.75;
    margin: 0 0 0 0.8em !important;
    padding: 0.15em 1em 0.15em 1.15em !important;
    border: none !important;
    border-left: 2px solid rgba(128, 128, 128, 0.38) !important;
    background-color: rgba(128, 128, 128, 0.05);
    text-indent: 0 !important;
  }
  [data-translit-role="quote-line"][data-translit-quote-pos="first"] {
    margin-top: 1.3em !important;
    padding-top: 0.55em !important;
  }
  [data-translit-role="quote-line"][data-translit-quote-pos="last"] {
    margin-bottom: 1.3em !important;
    padding-bottom: 0.55em !important;
  }
  [data-translit-role="quote-line"][data-translit-quote-pos="single"] {
    margin-top: 1.3em !important;
    margin-bottom: 1.3em !important;
    padding-top: 0.55em !important;
    padding-bottom: 0.55em !important;
  }
  blockquote [data-translit-role="quote-line"] {
    border-left: none !important;
    background-color: transparent !important;
    margin: 0.45em 0 !important;
    padding: 0 !important;
    font-size: 1em !important;
  }

  /* Invert nested emphasis inside KaiTi quote/epigraph/verse blocks back to upright SongTi */
  blockquote em, blockquote i,
  [data-translit-role="quote-line"] em, [data-translit-role="quote-line"] i,
  [data-translit-role="epigraph"] em, [data-translit-role="epigraph"] i,
  [data-translit-role="verse"] em, [data-translit-role="verse"] i {
    font-family: ${HETI_SERIF_FONT_STACK} !important;
    font-style: normal;
  }

  /* Normalize lists for harmonious CJK reading */
  ol, ul {
    font-size: 0.96em !important;
    line-height: 1.8;
    margin: 0.9em 0;
    padding-left: 2em;
  }
  ol ol, ol ul, ul ol, ul ul {
    font-size: 1em !important;
  }
  li {
    line-height: 1.8;
    margin: 0.3em 0;
  }
  li p {
    text-indent: 0 !important;
  }
  ol[data-translit-list="none"], ul[data-translit-list="none"] {
    list-style: none !important;
    list-style-type: none !important;
    padding-left: 0 !important;
  }
  ol[data-translit-list="none"] > li, ul[data-translit-list="none"] > li,
  li[data-translit-list="none"], li[data-translit-role="hanging"] {
    list-style: none !important;
    list-style-type: none !important;
  }

  /* Unified Chinese body paragraph indent while protecting headings, centered/right blocks, captions, and hanging indents */
  p[data-translit-role="body"]:not([data-translit-indent="none"]):not([data-translit-align="center"]):not([data-translit-align="right"]), p${notChain} {
    font-size: 1em;
    text-indent: 2em !important;
    margin: 0.45em 0;
    line-height: 1.8;
    line-break: strict;
    word-break: normal;
    overflow-wrap: break-word;
    hanging-punctuation: allow-end;
    text-spacing-trim: space-first;
    text-autospace: normal;
  }

  /* Orthogonal modifier overrides */
  [data-translit-align="center"] {
    text-align: center !important;
    text-indent: 0 !important;
  }
  [data-translit-align="right"] {
    text-align: right !important;
    text-indent: 0 !important;
  }
  [data-translit-align="left"] {
    text-align: left !important;
  }
  [data-translit-indent="none"] {
    text-indent: 0 !important;
  }
  [data-translit-merged="true"] {
    display: none !important;
  }

  /* Data tables, code, captions, dividers & media */
  [data-translit-role="data-table"] {
    width: 100%;
    border-collapse: collapse;
    margin: 1.4em 0;
    font-size: 0.92em;
  }
  [data-translit-role="data-table"] th, [data-translit-role="data-table"] td {
    border: 1px solid rgba(128, 128, 128, 0.28);
    padding: 0.45em 0.75em;
    text-indent: 0 !important;
  }
  [data-translit-role="data-table"] th {
    background-color: rgba(128, 128, 128, 0.07);
    font-weight: 700;
  }
  table p, td p, th p {
    text-indent: 0 !important;
  }
  pre, code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.88em;
    background-color: rgba(128, 128, 128, 0.07);
    border-radius: 3px;
    text-indent: 0 !important;
  }
  pre {
    padding: 0.75em 1em;
    overflow-x: auto;
    line-height: 1.55;
    margin: 1.1em 0;
  }
  code {
    padding: 0.1em 0.3em;
  }
  pre code {
    padding: 0;
    background: none;
  }
  caption, figcaption, [data-translit-role="caption"] {
    text-indent: 0 !important;
    text-align: center !important;
    font-size: 0.88em;
    color: inherit;
    opacity: 0.76;
    font-family: ${HETI_KAI_FONT_STACK};
    margin: 0.5em 0 1.3em;
  }
  p.line, .line, [data-translit-role="divider"] {
    text-indent: 0 !important;
    text-align: center !important;
    opacity: 0.65;
    letter-spacing: 0.35em;
    margin: 1.5em 0;
  }
  hr {
    border: none;
    border-top: 1px solid rgba(128, 128, 128, 0.28);
    margin: 1.8em auto;
    width: 40%;
  }
  img, svg {
    max-width: 100%;
    height: auto;
  }
`;
}

export const BILINGUAL_EPUB_CSS = `
  /* TransLit Bilingual Paragraph Alignment Styles (Pure Heti + CLREQ Enhanced) */
  .bilingual-pair {
    margin-top: 1.4em;
    margin-bottom: 1.4em;
  }
  .bilingual-source {
    font-family: "Georgia", "Garamond", "Times New Roman", serif;
    font-size: 0.9em;
    line-height: 1.55;
    word-break: normal;
    overflow-wrap: break-word;
    color: inherit;
    opacity: 0.72;
    margin-top: 0.2em;
    margin-bottom: 0.35em;
  }
  .bilingual-source p {
    text-indent: 0;
    margin: 0.2em 0;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
  }
  .bilingual-source em, .bilingual-source i {
    font-style: italic;
    font-family: inherit;
  }
  .bilingual-target {
    font-size: 1.02em;
    line-height: 1.8;
    line-break: strict;
    word-break: normal;
    overflow-wrap: break-word;
    hanging-punctuation: allow-end;
    text-spacing-trim: space-first;
    text-autospace: normal;
    color: inherit;
    margin-top: 0.2em;
    margin-bottom: 0.35em;
  }
  .bilingual-target p {
    text-indent: 2em;
    margin: 0.2em 0;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
  }
  /* Chinese typography standard: Roman KaiTi for italics without fake slant */
  .bilingual-target em, .bilingual-target i {
    font-style: normal;
    font-family: ${HETI_KAI_FONT_STACK};
    font-weight: normal;
  }
  .bilingual-heading {
    margin-top: 2em;
    margin-bottom: 1.8em;
    text-align: center;
  }
  .bilingual-heading p {
    text-align: justify;
    text-indent: 2em;
  }
  .bilingual-heading blockquote {
    text-align: justify;
  }
  .bilingual-heading h1, .bilingual-heading h2, .bilingual-heading h3,
  .bilingual-heading h4, .bilingual-heading h5, .bilingual-heading h6 {
    margin: 0.25em 0;
  }
  .bilingual-heading .bilingual-source h1, .bilingual-heading .bilingual-source h2,
  .bilingual-heading .bilingual-source h3, .bilingual-heading .bilingual-source h4,
  .bilingual-heading .bilingual-source h5, .bilingual-heading .bilingual-source h6 {
    font-size: 0.88em;
    color: inherit;
    opacity: 0.72;
    font-weight: normal;
    text-align: center;
    border-bottom: none;
    text-indent: 0;
  }
  .bilingual-heading .bilingual-target h1, .bilingual-heading .bilingual-target h2,
  .bilingual-heading .bilingual-target h3, .bilingual-heading .bilingual-target h4,
  .bilingual-heading .bilingual-target h5, .bilingual-heading .bilingual-target h6 {
    text-align: center;
    text-indent: 0;
  }
  .bilingual-image {
    margin: 1.5em auto;
    text-align: center;
  }
  .bilingual-source blockquote, .bilingual-target blockquote {
    margin: 0.3em 0;
    padding: 0;
    border: none;
    background: none;
  }
  .bilingual-source blockquote {
    font-style: italic;
    color: inherit;
    opacity: 0.72;
  }
  .bilingual-source blockquote p {
    text-indent: 0;
    margin: 0.2em 0;
  }
  .bilingual-target blockquote {
    font-style: normal;
    font-family: ${HETI_KAI_FONT_STACK};
    color: inherit;
    border: none;
    border-left: 2px solid rgba(128, 128, 128, 0.38);
    background-color: rgba(128, 128, 128, 0.05);
    padding: 0.5em 1em 0.5em 1.15em;
    margin: 0.6em 0;
  }
  .bilingual-target blockquote blockquote {
    border-left: none;
    background: none;
    padding: 0;
    margin: 0.3em 0 0.3em 1em;
  }
  .bilingual-target blockquote p {
    text-indent: 2em;
    margin: 0.3em 0;
  }
`;

export const CHINESE_TYPOGRAPHY_ENHANCEMENT_CSS = buildAdaptiveChineseTypographyCss();

/**
 * Strips hardcoded `font-family` declarations from per-chapter `<style>` blocks and
 * `<body style="...">` attributes in Chinese EPUB exports so e-readers can apply
 * user-selected fonts to body text while preserving external CSS role fonts (e.g. KaiTi).
 */
export function stripInlineFontFamilyForChineseEpub(xhtml: string): string {
  if (!xhtml) return xhtml;
  let updated = xhtml.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, openTag: string, cssBody: string, closeTag: string) => {
      const cleanedCss = cssBody.replace(/font-family\s*:[^;{}]*(?:;|(?=\}))/gi, '');
      return `${openTag}${cleanedCss}${closeTag}`;
    }
  );
  updated = updated.replace(/<body\b[^>]*>/gi, (bodyTag) => {
    return bodyTag.replace(
      /\s*\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
      (_attrMatch, dqVal: string | undefined, sqVal: string | undefined) => {
        const quote = dqVal !== undefined ? '"' : "'";
        const rawStyle = dqVal !== undefined ? dqVal : (sqVal ?? '');
        if (!/font-family\s*:/i.test(rawStyle)) {
          return ` style=${quote}${rawStyle}${quote}`;
        }
        const cleanedDecls = rawStyle
          .split(';')
          .map((d) => d.trim())
          .filter((d) => d.length > 0 && !/^font-family\s*:/i.test(d));
        if (cleanedDecls.length === 0) {
          return '';
        }
        return ` style=${quote}${cleanedDecls.join('; ')}${quote}`;
      }
    );
  });
  return updated;
}

export interface MarkdownBlock {
  type: 'heading' | 'image' | 'hr' | 'code' | 'table' | 'blockquote' | 'list' | 'paragraph';
  content: string;
  level?: number;
  imageSrc?: string;
}

export function splitMarkdownIntoBlocks(markdown: string): MarkdownBlock[] {
  if (!markdown || !markdown.trim()) return [];

  const lines = markdown.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let currentLines: string[] = [];
  let currentType: MarkdownBlock['type'] | null = null;
  let inFencedCode = false;

  const flush = () => {
    if (currentLines.length === 0) return;
    const text = currentLines.join('\n').trim();
    if (text) {
      blocks.push(classifyBlock(text, currentType));
    }
    currentLines = [];
    currentType = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code blocks
    if (/^```/.test(trimmed)) {
      if (inFencedCode) {
        currentLines.push(line);
        inFencedCode = false;
        flush();
        continue;
      } else {
        flush();
        inFencedCode = true;
        currentType = 'code';
        currentLines.push(line);
        continue;
      }
    }

    if (inFencedCode) {
      currentLines.push(line);
      continue;
    }

    // Blank line terminates current block
    if (!trimmed) {
      flush();
      continue;
    }

    // Headings
    if (/^#{1,6}\s+/.test(trimmed)) {
      flush();
      blocks.push(classifyBlock(trimmed, 'heading'));
      continue;
    }

    // Horizontal rules
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ type: 'hr', content: trimmed });
      continue;
    }

    // Standalone images: ![alt](url) or <img ... />
    if (/^!\[.*?\]\(.*?\)$/.test(trimmed) || /^<img\b[^>]*\/?>$/i.test(trimmed)) {
      flush();
      blocks.push(classifyBlock(trimmed, 'image'));
      continue;
    }

    // Tables
    if (/^\|/.test(trimmed)) {
      if (currentType !== 'table') {
        flush();
        currentType = 'table';
      }
      currentLines.push(line);
      continue;
    }

    // Blockquotes
    if (/^>/.test(trimmed)) {
      if (currentType !== 'blockquote') {
        flush();
        currentType = 'blockquote';
      }
      currentLines.push(line);
      continue;
    }

    // Lists
    if (/^([-*+]|\d+[.)])\s+/.test(trimmed)) {
      if (currentType !== 'list') {
        flush();
        currentType = 'list';
      }
      currentLines.push(line);
      continue;
    }

    // Normal paragraph lines
    if (currentType === null) {
      currentType = 'paragraph';
    } else if (currentType !== 'paragraph') {
      flush();
      currentType = 'paragraph';
    }
    currentLines.push(line);
  }

  flush();
  return blocks;
}

function classifyBlock(text: string, suggestedType: MarkdownBlock['type'] | null): MarkdownBlock {
  const trimmed = text.trim();
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return {
      type: 'heading',
      content: trimmed,
      level: headingMatch[1].length
    };
  }
  const imgMatch =
    trimmed.match(/^!\[(.*?)\]\((.+?)\)$/) ||
    trimmed.match(/<img\b[^>]*src=["']([^"']+)["'][^>]*\/?>/i);
  if (imgMatch) {
    return {
      type: 'image',
      content: trimmed,
      imageSrc: imgMatch[2] || imgMatch[1]
    };
  }
  if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
    return { type: 'hr', content: trimmed };
  }
  if (trimmed.startsWith('```')) {
    return { type: 'code', content: trimmed };
  }
  if (suggestedType === 'table' || trimmed.startsWith('|')) {
    return { type: 'table', content: trimmed };
  }
  if (suggestedType === 'blockquote' || trimmed.startsWith('>')) {
    return { type: 'blockquote', content: trimmed };
  }
  if (suggestedType === 'list' || /^([-*+]|\d+[.)])\s+/.test(trimmed)) {
    return { type: 'list', content: trimmed };
  }
  return { type: 'paragraph', content: trimmed };
}

export interface BilingualPair {
  type: MarkdownBlock['type'];
  sourceContent?: string;
  targetContent?: string;
  level?: number;
  imageSrc?: string;
}

function computePairCost(s: MarkdownBlock[], t: MarkdownBlock[]): number {
  const isS = s.length > 0;
  const isT = t.length > 0;

  // Unaligned source block
  if (isS && !isT) {
    if (s[0].type === 'image' || s[0].type === 'hr') return 0.5;
    return 25.0;
  }

  // Unaligned target block
  if (!isS && isT) {
    if (t[0].type === 'image' || t[0].type === 'hr') return 0.5;
    return 25.0;
  }

  if (isS && isT) {
    const sType = s[0].type;
    const tType = t[0].type;

    // Both are images: perfect match
    if (sType === 'image' && tType === 'image') return 0;
    // Both are hr: perfect match
    if (sType === 'hr' && tType === 'hr') return 0;

    // Image/hr paired with text: strictly avoid
    if ((sType === 'image' || sType === 'hr') !== (tType === 'image' || tType === 'hr')) {
      return 1000.0;
    }

    let cost = 0;

    // Headings prefer 1-to-1 alignment; also support translated headings where LLM omitted `#` prefixes
    const hasHeading = s.some((b) => b.type === 'heading') || t.some((b) => b.type === 'heading');
    if (hasHeading) {
      if (s.length === 1 && t.length === 1) {
        if (s[0].type === 'heading' && t[0].type === 'heading') {
          let cost = -40.0;
          if (s[0].level === t[0].level) cost -= 10.0;
          return cost;
        }
        if (
          s[0].type === 'heading' &&
          t[0].type === 'paragraph' &&
          !t[0].content.includes('\n') &&
          t[0].content.trim().length <= 100 &&
          t[0].content.trim().length <= s[0].content.length * 3 + 30
        ) {
          const sLen = s[0].content.replace(/^#+\s*/, '').length;
          const tLen = t[0].content.trim().length;
          const diff = Math.abs(sLen - tLen * 1.8) / Math.max(sLen, 8);
          return -20.0 + Math.min(diff * 4, 10.0);
        }
      }
      return 1000.0; // Strictly forbid merging heading with body paragraphs, blockquotes, or images
    }

    // Type compatibility
    const isProse = (type: string) => type === 'paragraph' || type === 'blockquote';
    if (sType !== tType) {
      if (isProse(sType) && isProse(tType)) {
        cost += 1.5; // Highly compatible prose (paragraph vs blockquote)
      } else {
        cost += 10.0;
      }
    }

    // Footnote slot overlap bonus (normalized across {{TRANSLITFNSLOT:...}}, __FN_REF_...__, and [^...])
    const extractSlots = (blocks: MarkdownBlock[]) => {
      const slots = new Set<string>();
      for (const b of blocks) {
        const re = /(?:\{\{TRANSLITFNSLOT:([A-Za-z0-9_-]+)\}\}|__FN_REF_([A-Za-z0-9_-]+)__|\[\^(?:fn-)?([A-Za-z0-9_-]+)\])/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(b.content)) !== null) {
          const rawId = match[1] || match[2] || match[3];
          if (rawId) {
            slots.add(rawId.replace(/^fn-/, ''));
          }
        }
      }
      return slots;
    };
    const sSlots = extractSlots(s);
    const tSlots = extractSlots(t);

    let sharedSlots = 0;
    for (const slot of sSlots) {
      if (tSlots.has(slot)) sharedSlots++;
    }
    if (sharedSlots > 0) {
      cost -= sharedSlots * 35.0;
    }

    // Length ratio score (English words to Chinese characters: ~1.8 chars/char)
    const sLen = s.reduce((sum, b) => sum + b.content.length, 0);
    const tLen = t.reduce((sum, b) => sum + b.content.length, 0);
    const diff = Math.abs(sLen - tLen * 1.8) / Math.max(sLen, 15);
    cost += Math.min(diff * 6, 20.0);

    // Prefer 1-to-1: reward 1-to-1, penalize 1-to-2 or 2-to-1
    if (s.length === 1 && t.length === 1) {
      cost -= 5.0;
    } else if (s.length > 1 || t.length > 1) {
      cost += 12.0;
    }

    return cost;
  }

  return 1000.0;
}

export function alignMarkdownBlocks(
  sourceBlocks: MarkdownBlock[],
  targetBlocks: MarkdownBlock[]
): BilingualPair[] {
  const N = sourceBlocks.length;
  const M = targetBlocks.length;

  if (N === 0 && M === 0) return [];
  if (N === 0) {
    return targetBlocks.map((b) => ({
      type: b.type,
      targetContent: b.content,
      level: b.level,
      imageSrc: b.imageSrc
    }));
  }
  if (M === 0) {
    return sourceBlocks.map((b) => ({
      type: b.type,
      sourceContent: b.content,
      level: b.level,
      imageSrc: b.imageSrc
    }));
  }

  const dp: Array<Array<{ cost: number; prevI: number; prevJ: number; sCount: number; tCount: number }>> = [];
  for (let i = 0; i <= N; i++) {
    dp[i] = [];
    for (let j = 0; j <= M; j++) {
      dp[i][j] = { cost: Infinity, prevI: -1, prevJ: -1, sCount: 0, tCount: 0 };
    }
  }

  dp[0][0] = { cost: 0, prevI: -1, prevJ: -1, sCount: 0, tCount: 0 };

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= M; j++) {
      const currentCost = dp[i][j].cost;
      if (currentCost === Infinity) continue;

      // Transition 1: 1-to-1
      if (i + 1 <= N && j + 1 <= M) {
        const c = currentCost + computePairCost([sourceBlocks[i]], [targetBlocks[j]]);
        if (c < dp[i + 1][j + 1].cost) {
          dp[i + 1][j + 1] = { cost: c, prevI: i, prevJ: j, sCount: 1, tCount: 1 };
        }
      }

      // Transition 2: 1-to-2 (source split into 2 target blocks)
      if (i + 1 <= N && j + 2 <= M) {
        const c = currentCost + computePairCost([sourceBlocks[i]], [targetBlocks[j], targetBlocks[j + 1]]);
        if (c < dp[i + 1][j + 2].cost) {
          dp[i + 1][j + 2] = { cost: c, prevI: i, prevJ: j, sCount: 1, tCount: 2 };
        }
      }

      // Transition 3: 2-to-1 (2 source blocks merged into 1 target block)
      if (i + 2 <= N && j + 1 <= M) {
        const c = currentCost + computePairCost([sourceBlocks[i], sourceBlocks[i + 1]], [targetBlocks[j]]);
        if (c < dp[i + 2][j + 1].cost) {
          dp[i + 2][j + 1] = { cost: c, prevI: i, prevJ: j, sCount: 2, tCount: 1 };
        }
      }

      // Transition 4: standalone source
      if (i + 1 <= N) {
        const c = currentCost + computePairCost([sourceBlocks[i]], []);
        if (c < dp[i + 1][j].cost) {
          dp[i + 1][j] = { cost: c, prevI: i, prevJ: j, sCount: 1, tCount: 0 };
        }
      }

      // Transition 5: standalone target
      if (j + 1 <= M) {
        const c = currentCost + computePairCost([], [targetBlocks[j]]);
        if (c < dp[i][j + 1].cost) {
          dp[i][j + 1] = { cost: c, prevI: i, prevJ: j, sCount: 0, tCount: 1 };
        }
      }
    }
  }

  const pairs: BilingualPair[] = [];
  let currI = N;
  let currJ = M;

  while (currI > 0 || currJ > 0) {
    const step = dp[currI][currJ];
    const { prevI, prevJ, sCount, tCount } = step;

    if (sCount > 0 && tCount > 0) {
      const sSlice = sourceBlocks.slice(prevI, prevI + sCount);
      const tSlice = targetBlocks.slice(prevJ, prevJ + tCount);
      const sText = sSlice.map((b) => b.content).join('\n\n');
      let tText = tSlice.map((b) => b.content).join('\n\n');
      const mainType = sSlice[0].type;
      const level = sSlice[0].level || tSlice[0].level;
      if (
        mainType === 'heading' &&
        sSlice.length === 1 &&
        tSlice.length === 1 &&
        !/^#{1,6}\s/.test(tText.trim())
      ) {
        tText = `${'#'.repeat(level || 1)} ${tText.trim()}`;
      }
      const imageSrc = sSlice[0].imageSrc || tSlice[0].imageSrc;
      pairs.push({
        type: mainType,
        sourceContent: sText,
        targetContent: tText,
        level,
        imageSrc
      });
    } else if (sCount > 0) {
      const sSlice = sourceBlocks.slice(prevI, prevI + sCount);
      pairs.push({
        type: sSlice[0].type,
        sourceContent: sSlice.map((b) => b.content).join('\n\n'),
        level: sSlice[0].level,
        imageSrc: sSlice[0].imageSrc
      });
    } else if (tCount > 0) {
      const tSlice = targetBlocks.slice(prevJ, prevJ + tCount);
      pairs.push({
        type: tSlice[0].type,
        targetContent: tSlice.map((b) => b.content).join('\n\n'),
        level: tSlice[0].level,
        imageSrc: tSlice[0].imageSrc
      });
    }

    currI = prevI;
    currJ = prevJ;
  }

  pairs.reverse();
  return pairs;
}

export class EpubService {
  private footnoteResolver = new FootnoteResolver();
  private pageClassifier = new PageClassifier();
  private domMutationEngine = new DomMutationEngine();

  /**
   * Refreshes a chapter's translatable payload if it contains legacy Turndown markdown artifacts
   * (such as `![img]` or `>` blockquote tokens), re-extracting clean payload via DomMutationEngine.
   */
  public refreshChapterPayloadIfNeeded(chapter: Chapter): boolean {
    if (!chapter.content) return false;
    const combinedMarkdown = `${chapter.markdown || ''}\n${chapter.slottedMarkdown || ''}`;
    const hasLegacyArtifacts = /!\[.*?\]\(.*?\)|<img\b|^[ \t]*>+|>>+/m.test(combinedMarkdown);
    if (hasLegacyArtifacts) {
      const res = this.domMutationEngine.extractTranslatablePayload(
        chapter.content,
        chapter.internalizedFootnotes
      );
      if (res.payloadText) {
        chapter.markdown = res.payloadText;
        chapter.slottedMarkdown = res.payloadText;
        return true;
      }
    }
    return false;
  }

  async parseEpub(file: File | Blob | ArrayBuffer | Uint8Array): Promise<{
    chapters: Chapter[];
    images: Record<string, Blob>;
    coverPath?: string;
    opfPath: string;
    opfDir: string;
    cssFiles: string[];
    cssContents: string[];
    detectedLanguage: string;
    detectedLanguageSource: LanguageDetectionSource;
  }> {
    const zip = new JSZip();
    const loadedZip = await zip.loadAsync(file as any);

    const containerFile = loadedZip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('Invalid EPUB: Missing META-INF/container.xml');

    const containerXml = await containerFile.async('string');
    const containerDoc = parseXmlDocument(containerXml);
    const rootfileNode = containerDoc.querySelector('rootfile');

    if (!rootfileNode) throw new Error('Invalid EPUB: Missing rootfile in container.xml');
    const opfPath = rootfileNode.getAttribute('full-path');
    if (!opfPath) throw new Error('Invalid EPUB: rootfile missing full-path');

    const opfFile = loadedZip.file(opfPath);
    if (!opfFile) throw new Error(`Invalid EPUB: OPF file not found at ${opfPath}`);

    const opfXml = await opfFile.async('string');
    const opfDoc = parseXmlDocument(opfXml);

    const opfLanguage =
      opfDoc.getElementsByTagNameNS('*', 'language')[0]?.textContent?.trim() ||
      opfDoc.querySelector('language')?.textContent?.trim();

    const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

    const manifestItems = Array.from(opfDoc.querySelectorAll('manifest > item')).reduce(
      (acc, item) => {
        acc[item.getAttribute('id')!] = item.getAttribute('href')!;
        return acc;
      },
      {} as Record<string, string>
    );

    // Get list of CSS files and pre-parse EPUB CSS profiles for pseudo-heading detection
    let cssFiles = Array.from(
      opfDoc.querySelectorAll("manifest > item[media-type='text/css']")
    ).map((item) => opfDir + item.getAttribute('href')!);

    if (cssFiles.length === 0) {
      cssFiles = Object.keys(loadedZip.files).filter((p) => /\.css$/i.test(p));
    }

    const rawCssTexts: string[] = [];
    for (const cssPath of cssFiles) {
      const cssFile = loadedZip.file(cssPath);
      if (cssFile) {
        rawCssTexts.push(await cssFile.async('string'));
      }
    }
    const cssProfiles = parseEpubCssProfiles(rawCssTexts);

    // Find Navigation File (NCX or NAV)
    const tocMap: Record<string, string> = {};
    const spine = opfDoc.querySelector('spine');
    const tocId = spine?.getAttribute('toc');

    // Try NCX (EPUB 2/3)
    if (tocId && manifestItems[tocId]) {
      const ncxRelPath = manifestItems[tocId];
      const ncxFile = loadedZip.file(opfDir + ncxRelPath);
      if (ncxFile) {
        const ncxXml = await ncxFile.async('string');
        const ncxDoc = parseXmlDocument(ncxXml);
        const navPoints = ncxDoc.querySelectorAll('navPoint');
        navPoints.forEach((point) => {
          const label = point.querySelector('navLabel > text')?.textContent?.trim();
          const src = point.querySelector('content')?.getAttribute('src');
          if (label && src) {
            const rawHref = src.split('#')[0];
            const resolvedHref = resolveRelativeEpubHref(ncxRelPath, rawHref).filePath || normalizeEpubFilePath(rawHref);
            if (resolvedHref && !tocMap[resolvedHref]) tocMap[resolvedHref] = label;
          }
        });
      }
    }

    // Try NAV (EPUB 3) if NCX failed or as secondary source
    const navItem = opfDoc.querySelector('manifest > item[properties~="nav"]');
    if (navItem) {
      const navHref = navItem.getAttribute('href');
      if (navHref) {
        const navFile = loadedZip.file(opfDir + navHref);
        if (navFile) {
          const navHtml = await navFile.async('string');
          const navDoc = parseHtmlDocument(navHtml);
          const links = navDoc.querySelectorAll('nav[epub\\:type="toc"] a, nav#toc a');
          links.forEach((a) => {
            const label = a.textContent?.trim();
            const src = a.getAttribute('href');
            if (label && src) {
              const rawHref = src.split('#')[0];
              const resolvedHref = resolveRelativeEpubHref(navHref, rawHref).filePath || normalizeEpubFilePath(rawHref);
              if (resolvedHref && !tocMap[resolvedHref]) tocMap[resolvedHref] = label;
            }
          });
        }
      }
    }

    const spineRefs = Array.from(opfDoc.querySelectorAll('spine > itemref'));

    let coverId = opfDoc.querySelector('meta[name="cover"]')?.getAttribute('content');

    if (!coverId) {
      const coverItem = opfDoc.querySelector('manifest > item[properties~="cover-image"]');
      if (coverItem) {
        coverId = coverItem.getAttribute('id');
      }
    }

    let coverPath: string | undefined = undefined;
    if (coverId && manifestItems[coverId]) {
      coverPath = opfDir + manifestItems[coverId];
    }

    const rawChapters: Chapter[] = [];
    const images: Record<string, Blob> = {};

    for (const [path, fileObj] of Object.entries(loadedZip.files)) {
      if (path.match(/\.(png|jpe?g|gif|svg|webp)$/i)) {
        const blob = await (fileObj as any).async('blob');
        images[path] = blob;
      }
    }

    // Collect all XHTML/HTML files in manifest for global FootnoteResolver pre-scan
    const allXhtmlFiles: Record<string, string> = {};
    const spineHrefs: string[] = [];

    for (const ref of spineRefs) {
      const id = ref.getAttribute('idref');
      if (!id || !manifestItems[id]) continue;
      const href = manifestItems[id];
      const fullPath = opfDir + href;
      const fileObj = loadedZip.file(fullPath);
      if (fileObj) {
        const htmlContent = await fileObj.async('string');
        allXhtmlFiles[normalizeEpubFilePath(href)] = htmlContent;
        spineHrefs.push(normalizeEpubFilePath(href));
      }
    }

    // Also include any non-spine manifest XHTML files (e.g., non-linear footnote files)
    for (const [, href] of Object.entries(manifestItems)) {
      if (/\.(xhtml|html|htm|xml)$/i.test(href)) {
        const normHref = normalizeEpubFilePath(href);
        if (!allXhtmlFiles[normHref]) {
          const fileObj = loadedZip.file(opfDir + href);
          if (fileObj) {
            allXhtmlFiles[normHref] = await fileObj.async('string');
          }
        }
      }
    }

    // Run FootnoteResolver global pre-scan and cross-file link internalization
    const footnoteResolution = this.footnoteResolver.resolveAll(allXhtmlFiles, spineHrefs);

    // Build chapters from spine
    for (const ref of spineRefs) {
      // Yield to the browser event loop so UI never freezes on large books
      await new Promise((resolve) => setTimeout(resolve, 0));

      const id = ref.getAttribute('idref');
      if (!id || !manifestItems[id]) continue;

      const href = manifestItems[id];
      const normHref = normalizeEpubFilePath(href);
      const htmlContent = allXhtmlFiles[normHref];
      if (!htmlContent) continue;

      const chapterRes = footnoteResolution.chapters[normHref];
      const effectiveHtml = chapterRes ? chapterRes.html : htmlContent;
      const doc = parseHtmlDocument(effectiveHtml);

      let title = '';
      let isTocPoint = false;

      // 1. Try TOC Map first
      if (tocMap[href] || tocMap[normHref]) {
        title = tocMap[href] || tocMap[normHref];
        isTocPoint = true;
      }

      // 2. If not in TOC, check headings, aria-label, or <title> in content
      if (!title) {
        const headings = doc.querySelectorAll('h1, h2, h3');
        const isGarbageTitle = (raw: string) => {
          if (!raw) return true;
          const systemPattern =
            /^(part|page|item|file|xhtml|html|untitled|chapter|section|p|id|img|image|text|body|nav)\s?_?\d*$/i;
          const isSlugOrCode =
            /^[a-z0-9]+[_-][a-z0-9_-]*$/i.test(raw) || /^[a-z]+\d+$/i.test(raw);
          const isFileFormat =
            raw.toLowerCase().includes('.xhtml') || raw.toLowerCase().includes('.html');
          const isJustNumbers = /^\d+$/.test(raw);
          return (systemPattern.test(raw) || isSlugOrCode || isFileFormat || isJustNumbers) && raw.length < 20;
        };

        if (headings.length > 0) {
          const headTitle = headings[0].textContent?.trim() || '';
          if (!isGarbageTitle(headTitle)) {
            title = headTitle;
          }
        }

        if (!title) {
          const pseudoHeading = doc
            .querySelector(
              '.top, .top-int, .part-title, .fm-title, .bm-title1a, .bm-title, .sec1-titlea, .book-title, .halftitle, .half-title, .chap-title, .h1, .h2'
            )
            ?.textContent?.replace(/\s+/g, ' ')
            .trim();
          if (pseudoHeading && !isGarbageTitle(pseudoHeading)) {
            title = pseudoHeading;
          }
        }

        if (!title && cssProfiles.size > 0 && doc.body) {
          const candidateNodes = this.domMutationEngine
            .collectTranslatableLeafElements(doc.body)
            .slice(0, 15);
          const headingAnalysis = resolveLeafHeadingAnalysis(candidateNodes, cssProfiles);
          for (const cand of candidateNodes) {
            if ((headingAnalysis.headingLevels.get(cand) || 0) > 0) {
              const candTitle = cand.textContent?.replace(/\s+/g, ' ').trim() || '';
              if (candTitle && !isGarbageTitle(candTitle)) {
                title = candTitle;
                break;
              }
            }
          }
        }

        if (!title) {
          const ariaLabel = doc
            .querySelector('section[aria-label], aside[aria-label], nav[aria-label]')
            ?.getAttribute('aria-label')
            ?.trim();
          if (ariaLabel && !isGarbageTitle(ariaLabel)) {
            title = ariaLabel;
          }
        }

        if (!title) {
          const docTitle = doc.querySelector('title')?.textContent?.trim() || '';
          if (docTitle && !isGarbageTitle(docTitle)) {
            title = docTitle;
          }
        }
      }

      // 3. Fallback: try first paragraph snippet or assign Section N
      if (!title) {
        const firstP = doc.querySelector('p')?.textContent?.trim().replace(/\s+/g, ' ') || '';
        if (firstP && firstP.length >= 3 && firstP.length <= 40) {
          title = firstP;
        } else {
          title = rawChapters.length === 0 ? 'Front Matter' : `Section ${rawChapters.length + 1}`;
        }
      }

      const internalizedNotes = chapterRes ? chapterRes.internalizedFootnotes : {};
      const domExtraction = this.domMutationEngine.extractTranslatablePayload(
        effectiveHtml,
        internalizedNotes,
        cssProfiles
      );
      const markdown = domExtraction.payloadText || '';
      const isFootnoteSource = footnoteResolution.footnoteSourceFiles.has(normHref);

      rawChapters.push({
        id,
        index: rawChapters.length,
        fileName: href,
        title,
        content: effectiveHtml,
        markdown,
        slottedMarkdown: markdown,
        isTocPoint,
        isFootnoteSource,
        isSystemProtected: isFootnoteSource,
        internalizedFootnotes: internalizedNotes
      });
    }

    // Run Stage 1 of Two-Stage Page Classifier (Zero-latency local rules)
    const chapters = this.pageClassifier.classifyChaptersLocal(
      rawChapters,
      footnoteResolution.footnoteSourceFiles
    );

    const detected = detectBookLanguage(chapters, opfLanguage);

    return {
      chapters,
      images,
      coverPath,
      opfPath,
      opfDir,
      cssFiles,
      cssContents: rawCssTexts,
      detectedLanguage: detected.language,
      detectedLanguageSource: detected.source
    };
  }

  /**
   * Renders a bilingual chapter with paragraph-level alignment between source and target markdown.
   */
  public async renderBilingualChapterEpub3Html(
    markdownContent: string,
    internalizedFootnotes: Record<string, FootnoteNode> = {},
    translatedFootnotes: Record<string, string> = {},
    sourceMarkdownWithSlots?: string,
    bilingualMode: BilingualMode = 'source_first',
    wereadMode: boolean = false,
    imagesRelPath: string = 'Images/'
  ): Promise<string> {
    let targetContent = markdownContent || '';
    let sourceContent = sourceMarkdownWithSlots || '';

    // Extract inline footnote definitions from targetContent
    const inlineTranslatedNotes: Record<string, string> = { ...translatedFootnotes };
    targetContent = targetContent.replace(
      /(?:\[|【)\s*FN_DEF[:：]\s*([^\]】]+?)\s*(?:\]|】)([\s\S]*?)(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|(?=(?:\[|【)\s*FN_DEF[:：])|$)/gi,
      (_, rawId, text) => {
        const cleanId = String(rawId).trim().replace(/^fn-/, '');
        inlineTranslatedNotes[cleanId] = String(text).trim();
        return '';
      }
    );
    targetContent = targetContent
      .replace(/(?:\[|【)\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)|$)/gi, '')
      .replace(/(?:\[|【)\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)|$)/gi, '')
      .replace(/(?:\[|【)\s*[\/／]?\s*MAIN_CONTENT\s*(?:\]|】)/gi, '');

    targetContent = targetContent.replace(
      /(?:^|\n)(?:\[|【|〔)\s*\^\s*(?:fn-)?([^\]】〕]+?)\s*(?:\]|】|〕)[:：][ \t]*([\s\S]*?)(?=(?:\n(?:\[|【|〔)\s*\^\s*(?:fn-)?)|(?:\n\n(?!\s{2,}))|$)/g,
      (_, rawId, defText) => {
        const cleanId = String(rawId).trim().replace(/^fn-/, '');
        if (!inlineTranslatedNotes[cleanId]) {
          inlineTranslatedNotes[cleanId] = String(defText).trim();
        }
        return '';
      }
    );
    const knownBilingualIds = Object.keys(internalizedFootnotes);
    if (knownBilingualIds.length > 0 && targetContent) {
      const stripped = stripLeakedFootnoteDefinitions(targetContent, knownBilingualIds);
      if (stripped.cleanedText !== targetContent) {
        targetContent = stripped.cleanedText;
        for (const [fnId, fnText] of Object.entries(stripped.extractedDefs)) {
          if (!inlineTranslatedNotes[fnId] && fnText) {
            inlineTranslatedNotes[fnId] = fnText;
          }
        }
      }
    }

    // Clean sourceContent tags as well
    sourceContent = sourceContent
      .replace(/(?:\[|【)\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)|$)/gi, '')
      .replace(/(?:\[|【)\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)|$)/gi, '')
      .replace(/(?:\[|【)\s*[\/／]?\s*MAIN_CONTENT\s*(?:\]|】)/gi, '');

    // Validate and repair slots if source is available, and restore missing `#` heading prefixes
    if (sourceContent) {
      const repaired = validateAndRepairSlots(sourceContent, targetContent);
      targetContent = repaired.repairedText;
      targetContent = restoreHeadingPrefixesFromSource(sourceContent, targetContent);
    }

    // Protect __FN_REF_{id}__ tokens in both target and source
    targetContent = targetContent.replace(
      /__FN_REF_([A-Za-z0-9_-]+?)__/g,
      (_, id) => `{{TRANSLITFNSLOT:${id}}}`
    );
    sourceContent = sourceContent.replace(
      /__FN_REF_([A-Za-z0-9_-]+?)__/g,
      (_, id) => `{{TRANSLITFNSLOT:${id}}}`
    );

    // If source and target are identical or source is empty, fall back to standard rendering
    if (!sourceContent.trim() || sourceContent.trim() === targetContent.trim()) {
      return this.renderChapterEpub3Html(
        targetContent,
        internalizedFootnotes,
        inlineTranslatedNotes,
        undefined,
        'none',
        wereadMode,
        imagesRelPath
      );
    }

    const sourceBlocks = splitMarkdownIntoBlocks(sourceContent);
    const targetBlocks = splitMarkdownIntoBlocks(targetContent);
    const pairs = alignMarkdownBlocks(sourceBlocks, targetBlocks);

    const htmlParts: string[] = [];

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

    const replaceSourceSlot = (htmlText: string) => {
      const replacer = (_match: string, rawId: string) => {
        const id = String(rawId).trim().replace(/^fn-/, '');
        if (!hasBackingFootnote(id)) {
          return '';
        }
        const displayNum = getDisplayNum(id);

        const prevCount = idCitationCount.get(`src-${id}`) || 0;
        idCitationCount.set(`src-${id}`, prevCount + 1);
        const refIdAttr = prevCount === 0 ? `fnref-src-${id}` : `fnref-src-${id}-${prevCount + 1}`;

        if (wereadMode) {
          // Source block uses original English footnote text
          const rawNoteText =
            internalizedFootnotes[id]?.plainText ||
            internalizedFootnotes[`fn-${id}`]?.plainText ||
            inlineTranslatedNotes[id] ||
            '';
          const cleanAlt = escapeXml(rawNoteText.replace(/\s+/g, ' ').trim());
          return `<a id="${refIdAttr}" href="#fn-src-${id}" epub:type="noteref" class="noteref duokan-footnote footnote" data-num="${displayNum}"><img class="qqreader-footnote" src="${imagesRelPath}note.png" alt="${cleanAlt}"/></a>`;
        }

        return `<a id="${refIdAttr}" href="#fn-src-${id}" epub:type="noteref" class="noteref duokan-footnote footnote" data-num="${displayNum}"><sup>[${displayNum}]</sup></a>`;
      };

      return htmlText
        .replace(/\{\{TRANSLITFNSLOT:([A-Za-z0-9_-]+)\}\}/g, replacer)
        .replace(/\[\^(?:fn-)?([A-Za-z0-9_-]+)\]/g, replacer);
    };

    const replaceTargetSlot = (htmlText: string) => {
      const replacer = (_match: string, rawId: string) => {
        const id = String(rawId).trim().replace(/^fn-/, '');
        if (!hasBackingFootnote(id)) {
          return '';
        }
        const displayNum = getDisplayNum(id);

        const prevCount = idCitationCount.get(`tgt-${id}`) || 0;
        idCitationCount.set(`tgt-${id}`, prevCount + 1);
        const refIdAttr = prevCount === 0 ? `fnref-${id}` : `fnref-${id}-${prevCount + 1}`;

        if (wereadMode) {
          // Target block uses translated Chinese footnote text
          const rawNoteText =
            inlineTranslatedNotes[id] ||
            inlineTranslatedNotes[`fn-${id}`] ||
            internalizedFootnotes[id]?.plainText ||
            internalizedFootnotes[`fn-${id}`]?.plainText ||
            '';
          const cleanAlt = escapeXml(rawNoteText.replace(/\s+/g, ' ').trim());
          return `<a id="${refIdAttr}" href="#fn-${id}" epub:type="noteref" class="noteref duokan-footnote footnote" data-num="${displayNum}"><img class="qqreader-footnote" src="${imagesRelPath}note.png" alt="${cleanAlt}"/></a>`;
        }

        return `<a id="${refIdAttr}" href="#fn-${id}" epub:type="noteref" class="noteref duokan-footnote footnote" data-num="${displayNum}"><sup>[${displayNum}]</sup></a>`;
      };

      return htmlText
        .replace(/\{\{TRANSLITFNSLOT:([A-Za-z0-9_-]+)\}\}/g, replacer)
        .replace(/\[\^(?:fn-)?([A-Za-z0-9_-]+)\]/g, replacer);
    };

    for (const pair of pairs) {
      if (pair.type === 'hr') {
        htmlParts.push('<hr/>');
        continue;
      }

      if (pair.type === 'image') {
        const imgMd = pair.sourceContent || pair.targetContent || '';
        let imgHtml = await marked(imgMd, { breaks: true, gfm: true });
        imgHtml = imgHtml.trim()
          .replace(/<img([^>]*)>/g, (m, attrs) => attrs.trim().endsWith('/') ? m : `<img${attrs}/>`);
        htmlParts.push(`<div class="bilingual-image">\n  ${imgHtml}\n</div>`);
        continue;
      }

      const hasSource = Boolean(pair.sourceContent && pair.sourceContent.trim());
      const hasTarget = Boolean(pair.targetContent && pair.targetContent.trim());

      let sourceHtml = '';
      if (hasSource) {
        sourceHtml = await marked(pair.sourceContent!, { breaks: true, gfm: true });
        sourceHtml = sourceHtml.trim()
          .replace(/<br>/g, '<br/>')
          .replace(/<hr>/g, '<hr/>')
          .replace(/<img([^>]*)>/g, (m, attrs) => attrs.trim().endsWith('/') ? m : `<img${attrs}/>`);
        sourceHtml = replaceSourceSlot(sourceHtml);
      }

      let targetHtml = '';
      if (hasTarget) {
        const targetMdForRender =
          pair.type !== 'code' ? applyHetiTextTypography(pair.targetContent!) : pair.targetContent!;
        targetHtml = await marked(targetMdForRender, { breaks: true, gfm: true });
        targetHtml = targetHtml.trim()
          .replace(/<br>/g, '<br/>')
          .replace(/<hr>/g, '<hr/>')
          .replace(/<img([^>]*)>/g, (m, attrs) => attrs.trim().endsWith('/') ? m : `<img${attrs}/>`);
        targetHtml = replaceTargetSlot(targetHtml);
      }

      if (pair.type === 'heading') {
        const headingDivClass = 'bilingual-heading bilingual-pair';
        if (hasSource && hasTarget) {
          const firstHtml = bilingualMode === 'source_first' ? sourceHtml : targetHtml;
          const secondHtml = bilingualMode === 'source_first' ? targetHtml : sourceHtml;
          const firstClass = bilingualMode === 'source_first' ? 'bilingual-source' : 'bilingual-target';
          const secondClass = bilingualMode === 'source_first' ? 'bilingual-target' : 'bilingual-source';
          htmlParts.push(
            `<div class="${headingDivClass}">\n  <div class="${firstClass}">${firstHtml}</div>\n  <div class="${secondClass}">${secondHtml}</div>\n</div>`
          );
        } else {
          const onlyHtml = hasSource ? sourceHtml : targetHtml;
          const onlyClass = hasSource ? 'bilingual-source' : 'bilingual-target';
          htmlParts.push(
            `<div class="${headingDivClass}">\n  <div class="${onlyClass}">${onlyHtml}</div>\n</div>`
          );
        }
        continue;
      }

      // Normal paragraph / blockquote / list / table / code pair
      if (hasSource && hasTarget) {
        const firstHtml = bilingualMode === 'source_first' ? sourceHtml : targetHtml;
        const secondHtml = bilingualMode === 'source_first' ? targetHtml : sourceHtml;
        const firstClass = bilingualMode === 'source_first' ? 'bilingual-source' : 'bilingual-target';
        const secondClass = bilingualMode === 'source_first' ? 'bilingual-target' : 'bilingual-source';
        htmlParts.push(
          `<div class="bilingual-pair">\n  <div class="${firstClass}">\n    ${firstHtml}\n  </div>\n  <div class="${secondClass}">\n    ${secondHtml}\n  </div>\n</div>`
        );
      } else if (hasSource) {
        htmlParts.push(
          `<div class="bilingual-pair">\n  <div class="bilingual-source">\n    ${sourceHtml}\n  </div>\n</div>`
        );
      } else if (hasTarget) {
        htmlParts.push(
          `<div class="bilingual-pair">\n  <div class="bilingual-target">\n    ${targetHtml}\n  </div>\n</div>`
        );
      }
    }

    let htmlBody = htmlParts.join('\n\n');

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

        // Source (original) footnote aside
        const rawSourceText =
          internalizedFootnotes[id]?.plainText ||
          internalizedFootnotes[`fn-${id}`]?.plainText ||
          inlineTranslatedNotes[id] ||
          '';
        asideBlocks.push(buildFootnoteAsideHtml(id, displayNum, rawSourceText, true));
      }

      htmlBody = `${htmlBody.trim()}\n\n${asideBlocks.join('\n\n')}`;
    }

    return htmlBody;
  }

  /**
   * Renders translated Markdown (containing __FN_REF_{id}__ slots) and translated footnotes
   * into standard EPUB 3 HTML with `<a epub:type="noteref">` and `<aside epub:type="footnote">`.
   */
  public async renderChapterEpub3Html(
    markdownContent: string,
    internalizedFootnotes: Record<string, FootnoteNode> = {},
    translatedFootnotes: Record<string, string> = {},
    sourceMarkdownWithSlots?: string,
    bilingualMode: BilingualMode = 'none',
    wereadMode: boolean = false,
    imagesRelPath: string = 'Images/'
  ): Promise<string> {
    if (bilingualMode === 'source_first' || bilingualMode === 'target_first') {
      return this.renderBilingualChapterEpub3Html(
        markdownContent,
        internalizedFootnotes,
        translatedFootnotes,
        sourceMarkdownWithSlots,
        bilingualMode,
        wereadMode,
        imagesRelPath
      );
    }

    let contentToUse = markdownContent || '';

    // Extract any inline [FN_DEF:id]...[/FN_DEF] or [^id]: ... if present in markdownContent
    const inlineTranslatedNotes: Record<string, string> = { ...translatedFootnotes };
    contentToUse = contentToUse.replace(
      /(?:\[|【)\s*FN_DEF[:：]\s*([^\]】]+?)\s*(?:\]|】)([\s\S]*?)(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|(?=(?:\[|【)\s*FN_DEF[:：])|$)/gi,
      (_, rawId, text) => {
        const cleanId = String(rawId).trim().replace(/^fn-/, '');
        inlineTranslatedNotes[cleanId] = String(text).trim();
        return '';
      }
    );
    contentToUse = contentToUse
      .replace(/(?:\[|【)\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)|$)/gi, '')
      .replace(/(?:\[|【)\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)|$)/gi, '')
      .replace(/(?:\[|【)\s*[\/／]?\s*MAIN_CONTENT\s*(?:\]|】)/gi, '');

    // Also capture any markdown footnote definition lines [^id]: ... or 【^id】： ... (multiline supported)
    contentToUse = contentToUse.replace(
      /(?:^|\n)(?:\[|【|〔)\s*\^\s*(?:fn-)?([^\]】〕]+?)\s*(?:\]|】|〕)[:：][ \t]*([\s\S]*?)(?=(?:\n(?:\[|【|〔)\s*\^\s*(?:fn-)?)|(?:\n\n(?!\s{2,}))|$)/g,
      (_, rawId, defText) => {
        const cleanId = String(rawId).trim().replace(/^fn-/, '');
        if (!inlineTranslatedNotes[cleanId]) {
          inlineTranslatedNotes[cleanId] = String(defText).trim();
        }
        return '';
      }
    );
    const knownMonoIds = Object.keys(internalizedFootnotes);
    if (knownMonoIds.length > 0 && contentToUse) {
      const stripped = stripLeakedFootnoteDefinitions(contentToUse, knownMonoIds);
      if (stripped.cleanedText !== contentToUse) {
        contentToUse = stripped.cleanedText;
        for (const [fnId, fnText] of Object.entries(stripped.extractedDefs)) {
          if (!inlineTranslatedNotes[fnId] && fnText) {
            inlineTranslatedNotes[fnId] = fnText;
          }
        }
      }
    }

    // Validate and repair slots if sourceMarkdownWithSlots is available, and restore headings / Heti typography
    if (sourceMarkdownWithSlots) {
      const repaired = validateAndRepairSlots(sourceMarkdownWithSlots, contentToUse);
      contentToUse = repaired.repairedText;
      contentToUse = restoreHeadingPrefixesFromSource(sourceMarkdownWithSlots, contentToUse);
    }
    contentToUse = applyHetiTextTypography(contentToUse);

    // Protect __FN_REF_{id}__ tokens from Marked's __bold__ / _italic_ parser by temporarily
    // replacing them with underscore-free placeholder tokens before running marked()
    contentToUse = contentToUse.replace(
      /__FN_REF_([A-Za-z0-9_-]+?)__/g,
      (_, id) => `{{TRANSLITFNSLOT:${id}}}`
    );

    // Structure-aware line joining
    const isTableRow = (line: string) => /^\|/.test(line);
    const isListItem = (line: string) => /^[-*+]\s|^\d+[.)]\s/.test(line);
    const trimmedLines = contentToUse
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const mdParts: string[] = [];
    for (let i = 0; i < trimmedLines.length; i++) {
      mdParts.push(trimmedLines[i]);
      if (i < trimmedLines.length - 1) {
        const curr = trimmedLines[i];
        const next = trimmedLines[i + 1];
        if (
          (isTableRow(curr) && isTableRow(next)) ||
          (isListItem(curr) && isListItem(next))
        ) {
          mdParts.push('\n');
        } else {
          mdParts.push('\n\n');
        }
      }
    }
    const processedMarkdown = mdParts.join('');

    let htmlBody = await marked(processedMarkdown, {
      breaks: true,
      gfm: true
    });

    htmlBody = htmlBody
      .replace(/<br>/g, '<br/>')
      .replace(/<hr>/g, '<hr/>')
      .replace(/<img([^>]*)>/g, (match, attrs) =>
        attrs.trim().endsWith('/') ? match : `<img${attrs}/>`
      );

    // Replace @@TRANSLIT_FN_SLOT_{id}@@ (and any legacy [^id]) with EPUB 3 noteref anchors
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

    const replaceSlotWithNoteref = (_match: string, rawId: string) => {
      const id = String(rawId).trim().replace(/^fn-/, '');
      if (!hasBackingFootnote(id)) {
        return '';
      }
      let displayNum = idToDisplayNumber.get(id);
      if (!displayNum) {
        displayNum = orderedIds.length + 1;
        idToDisplayNumber.set(id, displayNum);
        orderedIds.push(id);
      }

      const prevCount = idCitationCount.get(id) || 0;
      idCitationCount.set(id, prevCount + 1);
      const refIdAttr = prevCount === 0 ? `fnref-${id}` : `fnref-${id}-${prevCount + 1}`;

      if (wereadMode) {
        const rawNoteText =
          inlineTranslatedNotes[id] ||
          inlineTranslatedNotes[`fn-${id}`] ||
          internalizedFootnotes[id]?.plainText ||
          internalizedFootnotes[`fn-${id}`]?.plainText ||
          '';
        const cleanAlt = escapeXml(rawNoteText.replace(/\s+/g, ' ').trim());
        return `<a id="${refIdAttr}" href="#fn-${id}" epub:type="noteref" class="noteref duokan-footnote footnote" data-num="${displayNum}"><img class="qqreader-footnote" src="${imagesRelPath}note.png" alt="${cleanAlt}"/></a>`;
      }

      return `<a id="${refIdAttr}" href="#fn-${id}" epub:type="noteref" class="noteref duokan-footnote footnote" data-num="${displayNum}"><sup>[${displayNum}]</sup></a>`;
    };

    htmlBody = htmlBody.replace(
      /\{\{TRANSLITFNSLOT:([A-Za-z0-9_-]+)\}\}/g,
      replaceSlotWithNoteref
    );
    htmlBody = htmlBody.replace(
      /\[\^(?:fn-)?([A-Za-z0-9_-]+)\]/g,
      replaceSlotWithNoteref
    );

    // Append standard EPUB 3 <aside epub:type="footnote" class="footnote-popup"> nodes
    if (orderedIds.length > 0) {
      const asideBlocks: string[] = [];
      for (const id of orderedIds) {
        const displayNum = idToDisplayNumber.get(id)!;
        const rawNoteText =
          inlineTranslatedNotes[id] ||
          inlineTranslatedNotes[`fn-${id}`] ||
          internalizedFootnotes[id]?.plainText ||
          internalizedFootnotes[`fn-${id}`]?.plainText ||
          '';
        asideBlocks.push(buildFootnoteAsideHtml(id, displayNum, rawNoteText, false));
      }

      htmlBody = `${htmlBody.trim()}\n\n${asideBlocks.join('\n\n')}`;
    }

    return htmlBody;
  }

  /**
   * Ensures an XHTML string declares `xmlns:epub="http://www.idpf.org/2007/ops"` on `<html>`.
   */
  public ensureEpub3XhtmlNamespace(xhtml: string): string {
    if (/xmlns:epub=["']http:\/\/www\.idpf\.org\/2007\/ops["']/i.test(xhtml)) {
      return xhtml;
    }
    if (/<html\b[^>]*>/i.test(xhtml)) {
      return xhtml.replace(/<html\b([^>]*)>/i, (_m, attrs) => {
        return `<html${attrs} xmlns:epub="http://www.idpf.org/2007/ops">`;
      });
    }
    return `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n<body>\n${xhtml}\n</body>\n</html>`;
  }

  async generateEpub(
    chapters: Chapter[],
    originalZip: JSZip,
    opfPath: string,
    opfDir: string,
    cssFiles: string[],
    title: string,
    targetLanguage: string = 'English',
    cssOverrides?: string,
    excludeFileNames?: string[],
    bilingualMode: BilingualMode = 'none',
    wereadMode: boolean = false,
    bookStyleRoles?: BookStyleRoleMap
  ): Promise<Blob> {
    const zip = originalZip;
    const isChinese = targetLanguage.toLowerCase().includes('chinese');

    const ensureOpfEpub3Metadata = (opfXml: string): string => {
      let updated = opfXml.replace(
        /(<package\b[^>]*\bversion=["'])2\.0(["'][^>]*>)/i,
        '$13.0$2'
      );
      if (!updated.includes('xmlns:epub=')) {
        updated = updated.replace(
          /<package\b([^>]*)>/i,
          '<package$1 xmlns:epub="http://www.idpf.org/2007/ops">'
        );
      }
      if (!updated.includes('dcterms:modified')) {
        const nowUtc = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        updated = updated.replace(
          /<\/metadata>/i,
          `    <meta property="dcterms:modified">${nowUtc}</meta>\n  </metadata>`
        );
      }
      if (wereadMode && !updated.includes('Images/note.png')) {
        updated = updated.replace(
          /<\/manifest>/i,
          '    <item id="qqreader_note_png" href="Images/note.png" media-type="image/png"/>\n  </manifest>'
        );
      }
      return updated;
    };

    // Add WeChat Reading note icon to ZIP if wereadMode is enabled
    if (wereadMode) {
      const noteFullPath = opfDir + 'Images/note.png';
      const binaryString = atob(NOTE_ICON_BASE64);
      const notePngBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        notePngBytes[i] = binaryString.charCodeAt(i);
      }
      zip.file(noteFullPath, notePngBytes);
    }

    // Collect standalone footnote source files so they are NEVER deleted (0-Offset guarantee)
    const footnoteSourceFileSet = new Set<string>();
    for (const ch of chapters) {
      if (
        ch.isFootnoteSource ||
        ch.classification?.disposition === 'system_footnote_source'
      ) {
        footnoteSourceFileSet.add(ch.fileName);
        footnoteSourceFileSet.add(normalizeEpubFilePath(ch.fileName));
      }
    }

    // 1. Update title, language, and upgrade OPF version to EPUB 3.0
    const opfFile = zip.file(opfPath);
    if (opfFile) {
      let opfContent = ensureOpfEpub3Metadata(await opfFile.async('string'));

      const titlePattern = /<dc:title\b([^>]*)>[\s\S]*?<\/dc:title>/i;
      const cleanTitle = title.replace(/【TransLit.*?】$/, '').trim();
      const safeTitle = escapeXml(cleanTitle);
      let titleSuffix = '【TransLit】';
      if (wereadMode) {
        if (bilingualMode === 'source_first') {
          titleSuffix = '【TransLit-双语-原文在前-微信专版】';
        } else if (bilingualMode === 'target_first') {
          titleSuffix = '【TransLit-双语-译文在前-微信专版】';
        } else {
          titleSuffix = '【TransLit-微信专版】';
        }
      } else {
        if (bilingualMode === 'source_first') {
          titleSuffix = '【TransLit-双语-原文在前】';
        } else if (bilingualMode === 'target_first') {
          titleSuffix = '【TransLit-双语-译文在前】';
        } else {
          titleSuffix = '【TransLit】';
        }
      }
      const fullBookTitle = `${safeTitle}${titleSuffix}`;
      if (titlePattern.test(opfContent)) {
        opfContent = opfContent.replace(
          titlePattern,
          `<dc:title$1>${fullBookTitle}</dc:title>`
        );
      }

      const langPattern = /<dc:language\b([^>]*)>[\s\S]*?<\/dc:language>/i;
      if (langPattern.test(opfContent)) {
        opfContent = opfContent.replace(
          langPattern,
          `<dc:language$1>${isChinese ? 'zh' : 'en'}</dc:language>`
        );
      }

      zip.file(opfPath, opfContent);
    }

    // 1b. Remove excluded chapters (ONLY user-skipped pages, NEVER standalone footnote source files)
    const safeExcludeFileNames = (excludeFileNames || []).filter(
      (fn) =>
        !footnoteSourceFileSet.has(fn) &&
        !footnoteSourceFileSet.has(normalizeEpubFilePath(fn))
    );

    if (safeExcludeFileNames.length > 0) {
      const currentOpfFile = zip.file(opfPath);
      if (currentOpfFile) {
        const opfContent = await currentOpfFile.async('string');
        const opfDoc = parseXmlDocument(opfContent);
        const normalizeExcludePath = (raw: string): string => {
          let decoded = raw.split('#')[0];
          try {
            decoded = decodeURIComponent(decoded);
          } catch {
            // ignore
          }
          return normalizeEpubFilePath(decoded);
        };
        const excludeSet = new Set(safeExcludeFileNames.map(normalizeExcludePath));

        const idsToRemove = new Set<string>();
        let ncxHref: string | null = null;
        let navHref: string | null = null;

        for (const item of Array.from(opfDoc.querySelectorAll('*'))) {
          if (item.localName === 'item') {
            const href = item.getAttribute('href');
            const id = item.getAttribute('id');
            const properties = item.getAttribute('properties');

            if (href && id && excludeSet.has(normalizeExcludePath(href))) {
              idsToRemove.add(id);
              item.remove();
              const candidates = new Set([
                opfDir + href,
                opfDir + normalizeExcludePath(href)
              ]);
              for (const fullPath of candidates) {
                if (zip.file(fullPath)) {
                  zip.remove(fullPath);
                }
              }
            }

            if (properties && properties.split(/\s+/).includes('nav')) {
              navHref = href;
            }
          }
        }

        let tocId: string | null = null;
        for (const ref of Array.from(opfDoc.querySelectorAll('*'))) {
          if (ref.localName === 'spine') {
            tocId = ref.getAttribute('toc');
          } else if (ref.localName === 'itemref') {
            const idref = ref.getAttribute('idref');
            if (idref && idsToRemove.has(idref)) {
              ref.remove();
            }
          }
        }

        if (tocId) {
          for (const item of Array.from(opfDoc.querySelectorAll('*'))) {
            if (item.localName === 'item' && item.getAttribute('id') === tocId) {
              ncxHref = item.getAttribute('href');
              break;
            }
          }
        }

        const isExcluded = (link: string | null, baseDocHref: string | null) => {
          if (!link) return false;
          const resolvedLink = baseDocHref
            ? normalizeEpubFilePath(resolveRelativeEpubHref(baseDocHref, link).filePath)
            : normalizeExcludePath(link);
          const baseLink = normalizeExcludePath(link);
          for (const ex of excludeSet) {
            if (ex === resolvedLink) return true;
            if (!baseDocHref && (ex === baseLink || ex.endsWith('/' + baseLink) || baseLink.endsWith('/' + ex))) {
              return true;
            }
          }
          return false;
        };

        const serializedOpf = ensureOpfEpub3Metadata(serializeXmlNode(opfDoc));
        zip.file(opfPath, serializedOpf);

        // Clean up EPUB2 NCX
        if (ncxHref) {
          const ncxPath = opfDir + ncxHref;
          const ncxFile = zip.file(ncxPath);
          if (ncxFile) {
            const ncxContent = await ncxFile.async('string');
            const ncxDoc = parseXmlDocument(ncxContent);
            for (const el of Array.from(ncxDoc.querySelectorAll('*')).reverse()) {
              if (el.localName === 'navPoint') {
                let contentNode: Element | null = null;
                for (const child of Array.from(el.children)) {
                  if (child.localName === 'content') {
                    contentNode = child;
                    break;
                  }
                }
                if (contentNode && isExcluded(contentNode.getAttribute('src'), ncxHref)) {
                  const childNavPoints = Array.from(el.children).filter(
                    (c) => c.localName === 'navPoint'
                  );
                  for (const child of childNavPoints) {
                    if (el.parentElement) el.parentElement.insertBefore(child, el);
                  }
                  el.remove();
                }
              }
            }
            zip.file(ncxPath, serializeXmlNode(ncxDoc));
          }
        }

        // Clean up EPUB3 NAV
        if (navHref) {
          const navPath = opfDir + navHref;
          const navFile = zip.file(navPath);
          if (navFile) {
            const navContent = await navFile.async('string');
            const navDoc = parseXmlDocument(navContent);
            for (const el of Array.from(navDoc.querySelectorAll('*')).reverse()) {
              if (el.localName === 'a') {
                if (isExcluded(el.getAttribute('href'), navHref)) {
                  let li: Element | null = el;
                  while (li && li.localName !== 'li') {
                    li = li.parentElement;
                  }
                  if (li) {
                    const childOls = Array.from(li.children).filter(
                      (c) => c.localName === 'ol'
                    );
                    for (const ol of childOls) {
                      const childLis = Array.from(ol.children).filter(
                        (c) => c.localName === 'li'
                      );
                      for (const childLi of childLis) {
                        if (li.parentElement) li.parentElement.insertBefore(childLi, li);
                      }
                    }
                    li.remove();
                  }
                }
              }
            }
            zip.file(navPath, serializeXmlNode(navDoc));
          }
        }
      }
    }

    // 2. Collect original CSS files, profile book classes, and mount adaptive Heti + TransLit styles
    const cssEntries: Array<{ path: string; origCss: string }> = [];
    if (cssFiles && cssFiles.length > 0) {
      for (const cssPath of cssFiles) {
        const origFile = zip.file(cssPath);
        const origCss = origFile ? await origFile.async('string') : '';
        cssEntries.push({ path: cssPath, origCss });
      }
    } else {
      const commonCssPaths = [
        'css/styles.css',
        'OEBPS/css/styles.css',
        'stylesheet.css',
        'styles.css'
      ];
      for (const path of commonCssPaths) {
        const targetPath = zip.file(path) ? path : opfDir + path;
        if (zip.file(targetPath)) {
          const origFile = zip.file(targetPath);
          const origCss = origFile ? await origFile.async('string') : '';
          cssEntries.push({ path: targetPath, origCss });
        }
      }
    }

    const originalCssTexts = cssEntries.map((e) => e.origCss).filter((t) => t.trim().length > 0);
    if (originalCssTexts.length === 0) {
      for (const ch of chapters) {
        if (!ch.content) continue;
        const styleMatches = ch.content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi);
        for (const m of styleMatches) {
          if (m[1]?.trim()) originalCssTexts.push(m[1]);
        }
      }
    }

    const cssProfiles = parseEpubCssProfiles(originalCssTexts);
    const adaptiveEnhancementCss = isChinese
      ? buildAdaptiveChineseTypographyCss(
          originalCssTexts.length > 0 ? originalCssTexts : undefined,
          bookStyleRoles
        )
      : '';

    const enhanceOriginalCss = (origCss: string): string => {
      // For Chinese output: replace publisher CSS with Pure Heti Semantic Preset CSS
      // (after cssProfiles has already extracted semantic roles) so Calibre/publisher quirks never leak.
      let finalCss = cssOverrides ? cssOverrides : (isChinese ? adaptiveEnhancementCss : origCss);
      if (!finalCss.includes('.footnote-popup')) {
        finalCss += `\n\n/* TransLit Footnote Popup Styles */\n${EPUB3_POPUP_FOOTNOTE_CSS}`;
      }
      if (bilingualMode === 'source_first' || bilingualMode === 'target_first') {
        if (!finalCss.includes('.bilingual-pair')) {
          finalCss += `\n\n/* TransLit Bilingual Alignment Styles */\n${BILINGUAL_EPUB_CSS}`;
        }
      }
      return finalCss;
    };

    let hasGeneratedCss = false;
    if (cssEntries.length > 0) {
      for (const entry of cssEntries) {
        zip.file(entry.path, enhanceOriginalCss(entry.origCss));
      }
    } else {
      const generatedCss = enhanceOriginalCss('');
      if (generatedCss.trim()) {
        zip.file(opfDir + 'translit.css', generatedCss);
        const curOpfFile = zip.file(opfPath);
        if (curOpfFile) {
          const curOpfXml = await curOpfFile.async('string');
          if (!/href=["']translit\.css["']/i.test(curOpfXml)) {
            zip.file(
              opfPath,
              curOpfXml.replace(
                /<\/manifest>/i,
                '    <item id="translit_generated_css" href="translit.css" media-type="text/css"/>\n  </manifest>'
              )
            );
          }
        }
        hasGeneratedCss = true;
      }
    }

    const attachGeneratedCssLink = (xhtml: string, relHref: string): string => {
      if (!hasGeneratedCss || xhtml.includes('translit.css')) return xhtml;
      const linkTag = `<link rel="stylesheet" type="text/css" href="${relHref}"/>`;
      if (/<\/head>/i.test(xhtml)) {
        return xhtml.replace(/<\/head>/i, `  ${linkTag}\n</head>`);
      }
      if (/<body\b[^>]*>/i.test(xhtml)) {
        return xhtml.replace(/<body\b[^>]*>/i, (m) => `<head>\n  ${linkTag}\n</head>\n${m}`);
      }
      return xhtml;
    };

    // 3. Mutate DOM of each XHTML chapter in-place (or write 0-Offset placeholder for drained footnote source files)
    for (const ch of chapters) {
      const fullPath = opfDir + ch.fileName;
      const originalXhtmlFile = zip.file(fullPath);
      if (!originalXhtmlFile) continue;

      const originalXhtml = await originalXhtmlFile.async('string');
      const depth = ch.fileName.split('/').length - 1;
      const cssRelPath = (depth > 0 ? '../'.repeat(depth) : '') + 'translit.css';

      // 3a. Standalone footnote source file -> write 0-Offset XHTML placeholder
      if (
        ch.isFootnoteSource ||
        ch.classification?.disposition === 'system_footnote_source'
      ) {
        const placeholderXhtml = attachGeneratedCssLink(
          this.ensureEpub3XhtmlNamespace(
            this.footnoteResolver.createZeroOffsetPlaceholder(originalXhtml, ch.fileName)
          ),
          cssRelPath
        );
        zip.file(fullPath, placeholderXhtml);
        continue;
      }

      const hasTranslation =
        !ch.isReference && Boolean(ch.translatedMarkdown || ch.proofreadMarkdown);
      const hasFootnotesToInternalize = Boolean(
        ch.internalizedFootnotes && Object.keys(ch.internalizedFootnotes).length > 0
      );

      // Reference chapters (keep original) with no footnotes to internalize preserve original XHTML untouched
      if (ch.isReference && !hasFootnotesToInternalize) {
        continue;
      }

      // If chapter has neither translation nor internalized footnotes nor markdown content, preserve original
      if (!hasTranslation && !hasFootnotesToInternalize && !ch.markdown) {
        continue;
      }

      const contentToUse = ch.isReference
        ? ch.slottedMarkdown || ch.markdown || ''
        : ch.proofreadMarkdown || ch.translatedMarkdown || ch.slottedMarkdown || ch.markdown || '';

      // In bilingual mode, if a chapter has no translation, fall back to 'none' mode for that chapter
      const chapterBilingualMode = hasTranslation ? bilingualMode : 'none';

      const imagesRelPath = (depth > 0 ? '../'.repeat(depth) : '') + 'Images/';

      const baseDomXhtml = ch.content && /<[a-z][\s\S]*>/i.test(ch.content) ? ch.content : originalXhtml;
      const mutatedRes = this.domMutationEngine.mutateDomInPlaceWithStats(baseDomXhtml, contentToUse, {
        internalizedFootnotes: ch.internalizedFootnotes || {},
        translatedFootnotes: ch.isReference ? {} : (ch.translatedFootnotes || {}),
        sourcePayloadWithSlots: ch.slottedMarkdown || ch.markdown,
        bilingualMode: chapterBilingualMode,
        wereadMode,
        imagesRelPath,
        cssProfiles,
        bookStyleRoles,
        applyChineseTypography: hasTranslation && isChinese
      });

      const htmlBody =
        mutatedRes.leafCount > 0
          ? mutatedRes.html
          : await this.renderChapterEpub3Html(
              contentToUse,
              ch.internalizedFootnotes || {},
              ch.isReference ? {} : (ch.translatedFootnotes || {}),
              ch.slottedMarkdown || ch.markdown,
              chapterBilingualMode,
              wereadMode,
              imagesRelPath
            );

      let newXhtml = this.ensureEpub3XhtmlNamespace(originalXhtml);
      if (newXhtml.match(/<body[^>]*>/i)) {
        newXhtml = newXhtml.replace(/<body[^>]*>([\s\S]*)<\/body>/i, () => {
          const bodyTagMatch = newXhtml.match(/<body[^>]*>/i);
          const bodyTag = bodyTagMatch ? bodyTagMatch[0] : '<body>';
          return `${bodyTag}\n${htmlBody}\n</body>`;
        });
      } else {
        newXhtml = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n<body>\n${htmlBody}\n</body>\n</html>`;
      }

      newXhtml = attachGeneratedCssLink(newXhtml, cssRelPath);
      if (isChinese) {
        newXhtml = stripInlineFontFamilyForChineseEpub(newXhtml);
      }
      zip.file(fullPath, newXhtml);
    }

    // Ensure mimetype is the very first entry in the archive and uncompressed (STORE) per OCF spec
    if (zip.file('mimetype')) {
      const mimeText = await zip.file('mimetype')!.async('string');
      zip.remove('mimetype');
      zip.file('mimetype', mimeText, { compression: 'STORE' });
      const rawFiles = (zip as any).files;
      if (rawFiles && rawFiles['mimetype']) {
        const reordered: Record<string, any> = { mimetype: rawFiles['mimetype'] };
        for (const [k, v] of Object.entries(rawFiles)) {
          if (k !== 'mimetype') reordered[k] = v;
        }
        (zip as any).files = reordered;
      }
    }

    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/epub+zip'
    });
  }
}
