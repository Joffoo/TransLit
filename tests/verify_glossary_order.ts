import assert from 'node:assert/strict';
import {
  GlossaryEntry,
  parseGlossaryEntries,
  glossaryEntriesToOutputStr,
  mergeGlossaryEntries,
  mergeGlossaryStrings,
  reconcileOptimizedGlossary,
  recoverGlossaryOrderFromChapters,
  filterGlossaryDeltaByPosterior,
  mergeChunkGlossaries,
} from '../utils/glossaryUtils.ts';
import { AiService } from '../services/geminiService.ts';
import { PersistenceService } from '../services/persistenceService.ts';
import { AppConfig } from '../types.ts';

/**
 * Minimal in-memory IndexedDB shim whose `openCursor()` strictly iterates keys
 * in ascending UTF-16 lexicographical order (identical to real browser IndexedDB).
 */
function createLexicographicalIdbMock() {
  const stores = new Map<string, Map<string, any>>();

  const makeStore = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const data = stores.get(name)!;

    return {
      put(value: any, key?: string) {
        const k = String(key ?? value?.id ?? value?.timestamp ?? '');
        data.set(k, value);
        const req: any = { result: k, onsuccess: null, onerror: null };
        queueMicrotask(() => req.onsuccess?.({ target: req }));
        return req;
      },
      clear() {
        data.clear();
        const req: any = { result: undefined, onsuccess: null, onerror: null };
        queueMicrotask(() => req.onsuccess?.({ target: req }));
        return req;
      },
      getAllKeys() {
        const sortedKeys = Array.from(data.keys()).sort();
        const req: any = { result: sortedKeys, onsuccess: null, onerror: null };
        queueMicrotask(() => req.onsuccess?.({ target: req }));
        return req;
      },
      openCursor() {
        // Real IndexedDB ALWAYS iterates string keys in ascending UTF-16 code unit order
        const sortedKeys = Array.from(data.keys()).sort();
        let idx = 0;
        const req: any = { result: null, onsuccess: null, onerror: null };

        const emitNext = () => {
          queueMicrotask(() => {
            if (idx < sortedKeys.length) {
              const key = sortedKeys[idx++];
              req.result = {
                key,
                value: data.get(key),
                continue: emitNext,
              };
            } else {
              req.result = null;
            }
            req.onsuccess?.({ target: req });
          });
        };

        emitNext();
        return req;
      },
    };
  };

  const db: any = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    createObjectStore: (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return makeStore(name);
    },
    transaction(storeNames: string | string[]) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      for (const n of names) {
        if (!stores.has(n)) stores.set(n, new Map());
      }
      const tx: any = {
        oncomplete: null,
        onerror: null,
        objectStore: (name: string) => makeStore(name),
      };
      // Complete after microtasks queued by cursor/put operations settle
      setTimeout(() => tx.oncomplete?.(), 5);
      return tx;
    },
  };

  return { db, stores };
}

