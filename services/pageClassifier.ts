import {
  Chapter,
  PageCategory,
  PageClassification,
  PageDisposition
} from '../types';
import { parseHtmlDocument, normalizeEpubFilePath } from '../utils/domAdapter';

export interface LightweightPagePayload {
  title: string;
  wordCount: number;
  snippet: string; // Strictly capped at 200 chars: text.slice(0, 200)
}

export interface LightweightAiVerdict {
  category: PageCategory;
  disposition: PageDisposition;
  reason: string;
  confidence?: number;
}

export type LightweightAiClassifier = (
  payload: LightweightPagePayload
) => Promise<LightweightAiVerdict>;

const COPYRIGHT_KEYWORDS = /\b(isbn|copyright\s*©?|all\s+rights\s+reserved|library\s+of\s+congress|cataloging-in-publication|printed\s+in\s+the|first\s+published\s+by|published\s+by\s+[a-z0-9]|版权所有|图书在版编目|cip数据)\b/i;
const COPYRIGHT_TITLE_OR_FILE = /^(copyright|colophon|imprint|legal|rights|cip)(?:[\s_-]|\d|\.)/i;
const PUBLISHER_PROMO_KEYWORDS = /\b(join\s+our\s+mailing\s+list|sign\s+up\s+to\s+receive|thank\s+you\s+for\s+downloading\s+this|click\s+here\s+to\s+sign\s+up|ebook[-\s]?signup)\b/i;
const PUBLISHER_PROMO_FILE = /(signup|recommendpage|newsletter|adcard|buylink)/i;

const TOC_TITLE_OR_FILE = /^(toc|table\s+of\s+contents|contents)(?:$|[\s_-]|\.)/i;
const FOOTNOTE_TITLE_OR_FILE = /^(notes?|endnotes?|footnotes?)(?:$|[\s_-]|\d|\.)/i;
const INDEX_OR_LONGDESC_FILE = /^(index|longdesc)\.(xhtml|html|htm|xml)$/i;

