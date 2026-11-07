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

export function parseHtmlDocument(html: string): Document {
  ensureDomGlobals();
  const parser = new DOMParser();
  const normalizedHtml = (html || '').replace(
    /<(span|a|div|p|section|aside|sup|sub|em|i|b|strong|small|li|td|th|h[1-6]|blockquote|cite|q|dfn|abbr|code|pre|ol|ul|dl|dt|dd|nav|header|footer|main|article|figure|figcaption)(\s[^>]*)?\/>/gi,
    '<$1$2></$1>'
  );
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
