
import { Chapter, ProcessingLog, SessionState } from '../types';
import {
  GlossaryEntry,
  glossaryEntriesToRecord,
  normalizeGlossaryKey
} from '../utils/glossaryUtils';

type StoredGlossaryRecord = string | { value: string; order?: number };

const DB_NAME = 'epub_translator_db';
const DB_VERSION = 3;
const STORES = {
  METADATA: 'metadata',
  CHAPTERS: 'chapters',
  IMAGES: 'images',
  LOGS: 'logs',
  GLOSSARY: 'glossary',
  ORIGINAL_ZIP: 'original_zip'
};

export class PersistenceService {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        this.initPromise = null;
        reject(request.error);
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        if (!db.objectStoreNames.contains(STORES.METADATA)) {
          db.createObjectStore(STORES.METADATA);
        }
        if (!db.objectStoreNames.contains(STORES.CHAPTERS)) {
          db.createObjectStore(STORES.CHAPTERS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.IMAGES)) {
          db.createObjectStore(STORES.IMAGES);
        }
        if (!db.objectStoreNames.contains(STORES.LOGS)) {
          db.createObjectStore(STORES.LOGS, { keyPath: 'timestamp' });
        }
        if (!db.objectStoreNames.contains(STORES.GLOSSARY)) {
          db.createObjectStore(STORES.GLOSSARY);
        }
        if (!db.objectStoreNames.contains(STORES.ORIGINAL_ZIP)) {
          db.createObjectStore(STORES.ORIGINAL_ZIP);
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };
    });

    return this.initPromise;
  }

  private getTransaction(
    storeNames: string | string[],
    mode: IDBTransactionMode = 'readonly'
  ): IDBTransaction {
    if (!this.db) throw new Error("Database not initialized");
    return this.db.transaction(storeNames, mode);
  }

  private getStore(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    return this.getTransaction(storeName, mode).objectStore(storeName);
  }

  // --- Session Metadata ---

  async saveSession(state: SessionState): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.METADATA, 'readwrite');
      const request = store.put(state, 'currentSession');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async loadSession(): Promise<SessionState | null> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.METADATA);
      const request = store.get('currentSession');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async clearSession(): Promise<void> {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const activeStores = [STORES.METADATA, STORES.CHAPTERS, STORES.IMAGES, STORES.LOGS, STORES.GLOSSARY, STORES.ORIGINAL_ZIP]
        .filter(name => this.db!.objectStoreNames.contains(name));
        
      if (activeStores.length === 0) {
        resolve();
        return;
      }

      const transaction = this.db!.transaction(activeStores, 'readwrite');
      
      activeStores.forEach(storeName => {
        transaction.objectStore(storeName).clear();
      });
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // --- Chapters ---

  async saveChapters(chapters: Chapter[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.getTransaction(STORES.CHAPTERS, 'readwrite');
      const store = transaction.objectStore(STORES.CHAPTERS);
      
      // Clear existing chapters first to avoid stale data
      store.clear();

      chapters.forEach(chapter => {
        store.put(chapter);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async updateChapter(chapter: Chapter): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.CHAPTERS, 'readwrite');
      const request = store.put(chapter);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async loadChapters(): Promise<Chapter[]> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.CHAPTERS);
      const request = store.getAll();
      request.onsuccess = () => {
        // Sort by ID or ensure order if necessary. 
        // Assuming getAll returns in insertion order for simple keys, but here keys are strings (id).
        // The caller might need to sort them if order matters and IDs aren't sortable.
        // However, we usually rely on the array order. 
        // Let's assume the App handles sorting or we stored them with a sortable key?
        // Actually, 'id' in Chapter is usually a string ref from EPUB.
        // To be safe, we might want to store an index, but for now let's trust the caller to re-sort or
        // we just return what we have. The App.tsx uses chaptersRef.current which is an array.
        // IndexedDB getAll() returns sorted by key.
        // If we need original order, we should add an 'index' field to Chapter.
        resolve(request.result || []);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // --- Images ---

  async saveImages(images: Record<string, Blob>): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.getTransaction(STORES.IMAGES, 'readwrite');
      const store = transaction.objectStore(STORES.IMAGES);
      
      store.clear();

      Object.entries(images).forEach(([path, blob]) => {
        store.put(blob, path);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async loadImages(): Promise<Record<string, Blob>> {
    return new Promise((resolve, reject) => {
      const transaction = this.getTransaction(STORES.IMAGES, 'readonly');
      const store = transaction.objectStore(STORES.IMAGES);
      const images: Record<string, Blob> = {};
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          images[String(cursor.key)] = cursor.value as Blob;
          cursor.continue();
        }
      };

      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(images);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getImage(path: string): Promise<Blob | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
          resolve(null);
          return;
      }
      const store = this.getStore(STORES.IMAGES);
      const request = store.get(path);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  // --- Logs ---

  async saveLog(log: ProcessingLog): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.LOGS, 'readwrite');
      const request = store.put(log);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async loadLogs(): Promise<ProcessingLog[]> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.LOGS);
      const request = store.getAll();
      request.onsuccess = () => {
        const logs = request.result as ProcessingLog[];
        logs.sort((a, b) => a.timestamp - b.timestamp);
        resolve(logs);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // --- Glossary ---

  private normalizeGlossaryInput(
    terms: GlossaryEntry[] | Record<string, string>
  ): GlossaryEntry[] {
    const raw: GlossaryEntry[] = Array.isArray(terms)
      ? terms
      : Object.entries(terms).map(([key, value]) => ({ key, value }));
    const deduped: GlossaryEntry[] = [];
    const indexByExactKey = new Map<string, number>();
    for (const item of raw) {
      if (!item || typeof item.key !== 'string') continue;
      const trimmedKey = item.key.trim();
      if (!trimmedKey) continue;
      const existingIdx = indexByExactKey.get(trimmedKey);
      if (existingIdx !== undefined) {
        deduped[existingIdx] = { key: trimmedKey, value: item.value };
      } else {
        indexByExactKey.set(trimmedKey, deduped.length);
        deduped.push({ key: trimmedKey, value: item.value });
      }
    }
    return deduped;
  }

  async saveGlossaryTerms(terms: GlossaryEntry[] | Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const entries = this.normalizeGlossaryInput(terms);
        if (entries.length === 0) return resolve(0);

        const transaction = this.getTransaction(STORES.GLOSSARY, 'readwrite');
        const store = transaction.objectStore(STORES.GLOSSARY);

        let addedCount = 0;
        const existingLower = new Set<string>();
        let maxOrder = -1;
        let existingCount = 0;

        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (cursor) {
                existingCount++;
                existingLower.add(normalizeGlossaryKey(String(cursor.key)));
                const rawVal = cursor.value as StoredGlossaryRecord | null | undefined;
                if (
                    rawVal &&
                    typeof rawVal === 'object' &&
                    typeof rawVal.order === 'number' &&
                    Number.isFinite(rawVal.order) &&
                    rawVal.order > maxOrder
                ) {
                    maxOrder = rawVal.order;
                }
                cursor.continue();
                return;
            }

            let nextOrder = Math.max(maxOrder + 1, existingCount);
            for (const { key: term, value: translation } of entries) {
                const lower = normalizeGlossaryKey(term);
                if (!lower || existingLower.has(lower)) continue;
                existingLower.add(lower);
                store.put({ value: translation, order: nextOrder++ }, term);
                addedCount++;
            }
        };

        cursorReq.onerror = () => reject(cursorReq.error);
        transaction.oncomplete = () => resolve(addedCount);
        transaction.onerror = () => reject(transaction.error);
    });
  }

  async loadGlossaryEntriesWithMeta(): Promise<{
    entries: GlossaryEntry[];
    isLegacyUnordered: boolean;
  }> {
     return new Promise((resolve, reject) => {
        const transaction = this.getTransaction(STORES.GLOSSARY, 'readonly');
        const store = transaction.objectStore(STORES.GLOSSARY);
        const rows: Array<{
          key: string;
          value: string;
          order: number | undefined;
          cursorIdx: number;
        }> = [];
        let isLegacyUnordered = false;
        let cursorIdx = 0;

        const request = store.openCursor();

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor) {
            const key = String(cursor.key);
            const rawVal = cursor.value as StoredGlossaryRecord | null | undefined;
            if (typeof rawVal === 'string') {
              isLegacyUnordered = true;
              rows.push({ key, value: rawVal, order: undefined, cursorIdx: cursorIdx++ });
            } else if (rawVal && typeof rawVal === 'object' && typeof rawVal.value === 'string') {
              const hasOrder = typeof rawVal.order === 'number' && Number.isFinite(rawVal.order);
              if (!hasOrder) {
                isLegacyUnordered = true;
              }
              rows.push({
                key,
                value: rawVal.value,
                order: hasOrder ? rawVal.order : undefined,
                cursorIdx: cursorIdx++
              });
            }
            cursor.continue();
          }
        };

        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => {
          rows.sort((a, b) => {
            if (a.order !== undefined && b.order !== undefined) {
              return a.order - b.order || a.cursorIdx - b.cursorIdx;
            }
            if (a.order === undefined && b.order === undefined) {
              return a.cursorIdx - b.cursorIdx;
            }
            // Legacy unordered entries pre-date newly appended ordered entries
            return a.order === undefined ? -1 : 1;
          });
          resolve({
            entries: rows.map(({ key, value }) => ({ key, value })),
            isLegacyUnordered
          });
        };
        transaction.onerror = () => reject(transaction.error);
     });
  }

  async loadGlossaryEntries(): Promise<GlossaryEntry[]> {
    const { entries } = await this.loadGlossaryEntriesWithMeta();
    return entries;
  }

  async loadGlossary(): Promise<Record<string, string>> {
    const entries = await this.loadGlossaryEntries();
    return glossaryEntriesToRecord(entries);
  }

  async replaceGlossary(terms: GlossaryEntry[] | Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
        const entries = this.normalizeGlossaryInput(terms);
        const transaction = this.getTransaction(STORES.GLOSSARY, 'readwrite');
        const store = transaction.objectStore(STORES.GLOSSARY);

        store.clear();
        entries.forEach((entry, idx) => {
            store.put({ value: entry.value, order: idx }, entry.key);
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
  }

  async saveOriginalZip(data: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.getTransaction(STORES.ORIGINAL_ZIP, 'readwrite');
      const store = transaction.objectStore(STORES.ORIGINAL_ZIP);
      const request = store.put(data, 'archive');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async loadOriginalZip(): Promise<ArrayBuffer | null> {
    return new Promise((resolve, reject) => {
      const store = this.getStore(STORES.ORIGINAL_ZIP);
      const request = store.get('archive');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
}
