import {
  BlockStyleRole,
  BookStyleRole,
  BookStyleRoleMap,
  CssClassSemanticMapping,
  InlineStyleRole
} from '../types';
import { parseHtmlDocument } from '../utils/domAdapter';
import {
  CssClassProfile,
  EXCLUDED_PSEUDO_HEADING_CLASSES,
  parseEpubCssProfiles,
  resolveElementVisualStyle
} from './domMutationEngine';

export interface BookStyleCandidate {
  cls: string;
  scope: 'block' | 'inline';
  tags: string[];
  cssSummary: string;
  count: number;
  minLen: number;
  maxLen: number;
  avgLen: number;
  maxConsecutiveRun: number;
  insideBlockquoteRatio: number;
  samples: string[];
  profile: CssClassProfile;
}

const BLOCK_STYLE_ROLES: ReadonlySet<BlockStyleRole> = new Set<BlockStyleRole>([
  'h1',
  'h2',
  'h3',
  'h4',
  'kicker',
  'subtitle',
  'body',
  'quote',
  'epigraph',
  'verse',
  'attribution',
  'callout',
  'caption',
  'hanging',
  'meta',
  'divider',
  'ignore'
]);

const INLINE_STYLE_ROLES: ReadonlySet<InlineStyleRole> = new Set<InlineStyleRole>([
  'emphasis',
  'strong',
  'dropcap',
  'code',
  'ignore'
]);

const BLOCK_CENSUS_TAGS = new Set([
  'P',
  'DIV',
  'BLOCKQUOTE',
  'LI',
  'TD',
  'TH',
  'DT',
  'DD',
  'FIGCAPTION',
  'CAPTION',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6'
]);

const INLINE_CENSUS_TAGS = new Set([
  'SPAN',
  'B',
  'STRONG',
  'I',
  'EM',
  'SMALL',
  'BIG',
  'CITE',
  'CODE',
  'U'
]);

const STRUCTURAL_CONTAINER_TAGS = new Set([
  'BODY',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'NAV',
  'ASIDE',
  'FIGURE',
  'IMG',
  'SVG',
  'HR',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'OL',
  'UL',
  'DL'
]);

const SKIP_CLASS_NAME_RE =
  /^(?:calibre|bilingual-(?:pair|source|target|heading|image)|noteref|footnote(?:-popup|-content|-backref)?|duokan-footnote(?:-item|-content)?|qqreader-footnote|pagebreak|translit-.*)$/i;

function formatCssSummary(profile: CssClassProfile): string {
  const parts: string[] = [];
  if (profile.fontSizeEm !== undefined && Math.abs(profile.fontSizeEm - 1) > 0.02) {
    parts.push(`${Number(profile.fontSizeEm.toFixed(2))}em`);
  }
  if (profile.fontWeight === 'bold') parts.push('bold');
  if (profile.fontStyle === 'italic') parts.push('italic');
  if (profile.textAlign && profile.textAlign !== 'left' && profile.textAlign !== 'justify') {
    parts.push(profile.textAlign);
  }
  if (profile.fontVariant === 'small-caps') parts.push('small-caps');
  if (profile.textTransform && profile.textTransform !== 'none') parts.push(profile.textTransform);
  if (profile.textIndentEm !== undefined) {
    parts.push(`indent:${Number(profile.textIndentEm.toFixed(2))}em`);
  }
  if (profile.marginTopEm !== undefined && profile.marginTopEm >= 0.8) {
    parts.push(`mt:${Number(profile.marginTopEm.toFixed(1))}em`);
  }
  if (profile.marginBottomEm !== undefined && profile.marginBottomEm >= 0.8) {
    parts.push(`mb:${Number(profile.marginBottomEm.toFixed(1))}em`);
  }
  if (profile.marginLeftEm !== undefined && profile.marginLeftEm >= 0.8) {
    parts.push(`ml:${Number(profile.marginLeftEm.toFixed(1))}em`);
  }
  if ((profile.letterSpacingEm ?? 0) >= 0.04) parts.push('tracked');
  if (profile.hasBorderBottom) parts.push('border-bottom');
  else if (profile.hasBorder) parts.push('border');
  return parts.join(';');
}

