export interface GlossaryEntry {
  key: string;
  value: string;
}

/**
 * Parses a glossary string into an ordered list of `{ key, value }` entries,
 * strictly preserving first-appearance line order (including numeric string keys
 * such as "1984" or "2001" that plain JS objects would hoist to the front).
 * If the exact same key appears more than once, its value is updated in-place
 * at its original position.
 */
export const parseGlossaryEntries = (str: string): GlossaryEntry[] => {
  if (!str) return [];
  const lines = str.split('\n');
  const entries: GlossaryEntry[] = [];
  const indexByExactKey = new Map<string, number>();

  const upsert = (key: string, value: string) => {
    const existingIdx = indexByExactKey.get(key);
    if (existingIdx !== undefined) {
      entries[existingIdx] = { key, value };
    } else {
      indexByExactKey.set(key, entries.length);
      entries.push({ key, value });
    }
  };

  lines.forEach(rawLine => {
    const line = rawLine
      .trim()
      .replace(/^<\/?glossary>\s*/i, '')
      .replace(/\s*<\/?glossary>$/i, '')
      .trim();
    if (!line) return;

    // 1. Legacy structural format compatibility: SOURCE: xxx | TARGET: yyy
    const structuralMatch = line.match(/SOURCE:\s*(.*?)\s*\|\s*TARGET:\s*(.*)/i);
    if (structuralMatch) {
        const key = structuralMatch[1].trim();
        const value = parseGlossaryValue(structuralMatch[2]);
        if (key && value) {
            upsert(key, value);
        }
        return;
    }

    // 2. Primary compact format: Key=Value (also tolerate full-width ＝)
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
        const key = line.slice(0, eqIndex).trim();
        const value = parseGlossaryValue(line.slice(eqIndex + 1));
        if (key && value) {
            upsert(key, value);
        }
        return;
    }

    const fullEqIndex = line.indexOf('＝');
    if (fullEqIndex > 0) {
        const key = line.slice(0, fullEqIndex).trim();
        const value = parseGlossaryValue(line.slice(fullEqIndex + 1));
        if (key && value) {
            upsert(key, value);
        }
        return;
    }

    // 3. Fallback to simple format: Key: Value
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join(':').trim();
      if (key && value && !key.toLowerCase().includes('source') && !key.toLowerCase().includes('target')) {
          upsert(key, value);
      }
    }
  });

  return entries;
};

export const glossaryEntriesToOutputStr = (entries: GlossaryEntry[]): string => {
  if (!entries || entries.length === 0) return '';
  return entries
    .map(e => `${e.key}=${e.value}`)
    .join('\n');
};

export const glossaryEntriesToRecord = (entries: GlossaryEntry[]): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const { key, value } of entries) {
    record[key] = value;
  }
  return record;
};

export const parseGlossaryStr = (str: string): Record<string, string> => {
  return glossaryEntriesToRecord(parseGlossaryEntries(str));
};

export const glossaryToOutputStr = (glossary: Record<string, string>, preferredOrder?: string[]): string => {
  const keys = Object.keys(glossary);
  if (keys.length === 0) return '';

  const orderedKeys: string[] = [];
  const seen = new Set<string>();

  if (preferredOrder && preferredOrder.length > 0) {
    for (const k of preferredOrder) {
      if (Object.prototype.hasOwnProperty.call(glossary, k) && !seen.has(k)) {
        orderedKeys.push(k);
        seen.add(k);
      }
    }
  }

  for (const k of keys) {
    if (!seen.has(k)) {
      orderedKeys.push(k);
      seen.add(k);
    }
  }

  return orderedKeys
    .map(k => `${k}=${glossary[k]}`)
    .join('\n');
};

export const parseGlossaryValue = (rawValue: string): string => {
  return rawValue ? rawValue.trim() : "";
};

/**
 * Append-only chronological merge of glossary entries (case- and width-insensitive
 * deduplication). Established entries in `base` never move, preserving Prefix Cache stability.
 */
export function mergeGlossaryEntries(
  base: GlossaryEntry[],
  delta: GlossaryEntry[]
): GlossaryEntry[] {
  const merged: GlossaryEntry[] = [];
  const seenLower = new Set<string>();

  for (const entry of base) {
    const lower = normalizeGlossaryKey(entry.key);
    if (!lower || seenLower.has(lower)) continue;
    seenLower.add(lower);
    merged.push({ key: entry.key, value: entry.value });
  }

  for (const entry of delta) {
    const lower = normalizeGlossaryKey(entry.key);
    if (!lower || seenLower.has(lower)) continue;
    seenLower.add(lower);
    merged.push({ key: entry.key, value: entry.value });
  }

  return merged;
}

/**
 * Append-only chronological merge of two serialized glossary strings.
 */
export function mergeGlossaryStrings(base: string, delta: string): string {
  return glossaryEntriesToOutputStr(
    mergeGlossaryEntries(parseGlossaryEntries(base), parseGlossaryEntries(delta))
  );
}

function stripOptimizerKeyDecorations(rawKey: string): string {
  let cleaned = rawKey.trim();
  // Strip leading Markdown bullets / numbered list markers (e.g. "- ", "* ", "• ", "1. ", "2) ", "3、")
  cleaned = cleaned.replace(/^(?:[-*•·+]\s+|\d+[.)、]\s+)/, '').trim();
  // Iteratively unwrap surrounding Markdown emphasis, inline code, or quote wrappers
  for (let pass = 0; pass < 4; pass++) {
    const prev = cleaned;
    cleaned = cleaned
      .replace(/^\*\*([\s\S]+?)\*\*$/, '$1')
      .replace(/^__([\s\S]+?)__$/, '$1')
      .replace(/^`([\s\S]+?)`$/, '$1')
      .replace(/^"([\s\S]+?)"$/, '$1')
      .replace(/^'([\s\S]+?)'$/, '$1')
      .replace(/^“([\s\S]+?)”$/, '$1')
      .replace(/^‘([\s\S]+?)’$/, '$1')
      .replace(/^「([\s\S]+?)」$/, '$1')
      .trim();
    if (cleaned === prev) break;
  }
  return cleaned;
}

