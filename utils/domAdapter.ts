/**
 * Universal DOM Adapter for Browser (DOMParser/XMLSerializer) and Node.js (jsdom).
 * Ensures deterministic DOM/AST parsing in both Vite browser runtime and Node CLI/tests.
 */

let domInitialized = false;

export function ensureDomGlobals(): void {
  if (domInitialized || typeof globalThis.DOMParser !== 'undefined') {
    domInitialized = true;
    return;
  }

  const proc = (globalThis as any).process;
  if (proc && typeof proc.getBuiltinModule === 'function') {
    const moduleBuiltin = proc.getBuiltinModule('module');
    if (moduleBuiltin && typeof moduleBuiltin.createRequire === 'function') {
      const req = moduleBuiltin.createRequire(import.meta.url);
      const { JSDOM } = req('jsdom');
      const jsdomInstance = new JSDOM('<!DOCTYPE html><html><body></body></html>');
      const win = jsdomInstance.window;
      (globalThis as any).DOMParser = win.DOMParser;
      (globalThis as any).XMLSerializer = win.XMLSerializer;
      (globalThis as any).Node = win.Node;
      (globalThis as any).Element = win.Element;
      (globalThis as any).HTMLElement = win.HTMLElement;
      (globalThis as any).Document = win.Document;
      domInitialized = true;
    }
  }
}

const HTML5_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
]);

/**
 * Expands XHTML self-closing non-void elements (e.g. `<script .../>`, `<span .../>`, `<style .../>`)
 * into explicit open/close pairs before HTML5 `text/html` parsing, while preserving HTML5 void elements
 * and foreign `<svg>` / `<math>` subtrees untouched.
 */
export function expandXhtmlSelfClosingTags(html: string): string {
  if (!html || !html.includes('/>')) return html || '';

  const preservedForeignBlocks: string[] = [];
  const masked = html.replace(/<(svg|math)\b[\s\S]*?<\/\1>/gi, (match) => {
    const idx = preservedForeignBlocks.length;
    preservedForeignBlocks.push(match);
    return `<!--TRANSLIT_FOREIGN_${idx}-->`;
  });

  const expanded = masked.replace(
    /<([a-zA-Z][a-zA-Z0-9:-]*)(\s(?:[^>"']|"[^"]*"|'[^']*')*?)?\s*\/>/g,
    (full, tag: string, attrs?: string) => {
      if (HTML5_VOID_ELEMENTS.has(tag.toLowerCase())) {
        return full;
      }
      return `<${tag}${attrs || ''}></${tag}>`;
    }
  );

  if (preservedForeignBlocks.length === 0) {
    return expanded;
  }

  return expanded.replace(/<!--TRANSLIT_FOREIGN_(\d+)-->/g, (_, idxStr) => {
    return preservedForeignBlocks[Number(idxStr)] ?? '';
  });
}

export function parseHtmlDocument(html: string): Document {
  ensureDomGlobals();
  const parser = new DOMParser();
  const normalizedHtml = expandXhtmlSelfClosingTags(html || '');
  return parser.parseFromString(normalizedHtml, 'text/html');
}

export function parseXmlDocument(xml: string): Document {
  ensureDomGlobals();
  const parser = new DOMParser();
  return parser.parseFromString(xml, 'application/xml');
}

export function serializeXmlNode(node: Node): string {
  ensureDomGlobals();
  const serializer = new XMLSerializer();
  return serializer.serializeToString(node);
}

/**
 * Normalizes a relative path inside an EPUB archive relative to a source file path.
 * E.g. resolveRelativeEpubPath('Text/chapter1.xhtml', '../Notes/notes.xhtml#fn1')
 * -> { filePath: 'Notes/notes.xhtml', hash: 'fn1' }
 */
export function resolveRelativeEpubHref(
  fromFilePath: string,
  href: string
): { filePath: string; hash: string } {
  const trimmed = (href || '').trim();
  if (!trimmed) return { filePath: '', hash: '' };

  const hashIdx = trimmed.indexOf('#');
  const rawPath = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const rawHash = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : '';

  let decodedHash = rawHash;
  try {
    decodedHash = decodeURIComponent(rawHash);
  } catch {
    decodedHash = rawHash;
  }

  const normalizedFrom = fromFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rawPath) {
    return { filePath: normalizedFrom, hash: decodedHash };
  }

  let cleanRel = rawPath.replace(/\\/g, '/');
  try {
    cleanRel = decodeURIComponent(cleanRel);
  } catch {
    // keep cleanRel
  }

  if (/^(https?:|mailto:|tel:|data:|javascript:)/i.test(cleanRel)) {
    return { filePath: cleanRel, hash: decodedHash };
  }

  const baseParts = normalizedFrom.split('/').filter(Boolean);
  baseParts.pop(); // directory of fromFilePath

  const relParts = cleanRel.split('/').filter(Boolean);
  for (const part of relParts) {
    if (part === '.') continue;
    if (part === '..') {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }

  return {
    filePath: baseParts.join('/'),
    hash: decodedHash
  };
}

export function normalizeEpubFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}
