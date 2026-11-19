import { franc } from 'franc-min';

export type LanguageDetectionSource = 'text' | 'metadata' | 'fallback';

export interface LanguageDetectionResult {
  language: string;
  source: LanguageDetectionSource;
}

const ISO_TO_LANGUAGE_NAME: Record<string, string> = {
  // 9 preset languages
  eng: 'English',
  en: 'English',
  jpn: 'Japanese',
  ja: 'Japanese',
  kor: 'Korean',
  ko: 'Korean',
  fra: 'French',
  fre: 'French',
  fr: 'French',
  deu: 'German',
  ger: 'German',
  de: 'German',
  spa: 'Spanish',
  es: 'Spanish',
  rus: 'Russian',
  ru: 'Russian',
  ita: 'Italian',
  it: 'Italian',
  por: 'Portuguese',
  pt: 'Portuguese',
  // Extended languages supported by franc-min & common EPUBs
  cmn: 'Chinese',
  zho: 'Chinese',
  chi: 'Chinese',
  zh: 'Chinese',
  nld: 'Dutch',
  dut: 'Dutch',
  nl: 'Dutch',
  ara: 'Arabic',
  ar: 'Arabic',
  pol: 'Polish',
  pl: 'Polish',
  swe: 'Swedish',
  sv: 'Swedish',
  tur: 'Turkish',
  tr: 'Turkish',
  vie: 'Vietnamese',
  vi: 'Vietnamese',
  tha: 'Thai',
  th: 'Thai',
  ind: 'Indonesian',
  id: 'Indonesian',
  ell: 'Greek',
  gre: 'Greek',
  el: 'Greek',
  ukr: 'Ukrainian',
  uk: 'Ukrainian',
  ces: 'Czech',
  cze: 'Czech',
  cs: 'Czech',
  dan: 'Danish',
  da: 'Danish',
  fin: 'Finnish',
  fi: 'Finnish',
  nor: 'Norwegian',
  nob: 'Norwegian',
  nno: 'Norwegian',
  no: 'Norwegian',
  heb: 'Hebrew',
  he: 'Hebrew',
  hin: 'Hindi',
  hi: 'Hindi',
  ron: 'Romanian',
  rum: 'Romanian',
  ro: 'Romanian',
  hun: 'Hungarian',
  hu: 'Hungarian',
  lat: 'Latin',
  la: 'Latin',
};

/**
 * Normalizes an ISO 639-1, ISO 639-3, or BCP-47 language tag (e.g., "en-US", "jpn")
 * to a canonical language name. Returns null for undetermined or empty tags.
 */
export function normalizeLanguageCode(code?: string | null): string | null {
  if (!code) return null;
  const cleaned = code.trim().toLowerCase();
  if (!cleaned || cleaned === 'und') return null;

  if (ISO_TO_LANGUAGE_NAME[cleaned]) {
    return ISO_TO_LANGUAGE_NAME[cleaned];
  }

  const primarySubtag = cleaned.split(/[-_]/)[0];
  if (ISO_TO_LANGUAGE_NAME[primarySubtag]) {
    return ISO_TO_LANGUAGE_NAME[primarySubtag];
  }

  return null;
}

export interface ChapterTextLike {
  markdown?: string | null;
  originalMarkdown?: string | null;
}

/**
 * Extracts a clean prose sample from chapters for statistical language detection.
 */
export function extractDetectionSample(
  chapters: ChapterTextLike[],
  maxChars = 4000
): string {
  const parts: string[] = [];
  let totalLen = 0;

  for (const ch of chapters) {
    const rawText = ch.markdown ?? ch.originalMarkdown;
    if (!rawText) continue;
    const cleaned = rawText
      .replace(/\[\[NOTE_[^\]]+\]\]/g, ' ')
      .replace(/__FN_REF_[A-Za-z0-9_-]+__/g, ' ')
      .replace(/\{\{TRANSLITFNSLOT:[A-Za-z0-9_-]+\}\}/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[#>*_`~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length < 10) continue;
    parts.push(cleaned);
    totalLen += cleaned.length;
    if (totalLen >= maxChars) break;
  }

  return parts.join(' ').slice(0, maxChars).trim();
}

/**
 * Detects the source language of an EPUB from its chapter text first,
 * falling back to OPF metadata (<dc:language>) and finally 'English'.
 */
export function detectBookLanguage(
  chapters: ChapterTextLike[],
  opfLanguage?: string | null
): LanguageDetectionResult {
  const sample = extractDetectionSample(chapters);
  if (sample.length >= 20) {
    const detectedIso = franc(sample, { minLength: 20 });
    const mapped = normalizeLanguageCode(detectedIso);
    if (mapped) {
      return { language: mapped, source: 'text' };
    }
  }

  const metaLanguage = normalizeLanguageCode(opfLanguage);
  if (metaLanguage) {
    return { language: metaLanguage, source: 'metadata' };
  }

  return { language: 'English', source: 'fallback' };
}
