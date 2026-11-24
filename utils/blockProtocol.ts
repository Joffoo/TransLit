/**
 * Explicit Block-ID Wire Protocol (`[B1]`, `[B2]`, ...):
 * Gives every extracted DOM leaf block a deterministic identity across LLM requests
 * so block-order swaps (e.g. swapping a body paragraph with its following <h2>)
 * and accidental heading-into-body merges are eliminated at the protocol layer.
 */

export interface EncodedBlocksResult {
  encodedText: string;
  blockCount: number;
  sourceBlocks: string[];
}

export interface DecodedBlocksResult {
  decodedText: string;
  usedBlockProtocol: boolean;
  matchedIds: number[];
  missingIds: number[];
  outOfOrderCount: number;
}

const STRAY_BLOCK_MARKER_LINE_RE =
  /(^|\n)[ \t]*(?:\[|【|〔)\s*[Bb]\s*\d+\s*(?:\]|】|〕)[ \t]*[:：]?[ \t]*/g;

const LINE_START_BLOCK_MARKER_RE =
  /(?:^|\n)[ \t]*(?:\[|【|〔)\s*[Bb]\s*(\d+)\s*(?:\]|】|〕)[ \t]*[:：]?[ \t]*/g;

/**
 * Strips any stray `[B1]` / `【B1】` / `〔B1〕` prefixes at the start of lines.
 */
export function stripBlockProtocolMarkers(text: string): string {
  if (!text) return '';
  return text.replace(STRAY_BLOCK_MARKER_LINE_RE, '$1');
}

/**
 * Encodes a `\n\n`-separated chunk of leaf DOM blocks with 1-based `[Bk]` wire IDs.
 * Leading Markdown `#` heading prefixes are stripped on the wire because target DOM tags
 * (`<h1>`..`<h6>`) already retain their heading identity in-place; stripping `#` eliminates
 * the conflict with prompts that forbid outputting `#`.
 */
export function encodeBlocksForWire(chunkText: string): EncodedBlocksResult {
  if (!chunkText || !chunkText.trim()) {
    return { encodedText: chunkText || '', blockCount: 0, sourceBlocks: [] };
  }

  const sourceBlocks = chunkText
    .split(/\r?\n\s*\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  if (sourceBlocks.length === 0) {
    return { encodedText: chunkText, blockCount: 0, sourceBlocks: [] };
  }

  const encodedBlocks = sourceBlocks.map((block, idx) => {
    const withoutMdHash = block.replace(/^#{1,6}\s+/, '').trim();
    return `[B${idx + 1}] ${withoutMdHash}`;
  });

  return {
    encodedText: encodedBlocks.join('\n\n'),
    blockCount: sourceBlocks.length,
    sourceBlocks
  };
}

/**
 * Decodes LLM output carrying `[B1]`..`[Bk]` markers back into canonical `1..K` order,
 * separated by `\n\n`. Any accidental blank lines inside a single `[Bk]` block are folded
 * to `<br/>` so block count parity is preserved.
 * Falls back transparently (`usedBlockProtocol: false`) when a model or legacy cache omits `[Bk]`.
 */
export function decodeBlocksFromWire(
  rawResponseBody: string,
  expectedBlockCount: number
): DecodedBlocksResult {
  if (!rawResponseBody || expectedBlockCount <= 0) {
    return {
      decodedText: (rawResponseBody || '').trim(),
      usedBlockProtocol: false,
      matchedIds: [],
      missingIds: [],
      outOfOrderCount: 0
    };
  }

  let normalized = rawResponseBody.replace(/\r\n/g, '\n');

  const seenLineStartIds = new Set<number>();
  {
    const scanRe = new RegExp(LINE_START_BLOCK_MARKER_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = scanRe.exec(normalized)) !== null) {
      const id = Number(m[1]);
      if (id >= 1 && id <= expectedBlockCount) {
        seenLineStartIds.add(id);
      }
    }
  }

  // If at least one valid line-start `[Bk]` exists and some valid IDs were placed inline
  // after prose on the same line, split only those missing valid IDs onto new lines.
  if (seenLineStartIds.size > 0 && seenLineStartIds.size < expectedBlockCount) {
    normalized = normalized.replace(
      /(?<=[^\n])[ \t]*((?:\[|【|〔)\s*[Bb]\s*(\d+)\s*(?:\]|】|〕))/g,
      (full, marker, numStr) => {
        const id = Number(numStr);
        if (id >= 1 && id <= expectedBlockCount && !seenLineStartIds.has(id)) {
          seenLineStartIds.add(id);
          return `\n${marker}`;
        }
        return full;
      }
    );
  }

  const validMatches: Array<{ id: number; matchIndex: number; endIndex: number }> = [];
  {
    const matchRe = new RegExp(LINE_START_BLOCK_MARKER_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = matchRe.exec(normalized)) !== null) {
      const id = Number(m[1]);
      if (id >= 1 && id <= expectedBlockCount) {
        validMatches.push({
          id,
          matchIndex: m.index,
          endIndex: matchRe.lastIndex
        });
      }
    }
  }

  if (validMatches.length === 0) {
    return {
      decodedText: stripBlockProtocolMarkers(rawResponseBody).trim(),
      usedBlockProtocol: false,
      matchedIds: [],
      missingIds: Array.from({ length: expectedBlockCount }, (_, i) => i + 1),
      outOfOrderCount: 0
    };
  }

  const blockMap = new Map<number, string>();
  let outOfOrderCount = 0;
  let lastSeenId = 0;

  // Recover preamble before first marker ONLY if B1 itself was omitted and first marker is > 1
  if (validMatches[0].id > 1 && validMatches[0].matchIndex > 0) {
    const preamble = normalized.slice(0, validMatches[0].matchIndex).trim();
    if (preamble) {
      blockMap.set(1, preamble.replace(/\n\s*\n+/g, '<br/>'));
      lastSeenId = 1;
    }
  }

  for (let i = 0; i < validMatches.length; i++) {
    const cur = validMatches[i];
    const nextStart = i + 1 < validMatches.length ? validMatches[i + 1].matchIndex : normalized.length;
    const rawBody = normalized.slice(cur.endIndex, nextStart);
    const cleanedBody = stripBlockProtocolMarkers(rawBody)
      .trim()
      .replace(/\n\s*\n+/g, '<br/>')
      .trim();

    if (lastSeenId > 0 && cur.id < lastSeenId) {
      outOfOrderCount++;
    }
    lastSeenId = cur.id;

    if (cleanedBody) {
      const existing = blockMap.get(cur.id);
      blockMap.set(cur.id, existing ? `${existing}<br/>${cleanedBody}` : cleanedBody);
    } else if (!blockMap.has(cur.id)) {
      blockMap.set(cur.id, '');
    }
  }

  const matchedIds: number[] = [];
  const missingIds: number[] = [];
  const assembled: string[] = [];

  for (let id = 1; id <= expectedBlockCount; id++) {
    const text = blockMap.get(id);
    if (text && text.trim()) {
      matchedIds.push(id);
      assembled.push(text.trim());
    } else {
      missingIds.push(id);
    }
  }

  return {
    decodedText: assembled.join('\n\n'),
    usedBlockProtocol: true,
    matchedIds,
    missingIds,
    outOfOrderCount
  };
}
