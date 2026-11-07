import { FootnoteNode } from '../types';
import {
  parseHtmlDocument,
  resolveRelativeEpubHref,
  normalizeEpubFilePath
} from '../utils/domAdapter';

export interface ChapterFootnoteResolution {
  fileName: string;
  chapterIndex: number;
  html: string;
  internalizedFootnotes: Record<string, FootnoteNode>; // keyed by namespaceId e.g. "0-1"
  referencedSourceKeys: string[];
  isFootnoteSource: boolean;
}

export interface FootnoteResolutionResult {
  topology: Map<string, FootnoteNode>; // keyed by "normalizedFilePath#id"
  chapters: Record<string, ChapterFootnoteResolution>; // keyed by normalizedFilePath
  footnoteSourceFiles: Set<string>; // normalizedFilePaths of standalone footnote files
  zeroOffsetPlaceholders: Record<string, string>; // keyed by normalizedFilePath
}

const FOOTNOTE_ATTR_PATTERN = /(?:^|[\s_-])(fn|footnote|footnotes|endnote|endnotes|rearnote|note|noteref|doc-footnote|doc-endnote|doc-endnotes|doc-noteref|fnlist)(?:$|[\s_-]|\d)/i;
const FOOTNOTE_CONTAINER_ATTR_PATTERN = /(?:^|[\s_-])(fn|footnote|footnotes|endnote|endnotes|rearnote|doc-footnote|doc-endnote|doc-endnotes|fnlist)(?:$|[\s_-]|\d)/i;
const FOOTNOTE_ID_PREFIX_PATTERN = /^(fn|footnote|endnote|rearnote|note|en|nt|ftn)[-_:]?\d+[a-z]?$/i;
const NON_FOOTNOTE_ID_PATTERN = /(backlink|backref|fnref|noteref|ref|page|pg|fig|img|tbl|table|idx|index|desc|longdesc|det|chap|chapter|sec|section|part|hd|heading|toc|nav|cover)/i;
const FOOTNOTE_FILE_PATTERN = /(?:^|\/|[a-z0-9_-]*[_-])(notes?|endnotes?|footnotes?|_?fn\d*)(?:[_-]split[_-]\d+|[-_]?\d*)\.(xhtml|html|xml|htm)$/i;
const HEADING_OR_SEPARATOR_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'NAV', 'SECTION']);
const STRUCTURAL_CONTAINER_TAGS = new Set([
  'BODY',
  'HTML',
  'MAIN',
  'SECTION',
  'ARTICLE',
  'NAV',
  'HEADER',
  'FOOTER',
  'OL',
  'UL',
  'DL',
  'TABLE',
  'TBODY',
  'TR',
  'FIGURE'
]);
const INLINE_WRAPPER_TAGS = new Set(['A', 'SPAN', 'SUP', 'SUB', 'EM', 'I', 'B', 'STRONG', 'SMALL']);

export class FootnoteResolver {
  /**
   * Executes global pre-scan across all EPUB XHTML files, builds the cross-file
   * footnote topology index, internalizes links per chapter with chapter-scoped
   * namespaces (#fn-{chIndex}-{uniqueIndex}), marks standalone footnote source
   * files, and generates 0-Offset XHTML placeholders.
   */
  public resolveAll(
    files: Record<string, string>,
    spineFileNames?: string[]
  ): FootnoteResolutionResult {
    const normalizedFiles: Record<string, string> = {};
    for (const [rawPath, content] of Object.entries(files)) {
      normalizedFiles[normalizeEpubFilePath(rawPath)] = content;
    }

    const orderedFileNames = (spineFileNames && spineFileNames.length > 0
      ? spineFileNames.map(normalizeEpubFilePath)
      : Object.keys(normalizedFiles)
    ).filter((f) => normalizedFiles[f] !== undefined);

    // Step 1: Collect all incoming anchor targets across all files
    const incomingLinkTargets = this.collectIncomingTargets(normalizedFiles);

    // Step 2: Scan all files to build the global footnote topology index
    const { topology, extractedElementsByFile } = this.scanTopologyWithElements(
      normalizedFiles,
      incomingLinkTargets
    );

    // Step 3: Internalize footnote references in each chapter first so we know
    // which topology nodes are actually referenced cross-file vs same-page
    const chapters: Record<string, ChapterFootnoteResolution> = {};
    orderedFileNames.forEach((fileName, chIndex) => {
      const rawHtml = normalizedFiles[fileName];
      const resolved = this.internalizeChapterFootnotes(
        rawHtml,
        fileName,
        chIndex,
        topology
      );
      chapters[fileName] = {
        ...resolved,
        isFootnoteSource: false
      };
    });

    // Step 4: Determine standalone footnote source files (only files whose notes
    // were referenced cross-file and drained into body chapters)
    const footnoteSourceFiles = this.identifyFootnoteSourceFiles(
      normalizedFiles,
      topology,
      extractedElementsByFile,
      incomingLinkTargets
    );

    // Mark drained standalone footnote source chapters accordingly
    for (const sourceFile of footnoteSourceFiles) {
      if (chapters[sourceFile]) {
        chapters[sourceFile] = {
          fileName: sourceFile,
          chapterIndex: chapters[sourceFile].chapterIndex,
          html: normalizedFiles[sourceFile],
          internalizedFootnotes: {},
          referencedSourceKeys: [],
          isFootnoteSource: true
        };
      }
    }

    // Step 5: Generate 0-Offset placeholders for standalone footnote files
    const zeroOffsetPlaceholders: Record<string, string> = {};
    for (const sourceFile of footnoteSourceFiles) {
      const originalHtml = normalizedFiles[sourceFile];
      if (originalHtml) {
        zeroOffsetPlaceholders[sourceFile] = this.createZeroOffsetPlaceholder(
          originalHtml,
          sourceFile
        );
      }
    }

    return {
      topology,
      chapters,
      footnoteSourceFiles,
      zeroOffsetPlaceholders
    };
  }

