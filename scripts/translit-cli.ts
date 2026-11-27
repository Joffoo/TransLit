import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {
  AiService,
  countReplacementChars
} from '../services/geminiService';
import {
  DomMutationEngine,
  parseEpubCssProfiles,
  resolveLeafHeadingAnalysis
} from '../services/domMutationEngine';
import { computeStructuralTreeDiff } from '../services/domMutationEngine';
import { EpubService } from '../services/epubService';
import { FootnotePool, stripLeakedFootnoteDefinitions } from '../services/footnotePool';
import {
  StyleClassifier,
  buildBookStyleCensus,
  deriveLocalStyleRoles
} from '../services/styleClassifier';
import { RECOMMENDED_TRANSLATION_PROMPT, TWO_STEP_BASE_PROMPT } from '../prompts';
import {
  AppConfig,
  BilingualMode,
  BookStyleRoleMap,
  Chapter,
  TokenUsage,
  TokenUsageStats
} from '../types';
import {
  normalizeEpubFilePath,
  parseHtmlDocument,
  parseXmlDocument,
  resolveRelativeEpubHref,
  serializeXmlNode
} from '../utils/domAdapter';
import { isChapterNonTranslatable, buildPosteriorTextForChapter } from '../utils/chapterUtils';

const FORBIDDEN_HARDCODED_HEX = [
  '#2e5b60',
  '#412938',
  '#a2906a',
  '#2c2c2c',
  '#4a4a4a',
  '#555555',
  '#1a1a1a',
  '#f5f5f3',
  '#f6f6f4',
  '#d4d4d4'
];

const SOURCE_LANG_ZH_MAP: Record<string, string> = {
  English: '英语',
  Japanese: '日语',
  French: '法语',
  German: '德语',
  Spanish: '西班牙语',
  Russian: '俄语',
  Korean: '韩语',
  Italian: '意大利语',
  Portuguese: '葡萄牙语',
  Latin: '拉丁语',
  Greek: '希腊语'
};

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '-o') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags.o = next;
        i++;
      } else {
        flags.o = true;
      }
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf('=');
      if (eqIdx >= 0) {
        flags[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        const booleanOnlyFlags = new Set([
          'styles',
          'json',
          'local',
          'no-notes',
          'no-images',
          'no-roles',
          'no-style-ai',
          'strict',
          'proofread',
          'all-passthrough'
        ]);
        if (!booleanOnlyFlags.has(body) && next !== undefined && !next.startsWith('-')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = flags[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

function printUsage(): void {
  console.log(`TransLit CLI — Reusable verification, slicing, classification & rendering tool

Usage:
  npm run cli -- <command> [options]

Commands:
  sample <input.epub> -o <output.epub> [--chapters <spec>] [--max-blocks <N>] [--no-notes] [--no-images]
      Slice selected chapters (1-based spine indices, ranges "3-5", or substrings),
      optionally trim each chapter to N blocks (--max-blocks) & prune unreferenced notes,
      auto-retain referenced Notes & CSS (and images unless --no-images), and write
      a compact valid EPUB sample.

  inspect <book.epub> [--styles] [--chapter <idxOrPattern>] [--json]
      Inspect parsed chapters, footnotes, CSS style census (--styles), or DOM leaf
      blocks and resolved semantic roles (--chapter).

  classify-styles <book.epub> [--local] [--save-roles <file.json>] [--json]
      Classify book CSS classes into Pure Heti semantic roles locally (--local or no API key)
      or via 1-shot AI using TRANSLIT_API_KEY / TRANSLIT_BASE_URL / TRANSLIT_MODEL.

  render <book.epub> -o <out.epub> [--roles <roles.json> | --no-roles] [--chapter <idxOrPattern>]
         [--translation <file.md|file.json>] [--all-passthrough]
         [--bilingual source_first|target_first] [--html-preview <out.html>] [--strict] [--json]
      Run DomMutationEngine + Pure Heti CSS + EpubService.generateEpub, write an EPUB
      (and optional self-contained HTML preview), and print a strict quality audit report.

  translate <book.epub> -o <out.epub> [--chapters <spec>] [--bilingual source_first|target_first]
            [--proofread] [--no-style-ai] [--html-preview <out.html>] [--strict] [--json]
      Run live translation via TRANSLIT_API_KEY / TRANSLIT_BASE_URL / TRANSLIT_MODEL,
      apply Pure Heti export, and print token usage + quality audit report.
`);
}

export function readLocalEpubAsFile(filePath: string): File {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`EPUB file not found: ${absPath}`);
  }
  const buf = fs.readFileSync(absPath);
  return {
    name: path.basename(absPath),
    size: buf.byteLength,
    type: 'application/epub+zip',
    lastModified: Date.now(),
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  } as unknown as File;
}

async function fileToUint8Array(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function findMatchingChapter(chapters: Chapter[], pattern: string | undefined): Chapter | undefined {
  if (!pattern) return undefined;
  const trimmed = pattern.trim();
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed);
    return chapters.find((c) => c.index === idx);
  }
  const needle = trimmed.toLowerCase();
  return chapters.find(
    (c) =>
      c.fileName.toLowerCase().includes(needle) ||
      (c.title || '').toLowerCase().includes(needle)
  );
}

function buildCliAiConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    apiKey: process.env.TRANSLIT_API_KEY || '',
    baseUrl: process.env.TRANSLIT_BASE_URL || 'https://api.openai.com/v1',
    modelName: process.env.TRANSLIT_MODEL || 'gpt-4o-mini',
    sourceLanguage: 'English',
    additionalContext: '',
    enableProofreading: false,
    useRecommendedPrompts: true,
    smartSkip: true,
    enableGlossary: true,
    ...overrides
  };
}

function buildEffectiveSystemInstruction(cfg: AppConfig): string {
  const rawSource = cfg.sourceLanguage.trim() || 'English';
  const localizedSource = SOURCE_LANG_ZH_MAP[rawSource] || rawSource;
  let basePrompt = '';
  if (cfg.enableProofreading) {
    basePrompt = TWO_STEP_BASE_PROMPT.replace(/\[SOURCE_LANG\]/g, localizedSource);
  } else if (cfg.useRecommendedPrompts) {
    basePrompt = RECOMMENDED_TRANSLATION_PROMPT.replace(/\[SOURCE_LANG\]/g, localizedSource);
  } else {
    basePrompt = `你是一位专业的文学翻译专家。请把${localizedSource}内容重写为中文，确保译文生动、地道，并保持原有的段落结构与占位符标签，严禁生成任何标题符号（#）或引用块符号（>）。`;
  }
  return cfg.additionalContext
    ? `${basePrompt}\n\n【书籍元信息与特定翻译要求】\n${cfg.additionalContext}`
    : basePrompt;
}

async function extractBookTitleFromOpf(zipBytes: Uint8Array, opfPath: string, fallbackName: string): Promise<string> {
  try {
    const zip = await new JSZip().loadAsync(zipBytes);
    const opfXml = await zip.file(opfPath)?.async('string');
    if (opfXml) {
      const m = opfXml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
      const text = m?.[1]?.replace(/<[^>]+>/g, '').trim();
      if (text) return text;
    }
  } catch {
    // fallback
  }
  return fallbackName.replace(/\.epub$/i, '');
}

interface SpineMeta {
  spineIndex1Based: number;
  id: string;
  href: string;
  normHref: string;
  mediaType: string;
  titleHint: string;
  textLength: number;
}

function matchesChapterSpec(item: SpineMeta, tokens: string[]): boolean {
  for (const tok of tokens) {
    const rangeMatch = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (item.spineIndex1Based >= start && item.spineIndex1Based <= end) return true;
      continue;
    }
    if (/^\d+$/.test(tok)) {
      if (item.spineIndex1Based === Number(tok)) return true;
      continue;
    }
    const lower = tok.toLowerCase();
    if (
      item.href.toLowerCase().includes(lower) ||
      item.titleHint.toLowerCase().includes(lower)
    ) {
      return true;
    }
  }
  return false;
}

