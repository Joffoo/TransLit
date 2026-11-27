import { Chapter } from '../types';

export function isFootnoteSourceChapter(
  chapter: Pick<Chapter, 'isFootnoteSource' | 'classification'>
): boolean {
  return Boolean(
    chapter.isFootnoteSource ||
      chapter.classification?.disposition === 'system_footnote_source'
  );
}

export function isChapterEffectivelySkippable(
  chapter: Pick<Chapter, 'isSkippable' | 'isFootnoteSource' | 'classification'>,
  smartSkip: boolean
): boolean {
  if (isFootnoteSourceChapter(chapter)) return false;
  if (!chapter.isSkippable) return false;
  if (chapter.classification?.stage === 'user_override') return true;
  return smartSkip;
}

export function isChapterEffectivelyReference(
  chapter: Pick<
    Chapter,
    'isReference' | 'isSkippable' | 'isFootnoteSource' | 'classification'
  >,
  smartSkip: boolean
): boolean {
  if (isFootnoteSourceChapter(chapter)) return false;
  if (isChapterEffectivelySkippable(chapter, smartSkip)) return false;
  if (!chapter.isReference) return false;
  if (chapter.classification?.stage === 'user_override') return true;
  return smartSkip;
}

export function isChapterNonTranslatable(
  chapter: Pick<
    Chapter,
    'isReference' | 'isSkippable' | 'isFootnoteSource' | 'classification'
  >,
  smartSkip: boolean
): boolean {
  return (
    isFootnoteSourceChapter(chapter) ||
    isChapterEffectivelySkippable(chapter, smartSkip) ||
    isChapterEffectivelyReference(chapter, smartSkip)
  );
}

/**
 * Builds clean posterior translatable text for glossary filtering at chapter `currentIndex`.
 * - Excludes drained `isFootnoteSource` chapters (e.g. back-of-book Notes files) and any
 *   chapters that will not be translated (`isChapterNonTranslatable(ch, smartSkip)`), so
 *   one-off footnotes from earlier chapters never self-match in back-of-book notes.
 * - Includes both each posterior translatable chapter's body payload and the `plainText`
 *   of its `internalizedFootnotes` (deduplicated by canonical key).
 */
export function buildPosteriorTextForChapter(
  chapters: Chapter[],
  currentIndex: number,
  smartSkip: boolean
): string {
  const parts: string[] = [];
  const seenFootnoteKeys = new Set<string>();
  const start = Math.max(0, currentIndex + 1);

  for (let i = start; i < chapters.length; i++) {
    const ch = chapters[i];
    if (!ch || isChapterNonTranslatable(ch, smartSkip)) continue;

    const bodyText = (ch.slottedMarkdown || ch.markdown || '').trim();
    if (bodyText) {
      parts.push(bodyText);
    }

    if (ch.internalizedFootnotes) {
      for (const fnNode of Object.values(ch.internalizedFootnotes)) {
        if (!fnNode?.plainText) continue;
        const dedupeKey = fnNode.key || `${ch.index}:${fnNode.namespaceId || fnNode.originalId}`;
        if (seenFootnoteKeys.has(dedupeKey)) continue;
        seenFootnoteKeys.add(dedupeKey);
        const noteText = fnNode.plainText.trim();
        if (noteText) {
          parts.push(noteText);
        }
      }
    }
  }

  return parts.join('\n');
}