  /**
   * Scans all XHTML files and returns the global footnote topology index:
   * Map<fileRelativePath + '#' + id, FootnoteNode>
   */
  public scanTopology(files: Record<string, string>): Map<string, FootnoteNode> {
    const normalizedFiles: Record<string, string> = {};
    for (const [rawPath, content] of Object.entries(files)) {
      normalizedFiles[normalizeEpubFilePath(rawPath)] = content;
    }
    const incomingLinkTargets = this.collectIncomingTargets(normalizedFiles);
    return this.scanTopologyWithElements(normalizedFiles, incomingLinkTargets).topology;
  }

  private isNavigationOrIndexDoc(doc: Document, filePath: string): boolean {
    const baseName = (filePath.split('/').pop() || '').toLowerCase();
    if (/^(nav|toc|index|longdesc)\.(xhtml|html|htm|xml)$/i.test(baseName)) {
      return true;
    }
    if (
      doc.querySelector(
        'nav[epub\\:type="toc"], [role="doc-toc"], [role="doc-index"], [epub\\:type="index"], [role="doc-pagelist"]'
      )
    ) {
      return true;
    }
    return false;
  }

  private isFootnoteId(id: string): boolean {
    if (!id || NON_FOOTNOTE_ID_PATTERN.test(id)) return false;
    return FOOTNOTE_ID_PREFIX_PATTERN.test(id);
  }

  private isLikelyCitationLink(link: Element): boolean {
    const role = link.getAttribute('role') || link.getAttribute('epub:type') || '';
    const cls = link.getAttribute('class') || '';
    if (/backlink|backref|doc-backlink|indref/i.test(`${role} ${cls}`)) {
      return false;
    }
    if (/\b(noteref|doc-noteref|footnote-ref|fnref)\b/i.test(`${role} ${cls}`)) {
      return true;
    }
    const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
    // Footnote citation markers in body text are compact markers (e.g. "1", "[1]", "*", "†", "[note 1]")
    if (text.length === 0 || text.length > 15) {
      return false;
    }
    return true;
  }

  private collectIncomingTargets(
    normalizedFiles: Record<string, string>
  ): Map<string, Set<string>> {
    // Map<targetKey (file#id), Set<sourceFile>>
    const targets = new Map<string, Set<string>>();

    for (const [filePath, html] of Object.entries(normalizedFiles)) {
      if (FOOTNOTE_FILE_PATTERN.test(filePath)) {
        // Links inside standalone notes/endnotes files pointing to chapters are backlinks, not incoming footnote citations
        continue;
      }
      const doc = parseHtmlDocument(html);
      if (this.isNavigationOrIndexDoc(doc, filePath)) {
        continue;
      }

      const links = Array.from(doc.querySelectorAll('a[href]'));
      for (const link of links) {
        // Ignore links inside navigation, index, or figure captions
        if (link.closest('nav, [role="doc-toc"], [role="doc-pagelist"], [role="doc-index"], figcaption')) {
          continue;
        }
        if (!this.isLikelyCitationLink(link)) {
          continue;
        }

        const href = link.getAttribute('href') || '';
        if (!href || !href.includes('#')) continue;
        const { filePath: targetFile, hash } = resolveRelativeEpubHref(filePath, href);
        if (!targetFile || !hash) continue;
        if (NON_FOOTNOTE_ID_PATTERN.test(hash)) continue;
        if (/longdesc\.(xhtml|html|htm|xml)$/i.test(targetFile)) continue;

        const key = `${targetFile}#${hash}`;
        if (!targets.has(key)) {
          targets.set(key, new Set());
        }
        targets.get(key)!.add(filePath);
      }
    }

    return targets;
  }

