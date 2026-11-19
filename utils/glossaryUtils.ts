export const parseGlossaryStr = (str: string): Record<string, string> => {
  const lines = str.split('\n');
  const result: Record<string, string> = {};
  lines.forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;

    // 1. Legacy structural format compatibility: SOURCE: xxx | TARGET: yyy
    const structuralMatch = line.match(/SOURCE:\s*(.*?)\s*\|\s*TARGET:\s*(.*)/i);
    if (structuralMatch) {
        const key = structuralMatch[1].trim();
        const value = parseGlossaryValue(structuralMatch[2]);
        if (key && value) {
            result[key] = value;
            return;
        }
    }

    // 2. Primary compact format: Key=Value
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
        const key = line.slice(0, eqIndex).trim();
        const value = parseGlossaryValue(line.slice(eqIndex + 1));
        if (key && value) {
            result[key] = value;
            return;
        }
    }

    // 3. Fallback to simple format: Key: Value
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join(':').trim();
      if (key && value && !key.toLowerCase().includes('source') && !key.toLowerCase().includes('target')) {
          result[key] = value;
      }
    }
  });
  return result;
}

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
}

export const parseGlossaryValue = (rawValue: string): string => {
  return rawValue ? rawValue.trim() : "";
};

const GENERIC_COMPONENT_WORDS = new Set([
  'about', 'after', 'against', 'army', 'before', 'between', 'black', 'blade',
  'blood', 'book', 'case', 'church', 'city', 'clan', 'code', 'council', 'court',
  'crown', 'dark', 'dawn', 'during', 'fire', 'first', 'force', 'forest', 'form',
  'from', 'gate', 'great', 'guild', 'hall', 'hand', 'head', 'heart', 'high',
  'house', 'into', 'island', 'king', 'lady', 'lake', 'land', 'last', 'life',
  'light', 'line', 'little', 'lord', 'mark', 'mind', 'moon', 'mountain', 'name',
  'night', 'order', 'over', 'part', 'power', 'queen', 'ring', 'river', 'road',
  'rule', 'side', 'soul', 'star', 'state', 'stone', 'sword', 'system', 'temple',
  'that', 'this', 'through', 'time', 'tower', 'town', 'type', 'under', 'valley',
  'ward', 'water', 'white', 'wind', 'with', 'without', 'word', 'work', 'world',
]);

const ASCII_TERM_RE = /^[a-z0-9\s\-'.\u2018\u2019]+$/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  const normTerm = lowerTerm.replace(/[\u2018\u2019]/g, "'");

  if (ASCII_TERM_RE.test(normTerm) && normTerm.length <= 5) {
    const boundaryRe = new RegExp(`(?<![a-z0-9])${escapeRegExp(normTerm)}(?:s|es)?(?![a-z0-9])`);
    return boundaryRe.test(normalizedLowerText);
  }

  return normalizedLowerText.includes(normTerm);
}