async function cmdSample(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const inputPath = positionals[0];
  const outputPath = getStringFlag(flags, 'o', 'out');
  if (!inputPath || !outputPath) {
    throw new Error('Usage: sample <input.epub> -o <output.epub> [--chapters <spec>] [--no-notes] [--no-images]');
  }

  const inputFile = readLocalEpubAsFile(inputPath);
  const inputBytes = await fileToUint8Array(inputFile);
  const inZip = await new JSZip().loadAsync(inputBytes);

  const containerXml = await inZip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) throw new Error('Invalid EPUB: missing META-INF/container.xml');
  const containerDoc = parseXmlDocument(containerXml);
  const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('Invalid EPUB: container.xml missing rootfile full-path');
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
  const opfXml = await inZip.file(opfPath)?.async('string');
  if (!opfXml) throw new Error(`Invalid EPUB: OPF not found at ${opfPath}`);
  const opfDoc = parseXmlDocument(opfXml);

  interface ManifestEntry {
    el: Element;
    id: string;
    href: string;
    normHref: string;
    mediaType: string;
    properties: string;
  }

  const manifestById = new Map<string, ManifestEntry>();
  const manifestByNormLower = new Map<string, ManifestEntry>();
  for (const item of Array.from(opfDoc.querySelectorAll('*'))) {
    if (item.localName !== 'item') continue;
    const id = item.getAttribute('id') || '';
    const href = item.getAttribute('href') || '';
    const mediaType = item.getAttribute('media-type') || '';
    const properties = item.getAttribute('properties') || '';
    if (!id || !href) continue;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      // keep raw
    }
    const normHref = normalizeEpubFilePath(decoded);
    const entry: ManifestEntry = { el: item, id, href, normHref, mediaType, properties };
    manifestById.set(id, entry);
    manifestByNormLower.set(normHref.toLowerCase(), entry);
  }

  const spineEl = Array.from(opfDoc.querySelectorAll('*')).find((el) => el.localName === 'spine');
  const tocId = spineEl?.getAttribute('toc') || null;
  const ncxEntry = tocId ? manifestById.get(tocId) : undefined;
  const navEntry = Array.from(manifestById.values()).find((e) =>
    e.properties.split(/\s+/).includes('nav')
  );

  // Extract NCX labels for better matching on title hints
  const tocTitleByNormLower = new Map<string, string>();
  if (ncxEntry) {
    const ncxText = await inZip.file(opfDir + ncxEntry.href)?.async('string');
    if (ncxText) {
      const ncxDoc = parseXmlDocument(ncxText);
      for (const el of Array.from(ncxDoc.querySelectorAll('*'))) {
        if (el.localName === 'navPoint') {
          const label = Array.from(el.querySelectorAll('*'))
            .find((c) => c.localName === 'text')
            ?.textContent?.trim();
          const src = Array.from(el.children)
            .find((c) => c.localName === 'content')
            ?.getAttribute('src');
          if (label && src) {
            const rel = resolveRelativeEpubHref(ncxEntry.href, src.split('#')[0]).filePath;
            const norm = normalizeEpubFilePath(rel).toLowerCase();
            if (norm && !tocTitleByNormLower.has(norm)) {
              tocTitleByNormLower.set(norm, label);
            }
          }
        }
      }
    }
  }

  const spineItemrefs = Array.from(opfDoc.querySelectorAll('*')).filter(
    (el) => el.localName === 'itemref'
  );
  const spineMetas: SpineMeta[] = [];
  for (let i = 0; i < spineItemrefs.length; i++) {
    const idref = spineItemrefs[i].getAttribute('idref') || '';
    const entry = manifestById.get(idref);
    if (!entry) continue;
    const xhtml = await inZip.file(opfDir + entry.href)?.async('string');
    let headingHint = tocTitleByNormLower.get(entry.normHref.toLowerCase()) || '';
    let textLen = 0;
    if (xhtml) {
      const doc = parseHtmlDocument(xhtml);
      textLen = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim().length;
      const headEl = doc.querySelector('h1, h2, h3, .chap-title, .chapter-title, .fm-title, .bm-title, .cnab, .cnab1, title');
      const headText = headEl?.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (headText) {
        headingHint = headingHint ? `${headingHint} | ${headText}` : headText;
      }
    }
    spineMetas.push({
      spineIndex1Based: i + 1,
      id: entry.id,
      href: entry.href,
      normHref: entry.normHref,
      mediaType: entry.mediaType,
      titleHint: headingHint,
      textLength: textLen
    });
  }

  const chaptersSpec = getStringFlag(flags, 'chapters');
  const keepNotes = !flags['no-notes'];
  const dropImages = Boolean(flags['no-images']);

  const selectedIds = new Set<string>();
  if (chaptersSpec) {
    const tokens = chaptersSpec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const meta of spineMetas) {
      if (matchesChapterSpec(meta, tokens)) {
        selectedIds.add(meta.id);
      }
    }
  } else {
    for (const meta of spineMetas) {
      if (selectedIds.size >= 4) break;
      if (meta.textLength >= 200 && !/toc|nav|cover/i.test(meta.href)) {
        selectedIds.add(meta.id);
      }
    }
  }

  if (selectedIds.size === 0) {
    throw new Error(`No spine chapters matched spec: ${chaptersSpec || '(default)'}`);
  }

  const keptSpineIds = new Set<string>(selectedIds);
  const keptAssetNormLowers = new Set<string>();

  // Collect cross-file footnote targets & assets referenced by selected chapters
  const selectedHtmlEntries: SpineMeta[] = spineMetas.filter((m) => selectedIds.has(m.id));
  const noteFilePattern = /(?:^|\/|_|-)(?:notes?|endnotes?|footnotes?)(?:\d*)?\.(?:xhtml|html|htm)$/i;
  const tocHrefPattern = /(?:^|\/|_|-)(?:toc|contents?|nav)\.(?:xhtml|html|htm)$/i;

  const scanChapterDeps = async (meta: SpineMeta, allowHtmlNoteTargets: boolean) => {
    const xhtml = await inZip.file(opfDir + meta.href)?.async('string');
    if (!xhtml) return;
    const doc = parseHtmlDocument(xhtml);
    for (const el of Array.from(doc.querySelectorAll('a[href], link[href], img[src], image[*|href], image[href]'))) {
      const rawRef =
        el.getAttribute('href') ||
        el.getAttribute('src') ||
        el.getAttribute('xlink:href') ||
        '';
      if (!rawRef || /^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(rawRef.trim())) continue;
      const resolved = resolveRelativeEpubHref(meta.href, rawRef);
      const targetNormLower = normalizeEpubFilePath(resolved.filePath).toLowerCase();
      const targetEntry = manifestByNormLower.get(targetNormLower);
      if (!targetEntry) continue;

      if (/xhtml|html/i.test(targetEntry.mediaType)) {
        if (!allowHtmlNoteTargets || !keepNotes) continue;
        // Skip links from heading anchors back to Contents/TOC files unless explicitly selected
        if (tocHrefPattern.test(targetEntry.href) || el.closest('h1, h2, h3, h4, h5, h6')) continue;
        const isNoterefLike =
          Boolean(resolved.hash) &&
          (noteFilePattern.test(targetEntry.href) ||
            /fn|note|endnote/i.test(resolved.hash) ||
            el.getAttribute('epub:type') === 'noteref' ||
            el.getAttribute('role') === 'doc-noteref');
        if (!isNoterefLike) continue;

        const isInSpine = spineMetas.some((m) => m.id === targetEntry.id);
        if (isInSpine) {
          keptSpineIds.add(targetEntry.id);
        } else {
          keptAssetNormLowers.add(targetNormLower);
        }
      } else if (!dropImages || !targetEntry.mediaType.startsWith('image/')) {
        keptAssetNormLowers.add(targetNormLower);
      }
    }
  };

  for (const meta of selectedHtmlEntries) {
    await scanChapterDeps(meta, true);
  }

  if (keepNotes) {
    for (const meta of spineMetas) {
      if (noteFilePattern.test(meta.href)) {
        keptSpineIds.add(meta.id);
      }
    }
  }

  // Scan assets (CSS/images only — never back-links) in any newly added note chapters
  for (const meta of spineMetas) {
    if (keptSpineIds.has(meta.id) && !selectedIds.has(meta.id)) {
      await scanChapterDeps(meta, false);
    }
  }

  // Always retain CSS stylesheets, fonts, NCX, NAV manifest items
  const keptManifestIds = new Set<string>(keptSpineIds);
  for (const entry of manifestById.values()) {
    const isCss = entry.mediaType === 'text/css' || /\.css$/i.test(entry.href);
    const isFont = /font|opentype|truetype|woff/i.test(entry.mediaType) || /\.(?:ttf|otf|woff2?)$/i.test(entry.href);
    const isNavOrNcx = entry === ncxEntry || entry === navEntry;
    const isKeptAsset = keptAssetNormLowers.has(entry.normHref.toLowerCase());
    const isImage = entry.mediaType.startsWith('image/') || /\.(?:png|jpe?g|gif|svg|webp)$/i.test(entry.href);

    if (dropImages && isImage) {
      continue;
    }
    if (isCss || isFont || isNavOrNcx || isKeptAsset) {
      keptManifestIds.add(entry.id);
    }
  }

  // Prune OPF manifest & spine
  for (const entry of manifestById.values()) {
    if (!keptManifestIds.has(entry.id)) {
      entry.el.remove();
    }
  }
  for (const ref of spineItemrefs) {
    const idref = ref.getAttribute('idref') || '';
    if (!keptSpineIds.has(idref)) {
      ref.remove();
    }
  }

  const keptXhtmlNormLowers = new Set<string>();
  for (const id of keptSpineIds) {
    const entry = manifestById.get(id);
    if (entry) keptXhtmlNormLowers.add(entry.normHref.toLowerCase());
  }

  // Optional --max-blocks <N> & asset referential integrity (strip orphan images when --no-images)
  const maxBlocksRaw = getStringFlag(flags, 'max-blocks');
  const maxBlocks = maxBlocksRaw ? Number(maxBlocksRaw) : 0;
  if (maxBlocksRaw && (!Number.isFinite(maxBlocks) || maxBlocks <= 0)) {
    throw new Error(`Invalid --max-blocks value: "${maxBlocksRaw}". Expected a positive integer.`);
  }

  const keptManifestNormLowers = new Set<string>();
  for (const id of keptManifestIds) {
    const entry = manifestById.get(id);
    if (entry) keptManifestNormLowers.add(entry.normHref.toLowerCase());
  }

  const replaceBodyInXhtml = (rawXhtml: string, newBodyInnerHtml: string): string => {
    const safeBody = newBodyInnerHtml
      .replace(/<br\b([^>]*)>/gi, (m, a) => (a.trim().endsWith('/') ? m : `<br${a}/>`))
      .replace(/<hr\b([^>]*)>/gi, (m, a) => (a.trim().endsWith('/') ? m : `<hr${a}/>`))
      .replace(/<img\b([^>]*)>/gi, (m, a) => (a.trim().endsWith('/') ? m : `<img${a}/>`));
    if (/<body\b[^>]*>[\s\S]*<\/body>/i.test(rawXhtml)) {
      return rawXhtml.replace(/(<body\b[^>]*>)[\s\S]*(<\/body>)/i, `$1\n${safeBody}\n$2`);
    }
    return safeBody;
  };

  const pruneEmptyAncestors = (startNode: Element | null, stopAt: Element) => {
    let curr = startNode;
    while (curr && curr !== stopAt) {
      const parent = curr.parentElement;
      const tag = (curr.tagName || '').toUpperCase();
      const isPrunableContainer =
        tag === 'DIV' ||
        tag === 'SECTION' ||
        tag === 'BLOCKQUOTE' ||
        tag === 'UL' ||
        tag === 'OL' ||
        tag === 'FIGURE';
      const txt = (curr.textContent || '').replace(/[\s\u00a0]+/g, '').trim();
      const hasMedia = Boolean(curr.querySelector('img, svg, image'));
      if (isPrunableContainer && txt.length === 0 && !hasMedia) {
        curr.remove();
        curr = parent;
      } else {
        break;
      }
    }
  };

  const stripUnkeptImages = (entry: ManifestEntry, body: Element): boolean => {
    let modified = false;
    for (const imgEl of Array.from(body.querySelectorAll('img, image'))) {
      const rawSrc =
        imgEl.getAttribute('src') ||
        imgEl.getAttribute('href') ||
        imgEl.getAttribute('xlink:href') ||
        '';
      let remove = dropImages;
      if (!remove && rawSrc && !/^(?:https?:|data:)/i.test(rawSrc.trim())) {
        const resolved = resolveRelativeEpubHref(entry.href, rawSrc);
        const normLower = normalizeEpubFilePath(resolved.filePath).toLowerCase();
        if (normLower && !keptManifestNormLowers.has(normLower)) {
          remove = true;
        }
      }
      if (remove) {
        const parent = imgEl.parentElement;
        imgEl.remove();
        pruneEmptyAncestors(parent, body);
        modified = true;
      }
    }
    return modified;
  };

  const trimmedHtmlById = new Map<string, string>();
  if (maxBlocks > 0) {
    const sampleDomEngine = new DomMutationEngine();
    const referencedNoteIdsByFile = new Map<string, Set<string>>();

    for (const id of keptSpineIds) {
      const entry = manifestById.get(id);
      if (!entry || !selectedIds.has(entry.id) || noteFilePattern.test(entry.href)) continue;

      const rawXhtml = await inZip.file(opfDir + entry.href)?.async('string');
      if (!rawXhtml) continue;
      const doc = parseHtmlDocument(rawXhtml);
      if (!doc.body) continue;

      const leafEls = sampleDomEngine.collectTranslatableLeafElements(doc.body);
      const lastKept = maxBlocks <= leafEls.length ? leafEls[maxBlocks - 1] : undefined;
      if (lastKept && leafEls.length > maxBlocks) {
        // Cut cleanly at lastKept in document order, eliminating trailing <figure>, <img>, <section>, etc.
        for (const node of Array.from(doc.body.querySelectorAll('*')).reverse()) {
          if (
            node !== lastKept &&
            !node.contains(lastKept) &&
            !lastKept.contains(node) &&
            (lastKept.compareDocumentPosition(node) & 4) !== 0
          ) {
            const parent = node.parentElement;
            node.remove();
            pruneEmptyAncestors(parent, doc.body);
          }
        }
      }

      stripUnkeptImages(entry, doc.body);

      // Collect cross-file #hash note references remaining in the trimmed body
      for (const a of Array.from(doc.body.querySelectorAll('a[href]'))) {
        const rawHref = a.getAttribute('href') || '';
        if (!rawHref || /^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(rawHref.trim())) continue;
        const resolved = resolveRelativeEpubHref(entry.href, rawHref);
        if (!resolved.hash) continue;
        const targetNormLower = normalizeEpubFilePath(resolved.filePath).toLowerCase();
        if (!referencedNoteIdsByFile.has(targetNormLower)) {
          referencedNoteIdsByFile.set(targetNormLower, new Set<string>());
        }
        referencedNoteIdsByFile.get(targetNormLower)!.add(resolved.hash);
      }

      trimmedHtmlById.set(entry.id, replaceBodyInXhtml(rawXhtml, doc.body.innerHTML));
    }

    for (const id of keptSpineIds) {
      const entry = manifestById.get(id);
      if (!entry || !noteFilePattern.test(entry.href)) continue;

      const keptIds = referencedNoteIdsByFile.get(entry.normHref.toLowerCase());
      if (!keptIds || keptIds.size === 0) continue;

      const rawXhtml = await inZip.file(opfDir + entry.href)?.async('string');
      if (!rawXhtml) continue;
      const doc = parseHtmlDocument(rawXhtml);
      if (!doc.body) continue;

      const elementMatchesKeptId = (el: Element): boolean => {
        const ownId = el.getAttribute('id') || el.getAttribute('name') || '';
        if (ownId && keptIds.has(ownId)) return true;
        return Array.from(el.querySelectorAll('[id], a[name]')).some((child) => {
          const cid = child.getAttribute('id') || child.getAttribute('name') || '';
          return Boolean(cid && keptIds.has(cid));
        });
      };

      const listItems = Array.from(doc.body.querySelectorAll('li'));
      if (listItems.length > 0) {
        for (const li of listItems) {
          if (!elementMatchesKeptId(li)) {
            li.remove();
          }
        }
        // Remove empty lists and orphan chapter subheadings before/inside emptied sections
        for (const listEl of Array.from(doc.body.querySelectorAll('ol, ul'))) {
          if (!listEl.querySelector('li')) {
            const prev = listEl.previousElementSibling;
            const parentSection = listEl.closest('section');
            listEl.remove();
            if (prev && /^H[2-6]$|^P$/.test((prev.tagName || '').toUpperCase())) {
              const prevHeadingText = (prev.textContent || '').trim();
              if (prevHeadingText.length < 120) {
                prev.remove();
              }
            }
            if (parentSection && parentSection !== doc.body) {
              pruneEmptyAncestors(parentSection, doc.body);
            }
          }
        }
      } else {
        const fallbackNotes = Array.from(doc.body.querySelectorAll('p, div, aside')).filter(
          (el) => !el.querySelector('p, div, aside') && (el.getAttribute('id') || el.querySelector('[id], a[name]'))
        );
        for (const noteEl of fallbackNotes) {
          if (!elementMatchesKeptId(noteEl)) {
            const parent = noteEl.parentElement;
            noteEl.remove();
            pruneEmptyAncestors(parent, doc.body);
          }
        }
      }

      stripUnkeptImages(entry, doc.body);
      trimmedHtmlById.set(entry.id, replaceBodyInXhtml(rawXhtml, doc.body.innerHTML));
    }
  }

  // Referential integrity sweep across all kept XHTML chapters when --no-images or trimmed assets are omitted
  if (dropImages) {
    for (const id of keptSpineIds) {
      if (trimmedHtmlById.has(id)) continue;
      const entry = manifestById.get(id);
      if (!entry) continue;
      const rawXhtml = await inZip.file(opfDir + entry.href)?.async('string');
      if (!rawXhtml) continue;
      const doc = parseHtmlDocument(rawXhtml);
      if (!doc.body) continue;
      if (stripUnkeptImages(entry, doc.body)) {
        trimmedHtmlById.set(entry.id, replaceBodyInXhtml(rawXhtml, doc.body.innerHTML));
      }
    }
  }

  // Build sliced ZIP archive
  const outZip = new JSZip();
  const mimeContent = (await inZip.file('mimetype')?.async('string')) || 'application/epub+zip';
  outZip.file('mimetype', mimeContent, { compression: 'STORE' });
  outZip.file('META-INF/container.xml', containerXml);
  outZip.file(opfPath, serializeXmlNode(opfDoc));

  const copyZipEntry = async (entry: ManifestEntry) => {
    const fullPath = opfDir + entry.href;
    const zipEntry = inZip.file(fullPath);
    if (!zipEntry) return;

    if (trimmedHtmlById.has(entry.id)) {
      outZip.file(fullPath, trimmedHtmlById.get(entry.id)!);
      return;
    }

    if (ncxEntry && entry.id === ncxEntry.id) {
      const ncxXml = await zipEntry.async('string');
      const ncxDoc = parseXmlDocument(ncxXml);
      for (const el of Array.from(ncxDoc.querySelectorAll('*')).reverse()) {
        if (el.localName === 'navPoint') {
          const contentEl = Array.from(el.children).find((c) => c.localName === 'content');
          const src = contentEl?.getAttribute('src');
          if (src) {
            const rel = resolveRelativeEpubHref(ncxEntry.href, src.split('#')[0]).filePath;
            const normLower = normalizeEpubFilePath(rel).toLowerCase();
            if (!keptXhtmlNormLowers.has(normLower)) {
              const childPoints = Array.from(el.children).filter((c) => c.localName === 'navPoint');
              for (const child of childPoints) {
                if (el.parentElement) el.parentElement.insertBefore(child, el);
              }
              el.remove();
            }
          }
        }
      }
      outZip.file(fullPath, serializeXmlNode(ncxDoc));
      return;
    }

    if (navEntry && entry.id === navEntry.id && !keptSpineIds.has(entry.id)) {
      const navHtml = await zipEntry.async('string');
      const navDoc = parseXmlDocument(navHtml);
      for (const el of Array.from(navDoc.querySelectorAll('*')).reverse()) {
        if (el.localName === 'a') {
          const href = el.getAttribute('href');
          if (href && !href.startsWith('#')) {
            const rel = resolveRelativeEpubHref(navEntry.href, href.split('#')[0]).filePath;
            const normLower = normalizeEpubFilePath(rel).toLowerCase();
            if (!keptXhtmlNormLowers.has(normLower)) {
              let li: Element | null = el;
              while (li && li.localName !== 'li') li = li.parentElement;
              if (li) {
                for (const ol of Array.from(li.children).filter((c) => c.localName === 'ol')) {
                  for (const childLi of Array.from(ol.children).filter((c) => c.localName === 'li')) {
                    if (li.parentElement) li.parentElement.insertBefore(childLi, li);
                  }
                }
                li.remove();
              }
            }
          }
        }
      }
      outZip.file(fullPath, serializeXmlNode(navDoc));
      return;
    }

    const bytes = await zipEntry.async('uint8array');
    outZip.file(fullPath, bytes);
  };

  for (const id of keptManifestIds) {
    const entry = manifestById.get(id);
    if (entry) {
      await copyZipEntry(entry);
    }
  }

  // Ensure mimetype first
  const rawFiles = (outZip as any).files;
  if (rawFiles && rawFiles.mimetype) {
    const reordered: Record<string, any> = { mimetype: rawFiles.mimetype };
    for (const [k, v] of Object.entries(rawFiles)) {
      if (k !== 'mimetype') reordered[k] = v;
    }
    (outZip as any).files = reordered;
  }

  const outAbs = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const outBuf = await outZip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' });
  fs.writeFileSync(outAbs, outBuf);

  const keptList = spineMetas
    .filter((m) => keptSpineIds.has(m.id))
    .map((m) => `[${m.spineIndex1Based}] ${m.href}${m.titleHint ? ` (${m.titleHint})` : ''}`);

  console.log(`Sample EPUB created: ${outAbs} (${(outBuf.byteLength / 1024).toFixed(1)} KB)`);
  console.log(`Kept chapters (${keptList.length}):`);
  for (const line of keptList) {
    console.log(`  - ${line}`);
  }
}

