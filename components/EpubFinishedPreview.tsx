import React, { useState, useRef, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { PersistenceService } from '../services/persistenceService';
import {
  buildAdaptiveChineseTypographyCss,
  EPUB3_POPUP_FOOTNOTE_CSS,
  BILINGUAL_EPUB_CSS
} from '../services/epubService';
import {
  DomMutationEngine,
  restoreHeadingPrefixesFromSource,
  applyHetiTextTypography,
  parseEpubCssProfiles
} from '../services/domMutationEngine';
import { Chapter, BilingualMode, BookStyleRoleMap, FootnoteNode } from '../types';

// Helper to resolve relative paths in EPUB
export const resolveEpubPath = (basePath: string, relativePath: string): string => {
  if (!relativePath || relativePath.startsWith('http') || relativePath.startsWith('data:')) return relativePath;

  let rel = relativePath.replace(/\\/g, '/');
  const base = basePath.replace(/\\/g, '/');
  rel = rel.replace(/^\.\//, '');

  const baseParts = base.split('/').filter(p => p);
  baseParts.pop(); // remove filename to get directory

  const relParts = rel.split('/').filter(p => p);
  for (const part of relParts) {
    if (part === '..') {
      baseParts.pop();
    } else if (part !== '.') {
      baseParts.push(part);
    }
  }

  return baseParts.join('/');
};

export const MarkdownImage: React.FC<{
  src?: string;
  alt?: string;
  chapterPath: string;
  persistence: PersistenceService;
}> = ({ src, alt, chapterPath, persistence }) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!src) {
      setIsLoading(false);
      return;
    }

    let currentUrl: string | null = null;

    const loadImg = async () => {
      try {
        const fullPath = resolveEpubPath(chapterPath, src);
        const blob = await persistence.getImage(fullPath);
        if (blob) {
          currentUrl = URL.createObjectURL(blob);
          setBlobUrl(currentUrl);
        }
      } catch (e) {
        console.warn('Failed to load preview image:', src, e);
      } finally {
        setIsLoading(false);
      }
    };

    loadImg();

    return () => {
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [src, chapterPath, persistence]);

  if (!src) return null;
  if (isLoading) {
    return (
      <span className="w-full h-32 bg-neutral-200 animate-pulse rounded-none flex items-center justify-center text-neutral-500 text-xs font-mono uppercase tracking-widest">
        Loading image...
      </span>
    );
  }

  return (
    <img
      src={blobUrl || src}
      alt={alt}
      className="rounded-none shadow-sm mx-auto my-6 max-h-[500px] object-contain bg-neutral-50"
      onError={(e) => {
        (e.target as HTMLImageElement).className = 'hidden';
      }}
    />
  );
};