function extractDistinctiveWords(key: string): string[] {
  return key
    .replace(/[\u2018\u2019]/g, "'")
    .split(/\s+/)
    .map(w => w.replace(/^[^a-zA-Z0-9]+|(?:'s|[^a-zA-Z0-9]+)$/g, '').toLowerCase())
    .filter(w => w.length >= 4 && !GENERIC_COMPONENT_WORDS.has(w));
}

export interface FilterDeltaResult {
  filteredText: string;
  originalCount: number;
  filteredCount: number;
}

/**
 * Filters candidate terms in deltaGlossary by searching posterior text.
 * 1. Case-insensitively strips out terms already present in currentGlossary.
 * 2. If posterior text is empty (e.g. final chapter), keeps all new candidates.
 * 3. Checks direct match (with word-boundary guard for short ASCII terms),
 *    lightweight English morphological variants, and distinctive multi-word components.
 *    Accepts pre-lowercased posterior strings to avoid repeated full-book lowercasing.
 */
export function filterGlossaryDeltaByPosterior(
  deltaGlossaryText: string,
  currentGlossaryText: string,
  posteriorTextOrPrecomputed: string | { lowerTexts: string[] }
): FilterDeltaResult {
  if (!deltaGlossaryText) return { filteredText: "", originalCount: 0, filteredCount: 0 };

  const deltaMap = parseGlossaryStr(deltaGlossaryText);
  const currentMap = parseGlossaryStr(currentGlossaryText);

  const deltaEntries = Object.entries(deltaMap);
  const originalCount = deltaEntries.length;
  if (originalCount === 0) return { filteredText: "", originalCount: 0, filteredCount: 0 };

  // 1. Case-insensitive deduplication against currentGlossary and within deltaEntries
  const seenLowerKeys = new Set(Object.keys(currentMap).map(k => k.toLowerCase()));
  const newCandidates: [string, string][] = [];
  for (const [key, val] of deltaEntries) {
    const lowerKey = key.toLowerCase();
    if (!seenLowerKeys.has(lowerKey)) {
      seenLowerKeys.add(lowerKey);
      newCandidates.push([key, val]);
    }
  }

  // 2. Normalize posterior search targets without redundant .toLowerCase()
  const lowerTargets = typeof posteriorTextOrPrecomputed === 'string'
    ? [posteriorTextOrPrecomputed.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'")].filter(Boolean)
    : posteriorTextOrPrecomputed.lowerTexts
        .map(t => t.trim().replace(/[\u2018\u2019]/g, "'"))
        .filter(Boolean);

  if (lowerTargets.length === 0) {
    const filteredMap: Record<string, string> = {};
    for (const [k, v] of newCandidates) filteredMap[k] = v;
    return {
      filteredText: glossaryToOutputStr(filteredMap),
      originalCount,
      filteredCount: newCandidates.length
    };
  }

  // 3. Match each candidate against posterior text slices
  const keptMap: Record<string, string> = {};
  const matchesAnyTarget = (term: string) =>
    lowerTargets.some(target => hasTermInLowerText(term, target));

  for (const [key, val] of newCandidates) {
    const lowerKey = key.toLowerCase();

    if (matchesAnyTarget(lowerKey)) {
      keptMap[key] = val;
      continue;
    }

    // Morphological variants for single ASCII words
    if (/^[a-z]+$/.test(lowerKey)) {
      const variants = generateEnglishSearchForms(lowerKey).filter(v => v !== lowerKey);
      const matchedVariant = variants.find(v => matchesAnyTarget(v));
      if (matchedVariant) {
        keptMap[key] = val;
        continue;
      }
    }

    // Distinctive component words for multi-word phrases (skipping generic words)
    if (/\s/.test(key)) {
      const distinctiveWords = extractDistinctiveWords(key);
      const matchedWord = distinctiveWords.find(word =>
        generateEnglishSearchForms(word).some(variant => matchesAnyTarget(variant))
      );
      if (matchedWord) {
        keptMap[key] = val;
        continue;
      }
    }
  }

  return {
    filteredText: glossaryToOutputStr(keptMap),
    originalCount,
    filteredCount: Object.keys(keptMap).length
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
 */
export function reconcileGlossaryDrift(
  translatedText: string,
  deltaGlossaryText: string,
  currentGlossaryText: string,
  chunkFootnotes?: Record<string, string>
): ReconcileDriftResult {
  if (!deltaGlossaryText || !currentGlossaryText) {
    return { fixedText: translatedText, fixes: [] };
  }

  const baseMap = parseGlossaryStr(currentGlossaryText);
  const baseLowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(baseMap)) {
    baseLowerMap.set(k.toLowerCase(), v);
  }

  const deltaMap = parseGlossaryStr(deltaGlossaryText);
  let fixedText = translatedText;
  const fixes: GlossaryDriftFix[] = [];

  for (const [key, rawNewVal] of Object.entries(deltaMap)) {
    const rawOldVal = baseLowerMap.get(key.toLowerCase());
    if (!rawOldVal) continue;

    const oldVal = stripTrailingParenNote(rawOldVal);
    const newVal = stripTrailingParenNote(rawNewVal);
    if (!oldVal || !newVal || oldVal === newVal) continue;

    // Guard against single-character false replacements in prose
    if (newVal.length < 2) continue;

    const escaped = escapeRegExp(newVal);
    const re = new RegExp(escaped, 'g');
    let count = 0;

    if (fixedText.includes(newVal)) {
      fixedText = fixedText.replace(re, () => {
        count++;
        return oldVal;
      });
    }

    if (chunkFootnotes) {
      for (const fnId of Object.keys(chunkFootnotes)) {
        const fnVal = chunkFootnotes[fnId];
        if (fnVal && fnVal.includes(newVal)) {
          chunkFootnotes[fnId] = fnVal.replace(re, () => {
            count++;
            return oldVal;
          });
        }
      }
    }

    if (count > 0) {
      fixes.push({ key, oldVal, newVal, count });
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
 * code blocks, images, links, HTML tags, and footnote slots/definitions.
 */
export function safeReplaceKeyword(
  content: string,
  oldWord: string,
  newWord: string
): { replacedText: string; count: number } {
  if (!content || !oldWord || !oldWord.trim() || oldWord === newWord) {
    return { replacedText: content, count: 0 };
  }
  const protectedPattern =
    /(```[\s\S]*?```|`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\]\([^)\s]+\)|<[^>]+>|\{\{TRANSLITFNSLOT:[A-Za-z0-9_-]+\}\}|__FN_REF_[A-Za-z0-9_-]+__|\[\^[^\]]+\]|(?:\[|【)\s*FN_DEF[:：][\s\S]*?(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|$))/g;

  const isAsciiWord = /^[\w-]+$/.test(oldWord);
  const createRegex = () =>
    isAsciiWord
      ? new RegExp(`\\b${escapeRegExp(oldWord)}\\b`, 'g')
      : new RegExp(escapeRegExp(oldWord), 'g');

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
