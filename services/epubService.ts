import JSZip from 'jszip';
import TurndownService from 'turndown';
import { marked } from 'marked';
import katex from 'katex';
import { Chapter, FootnoteNode } from '../types';
import {
  parseHtmlDocument,
  parseXmlDocument,
  serializeXmlNode,
  normalizeEpubFilePath
} from '../utils/domAdapter';
import { FootnoteResolver } from './footnoteResolver';
import { PageClassifier } from './pageClassifier';
import { createFootnoteSlot, validateAndRepairSlots } from './footnotePool';

// Initialize Markdown converters
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
});

// Custom Rule: Convert EPUB3 footnote links to opaque __FN_REF_{id}__ slots
turndownService.addRule('epub-noteref', {
  filter: function (node: any) {
    if (node.nodeName !== 'A') return false;
    const epubType = node.getAttribute('epub:type') || '';
    const cls = node.getAttribute('class') || '';
    return (
      epubType === 'noteref' ||
      cls.split(/\s+/).includes('noteref') ||
      Boolean(node.getAttribute('data-fn-id'))
    );
  },
  replacement: function (content: string, node: any) {
    const dataFnId = node.getAttribute('data-fn-id');
    if (dataFnId) {
      return createFootnoteSlot(dataFnId);
    }
    const href = node.getAttribute('href');
    if (href && href.startsWith('#')) {
      const id = href.substring(1).replace(/^fn-/, '');
      return createFootnoteSlot(id);
    }
    return content;
  }
});

// Custom Rule: Suppress inline footnote aside definitions from body markdown (handled via internalizedFootnotes)
turndownService.addRule('epub-footnote-def', {
  filter: function (node: any) {
    const epubType = node.getAttribute?.('epub:type') || '';
    const cls = node.getAttribute?.('class') || '';
    return (
      epubType === 'footnote' ||
      cls.split(/\s+/).includes('footnote') ||
      cls.split(/\s+/).includes('footnote-def') ||
      cls.split(/\s+/).includes('footnote-popup')
    );
  },
  replacement: function () {
    return '';
  }
});

// Custom Rule: Flatten Headings
turndownService.addRule('flattenHeader', {
  filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  replacement: function (content: string, node: any) {
    const hLevel = Number(node.nodeName.charAt(1));
    const hashes = '#'.repeat(hLevel);
    const cleanContent = content.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    return `\n\n${hashes} ${cleanContent}\n\n`;
  }
});

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
        const rule = /^\$([^$\n]+)\$/;
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

export const EPUB3_POPUP_FOOTNOTE_CSS = `
  /* EPUB 3 Native Popup Footnotes & Graceful Reader Fallback */
  a.noteref, a[epub|type~="noteref"] {
    color: #2e5b60;
    text-decoration: none;
    border-bottom: none;
    font-size: 0.85em;
    line-height: 0;
  }
  a.noteref sup {
    font-size: 0.85em;
    vertical-align: super;
  }
  aside.footnote-popup, aside[epub|type~="footnote"] {
    margin-top: 1.5em;
    padding-top: 0.75em;
    border-top: 1px dashed #A2906A;
    font-size: 0.9em;
    line-height: 1.6;
    color: #4a4a4a;
  }
  aside.footnote-popup p.footnote-content {
    text-indent: 0;
    margin: 0.4em 0;
    text-align: justify;
  }
  a.footnote-backref {
    color: #2e5b60;
    font-weight: bold;
    margin-right: 0.4em;
    text-decoration: none;
    border-bottom: none;
  }
  .translit-zero-offset-placeholder {
    margin: 3em 1em;
    padding: 1.5em;
    border: 1px dashed #A2906A;
    color: #666;
    font-size: 0.9em;
    text-align: center;
  }
`;