  private scanTopologyWithElements(
    normalizedFiles: Record<string, string>,
    incomingLinkTargets: Map<string, Set<string>>
  ): {
    topology: Map<string, FootnoteNode>;
    extractedElementsByFile: Map<string, Set<Element>>;
  } {
    const topology = new Map<string, FootnoteNode>();
    const extractedElementsByFile = new Map<string, Set<Element>>();

    for (const [filePath, html] of Object.entries(normalizedFiles)) {
      const doc = parseHtmlDocument(html);
      if (this.isNavigationOrIndexDoc(doc, filePath)) {
        extractedElementsByFile.set(filePath, new Set());
        continue;
      }

      const isDedicatedNoteFile = FOOTNOTE_FILE_PATTERN.test(filePath);
      const consumedBlocks = new Set<Element>();

      // Gather candidate elements with ID (or <a name="...">)
      const allIdElements = Array.from(doc.body?.querySelectorAll('[id], a[name]') || []);

      // First determine which elements are footnote start candidates
      const candidateMap = new Map<Element, string>(); // blockElement -> id
      for (const el of allIdElements) {
        const id = el.getAttribute('id') || el.getAttribute('name') || '';
        if (!id) continue;

        const key = `${filePath}#${id}`;
        const referencingFiles = incomingLinkTargets.get(key);
        const isTargetedFromBody = referencingFiles !== undefined && referencingFiles.size > 0;

        if (this.isFootnoteCandidate(el, id, isDedicatedNoteFile, isTargetedFromBody)) {
          const blockEl = this.resolveFootnoteStartBlock(el);
          // Never register a structural container (e.g. <section>, <ol>) or bare inline tag as a FootnoteNode
          if (
            STRUCTURAL_CONTAINER_TAGS.has(blockEl.tagName) ||
            INLINE_WRAPPER_TAGS.has(blockEl.tagName)
          ) {
            continue;
          }
          if (!candidateMap.has(blockEl)) {
            candidateMap.set(blockEl, id);
          }
        }
      }

      // Extract each candidate along with its multi-paragraph sibling continuation
      for (const [startBlock, id] of candidateMap.entries()) {
        if (consumedBlocks.has(startBlock)) continue;

        const key = `${filePath}#${id}`;
        const { paragraphs, rawHtmlParts, consumed } = this.extractMultiParagraphFootnote(
          startBlock,
          id,
          candidateMap
        );

        consumed.forEach((c) => consumedBlocks.add(c));

        const cleanParagraphs = paragraphs
          .map((p) => p.trim())
          .filter((p) => p.length > 0);

        if (cleanParagraphs.length === 0) continue;

        const label = this.extractFootnoteLabel(startBlock, id);

        topology.set(key, {
          key,
          sourceFile: filePath,
          originalId: id,
          label,
          html: rawHtmlParts.join('\n'),
          plainText: cleanParagraphs.join('\n\n'),
          paragraphs: cleanParagraphs,
          referencedByChapters: []
        });
      }

      extractedElementsByFile.set(filePath, consumedBlocks);
    }

    return { topology, extractedElementsByFile };
  }

