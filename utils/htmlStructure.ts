/**
 * Single source of truth for HTML5 / EPUB3 / legacy e-book structural tag taxonomy
 * and O(N) descendant block boundary indexing.
 */

export const BLOCK_LEVEL_TAGS: ReadonlySet<string> = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HGROUP',
  'UL',
  'OL',
  'LI',
  'DL',
  'DT',
  'DD',
  'MENU',
  'TABLE',
  'CAPTION',
  'COLGROUP',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'BLOCKQUOTE',
  'PRE',
  'DIV',
  'SECTION',
  'ARTICLE',
  'ASIDE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'NAV',
  'FIGURE',
  'FIGCAPTION',
  'HR',
  'DETAILS',
  'SUMMARY',
  'ADDRESS',
  'CENTER',
  'DIALOG',
  'SEARCH',
  'FORM',
  'FIELDSET',
  'LEGEND',
  'NOSCRIPT',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'IFRAME',
  'OBJECT'
]);

export const LEAF_CANDIDATE_TAGS: ReadonlySet<string> = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'TD',
  'TH',
  'DT',
  'DD',
  'FIGCAPTION',
  'CAPTION',
  'SUMMARY',
  'ADDRESS',
  'BLOCKQUOTE',
  'PRE',
  'DIV',
  'CENTER'
]);

export const NON_TRANSLATABLE_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'SVG',
  'MATH',
  'TEMPLATE',
  'NOSCRIPT',
  'IFRAME',
  'OBJECT',
  'CANVAS',
  'VIDEO',
  'AUDIO'
]);

export const EMPTY_MARKER_VOID_TAGS: ReadonlySet<string> = new Set([
  'WBR',
  'PAGEBREAK',
  'MBP:PAGEBREAK',
  'COL',
  'LINK',
  'META',
  'BASE',
  'SOURCE',
  'TRACK',
  'PARAM',
  'AREA'
]);

export const FOOTNOTE_INLINE_TAG_SET: ReadonlySet<string> = new Set([
  'i',
  'em',
  'b',
  'strong',
  'sup',
  'sub',
  'u',
  'small',
  'code'
]);

export const LEAF_INLINE_TAG_SET: ReadonlySet<string> = new Set([
  ...FOOTNOTE_INLINE_TAG_SET,
  'span'
]);

export const STRIP_SHELL_HTML_TAGS: ReadonlySet<string> = new Set([
  'hgroup',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'main',
  'figure',
  'figcaption',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'caption',
  'colgroup',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'details',
  'summary',
  'address',
  'dialog',
  'search',
  'form',
  'fieldset',
  'legend',
  'menu',
  'hr',
  'a',
  'font',
  'big',
  'center',
  'cite',
  'q',
  'abbr',
  'mark',
  'del',
  'ins',
  's',
  'strike',
  'time',
  'dfn',
  'kbd',
  'samp',
  'var',
  'bdi',
  'bdo',
  'data',
  'wbr',
  'ruby',
  'rt',
  'rp',
  'rb',
  'rtc',
  'pagebreak',
  'div',
  'p',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside'
]);

export const ALL_KNOWN_HTML_TAG_NAMES: ReadonlySet<string> = new Set([
  ...LEAF_INLINE_TAG_SET,
  ...STRIP_SHELL_HTML_TAGS,
  'br',
  'img',
  'svg',
  'math'
]);

/**
 * Computes in a single O(N) bottom-up DFS the set of elements under `root`
 * whose subtree contains at least one descendant in `BLOCK_LEVEL_TAGS`
 * (excluding non-translatable subtrees and optional ignored subtrees such as footnote asides).
 */
export function buildBlockDescendantIndex(
  root: Element,
  isIgnoredSubtree?: (el: Element) => boolean
): Set<Element> {
  const hasBlockDescendant = new Set<Element>();

  const walk = (el: Element): boolean => {
    const tag = (el.tagName || '').toUpperCase();
    if (el !== root && isIgnoredSubtree?.(el)) {
      return false;
    }
    if (NON_TRANSLATABLE_SUBTREE_TAGS.has(tag)) {
      return false;
    }

    let childContainsBlock = false;
    for (const child of Array.from(el.children)) {
      const childTag = (child.tagName || '').toUpperCase();
      if (isIgnoredSubtree?.(child)) continue;
      if (NON_TRANSLATABLE_SUBTREE_TAGS.has(childTag)) continue;
      const descHasBlock = walk(child);
      if (BLOCK_LEVEL_TAGS.has(childTag) || descHasBlock) {
        childContainsBlock = true;
      }
    }

    if (childContainsBlock) {
      hasBlockDescendant.add(el);
    }
    return childContainsBlock;
  };

  walk(root);
  return hasBlockDescendant;
}

export function isBlockBoundaryElement(
  el: Element,
  blockDescIndex: Set<Element>
): boolean {
  return (
    BLOCK_LEVEL_TAGS.has((el.tagName || '').toUpperCase()) ||
    blockDescIndex.has(el)
  );
}