const CHINESE_EPUB_CSS = `
  @charset "UTF-8";
  
  /* Basic typography: Prioritize Songti/XIAOBIAOSONG, optimize alignment */
  body {
    font-family: "ZY-XIAOBIAOSONG", "Songti SC", "SimSun", "STSong", "Times New Roman", serif;
    font-size: 1em;
    line-height: 1.8em;
    text-align: justify;
    text-justify: inter-ideograph;
    word-break: break-all;
    padding: 0 3%;
    color: #333;
    margin: 0;
  }

  /* Headings: Teal #2e5b60, non-bold */
  h1, h2, h3, h4, h5, h6 {
    font-family: "fzqys", "ZY-XIAOBIAOSONG", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-weight: normal;
    color: #2e5b60;
    text-align: center;
    margin-top: 1em;
    margin-bottom: 2.2em;
    line-height: 1.6;
  }

  h1 { 
    font-size: 1.3em; 
    border-bottom: 1px dotted #A2906A;
    padding-bottom: 0.6em; 
  }
  
  h2 { font-size: 1.15em; }
  h3 { font-size: 1.1em; }

  /* Paragraphs: Standard indent */
  p {
    text-indent: 2em;
    margin: 0.5em 0;
    line-height: 1.8em;
    text-align: justify;
    text-justify: inter-ideograph;
  }

  /* Blockquote: FangSong/Serif, dark brown (#412938) */
  blockquote {
    font-family: "fs2", "ZY-FANGSONG", "FangSong", "KaiTi", serif;
    font-size: 1em;
    margin: 1.8em 1em;
    padding: 0;
    text-indent: 2em;
    color: #412938;
    border: none;
    background: none;
  }
  
  /* Horizontal Rule: Dotted, bronze (#A2906A) */
  hr {
    border: 0;
    border-top: 1px dotted #A2906A;
    margin: 2em auto;
    width: 60%;
    color: #A2906A;
    background-color: transparent;
    height: 1px;
  }
  
  /* Lists */
  ul, ol {
    margin: 1em 0 1em 2em;
    padding: 0;
  }
  
  li {
    margin-bottom: 0.3em;
  }

  /* Images */
  img {
    display: block;
    margin: 1.5em auto;
    max-width: 100%;
    height: auto;
    border-radius: 2px;
  }
  
  /* Code Blocks */
  pre, code {
    font-family: "Consolas", "Monaco", monospace;
    background-color: #f5f5f5;
    padding: 0.2em;
    border-radius: 3px;
    font-size: 0.9em;
    color: #d63384;
  }
  
  /* Links */
  a {
    color: #2e5b60;
    text-decoration: none;
    border-bottom: 1px dashed #2e5b60;
  }

  ${EPUB3_POPUP_FOOTNOTE_CSS}
`;

const DEFAULT_EPUB_CSS = `
  @charset "UTF-8";
  
  body {
    font-family: "Times New Roman", serif;
    line-height: 1.6;
    padding: 0 3%;
    color: #333;
    margin: 0;
  }

  h1, h2, h3, h4, h5, h6 {
    font-family: Helvetica, Arial, sans-serif;
    font-weight: bold;
    color: #1a1a1a;
    text-align: center;
    margin-top: 1.5em;
    margin-bottom: 1em;
  }
  
  h1 { border-bottom: 1px solid #eee; padding-bottom: 0.5em; }

  p {
    text-indent: 0;
    margin-bottom: 1.2em;
    margin-top: 0;
  }

  blockquote {
    border: none;
    margin: 1em 2em;
    padding: 0;
    color: inherit;
    font-style: italic;
  }

  img {
    display: block;
    margin: 1.5em auto;
    max-width: 100%;
    height: auto;
  }

  code, pre {
    font-family: monospace;
    background: #f4f4f4;
    padding: 0.2em;
  }

  ${EPUB3_POPUP_FOOTNOTE_CSS}
`;

export class EpubService {
  private footnoteResolver = new FootnoteResolver();
  private pageClassifier = new PageClassifier();