function extractOptimizerCandidateKeys(optimizedText: string): string[] {
  const sanitized = optimizedText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?glossary>/gi, '\n');

  const keys: string[] = [];
  for (const rawLine of sanitized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^```/.test(line)) continue;

    // 1. Legacy structural format: SOURCE: xxx | TARGET: yyy
    const structuralMatch = line.match(/SOURCE:\s*(.*?)\s*\|\s*TARGET:\s*(.*)/i);
    if (structuralMatch) {
      const k = structuralMatch[1].trim();
      const v = parseGlossaryValue(structuralMatch[2]);
      if (k && v) keys.push(k);
      continue;
    }

    // 2. Primary compact format: Key=Value or Key＝Value
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      const k = line.slice(0, eqIndex).trim();
      const v = parseGlossaryValue(line.slice(eqIndex + 1));
      if (k && v) keys.push(k);
      continue;
    }
    const fullEqIndex = line.indexOf('＝');
    if (fullEqIndex > 0) {
      const k = line.slice(0, fullEqIndex).trim();
      const v = parseGlossaryValue(line.slice(fullEqIndex + 1));
      if (k && v) keys.push(k);
      continue;
    }

    // 3. Arrow separator tolerance: Key -> Value / Key → Value
    const arrowMatch = line.match(/^(.+?)\s*(?:->|→)\s*(.+)$/);
    if (arrowMatch) {
      const k = arrowMatch[1].trim();
      const v = parseGlossaryValue(arrowMatch[2]);
      if (k && v) keys.push(k);
      continue;
    }

    // 4. Colon separator tolerance: Key: Value / Key：Value
    const colonMatch = line.match(/^([^:：]+)[:：](.+)$/);
    if (colonMatch) {
      const k = colonMatch[1].trim();
      const v = parseGlossaryValue(colonMatch[2]);
      if (k && v && !k.toLowerCase().includes('source') && !k.toLowerCase().includes('target')) {
        keys.push(k);
      }
    }
  }
  return keys;
}

/**
 * Reconciles AI smart-cleanup/deduplication output against the pre-optimization
 * chronological glossary:
 * 1. Deduplicates case/width variants to the earliest occurrence in `originalEntries`.
 * 2. Restores original key casing, translation, and gender tags (filter/dedupe only).
 * 3. Deterministically enforces the original chronological first-appearance order
 *    regardless of whether the LLM reordered, bulleted, or grouped its output.
 * 4. Drops non-glossary commentary or hallucinated entries not present in `originalEntries`.
 */
export function reconcileOptimizedGlossary(
  originalEntries: GlossaryEntry[],
  optimizedText: string
): GlossaryEntry[] {
  if (originalEntries.length === 0 || !optimizedText || !optimizedText.trim()) {
    return [];
  }

  const origByNormKey = new Map<string, { index: number; entry: GlossaryEntry }>();
  for (let i = 0; i < originalEntries.length; i++) {
    const entry = originalEntries[i];
    const normKey = normalizeGlossaryKey(entry.key);
    if (!normKey || origByNormKey.has(normKey)) continue;
    origByNormKey.set(normKey, { index: i, entry });
  }

  const candidateKeys = extractOptimizerCandidateKeys(optimizedText);
  const selectedNormKeys = new Set<string>();
  const kept: Array<{ index: number; entry: GlossaryEntry }> = [];

  for (const rawKey of candidateKeys) {
    let matchedNormKey = normalizeGlossaryKey(rawKey);
    let orig = matchedNormKey ? origByNormKey.get(matchedNormKey) : undefined;
    if (!orig) {
      const strippedKey = stripOptimizerKeyDecorations(rawKey);
      const strippedNorm = normalizeGlossaryKey(strippedKey);
      if (strippedNorm) {
        matchedNormKey = strippedNorm;
        orig = origByNormKey.get(strippedNorm);
      }
    }
    if (!orig || !matchedNormKey || selectedNormKeys.has(matchedNormKey)) continue;
    selectedNormKeys.add(matchedNormKey);
    kept.push({
      index: orig.index,
      entry: { key: orig.entry.key, value: orig.entry.value }
    });
  }

  kept.sort((a, b) => a.index - b.index);
  return kept.map(item => item.entry);
}

/**
 * Recovers chronological first-appearance order for a legacy unordered glossary
 * (e.g. loaded from an older IndexedDB session without explicit sequence numbers)
 * using persisted chapter `chunkGlossaries` and `glossary` snapshots in chapter order.
 * Terms not found in chapter snapshots (e.g. manually added terms) are appended at
 * the end preserving their existing relative order.
 */
export function recoverGlossaryOrderFromChapters(
  entries: GlossaryEntry[],
  chapters: Array<{ index?: number; chunkGlossaries?: string[]; glossary?: string }>
): GlossaryEntry[] {
  if (entries.length <= 1 || !chapters || chapters.length === 0) {
    return entries.map(e => ({ ...e }));
  }

  const sortedChapters = [...chapters].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const rankByNormKey = new Map<string, number>();
  let nextRank = 0;

  const recordFromText = (text?: string | null) => {
    if (!text || !text.trim()) return;
    for (const item of parseGlossaryEntries(text)) {
      const normKey = normalizeGlossaryKey(item.key);
      if (normKey && !rankByNormKey.has(normKey)) {
        rankByNormKey.set(normKey, nextRank++);
      }
    }
  };

  for (const ch of sortedChapters) {
    if (ch.chunkGlossaries && ch.chunkGlossaries.length > 0) {
      for (const chunkStr of ch.chunkGlossaries) {
        recordFromText(chunkStr);
      }
    }
    if (ch.glossary) {
      recordFromText(ch.glossary);
    }
  }

  if (rankByNormKey.size === 0) {
    return entries.map(e => ({ ...e }));
  }

  return entries
    .map((entry, idx) => ({
      entry: { key: entry.key, value: entry.value },
      rank: rankByNormKey.get(normalizeGlossaryKey(entry.key)),
      idx
    }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) {
        return a.rank - b.rank || a.idx - b.idx;
      }
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.idx - b.idx;
    })
    .map(item => item.entry);
}

const GENERIC_COMPONENT_WORDS = new Set([
  'about', 'administration', 'after', 'against', 'agency', 'alliance', 'american',
  'army', 'association', 'authority', 'back', 'bank', 'before', 'between', 'black',
  'blade', 'blood', 'board', 'book', 'british', 'bureau', 'case', 'center', 'centre',
  'chapter', 'church', 'city', 'clan', 'code', 'college', 'commission', 'committee',
  'company', 'corporation', 'council', 'court', 'crown', 'dark', 'dawn', 'department',
  'division', 'during', 'east', 'economic', 'economics', 'edition', 'european',
  'exchange', 'federal', 'federation', 'figure', 'fire', 'first', 'force', 'forest',
  'form', 'foundation', 'free', 'from', 'fund', 'gate', 'global', 'good', 'great',
  'group', 'guild', 'hall', 'hand', 'head', 'health', 'heart', 'high', 'history',
  'home', 'house', 'human', 'index', 'institute', 'international', 'into', 'island',
  'journal', 'king', 'lady', 'lake', 'land', 'last', 'laws', 'left', 'life', 'light',
  'line', 'little', 'long', 'lord', 'mark', 'market', 'markets', 'medical', 'mind',
  'ministry', 'model', 'modern', 'moon', 'moral', 'mountain', 'name', 'national',
  'network', 'night', 'north', 'note', 'notes', 'office', 'order', 'organisation',
  'organization', 'over', 'page', 'pages', 'paper', 'part', 'party', 'place', 'plan',
  'point', 'policy', 'post', 'power', 'press', 'program', 'programme', 'project',
  'public', 'queen', 'real', 'report', 'research', 'revenue', 'review', 'right',
  'ring', 'river', 'road', 'room', 'rule', 'school', 'science', 'sciences', 'section',
  'series', 'service', 'services', 'side', 'social', 'society', 'soul', 'south',
  'standard', 'star', 'state', 'states', 'stone', 'studies', 'study', 'sword',
  'system', 'table', 'temple', 'that', 'theory', 'this', 'through', 'time', 'times',
  'tower', 'town', 'true', 'type', 'under', 'union', 'united', 'university', 'valley',
  'view', 'volume', 'ward', 'water', 'west', 'white', 'wind', 'with', 'without',
  'word', 'work', 'world', 'year',
]);

const ASCII_TERM_RE = /^[a-z0-9\s\-'.\u2018\u2019]+$/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes full-width ASCII characters (U+FF01..U+FF5E, e.g. "ＡＩ", "ＳＦ", "ｗｅｂ"),
 * full-width spaces (U+3000), and curly apostrophes into standard half-width ASCII while
 * preserving letter case.
 */
export function normalizeTextForGlossarySearch(text: string): string {
  if (!text) return '';
  if (!/[\uFF01-\uFF5E\u3000\u2018\u2019]/.test(text)) {
    return text;
  }
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/[\u2018\u2019]/g, "'");
}

/**
 * Canonical comparison key for glossary deduplication & lookup across width and case variants
 * (e.g. "ＡＩ" and "ai" map to the same canonical key "ai").
 */
export function normalizeGlossaryKey(key: string): string {
  return normalizeTextForGlossarySearch(key).trim().toLowerCase();
}

/**
 * Generates lightweight morphological variants for a lowercased English word
 * (plurals, -ies/-y, -ves/-f(e), -ed/-ing) without heavy NLP dependencies.
 */
export function generateEnglishSearchForms(lowerWord: string): string[] {
  const forms = new Set<string>([lowerWord]);
  const len = lowerWord.length;

  if (len < 3 || !/^[a-z]+$/.test(lowerWord)) {
    return Array.from(forms);
  }

  // Inflected -> base / sibling forms
  if (lowerWord.endsWith('ies') && len > 4) {
    const stem = lowerWord.slice(0, -3);
    forms.add(`${stem}y`);
    forms.add(`${stem}ie`);
  } else if (lowerWord.endsWith('ves') && len > 4) {
    const stem = lowerWord.slice(0, -3);
    forms.add(`${stem}f`);
    forms.add(`${stem}fe`);
  } else if (lowerWord.endsWith('es') && len > 4) {
    forms.add(lowerWord.slice(0, -2));
  } else if (lowerWord.endsWith('s') && !lowerWord.endsWith('ss') && len > 3) {
    forms.add(lowerWord.slice(0, -1));
  }

  if (lowerWord.endsWith('ied') && len > 4) {
    forms.add(`${lowerWord.slice(0, -3)}y`);
  } else if (lowerWord.endsWith('ed') && len > 4) {
    const stem = lowerWord.slice(0, -2);
    forms.add(stem);
    forms.add(`${stem}e`);
  }

  if (lowerWord.endsWith('ing') && len > 5) {
    const stem = lowerWord.slice(0, -3);
    forms.add(stem);
    forms.add(`${stem}e`);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      forms.add(stem.slice(0, -1));
    }
  }

  // Base -> common inflected forms
  if (lowerWord.endsWith('y') && len >= 4 && !/[aeiou]y$/.test(lowerWord)) {
    forms.add(`${lowerWord.slice(0, -1)}ies`);
  } else if (lowerWord.endsWith('fe') && len >= 4) {
    forms.add(`${lowerWord.slice(0, -2)}ves`);
  } else if (lowerWord.endsWith('f') && len >= 4) {
    forms.add(`${lowerWord.slice(0, -1)}ves`);
  }

  return Array.from(forms);
}

/**
 * Checks if a lowercased term appears in pre-lowercased posterior text.
 * Short ASCII terms (<= 5 chars) use word-boundary matching to avoid
 * substring false positives (e.g. "art" matching "start").
 */
function hasTermInLowerText(lowerTerm: string, normalizedLowerText: string): boolean {
  if (!lowerTerm || !normalizedLowerText) return false;

  const normTerm = normalizeTextForGlossarySearch(lowerTerm).toLowerCase();

  if (ASCII_TERM_RE.test(normTerm) && normTerm.length <= 5) {
    const boundaryRe = new RegExp(`(?<![a-z0-9])${escapeRegExp(normTerm)}(?:s|es)?(?![a-z0-9])`);
    return boundaryRe.test(normalizedLowerText);
  }

  return normalizedLowerText.includes(normTerm);
}

const ACRONYM_STOP_WORDS = new Set([
  'of', 'the', 'and', 'in', 'on', 'for', 'to', 'a', 'an', 'at', 'by', 'with',
  'from', 'as', 'de', 'la', 'du', 'des', 'von', 'van'
]);

const TITLE_CASE_MINOR_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet',
  'at', 'by', 'for', 'from', 'in', 'into', 'of', 'off', 'on', 'onto',
  'out', 'over', 'per', 'to', 'up', 'via', 'with', 'as', 'vs', 'v'
]);

const NAME_SUFFIX_RE = /^(?:jr|sr|ii|iii|iv|v|phd|md|dds|jd|esq)$/i;

const HONORIFIC_PREFIX_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Rev|Sen|Rep|Gov|Gen|Col|Capt|Lt|Sgt|Fr|Sr)\.$/;

function isAllLowercaseAsciiTerm(normKey: string): boolean {
  const trimmed = normKey.trim();
  return (
    Boolean(trimmed) &&
    !/[A-Z]/.test(trimmed) &&
    /^[a-z][a-z0-9\s\-'.]*$/.test(trimmed)
  );
}

/**
 * Generates morphological variants for a lowercased single word, hyphenated compound,
 * or multi-word ASCII phrase by varying the final alphabetic segment
 * (e.g. "black markets" -> ["black markets", "black market"],
 * "trade-offs" -> ["trade-offs", "trade-off"]).
 */
function generatePhraseSearchForms(lowerPhrase: string): string[] {
  const trimmed = lowerPhrase.trim();
  if (!trimmed) return [];
  if (/^[a-z]+$/.test(trimmed)) {
    return generateEnglishSearchForms(trimmed);
  }
  const tailMatch = trimmed.match(/^(.*[\s-])([a-z]{3,})$/);
  if (!tailMatch) {
    return [trimmed];
  }
  const [, prefix, lastWord] = tailMatch;
  const tailForms = generateEnglishSearchForms(lastWord);
  return Array.from(new Set(tailForms.map((f) => `${prefix}${f}`)));
}

/**
 * Returns true if `normKey` is a pure ASCII term containing uppercase letters only
 * in simple Title-Case word-initial positions (including hyphenated compounds like
 * "Self-Interest" or "Peer-to-Peer"), excluding acronyms ("IVF", "AI", "PNAS")
 * and mixed-case brands/surnames ("iPhone", "McDonald", "X-Ray", "AI-Powered").
 */
function isSimpleTitleCaseAsciiTerm(normKey: string): boolean {
  const trimmed = normKey.trim();
  if (!trimmed || !ASCII_TERM_RE.test(trimmed) || !/[A-Z]/.test(trimmed)) {
    return false;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  for (const rawWord of words) {
    const cleaned = rawWord.replace(/^[^A-Za-z0-9]+|(?:'s|[^A-Za-z0-9]+)$/g, '');
    if (!cleaned || !/[A-Z]/.test(cleaned)) continue;
    const subParts = cleaned.split('-').filter(Boolean);
    if (subParts.length === 0) return false;
    for (const part of subParts) {
      if (!/[A-Z]/.test(part)) continue;
      // Any segment with 2+ uppercase letters, single-letter uppercase ("X-Ray"), or internal uppercase ("iPhone", "McDonald") is proper/technical
      if (!/^[A-Z][a-z]+$/.test(part)) {
        return false;
      }
    }
  }
  return true;
}

function isTitleCaseHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 100) return false;
  if (/[.!?,;。！？，；]$/.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;

  let capCount = 0;
  for (const rawToken of tokens) {
    const cleaned = rawToken.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!cleaned || /^\d+$/.test(cleaned)) continue;
    const lower = cleaned.toLowerCase();
    if (/^[A-Z]/.test(cleaned)) {
      capCount++;
      continue;
    }
    if (TITLE_CASE_MINOR_WORDS.has(lower)) {
      continue;
    }
    // Found a lowercase non-stopword content word -> ordinary prose, not a Title-Case heading
    return false;
  }
  return capCount >= 2;
}

function countTermOccurrencesInLowerTexts(
  forms: string[],
  lowerTargets: string[],
  cap: number
): number {
  const uniqueNorm = Array.from(
    new Set(
      forms
        .map((f) => normalizeTextForGlossarySearch(f).trim().toLowerCase())
        .filter(Boolean)
    )
  ).sort((a, b) => b.length - a.length);

  if (uniqueNorm.length === 0 || lowerTargets.length === 0) return 0;

  const endsWithAsciiLetters = uniqueNorm.every((f) => /[a-z]$/.test(f));
  const pattern = uniqueNorm.map(escapeRegExp).join('|');
  const suffix = endsWithAsciiLetters ? '(?:s|es)?' : '';
  const countRe = new RegExp(`(?<![a-z0-9])(?:${pattern})${suffix}(?![a-z0-9])`, 'g');

  let total = 0;
  for (const target of lowerTargets) {
    if (!target) continue;
    countRe.lastIndex = 0;
    while (countRe.exec(target) !== null) {
      total++;
      if (total >= cap) return total;
    }
  }
  return total;
}

function hasLowercaseOccurrenceInRawTexts(
  lowerForms: string[],
  rawTexts: string[]
): boolean {
  const unique = Array.from(new Set(lowerForms.filter(Boolean))).sort((a, b) => b.length - a.length);
  if (unique.length === 0 || rawTexts.length === 0) return false;
  const endsWithAsciiLetters = unique.every((f) => /[a-z]$/.test(f));
  const pattern = unique.map(escapeRegExp).join('|');
  const suffix = endsWithAsciiLetters ? '(?:s|es)?' : '';
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${pattern})${suffix}(?![A-Za-z0-9])`);
  return rawTexts.some((t) => t && re.test(t));
}