async function cmdInspect(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const inputPath = positionals[0];
  if (!inputPath) {
    throw new Error('Usage: inspect <book.epub> [--styles] [--chapter <idxOrPattern>] [--json]');
  }

  const file = readLocalEpubAsFile(inputPath);
  const bytes = await fileToUint8Array(file);
  const epubService = new EpubService();
  const parsed = await epubService.parseEpub(bytes);
  const bodyHtmls = parsed.chapters
    .filter((c) => !c.isFootnoteSource && Boolean(c.content))
    .map((c) => c.content);

  const candidates = buildBookStyleCensus(bodyHtmls, parsed.cssContents);
  const localRoles = deriveLocalStyleRoles(candidates);

  const chapterFlag = getStringFlag(flags, 'chapter');
  const inspectChapter = chapterFlag ? findMatchingChapter(parsed.chapters, chapterFlag) : undefined;
  if (chapterFlag && !inspectChapter) {
    throw new Error(`No chapter matched "${chapterFlag}"`);
  }

  let blockDetails: Array<{
    index: number;
    tag: string;
    className: string;
    role: string;
    headingLevel: number;
    isHeadingLike: boolean;
    text: string;
  }> | undefined;

  if (inspectChapter) {
    const engine = new DomMutationEngine();
    const cssProfiles = parseEpubCssProfiles(parsed.cssContents);
    const extracted = engine.extractTranslatablePayload(
      inspectChapter.content,
      inspectChapter.internalizedFootnotes,
      cssProfiles,
      localRoles
    );
    const mutated = engine.mutateDomInPlace(inspectChapter.content, extracted.payloadText, {
      internalizedFootnotes: inspectChapter.internalizedFootnotes,
      cssProfiles,
      bookStyleRoles: localRoles,
      applyChineseTypography: true
    });
    const mutDoc = parseHtmlDocument(mutated);
    const leafEls = mutDoc.body ? engine.collectTranslatableLeafElements(mutDoc.body) : [];
    const analysis = resolveLeafHeadingAnalysis(
      parseHtmlDocument(inspectChapter.content).body
        ? engine.collectTranslatableLeafElements(parseHtmlDocument(inspectChapter.content).body!)
        : [],
      cssProfiles,
      localRoles
    );
    const headingLvls = Array.from(analysis.headingLevels.values());

    blockDetails = extracted.blocks.map((b, idx) => {
      const mutEl = leafEls[idx];
      const roleAttr = mutEl?.getAttribute('data-translit-role') || '';
      const mods: string[] = [];
      if (mutEl?.getAttribute('data-translit-align')) mods.push(`align=${mutEl.getAttribute('data-translit-align')}`);
      if (mutEl?.getAttribute('data-translit-weight')) mods.push(`weight=${mutEl.getAttribute('data-translit-weight')}`);
      if (mutEl?.getAttribute('data-translit-quote-pos')) mods.push(`pos=${mutEl.getAttribute('data-translit-quote-pos')}`);
      const roleDisplay = mods.length > 0 ? `${roleAttr}(${mods.join(',')})` : roleAttr;
      return {
        index: b.index,
        tag: b.tagName,
        className: b.className,
        role: roleDisplay || '-',
        headingLevel: headingLvls[idx] || 0,
        isHeadingLike: b.isHeadingLike,
        text: b.slottedText.length > 100 ? `${b.slottedText.slice(0, 97)}...` : b.slottedText
      };
    });
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          fileName: path.basename(inputPath),
          detectedLanguage: parsed.detectedLanguage,
          cssFiles: parsed.cssFiles,
          chapters: parsed.chapters.map((c) => ({
            index: c.index,
            fileName: c.fileName,
            title: c.title,
            category: c.classification?.category,
            disposition: c.classification?.disposition,
            isFootnoteSource: Boolean(c.isFootnoteSource),
            chars: (c.markdown || '').length,
            footnotes: Object.keys(c.internalizedFootnotes || {}).length
          })),
          ...(flags.styles ? { candidates, localRoles } : {}),
          ...(blockDetails ? { inspectedChapter: inspectChapter?.fileName, blocks: blockDetails } : {})
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `EPUB: ${path.basename(inputPath)} | Lang: ${parsed.detectedLanguage} | Chapters: ${parsed.chapters.length} | CSS files: ${parsed.cssFiles.length}`
  );
  console.log('Index | File | Title | Category(Disposition) | Chars | Notes | FnSrc');
  for (const ch of parsed.chapters) {
    const fnCount = Object.keys(ch.internalizedFootnotes || {}).length;
    console.log(
      `  [${ch.index}] ${ch.fileName} | "${ch.title}" | ${ch.classification?.category || '-'}(${ch.classification?.disposition || '-'}) | ${(ch.markdown || '').length} | ${fnCount} | ${ch.isFootnoteSource ? 'YES' : 'no'}`
    );
  }

  if (flags.styles) {
    console.log(`\nStyle Census (${candidates.length} candidates, ${Object.keys(localRoles).length} local role mappings):`);
    for (const c of candidates) {
      const mapped = localRoles[c.cls];
      const mappedStr = mapped
        ? `${mapped.role}${mapped.align ? ` align=${mapped.align}` : ''}${mapped.weight ? ` weight=${mapped.weight}` : ''}`
        : '(unmapped)';
      console.log(
        `  .${c.cls} [${c.scope}] <${c.tags.join(',')}> n=${c.count} run=${c.maxConsecutiveRun} len=${c.minLen}-${c.maxLen} css="${c.cssSummary}" -> ${mappedStr} | ex="${c.samples[0] || ''}"`
      );
    }
  }

  if (blockDetails && inspectChapter) {
    console.log(`\nChapter [${inspectChapter.index}] ${inspectChapter.fileName} ("${inspectChapter.title}") — ${blockDetails.length} leaf blocks:`);
    for (const b of blockDetails) {
      console.log(
        `  #${b.index} <${b.tag}${b.className ? `.${b.className}` : ''}> role=${b.role} hdr=${b.isHeadingLike ? `H${b.headingLevel || '?'}` : 'no'} | ${b.text}`
      );
    }
  }
}