function isNeutralBodyProfile(profile: CssClassProfile): boolean {
  if (profile.isInlineOnly) return false;
  if (profile.fontWeight === 'bold' || profile.fontStyle === 'italic') return false;
  if (profile.fontSizeEm !== undefined && (profile.fontSizeEm < 0.94 || profile.fontSizeEm > 1.04)) {
    return false;
  }
  if (profile.textAlign && profile.textAlign !== 'left' && profile.textAlign !== 'justify') {
    return false;
  }
  if (profile.fontVariant === 'small-caps') return false;
  if (profile.textTransform && profile.textTransform !== 'none') return false;
  if (profile.hasBorder || profile.hasBorderBottom) return false;
  if ((profile.letterSpacingEm ?? 0) >= 0.04) return false;
  if (profile.textIndentEm !== undefined && profile.textIndentEm < 0) return false;
  if ((profile.marginLeftEm ?? 0) >= 1.2) return false;
  return true;
}

function getRunSignatureKey(el: Element, cssProfiles: Map<string, CssClassProfile>): string {
  const s = resolveElementVisualStyle(el, cssProfiles);
  const fsBucket = Math.round((s.fontSizeEm ?? 1) * 10);
  return [
    fsBucket,
    s.fontWeight || 'normal',
    s.fontStyle || 'normal',
    s.textAlign || 'left',
    s.fontVariant || 'normal',
    s.textTransform || 'none'
  ].join('|');
}

/**
 * Performs a fast zero-token census across the EPUB's XHTML chapters and stylesheets,
 * extracting styled candidate classes with usage counts, length distributions,
 * consecutive-run lengths, and 1-2 short real text excerpts.
 */