async function runTests() {
  console.log('--- Running Chronological Glossary Ordering & Prefix Caching Tests ---');

  // 1. parseGlossaryEntries & glossaryEntriesToOutputStr preserve order including numeric keys
  {
    const raw = [
      'Zebra=斑马',
      '1984=一九八四',
      'SOURCE: Kahneman | TARGET: 卡尼曼',
      '007: 邦德',
      'Alpha=阿尔法',
      'Zebra=斑马（修订）', // exact duplicate updates value in-place at index 0
      '2001=太空漫游',
    ].join('\n');

    const entries = parseGlossaryEntries(raw);
    assert.deepEqual(
      entries.map((e) => e.key),
      ['Zebra', '1984', 'Kahneman', '007', 'Alpha', '2001']
    );
    assert.equal(entries[0].value, '斑马（修订）');
    assert.equal(
      glossaryEntriesToOutputStr(entries),
      [
        'Zebra=斑马（修订）',
        '1984=一九八四',
        'Kahneman=卡尼曼',
        '007=邦德',
        'Alpha=阿尔法',
        '2001=太空漫游',
      ].join('\n')
    );

    // Empty-value `Key=` lines whose key contains `:` must NOT fall through into bogus `Key: Value` splits
    assert.deepEqual(
      parseGlossaryEntries('Chapter 1: Dawn=\n2001: A Space Odyssey=\nSOURCE: EmptyTarget | TARGET:   '),
      []
    );
    // Full-width `＝` and inline `<glossary>...</glossary>` wrappers parse cleanly in chronological order
    assert.deepEqual(
      parseGlossaryEntries('<glossary>Zebra＝斑马\n1984＝一九八四</glossary>'),
      [
        { key: 'Zebra', value: '斑马' },
        { key: '1984', value: '一九八四' },
      ]
    );
    console.log('  [PASS] parseGlossaryEntries preserves exact insertion order, handles full-width ＝, & rejects empty colon-key lines');
  }

  // 2. mergeGlossaryEntries & mergeGlossaryStrings are strictly append-only (Prefix Caching invariant)
  {
    const base = 'Zebra=斑马\nKahneman=卡尼曼';
    const delta = '1984=一九八四\nkahneman=卡内曼\nAlpha=阿尔法\nＡＬＰＨＡ=重复全角\n0=零号';
    const merged = mergeGlossaryStrings(base, delta);
    assert.equal(
      merged,
      'Zebra=斑马\nKahneman=卡尼曼\n1984=一九八四\nAlpha=阿尔法\n0=零号'
    );
    assert.ok(merged.startsWith(base), 'Merged glossary must strictly start with base prefix');

    const mergedEntries = mergeGlossaryEntries(
      [{ key: 'Zebra', value: '斑马' }],
      [{ key: '42', value: '四十二' }, { key: 'Alpha', value: '阿尔法' }]
    );
    assert.deepEqual(
      mergedEntries.map((e) => e.key),
      ['Zebra', '42', 'Alpha']
    );
    console.log('  [PASS] mergeGlossaryStrings is strictly append-only even with numeric & duplicate keys');
  }

  // 3. filterGlossaryDeltaByPosterior & mergeChunkGlossaries preserve order with numeric keys
  {
    const filtered = filterGlossaryDeltaByPosterior(
      'Zebra=斑马\n1984=一九八四\nAlpha=阿尔法',
      '',
      'In 1984, Alpha met Zebra.'
    );
    assert.equal(filtered.filteredText, 'Zebra=斑马\n1984=一九八四\nAlpha=阿尔法');

    const chapterMerged = mergeChunkGlossaries([
      'Zebra=斑马\n2001=太空漫游',
      '1984=一九八四\nzebra=重复\nAlpha=阿尔法',
    ]);
    assert.equal(
      chapterMerged,
      'Zebra=斑马\n2001=太空漫游\n1984=一九八四\nAlpha=阿尔法'
    );
    console.log('  [PASS] filterGlossaryDeltaByPosterior & mergeChunkGlossaries preserve exact order');
  }

  // 4. reconcileOptimizedGlossary deterministically enforces original chronological order
  {
    const original: GlossaryEntry[] = [
      { key: 'Zebra', value: '斑马' },
      { key: 'heroin', value: '海洛因' },
      { key: 'Alex', value: '亚历克斯(女)' },
      { key: '1984', value: '一九八四' },
      { key: 'AI', value: '人工智能' },
      { key: 'Alpha', value: '阿尔法' },
      { key: 'ＡＩ', value: '人工知能' }, // later full-width duplicate
    ];

    // Simulate an LLM that alphabetizes, picks full-width dup, strips gender tag, and adds commentary
    const scrambledLlmOutput = [
      'Note: Here is the cleaned glossary',
      '1984=一九八四',
      'Alpha=阿尔法',
      'alex=亚历克斯',
      'ＡＩ=人工知能',
      'Zebra=斑马',
      'HallucinatedTerm=幻觉词',
    ].join('\n');

    const reconciled = reconcileOptimizedGlossary(original, scrambledLlmOutput);
    assert.deepEqual(reconciled, [
      { key: 'Zebra', value: '斑马' },
      { key: 'Alex', value: '亚历克斯(女)' },
      { key: '1984', value: '一九八四' },
      { key: 'AI', value: '人工智能' },
      { key: 'Alpha', value: '阿尔法' },
    ]);

    // All-commentary / error response yields empty list so caller safety guard preserves glossary
    const badLlmOutput = 'Sorry: I cannot process this request right now.';
    assert.deepEqual(reconcileOptimizedGlossary(original, badLlmOutput), []);

    // Tolerate Markdown bullets, numbered lists, bold/backticks, full-width ＝/：, arrows, <think>, code fences, & <glossary> tags
    const decoratedLlmOutput = [
      '<think>Let me sort and bullet these</think>',
      '```text',
      '<glossary>1. `Alpha` -> 阿尔法',
      '- **1984**＝一九八四',
      '* 「AI」：人工智能',
      '• "Alex" → 亚历克斯',
      '- Zebra=斑马</glossary>',
      '- Hallucinated=幻觉',
      '```',
    ].join('\n');
    assert.deepEqual(reconcileOptimizedGlossary(original, decoratedLlmOutput), [
      { key: 'Zebra', value: '斑马' },
      { key: 'Alex', value: '亚历克斯(女)' },
      { key: '1984', value: '一九八四' },
      { key: 'AI', value: '人工智能' },
      { key: 'Alpha', value: '阿尔法' },
    ]);

    // Legitimate numbered key in originalEntries matches exact key before decoration stripping
    const numberedOriginal: GlossaryEntry[] = [
      { key: '1. First Law', value: '第一定律' },
      { key: 'Zebra', value: '斑马' },
    ];
    assert.deepEqual(
      reconcileOptimizedGlossary(numberedOriginal, 'Zebra=斑马\n1. First Law=第一定律'),
      [
        { key: '1. First Law', value: '第一定律' },
        { key: 'Zebra', value: '斑马' },
      ]
    );
    console.log('  [PASS] reconcileOptimizedGlossary restores chronological order, handles LLM formatting quirks, & strips noise');
  }

  // 5. recoverGlossaryOrderFromChapters migrates legacy alphabetical IndexedDB glossaries
  {
    // Legacy IndexedDB openCursor() yielded keys alphabetically
    const legacyAlphabetical: GlossaryEntry[] = [
      { key: '1984', value: '一九八四' },
      { key: 'Alpha', value: '阿尔法' },
      { key: 'Beta', value: '贝塔' },
      { key: 'ManualTerm', value: '手动词' },
      { key: 'Zebra', value: '斑马' },
    ];

    // Unsorted chapter array with explicit index field
    const chapters = [
      {
        index: 2,
        chunkGlossaries: ['Beta=贝塔'],
        glossary: 'Zebra=斑马\n1984=一九八四\nAlpha=阿尔法\nBeta=贝塔',
      },
      {
        index: 0,
        chunkGlossaries: ['Zebra=斑马', '1984=一九八四'],
        glossary: 'Zebra=斑马\n1984=一九八四',
      },
      {
        index: 1,
        // Simulate older chapter without chunkGlossaries (only cumulative glossary)
        glossary: 'Zebra=斑马\n1984=一九八四\nAlpha=阿尔法',
      },
    ];

    const recovered = recoverGlossaryOrderFromChapters(legacyAlphabetical, chapters);
    assert.deepEqual(
      recovered.map((e) => e.key),
      ['Zebra', '1984', 'Alpha', 'Beta', 'ManualTerm']
    );
    console.log('  [PASS] recoverGlossaryOrderFromChapters restores chronological order for legacy sessions');
  }

  // 6. AiService.translateContent maintains byte-for-byte Prefix Cache stability across chunks
  {
    const origFetch = globalThis.fetch;
    const capturedSystemPrompts: string[] = [];
    const mockResponses = [
      '<translation>[B1] 第一段译文。</translation><glossary>Kahneman=卡尼曼\n1984=一九八四</glossary>',
      '<translation>[B1] 第二段译文。</translation><glossary>Alpha=阿尔法\n007=邦德</glossary>',
      '<translation>[B1] 第三段译文。</translation><glossary></glossary>',
    ];
    let callIdx = 0;

    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const sysMsg = body.messages?.find((m: any) => m.role === 'system')?.content || '';
      capturedSystemPrompts.push(sysMsg);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: mockResponses[callIdx++] || mockResponses[2] } }],
          }),
      };
    };

    try {
      const cfg: AppConfig = {
        apiKey: 'test-key',
        baseUrl: 'https://mock.local/v1',
        modelName: 'mock-model',
        sourceLanguage: 'English',
        additionalContext: '',
        enableProofreading: false,
        useRecommendedPrompts: false,
        smartSkip: true,
        enableGlossary: true,
      };
      const ai = new AiService(cfg);
      const chunk0 = `${'X'.repeat(2400)} Kahneman wrote about 1984.`;
      const chunk1 = `${'Y'.repeat(2400)} Kahneman and 1984 led Alpha and 007.`;
      const chunk2 = `${'Z'.repeat(2400)} Later Alpha met 007 and Zebra.`;
      const content = `${chunk0}\n\n${chunk1}\n\n${chunk2}`;

      const res = await ai.translateContent(
        content,
        'Chinese (Simplified)',
        'System Base',
        undefined,
        [],
        [],
        'Zebra=斑马',
        'Zebra, Kahneman, 1984, Alpha, and 007 appear later.'
      );

      assert.equal(capturedSystemPrompts.length, 3);
      assert.ok(
        capturedSystemPrompts[0].endsWith('CURRENT GLOSSARY:\nZebra=斑马'),
        'Chunk 0 should start with initial glossary'
      );
      assert.ok(
        capturedSystemPrompts[1].startsWith(capturedSystemPrompts[0]),
        'Chunk 1 system prompt MUST share byte-for-byte prefix with Chunk 0 (Prefix Caching)'
      );
      assert.ok(
        capturedSystemPrompts[1].endsWith('CURRENT GLOSSARY:\nZebra=斑马\nKahneman=卡尼曼\n1984=一九八四'),
        `Unexpected chunk 1 glossary tail: ${capturedSystemPrompts[1].slice(-120)}`
      );
      assert.ok(
        capturedSystemPrompts[2].startsWith(capturedSystemPrompts[1]),
        'Chunk 2 system prompt MUST share byte-for-byte prefix with Chunk 1 (Prefix Caching)'
      );
      assert.ok(
        capturedSystemPrompts[2].endsWith(
          'CURRENT GLOSSARY:\nZebra=斑马\nKahneman=卡尼曼\n1984=一九八四\nAlpha=阿尔法\n007=邦德'
        ),
        `Unexpected chunk 2 glossary tail: ${capturedSystemPrompts[2].slice(-160)}`
      );
      assert.equal(
        res.glossary,
        'Zebra=斑马\nKahneman=卡尼曼\n1984=一九八四\nAlpha=阿尔法\n007=邦德'
      );
      console.log('  [PASS] AiService.translateContent maintains strict append-only Prefix Caching');
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 7. AiService.optimizeGlossary & optimizeIncrementalGlossary enforce order even when LLM scrambles
  {
    const origFetch = globalThis.fetch;
    const seenSysPrompts: string[] = [];

    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const sysMsg = body.messages?.find((m: any) => m.role === 'system')?.content || '';
      seenSysPrompts.push(sysMsg);
      // Intentionally return alphabetically sorted + tag-stripped + commentary-polluted output
      const llmReply = [
        'Explanation: cleaned list below',
        '1984=一九八四',
        'Alpha=阿尔法',
        'alex=亚历克斯',
        'Zebra=斑马',
      ].join('\n');
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: llmReply } }],
          }),
      };
    };

    try {
      const cfg: AppConfig = {
        apiKey: 'test-key',
        baseUrl: 'https://mock.local/v1',
        modelName: 'mock-model',
        sourceLanguage: 'English',
        additionalContext: '',
        enableProofreading: false,
        useRecommendedPrompts: false,
        smartSkip: true,
        enableGlossary: true,
      };
      const ai = new AiService(cfg);
      const inputGlossary = [
        'Zebra=斑马',
        'heroin=海洛因',
        'Alex=亚历克斯(女)',
        '1984=一九八四',
        'Alpha=阿尔法',
      ].join('\n');

      const optAll = await ai.optimizeGlossary(inputGlossary);
      assert.equal(
        optAll,
        'Zebra=斑马\nAlex=亚历克斯(女)\n1984=一九八四\nAlpha=阿尔法'
      );

      const optInc = await ai.optimizeIncrementalGlossary(inputGlossary);
      assert.equal(
        optInc,
        'Zebra=斑马\nAlex=亚历克斯(女)\n1984=一九八四\nAlpha=阿尔法'
      );

      assert.ok(seenSysPrompts[0].includes('严格保持原序'), 'Full optimizer prompt must instruct order preservation');
      assert.ok(seenSysPrompts[1].includes('严格保持原序'), 'Incremental optimizer prompt must instruct order preservation');

      // Empty input must short-circuit with 0 API calls
      const callsBeforeEmpty = seenSysPrompts.length;
      assert.equal(await ai.optimizeGlossary('   \n  '), '');
      assert.equal(await ai.optimizeIncrementalGlossary(''), '');
      assert.equal(seenSysPrompts.length, callsBeforeEmpty, 'Empty optimizer input must not invoke LLM');

      // XML-wrapped optimizer response (<translation>...<glossary>...) extracts <glossary> and preserves chronological order
      (globalThis as any).fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '<translation>已完成去重</translation><glossary>- 1984=一九八四\n- Zebra=斑马</glossary>',
                },
              },
            ],
          }),
      });
      const optXml = await ai.optimizeGlossary('Zebra=斑马\n1984=一九八四');
      assert.equal(optXml, 'Zebra=斑马\n1984=一九八四');
      console.log('  [PASS] AiService.optimizeGlossary & optimizeIncrementalGlossary preserve strict chronological order');
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 8. PersistenceService preserves chronological order despite IndexedDB lexicographical cursor
  {
    const { db, stores } = createLexicographicalIdbMock();
    const persistence = new PersistenceService();
    (persistence as any).db = db;

    // Batch 1: reverse-alphabetical + numeric
    const added1 = await persistence.saveGlossaryTerms([
      { key: 'Zebra', value: '斑马' },
      { key: '1984', value: '一九八四' },
    ]);
    assert.equal(added1, 2);

    // Batch 2: alphabetically earlier keys + case duplicate + whitespace-only key
    const added2 = await persistence.saveGlossaryTerms([
      { key: '   ', value: '空键忽略' },
      { key: ' Alpha ', value: '阿尔法' },
      { key: 'zebra', value: '重复斑马' },
      { key: '007', value: '邦德' },
    ]);
    assert.equal(added2, 2);

    const loaded = await persistence.loadGlossaryEntriesWithMeta();
    assert.equal(loaded.isLegacyUnordered, false);
    assert.deepEqual(loaded.entries, [
      { key: 'Zebra', value: '斑马' },
      { key: '1984', value: '一九八四' },
      { key: 'Alpha', value: '阿尔法' },
      { key: '007', value: '邦德' },
    ]);

    // Replace after smart cleanup / rename preserves exact new order
    await persistence.replaceGlossary([
      { key: 'Zebra', value: '斑马' },
      { key: 'Renamed_AAA', value: '一九八四' },
      { key: '007', value: '邦德' },
    ]);
    const afterReplace = await persistence.loadGlossaryEntries();
    assert.deepEqual(
      afterReplace.map((e) => e.key),
      ['Zebra', 'Renamed_AAA', '007']
    );

    // Seed legacy plain-string records directly in IDB store (no `order` field)
    const glossaryStore = stores.get('glossary')!;
    glossaryStore.clear();
    glossaryStore.set('Zebra', '斑马');
    glossaryStore.set('Alpha', '阿尔法');
    glossaryStore.set('1984', '一九八四');

    const legacyMeta = await persistence.loadGlossaryEntriesWithMeta();
    assert.equal(legacyMeta.isLegacyUnordered, true);
    // Lexicographical cursor yields 1984, Alpha, Zebra
    assert.deepEqual(
      legacyMeta.entries.map((e) => e.key),
      ['1984', 'Alpha', 'Zebra']
    );

    // Appending a new term before migration places it AFTER legacy records
    await persistence.saveGlossaryTerms([{ key: '000_New', value: '新词' }]);
    const mixedMeta = await persistence.loadGlossaryEntriesWithMeta();
    assert.equal(mixedMeta.isLegacyUnordered, true);
    assert.deepEqual(
      mixedMeta.entries.map((e) => e.key),
      ['1984', 'Alpha', 'Zebra', '000_New']
    );

    // After recovering order and replacing, isLegacyUnordered becomes false
    const migrated = recoverGlossaryOrderFromChapters(mixedMeta.entries, [
      { index: 0, chunkGlossaries: ['Zebra=斑马\n1984=一九八四'] },
      { index: 1, chunkGlossaries: ['Alpha=阿尔法'] },
    ]);
    await persistence.replaceGlossary(migrated);
    const upgradedMeta = await persistence.loadGlossaryEntriesWithMeta();
    assert.equal(upgradedMeta.isLegacyUnordered, false);
    assert.deepEqual(
      upgradedMeta.entries.map((e) => e.key),
      ['Zebra', '1984', 'Alpha', '000_New']
    );
    console.log('  [PASS] PersistenceService preserves chronological order & migrates legacy v3 stores');
  }

  console.log('\n[PASS] ALL_GLOSSARY_ORDER_TESTS_SUCCESSFUL\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