async function cmdClassifyStyles(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const inputPath = positionals[0];
  if (!inputPath) {
    throw new Error('Usage: classify-styles <book.epub> [--local] [--save-roles <file.json>] [--json]');
  }

  const file = readLocalEpubAsFile(inputPath);
  const bytes = await fileToUint8Array(file);
  const parsed = await new EpubService().parseEpub(bytes);
  const bodyHtmls = parsed.chapters
    .filter((c) => !c.isFootnoteSource && Boolean(c.content))
    .map((c) => c.content);

  const classifier = new StyleClassifier();
  const useLocal = Boolean(flags.local) || !process.env.TRANSLIT_API_KEY;
  let usage: TokenUsage | undefined;
  let roles: BookStyleRoleMap;

  if (useLocal) {
    roles = classifier.classifyLocal(bodyHtmls, parsed.cssContents).roles;
  } else {
    const aiCfg = buildCliAiConfig();
    const aiService = new AiService(aiCfg, (u) => {
      usage = u;
    });
    const res = await classifier.classifyBookStylesAi(bodyHtmls, parsed.cssContents, (cands) =>
      aiService.classifyBookStyles(cands)
    );
    roles = res.roles;
  }

  const savePath = getStringFlag(flags, 'save-roles');
  if (savePath) {
    const absSave = path.resolve(savePath);
    fs.mkdirSync(path.dirname(absSave), { recursive: true });
    fs.writeFileSync(absSave, JSON.stringify(roles, null, 2), 'utf8');
  }

  if (flags.json) {
    console.log(JSON.stringify({ mode: useLocal ? 'local' : 'ai', usage, roles }, null, 2));
    return;
  }

  console.log(`Mode: ${useLocal ? 'local (zero-token)' : 'ai (1-shot)'} | Mapped classes: ${Object.keys(roles).length}`);
  if (usage) {
    console.log(`Tokens: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, total=${usage.totalTokens}`);
  }
  console.log(JSON.stringify(roles, null, 2));
}