function hasMidSentenceCapitalizedOccurrence(
  titleForms: string[],
  rawTexts: string[]
): boolean {
  const unique = Array.from(new Set(titleForms.filter(Boolean))).sort((a, b) => b.length - a.length);
  if (unique.length === 0 || rawTexts.length === 0) return false;
  const endsWithAsciiLetters = unique.every((f) => /[A-Za-z]$/.test(f));
  const pattern = unique.map(escapeRegExp).join('|');
  const suffix = endsWithAsciiLetters ? "(?:'s|s|es)?" : '';
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${pattern})${suffix}(?![A-Za-z0-9])`, 'g');

  for (const raw of rawTexts) {
    if (!raw) continue;
    // Ignore Markdown headings and standalone Title-Case heading lines
    // (often Title-Cased regardless of whether words are common nouns)
    const bodyText = raw
      .split('\n')
      .map((line) => (/^#{1,6}\s+/.test(line) || isTitleCaseHeadingLine(line) ? '' : line))
      .join('\n');
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(bodyText)) !== null) {
      const idx = match.index;
      const prefix = bodyText.slice(Math.max(0, idx - 28), idx);

      // Line / paragraph start
      const lastNewline = prefix.lastIndexOf('\n');
      if (lastNewline >= 0) {
        const afterNl = prefix.slice(lastNewline + 1);
        if (/^[\s"'“‘(\[•·*-]*$/.test(afterNl)) continue;
      }

      // Direct-speech opening quote (e.g. `He said, "Heroin...`)
      if (/[,:]\s*["'“‘]+$/.test(prefix)) continue;

      const before = prefix.replace(/[\s"'“‘”’(\[—–-]+$/, '');
      if (!before) continue;

      // Reject ALL-CAPS preceding words (e.g. `PROTECTION FROM HARM`)
      if (/[A-Z]{2,}$/.test(before)) continue;

      // Reject sentence-initial positions (except after known honorifics like "Dr. Kahneman")
      if (/[.!?。！？:：]$/.test(before)) {
        if (HONORIFIC_PREFIX_RE.test(before)) {
          return true;
        }
        continue;
      }

      // Accept genuine mid-sentence context: after lowercase word, single-letter "A"/"I", digit, or CJK
      if (
        /[a-z][,;\)\]]*$/.test(before) ||
        /(?:^|[\s"'“‘(\[])[AI]$/.test(before) ||
        /\d$/.test(before) ||
        /[\u4e00-\u9fff\u3040-\u30ff]$/.test(before)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detects when an LLM artificially capitalized an ordinary lowercase word/phrase
 * (e.g. "Heroin", "Tradeoffs", "Cake", "Black Market", "Self-Interest") by checking
 * whether it appears in lowercase in the book corpus while never appearing capitalized mid-sentence.
 */
function isDemotedToLowercaseByCorpusCasing(normKey: string, corpusRawTexts: string[]): boolean {
  if (corpusRawTexts.length === 0 || !isSimpleTitleCaseAsciiTerm(normKey)) {
    return false;
  }

  const lowerKey = normKey.toLowerCase();
  const lowerForms = generatePhraseSearchForms(lowerKey);

  if (!hasLowercaseOccurrenceInRawTexts(lowerForms, corpusRawTexts)) {
    return false;
  }

  const isSingleAsciiWord = /^[a-z]+$/.test(lowerKey);
  const titleForms = isSingleAsciiWord
    ? lowerForms.map((f) => f[0].toUpperCase() + f.slice(1))
    : Array.from(
        new Set([
          normKey,
          ...lowerForms.map((f) =>
            f.replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`)
          )
        ])
      );

  return !hasMidSentenceCapitalizedOccurrence(titleForms, corpusRawTexts);
}

function extractDistinctiveCapitalizedComponents(normKey: string): {
  baseWithoutSuffix: string | null;
  firstLastPhrase: string | null;
  components: string[];
} {
  const rawWords = normKey
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|(?:'s|[^A-Za-z0-9]+)$/g, ''))
    .filter(Boolean);

  if (rawWords.length < 2 || rawWords.length > 4) {
    return { baseWithoutSuffix: null, firstLastPhrase: null, components: [] };
  }

  // Strip trailing generational/degree suffixes (e.g. "Martin Luther King Jr.", "Alvin E. Roth, PhD")
  let trimmedWords = rawWords;
  let baseWithoutSuffix: string | null = null;
  while (trimmedWords.length >= 3 && NAME_SUFFIX_RE.test(trimmedWords[trimmedWords.length - 1])) {
    trimmedWords = trimmedWords.slice(0, -1);
    baseWithoutSuffix = trimmedWords.join(' ').toLowerCase();
  }

  if (trimmedWords.length < 2 || trimmedWords.length > 3) {
    return { baseWithoutSuffix, firstLastPhrase: null, components: [] };
  }

  // Strip leading English article ("The Dark Forest" -> ["Dark", "Forest"])
  const leadingLower = trimmedWords[0].toLowerCase();
  const contentWords =
    trimmedWords.length === 3 && (leadingLower === 'the' || leadingLower === 'a' || leadingLower === 'an')
      ? trimmedWords.slice(1)
      : trimmedWords;

  const isThreeWordAllCapName =
    contentWords.length === 3 && contentWords.every((w) => /^[A-Z]/.test(w));

  const firstLastPhrase = isThreeWordAllCapName
    ? `${contentWords[0]} ${contentWords[2]}`.toLowerCase()
    : null;

  // For 3-word all-capitalized names (e.g. "Alan Page Fiske", "Alvin E. Roth"),
  // never fall back to the middle name ("Page") or standalone first name ("Alan");
  // allow only the surname (last word) plus the contiguous "First Last" form.
  const candidateWords = isThreeWordAllCapName
    ? [contentWords[2]]
    : contentWords.filter((w) => /^[A-Z]/.test(w));

  const components = candidateWords.filter((w) => {
    const lower = w.toLowerCase();
    return lower.length >= 4 && !GENERIC_COMPONENT_WORDS.has(lower);
  });

  return { baseWithoutSuffix, firstLastPhrase, components };
}

function hasCapitalizedComponentInRawTexts(component: string, rawTargets: string[]): boolean {
  if (!component || rawTargets.length === 0) return false;
  const lower = component.toLowerCase();
  const baseForms = /^[a-z]+$/.test(lower) ? generateEnglishSearchForms(lower) : [lower];
  const casedForms = new Set<string>([component, component.toUpperCase()]);
  for (const f of baseForms) {
    if (!f) continue;
    casedForms.add(f[0].toUpperCase() + f.slice(1));
    casedForms.add(f.toUpperCase());
  }
  const pattern = Array.from(casedForms)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?:'s|s|es)?(?![A-Za-z0-9])`);
  return rawTargets.some((target) => target && re.test(target));
}

function extractPhraseAcronym(normKey: string): string | null {
  let words = normKey
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''))
    .filter(Boolean);

  // Strip trailing generational/degree suffixes so "John F. Kennedy Jr." -> "JFK"
  while (words.length >= 3 && NAME_SUFFIX_RE.test(words[words.length - 1])) {
    words = words.slice(0, -1);
  }

  const letters: string[] = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (ACRONYM_STOP_WORDS.has(lower)) continue;
    if (/^[A-Z]/.test(w)) {
      letters.push(w[0].toUpperCase());
    }
  }

  return letters.length >= 3 ? letters.join('') : null;
}

function hasAcronymInTargets(
  upperAcronym: string,
  rawTargets: string[] | undefined,
  lowerTargets: string[]
): boolean {
  if (!upperAcronym) return false;
  if (rawTargets && rawTargets.length > 0) {
    const upperRe = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(upperAcronym)}(?![A-Za-z0-9])`, 'g');
    for (const target of rawTargets) {
      if (!target) continue;
      upperRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = upperRe.exec(target)) !== null) {
        const before = target.slice(Math.max(0, match.index - 16), match.index);
        const after = target.slice(match.index + match[0].length, match.index + match[0].length + 16);
        // Reject matches sitting inside an ALL-CAPS heading run (e.g. "PART II: WHO WE ARE")
        const precededByAllCapsWord = /[A-Z]{2,}\s+$/.test(before);
        const followedByAllCapsWord = /^\s+[A-Z]{2,}/.test(after);
        if (precededByAllCapsWord || followedByAllCapsWord) {
          continue;
        }
        return true;
      }
    }
    return false;
  }
  const lowerRe = new RegExp(`(?<![a-z0-9])${escapeRegExp(upperAcronym.toLowerCase())}(?![a-z0-9])`);
  return lowerTargets.some((target) => target && lowerRe.test(target));
}

export interface PosteriorSearchInput {
  lowerTexts: string[];
  rawTexts?: string[];
  sourceText?: string;
}

export interface FilterDeltaOptions {
  sourceText?: string;
  verifyCasing?: boolean;
}

export interface FilterDeltaResult {
  filteredText: string;
  originalCount: number;
  filteredCount: number;
}

/**
 * Filters candidate terms in deltaGlossary by searching posterior text.
 * 1. Normalizes full-width ASCII <-> half-width ASCII (e.g. "ＡＩ" <-> "AI") and
 *    case-insensitively strips out terms already present in currentGlossary.
 * 2. If posterior text is empty (e.g. final chapter), keeps all new candidates.
 * 3. Applies tiered thresholds & case-aware multi-word matching:
 *    - All-lowercase ASCII common terms (and LLM-capitalized ordinary words when casing
 *      verification is active via `sourceText` or `verifyCasing`) must appear >= 3 times
 *      in posterior text.
 *    - Capitalized proper nouns / acronyms / non-ASCII terms require >= 1 match.
 *    - 2–3 word capitalized entities may match via distinctive capitalized component words
 *      matched case-sensitively (with 3-word person names skipping middle/first names and
 *      allowing "First Last" or surname); 4+ word titles/journals require full phrase match
 *      or uppercase derived acronym (e.g. PNAS).
 */
export function filterGlossaryDeltaByPosterior(
  deltaGlossaryText: string,
  currentGlossaryText: string,
  posteriorTextOrPrecomputed: string | PosteriorSearchInput,
  options?: FilterDeltaOptions
): FilterDeltaResult {
  if (!deltaGlossaryText) return { filteredText: "", originalCount: 0, filteredCount: 0 };

  const deltaEntries = parseGlossaryEntries(deltaGlossaryText);
  const currentEntries = parseGlossaryEntries(currentGlossaryText);

  const originalCount = deltaEntries.length;
  if (originalCount === 0) return { filteredText: "", originalCount: 0, filteredCount: 0 };

  // 1. Case-insensitive & width-normalized deduplication against currentGlossary and within deltaEntries
  const seenLowerKeys = new Set(currentEntries.map((e) => normalizeGlossaryKey(e.key)));
  const newCandidates: GlossaryEntry[] = [];
  for (const entry of deltaEntries) {
    const lowerKey = normalizeGlossaryKey(entry.key);
    if (!seenLowerKeys.has(lowerKey)) {
      seenLowerKeys.add(lowerKey);
      newCandidates.push(entry);
    }
  }

  // 2. Normalize posterior search targets (preserving case when rawTexts/string is available)
  let lowerTargets: string[];
  let rawTargets: string[] | undefined;
  let sourceText: string | undefined = options?.sourceText;

  if (typeof posteriorTextOrPrecomputed === 'string') {
    const normRaw = normalizeTextForGlossarySearch(posteriorTextOrPrecomputed).trim();
    rawTargets = normRaw ? [normRaw] : [];
    lowerTargets = normRaw ? [normRaw.toLowerCase()] : [];
  } else {
    lowerTargets = posteriorTextOrPrecomputed.lowerTexts
      .map((t) => normalizeTextForGlossarySearch(t).trim().toLowerCase())
      .filter(Boolean);
    if (posteriorTextOrPrecomputed.rawTexts) {
      rawTargets = posteriorTextOrPrecomputed.rawTexts
        .map((t) => normalizeTextForGlossarySearch(t).trim())
        .filter(Boolean);
    }
    if (sourceText === undefined) {
      sourceText = posteriorTextOrPrecomputed.sourceText;
    }
  }

  if (lowerTargets.length === 0) {
    return {
      filteredText: glossaryEntriesToOutputStr(newCandidates),
      originalCount,
      filteredCount: newCandidates.length
    };
  }

  const shouldVerifyCasing = sourceText !== undefined || options?.verifyCasing === true;
  const corpusRawTexts: string[] = shouldVerifyCasing
    ? [
        ...(sourceText ? [normalizeTextForGlossarySearch(sourceText).trim()] : []),
        ...(rawTargets || [])
      ].filter(Boolean)
    : [];

  // 3. Match each candidate against posterior text slices with tiered thresholds
  const keptEntries: GlossaryEntry[] = [];
  const matchesAnyTarget = (term: string) =>
    lowerTargets.some((target) => hasTermInLowerText(term, target));

  for (const entry of newCandidates) {
    const { key, value: val } = entry;
    const normKey = normalizeTextForGlossarySearch(key).trim();
    const lowerKey = normKey.toLowerCase();

    const treatAsLowercaseCommon =
      isAllLowercaseAsciiTerm(normKey) ||
      (shouldVerifyCasing && isDemotedToLowercaseByCorpusCasing(normKey, corpusRawTexts));

    if (treatAsLowercaseCommon) {
      const forms = generatePhraseSearchForms(lowerKey);
      if (countTermOccurrencesInLowerTexts(forms, lowerTargets, 3) >= 3) {
        keptEntries.push({ key, value: val });
      }
      continue;
    }

    const words = normKey.split(/\s+/).filter(Boolean);

    if (matchesAnyTarget(lowerKey)) {
      keptEntries.push({ key, value: val });
      continue;
    }

    // Morphological variants for single ASCII words and multi-word ASCII phrases (e.g. "Black Markets" -> "black market")
    if (ASCII_TERM_RE.test(lowerKey)) {
      const variants = generatePhraseSearchForms(lowerKey).filter((v) => v !== lowerKey);
      if (variants.some((v) => matchesAnyTarget(v))) {
        keptEntries.push({ key, value: val });
        continue;
      }
    }

    // 2–3 word capitalized entities (plus 4-word names with suffixes like "Jr." / "PhD"):
    // allow suffixless full name, "First Last" (for 3-word names), or case-sensitive distinctive component
    if (words.length >= 2 && words.length <= 4) {
      const { baseWithoutSuffix, firstLastPhrase, components } =
        extractDistinctiveCapitalizedComponents(normKey);
      if (baseWithoutSuffix && matchesAnyTarget(baseWithoutSuffix)) {
        keptEntries.push({ key, value: val });
        continue;
      }
      if (firstLastPhrase && matchesAnyTarget(firstLastPhrase)) {
        keptEntries.push({ key, value: val });
        continue;
      }
      const matchedComponent = components.find((comp) =>
        rawTargets && rawTargets.length > 0
          ? hasCapitalizedComponentInRawTexts(comp, rawTargets)
          : generateEnglishSearchForms(comp.toLowerCase()).some((variant) => matchesAnyTarget(variant))
      );
      if (matchedComponent) {
        keptEntries.push({ key, value: val });
        continue;
      }
    }

    // 3+ word capitalized organizations / titles / journals: allow case-sensitive derived acronym (e.g. WHO, IMF, FDA, PNAS, JFK)
    if (words.length >= 3) {
      const acronym = extractPhraseAcronym(normKey);
      if (acronym && hasAcronymInTargets(acronym, rawTargets, lowerTargets)) {
        keptEntries.push({ key, value: val });
        continue;
      }
    }
  }

  return {
    filteredText: glossaryEntriesToOutputStr(keptEntries),
    originalCount,
    filteredCount: keptEntries.length
  };
}

export interface GlossaryDriftFix {
  key: string;
  oldVal: string;
  newVal: string;
  count: number;
}

export interface ReconcileDriftResult {
  fixedText: string;
  fixes: GlossaryDriftFix[];
}

/**
 * Strips trailing parenthetical gender/identity notes like "(男)" or "（女）"
 * so comparisons and prose replacements use the pure translated term.
 */
export function stripTrailingParenNote(val: string): string {
  return val.replace(/\s*[（(][^()（）]{1,12}[)）]\s*$/, '').trim();
}

/**
 * Detects terminology drift where deltaGlossary proposes a different translation
 * for a key already established in currentGlossary, and unifies occurrences in
 * the translated chunk (and optional footnotes) back to the established translation.
 * Also guards against untranslated ASCII glossary source-key leaks (e.g. "Ash" or
 * lowercase speaker label "ash：" when "Ash=阿什" is already established).
 */
export function reconcileGlossaryDrift(
  translatedText: string,
  deltaGlossaryText: string,
  currentGlossaryText: string,
  chunkFootnotes?: Record<string, string>
): ReconcileDriftResult {
  if (!currentGlossaryText) {
    return { fixedText: translatedText, fixes: [] };
  }

  const baseEntries = parseGlossaryEntries(currentGlossaryText);
  const baseLowerMap = new Map<string, string>();
  for (const { key: k, value: v } of baseEntries) {
    const norm = normalizeGlossaryKey(k);
    if (!baseLowerMap.has(norm)) {
      baseLowerMap.set(norm, v);
    }
  }

  let fixedText = translatedText;
  const fixes: GlossaryDriftFix[] = [];

  // Pass 1: Reconcile conflicting translations proposed in deltaGlossary
  if (deltaGlossaryText) {
    const deltaEntries = parseGlossaryEntries(deltaGlossaryText);
    for (const { key, value: rawNewVal } of deltaEntries) {
      const rawOldVal = baseLowerMap.get(normalizeGlossaryKey(key));
      if (!rawOldVal) continue;

      const oldVal = stripTrailingParenNote(rawOldVal);
      const newVal = stripTrailingParenNote(rawNewVal);
      if (!oldVal || !newVal || oldVal === newVal) continue;

      // Guard against single-character false replacements in prose
      if (newVal.length < 2) continue;

      let count = 0;
      const bodyRes = safeReplaceKeyword(fixedText, newVal, oldVal);
      if (bodyRes.count > 0) {
        fixedText = bodyRes.replacedText;
        count += bodyRes.count;
      }

      if (chunkFootnotes) {
        for (const fnId of Object.keys(chunkFootnotes)) {
          const fnVal = chunkFootnotes[fnId];
          if (fnVal) {
            const fnRes = safeReplaceKeyword(fnVal, newVal, oldVal);
            if (fnRes.count > 0) {
              chunkFootnotes[fnId] = fnRes.replacedText;
              count += fnRes.count;
            }
          }
        }
      }

      if (count > 0) {
        fixes.push({ key, oldVal, newVal, count });
      }
    }
  }

  // Pass 2: Guard against untranslated ASCII source-key leaks for established glossary entries
  for (const { key: rawKey, value: rawEstablishedVal } of baseEntries) {
    const key = rawKey.trim();
    const establishedVal = stripTrailingParenNote(rawEstablishedVal);
    if (!key || !establishedVal) continue;
    if (key.length < 3) continue;
    if (!/^[A-Za-z][A-Za-z0-9\s\-'.]*$/.test(key)) continue;

    const lowerKey = key.toLowerCase();
    const lowerEst = establishedVal.toLowerCase();
    // Skip pass-through terms (e.g. Waymo=Waymo) and self-containing glosses (e.g. LLM=大语言模型（LLM）)
    if (lowerKey === lowerEst || lowerEst.includes(lowerKey)) continue;

    let count = 0;
    const bodyRes = safeReplaceKeyword(fixedText, key, establishedVal, { caseInsensitive: true });
    if (bodyRes.count > 0) {
      fixedText = bodyRes.replacedText;
      count += bodyRes.count;
    }

    if (chunkFootnotes) {
      for (const fnId of Object.keys(chunkFootnotes)) {
        const fnVal = chunkFootnotes[fnId];
        if (fnVal) {
          const fnRes = safeReplaceKeyword(fnVal, key, establishedVal, { caseInsensitive: true });
          if (fnRes.count > 0) {
            chunkFootnotes[fnId] = fnRes.replacedText;
            count += fnRes.count;
          }
        }
      }
    }

    if (count > 0) {
      fixes.push({ key, oldVal: establishedVal, newVal: key, count });
    }
  }

  return { fixedText, fixes };
}

export interface TermChange {
  sourceKey: string;
  oldTarget: string;
  newTarget: string;
}

/**
 * Safely replaces a keyword in translated content while protecting markdown syntax,
 * code blocks, images, links, HTML tags, parenthetical English glosses after CJK text,
 * and footnote slots/definitions.
 */
export function safeReplaceKeyword(
  content: string,
  oldWord: string,
  newWord: string,
  options?: { caseInsensitive?: boolean }
): { replacedText: string; count: number } {
  if (!content || !oldWord || !oldWord.trim() || oldWord === newWord) {
    return { replacedText: content, count: 0 };
  }
  const protectedPattern =
    /(```[\s\S]*?```|`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\]\([^)\s]+\)|<[^>]+>|\{\{TRANSLITFNSLOT:[A-Za-z0-9_-]+\}\}|__FN_REF_[A-Za-z0-9_-]+__|\[\^[^\]]+\]|(?:\[|【)\s*FN_DEF[:：][\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|$)|(?<=[\u4e00-\u9fff])\s*[（(][A-Za-z0-9][A-Za-z0-9\s\-'.]{0,40}[)）])/g;

  const trimmedOld = oldWord.trim();
  const isAsciiPhrase =
    /^[A-Za-z0-9]$/.test(trimmedOld) ||
    /^[A-Za-z0-9][A-Za-z0-9\s\-'.]*[A-Za-z0-9]$/.test(trimmedOld);
  const flags = options?.caseInsensitive ? 'gi' : 'g';
  const createRegex = () =>
    isAsciiPhrase
      ? new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(trimmedOld)}(?![A-Za-z0-9])`, flags)
      : new RegExp(escapeRegExp(oldWord), flags);

  let count = 0;
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = protectedPattern.exec(content)) !== null) {
    const prose = content.substring(lastIndex, match.index);
    if (prose) {
      const regex = createRegex();
      const replacedProse = prose.replace(regex, () => {
        count++;
        return newWord;
      });
      parts.push(replacedProse);
    }
    parts.push(match[0]);
    lastIndex = match.index + match[0].length;
  }

  const trailingProse = content.substring(lastIndex);
  if (trailingProse) {
    const regex = createRegex();
    const replacedTrailing = trailingProse.replace(regex, () => {
      count++;
      return newWord;
    });
    parts.push(replacedTrailing);
  }

  return { replacedText: parts.join(''), count };
}

/**
 * Compares old and new glossary dictionaries and returns target-term changes
 * (with trailing gender notes stripped so prose replacements match actual text).
 */
export function detectGlossaryChanges(
  oldMap: Record<string, string>,
  newMap: Record<string, string>
): TermChange[] {
  const changes: TermChange[] = [];
  for (const [key, newVal] of Object.entries(newMap)) {
    const oldVal = oldMap[key];
    const parsedNew = stripTrailingParenNote(parseGlossaryValue(newVal));
    if (!parsedNew) continue;

    if (oldVal !== undefined) {
      const parsedOld = stripTrailingParenNote(parseGlossaryValue(oldVal));
      if (parsedOld && parsedOld !== parsedNew) {
        changes.push({ sourceKey: key, oldTarget: parsedOld, newTarget: parsedNew });
      }
    } else {
      const trimmedKey = key.trim();
      if (
        trimmedKey &&
        trimmedKey !== parsedNew &&
        !trimmedKey.startsWith('新词条_') &&
        !trimmedKey.startsWith('new_term_')
      ) {
        changes.push({ sourceKey: trimmedKey, oldTarget: trimmedKey, newTarget: parsedNew });
      }
    }
  }
  return changes;
}

/**
 * Filters term changes for safe automatic retroactive cascading to prior chunks/chapters.
 * Prevents short-word false positives and self-containing nested replacements (e.g. LLM -> 大语言模型（LLM）).
 */
export function filterSafeCascadeChanges(changes: TermChange[]): TermChange[] {
  return changes.filter(c => {
    const oldT = c.oldTarget.trim();
    const newT = c.newTarget.trim();
    if (!oldT || !newT) return false;
    const lowerOld = oldT.toLowerCase();
    const lowerNew = newT.toLowerCase();
    if (lowerOld === lowerNew) return false;
    if (lowerNew.includes(lowerOld)) return false;
    if (/^[A-Za-z0-9\s\-'.]+$/.test(oldT) && oldT.length < 3) return false;
    return oldT.length >= 2;
  });
}

/**
 * Merges per-chunk delta glossary strings for a chapter into a single
 * deduplicated glossary string representing terms newly extracted in that chapter.
 */
export function mergeChunkGlossaries(chunkGlossaries?: (string | undefined | null)[]): string {
  if (!chunkGlossaries || chunkGlossaries.length === 0) return '';

  const merged: GlossaryEntry[] = [];
  const seenLower = new Set<string>();

  for (const chunkStr of chunkGlossaries) {
    if (!chunkStr || !chunkStr.trim()) continue;
    const parsed = parseGlossaryEntries(chunkStr);
    for (const { key, value: val } of parsed) {
      const lowerKey = normalizeGlossaryKey(key);
      if (!seenLower.has(lowerKey)) {
        seenLower.add(lowerKey);
        merged.push({ key, value: val });
      }
    }
  }

  return glossaryEntriesToOutputStr(merged);
}