export const LogoWatermark: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="115.29 115.46 793.23 793.23" width="220" height="220" fill="currentColor" className="text-neutral-300 opacity-20 pointer-events-none select-none">
    <path fillRule="evenodd" d="M 793.896 175.286 C 765.879 199.109, 751.775 208.906, 726.598 222.034 C 698.735 236.563, 673.394 245.224, 635.500 253.169 L 624.500 255.475 397.246 255.752 L 169.992 256.030 170.246 371.265 L 170.500 486.500 233 486.500 L 295.500 486.500 295.759 435.250 L 296.018 384 340.509 384 L 385 384 385 551.500 L 385 719 347 719 L 309 719 309 785 L 309 851 471.868 851 L 634.736 851 636.347 845.250 C 644.389 816.529, 638.076 786.582, 616.467 750.946 C 593.298 712.737, 545.956 667.638, 488 628.566 C 481.675 624.302, 476.375 620.693, 476.222 620.545 C 476.069 620.398, 479.219 618.570, 483.222 616.484 C 502.059 606.668, 530.636 588.347, 553.841 571.209 C 577.486 553.745, 607.177 526.965, 629.687 502.797 C 649.433 481.598, 659.786 469.268, 675.277 448.500 C 730.753 374.126, 770.930 286.534, 792.472 193 C 797.124 172.799, 797.082 172.994, 796.769 173.036 C 796.621 173.056, 795.328 174.068, 793.896 175.286 M 811.648 257.750 C 811.380 258.712, 810.858 262.650, 810.489 266.500 C 810.119 270.350, 808.721 280.250, 807.382 288.500 C 789.970 395.737, 746.998 483.112, 677.532 552.520 C 650.628 579.403, 621.106 602.164, 591.837 618.592 C 586.427 621.628, 582.004 624.425, 582.009 624.806 C 582.014 625.188, 584.603 627.165, 587.763 629.201 C 600.640 637.496, 620.285 657.682, 629.770 672.366 C 656.140 713.189, 665.502 764, 655.861 813.980 C 654.749 819.744, 651.905 830.319, 649.542 837.480 C 647.179 844.641, 645.377 850.650, 645.538 850.832 C 645.991 851.346, 663.357 839.514, 674.500 831.101 C 692.303 817.660, 707.162 804.557, 723.543 787.857 C 741.316 769.737, 750.283 759.381, 763.684 741.500 C 795.225 699.412, 821.492 649.768, 836.953 603.019 C 843.309 583.804, 849.292 557.182, 852.129 535.500 C 852.966 529.103, 853.401 488.028, 853.634 393.500 C 853.814 320.350, 853.693 259.488, 853.364 258.250 C 852.769 256.010, 852.675 256, 832.451 256 C 813.954 256, 812.091 256.157, 811.648 257.750 M 612.602 274.083 C 612.347 274.862, 610.545 281.350, 608.597 288.500 C 584.819 375.791, 542.216 463.768, 490.709 531.942 C 476.970 550.126, 461.469 568.478, 448.771 581.591 C 443.397 587.141, 439 591.964, 439 592.309 C 439 592.654, 443.824 596.535, 449.721 600.935 L 460.441 608.934 462.830 606.717 C 467.931 601.984, 487.194 578.815, 497.514 565 C 536.683 512.571, 566.155 455.580, 588.015 390 C 599.875 354.417, 608.579 319.072, 613.576 286.197 C 614.838 277.890, 614.998 274.598, 614.180 273.780 C 613.361 272.961, 612.943 273.041, 612.602 274.083" />
  </svg>
);

/**
 * Transforms raw markdown containing internal __FN_REF_{id}__ slots or {{TRANSLITFNSLOT:...}}
 * into user-friendly [注N](#fn-{id} "title") links for studio preview.
 */