export interface EpubAuditResult {
  passed: boolean;
  structuralTreeDiffTotal: number;
  chapterDiffs: Array<{ fileName: string; diffCount: number; diffs: string[] }>;
  hardcodedColors: Array<{ cssFile: string; hex: string }>;
  xmlErrors: Array<{ fileName: string; error: string }>;
  roleCounts: Record<string, number>;
  mergedCount: number;
  unmatchedNoterefs: Array<{ fileName: string; href: string }>;
  leakedFootnotes: Array<{ fileName: string; ids: string[]; snippet: string }>;
  untranslatedAsides: Array<{ fileName: string; id: string; text: string }>;
  escapedHtmlLeaks: Array<{ fileName: string; snippet: string }>;
  emptyHeadingLeaks: Array<{ fileName: string; tag: string }>;
  englishLeaks: Array<{ fileName: string; text: string }>;
  corruptedChars: number;
}

function isUntranslatedEnglishProse(text: string): boolean {
  return (
    text.length > 30 &&
    !/[\u4e00-\u9fff]/.test(text) &&
    /[A-Za-z]{4,}(?:\s+[A-Za-z]{2,}){3,}/.test(text) &&
    !/^https?:\/\//i.test(text)
  );
}

async function runEpubQualityAudit(
  outZipBytes: Uint8Array,
  origChapters: Chapter[],
  options: {
    bilingualMode: BilingualMode;
    translatedChapterIndices: Set<number>;
    checkStructuralDiff: boolean;
  }
): Promise<EpubAuditResult> {
  const outZip = await new JSZip().loadAsync(outZipBytes);
  const hardcodedColors: Array<{ cssFile: string; hex: string }> = [];
  const xmlErrors: Array<{ fileName: string; error: string }> = [];

  for (const [zipPath, entry] of Object.entries(outZip.files)) {
    if (entry.dir) continue;
    if (/\.css$/i.test(zipPath)) {
      const cssText = (await entry.async('string')).toLowerCase();
      for (const hex of FORBIDDEN_HARDCODED_HEX) {
        if (cssText.includes(hex)) {
          hardcodedColors.push({ cssFile: zipPath, hex });
        }
      }
    } else if (/\.xhtml$/i.test(zipPath)) {
      const xmlStr = await entry.async('string');
      const xmlDoc = parseXmlDocument(xmlStr);
      const parseErr = xmlDoc.getElementsByTagName('parsererror')[0];
      if (parseErr) {
        xmlErrors.push({
          fileName: zipPath,
          error: (parseErr.textContent || 'XML parsererror').replace(/\s+/g, ' ').trim().slice(0, 140)
        });
      }
    }
  }

  const chapterDiffs: Array<{ fileName: string; diffCount: number; diffs: string[] }> = [];
  let structuralTreeDiffTotal = 0;
  const roleCounts: Record<string, number> = {};
  let mergedCount = 0;
  const unmatchedNoterefs: Array<{ fileName: string; href: string }> = [];
  const leakedFootnotes: Array<{ fileName: string; ids: string[]; snippet: string }> = [];
  const untranslatedAsides: Array<{ fileName: string; id: string; text: string }> = [];
  const escapedHtmlLeaks: Array<{ fileName: string; snippet: string }> = [];
  const emptyHeadingLeaks: Array<{ fileName: string; tag: string }> = [];
  const englishLeaks: Array<{ fileName: string; text: string }> = [];
  let corruptedChars = 0;

  for (const ch of origChapters) {
    if (ch.isFootnoteSource || ch.classification?.disposition === 'system_footnote_source') {
      continue;
    }
    // Locate exported file in ZIP
    const normSuffix = normalizeEpubFilePath(ch.fileName);
    const matchedPath = Object.keys(outZip.files).find(
      (p) => !outZip.files[p].dir && (p === ch.fileName || normalizeEpubFilePath(p).endsWith(normSuffix))
    );
    if (!matchedPath) continue;

    const outXhtml = await outZip.file(matchedPath)!.async('string');
    const outDoc = parseHtmlDocument(outXhtml);
    if (!outDoc.body) continue;

    const isTranslated = options.translatedChapterIndices.has(ch.index);
    const hasNotes = Object.keys(ch.internalizedFootnotes || {}).length > 0;

    if (options.checkStructuralDiff && options.bilingualMode === 'none' && (isTranslated || hasNotes)) {
      const diff = computeStructuralTreeDiff(ch.content, outXhtml);
      if (diff.diffCount > 0) {
        structuralTreeDiffTotal += diff.diffCount;
        chapterDiffs.push({ fileName: ch.fileName, diffCount: diff.diffCount, diffs: diff.diffs });
      }
    }

    for (const el of Array.from(outDoc.body.querySelectorAll('[data-translit-role]'))) {
      const role = el.getAttribute('data-translit-role') || 'unknown';
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }
    mergedCount += outDoc.body.querySelectorAll('[data-translit-merged="true"]').length;

    // Check noteref -> aside matching
    const asideIds = new Set(
      Array.from(outDoc.body.querySelectorAll('aside[id]')).map((a) => a.getAttribute('id') || '')
    );
    for (const a of Array.from(outDoc.body.querySelectorAll('a.noteref, a[epub\\:type="noteref"]'))) {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) {
        const targetId = href.slice(1);
        if (!asideIds.has(targetId)) {
          unmatchedNoterefs.push({ fileName: ch.fileName, href });
        }
      }
    }

    // Check non-aside visible blocks for leaked footnotes, replacement chars, & untranslated English
    const knownFnIds = Object.keys(ch.internalizedFootnotes || {});
    for (const block of Array.from(
      outDoc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, div')
    )) {
      if (block.closest('aside')) continue;
      if (block.getAttribute('data-translit-merged') === 'true') continue;
      if (block.classList.contains('bilingual-source')) continue;
      // Only inspect leaf-like elements so we don't double-count containers
      if (block.querySelector('p, h1, h2, h3, h4, h5, h6, li, blockquote')) continue;

      const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      corruptedChars += countReplacementChars(text);

      if (/<\/?(?:a|img|span|div|p|font|strong|em)\b[^>]*>/i.test(text)) {
        escapedHtmlLeaks.push({ fileName: ch.fileName, snippet: text.slice(0, 100) });
      }

      if (knownFnIds.length > 0) {
        const leakCheck = stripLeakedFootnoteDefinitions(text, knownFnIds);
        const extractedIds = Object.keys(leakCheck.extractedDefs);
        if (extractedIds.length > 0) {
          leakedFootnotes.push({
            fileName: ch.fileName,
            ids: extractedIds,
            snippet: text.slice(0, 80)
          });
        }
      }

      if (
        isTranslated &&
        options.bilingualMode === 'none' &&
        isUntranslatedEnglishProse(text)
      ) {
        englishLeaks.push({ fileName: ch.fileName, text: text.slice(0, 100) });
      }
    }

    if (isTranslated) {
      for (const hEl of Array.from(
        outDoc.body.querySelectorAll('[data-translit-role="h1"], [data-translit-role="h2"]')
      )) {
        if (hEl.classList.contains('bilingual-source')) continue;
        if (
          hEl.getAttribute('data-translit-merged') === 'true' ||
          !(hEl.textContent || '').replace(/\s+/g, '').trim()
        ) {
          emptyHeadingLeaks.push({ fileName: ch.fileName, tag: hEl.tagName.toLowerCase() });
        }
      }
    }

    if (isTranslated && options.bilingualMode === 'none') {
      for (const aside of Array.from(outDoc.body.querySelectorAll('aside.footnote-popup'))) {
        const id = aside.getAttribute('id') || '';
        if (id.startsWith('fn-src-')) continue;
        const rawAsideText = (aside.textContent || '').replace(/\s+/g, ' ').trim();
        const asideBody = rawAsideText.replace(/^\[\d+\]\s*/, '').trim();
        if (asideBody && isUntranslatedEnglishProse(asideBody)) {
          untranslatedAsides.push({ fileName: ch.fileName, id, text: asideBody.slice(0, 100) });
        }
      }
    }
  }

  const passed =
    structuralTreeDiffTotal === 0 &&
    hardcodedColors.length === 0 &&
    xmlErrors.length === 0 &&
    unmatchedNoterefs.length === 0 &&
    leakedFootnotes.length === 0 &&
    untranslatedAsides.length === 0 &&
    escapedHtmlLeaks.length === 0 &&
    emptyHeadingLeaks.length === 0 &&
    englishLeaks.length === 0 &&
    corruptedChars === 0;

  return {
    passed,
    structuralTreeDiffTotal,
    chapterDiffs,
    hardcodedColors,
    xmlErrors,
    roleCounts,
    mergedCount,
    unmatchedNoterefs,
    leakedFootnotes,
    untranslatedAsides,
    escapedHtmlLeaks,
    emptyHeadingLeaks,
    englishLeaks,
    corruptedChars
  };
}

