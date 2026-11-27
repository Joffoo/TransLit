
import { Chapter, ProcessingLog, SessionState } from '../types';
import { normalizeGlossaryKey } from '../utils/glossaryUtils';

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

  async saveGlossaryTerms(terms: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const entries = Object.entries(terms);
        if (entries.length === 0) return resolve(0);

        const transaction = this.getTransaction(STORES.GLOSSARY, 'readwrite');
        const store = transaction.objectStore(STORES.GLOSSARY);
        
        let addedCount = 0;
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = () => {
            const existingLower = new Set(
                (keysReq.result || []).map(k => normalizeGlossaryKey(String(k)))
            );
            for (const [term, translation] of entries) {
                const lower = normalizeGlossaryKey(term);
                if (!existingLower.has(lower)) {
                    existingLower.add(lower);
                    store.put(translation, term);
                    addedCount++;
                }
            }
        };

        transaction.oncomplete = () => resolve(addedCount);
        transaction.onerror = () => reject(transaction.error);
    });
  }

  async loadGlossary(): Promise<Record<string, string>> {
     return new Promise((resolve, reject) => {
        const transaction = this.getTransaction(STORES.GLOSSARY, 'readonly');
        const store = transaction.objectStore(STORES.GLOSSARY);
        const glossary: Record<string, string> = {};
        const request = store.openCursor();

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor) {
            glossary[String(cursor.key)] = cursor.value as string;
            cursor.continue();
          }
        };

        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve(glossary);
        transaction.onerror = () => reject(transaction.error);
     });
  }

  async replaceGlossary(terms: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
        const transaction = this.getTransaction(STORES.GLOSSARY, 'readwrite');
        const store = transaction.objectStore(STORES.GLOSSARY);
        
        store.clear();
        Object.entries(terms).forEach(([term, translation]) => {
            store.put(translation, term);
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