export const formatMarkdownForPreview = (
  rawMd: string,
  internalizedFootnotes: Record<string, FootnoteNode> = {},
  translatedFootnotes: Record<string, string> = {},
  options?: { isTranslation?: boolean; sourceMarkdown?: string }
): string => {
  if (!rawMd) return '';

  let text = rawMd
    .replace(/(?:\[|【)\s*[\/／]?\s*MAIN_CONTENT\s*(?:\]|】)/gi, '')
    .replace(/(?:\[|【)\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_TO_TRANSLATE\s*(?:\]|】)|$)/gi, '')
    .replace(/(?:\[|【)\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)[\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FOOTNOTES_REFERENCE_ONLY\s*(?:\]|】)|$)/gi, '')
    .replace(/(?:\[|【)\s*FN_DEF[:：][\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|$)/gi, '')
    .replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*')
    .replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
    .replace(/<\/?(?:span|small|big|sub|sup)\b[^>]*>/gi, '')
    .replace(/^(\d{1,3})\s*\r?\n\s*\r?\n(#\s+)/, '$2$1. ');

  if (options?.isTranslation) {
    if (options.sourceMarkdown) {
      text = restoreHeadingPrefixesFromSource(options.sourceMarkdown, text);
    }
    text = applyHetiTextTypography(text);
  }

  const idMap = new Map<string, number>();
  let nextNum = 1;

  return text.replace(
    /(?:\{\{TRANSLITFNSLOT:([A-Za-z0-9_-]+)\}\}|__FN_REF_([A-Za-z0-9_-]+)__|\[\^(?:fn-)?([A-Za-z0-9_-]+)\])/g,
    (_, id1, id2, id3) => {
      const rawId = (id1 || id2 || id3 || '').trim();
      const cleanId = rawId.replace(/^fn-/, '');
      if (!idMap.has(cleanId)) {
        idMap.set(cleanId, nextNum++);
      }
      const num = idMap.get(cleanId);
      const noteContent =
        translatedFootnotes[cleanId] ||
        translatedFootnotes[`fn-${cleanId}`] ||
        internalizedFootnotes[cleanId]?.plainText ||
        internalizedFootnotes[`fn-${cleanId}`]?.plainText ||
        '';
      const cleanSnippet = noteContent.replace(/["\n\r]+/g, ' ').slice(0, 80);
      return ` [注${num}](#fn-${cleanId}${cleanSnippet ? ` "${cleanSnippet}"` : ''}) `;
    }
  );
};

const previewDomMutationEngine = new DomMutationEngine();

export interface EpubFinishedPreviewProps {
  chapter: Chapter;
  displayMode: 'translation' | 'bilingual' | 'source';
  bookCssTexts: string[];
  bookStyleRoles?: BookStyleRoleMap;
  opfDir?: string;
  persistence: PersistenceService;
  isStreamingCurrentChapter?: boolean;
  forceOriginal?: boolean;
}

export const EpubFinishedPreview: React.FC<EpubFinishedPreviewProps> = ({
  chapter,
  displayMode,
  bookCssTexts,
  bookStyleRoles,
  opfDir,
  persistence,
  isStreamingCurrentChapter = false,
  forceOriginal = false
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState<number>(520);
  const [resolvedBodyHtml, setResolvedBodyHtml] = useState<string>('');
  const [activePopover, setActivePopover] = useState<{
    id: string;
    num: string;
    text: string;
    topPx: number;
  } | null>(null);

  const inlineHeadStyles = useMemo(() => {
    if (!chapter.content) return [];
    return Array.from(chapter.content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
      .map((m) => (m[1] || '').trim())
      .filter(Boolean);
  }, [chapter.content]);

  const effectiveCssTexts = useMemo(() => {
    return [...bookCssTexts, ...inlineHeadStyles];
  }, [bookCssTexts, inlineHeadStyles]);

  const cssProfiles = useMemo(() => parseEpubCssProfiles(effectiveCssTexts), [effectiveCssTexts]);

  const hasTranslation =
    !forceOriginal && Boolean(chapter.proofreadMarkdown || chapter.translatedMarkdown);
  const showTranslation = displayMode !== 'source' && hasTranslation;
  const effectiveBilingualMode: BilingualMode =
    displayMode === 'bilingual' && hasTranslation ? 'source_first' : 'none';

  const bodyAttrs = useMemo(() => {
    if (!chapter.content) return '';
    const match = chapter.content.match(/<body([^>]*)>/i);
    if (!match) return '';
    const rawAttrs = match[1] || '';
    const clsMatch = rawAttrs.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
    const idMatch = rawAttrs.match(/\bid\s*=\s*(["'])(.*?)\1/i);
    const clsPart = clsMatch ? ` class="${clsMatch[2]}"` : '';
    const idPart = idMatch ? ` id="${idMatch[2]}"` : '';
    return `${clsPart}${idPart}`;
  }, [chapter.content]);

  const rawMutatedBodyHtml = useMemo(() => {
    if (!chapter.content || !/<[a-z][\s\S]*>/i.test(chapter.content)) {
      return '';
    }
    const payloadToRender = showTranslation
      ? chapter.proofreadMarkdown || chapter.translatedMarkdown || ''
      : chapter.slottedMarkdown || chapter.markdown || '';

    const mutated = previewDomMutationEngine.mutateDomInPlace(
      chapter.content,
      payloadToRender,
      {
        internalizedFootnotes: chapter.internalizedFootnotes || {},
        translatedFootnotes: showTranslation ? chapter.translatedFootnotes || {} : {},
        sourcePayloadWithSlots: chapter.slottedMarkdown || chapter.markdown,
        bilingualMode: effectiveBilingualMode,
        wereadMode: false,
        cssProfiles,
        bookStyleRoles,
        applyChineseTypography: showTranslation,
        isStreaming: isStreamingCurrentChapter && showTranslation
      }
    );

    // Strip any raw <script> tags from publisher HTML for preview safety
    return mutated.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  }, [
    chapter.content,
    chapter.slottedMarkdown,
    chapter.markdown,
    chapter.proofreadMarkdown,
    chapter.translatedMarkdown,
    chapter.internalizedFootnotes,
    chapter.translatedFootnotes,
    showTranslation,
    effectiveBilingualMode,
    cssProfiles,
    bookStyleRoles,
    isStreamingCurrentChapter
  ]);

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];

    if (!rawMutatedBodyHtml) {
      setResolvedBodyHtml('');
      return;
    }

    const resolveImages = async () => {
      const urlSet = new Set<string>();
      const attrRegex = /\b(?:src|xlink:href|href)\s*=\s*(["'])([^"']+)\1/gi;
      let match: RegExpExecArray | null;
      while ((match = attrRegex.exec(rawMutatedBodyHtml)) !== null) {
        const val = match[2];
        if (
          !val ||
          val.startsWith('#') ||
          val.startsWith('http://') ||
          val.startsWith('https://') ||
          val.startsWith('data:') ||
          val.startsWith('blob:')
        ) {
          continue;
        }
        if (/\.(png|jpe?g|gif|svg|webp|bmp)(?:[?#].*)?$/i.test(val)) {
          urlSet.add(val);
        }
      }

      if (urlSet.size === 0) {
        if (!cancelled) setResolvedBodyHtml(rawMutatedBodyHtml);
        return;
      }

      const replacements = new Map<string, string>();
      for (const relUrl of urlSet) {
        const cleanRel = relUrl.split('#')[0].split('?')[0];
        const stripped = cleanRel.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
        const candidates = [
          resolveEpubPath((opfDir || '') + chapter.fileName, cleanRel),
          resolveEpubPath(chapter.fileName, cleanRel),
          stripped,
          opfDir ? `${opfDir}${stripped}` : ''
        ].filter(Boolean);

        for (const candidate of candidates) {
          try {
            const blob = await persistence.getImage(candidate);
            if (blob) {
              const objUrl = URL.createObjectURL(blob);
              createdUrls.push(objUrl);
              replacements.set(relUrl, objUrl);
              break;
            }
          } catch {
            // Try next candidate
          }
        }
      }

      if (cancelled) {
        createdUrls.forEach((u) => URL.revokeObjectURL(u));
        return;
      }

      let updatedHtml = rawMutatedBodyHtml;
      replacements.forEach((blobUrl, origRel) => {
        const escaped = origRel.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        updatedHtml = updatedHtml.replace(
          new RegExp(`(\\b(?:src|xlink:href|href)\\s*=\\s*)(["'])${escaped}\\2`, 'g'),
          `$1$2${blobUrl}$2`
        );
      });
      setResolvedBodyHtml(updatedHtml);
    };

    resolveImages();

    return () => {
      cancelled = true;
      createdUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [rawMutatedBodyHtml, chapter.fileName, opfDir, persistence]);

  const combinedPreviewCss = useMemo(() => {
    const adaptiveCss = showTranslation
      ? buildAdaptiveChineseTypographyCss(
          effectiveCssTexts.length > 0 ? effectiveCssTexts : undefined,
          bookStyleRoles
        )
      : '';
    const bilingualCss = effectiveBilingualMode !== 'none' ? BILINGUAL_EPUB_CSS : '';

    return `
${showTranslation ? adaptiveCss : effectiveCssTexts.join('\n\n')}

/* EPUB3 Footnotes & Bilingual Preview Styles */
${EPUB3_POPUP_FOOTNOTE_CSS}
${bilingualCss}

/* Studio Preview Isolation Overrides */
html, body {
  margin: 0 !important;
  padding: 2px 2px 16px 2px !important;
  background: transparent !important;
  color: #242424;
  overflow-x: hidden !important;
  height: auto !important;
  min-height: 0 !important;
  box-sizing: border-box;
}
${
  !showTranslation
    ? `
body {
  font-family: "Lora", Georgia, Cambria, "Times New Roman", serif;
  line-height: 1.75;
  color: #262524;
}
`
    : ''
}
img, svg {
  max-width: 100% !important;
  height: auto !important;
}
aside.footnote-popup.is-highlighted {
  background-color: #fef3c7 !important;
  outline: 2px solid #f59e0b !important;
  padding: 0.6em !important;
  transition: background-color 0.25s ease;
}
    `.trim();
  }, [effectiveCssTexts, bookStyleRoles, showTranslation, effectiveBilingualMode]);

  const srcDoc = useMemo(() => {
    const safeHtml = resolvedBodyHtml || rawMutatedBodyHtml;
    return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<style>${combinedPreviewCss}</style>
</head>
<body${bodyAttrs}>
${safeHtml}
</body>
</html>`;
  }, [resolvedBodyHtml, rawMutatedBodyHtml, combinedPreviewCss, bodyAttrs]);

  useEffect(() => {
    setActivePopover(null);
  }, [chapter.id, displayMode]);

  const attachIframeListeners = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) return;

    const updateHeight = () => {
      const h = Math.max(
        doc.documentElement?.scrollHeight || 0,
        doc.body?.scrollHeight || 0,
        360
      );
      setIframeHeight(h + 12);
    };

    updateHeight();

    const imgs = Array.from(doc.querySelectorAll('img'));
    imgs.forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', updateHeight, { once: true });
        img.addEventListener('error', updateHeight, { once: true });
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateHeight);
      ro.observe(doc.body);
      if (doc.documentElement) ro.observe(doc.documentElement);
      (iframe as any).__translitRo?.disconnect?.();
      (iframe as any).__translitRo = ro;
    }

    doc.onclick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
      if (!anchor) {
        setActivePopover(null);
        return;
      }
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('#fn-')) {
        ev.preventDefault();
        const targetId = href.slice(1);
        const aside = doc.getElementById(targetId);
        const rawText =
          aside?.textContent?.replace(/\s+/g, ' ').trim().replace(/^\[\d+\]\s*/, '') ||
          '（未找到注释文本）';
        const rect = anchor.getBoundingClientRect();
        const num = anchor.getAttribute('data-num') || anchor.textContent?.replace(/[\[\]]/g, '') || '注';
        setActivePopover({
          id: targetId,
          num,
          text: rawText,
          topPx: Math.max(12, rect.bottom + 8)
        });
      } else if (href.startsWith('#fnref-')) {
        ev.preventDefault();
        const refEl = doc.getElementById(href.slice(1));
        if (refEl) {
          refEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    };
  };

  useEffect(() => {
    return () => {
      const iframe = iframeRef.current as any;
      iframe?.__translitRo?.disconnect?.();
    };
  }, []);

  const jumpToFootnoteAside = (id: string) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const el = doc.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('is-highlighted');
      setTimeout(() => el.classList.remove('is-highlighted'), 2000);
    }
    setActivePopover(null);
  };

  return (
    <div className="relative w-full">
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-same-origin"
        onLoad={attachIframeListeners}
        title={chapter.title || chapter.fileName || 'Finished EPUB Preview'}
        scrolling="no"
        className="w-full border-0 block bg-transparent transition-[height] duration-150"
        style={{ height: `${iframeHeight}px`, minHeight: '360px' }}
      />
      {activePopover && (
        <div
          style={{ top: `${Math.min(activePopover.topPx, Math.max(40, iframeHeight - 160))}px` }}
          className="absolute left-0 right-0 mx-auto max-w-lg z-20 bg-[#fdfbf7] border border-neutral-400 shadow-lg p-3.5 text-xs text-neutral-800 font-serif animate-in fade-in duration-150"
        >
          <div className="flex items-center justify-between border-b border-neutral-200 pb-1.5 mb-2 font-mono text-[10px] text-teal-900 uppercase tracking-wider">
            <span className="font-bold">注释 [{activePopover.num}]</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => jumpToFootnoteAside(activePopover.id)}
                className="text-neutral-600 hover:text-black underline cursor-pointer"
              >
                跳至文末注释 ↩
              </button>
              <button
                onClick={() => setActivePopover(null)}
                className="text-neutral-400 hover:text-black p-0.5 cursor-pointer"
                title="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <p className="leading-relaxed text-neutral-800 break-words m-0">{activePopover.text}</p>
        </div>
      )}
    </div>
  );
};