const AMBIGUOUS_TRANSITION_KEYWORDS = /\b(dedication|epigraph|foreword|preface|acknowledgm?ents?|praise\s+for|acclaim\s+for|also\s+by|about\s+the\s+author|appendix|glossary|bibliography|references|works\s+cited|editor'?s?\s+note|introduction|afterword|prologue|epilogue)\b/i;

export class PageClassifier {
  /**
   * Stage 1: Zero-latency local rule pre-classifier.
   * Executes synchronously on unpacked chapters using DOM & keyword features.
   */
  public classifyChaptersLocal(
    chapters: Chapter[],
    footnoteSourceFiles?: Set<string>
  ): Chapter[] {
    const normalizedSourceSet = new Set<string>();
    if (footnoteSourceFiles) {
      for (const f of footnoteSourceFiles) {
        normalizedSourceSet.add(normalizeEpubFilePath(f));
      }
    }

    return chapters.map((ch) => {
      const normFile = normalizeEpubFilePath(ch.fileName);
      const isKnownFnSource = Boolean(
        ch.isFootnoteSource || normalizedSourceSet.has(normFile)
      );
      return this.classifyChapterLocal(ch, isKnownFnSource);
    });
  }

  public classifyChapterLocal(
    chapter: Chapter,
    isKnownFootnoteSource: boolean = false
  ): Chapter {
    const doc = parseHtmlDocument(chapter.content || '');
    const body = doc.body;
    const rawText = (body?.textContent || chapter.markdown || '')
      .replace(/\s+/g, ' ')
      .trim();
    const wordCount = this.countWords(rawText);
    const lowerTitle = (chapter.title || '').trim().toLowerCase();
    const baseFileName = (chapter.fileName.split('/').pop() || '').toLowerCase();

    // 1. Standalone Footnote Source Page (Highest priority protection)
    // Only mark as 0-Offset drained footnote source if confirmed by FootnoteResolver
    if (isKnownFootnoteSource) {
      const classification: PageClassification = {
        category: 'footnote_source',
        disposition: 'system_footnote_source',
        reason: 'Standalone footnote definition page (auto-internalized & 0-Offset protected)',
        stage: 'local_rule',
        confidence: 1.0,
        isSystemProtected: true
      };
      return this.applyClassificationToChapter(chapter, classification);
    }

    // 2. Media-Only Page (Cover / Full-page Illustrations / Full-page Diagrams with Description link)
    const hasMedia = Boolean(
      body?.querySelector('img, svg, image, picture, canvas, video')
    );
    const cleanedMediaText = rawText.replace(/^description\s+\d+$/i, '').trim();
    if (hasMedia && cleanedMediaText.length < 30) {
      const classification: PageClassification = {
        category: 'media_only',
        disposition: 'keep_original',
        reason: 'Pure media/illustration page with no narrative text',
        stage: 'local_rule',
        confidence: 0.99
      };
      return this.applyClassificationToChapter(chapter, classification);
    }

    // 3. Table of Contents Page (TOC)
    if (this.isDomTocPage(body, lowerTitle, baseFileName, rawText)) {
      const classification: PageClassification = {
        category: 'toc',
        disposition: 'system_toc',
        reason: 'Navigation / Table of Contents structure',
        stage: 'local_rule',
        confidence: 0.98
      };
      return this.applyClassificationToChapter(chapter, classification);
    }

    // 4. Copyright / CIP / Publisher Newsletter Promo Page
    if (
      (COPYRIGHT_KEYWORDS.test(rawText) && wordCount < 600) ||
      COPYRIGHT_TITLE_OR_FILE.test(lowerTitle) ||
      COPYRIGHT_TITLE_OR_FILE.test(baseFileName) ||
      (PUBLISHER_PROMO_KEYWORDS.test(rawText) && wordCount < 450) ||
      PUBLISHER_PROMO_FILE.test(baseFileName)
    ) {
      const classification: PageClassification = {
        category: 'copyright',
        disposition: 'skip',
        reason: 'Copyright / CIP / Publisher promotional metadata page',
        stage: 'local_rule',
        confidence: 0.97
      };
      return this.applyClassificationToChapter(chapter, classification);
    }

    // 4b. Alphabetical Index or Accessibility Image Descriptions (back_matter reference)
    if (
      INDEX_OR_LONGDESC_FILE.test(baseFileName) ||
      Boolean(body?.querySelector('[role="doc-index"], [epub\\:type="index"]'))
    ) {
      const classification: PageClassification = {
        category: 'back_matter',
        disposition: 'keep_original',
        reason: 'Book index or accessibility image description reference page',
        stage: 'local_rule',
        confidence: 0.96
      };
      return this.applyClassificationToChapter(chapter, classification);
    }

    // 5. Ambiguous Transition Page (Dedication, Blurb, Foreword, Preface, Acknowledgments, Appendix, etc.)
    const headingText = Array.from(body?.querySelectorAll('h1, h2, h3') || [])
      .map((h) => h.textContent || '')
      .join(' ');
    const isTransitionCandidate =
      AMBIGUOUS_TRANSITION_KEYWORDS.test(lowerTitle) ||
      AMBIGUOUS_TRANSITION_KEYWORDS.test(baseFileName) ||
      AMBIGUOUS_TRANSITION_KEYWORDS.test(headingText) ||
      (wordCount > 0 && wordCount < 180 && (chapter.index <= 3 || false));

    if (isTransitionCandidate && wordCount < 1500) {
      const isBackRef = /\b(bibliography|references|works\s+cited|index)\b/i.test(
        `${lowerTitle} ${headingText} ${baseFileName}`
      );
      const classification: PageClassification = {
        category: 'ambiguous',
        disposition: isBackRef ? 'keep_original' : 'translate',
        reason: 'Transition page queued for Stage 2 lightweight AI classification',
        stage: 'local_rule',
        confidence: 0.55
      };
      return this.applyClassificationToChapter(chapter, classification);
    }

    // 6. Standard Content Page
    const classification: PageClassification = {
      category: 'content',
      disposition: 'translate',
      reason: 'Primary book chapter content',
      stage: 'local_rule',
      confidence: 0.95
    };
    return this.applyClassificationToChapter(chapter, classification);
  }

  /**
   * Stage 2: Lightweight AI Progressive Async Classifier.
   * Sends only `{ title, wordCount, snippet: text.slice(0, 200) }` for ambiguous transition pages.
   * Respects user overrides and system-protected footnote pages.
   */
  public async classifyAmbiguousPagesAi(
    chapters: Chapter[],
    aiClassifier: LightweightAiClassifier,
    onChapterUpdated?: (chapter: Chapter, index: number) => void
  ): Promise<Chapter[]> {
    const updatedChapters = [...chapters];

    const tasks = updatedChapters.map(async (ch, idx) => {
      if (!ch.classification || ch.classification.category !== 'ambiguous') {
        return;
      }
      if (ch.classification.stage === 'user_override' || ch.isSystemProtected) {
        return;
      }

      const payload = this.buildLightweightPayload(ch);
      try {
        const verdict = await aiClassifier(payload);
        // Re-check that user hasn't overridden while async request was in flight
        if (
          updatedChapters[idx].classification?.stage === 'user_override' ||
          updatedChapters[idx].isSystemProtected
        ) {
          return;
        }

        const nextClassification: PageClassification = {
          category: verdict.category,
          disposition: verdict.disposition,
          reason: verdict.reason,
          stage: 'lightweight_ai',
          confidence: verdict.confidence ?? 0.9
        };

        updatedChapters[idx] = this.applyClassificationToChapter(
          updatedChapters[idx],
          nextClassification
        );

        if (onChapterUpdated) {
          onChapterUpdated(updatedChapters[idx], idx);
        }
      } catch {
        // Keep Stage 1 fallback recommendation on AI error
      }
    });

    await Promise.all(tasks);
    return updatedChapters;
  }

  /**
   * Builds the minimal Stage 2 AI payload: `{ title, wordCount, snippet: text.slice(0, 200) }`.
   */
  public buildLightweightPayload(chapter: Chapter): LightweightPagePayload {
    const doc = parseHtmlDocument(chapter.content || '');
    const rawText = (doc.body?.textContent || chapter.markdown || '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      title: chapter.title || chapter.fileName,
      wordCount: this.countWords(rawText),
      snippet: rawText.slice(0, 200)
    };
  }

  /**
   * Lifecycle Binding Rule:
   * A footnote's translation status strictly follows the body chapter into which
   * it was internalized, completely decoupled from the standalone footnote source file's state.
   */
  public shouldTranslateChapterFootnotes(hostChapter: Chapter): boolean {
    if (hostChapter.isFootnoteSource) {
      return false;
    }
    if (hostChapter.isSkippable || hostChapter.isReference) {
      return false;
    }
    const disposition = hostChapter.classification?.disposition;
    if (
      disposition === 'skip' ||
      disposition === 'keep_original' ||
      disposition === 'system_toc' ||
      disposition === 'system_footnote_source'
    ) {
      return false;
    }
    return true;
  }

  public applyClassificationToChapter(
    chapter: Chapter,
    classification: PageClassification
  ): Chapter {
    const isFootnoteSource =
      Boolean(chapter.isFootnoteSource) ||
      classification.category === 'footnote_source' ||
      classification.disposition === 'system_footnote_source';

    const isSystemProtected = Boolean(
      isFootnoteSource || classification.isSystemProtected
    );

    let isSkippable = false;
    let isReference = false;

    switch (classification.disposition) {
      case 'skip':
        isSkippable = true;
        isReference = false;
        break;
      case 'keep_original':
      case 'system_toc':
      case 'system_footnote_source':
        isSkippable = false;
        isReference = true;
        break;
      case 'translate':
      default:
        isSkippable = false;
        isReference = false;
        break;
    }

    return {
      ...chapter,
      isFootnoteSource,
      isSystemProtected,
      isSkippable,
      isReference,
      classification: {
        ...classification,
        isSystemProtected
      }
    };
  }

  private isDomTocPage(
    body: HTMLElement | null | undefined,
    lowerTitle: string,
    baseFileName: string,
    rawText: string
  ): boolean {
    if (!body) return false;

    if (
      body.querySelector('nav[epub\\:type="toc"], nav#toc, nav.toc, [role="doc-toc"]')
    ) {
      return true;
    }

    if (TOC_TITLE_OR_FILE.test(lowerTitle) || TOC_TITLE_OR_FILE.test(baseFileName)) {
      return true;
    }

    const links = Array.from(body.querySelectorAll('a[href]'));
    if (links.length >= 4 && rawText.length > 0) {
      const linkTextLen = links.reduce(
        (sum, a) => sum + (a.textContent || '').trim().length,
        0
      );
      if (linkTextLen / rawText.length > 0.65) {
        return true;
      }
    }

    return false;
  }

  private isDomFootnoteSource(
    body: HTMLElement | null | undefined,
    lowerTitle: string,
    baseFileName: string
  ): boolean {
    if (!body) return false;
    const hasTitleMatch =
      FOOTNOTE_TITLE_OR_FILE.test(lowerTitle) ||
      FOOTNOTE_TITLE_OR_FILE.test(baseFileName);
    const footnoteNodes = body.querySelectorAll(
      '[epub\\:type="footnote"], [epub\\:type="endnote"], [epub\\:type="rearnote"], .footnote, .footnotes, .endnotes, [id^="fn"], [id^="note"]'
    );
    return hasTitleMatch && footnoteNodes.length > 0;
  }

  private countWords(text: string): number {
    if (!text) return 0;
    const cjkMatches = text.match(/[\u4e00-\u9fa5]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const nonCjkWords = text
      .replace(/[\u4e00-\u9fa5]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    return cjkCount + nonCjkWords;
  }
}