  private isInsideFootnoteContainer(el: Element): boolean {
    let parent = el.parentElement;
    while (parent && parent.tagName !== 'BODY') {
      const pType = parent.getAttribute('epub:type') || parent.getAttribute('role') || '';
      const pClass = parent.getAttribute('class') || '';
      const pId = parent.getAttribute('id') || '';
      if (
        FOOTNOTE_CONTAINER_ATTR_PATTERN.test(pType) ||
        FOOTNOTE_CONTAINER_ATTR_PATTERN.test(pClass) ||
        FOOTNOTE_CONTAINER_ATTR_PATTERN.test(pId)
      ) {
        return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  private isFootnoteCandidate(
    el: Element,
    id: string,
    isDedicatedNoteFile: boolean,
    isTargetedFromBody: boolean
  ): boolean {
    // Avoid treating top-level chapter headings or structural containers as footnotes
    if (HEADING_OR_SEPARATOR_TAGS.has(el.tagName) || STRUCTURAL_CONTAINER_TAGS.has(el.tagName)) {
      return false;
    }
    if (NON_FOOTNOTE_ID_PATTERN.test(id)) {
      return false;
    }

    // Never treat an in-text noteref link or pagebreak marker as a footnote definition
    const epubType = el.getAttribute('epub:type') || el.getAttribute('role') || '';
    const className = el.getAttribute('class') || '';
    if (
      /\b(noteref|doc-noteref|pagebreak|doc-pagebreak)\b/i.test(epubType) ||
      /\b(noteref|pagebreak)\b/i.test(className)
    ) {
      return false;
    }

    const inFootnoteContainer = this.isInsideFootnoteContainer(el);

    // Reject empty inline elements (e.g. <span id="note1"/> or <span id="page_10"/>) inside normal body text
    if (
      INLINE_WRAPPER_TAGS.has(el.tagName) &&
      (el.textContent || '').trim().length === 0 &&
      !isDedicatedNoteFile &&
      !inFootnoteContainer
    ) {
      return false;
    }

    const block = this.resolveFootnoteStartBlock(el);
    if (STRUCTURAL_CONTAINER_TAGS.has(block.tagName) || INLINE_WRAPPER_TAGS.has(block.tagName)) {
      return false;
    }

    // 1. Explicit epub:type or class or id matching footnote patterns
    if (
      /\b(footnote|endnote|rearnote|note|doc-footnote|doc-endnote)\b/i.test(epubType) ||
      FOOTNOTE_CONTAINER_ATTR_PATTERN.test(className) ||
      this.isFootnoteId(id)
    ) {
      return true;
    }

    // 2. Ancestor container is a footnote section/list/aside
    if (inFootnoteContainer) {
      return true;
    }

    let parent = el.parentElement;
    while (parent && parent.tagName !== 'BODY') {
      if (
        (parent.tagName === 'OL' || parent.tagName === 'UL' || parent.tagName === 'DL') &&
        (isDedicatedNoteFile || isTargetedFromBody) &&
        this.containsBacklink(block)
      ) {
        return true;
      }
      parent = parent.parentElement;
    }

    // 3. Element in a dedicated notes file or targeted by a link AND its leaf block has a backlink
    if ((isDedicatedNoteFile || isTargetedFromBody) && this.containsBacklink(block)) {
      return true;
    }

    // 4. In a dedicated notes file and targeted by another chapter
    if (isDedicatedNoteFile && isTargetedFromBody) {
      return true;
    }

    return false;
  }

  private resolveFootnoteStartBlock(el: Element): Element {
    let curr: Element = el;
    while (
      curr.parentElement &&
      INLINE_WRAPPER_TAGS.has(curr.tagName) &&
      !STRUCTURAL_CONTAINER_TAGS.has(curr.parentElement.tagName)
    ) {
      curr = curr.parentElement;
    }
    return curr;
  }

  private containsBacklink(block: Element): boolean {
    const links = Array.from(block.querySelectorAll('a[href]'));
    for (const a of links) {
      const text = (a.textContent || '').trim();
      const cls = a.getAttribute('class') || '';
      const role = a.getAttribute('role') || a.getAttribute('epub:type') || '';
      const href = a.getAttribute('href') || '';
      if (
        /backlink|backref|doc-backlink/i.test(cls) ||
        /backlink|doc-backlink/i.test(role) ||
        /^(↩|↑|↵|«|‹|\(?\[?\d+\]?\)?\.?|\*+|†|‡|§|back|return)$/i.test(text) ||
        /#(fnref|noteref|ref|back|r\d)/i.test(href)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Multi-paragraph Footnote Boundary Algorithm:
   * Starting from the block containing the footnote ID, collects nested paragraphs
   * or subsequent sibling elements until encountering the next footnote ID,
   * a block containing a reverse backlink, or a structural heading/divider.
   */
  private extractMultiParagraphFootnote(
    startBlock: Element,
    id: string,
    candidateMap: Map<Element, string>
  ): {
    paragraphs: string[];
    rawHtmlParts: string[];
    consumed: Element[];
  } {
    const paragraphs: string[] = [];
    const rawHtmlParts: string[] = [];
    const consumed: Element[] = [startBlock];

    // Case A: startBlock is a wrapper (<aside>, <li>, <div>, <dd>) containing child <p> elements
    const directChildParagraphs = Array.from(startBlock.children).filter(
      (c) => c.tagName === 'P' || c.tagName === 'BLOCKQUOTE'
    );
    const hasOtherCandidateInside = Array.from(startBlock.querySelectorAll('[id]')).some(
      (inner) => {
        const innerId = inner.getAttribute('id');
        return innerId && innerId !== id && this.isFootnoteId(innerId);
      }
    );

    if (directChildParagraphs.length > 0 && !hasOtherCandidateInside) {
      for (const p of directChildParagraphs) {
        const cleaned = this.cleanFootnoteParagraphNode(p);
        if (cleaned.text) {
          paragraphs.push(cleaned.text);
          rawHtmlParts.push(`<p>${cleaned.html}</p>`);
        }
      }
      return { paragraphs, rawHtmlParts, consumed };
    }

    // Case B: startBlock is itself a paragraph/block (e.g. <p id="fn1">...</p>)
    // Collect startBlock and then walk subsequent sibling nodes
    const firstCleaned = this.cleanFootnoteParagraphNode(startBlock);
    if (firstCleaned.text) {
      paragraphs.push(firstCleaned.text);
      rawHtmlParts.push(`<p>${firstCleaned.html}</p>`);
    }

    // Only walk siblings if startBlock is a flat block (like <p>) rather than a self-contained <aside> or <li>
    if (startBlock.tagName === 'ASIDE' || startBlock.tagName === 'LI') {
      return { paragraphs, rawHtmlParts, consumed };
    }

    let sibling = startBlock.nextElementSibling;
    while (sibling) {
      // Stop if sibling is a heading, separator, or non-paragraph container
      if (HEADING_OR_SEPARATOR_TAGS.has(sibling.tagName)) {
        break;
      }

      // Stop if sibling is registered as another footnote candidate
      if (candidateMap.has(sibling)) {
        break;
      }

      // Stop if sibling has its own footnote-like ID or contains one
      const siblingId = sibling.getAttribute('id') || '';
      if (siblingId && this.isFootnoteId(siblingId)) {
        break;
      }
      const nestedCandidate = Array.from(sibling.querySelectorAll('[id], a[name]')).some((el) => {
        const innerId = el.getAttribute('id') || el.getAttribute('name') || '';
        return innerId && (candidateMap.has(el) || this.isFootnoteId(innerId));
      });
      if (nestedCandidate) {
        break;
      }

      // Stop if sibling contains a backlink pointing back to a chapter citation (start of next note)
      if (this.startsWithBacklinkOrCitationNumber(sibling)) {
        break;
      }

      // Only collect continuation block elements (<p>, <blockquote>, etc.)
      if (sibling.tagName === 'P' || sibling.tagName === 'BLOCKQUOTE' || sibling.tagName === 'DIV') {
        const cleanedSib = this.cleanFootnoteParagraphNode(sibling);
        if (cleanedSib.text) {
          paragraphs.push(cleanedSib.text);
          rawHtmlParts.push(`<p>${cleanedSib.html}</p>`);
        }
        consumed.push(sibling);
        sibling = sibling.nextElementSibling;
      } else {
        break;
      }
    }

    return { paragraphs, rawHtmlParts, consumed };
  }

  private startsWithBacklinkOrCitationNumber(el: Element): boolean {
    const firstLink = el.querySelector('a[href]');
    if (!firstLink) return false;

    // Check if firstLink is near the very start of the element text
    const fullText = (el.textContent || '').trim();
    const linkText = (firstLink.textContent || '').trim();
    if (
      linkText &&
      fullText.startsWith(linkText) &&
      /^(\[?\d+\]?\.?|\*+|†|‡|§|↩|↑)$/i.test(linkText)
    ) {
      return true;
    }
    return false;
  }

  private extractFootnoteLabel(startBlock: Element, fallbackId: string): string {
    const firstLink = startBlock.querySelector('a[href]');
    if (firstLink) {
      const linkText = (firstLink.textContent || '').trim();
      const cleaned = linkText.replace(/^[\[\(]|[\]\)\.:]$/g, '').trim();
      if (cleaned && /^(\d+|\*+|†|‡|[a-z])$/i.test(cleaned)) {
        return cleaned;
      }
    }
    const numMatch = fallbackId.match(/(\d+)$/);
    return numMatch ? numMatch[1] : fallbackId;
  }

  private cleanFootnoteParagraphNode(el: Element): { text: string; html: string } {
    const clone = el.cloneNode(true) as Element;

    // Remove backlink anchors (leading number backlinks or trailing ↩ arrows)
    const links = Array.from(clone.querySelectorAll('a[href]'));
    for (const a of links) {
      const linkText = (a.textContent || '').trim();
      const cls = a.getAttribute('class') || '';
      const role = a.getAttribute('role') || a.getAttribute('epub:type') || '';
      const isBacklink =
        /backlink|backref|doc-backlink/i.test(cls) ||
        /backlink|doc-backlink/i.test(role) ||
        /^(↩|↑|↵|«|‹|back|return)$/i.test(linkText) ||
        (/^(\[?\d+\]?\.?|\*+|†|‡)$/.test(linkText) &&
          (clone.textContent || '').trim().startsWith(linkText));

      if (isBacklink) {
        a.remove();
      }
    }

    let html = clone.innerHTML.trim();
    // Strip leading punctuation/numbers left behind after backlink removal (e.g. "1. " or "[1] ")
    html = html.replace(/^(?:\[\d+\]|\d+\.)\s*/, '').trim();

    const text = (clone.textContent || '')
      .replace(/^(?:\[\d+\]|\d+\.)\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    return { text, html };
  }

  /**
   * Rewrites cross-file and same-page footnote links in a chapter to chapter-namespaced
   * same-page references: <a id="fnref-{chIndex}-{uniqueIndex}" href="#fn-{chIndex}-{uniqueIndex}" epub:type="noteref" class="noteref">
   */
  public internalizeChapterFootnotes(
    chapterHtml: string,
    chapterFileName: string,
    chapterIndex: number,
    topology: Map<string, FootnoteNode>
  ): ChapterFootnoteResolution {
    const normalizedChapterFile = normalizeEpubFilePath(chapterFileName);
    const doc = parseHtmlDocument(chapterHtml);
    const internalizedFootnotes: Record<string, FootnoteNode> = {};
    const referencedSourceKeys: string[] = [];

    if (this.isNavigationOrIndexDoc(doc, normalizedChapterFile)) {
      return {
        fileName: normalizedChapterFile,
        chapterIndex,
        html: chapterHtml,
        internalizedFootnotes,
        referencedSourceKeys,
        isFootnoteSource: false
      };
    }

    // Map<sourceKey, assignedNamespaceId> within this chapter so repeated citations
    // to the same footnote in the same chapter share the same chapter-scoped ID
    const sourceKeyToNamespaceId = new Map<string, string>();
    const citationOccurrenceCount = new Map<string, number>();
    let uniqueCounter = 0;

    // Collect same-page footnote definition IDs and their resolved definition blocks
    // so we don't rewrite backlink anchors inside footnote definitions themselves
    const samePageFootnoteIds = new Set<string>();
    const samePageFootnoteBlocks = new Set<Element>();
    for (const [, node] of topology.entries()) {
      if (node.sourceFile === normalizedChapterFile) {
        samePageFootnoteIds.add(node.originalId);
        const defEl = doc.getElementById(node.originalId);
        if (defEl) {
          const blockEl = this.resolveFootnoteStartBlock(defEl);
          if (!STRUCTURAL_CONTAINER_TAGS.has(blockEl.tagName)) {
            samePageFootnoteBlocks.add(blockEl);
          }
        }
      }
    }

    const links = Array.from(doc.body?.querySelectorAll('a[href]') || []);
    for (const link of links) {
      // Skip links inside navigation, index, or figure captions
      if (link.closest('nav, [role="doc-toc"], [role="doc-pagelist"], [role="doc-index"], figcaption')) {
        continue;
      }

      if (!this.isLikelyCitationLink(link)) {
        continue;
      }

      // Skip if this link is inside a same-page footnote definition block
      if (this.isInsideSamePageFootnoteDef(link, samePageFootnoteIds, samePageFootnoteBlocks)) {
        continue;
      }

      const rawHref = link.getAttribute('href') || '';
      if (!rawHref.includes('#')) continue;

      const { filePath: targetFile, hash } = resolveRelativeEpubHref(
        normalizedChapterFile,
        rawHref
      );
      if (!targetFile || !hash) continue;

      // Never treat outgoing links from a standalone notes/endnotes file to body chapters as footnote citations
      if (FOOTNOTE_FILE_PATTERN.test(normalizedChapterFile) && targetFile !== normalizedChapterFile) {
        continue;
      }

      const sourceKey = `${targetFile}#${hash}`;
      const targetNode = topology.get(sourceKey);
      if (!targetNode) continue;

      let namespaceId = sourceKeyToNamespaceId.get(sourceKey);
      if (!namespaceId) {
        uniqueCounter++;
        namespaceId = `${chapterIndex}-${uniqueCounter}`;
        sourceKeyToNamespaceId.set(sourceKey, namespaceId);
        referencedSourceKeys.push(sourceKey);

        if (!targetNode.referencedByChapters.includes(chapterIndex)) {
          targetNode.referencedByChapters.push(chapterIndex);
        }

        internalizedFootnotes[namespaceId] = {
          ...targetNode,
          namespaceId
        };
      }

      const prevCount = citationOccurrenceCount.get(namespaceId) || 0;
      citationOccurrenceCount.set(namespaceId, prevCount + 1);
      const refId = prevCount === 0 ? `fnref-${namespaceId}` : `fnref-${namespaceId}-${prevCount + 1}`;

      link.setAttribute('id', refId);
      link.setAttribute('href', `#fn-${namespaceId}`);
      link.setAttribute('epub:type', 'noteref');
      link.setAttribute('class', 'noteref');
      link.setAttribute('data-fn-id', namespaceId);
    }

    // If the chapter had same-page footnote definitions that were internalized,
    // remove the original footnote definition DOM elements from the body so they
    // aren't duplicated as body paragraphs during Markdown conversion
    if (samePageFootnoteIds.size > 0 && Object.keys(internalizedFootnotes).length > 0) {
      for (const origId of samePageFootnoteIds) {
        const defEl = doc.getElementById(origId);
        if (defEl) {
          const blockEl = this.resolveFootnoteStartBlock(defEl);
          // Do not remove if blockEl contains the noteref link itself!
          if (!blockEl.querySelector('a[epub\\:type="noteref"], a.noteref')) {
            const parentContainer = blockEl.parentElement;
            blockEl.remove();
            this.cleanupEmptyFootnoteContainers(parentContainer);
          }
        }
      }
    }

    const updatedBodyInner = doc.body ? doc.body.innerHTML : chapterHtml;
    let updatedFullHtml = chapterHtml;
    if (/<body[^>]*>[\s\S]*<\/body>/i.test(chapterHtml)) {
      updatedFullHtml = chapterHtml.replace(
        /(<body[^>]*>)[\s\S]*(<\/body>)/i,
        (_, openTag, closeTag) => `${openTag}\n${updatedBodyInner}\n${closeTag}`
      );
    } else {
      updatedFullHtml = updatedBodyInner;
    }

    return {
      fileName: normalizedChapterFile,
      chapterIndex,
      html: updatedFullHtml,
      internalizedFootnotes,
      referencedSourceKeys,
      isFootnoteSource: false
    };
  }

  private cleanupEmptyFootnoteContainers(container: Element | null): void {
    let curr = container;
    while (curr && curr.tagName !== 'BODY') {
      const nextParent = curr.parentElement;
      const text = (curr.textContent || '').trim();
      const hasMedia = Boolean(curr.querySelector('img, svg, image'));
      if (text.length === 0 && !hasMedia) {
        curr.remove();
        curr = nextParent;
      } else {
        break;
      }
    }
  }

  private isInsideSamePageFootnoteDef(
    el: Element,
    samePageFootnoteIds: Set<string>,
    samePageFootnoteBlocks: Set<Element>
  ): boolean {
    if (samePageFootnoteIds.size === 0) return false;
    let curr: Element | null = el;
    while (curr && curr.tagName !== 'BODY') {
      if (samePageFootnoteBlocks.has(curr)) {
        return true;
      }
      const id = curr.getAttribute('id') || '';
      const epubType = curr.getAttribute('epub:type') || curr.getAttribute('role') || '';
      const cls = curr.getAttribute('class') || '';
      if (
        (id && samePageFootnoteIds.has(id) && curr !== el) ||
        /\b(footnote|endnote|doc-footnote|doc-endnote|doc-endnotes)\b/i.test(epubType) ||
        /\b(fnlist|footnotes|endnotes)\b/i.test(cls)
      ) {
        return true;
      }
      curr = curr.parentElement;
    }
    return false;
  }

  private identifyFootnoteSourceFiles(
    normalizedFiles: Record<string, string>,
    topology: Map<string, FootnoteNode>,
    extractedElementsByFile: Map<string, Set<Element>>,
    incomingLinkTargets: Map<string, Set<string>>
  ): Set<string> {
    const footnoteSourceFiles = new Set<string>();

    // Group footnotes by source file
    const notesByFile = new Map<string, FootnoteNode[]>();
    for (const node of topology.values()) {
      if (!notesByFile.has(node.sourceFile)) {
        notesByFile.set(node.sourceFile, []);
      }
      notesByFile.get(node.sourceFile)!.push(node);
    }

    for (const [filePath, nodes] of notesByFile.entries()) {
      if (nodes.length === 0) continue;

      // Check how many footnotes in this file are referenced cross-file by OTHER files
      let crossFileReferencedCount = 0;
      for (const node of nodes) {
        const refSources = incomingLinkTargets.get(node.key);
        const hasExternalIncomingLink =
          refSources !== undefined &&
          Array.from(refSources).some((src) => src !== filePath);
        if (hasExternalIncomingLink) {
          crossFileReferencedCount++;
        }
      }

      // CRITICAL SAFETY GUARD:
      // Never drain or overwrite a file with a 0-Offset placeholder if NONE of its
      // footnotes were referenced cross-file by another chapter!
      if (crossFileReferencedCount === 0) {
        continue;
      }

      const html = normalizedFiles[filePath];
      if (!html) continue;

      const doc = parseHtmlDocument(html);
      const cloneBody = doc.body?.cloneNode(true) as HTMLElement | undefined;
      if (!cloneBody) continue;

      // Remove headings and all extracted footnote blocks (including multi-paragraph continuations)
      cloneBody.querySelectorAll('h1, h2, h3, h4, h5, h6, hr').forEach((h) => h.remove());
      for (const node of nodes) {
        const safeId = node.originalId.replace(/"/g, '\\"');
        const el = cloneBody.querySelector(`[id="${safeId}"]`);
        if (el) {
          const block = this.resolveFootnoteStartBlock(el);
          if (!STRUCTURAL_CONTAINER_TAGS.has(block.tagName)) {
            block.remove();
          }
        }
      }

      const consumedCount = extractedElementsByFile.get(filePath)?.size || 0;
      const totalBodyBlocks = doc.body?.querySelectorAll('p, li, aside, dd').length || 1;
      const isDedicatedFileName = FOOTNOTE_FILE_PATTERN.test(filePath);

      const remainingText = (cloneBody.textContent || '').replace(/\s+/g, ' ').trim();
      if (
        (isDedicatedFileName && crossFileReferencedCount >= nodes.length * 0.5) ||
        remainingText.length < 80 ||
        consumedCount / totalBodyBlocks >= 0.7
      ) {
        footnoteSourceFiles.add(filePath);
      }
    }

    return footnoteSourceFiles;
  }

  /**
   * Generates a 0-Offset XHTML placeholder for a drained standalone footnote file.
   * Preserves valid XHTML structure and any root/heading IDs so content.opf (Manifest/Spine)
   * and navigation files (toc.ncx / nav.xhtml) never encounter missing files or dead anchors.
   */
  public createZeroOffsetPlaceholder(originalXhtml: string, fileName?: string): string {
    const doc = parseHtmlDocument(originalXhtml);
    const titleText =
      doc.querySelector('title')?.textContent?.trim() ||
      doc.querySelector('h1, h2, h3')?.textContent?.trim() ||
      'Notes';

    // Preserve any anchor IDs that might be referenced directly by toc.ncx or nav.xhtml
    const topElementWithId = doc.body?.querySelector('h1[id], h2[id], div[id], section[id]');
    const preservedIdAttr = topElementWithId?.getAttribute('id')
      ? ` id="${topElementWithId.getAttribute('id')}"`
      : '';

    const placeholderBody = `<div class="translit-zero-offset-placeholder" data-zero-offset="true"${preservedIdAttr}>
  <h1>${titleText}</h1>
  <p class="zero-offset-notice">本书所有注释均已自动整合内化至对应正文章节。在阅读正文时点击角标编号，即可直接唤起交互式悬浮气泡查阅注释内容。</p>
</div>`;

    if (/<body[^>]*>[\s\S]*<\/body>/i.test(originalXhtml)) {
      return originalXhtml.replace(
        /(<body[^>]*>)[\s\S]*(<\/body>)/i,
        (_, openTag, closeTag) => `${openTag}\n${placeholderBody}\n${closeTag}`
      );
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${titleText}</title>
</head>
<body>
${placeholderBody}
</body>
</html>`;
  }
}