async function writeHtmlPreviewFile(
  outZipBytes: Uint8Array,
  previewPath: string,
  targetChapter: Chapter | undefined
): Promise<string> {
  const zip = await new JSZip().loadAsync(outZipBytes);
  const cssParts: string[] = [];
  for (const [p, entry] of Object.entries(zip.files)) {
    if (!entry.dir && /\.css$/i.test(p)) {
      cssParts.push(await entry.async('string'));
    }
  }

  let bodyHtml = '<p>(No matching chapter found for HTML preview)</p>';
  let previewTitle = targetChapter?.title || 'TransLit Preview';
  if (targetChapter) {
    const normSuffix = normalizeEpubFilePath(targetChapter.fileName);
    const matchedPath = Object.keys(zip.files).find(
      (p) => !zip.files[p].dir && (p === targetChapter.fileName || normalizeEpubFilePath(p).endsWith(normSuffix))
    );
    if (matchedPath) {
      const xhtml = await zip.file(matchedPath)!.async('string');
      const doc = parseHtmlDocument(xhtml);
      if (doc.body) {
        bodyHtml = doc.body.innerHTML;
      }
      previewTitle = `${targetChapter.title || targetChapter.fileName} — TransLit Pure Heti Preview`;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${previewTitle}</title>
  <style>
${cssParts.join('\n\n')}
    /* Studio Host Ink & Paper Simulation */
    html { background: #f8f7f4; }
    body {
      max-width: 42rem;
      margin: 2.5rem auto;
      padding: 2.5rem 3rem;
      background: #ffffff;
      color: #242424;
      box-shadow: 0 2px 18px rgba(0, 0, 0, 0.06);
      border-radius: 6px;
    }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

  const absPreview = path.resolve(previewPath);
  fs.mkdirSync(path.dirname(absPreview), { recursive: true });
  fs.writeFileSync(absPreview, html, 'utf8');
  return absPreview;
}

function printAuditReport(audit: EpubAuditResult, outAbs: string): void {
  console.log(`\nExported EPUB: ${outAbs}`);
  console.log(`Quality Audit: ${audit.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  structuralTreeDiffTotal: ${audit.structuralTreeDiffTotal}`);
  if (audit.chapterDiffs.length > 0) {
    for (const cd of audit.chapterDiffs) {
      console.log(`    [diff] ${cd.fileName}: ${cd.diffs.join(' | ')}`);
    }
  }
  console.log(`  hardcodedColors: ${audit.hardcodedColors.length}`);
  if (audit.hardcodedColors.length > 0) {
    console.log(`    ${JSON.stringify(audit.hardcodedColors)}`);
  }
  console.log(`  xmlErrors: ${audit.xmlErrors.length}`);
  if (audit.xmlErrors.length > 0) {
    for (const xe of audit.xmlErrors) {
      console.log(`    [xml] ${xe.fileName}: ${xe.error}`);
    }
  }
  console.log(`  roleCounts: ${JSON.stringify(audit.roleCounts)} | mergedHidden: ${audit.mergedCount}`);
  console.log(`  unmatchedNoterefs: ${audit.unmatchedNoterefs.length}`);
  console.log(`  leakedFootnotes: ${audit.leakedFootnotes.length}`);
  if (audit.leakedFootnotes.length > 0) {
    for (const lf of audit.leakedFootnotes) {
      console.log(`    [leaked-fn] ${lf.fileName} (${lf.ids.join(',')}): ${lf.snippet}`);
    }
  }
  console.log(`  untranslatedAsides: ${audit.untranslatedAsides.length}`);
  if (audit.untranslatedAsides.length > 0) {
    for (const ua of audit.untranslatedAsides) {
      console.log(`    [untranslated-aside] ${ua.fileName} #${ua.id}: ${ua.text}`);
    }
  }
  console.log(`  escapedHtmlLeaks: ${audit.escapedHtmlLeaks.length}`);
  if (audit.escapedHtmlLeaks.length > 0) {
    for (const ehl of audit.escapedHtmlLeaks) {
      console.log(`    [escaped-html] ${ehl.fileName}: ${ehl.snippet}`);
    }
  }
  console.log(`  emptyHeadingLeaks: ${audit.emptyHeadingLeaks.length}`);
  if (audit.emptyHeadingLeaks.length > 0) {
    for (const eh of audit.emptyHeadingLeaks) {
      console.log(`    [empty-heading] ${eh.fileName} <${eh.tag}>`);
    }
  }
  console.log(`  englishLeaks: ${audit.englishLeaks.length}`);
  if (audit.englishLeaks.length > 0) {
    for (const el of audit.englishLeaks) {
      console.log(`    [en-leak] ${el.fileName}: ${el.text}`);
    }
  }
  console.log(`  corruptedChars (\\uFFFD): ${audit.corruptedChars}`);
}

async function cmdRender(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const inputPath = positionals[0];
  const outputPath = getStringFlag(flags, 'o', 'out');
  if (!inputPath || !outputPath) {
    throw new Error(
      'Usage: render <book.epub> -o <out.epub> [--roles <file.json> | --no-roles] [--chapter <idxOrPattern>] [--translation <file.md|file.json>] [--all-passthrough] [--bilingual source_first|target_first] [--html-preview <out.html>] [--strict] [--json]'
    );
  }

  const bilingualRaw = getStringFlag(flags, 'bilingual') || 'none';
  const bilingualMode: BilingualMode =
    bilingualRaw === 'source_first' || bilingualRaw === 'target_first' ? bilingualRaw : 'none';

  const file = readLocalEpubAsFile(inputPath);
  const inputBytes = await fileToUint8Array(file);
  const epubService = new EpubService();
  const parsed = await epubService.parseEpub(inputBytes);
  const workingZip = await new JSZip().loadAsync(inputBytes);
  const bookTitle = await extractBookTitleFromOpf(inputBytes, parsed.opfPath, path.basename(inputPath));

  let bookStyleRoles: BookStyleRoleMap | undefined;
  const rolesPath = getStringFlag(flags, 'roles');
  if (rolesPath) {
    bookStyleRoles = JSON.parse(fs.readFileSync(path.resolve(rolesPath), 'utf8'));
  } else if (!flags['no-roles']) {
    const bodyHtmls = parsed.chapters
      .filter((c) => !c.isFootnoteSource && Boolean(c.content))
      .map((c) => c.content);
    bookStyleRoles = new StyleClassifier().classifyLocal(bodyHtmls, parsed.cssContents).roles;
  }

  // Re-extract payloads with resolved bookStyleRoles
  const cssProfiles = parseEpubCssProfiles(parsed.cssContents);
  const domEngine = new DomMutationEngine();
  for (const ch of parsed.chapters) {
    if (!ch.isFootnoteSource && ch.content) {
      const ext = domEngine.extractTranslatablePayload(
        ch.content,
        ch.internalizedFootnotes,
        cssProfiles,
        bookStyleRoles
      );
      if (ext.payloadText) {
        ch.markdown = ext.payloadText;
        ch.slottedMarkdown = ext.payloadText;
      }
    }
  }

  const chapterFlag = getStringFlag(flags, 'chapter');
  const translationFlag = getStringFlag(flags, 'translation');
  const translatedIndices = new Set<number>();

  let previewChapter: Chapter | undefined = chapterFlag
    ? findMatchingChapter(parsed.chapters, chapterFlag)
    : undefined;
  if (chapterFlag && !previewChapter) {
    throw new Error(`No chapter matched "${chapterFlag}"`);
  }

  if (translationFlag) {
    const absTrans = path.resolve(translationFlag);
    if (!fs.existsSync(absTrans)) {
      throw new Error(`Translation file not found: ${absTrans}`);
    }
    const rawContent = fs.readFileSync(absTrans, 'utf8');
    if (absTrans.toLowerCase().endsWith('.json')) {
      const mapping = JSON.parse(rawContent) as Record<
        string,
        string | { translatedMarkdown?: string; translatedFootnotes?: Record<string, string> }
      >;
      for (const [key, val] of Object.entries(mapping)) {
        const ch = findMatchingChapter(parsed.chapters, key);
        if (!ch) continue;
        if (typeof val === 'string') {
          ch.translatedMarkdown = val;
        } else if (val) {
          ch.translatedMarkdown = val.translatedMarkdown || ch.slottedMarkdown || ch.markdown;
          if (val.translatedFootnotes) ch.translatedFootnotes = val.translatedFootnotes;
        }
        translatedIndices.add(ch.index);
        if (!previewChapter) previewChapter = ch;
      }
    } else {
      const targetCh =
        previewChapter ||
        parsed.chapters.find((c) => !c.isFootnoteSource && !c.isSkippable) ||
        parsed.chapters[0];
      if (!targetCh) throw new Error('No target chapter available for translation');
      targetCh.translatedMarkdown = rawContent;
      translatedIndices.add(targetCh.index);
      previewChapter = targetCh;
    }

    if (flags['all-passthrough']) {
      for (const ch of parsed.chapters) {
        if (!ch.isFootnoteSource && !ch.isReference && !ch.translatedMarkdown && ch.markdown) {
          ch.translatedMarkdown = ch.slottedMarkdown || ch.markdown;
        }
      }
    }
  } else {
    // Offline dry-run render: passthrough target chapter or all non-footnote chapters so Pure Heti CSS + DOM roles run
    const targets = previewChapter
      ? [previewChapter]
      : parsed.chapters.filter((c) => !c.isFootnoteSource && !c.isReference);
    for (const ch of targets) {
      if (ch.markdown) {
        ch.translatedMarkdown = ch.slottedMarkdown || ch.markdown;
      }
    }
    if (!previewChapter) previewChapter = targets[0];
  }

  const outBlob = await epubService.generateEpub(
    parsed.chapters,
    workingZip,
    parsed.opfPath,
    parsed.opfDir,
    parsed.cssFiles,
    bookTitle,
    'Chinese (Simplified)',
    undefined,
    undefined,
    bilingualMode,
    false,
    bookStyleRoles
  );

  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  const outAbs = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, outBytes);

  const htmlPreviewFlag = getStringFlag(flags, 'html-preview');
  let htmlPreviewAbs: string | undefined;
  if (htmlPreviewFlag) {
    htmlPreviewAbs = await writeHtmlPreviewFile(outBytes, htmlPreviewFlag, previewChapter);
  }

  const audit = await runEpubQualityAudit(outBytes, parsed.chapters, {
    bilingualMode,
    translatedChapterIndices: translatedIndices,
    checkStructuralDiff: true
  });

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          output: outAbs,
          ...(htmlPreviewAbs ? { htmlPreview: htmlPreviewAbs } : {}),
          bookStyleRolesCount: Object.keys(bookStyleRoles || {}).length,
          audit
        },
        null,
        2
      )
    );
  } else {
    printAuditReport(audit, outAbs);
    if (htmlPreviewAbs) {
      console.log(`HTML Preview written: ${htmlPreviewAbs}`);
    }
  }

  if (flags.strict && !audit.passed) {
    process.exit(1);
  }
}