export function buildBookStyleCensus(
  chaptersHtml: string[],
  originalCssTexts: string[],
  maxCandidates: number = 60
): BookStyleCandidate[] {
  const cssProfiles = parseEpubCssProfiles(originalCssTexts);

  interface Accumulator {
    cls: string;
    scopeCounts: { block: number; inline: number };
    tagCounts: Map<string, number>;
    totalCount: number;
    nonHeadingCount: number;
    totalLen: number;
    minLen: number;
    maxLen: number;
    maxRun: number;
    bqCount: number;
    samples: Array<{ text: string; len: number }>;
    sawTextElement: boolean;
  }

  const accMap = new Map<string, Accumulator>();

  const ensureAcc = (cls: string): Accumulator => {
    let acc = accMap.get(cls);
    if (!acc) {
      acc = {
        cls,
        scopeCounts: { block: 0, inline: 0 },
        tagCounts: new Map(),
        totalCount: 0,
        nonHeadingCount: 0,
        totalLen: 0,
        minLen: Infinity,
        maxLen: 0,
        maxRun: 1,
        bqCount: 0,
        samples: [],
        sawTextElement: false
      };
      accMap.set(cls, acc);
    }
    return acc;
  };

  const addSample = (acc: Accumulator, rawText: string) => {
    const clean = rawText.replace(/[\s\u00a0]+/g, ' ').trim();
    if (!clean) return;
    const clipped = clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
    if (acc.samples.some((s) => s.text === clipped)) return;
    if (acc.samples.length < 2) {
      acc.samples.push({ text: clipped, len: clean.length });
    } else if (clean.length > acc.samples[1].len * 1.6 && acc.samples[1].len < 60) {
      acc.samples[1] = { text: clipped, len: clean.length };
    }
  };

  for (const html of chaptersHtml) {
    if (!html || !/<[a-z][\s\S]*>/i.test(html)) continue;
    const doc = parseHtmlDocument(html);
    if (!doc.body) continue;

    // Collect block leaf elements in order (exclude wrappers that contain nested block tags)
    const leafBlocks: Element[] = [];
    const walkBlocks = (el: Element) => {
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'MATH') return;
      const children = Array.from(el.children);
      const hasBlockChild = children.some((c) => {
        const ct = (c.tagName || '').toUpperCase();
        return BLOCK_CENSUS_TAGS.has(ct) || STRUCTURAL_CONTAINER_TAGS.has(ct);
      });
      if (hasBlockChild) {
        for (const child of children) walkBlocks(child);
        return;
      }
      if (BLOCK_CENSUS_TAGS.has(tag)) {
        const txt = (el.textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
        if (txt.length > 0) leafBlocks.push(el);
      } else {
        for (const child of children) walkBlocks(child);
      }
    };
    walkBlocks(doc.body);

    // Track consecutive runs (both by class AND by shared visual typography signature)
    const blockRunLengths = new Array<number>(leafBlocks.length).fill(1);
    let runStart = 0;
    while (runStart < leafBlocks.length) {
      const baseSig = getRunSignatureKey(leafBlocks[runStart], cssProfiles);
      let runEnd = runStart + 1;
      while (runEnd < leafBlocks.length) {
        const nextSig = getRunSignatureKey(leafBlocks[runEnd], cssProfiles);
        const sameParent = leafBlocks[runEnd].parentElement === leafBlocks[runStart].parentElement;
        if (!sameParent || nextSig !== baseSig) break;
        runEnd++;
      }
      const runLen = runEnd - runStart;
      for (let k = runStart; k < runEnd; k++) {
        blockRunLengths[k] = runLen;
      }
      runStart = runEnd;
    }

    leafBlocks.forEach((el, idx) => {
      const tag = (el.tagName || '').toUpperCase();
      const clsAttr = el.getAttribute('class') || '';
      const classes = clsAttr.split(/\s+/).filter(Boolean);
      if (classes.length === 0) return;

      const text = (el.textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      const isNativeHeading = /^H[1-6]$/.test(tag);
      const inBq = Boolean(el.closest('blockquote'));

      for (const cls of classes) {
        if (SKIP_CLASS_NAME_RE.test(cls)) continue;
        const acc = ensureAcc(cls);
        acc.totalCount++;
        if (!isNativeHeading) {
          acc.nonHeadingCount++;
          acc.scopeCounts.block++;
          acc.sawTextElement = true;
        }
        acc.tagCounts.set(tag.toLowerCase(), (acc.tagCounts.get(tag.toLowerCase()) || 0) + 1);
        acc.totalLen += text.length;
        acc.minLen = Math.min(acc.minLen, text.length);
        acc.maxLen = Math.max(acc.maxLen, text.length);
        acc.maxRun = Math.max(acc.maxRun, blockRunLengths[idx]);
        if (inBq) acc.bqCount++;
        addSample(acc, text);
      }
    });

    // Collect inline styled elements (skipping links and empty anchors)
    for (const inlineEl of Array.from(
      doc.body.querySelectorAll('span[class], b[class], strong[class], i[class], em[class], small[class], big[class], cite[class], code[class], u[class]')
    )) {
      if (inlineEl.closest('a[href]')) continue;
      const tag = (inlineEl.tagName || '').toUpperCase();
      if (!INLINE_CENSUS_TAGS.has(tag)) continue;
      const text = (inlineEl.textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      if (!text) continue;

      const classes = (inlineEl.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      for (const cls of classes) {
        if (SKIP_CLASS_NAME_RE.test(cls)) continue;
        const acc = ensureAcc(cls);
        acc.totalCount++;
        acc.nonHeadingCount++;
        acc.scopeCounts.inline++;
        acc.sawTextElement = true;
        acc.tagCounts.set(tag.toLowerCase(), (acc.tagCounts.get(tag.toLowerCase()) || 0) + 1);
        acc.totalLen += text.length;
        acc.minLen = Math.min(acc.minLen, text.length);
        acc.maxLen = Math.max(acc.maxLen, text.length);
        addSample(acc, text);
      }
    }
  }

  const candidates: BookStyleCandidate[] = [];
  for (const acc of accMap.values()) {
    if (!acc.sawTextElement || acc.nonHeadingCount === 0 || acc.totalCount === 0) continue;
    const profile = cssProfiles.get(acc.cls) || { className: acc.cls };
    if (profile.displayNone) continue;

    const scope: 'block' | 'inline' =
      profile.isInlineOnly || acc.scopeCounts.inline > acc.scopeCounts.block
        ? 'inline'
        : 'block';

    // Filter out plain neutral body classes and unstyled inline wrappers to minimize tokens
    const cssSummary = formatCssSummary(profile);
    if (scope === 'block' && isNeutralBodyProfile(profile) && !EXCLUDED_PSEUDO_HEADING_CLASSES.test(acc.cls)) {
      continue;
    }
    if (scope === 'inline' && !cssSummary) {
      continue;
    }

    const sortedTags = Array.from(acc.tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([t]) => t);

    candidates.push({
      cls: acc.cls,
      scope,
      tags: sortedTags,
      cssSummary: cssSummary || 'default',
      count: acc.nonHeadingCount,
      minLen: acc.minLen === Infinity ? 0 : acc.minLen,
      maxLen: acc.maxLen,
      avgLen: Math.round(acc.totalLen / Math.max(1, acc.totalCount)),
      maxConsecutiveRun: acc.maxRun,
      insideBlockquoteRatio: Number((acc.bqCount / Math.max(1, acc.totalCount)).toFixed(2)),
      samples: acc.samples.map((s) => s.text),
      profile
    });
  }

  // Prioritize visually distinctive & structurally telling classes before capping
  const scorePriority = (c: BookStyleCandidate): number => {
    let p = 0;
    const s = c.profile;
    if (s.fontSizeEm !== undefined && (s.fontSizeEm >= 1.15 || s.fontSizeEm <= 0.88)) p += 4;
    if (s.fontWeight === 'bold') p += 3;
    if (s.fontStyle === 'italic') p += 2;
    if (s.textAlign === 'center' || s.textAlign === 'right') p += 3;
    if (s.fontVariant === 'small-caps' || s.textTransform === 'uppercase') p += 3;
    if ((s.textIndentEm ?? 0) < 0) p += 3;
    if (s.hasBorder || s.hasBorderBottom) p += 2;
    if (c.maxConsecutiveRun >= 2) p += 2;
    if (c.scope === 'inline') p += 2;
    p += Math.min(c.count, 10) * 0.1;
    return p;
  };

  return candidates.sort((a, b) => scorePriority(b) - scorePriority(a)).slice(0, maxCandidates);
}

/**
 * Builds a compact 1-shot prompt for classifying all styled CSS classes in an EPUB
 * into orthogonal Heti Chinese publishing roles.
 */
export function buildStyleClassificationPrompt(candidates: BookStyleCandidate[]): {
  systemPrompt: string;
  userPrompt: string;
} {
  const serializeEntry = (c: BookStyleCandidate) => {
    const entry: Record<string, any> = {
      cls: c.cls,
      tag: c.tags[0] || (c.scope === 'inline' ? 'span' : 'p'),
      css: c.cssSummary,
      n: c.count,
      len: `${c.minLen}-${c.maxLen}`,
      ex: c.samples
    };
    if (c.scope === 'block' && c.maxConsecutiveRun > 1) {
      entry.run = c.maxConsecutiveRun;
    }
    if (c.insideBlockquoteRatio >= 0.3) {
      entry.bq = c.insideBlockquoteRatio;
    }
    return entry;
  };

  const payload = {
    block: candidates.filter((c) => c.scope === 'block').map(serializeEntry),
    inline: candidates.filter((c) => c.scope === 'inline').map(serializeEntry)
  };

  const systemPrompt = `You are a Chinese book typographer adapting an English/foreign EPUB to Pure Heti (赫蹏) + CLREQ publishing standards.
Classify each CSS class into an orthogonal publishing semantic mapping. Output ONLY valid JSON:
{"<cls>":{"role":"...","align":"left|center|right","weight":"bold","indent":"none"}}
Omit optional keys ("align", "weight", "indent") unless the class intentionally overrides the role's default.

Allowed "role" for "block" classes:
- "h1","h2","h3","h4": genuine part/chapter/section/subsection headings (short standalone titles, NOT inscriptions or full sentences)
- "kicker": chapter number or eyebrow label above a heading (e.g. "CHAPTER 3", "PART II")
- "subtitle": chapter/section subtitle immediately under a heading
- "body": ordinary narrative paragraphs (including flush-left chapter openers like .noindent/.CO — omit "indent" so Chinese uses 2em indent)
- "quote": block quotes, letters, historical plaques, signs, inscriptions (consecutive short lines with run>=2 like centered/small-caps lines are ALWAYS "quote", NEVER headings!)
- "epigraph": chapter/book epigraphs or dedications
- "verse": poetry, lyrics, or line-broken aphorisms
- "attribution": quote source, author signature, dateline, or credit
- "callout": highlighted summary/takeaway/definition/sidebar/Q&A callout paragraphs (full declarative sentences in bold are "callout" or "body" with weight:"bold", NEVER headings!)
- "caption": image/table captions and figure sources
- "hanging": bibliography, index, glossary, or TOC list items
- "meta": copyright/colophon/publisher front-matter fine print
- "divider": scene breaks or ornamental separators
- "ignore": structural wrappers without semantic role

Allowed "role" for "inline" classes:
- "emphasis": italic emphasis, foreign words, book titles
- "strong": bold keywords
- "dropcap": single-letter decorative initial/stickup cap (len 1-2, large font)
- "code": monospace code/UI keys
- "ignore": decorative link or neutral span`;

  const userPrompt = JSON.stringify(payload);
  return { systemPrompt, userPrompt };
}

/**
 * Strictly validates and normalizes the JSON output from AI style classification.
 */
export function parseStyleClassificationResponse(
  rawText: string,
  candidates: BookStyleCandidate[]
): BookStyleRoleMap {
  const result: BookStyleRoleMap = {};
  if (!rawText) return result;

  const candidateByName = new Map<string, BookStyleCandidate>();
  for (const c of candidates) {
    candidateByName.set(c.cls, c);
  }

  const stripped = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return result;

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result;
  }

  for (const [cls, rawVal] of Object.entries(parsed)) {
    const candidate = candidateByName.get(cls);
    if (!candidate || !rawVal || typeof rawVal !== 'object') continue;

    const rawRole = String(rawVal.role || '').trim() as BookStyleRole;
    if (candidate.scope === 'inline') {
      if (!INLINE_STYLE_ROLES.has(rawRole as InlineStyleRole)) continue;
      result[cls] = { role: rawRole, scope: 'inline' };
      continue;
    }

    if (!BLOCK_STYLE_ROLES.has(rawRole as BlockStyleRole)) continue;
    const mapping: CssClassSemanticMapping = {
      role: rawRole,
      scope: 'block'
    };
    if (rawVal.align === 'left' || rawVal.align === 'center' || rawVal.align === 'right') {
      mapping.align = rawVal.align;
    }
    if (rawVal.weight === 'bold') {
      mapping.weight = 'bold';
    }
    if (rawVal.indent === 'none') {
      mapping.indent = 'none';
    }
    result[cls] = mapping;
  }

  return result;
}

/**
 * Deterministic zero-token whole-book fallback classifier based on statistical census
 * across all occurrences of each CSS class in the EPUB.
 */
export function deriveLocalStyleRoles(candidates: BookStyleCandidate[]): BookStyleRoleMap {
  const roles: BookStyleRoleMap = {};

  for (const c of candidates) {
    const p = c.profile;
    const cls = c.cls;

    if (c.scope === 'inline') {
      if (
        (c.maxLen <= 2 && (p.fontSizeEm ?? 1) >= 1.25) ||
        /dropcap|stickupcap|initial|firstletter/i.test(cls)
      ) {
        roles[cls] = { role: 'dropcap', scope: 'inline' };
      } else if (p.fontStyle === 'italic' && p.fontWeight !== 'bold') {
        roles[cls] = { role: 'emphasis', scope: 'inline' };
      } else if (p.fontWeight === 'bold') {
        roles[cls] = { role: 'strong', scope: 'inline' };
      } else if (/\b(?:code|mono|tt)\b/i.test(cls)) {
        roles[cls] = { role: 'code', scope: 'inline' };
      }
      continue;
    }

    // Block candidates
    const align = p.textAlign === 'center' || p.textAlign === 'right' || p.textAlign === 'left'
      ? p.textAlign
      : undefined;

    if (/(?:^|[\s_-])(?:poem|verse|poetry)\d*(?:$|[\s_-])/i.test(cls)) {
      roles[cls] = { role: 'verse', scope: 'block' };
      continue;
    }
    if (/(?:^|[\s_-])(?:ded|dedication|epigraph|motto)\d*(?:$|[\s_-])/i.test(cls)) {
      roles[cls] = { role: 'epigraph', scope: 'block', ...(align ? { align } : {}) };
      continue;
    }
    if (/(?:^|[\s_-])(?:copy|copyright|colophon|meta)\d*(?:$|[\s_-])/i.test(cls)) {
      roles[cls] = { role: 'meta', scope: 'block', ...(align === 'center' ? { align } : {}) };
      continue;
    }
    if (/(?:^|[\s_-])(?:caption|img-caption|fig-caption|source)\d*(?:$|[\s_-])/i.test(cls)) {
      roles[cls] = { role: 'caption', scope: 'block' };
      continue;
    }
    if (
      /(?:^|[\s_-])(?:sig|signature|dateline|attribution|rightct|rightc)\d*(?:$|[\s_-])/i.test(cls) ||
      p.textAlign === 'right'
    ) {
      roles[cls] = {
        role: 'attribution',
        scope: 'block',
        ...(p.fontWeight === 'bold' ? { weight: 'bold' } : {})
      };
      continue;
    }
    if (
      (p.textIndentEm !== undefined && p.textIndentEm < 0) ||
      /(?:^|[\s_-])(?:bib|ref|reference|ind|inda|toc|hang)\d*(?:$|[\s_-])/i.test(cls)
    ) {
      roles[cls] = { role: 'hanging', scope: 'block' };
      continue;
    }
    if (/(?:^|[\s_-])(?:box|callout|sidebar)\d*(?:$|[\s_-])/i.test(cls)) {
      roles[cls] = {
        role: 'callout',
        scope: 'block',
        ...(align ? { align } : {}),
        ...(p.fontWeight === 'bold' ? { weight: 'bold' } : {})
      };
      continue;
    }
    if (
      /(?:^|[\s_-])(?:lett|quote|blockquote|bq|extract)\d*(?:$|[\s_-])/i.test(cls) ||
      c.insideBlockquoteRatio >= 0.5
    ) {
      roles[cls] = {
        role: 'quote',
        scope: 'block',
        ...(align ? { align } : {})
      };
      continue;
    }

    // Multi-line centered/small-caps plaque or inscription (e.g. .centert/.center/.centerb)
    const isExplicitHeadingCls =
      /\b(part-title|fm-title|bm-title|book-title|halftitle|half-title|chap-title|chapter-title|sec\d*-title|title[12]|h[1-6]|cn|ct)\b/i.test(
        cls
      );
    if (
      !isExplicitHeadingCls &&
      c.maxConsecutiveRun >= 2 &&
      c.maxLen <= 120 &&
      (p.textAlign === 'center' || p.fontVariant === 'small-caps' || p.textTransform === 'uppercase')
    ) {
      roles[cls] = {
        role: 'quote',
        scope: 'block',
        ...(p.textAlign === 'center' ? { align: 'center' } : {})
      };
      continue;
    }

    // Bold declarative/long paragraph that is clearly NOT a heading (e.g. .centertb callout or bold body lead)
    const looksLikeLongOrProseBold =
      p.fontWeight === 'bold' &&
      !isExplicitHeadingCls &&
      (c.maxLen > 90 ||
        ((p.fontSizeEm ?? 1) <= 1.05 && (p.marginTopEm ?? 0) < 1.0 && p.textAlign !== 'center') ||
        (p.fontSizeEm !== undefined && p.fontSizeEm < 1.0 && p.textAlign === 'center'));
    if (looksLikeLongOrProseBold) {
      roles[cls] = {
        role: p.textAlign === 'center' ? 'callout' : 'body',
        scope: 'block',
        weight: 'bold',
        ...(p.textAlign === 'center' ? { align: 'center' } : {}),
        ...(p.textIndentEm === 0 ? { indent: 'none' } : {})
      };
    }
  }

  return roles;
}

export class StyleClassifier {
  public buildCensus(
    chaptersHtml: string[],
    originalCssTexts: string[],
    maxCandidates: number = 60
  ): BookStyleCandidate[] {
    return buildBookStyleCensus(chaptersHtml, originalCssTexts, maxCandidates);
  }

  public classifyLocal(
    chaptersHtml: string[],
    originalCssTexts: string[],
    maxCandidates: number = 60
  ): { candidates: BookStyleCandidate[]; roles: BookStyleRoleMap } {
    const candidates = this.buildCensus(chaptersHtml, originalCssTexts, maxCandidates);
    const roles = deriveLocalStyleRoles(candidates);
    return { candidates, roles };
  }

  public async classifyBookStylesAi(
    chaptersHtml: string[],
    originalCssTexts: string[],
    aiClassifierFn: (candidates: BookStyleCandidate[]) => Promise<BookStyleRoleMap>
  ): Promise<{ candidates: BookStyleCandidate[]; roles: BookStyleRoleMap }> {
    const candidates = this.buildCensus(chaptersHtml, originalCssTexts);
    const localRoles = deriveLocalStyleRoles(candidates);
    if (candidates.length === 0) {
      return { candidates, roles: localRoles };
    }

    try {
      const aiRoles = await aiClassifierFn(candidates);
      return {
        candidates,
        roles: { ...localRoles, ...aiRoles }
      };
    } catch {
      return { candidates, roles: localRoles };
    }
  }
}
