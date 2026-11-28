import { FootnoteNode } from '../types';
import { parseHtmlDocument } from '../utils/domAdapter';
import { decodeBlocksFromWire } from '../utils/blockProtocol';
import {
  BLOCK_LEVEL_TAGS,
  NON_TRANSLATABLE_SUBTREE_TAGS,
  buildBlockDescendantIndex
} from '../utils/htmlStructure';
import { DomMutationEngine } from './domMutationEngine';

export const FOOTNOTE_SLOT_PROMPT_CONSTRAINT =
  '请严格保留形如 __FN_REF_{id}__ 的占位符，严禁翻译、增删或篡改其拼写与大小写。';

export interface TranslatedFootnote {
  footnoteId: string;
  canonicalKey?: string;
  originalText: string;
  translatedText: string;
  translatedParagraphs: string[];
  wasOversizedShunted?: boolean;
}

export interface ChapterBlock {
  index: number;
  tagName: string;
  slottedMarkdown: string;
  footnoteIds: string[];
  estimatedTokens: number;
}

export interface ContextAwareChunk {
  chunkIndex: number;
  slottedBodyMarkdown: string;
  referencedFootnoteIds: string[];
  pendingFootnotes: FootnoteNode[];
  referenceOnlyFootnotes: TranslatedFootnote[];
  oversizedFootnotes: FootnoteNode[];
  estimatedTokens: number;
}

export interface SlotValidationResult {
  isValidBeforeRepair: boolean;
  isValidAfterRepair: boolean;
  repairedText: string;
  missingIds: string[];
  repairedIds: string[];
}

export interface FootnotePoolOptions {
  maxChunkChars?: number;
  oversizedFootnoteThresholdChars?: number;
}

export function createFootnoteSlot(id: string): string {
  const cleanId = id.replace(/^fn-/, '').replace(/^[_＿]+|[_＿]+$/g, '');
  return `__FN_REF_${cleanId}__`;
}

export function extractFootnoteSlots(text: string): string[] {
  const matches = [...text.matchAll(/__FN_REF_([A-Za-z0-9_-]+?)__/g)];
  return matches.map((m) => m[1]);
}

/**
 * Detects whether a footnote's text is predominantly a URL, citation link, or code snippet.
 * When the model outputs verbatim URLs/code, it should be adopted rather than rejected as untranslated.
 */
export function isPureUrlOrCode(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  // Markdown autolink <http(s)://...> or <mailto:...>
  if (/^<(?:https?:\/\/|mailto:)[^\s>]+>$/i.test(trimmed)) {
    return true;
  }
  // Pure URL or starting with http(s):// or www.
  if (/^(?:https?:\/\/|www\.)[^\s<>"'{}|\\^`]+$/i.test(trimmed)) {
    return true;
  }
  // Markdown link [text](url) where url is pure http
  if (/^\[[^\]]+\]\((?:https?:\/\/|www\.)[^\s)]+\)$/i.test(trimmed)) {
    return true;
  }
  // Fenced code block or inline code
  if (/^```[\s\S]*```$/.test(trimmed) || /^`[^`]+`$/.test(trimmed)) {
    return true;
  }
  // Multiple URLs, DOI references, or code-like statements
  if (/^(?:(?:https?:\/\/|www\.|doi:)\S+\s*)+$/i.test(trimmed) || /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/i.test(trimmed)) {
    return true;
  }
  return false;
}

export interface LeakedFootnoteStripResult {
  cleanedText: string;
  extractedDefs: Record<string, string>;
}

/**
 * Strips leaked inline/end-of-body footnote definitions such as `(8-1) ...`, `(8 -1) ...`,
 * `<sup>(8 -1)</sup> ...`, or `注 8-1：...` for known chapter footnote IDs from translated prose,
 * returning both the cleaned prose and salvaged footnote definitions.
 */
export function stripLeakedFootnoteDefinitions(
  text: string,
  knownIds: string[]
): LeakedFootnoteStripResult {
  const extractedDefs: Record<string, string> = {};
  if (!text || !knownIds || knownIds.length === 0) {
    return { cleanedText: text, extractedDefs };
  }

  const normalizedIds = Array.from(
    new Set(
      knownIds
        .map((id) => String(id || '').trim().replace(/^fn-/, ''))
        .filter(Boolean)
    )
  );
  if (normalizedIds.length === 0) {
    return { cleanedText: text, extractedDefs };
  }

  // Count how many known IDs map to each natural suffix so unambiguous natural numbers
  // with explicit keyword prefixes (e.g. "脚注 1：...", "注 2: ...") are also stripped safely.
  const naturalSuffixCount = new Map<string, number>();
  for (const cleanId of normalizedIds) {
    const suffix = cleanId.includes('-') ? cleanId.split('-').pop()! : cleanId;
    naturalSuffixCount.set(suffix, (naturalSuffixCount.get(suffix) || 0) + 1);
  }

  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const buildIdTokenPattern = (cleanId: string): { markerPattern: string; flexId: string } => {
    const isNamespaced = /^\d+-\d+$/.test(cleanId);
    const flexId = isNamespaced
      ? cleanId
          .split('-')
          .map((part) => escapeRegex(part))
          .join('\\s*[-–—]\\s*')
      : escapeRegex(cleanId);

    const optOpenTags = '(?:<(?:sup|sub|span|b|strong|i|em)\\b[^>]*>\\s*)*';
    const optCloseTags = '(?:\\s*<\\/(?:sup|sub|span|b|strong|i|em)>)*';
    const explicitPrefix = '(?:注|注释|脚注|Footnote|Note)';

    const suffix = cleanId.includes('-') ? cleanId.split('-').pop()! : cleanId;
    const hasUniqueNaturalSuffix = isNamespaced && /^\d+$/.test(suffix) && naturalSuffixCount.get(suffix) === 1;
    const escapedSuffix = escapeRegex(suffix);
    const naturalKeywordAlt = hasUniqueNaturalSuffix
      ? `|${explicitPrefix}\\s*[:：#]?\\s*${escapedSuffix}(?!\\d)(?=\\s*[:：.．、])|〔\\s*${escapedSuffix}(?!\\d)\\s*〕`
      : '';

    const markerPattern = isNamespaced
      ? `${optOpenTags}(?:[\\(\\[\\uFF08【〔]\\s*(?:${explicitPrefix}\\s*)?${flexId}(?!\\d)\\s*[\\)\\]\\uFF09】〕]|${explicitPrefix}\\s*[:：#]?\\s*${flexId}(?!\\d)${naturalKeywordAlt})${optCloseTags}`
      : `${optOpenTags}(?:[\\(\\[\\uFF08【〔]?\\s*${explicitPrefix}\\s*[:：#]?\\s*${flexId}(?!\\d)\\s*[\\)\\]\\uFF09】〕]?|〔\\s*${flexId}(?!\\d)\\s*〕)${optCloseTags}`;

    return { markerPattern, flexId };
  };

  const allMarkerLookaheads = normalizedIds
    .map((id) => buildIdTokenPattern(id).markerPattern)
    .join('|');

  let cleaned = text
    .split('\n')
    .map((line) =>
      /^[ \t]*〔\s*\d+(?:\s*[-–—]\s*\d+)?\s*〕/.test(line)
        ? line.replace(/(?<=[^\n])[ \t]*(?=〔\s*\d+(?:\s*[-–—]\s*\d+)?\s*〕)/g, '\n')
        : line
    )
    .join('\n');

  for (const cleanId of normalizedIds) {
    const { markerPattern } = buildIdTokenPattern(cleanId);
    const blockRegex = new RegExp(
      `(?:^|\\n)[ \\t]*(?!#{1,6}\\s)${markerPattern}\\s*(?:[:：.．、])?[ \\t]*([\\s\\S]*?)(?=(?:\\n[ \\t]*\\n)|(?:\\n[ \\t]*(?:${allMarkerLookaheads}))|$)`,
      'gi'
    );

    cleaned = cleaned.replace(blockRegex, (_full, bodyRaw) => {
      const cleanedBody = String(bodyRaw || '')
        .replace(/(?:__FN_REF_[A-Za-z0-9_-]+__|\[\^(?:fn-)?[A-Za-z0-9_-]+\])+\s*$/g, '')
        .trim();
      if (cleanedBody && !extractedDefs[cleanId]) {
        extractedDefs[cleanId] = cleanedBody;
      }
      return '';
    });
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanedText: cleaned, extractedDefs };
}