async function cmdTranslate(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const inputPath = positionals[0];
  const outputPath = getStringFlag(flags, 'o', 'out');
  if (!inputPath || !outputPath) {
    throw new Error(
      'Usage: translate <book.epub> -o <out.epub> [--chapters <spec>] [--bilingual source_first|target_first] [--proofread] [--no-style-ai] [--html-preview <out.html>] [--strict] [--json]'
    );
  }

  const apiKey = process.env.TRANSLIT_API_KEY;
  const baseUrl = process.env.TRANSLIT_BASE_URL;
  const modelName = process.env.TRANSLIT_MODEL;
  if (!apiKey || !baseUrl || !modelName) {
    throw new Error(
      'Missing required environment variables: TRANSLIT_API_KEY, TRANSLIT_BASE_URL, and TRANSLIT_MODEL must be set.'
    );
  }

  const bilingualRaw = getStringFlag(flags, 'bilingual') || 'none';
  const bilingualMode: BilingualMode =
    bilingualRaw === 'source_first' || bilingualRaw === 'target_first' ? bilingualRaw : 'none';

  const file = readLocalEpubAsFile(inputPath);
  const inputBytes = await fileToUint8Array(file);
  const epubService = new EpubService();
  const parsed = await epubService.parseEpub(inputBytes);
  const workingZip = await new JSZip().loadAsync(inputBytes);
  const bookTitle = await extractBookTitleFromOpf(inputBytes, parsed.opfPath, path.basename(inputPath));

  const tokenStats: TokenUsageStats = {
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requestCount: 0
  };
  const recordUsage = (u: TokenUsage) => {
    tokenStats.promptTokens += u.promptTokens;
    tokenStats.cachedTokens += u.cachedTokens;
    tokenStats.completionTokens += u.completionTokens;
    tokenStats.reasoningTokens += u.reasoningTokens;
    tokenStats.totalTokens += u.totalTokens;
    tokenStats.requestCount += 1;
  };

  const aiCfg = buildCliAiConfig({
    apiKey,
    baseUrl,
    modelName,
    sourceLanguage: parsed.detectedLanguage || 'English',
    enableProofreading: Boolean(flags.proofread)
  });
  const aiService = new AiService(aiCfg, recordUsage);
  const footnotePool = new FootnotePool();

  const bodyHtmls = parsed.chapters
    .filter((c) => !c.isFootnoteSource && Boolean(c.content))
    .map((c) => c.content);
  const styleClassifier = new StyleClassifier();
  const bookStyleRoles = flags['no-style-ai']
    ? styleClassifier.classifyLocal(bodyHtmls, parsed.cssContents).roles
    : (await styleClassifier.classifyBookStylesAi(bodyHtmls, parsed.cssContents, (cands) =>
        aiService.classifyBookStyles(cands)
      )).roles;

  // Re-extract payloads with bookStyleRoles
  const cssProfiles = parseEpubCssProfiles(parsed.cssContents);
  const domEngine = new DomMutationEngine();
  for (const ch of parsed.chapters) {
    if (!ch.isFootnoteSource && ch.content) {
      const ext = domEngine.extractTranslatablePayload(
        ch.content,
        ch.internalizedFootnotes,
        cssProfiles,
        bookStyleRoles
      );
      if (ext.payloadText) {
        ch.markdown = ext.payloadText;
        ch.slottedMarkdown = ext.payloadText;
      }
    }
  }

  const chaptersSpec = getStringFlag(flags, 'chapters');
  let targetChapters = parsed.chapters.filter(
    (c) => !isChapterNonTranslatable(c, true) && Boolean(c.markdown)
  );
  if (chaptersSpec) {
    const tokens = chaptersSpec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    targetChapters = parsed.chapters.filter((ch) => {
      if (ch.isFootnoteSource || !ch.markdown) return false;
      return tokens.some((tok) => {
        if (/^\d+$/.test(tok)) return ch.index === Number(tok);
        const lower = tok.toLowerCase();
        return ch.fileName.toLowerCase().includes(lower) || (ch.title || '').toLowerCase().includes(lower);
      });
    });
  }

  if (targetChapters.length === 0) {
    throw new Error('No chapters matched for live translation.');
  }

  const effectiveSystemInstruction = buildEffectiveSystemInstruction(aiCfg);
  let runningGlossary = '';
  const translatedIndices = new Set<number>();

  for (let idx = 0; idx < targetChapters.length; idx++) {
    const ch = targetChapters[idx];
    const fullBookIdx = parsed.chapters.indexOf(ch);
    const posteriorText = buildPosteriorTextForChapter(
      parsed.chapters,
      fullBookIdx >= 0 ? fullBookIdx : ch.index,
      true
    );
    if (!flags.json) {
      console.log(`Translating [${ch.index}] ${ch.fileName} ("${ch.title}")...`);
    }
    const res = await aiService.translateContent(
      ch.slottedMarkdown || ch.markdown || '',
      'Chinese (Simplified)',
      effectiveSystemInstruction,
      undefined,
      [],
      [],
      runningGlossary,
      posteriorText,
      ch.internalizedFootnotes || {},
      footnotePool
    );
    ch.translatedMarkdown = res.content;
    ch.translatedFootnotes = res.translatedFootnotes;
    if (res.glossary) runningGlossary = res.glossary;
    translatedIndices.add(ch.index);
  }

  const excludeFileNames = parsed.chapters
    .filter((c) => c.isSkippable && !c.isFootnoteSource)
    .map((c) => c.fileName);

  const outBlob = await epubService.generateEpub(
    parsed.chapters,
    workingZip,
    parsed.opfPath,
    parsed.opfDir,
    parsed.cssFiles,
    bookTitle,
    'Chinese (Simplified)',
    undefined,
    excludeFileNames,
    bilingualMode,
    false,
    bookStyleRoles
  );

  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  const outAbs = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, outBytes);

  const htmlPreviewFlag = getStringFlag(flags, 'html-preview');
  let htmlPreviewAbs: string | undefined;
  if (htmlPreviewFlag) {
    htmlPreviewAbs = await writeHtmlPreviewFile(outBytes, htmlPreviewFlag, targetChapters[0]);
  }

  const audit = await runEpubQualityAudit(outBytes, parsed.chapters, {
    bilingualMode,
    translatedChapterIndices: translatedIndices,
    checkStructuralDiff: true
  });

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          output: outAbs,
          ...(htmlPreviewAbs ? { htmlPreview: htmlPreviewAbs } : {}),
          tokenStats,
          audit
        },
        null,
        2
      )
    );
  } else {
    console.log(
      `\nToken Stats: requests=${tokenStats.requestCount}, prompt=${tokenStats.promptTokens} (cached=${tokenStats.cachedTokens}), completion=${tokenStats.completionTokens}, total=${tokenStats.totalTokens}`
    );
    printAuditReport(audit, outAbs);
    if (htmlPreviewAbs) {
      console.log(`HTML Preview written: ${htmlPreviewAbs}`);
    }
  }

  if (flags.strict && !audit.passed) {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parseCliArgs(argv);
  const command = positionals[0];

  if (!command || flags.help) {
    printUsage();
    return;
  }

  const subPositionals = positionals.slice(1);
  switch (command) {
    case 'sample':
      await cmdSample(subPositionals, flags);
      break;
    case 'inspect':
      await cmdInspect(subPositionals, flags);
      break;
    case 'classify-styles':
      await cmdClassifyStyles(subPositionals, flags);
      break;
    case 'render':
      await cmdRender(subPositionals, flags);
      break;
    case 'translate':
      await cmdTranslate(subPositionals, flags);
      break;
    default:
      console.error(`Unknown CLI command: "${command}"\n`);
      printUsage();
      process.exit(1);
  }
}

const isMainEntry =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase().endsWith('translit-cli.ts');

if (isMainEntry) {
  main().catch((err) => {
    console.error(`CLI Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