  async parseEpub(file: File | Blob | ArrayBuffer | Uint8Array): Promise<{
    chapters: Chapter[];
    images: Record<string, Blob>;
    coverPath?: string;
    opfPath: string;
    opfDir: string;
    cssFiles: string[];
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

    const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

    const manifestItems = Array.from(opfDoc.querySelectorAll('manifest > item')).reduce(
      (acc, item) => {
        acc[item.getAttribute('id')!] = item.getAttribute('href')!;
        return acc;
      },
      {} as Record<string, string>
    );

    // Get list of CSS files
    const cssFiles = Array.from(
      opfDoc.querySelectorAll("manifest > item[media-type='text/css']")
    ).map((item) => opfDir + item.getAttribute('href')!);

    // Find Navigation File (NCX or NAV)
    const tocMap: Record<string, string> = {};
    const spine = opfDoc.querySelector('spine');
    const tocId = spine?.getAttribute('toc');

    // Try NCX (EPUB 2/3)
    if (tocId && manifestItems[tocId]) {
      const ncxFile = loadedZip.file(opfDir + manifestItems[tocId]);
      if (ncxFile) {
        const ncxXml = await ncxFile.async('string');
        const ncxDoc = parseXmlDocument(ncxXml);
        const navPoints = ncxDoc.querySelectorAll('navPoint');
        navPoints.forEach((point) => {
          const label = point.querySelector('navLabel > text')?.textContent?.trim();
          const src = point.querySelector('content')?.getAttribute('src');
          if (label && src) {
            const href = src.split('#')[0];
            if (!tocMap[href]) tocMap[href] = label;
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
              const href = src.split('#')[0];
              if (!tocMap[href]) tocMap[href] = label;
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

      // 3. Fallback
      if (!title) {
        if (rawChapters.length > 0) {
          title = rawChapters[rawChapters.length - 1].title;
        } else {
          title = 'Front Matter';
        }
      }

      const bodyContent = doc.body ? doc.body.innerHTML : effectiveHtml;
      const markdown = turndownService.turndown(bodyContent);
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
        internalizedFootnotes: chapterRes ? chapterRes.internalizedFootnotes : {}
      });
    }

    // Run Stage 1 of Two-Stage Page Classifier (Zero-latency local rules)
    const chapters = this.pageClassifier.classifyChaptersLocal(
      rawChapters,
      footnoteResolution.footnoteSourceFiles
    );

    return {
      chapters,
      images,
      coverPath,
      opfPath,
      opfDir,
      cssFiles
    };
  }

  /**
   * Renders translated Markdown (containing __FN_REF_{id}__ slots) and translated footnotes
   * into standard EPUB 3 HTML with `<a epub:type="noteref">` and `<aside epub:type="footnote">`.
   */
  public async renderChapterEpub3Html(
    markdownContent: string,
    internalizedFootnotes: Record<string, FootnoteNode> = {},
    translatedFootnotes: Record<string, string> = {},
    sourceMarkdownWithSlots?: string
  ): Promise<string> {
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

    // Validate and repair slots if sourceMarkdownWithSlots is available
    if (sourceMarkdownWithSlots) {
      const repaired = validateAndRepairSlots(sourceMarkdownWithSlots, contentToUse);
      contentToUse = repaired.repairedText;
    }

    // Protect __FN_REF_{id}__ tokens from Marked's __bold__ / _italic_ parser by temporarily
    // replacing them with underscore-free placeholder tokens before running marked()
    contentToUse = contentToUse.replace(
      /__FN_REF_([A-Za-z0-9-]+?)__/g,
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

    const replaceSlotWithNoteref = (_match: string, rawId: string) => {
      const id = String(rawId).trim().replace(/^fn-/, '');
      let displayNum = idToDisplayNumber.get(id);
      if (!displayNum) {
        displayNum = orderedIds.length + 1;
        idToDisplayNumber.set(id, displayNum);
        orderedIds.push(id);
      }

      const prevCount = idCitationCount.get(id) || 0;
      idCitationCount.set(id, prevCount + 1);
      const refIdAttr = prevCount === 0 ? `fnref-${id}` : `fnref-${id}-${prevCount + 1}`;

      return `<a id="${refIdAttr}" href="#fn-${id}" epub:type="noteref" class="noteref"><sup>[${displayNum}]</sup></a>`;
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
          internalizedFootnotes[id]?.plainText ||
          '';
        const paragraphs = rawNoteText
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean);

        if (paragraphs.length <= 1) {
          const singleText = paragraphs[0] || '';
          asideBlocks.push(
            `<aside id="fn-${id}" epub:type="footnote" class="footnote-popup">\n  <p class="footnote-content">\n    <a href="#fnref-${id}" class="footnote-backref">[${displayNum}]</a> ${singleText}\n  </p>\n</aside>`
          );
        } else {
          const firstPara = `<p class="footnote-content">\n    <a href="#fnref-${id}" class="footnote-backref">[${displayNum}]</a> ${paragraphs[0]}\n  </p>`;
          const restParas = paragraphs
            .slice(1)
            .map((p) => `<p class="footnote-content">${p}</p>`)
            .join('\n  ');
          asideBlocks.push(
            `<aside id="fn-${id}" epub:type="footnote" class="footnote-popup">\n  ${firstPara}\n  ${restParas}\n</aside>`
          );
        }
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
    excludeFileNames?: string[]
  ): Promise<Blob> {
    const zip = originalZip;
    const isChinese = targetLanguage.toLowerCase().includes('chinese');
    const defaultCss = isChinese ? CHINESE_EPUB_CSS : DEFAULT_EPUB_CSS;
    let cssToUse = cssOverrides || defaultCss;
    if (!cssToUse.includes('.footnote-popup')) {
      cssToUse = `${cssToUse}\n${EPUB3_POPUP_FOOTNOTE_CSS}`;
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
      let opfContent = await opfFile.async('string');

      // Upgrade OPF 2.0 to 3.0
      opfContent = opfContent.replace(
        /(<package\b[^>]*\bversion=["'])2\.0(["'][^>]*>)/i,
        '$13.0$2'
      );

      const titlePattern = /<dc:title>[^<]*<\/dc:title>/i;
      const safeTitle = escapeXml(title).trim();
      const fullBookTitle = `${safeTitle}【TransLit】`;
      if (titlePattern.test(opfContent)) {
        opfContent = opfContent.replace(
          titlePattern,
          `<dc:title>${fullBookTitle}</dc:title>`
        );
      }

      const langPattern = /<dc:language>[^<]*<\/dc:language>/i;
      if (langPattern.test(opfContent)) {
        opfContent = opfContent.replace(
          langPattern,
          `<dc:language>${isChinese ? 'zh' : 'en'}</dc:language>`
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
        const excludeSet = new Set(safeExcludeFileNames);

        const idsToRemove = new Set<string>();
        let ncxHref: string | null = null;
        let navHref: string | null = null;

        for (const item of Array.from(opfDoc.querySelectorAll('*'))) {
          if (item.localName === 'item') {
            const href = item.getAttribute('href');
            const id = item.getAttribute('id');
            const properties = item.getAttribute('properties');

            if (href && id && excludeSet.has(href)) {
              idsToRemove.add(id);
              item.remove();
              const fullPath = opfDir + href;
              if (zip.file(fullPath)) {
                zip.remove(fullPath);
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

        const isExcluded = (link: string | null) => {
          if (!link) return false;
          let baseLink = '';
          try {
            baseLink = decodeURIComponent(link.split('#')[0]);
          } catch {
            baseLink = link.split('#')[0];
          }
          return Array.from(excludeSet).some((ex) => {
            let decodedEx = ex;
            try {
              decodedEx = decodeURIComponent(ex);
            } catch {
              // ignore
            }
            if (decodedEx === baseLink) return true;
            if (decodedEx.endsWith('/' + baseLink)) return true;
            if (baseLink.endsWith('/' + decodedEx)) return true;
            return false;
          });
        };

        let serializedOpf = serializeXmlNode(opfDoc);
        serializedOpf = serializedOpf.replace(
          /(<package\b[^>]*\bversion=["'])2\.0(["'][^>]*>)/i,
          '$13.0$2'
        );
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
                if (contentNode && isExcluded(contentNode.getAttribute('src'))) {
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
                if (isExcluded(el.getAttribute('href'))) {
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

    // 2. Overwrite CSS files
    if (cssFiles && cssFiles.length > 0) {
      for (const cssPath of cssFiles) {
        zip.file(cssPath, cssToUse);
      }
    } else {
      const commonCssPaths = [
        'css/styles.css',
        'OEBPS/css/styles.css',
        'stylesheet.css',
        'styles.css'
      ];
      for (const path of commonCssPaths) {
        if (zip.file(path) || zip.file(opfDir + path)) {
          zip.file(zip.file(path) ? path : opfDir + path, cssToUse);
        }
      }
    }

    // 3. Replace body of each XHTML chapter (or write 0-Offset placeholder for drained footnote source files)
    for (const ch of chapters) {
      const fullPath = opfDir + ch.fileName;
      const originalXhtmlFile = zip.file(fullPath);
      if (!originalXhtmlFile) continue;

      const originalXhtml = await originalXhtmlFile.async('string');

      // 3a. Standalone footnote source file -> write 0-Offset XHTML placeholder
      if (
        ch.isFootnoteSource ||
        ch.classification?.disposition === 'system_footnote_source'
      ) {
        const placeholderXhtml = this.ensureEpub3XhtmlNamespace(
          this.footnoteResolver.createZeroOffsetPlaceholder(originalXhtml, ch.fileName)
        );
        zip.file(fullPath, placeholderXhtml);
        continue;
      }

      if (!ch.translatedMarkdown && !ch.proofreadMarkdown) continue;

      const contentToUse =
        ch.proofreadMarkdown || ch.translatedMarkdown || ch.markdown || '';

      let htmlBody = await this.renderChapterEpub3Html(
        contentToUse,
        ch.internalizedFootnotes || {},
        ch.translatedFootnotes || {},
        ch.slottedMarkdown || ch.markdown
      );

      // Preserve original relative image links
      htmlBody = htmlBody.replace(/src="([^"]+)"/g, (match, srcPath) => {
        if (srcPath.startsWith('http') || srcPath.startsWith('//')) return match;
        return `src="${srcPath}"`;
      });

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

      zip.file(fullPath, newXhtml);
    }

    // Ensure mimetype is first file and STORE
    if (zip.file('mimetype')) {
      const mimeBlob = await zip.file('mimetype')!.async('string');
      zip.remove('mimetype');
      zip.file('mimetype', mimeBlob, { compression: 'STORE' });
    }

    return await zip.generateAsync({ type: 'blob' });
  }
}