/**
 * Validates that all __FN_REF_{id}__ slots from `originalText` are present in `translatedText`.
 * Automatically repairs casing/whitespace corruption (e.g. `__fn_ref_ 0-1 __`) and re-attaches
 * any accidentally dropped slot tokens back to their corresponding paragraphs so footnote links never break.
 */
export function validateAndRepairSlots(
  originalText: string,
  translatedText: string
): SlotValidationResult {
  const expectedIds = extractFootnoteSlots(originalText);
  if (expectedIds.length === 0) {
    return {
      isValidBeforeRepair: true,
      isValidAfterRepair: true,
      repairedText: translatedText,
      missingIds: [],
      repairedIds: []
    };
  }

  const initialPresent = extractFootnoteSlots(translatedText);
  const isInitiallyValid = hasMatchingSlotCounts(expectedIds, initialPresent);

  // Step 1: Normalize mangled slot syntax (case changes, spaces around underscores, fullwidth underscores)
  let repaired = translatedText.replace(
    /[_＿]{1,2}\s*fn\s*[_＿]\s*ref\s*[_＿]\s*((?:[A-Za-z0-9-]|_(?=[A-Za-z0-9-]))+)\s*[_＿]{1,2}/gi,
    (_, rawId) => `__FN_REF_${String(rawId).trim().replace(/^[_＿]+|[_＿]+$/g, '')}__`
  );

  // Reconcile present slots against expected IDs
  const presentSlots = extractFootnoteSlots(repaired);
  const remainingNeeded = [...expectedIds];
  for (const slot of presentSlots) {
    const idx = remainingNeeded.indexOf(slot);
    if (idx !== -1) {
      remainingNeeded.splice(idx, 1);
    }
  }

  // Normalize if LLM emitted natural-number slots like __FN_REF_1__ instead of __FN_REF_28-1__
  if (remainingNeeded.length > 0) {
    repaired = repaired.replace(
      /__FN_REF_([A-Za-z0-9_-]+?)__/g,
      (fullMatch, rawId) => {
        const candidate = String(rawId).trim();
        if (expectedIds.includes(candidate)) {
          return fullMatch;
        }
        let matchIdx = remainingNeeded.findIndex((id) => {
          const naturalNum = id.split('-').pop();
          return naturalNum === candidate;
        });
        if (matchIdx === -1 && remainingNeeded.length > 0) {
          matchIdx = 0;
        }
        if (matchIdx !== -1) {
          const matchedId = remainingNeeded.splice(matchIdx, 1)[0];
          return `__FN_REF_${matchedId}__`;
        }
        return fullMatch;
      }
    );
  }

  // Also normalize if LLM converted __FN_REF_0-1__ to [^0-1], [^1], [^fn-0-1] or [^1] in sequence
  repaired = repaired.replace(
    /(?:\[|【|〔)\s*\^\s*(?:fn-)?([A-Za-z0-9_-]+)\s*(?:\]|】|〕)(?!\s*[:：])/g,
    (_, rawId) => {
      const candidate = String(rawId).trim();
      // Level 1: Exact match with an ID in remainingNeeded
      let matchIdx = remainingNeeded.indexOf(candidate);

      // Level 2: Natural number match (e.g. candidate "1" matches "28-1" or "fn-28-1")
      if (matchIdx === -1) {
        matchIdx = remainingNeeded.findIndex((id) => {
          const naturalNum = id.split('-').pop();
          return naturalNum === candidate || id === candidate;
        });
      }

      // Level 3: Positional order fallback among remainingNeeded slots
      if (matchIdx === -1 && remainingNeeded.length > 0) {
        matchIdx = 0;
      }

      if (matchIdx !== -1) {
        const matchedId = remainingNeeded.splice(matchIdx, 1)[0];
        return `__FN_REF_${matchedId}__`;
      }

      return `[^${rawId}]`;
    }
  );

  // Normalize explicit localized inline footnote citations (e.g. "（脚注 1）", "(注 2)", "[Note 3]")
  // and bare tortoise-shell footnote markers ("〔1〕") when matching an expected slot,
  // leaving definitions (followed by colon) untouched.
  const consumeMatchingSlotId = (rawId: string): string | null => {
    const candidate = String(rawId).trim();
    let matchIdx = remainingNeeded.indexOf(candidate);
    if (matchIdx === -1) {
      matchIdx = remainingNeeded.findIndex((id) => {
        const naturalNum = id.split('-').pop();
        return naturalNum === candidate || id === candidate;
      });
    }
    if (matchIdx !== -1) {
      return remainingNeeded.splice(matchIdx, 1)[0];
    }
    return null;
  };

  if (remainingNeeded.length > 0) {
    repaired = repaired.replace(
      /(?:\(|（|\[|【|〔)\s*(?:脚注|注释|注|Footnote|Note)\s*[:：#]?\s*([A-Za-z0-9_-]+)\s*(?:\)|）|\]|】|〕)(?!\s*[:：])/gi,
      (fullMatch, rawId) => {
        const matchedId = consumeMatchingSlotId(rawId);
        return matchedId ? `__FN_REF_${matchedId}__` : fullMatch;
      }
    );
  }

  if (remainingNeeded.length > 0) {
    repaired = repaired.replace(
      /〔\s*([A-Za-z0-9_-]+)\s*〕(?!\s*[:：])/g,
      (fullMatch, rawId) => {
        const matchedId = consumeMatchingSlotId(rawId);
        return matchedId ? `__FN_REF_${matchedId}__` : fullMatch;
      }
    );
  }

  const afterNormalizeIds = extractFootnoteSlots(repaired);
  const missingIds: string[] = [];
  const repairedIds: string[] = [];

  // Count occurrences
  const expectedCounts = countOccurrences(expectedIds);
  const currentCounts = countOccurrences(afterNormalizeIds);

  for (const [id, expCount] of expectedCounts.entries()) {
    const curCount = currentCounts.get(id) || 0;
    if (curCount < expCount) {
      for (let k = 0; k < expCount - curCount; k++) {
        missingIds.push(id);
      }
    }
  }

  // Step 2: Re-inject any still-missing slots into their corresponding paragraphs (or end of text for single-block chunks)
  if (missingIds.length > 0) {
    const origParas = originalText
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const tgtParas = repaired
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    const appendSlotBeforeEndPunct = (para: string, slotToken: string): string => {
      const trimmed = para.trimEnd();
      if (/[。！？.!?”"’']$/.test(trimmed)) {
        return `${trimmed.slice(0, -1)}${slotToken}${trimmed.slice(-1)}`;
      }
      return `${trimmed}${slotToken}`;
    };

    if (origParas.length > 1 && tgtParas.length > 1) {
      const origOccurById = new Map<string, number[]>();
      origParas.forEach((p, pIdx) => {
        for (const id of extractFootnoteSlots(p)) {
          if (!origOccurById.has(id)) origOccurById.set(id, []);
          origOccurById.get(id)!.push(pIdx);
        }
      });

      tgtParas.forEach((p, tIdx) => {
        const approxOrigIdx =
          (tIdx / Math.max(1, tgtParas.length - 1)) * (origParas.length - 1);
        for (const id of extractFootnoteSlots(p)) {
          const list = origOccurById.get(id);
          if (list && list.length > 0) {
            let bestPos = 0;
            let bestDist = Infinity;
            for (let k = 0; k < list.length; k++) {
              const dist = Math.abs(list[k] - approxOrigIdx);
              if (dist < bestDist) {
                bestDist = dist;
                bestPos = k;
              }
            }
            list.splice(bestPos, 1);
          }
        }
      });

      const remainingIdxById = new Map<string, number[]>();
      for (const [id, list] of origOccurById.entries()) {
        remainingIdxById.set(id, [...list]);
      }

      for (const missingId of missingIds) {
        const slotToken = createFootnoteSlot(missingId);
        const queue = remainingIdxById.get(missingId);
        const origParaIdx =
          queue && queue.length > 0 ? queue.shift()! : origParas.length - 1;

        let tgtIdx =
          origParas.length === tgtParas.length
            ? origParaIdx
            : Math.min(
                tgtParas.length - 1,
                Math.max(
                  0,
                  Math.round(
                    (origParaIdx / Math.max(1, origParas.length - 1)) *
                      (tgtParas.length - 1)
                  )
                )
              );

        const origIsHeading = /^#{1,6}\s/.test(origParas[origParaIdx] || '');
        if (!origIsHeading && /^#{1,6}\s/.test(tgtParas[tgtIdx] || '')) {
          if (tgtIdx + 1 < tgtParas.length && !/^#{1,6}\s/.test(tgtParas[tgtIdx + 1])) {
            tgtIdx += 1;
          } else if (tgtIdx - 1 >= 0 && !/^#{1,6}\s/.test(tgtParas[tgtIdx - 1])) {
            tgtIdx -= 1;
          }
        }

        tgtParas[tgtIdx] = appendSlotBeforeEndPunct(tgtParas[tgtIdx], slotToken);
        repairedIds.push(missingId);
      }

      repaired = tgtParas.join('\n\n');
    } else {
      for (const missingId of missingIds) {
        const slotToken = createFootnoteSlot(missingId);
        repaired = appendSlotBeforeEndPunct(repaired, slotToken);
        repairedIds.push(missingId);
      }
    }
  }

  const finalIds = extractFootnoteSlots(repaired);
  const isValidAfterRepair = hasMatchingSlotCounts(expectedIds, finalIds);

  return {
    isValidBeforeRepair: isInitiallyValid,
    isValidAfterRepair,
    repairedText: repaired,
    missingIds,
    repairedIds
  };
}

function countOccurrences(items: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item, (map.get(item) || 0) + 1);
  }
  return map;
}

function hasMatchingSlotCounts(expected: string[], actual: string[]): boolean {
  const expMap = countOccurrences(expected);
  const actMap = countOccurrences(actual);
  for (const [id, count] of expMap.entries()) {
    if ((actMap.get(id) || 0) < count) return false;
  }
  return true;
}

export class FootnotePool {
  private poolById = new Map<string, TranslatedFootnote>();
  private poolByCanonicalKey = new Map<string, TranslatedFootnote>();
  private maxChunkChars: number;
  private oversizedThresholdChars: number;
  private domMutationEngine = new DomMutationEngine();

  constructor(options: FootnotePoolOptions = {}) {
    this.maxChunkChars = options.maxChunkChars || 2600;
    this.oversizedThresholdChars = options.oversizedFootnoteThresholdChars || 1200;
  }

  private serializeElementWithFootnoteSlots(el: Element): string {
    const clone = el.cloneNode(true) as Element;
    const links = Array.from(clone.querySelectorAll('a'));
    const doc = clone.ownerDocument;
    for (const a of links) {
      const epubType = a.getAttribute('epub:type') || '';
      const cls = a.getAttribute('class') || '';
      const href = a.getAttribute('href') || '';
      const dataFnId = a.getAttribute('data-fn-id');
      const isNoteref =
        epubType.split(/\s+/).includes('noteref') ||
        cls.split(/\s+/).includes('noteref') ||
        Boolean(dataFnId) ||
        href.startsWith('#fn-');

      if (!isNoteref) continue;

      let rawId = dataFnId || '';
      if (!rawId && href.startsWith('#')) {
        rawId = href.slice(1).replace(/^fn-/, '');
      }
      if (!rawId) continue;

      const slotText = createFootnoteSlot(rawId);
      if (doc && a.parentNode) {
        a.parentNode.replaceChild(doc.createTextNode(slotText), a);
      } else {
        a.textContent = slotText;
      }
    }

    const normalized = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (/^H[1-6]$/i.test(el.tagName)) {
      const hLevel = Number(el.tagName.charAt(1));
      return `${'#'.repeat(hLevel)} ${normalized}`;
    }
    return normalized;
  }

  public estimateTokens(text: string): number {
    if (!text) return 0;
    const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const nonCjkChars = text.length - cjk;
    return Math.ceil(cjk * 1.5 + nonCjkChars / 4);
  }

  public isOversizedFootnote(node: FootnoteNode): boolean {
    return node.plainText.length > this.oversizedThresholdChars;
  }

  public getTranslatedFootnote(
    footnoteId: string,
    canonicalKey?: string
  ): TranslatedFootnote | undefined {
    const cleanId = footnoteId.replace(/^fn-/, '');
    if (this.poolById.has(cleanId)) {
      return this.poolById.get(cleanId);
    }
    if (canonicalKey && this.poolByCanonicalKey.has(canonicalKey)) {
      const existing = this.poolByCanonicalKey.get(canonicalKey)!;
      const aliased: TranslatedFootnote = {
        ...existing,
        footnoteId: cleanId
      };
      this.poolById.set(cleanId, aliased);
      return aliased;
    }
    return undefined;
  }

  public setTranslatedFootnote(entry: TranslatedFootnote): void {
    const cleanId = entry.footnoteId.replace(/^fn-/, '');
    const normalized: TranslatedFootnote = {
      ...entry,
      footnoteId: cleanId
    };
    this.poolById.set(cleanId, normalized);
    if (normalized.canonicalKey) {
      this.poolByCanonicalKey.set(normalized.canonicalKey, normalized);
    }
  }

  public getAllTranslatedFootnotes(): Map<string, TranslatedFootnote> {
    return new Map(this.poolById);
  }

  /**
   * Rehydrates the FootnotePool from persisted chapter snapshots.
   * Restores both cleanId and canonicalKey mappings to ensure seamless resuming and retrying.
   */
  public restoreFromChapters(
    chapters: Array<{
      translatedFootnotes?: Record<string, string>;
      internalizedFootnotes?: Record<string, FootnoteNode>;
    }>
  ): void {
    for (const ch of chapters) {
      if (!ch.translatedFootnotes) continue;
      for (const [rawId, trText] of Object.entries(ch.translatedFootnotes)) {
        const cleanId = rawId.replace(/^fn-/, '');
        const origNode = ch.internalizedFootnotes?.[cleanId] || ch.internalizedFootnotes?.[rawId];
        this.setTranslatedFootnote({
          footnoteId: cleanId,
          canonicalKey: origNode?.key,
          originalText: origNode?.plainText || trText,
          translatedText: trText,
          translatedParagraphs: trText
            .split(/\n{2,}/)
            .map((p) => p.trim())
            .filter(Boolean),
          wasOversizedShunted: false
        });
      }
    }
  }

  /**
   * Parses chapter XHTML into leaf DOM block elements (`p`, `td`, `h1-h6`, `li`, `blockquote`, etc.),
   * replacing in-text footnote anchors with opaque `__FN_REF_{id}__` slots and recording
   * referenced footnote IDs per block.
   */
  public parseChapterToBlocks(
    chapterHtml: string,
    internalizedFootnotes: Record<string, FootnoteNode> = {}
  ): ChapterBlock[] {
    const extraction = this.domMutationEngine.extractTranslatablePayload(
      chapterHtml,
      internalizedFootnotes
    );
    if (extraction.blocks.length > 0) {
      return extraction.blocks.map((b, idx) => ({
        index: idx,
        tagName: b.tagName,
        slottedMarkdown: b.slottedText,
        footnoteIds: b.footnoteIds,
        estimatedTokens: this.estimateTokens(b.slottedText)
      }));
    }

    const doc = parseHtmlDocument(chapterHtml);
    const body = doc.body;
    if (!body) return [];

    const topElements = this.collectTopLevelBlockElements(body);
    const blocks: ChapterBlock[] = [];

    const hasInternalizedNotes = Object.keys(internalizedFootnotes).length > 0;

    topElements.forEach((el) => {
      // Skip standalone footnote aside/div blocks if footnotes were already internalized
      const epubType = el.getAttribute('epub:type') || el.getAttribute('role') || '';
      const cls = el.getAttribute('class') || '';
      if (
        hasInternalizedNotes &&
        (/\b(footnote|endnote|doc-footnote|doc-endnote|doc-endnotes)\b/i.test(epubType) ||
          /\b(footnotes?|fnlist)\b/i.test(cls))
      ) {
        return;
      }

      const slottedMd = this.serializeElementWithFootnoteSlots(el);
      if (!slottedMd) return;

      const slotIds = extractFootnoteSlots(slottedMd);
      const uniqueIds = Array.from(new Set(slotIds));

      blocks.push({
        index: blocks.length,
        tagName: el.tagName.toLowerCase(),
        slottedMarkdown: slottedMd,
        footnoteIds: uniqueIds,
        estimatedTokens: this.estimateTokens(slottedMd)
      });
    });

    return blocks;
  }

  private collectTopLevelBlockElements(container: Element): Element[] {
    const blockDescIndex = buildBlockDescendantIndex(container);
    const result: Element[] = [];

    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        const tag = (child.tagName || '').toUpperCase();
        if (NON_TRANSLATABLE_SUBTREE_TAGS.has(tag)) continue;
        if (tag === 'PRE' || tag === 'HR' || tag === 'FIGURE') {
          result.push(child);
        } else if (blockDescIndex.has(child)) {
          walk(child);
        } else if (BLOCK_LEVEL_TAGS.has(tag) || (child.textContent || '').trim().length > 0) {
          result.push(child);
        }
      }
    };

    walk(container);
    return result;
  }

  /**
   * Formats a dual-channel chunk payload combining body text (`[MAIN_CONTENT]`),
   * pending footnotes to translate (`[FOOTNOTES_TO_TRANSLATE]`), and already-translated
   * reference-only footnotes (`[FOOTNOTES_REFERENCE_ONLY]`).
   */
  public formatDualChannelPayload(
    slottedBodyMarkdown: string,
    pendingFootnotes: FootnoteNode[],
    referenceOnlyFootnotes: TranslatedFootnote[]
  ): string {
    if (pendingFootnotes.length === 0 && referenceOnlyFootnotes.length === 0) {
      return slottedBodyMarkdown;
    }

    const parts: string[] = [];
    parts.push(`[MAIN_CONTENT]\n${slottedBodyMarkdown}\n[/MAIN_CONTENT]`);

    if (pendingFootnotes.length > 0) {
      const fnLines = pendingFootnotes.map((fn) => {
        const id = (fn.namespaceId || fn.originalId).replace(/^fn-/, '');
        return `[FN_DEF:${id}]\n${fn.plainText}\n[/FN_DEF]`;
      });
      parts.push(
        `[FOOTNOTES_TO_TRANSLATE]\n${fnLines.join('\n\n')}\n[/FOOTNOTES_TO_TRANSLATE]`
      );
    }

    if (referenceOnlyFootnotes.length > 0) {
      const refLines = referenceOnlyFootnotes.map(
        (ref) =>
          `[FN_REF_CTX:${ref.footnoteId}]\nOriginal: ${ref.originalText}\nTranslated: ${ref.translatedText}\n[/FN_REF_CTX]`
      );
      parts.push(
        `[FOOTNOTES_REFERENCE_ONLY]\n${refLines.join('\n\n')}\n[/FOOTNOTES_REFERENCE_ONLY]`
      );
    }

    return parts.join('\n\n');
  }

  /**
   * Parses the LLM response for a dual-channel chunk payload, extracting the
   * translated main body and each newly translated footnote definition.
   */
  public parseDualChannelResponse(
    rawResponse: string,
    expectedBodyOriginal: string,
    pendingFootnotes: FootnoteNode[]
  ): {
    translatedBody: string;
    translatedFootnotes: Record<string, string>;
    slotValidation: SlotValidationResult;
  } {
    let extractedBody = rawResponse.trim();
    const translatedFootnotes: Record<string, string> = {};

    interface ExtractedDef {
      rawId: string;
      text: string;
    }
    const rawDefs: ExtractedDef[] = [];

    // 1. Extract [FN_DEF:id]...[/FN_DEF] (supports fullwidth colons, Chinese brackets, whitespace, and optional closing tag)
    const fnDefRegex = /(?:\[|【)\s*FN_DEF[:：]\s*([^\]】]+?)\s*(?:\]|】)([\s\S]*?)(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|(?=(?:\[|【)\s*FN_DEF[:：])|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = fnDefRegex.exec(rawResponse)) !== null) {
      const id = match[1].trim().replace(/^fn-/, '');
      const text = match[2].trim();
      if (id && text) {
        rawDefs.push({ rawId: id, text });
      }
    }

    // 2. Extract standard Markdown footnotes [^id]: text (supports Chinese brackets, optional fn-, and multiline definitions)
    const mdDefRegex = /(?:^|\n)(?:\[|【|〔)\s*\^\s*(?:fn-)?([^\]】〕]+?)\s*(?:\]|】|〕)[:：][ \t]*([\s\S]*?)(?=(?:\n(?:\[|【|〔)\s*\^\s*(?:fn-)?)|(?:\n\n(?!\s{2,}))|$)/g;
    while ((match = mdDefRegex.exec(rawResponse)) !== null) {
      const id = match[1].trim().replace(/^fn-/, '');
      const text = match[2].trim();
      if (id && text) {
        rawDefs.push({ rawId: id, text });
      }
    }

    // Deduplicate extracted definitions by rawId: if multiple exist, preserve the latest definition
    const defsMap = new Map<string, string>();
    for (const def of rawDefs) {
      defsMap.set(def.rawId.toLowerCase(), def.text);
    }
    const extractedDefs: ExtractedDef[] = Array.from(defsMap.entries()).map(([rawId, text]) => ({
      rawId,
      text
    }));

    // Extract [MAIN_CONTENT]...[/MAIN_CONTENT] if present
    const mainMatch = rawResponse.match(/(?:\[|【)\s*MAIN_CONTENT\s*(?:\]|】)([\s\S]*?)(?:\[|【)\s*[\/／]\s*MAIN_CONTENT\s*(?:\]|】)/i);
    if (mainMatch) {
      extractedBody = mainMatch[1].trim();
    } else {
      // Strip out [FOOTNOTES_TO_TRANSLATE] and [FOOTNOTES_REFERENCE_ONLY] sections if tags were partially kept
      extractedBody = extractedBody
        .replace(/(?:\[|【)\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)|$)/gi, '')
        .replace(/(?:\[|【)\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)|$)/gi, '')
        .replace(/(?:\[|【)\s*FN_DEF[:：][^\]】]+?(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|(?=(?:\[|【)\s*FN_DEF[:：])|$)/gi, '')
        .replace(/(?:\[|【)\s*FN_REF_CTX[:：][^\]】]+?(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FN_REF_CTX\s*(?:\]|】)|$)/gi, '')
        .replace(/(?:\[|【)\s*[\/／]?\s*MAIN_CONTENT\s*(?:\]|】)/gi, '')
        .trim();
    }

    // Clean any residual footnote definitions from extractedBody
    extractedBody = extractedBody
      .replace(/(?:\[|【)\s*FN_DEF[:：][^\]】]+?(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|(?=(?:\[|【)\s*FN_DEF[:：])|$)/gi, '')
      .replace(/(?:^|\n)(?:\[|【|〔)\s*\^\s*(?:fn-)?([^\]】〕]+?)\s*(?:\]|】|〕)[:：][ \t]*[\s\S]*?(?=(?:\n(?:\[|【|〔)\s*\^\s*(?:fn-)?)|(?:\n\n(?!\s{2,}))|$)/g, '')
      .trim();

    // Strip any leaked inline/end-of-body definitions for known pending footnote IDs (e.g. `(8 -1) ...`)
    const pendingKnownIds = pendingFootnotes.flatMap((fn) => [
      (fn.namespaceId || fn.originalId).replace(/^fn-/, ''),
      fn.originalId.replace(/^fn-/, '')
    ]);
    const strippedLeakRes = stripLeakedFootnoteDefinitions(extractedBody, pendingKnownIds);
    extractedBody = strippedLeakRes.cleanedText;

    // 4-level matching and position sequence fallback for pending footnotes
    const usedDefs = new Set<ExtractedDef>();

    // Level 1: Namespaced ID matching (e.g. "28-1" or exact cleanId)
    for (const fn of pendingFootnotes) {
      const cleanId = (fn.namespaceId || fn.originalId).replace(/^fn-/, '');
      const def = extractedDefs.find(
        (d) =>
          !usedDefs.has(d) &&
          (d.rawId.toLowerCase() === cleanId.toLowerCase() ||
            d.rawId.toLowerCase() === (fn.namespaceId || '').toLowerCase() ||
            d.rawId.toLowerCase() === fn.originalId.toLowerCase())
      );
      if (def) {
        usedDefs.add(def);
        translatedFootnotes[cleanId] = def.text;
      }
    }

    // Also adopt definitions salvaged by stripLeakedFootnoteDefinitions for unmatched notes
    for (const fn of pendingFootnotes) {
      const cleanId = (fn.namespaceId || fn.originalId).replace(/^fn-/, '');
      if (translatedFootnotes[cleanId]) continue;
      const origClean = fn.originalId.replace(/^fn-/, '');
      const salvaged = strippedLeakRes.extractedDefs[cleanId] || strippedLeakRes.extractedDefs[origClean];
      if (salvaged) {
        translatedFootnotes[cleanId] = salvaged;
      }
    }

    // Level 2: Natural number matching (e.g. natural number "1" for "28-1")
    for (const fn of pendingFootnotes) {
      const cleanId = (fn.namespaceId || fn.originalId).replace(/^fn-/, '');
      if (translatedFootnotes[cleanId]) continue;

      const numLabel = fn.label || cleanId.split('-').pop() || '';
      if (numLabel) {
        const def = extractedDefs.find(
          (d) =>
            !usedDefs.has(d) &&
            (d.rawId === numLabel.toLowerCase() || d.rawId === `fn-${numLabel}`.toLowerCase())
        );
        if (def) {
          usedDefs.add(def);
          translatedFootnotes[cleanId] = def.text;
        }
      }
    }

    // Level 3: In-slice appearance position index fallback
    for (let i = 0; i < pendingFootnotes.length; i++) {
      const fn = pendingFootnotes[i];
      const cleanId = (fn.namespaceId || fn.originalId).replace(/^fn-/, '');
      if (translatedFootnotes[cleanId]) continue;

      let defToUse: ExtractedDef | undefined;
      // Positional alignment: if definition at index i is unused, prefer it
      if (i < extractedDefs.length && !usedDefs.has(extractedDefs[i])) {
        defToUse = extractedDefs[i];
      } else {
        const remainingUnused = extractedDefs.filter((d) => !usedDefs.has(d));
        if (remainingUnused.length > 0) {
          defToUse = remainingUnused[0];
        }
      }

      if (defToUse) {
        usedDefs.add(defToUse);
        translatedFootnotes[cleanId] = defToUse.text;
      }
    }

    // Level 4: Strict explicit-marker fuzzyPattern in rawResponse (never bare line-start digits!)
    for (const fn of pendingFootnotes) {
      const cleanId = (fn.namespaceId || fn.originalId).replace(/^fn-/, '');
      if (translatedFootnotes[cleanId]) continue;

      const numLabel = fn.label || cleanId.split('-').pop() || '';
      const idTokens = [cleanId, numLabel].filter(Boolean);
      const escapedTokens = idTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const idPattern = escapedTokens.join('|');

      if (idPattern) {
        const explicitMarker = `(?:(?:注|注释|脚注|Footnote|Note)\\s*[:：#]?\\s*(?:${idPattern})(?!\\d)\\s*(?:[:：.．、]|(?=\\s))|(?:\\[|【|\\(|（)\\s*(?:${idPattern})(?!\\d)\\s*(?:\\]|】|\\)|）)\\s*[:：]|〔\\s*(?:${idPattern})(?!\\d)\\s*〕\\s*[:：]?)`;
        const stopLookahead = `(?:注|注释|脚注|Footnote|Note)\\s*[:：#]?\\s*\\d+(?!\\d)\\s*[:：.．、]|(?:\\[|【|\\(|（)\\s*(?:\\d+|${idPattern})(?!\\d)\\s*(?:\\]|】|\\)|）)\\s*[:：]|〔\\s*(?:\\d+|${idPattern})(?!\\d)\\s*〕`;
        const fuzzyPattern = new RegExp(
          `(?:^|\\n)[ \\t]*(?!#{1,6}\\s)${explicitMarker}[ \\t]*([^\\n]+(?:\\n(?!\\n|[ \\t]*(?:${stopLookahead}))[^\\n]+)*)`,
          'i'
        );
        const fuzzyMatch = rawResponse.match(fuzzyPattern);
        if (fuzzyMatch && fuzzyMatch[1]) {
          const candidateText = fuzzyMatch[1].trim();
          const trimmedFull = fuzzyMatch[0].trim();
          if (
            candidateText &&
            !/^#{1,6}\s/.test(trimmedFull) &&
            (candidateText !== fn.plainText || isPureUrlOrCode(fn.plainText))
          ) {
            translatedFootnotes[cleanId] = candidateText;
            if (extractedBody.includes(trimmedFull)) {
              extractedBody = extractedBody.replace(fuzzyMatch[0], '').replace(/\n{3,}/g, '\n\n').trim();
            }
          }
        }
      }
    }

    // Pure URL / Code check & fallback to original plainText if untranslated
    for (const fn of pendingFootnotes) {
      const cleanId = (fn.namespaceId || fn.originalId).replace(/^fn-/, '');
      if (!translatedFootnotes[cleanId]) {
        translatedFootnotes[cleanId] = fn.plainText;
      }
    }

    const expectedBlockCount = expectedBodyOriginal
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean).length;
    const blockDecoded = decodeBlocksFromWire(extractedBody, expectedBlockCount);
    if (blockDecoded.usedBlockProtocol) {
      extractedBody = blockDecoded.decodedText;
    }

    const slotValidation = validateAndRepairSlots(expectedBodyOriginal, extractedBody);

    return {
      translatedBody: slotValidation.repairedText,
      translatedFootnotes,
      slotValidation
    };
  }

  /**
   * Translates an oversized footnote by splitting its paragraphs into sub-chunks,
   * calling `translateChunk(string) -> Promise<string>`, and reassembling into the pool.
   */
  public async translateOversizedFootnote(
    node: FootnoteNode,
    translateChunk: (payload: string) => Promise<string>
  ): Promise<TranslatedFootnote> {
    const id = (node.namespaceId || node.originalId).replace(/^fn-/, '');
    const existing = this.getTranslatedFootnote(id, node.key);
    if (existing) return existing;

    const paragraphs =
      node.paragraphs && node.paragraphs.length > 0
        ? node.paragraphs
        : node.plainText.split(/\n{2,}/).filter(Boolean);

    const subChunks: string[] = [];
    let current = '';
    const subChunkBudget = Math.max(300, Math.floor(this.oversizedThresholdChars * 0.8));

    for (const p of paragraphs) {
      if (current && current.length + p.length + 2 > subChunkBudget) {
        subChunks.push(current);
        current = p;
      } else {
        current = current ? `${current}\n\n${p}` : p;
      }
    }
    if (current) subChunks.push(current);

    const translatedParts: string[] = [];
    for (const sub of subChunks) {
      const translatedSub = await translateChunk(sub);
      translatedParts.push(translatedSub.trim());
    }

    const fullTranslated = translatedParts.join('\n\n');
    const entry: TranslatedFootnote = {
      footnoteId: id,
      canonicalKey: node.key,
      originalText: node.plainText,
      translatedText: fullTranslated,
      translatedParagraphs: translatedParts
        .flatMap((part) => part.split(/\n{2,}/))
        .map((s) => s.trim())
        .filter(Boolean),
      wasOversizedShunted: true
    };

    this.setTranslatedFootnote(entry);
    return entry;
  }

  /**
   * Full chapter context-aware chunking + translation orchestration using the
   * `translateChunk(string) -> Promise<string>` contract.
   */
  public async translateChapterWithPool(
    chapterHtml: string,
    internalizedFootnotes: Record<string, FootnoteNode>,
    translateChunk: (payload: string) => Promise<string>
  ): Promise<{
    slottedSourceMarkdown: string;
    slottedTranslatedMarkdown: string;
    translatedFootnotes: Record<string, string>;
    chunksCount: number;
  }> {
    const blocks = this.parseChapterToBlocks(chapterHtml, internalizedFootnotes);
    const slottedSourceMarkdown = blocks.map((b) => b.slottedMarkdown).join('\n\n');

    // Group blocks into chunks respecting token/character budget (including non-oversized pending footnotes)
    const rawChunkGroups: ChapterBlock[][] = [];
    let currentGroup: ChapterBlock[] = [];
    let currentGroupChars = 0;
    const seenFootnoteIdsInPlanning = new Set<string>();

    for (const block of blocks) {
      let blockFootnoteChars = 0;
      for (const fnId of block.footnoteIds) {
        if (!seenFootnoteIdsInPlanning.has(fnId)) {
          const fnNode = internalizedFootnotes[fnId];
          if (fnNode && !this.isOversizedFootnote(fnNode)) {
            blockFootnoteChars += fnNode.plainText.length;
          }
        }
      }

      const blockTotalCost = block.slottedMarkdown.length + blockFootnoteChars;
      if (currentGroup.length > 0 && currentGroupChars + blockTotalCost > this.maxChunkChars) {
        rawChunkGroups.push(currentGroup);
        currentGroup = [block];
        currentGroupChars = blockTotalCost;
      } else {
        currentGroup.push(block);
        currentGroupChars += blockTotalCost;
      }

      block.footnoteIds.forEach((id) => seenFootnoteIdsInPlanning.add(id));
    }
    if (currentGroup.length > 0) {
      rawChunkGroups.push(currentGroup);
    }

    const translatedChunkBodies: string[] = [];
    const chapterTranslatedFootnotes: Record<string, string> = {};

    for (let i = 0; i < rawChunkGroups.length; i++) {
      const group = rawChunkGroups[i];
      const slottedBody = group.map((b) => b.slottedMarkdown).join('\n\n');
      const groupFnIds = Array.from(
        new Set(group.flatMap((b) => b.footnoteIds))
      );

      const pendingFootnotes: FootnoteNode[] = [];
      const referenceOnlyFootnotes: TranslatedFootnote[] = [];

      for (const fnId of groupFnIds) {
        const fnNode = internalizedFootnotes[fnId];
        if (!fnNode) continue;

        // Check global pool first (by chapter namespaceId OR canonical sourceKey)
        const cached = this.getTranslatedFootnote(fnId, fnNode.key);
        if (cached) {
          referenceOnlyFootnotes.push(cached);
          chapterTranslatedFootnotes[fnId] = cached.translatedText;
          continue;
        }

        // If oversized, shunt and translate independently first, then inject as reference-only context!
        if (this.isOversizedFootnote(fnNode)) {
          const shuntedEntry = await this.translateOversizedFootnote(
            fnNode,
            translateChunk
          );
          referenceOnlyFootnotes.push(shuntedEntry);
          chapterTranslatedFootnotes[fnId] = shuntedEntry.translatedText;
          continue;
        }

        // Otherwise, first appearance -> pending translation in this chunk
        pendingFootnotes.push(fnNode);
      }

      const payload = this.formatDualChannelPayload(
        slottedBody,
        pendingFootnotes,
        referenceOnlyFootnotes
      );

      const rawResult = await translateChunk(payload);
      const parsed = this.parseDualChannelResponse(
        rawResult,
        slottedBody,
        pendingFootnotes
      );

      translatedChunkBodies.push(parsed.translatedBody);

      // Commit newly translated footnotes to the global pool
      for (const fnNode of pendingFootnotes) {
        const id = (fnNode.namespaceId || fnNode.originalId).replace(/^fn-/, '');
        const trText = parsed.translatedFootnotes[id] || fnNode.plainText;
        const entry: TranslatedFootnote = {
          footnoteId: id,
          canonicalKey: fnNode.key,
          originalText: fnNode.plainText,
          translatedText: trText,
          translatedParagraphs: trText
            .split(/\n{2,}/)
            .map((p) => p.trim())
            .filter(Boolean),
          wasOversizedShunted: false
        };
        this.setTranslatedFootnote(entry);
        chapterTranslatedFootnotes[id] = trText;
      }
    }

    return {
      slottedSourceMarkdown,
      slottedTranslatedMarkdown: translatedChunkBodies.join('\n\n'),
      translatedFootnotes: chapterTranslatedFootnotes,
      chunksCount: rawChunkGroups.length
    };
  }
}
