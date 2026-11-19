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
