
import React, { useState, useRef, useEffect, useMemo } from 'react';
import JSZip from 'jszip';
import { 
  FileCheck, Loader2, Download, AlertTriangle, 
  RefreshCw, Trash2, Save, Info, Plus, X, Eye, Ban, FileCode,
  CheckCircle2, Pause, Sparkles, Tag, Search, ChevronDown,
  BookOpen, Terminal, ChevronUp, ChevronLeft, ChevronRight,
  FileText
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import FileUpload from './components/FileUpload';
import SettingsPanel from './components/SettingsPanel';
import {
  EpubFinishedPreview,
  MarkdownImage,
  LogoWatermark,
  formatMarkdownForPreview
} from './components/EpubFinishedPreview';
import logoUrl from './logo.svg';
import {
  EpubService,
  splitMarkdownIntoBlocks,
  alignMarkdownBlocks
} from './services/epubService';
import {
  DomMutationEngine,
  parseEpubCssProfiles,
  restoreHeadingPrefixesFromSource
} from './services/domMutationEngine';
import { AiService, splitTextIntoChunks } from './services/geminiService';
import { PersistenceService } from './services/persistenceService';
import { loadApiProfileStore, getActiveProfile, hasValidApiProfileStore } from './services/apiProfileService';
import { LanguageDetectionSource } from './services/languageDetectionService';
import { FootnotePool } from './services/footnotePool';
import { PageClassifier } from './services/pageClassifier';
import { StyleClassifier } from './services/styleClassifier';
import { AppStatus, AppConfig, Chapter, ProcessingLog, BilingualMode, BookStyleRoleMap, SessionState, TokenUsage, TokenUsageStats } from './types';
import { RECOMMENDED_TRANSLATION_PROMPT, TWO_STEP_BASE_PROMPT } from './prompts';
import {
  GlossaryEntry,
  parseGlossaryEntries,
  glossaryEntriesToOutputStr,
  glossaryEntriesToRecord,
  mergeGlossaryEntries,
  reconcileOptimizedGlossary,
  recoverGlossaryOrderFromChapters,
  parseGlossaryValue,
  safeReplaceKeyword,
  detectGlossaryChanges,
  filterSafeCascadeChanges,
  mergeChunkGlossaries,
  normalizeGlossaryKey,
  TermChange
} from './utils/glossaryUtils';
import {
  isFootnoteSourceChapter,
  isChapterEffectivelySkippable,
  isChapterEffectivelyReference,
  isChapterNonTranslatable,
  buildPosteriorTextForChapter
} from './utils/chapterUtils';

const EMPTY_TOKEN_STATS: TokenUsageStats = {
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  requestCount: 0,
};

const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const formatUsageTag = (usage?: TokenUsage): string => {
  if (!usage) return '';
  const inPart = usage.cachedTokens > 0
    ? `in ${usage.promptTokens.toLocaleString()} (cache ${usage.cachedTokens.toLocaleString()})`
    : `in ${usage.promptTokens.toLocaleString()}`;
  const outPart = `out ${usage.completionTokens.toLocaleString()}`;
  const thinkPart = usage.reasoningTokens > 0 ? ` | think ${usage.reasoningTokens.toLocaleString()}` : '';
  return ` [${inPart} | ${outPart}${thinkPart}]`;
};

const DEFAULT_CONFIG: AppConfig = {
  apiKey: '',
  baseUrl: '',
  modelName: '',
  sourceLanguage: 'English',
  additionalContext: '',
  enableProofreading: true,
  useRecommendedPrompts: false,
  smartSkip: true,
  enableGlossary: true
};

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [detectedLanguageInfo, setDetectedLanguageInfo] = useState<{ language: string; source: LanguageDetectionSource } | null>(null);
  const [logs, setLogs] = useState<ProcessingLog[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isDownloadDropdownOpen, setIsDownloadDropdownOpen] = useState<boolean>(false);
  const [isPackagingBilingual, setIsPackagingBilingual] = useState<boolean>(false);
  const downloadDropdownRef = useRef<HTMLDivElement>(null);
  const pendingExportRef = useRef<{ kind: 'all' } | { kind: 'single'; mode: BilingualMode; wereadMode: boolean } | null>(null);
  const [restoredSession, setRestoredSession] = useState<boolean>(false);
  const [showConfirmReset, setShowConfirmReset] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'preview' | 'chapters' | 'glossary'>('preview');
  const [selectedChapterIndex, setSelectedChapterIndex] = useState<number>(0);
  const [previewDisplayMode, setPreviewDisplayMode] = useState<'translation' | 'bilingual' | 'source'>('translation');
  const [isLogDrawerOpen, setIsLogDrawerOpen] = useState<boolean>(false);
  const [tokenStats, setTokenStats] = useState<TokenUsageStats>(EMPTY_TOKEN_STATS);
  const tokenStatsRef = useRef<TokenUsageStats>(EMPTY_TOKEN_STATS);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [liveGlossary, setLiveGlossary] = useState<string>('');
  const [glossaryEntries, setGlossaryEntries] = useState<GlossaryEntry[]>([]);
  const [glossarySearch, setGlossarySearch] = useState('');
  const [editingTermKey, setEditingTermKey] = useState<{ origKey: string; draft: string } | null>(null);
  const [isBulkEdit, setIsBulkEdit] = useState(false);
  const [previewChapter, setPreviewChapter] = useState<Chapter | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]); // Added state for chapters to trigger re-renders
  const [bookCssTexts, setBookCssTexts] = useState<string[]>([]);
  const [bookStyleRoles, setBookStyleRoles] = useState<BookStyleRoleMap>({});
  const [isCleaningGlossary, setIsCleaningGlossary] = useState(false);
  const [isMissingZip, setIsMissingZip] = useState(false);
  const [exportNotification, setExportNotification] = useState<{
    type: 'success' | 'error' | 'process';
    message: string;
    downloadUrl?: string;
    fileName?: string;
  } | null>(null);
  const missingZipInputRef = useRef<HTMLInputElement>(null);
  const isCleaningGlossaryRef = useRef(false);
  const pendingGlossaryQueueRef = useRef<GlossaryEntry[][]>([]);
  const lastDownloadUrlRef = useRef<string | null>(null);
  const progressRef = useRef<number>(0);
  const liveGlossaryRef = useRef<string>('');
  const lastLogTimestampRef = useRef<number>(0);
  const lastSavedConfigJsonRef = useRef<string>(JSON.stringify(DEFAULT_CONFIG));
  
  const epubService = useRef(new EpubService());
  const persistenceService = useRef(new PersistenceService());
  const footnotePoolRef = useRef(new FootnotePool());
  const pageClassifierRef = useRef(new PageClassifier());
  const styleClassifierRef = useRef(new StyleClassifier());
  const bookStyleRolesRef = useRef<BookStyleRoleMap>({});
  const bookStyleRolesAiDoneRef = useRef<boolean>(false);
  const isClassifyingStylesRef = useRef<boolean>(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const isPauseRequested = useRef(false);

  const updateBookStyleRoles = (roles: BookStyleRoleMap) => {
    bookStyleRolesRef.current = roles;
    setBookStyleRoles(roles);
  };
  
  // Persist chapters and metadata across renders to allow resuming
  const chaptersRef = useRef<Chapter[]>([]);
  const coverPathRef = useRef<string | undefined>(undefined);
  const opfPathRef = useRef<string | undefined>(undefined);
  const opfDirRef = useRef<string | undefined>(undefined);
  const cssFilesRef = useRef<string[] | undefined>(undefined);
  const cssContentsRef = useRef<string[]>([]);
  const activeChapterIndexRef = useRef<number>(-1);
  const activeChunkIndexRef = useRef<number>(0);
  const savedGlossaryEntriesRef = useRef<GlossaryEntry[]>([]);
  const driftFixesRef = useRef<Array<{ chapterTitle: string; key: string; oldVal: string; newVal: string; count: number }>>([]);

  const updateProgress = (val: number) => {
    progressRef.current = val;
    setProgress(val);
  };

  const updateLiveGlossary = (val: string) => {
    liveGlossaryRef.current = val;
    setLiveGlossary(val);
  };

  const resolvePendingTermKeyRename = (
    entries: GlossaryEntry[],
    pending: { origKey: string; draft: string } | null
  ): { entries: GlossaryEntry[]; conflictKey?: string } => {
    if (!pending) return { entries };
    const trimmedNew = pending.draft.trim();
    if (!trimmedNew || trimmedNew === pending.origKey) return { entries };
    const normNew = normalizeGlossaryKey(trimmedNew);
    const conflict = entries.some(
      e => e.key !== pending.origKey && (e.key === trimmedNew || normalizeGlossaryKey(e.key) === normNew)
    );
    if (conflict) {
      return { entries, conflictKey: trimmedNew };
    }
    return {
      entries: entries.map(e =>
        e.key === pending.origKey ? { key: trimmedNew, value: e.value } : e
      )
    };
  };

  const buildCleanedGlossaryEntries = (entries: GlossaryEntry[]): GlossaryEntry[] => {
    const cleaned: GlossaryEntry[] = [];
    const indexByExactKey = new Map<string, number>();
    for (const entry of entries) {
      const trimmedK = entry.key.trim();
      const trimmedV = entry.value.trim();
      if (!trimmedK || (!trimmedV && trimmedK.startsWith('新词条_'))) continue;
      const existingIdx = indexByExactKey.get(trimmedK);
      if (existingIdx !== undefined) {
        cleaned[existingIdx] = { key: trimmedK, value: trimmedV };
      } else {
        indexByExactKey.set(trimmedK, cleaned.length);
        cleaned.push({ key: trimmedK, value: trimmedV });
      }
    }
    return cleaned;
  };

  const revokeDownloadUrl = () => {
    if (lastDownloadUrlRef.current) {
      URL.revokeObjectURL(lastDownloadUrlRef.current);
      lastDownloadUrlRef.current = null;
    }
    setDownloadUrl(null);
  };

  useEffect(() => {
    return () => {
      if (lastDownloadUrlRef.current) {
        URL.revokeObjectURL(lastDownloadUrlRef.current);
        lastDownloadUrlRef.current = null;
      }
    };
  }, []);

  const isWorking = [AppStatus.PARSING, AppStatus.TRANSLATING, AppStatus.PACKAGING].includes(status);

  // Initialize Persistence
  useEffect(() => {
    const init = async () => {
      try {
        await persistenceService.current.init();

        // Load API configuration cache from LocalStorage (with automatic legacy migration)
        const profileStore = loadApiProfileStore();
        const activeProfile = getActiveProfile(profileStore);
        const hasSavedProfilesStore = hasValidApiProfileStore();
        const localApiConfig: Partial<AppConfig> = activeProfile
          ? {
              baseUrl: activeProfile.baseUrl,
              apiKey: activeProfile.apiKey,
              modelName: activeProfile.modelName,
            }
          : hasSavedProfilesStore
            ? {
                baseUrl: '',
                apiKey: '',
                modelName: '',
              }
            : {};

        const session = await persistenceService.current.loadSession();
        
        if (session && session.fileName) {
            // Found a previous session
            const savedChapters = await persistenceService.current.loadChapters();
            const savedLogs = await persistenceService.current.loadLogs();
            
            // MEMORY OPTIMIZATION: Do NOT load images here. 
            // We only need them for the final packaging step.
            // const savedImages = await persistenceService.current.loadImages(); 
            
            if (savedChapters.length > 0) {
                // Invalidate / refresh legacy Turndown-polluted payloads
                let anyRefreshed = false;
                for (const ch of savedChapters) {
                    if (epubService.current.refreshChapterPayloadIfNeeded(ch)) {
                        anyRefreshed = true;
                        persistenceService.current.updateChapter(ch).catch(() => {});
                    }
                }
                if (anyRefreshed) {
                    addLog("已自动净化历史缓存中残留的 Markdown 格式标记与图片标签。", "info");
                }

                // Restore data to refs
                chaptersRef.current = savedChapters.sort((a, b) => a.index - b.index);
                setChapters(chaptersRef.current); // Sync state
                 // imagesRef.current = savedImages; // Don't load to RAM
                 coverPathRef.current = session.coverPath;
                 opfPathRef.current = session.opfPath;
                 opfDirRef.current = session.opfDir;
                 cssFilesRef.current = session.cssFiles;
                 if (session.cssContents && session.cssContents.length > 0) {
                   cssContentsRef.current = session.cssContents;
                   setBookCssTexts(session.cssContents);
                 } else {
                   persistenceService.current.loadOriginalZip().then(async (zipBuf) => {
                     if (!zipBuf) return;
                     try {
                       const zip = await new JSZip().loadAsync(zipBuf);
                       const cssPaths =
                         session.cssFiles && session.cssFiles.length > 0
                           ? session.cssFiles
                           : Object.keys(zip.files).filter((p) => /\.css$/i.test(p));
                       const loadedCss: string[] = [];
                       for (const p of cssPaths) {
                         const f = zip.file(p);
                         if (f) loadedCss.push(await f.async('string'));
                       }
                       if (loadedCss.length > 0) {
                         cssContentsRef.current = loadedCss;
                         setBookCssTexts(loadedCss);
                         if (Object.keys(bookStyleRolesRef.current).length === 0) {
                           runBookStyleClassification(
                             chaptersRef.current,
                             loadedCss,
                             { ...session.config, ...localApiConfig },
                             { allowAi: false, sessionSnapshot: session }
                           ).catch(() => {});
                         }
                       }
                     } catch {
                       // Ignore legacy ZIP CSS recovery errors
                     }
                   }).catch(() => {});
                 }
                 
                 // Restore footnote pool
                 footnotePoolRef.current = new FootnotePool();
                 footnotePoolRef.current.restoreFromChapters(chaptersRef.current);
                 
                 // Restore glossary (preserving chronological order; migrate legacy unordered DB if needed)
                const { entries: loadedEntries, isLegacyUnordered } =
                  await persistenceService.current.loadGlossaryEntriesWithMeta();
                let restoredEntries = loadedEntries;
                if (isLegacyUnordered && loadedEntries.length > 0) {
                  restoredEntries = recoverGlossaryOrderFromChapters(loadedEntries, chaptersRef.current);
                  await persistenceService.current.replaceGlossary(restoredEntries);
                }
                savedGlossaryEntriesRef.current = restoredEntries.map(e => ({ ...e }));
                setGlossaryEntries(restoredEntries);
                updateLiveGlossary(glossaryEntriesToOutputStr(restoredEntries));
                
                 // Restore UI state, merging with LocalStorage configurations
                const mergedRestoredConfig = { ...session.config, ...localApiConfig };
                lastSavedConfigJsonRef.current = JSON.stringify(mergedRestoredConfig);
                setConfig(mergedRestoredConfig);

                bookStyleRolesAiDoneRef.current = Boolean(session.bookStyleRolesAiDone);
                if (session.bookStyleRoles && Object.keys(session.bookStyleRoles).length > 0) {
                  updateBookStyleRoles(session.bookStyleRoles);
                } else {
                  const cssForCensus =
                    session.cssContents && session.cssContents.length > 0
                      ? session.cssContents
                      : cssContentsRef.current;
                  runBookStyleClassification(
                    chaptersRef.current,
                    cssForCensus,
                    mergedRestoredConfig,
                    { allowAi: false, sessionSnapshot: session }
                  ).catch(() => {});
                }
                lastLogTimestampRef.current = savedLogs.reduce(
                  (max, l) => Math.max(max, l.timestamp || 0),
                  0
                );
                setLogs(savedLogs);
                updateProgress(session.progress);
                const restoredStats = session.tokenStats || EMPTY_TOKEN_STATS;
                tokenStatsRef.current = restoredStats;
                setTokenStats(restoredStats);
                
                // If it was in progress, set to ERROR/PAUSED state so user can resume
                // If it was COMPLETED, restore that
                if (session.status === AppStatus.COMPLETED) {
                     setStatus(AppStatus.COMPLETED);
                     addLog("已恢复上次已完成的翻译会话。点击「重新导出」可重新生成电子书。", "info");


                } else if (session.status !== AppStatus.IDLE) {
                     setStatus(AppStatus.ERROR); // Use ERROR state to show "Resume" button
                     addLog("已恢复中断的翻译会话。点击「继续翻译」即可继续。", "info");
                }
                
                setRestoredSession(true);
                const dummyFile = { name: session.fileName } as File;
                setCurrentFile(dummyFile);
            }
        } else {
            // Apply local API configurations if no prior session exists
            setConfig(prev => {
              const merged = { ...prev, ...localApiConfig };
              lastSavedConfigJsonRef.current = JSON.stringify(merged);
              return merged;
            });
        }
      } catch (e) {
        console.error("Failed to initialize persistence:", e);
        addLog("自动持久化缓存初始化失败。", "error");
      }
    };
    init();
  }, []);

  // Debounced config persistence to IndexedDB session
  useEffect(() => {
    if (
      chaptersRef.current.length === 0 ||
      !currentFile ||
      status === AppStatus.PARSING ||
      status === AppStatus.TRANSLATING ||
      status === AppStatus.PACKAGING
    ) {
      return;
    }
    const serialized = JSON.stringify(config);
    if (serialized === lastSavedConfigJsonRef.current) return;
    const timer = setTimeout(() => {
      lastSavedConfigJsonRef.current = serialized;
      saveSessionState(status).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [config, status, currentFile]);

  // Recalculate progress when smartSkip setting changes
  useEffect(() => {
    if (chapters.length === 0 || status === AppStatus.PARSING || status === AppStatus.TRANSLATING) return;
    const doneCount = chapters.filter(
      (c) => isChapterNonTranslatable(c, config.smartSkip) || Boolean(c.translatedMarkdown)
    ).length;
    updateProgress(Math.min(100, (doneCount / chapters.length) * 100));
  }, [config.smartSkip]);

  // Close download dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (downloadDropdownRef.current && !downloadDropdownRef.current.contains(event.target as Node)) {
        setIsDownloadDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto dismiss export notification
  useEffect(() => {
    if (exportNotification?.type === 'success') {
      const timer = setTimeout(() => {
        setExportNotification(null);
      }, 30000);
      return () => clearTimeout(timer);
    }
  }, [exportNotification]);

  const optimizeGlossary = async () => {
    if (isCleaningGlossaryRef.current) return;

    // Respect unsaved UI edits (Bulk text or Table edits / pending key rename) if present;
    // otherwise read fresh ordered entries from IndexedDB (including legacy v3 migration).
    let currentEntries: GlossaryEntry[];
    const pendingResolved = resolvePendingTermKeyRename(glossaryEntries, editingTermKey);
    if (pendingResolved.conflictKey) {
      addLog(`术语「${pendingResolved.conflictKey}」已存在，已取消覆盖。`, "error");
    }
    const uiEntries = isBulkEdit
      ? parseGlossaryEntries(liveGlossaryRef.current)
      : buildCleanedGlossaryEntries(pendingResolved.entries);
    const hasUnsavedUiEdits =
      glossaryEntriesToOutputStr(uiEntries) !==
      glossaryEntriesToOutputStr(savedGlossaryEntriesRef.current);

    if (hasUnsavedUiEdits) {
      setEditingTermKey(null);
      currentEntries = uiEntries;
    } else {
      const { entries: rawEntries, isLegacyUnordered } =
        await persistenceService.current.loadGlossaryEntriesWithMeta();
      currentEntries =
        isLegacyUnordered && rawEntries.length > 0
          ? recoverGlossaryOrderFromChapters(rawEntries, chaptersRef.current)
          : rawEntries;
    }

    const currentGlossaryText = glossaryEntriesToOutputStr(currentEntries);
    const termCount = currentEntries.length;
    if (termCount === 0) return;

    setIsCleaningGlossary(true);
    isCleaningGlossaryRef.current = true;
    
    try {
        const aiService = new AiService(config, recordTokenUsage);
        addLog(`[Agent] Smart Cleanup: Performing deep analysis on ${termCount} terms...`, 'process');

        const optimizedText = await aiService.optimizeGlossary(currentGlossaryText);
        const finalEntries = reconcileOptimizedGlossary(currentEntries, optimizedText);
        if (termCount > 0 && finalEntries.length === 0) {
          addLog(`[Agent] Smart Cleanup skipped: optimizer returned empty result, preserved existing ${termCount} terms.`, 'error');
          return;
        }
        await persistenceService.current.replaceGlossary(finalEntries);
        savedGlossaryEntriesRef.current = finalEntries.map(e => ({ ...e }));
        setGlossaryEntries(finalEntries);
        updateLiveGlossary(glossaryEntriesToOutputStr(finalEntries));
        
        const finalCount = finalEntries.length;
        addLog(`[Agent] Smart Cleanup finished. Result: ${finalCount} / ${termCount} terms kept.`, 'success');
    } catch (e) {
        if (e instanceof Error && e.message === "PAUSE_SIGNAL") {
            throw e;
        }
        console.error("Glossary optimization failed:", e);
        addLog(`[Agent] Glossary optimization failed: ${e instanceof Error ? e.message : 'Unknown error'}`, 'error');
    } finally {
        while (pendingGlossaryQueueRef.current.length > 0) {
          await flushPendingGlossaryQueue();
        }
        isCleaningGlossaryRef.current = false;
        setIsCleaningGlossary(false);
    }
  };

  const flushPendingGlossaryQueue = async () => {
    if (pendingGlossaryQueueRef.current.length === 0) return;
    const queuedDeltaEntries: GlossaryEntry[] = [];
    const seenLower = new Set<string>();
    while (pendingGlossaryQueueRef.current.length > 0) {
      const batch = pendingGlossaryQueueRef.current.shift();
      if (batch) {
        for (const entry of batch) {
          const lower = normalizeGlossaryKey(entry.key);
          if (!lower || seenLower.has(lower)) continue;
          seenLower.add(lower);
          queuedDeltaEntries.push(entry);
        }
      }
    }
    if (queuedDeltaEntries.length > 0) {
      try {
        const prevEntries = [...savedGlossaryEntriesRef.current];
        const addedCount = await persistenceService.current.saveGlossaryTerms(queuedDeltaEntries);
        if (addedCount > 0) {
          const masterEntries = await persistenceService.current.loadGlossaryEntries();
          savedGlossaryEntriesRef.current = masterEntries.map(e => ({ ...e }));
          setGlossaryEntries(masterEntries);
          updateLiveGlossary(glossaryEntriesToOutputStr(masterEntries));

          const prevLower = new Set(prevEntries.map(e => normalizeGlossaryKey(e.key)));
          const newlyAddedFromQueue = masterEntries.filter(
            e => !prevLower.has(normalizeGlossaryKey(e.key))
          );
          const cascadeChanges = filterSafeCascadeChanges(
            detectGlossaryChanges({}, glossaryEntriesToRecord(newlyAddedFromQueue))
          );
          if (cascadeChanges.length > 0) {
            const cascadedCount = await syncGlossaryChangesToChapters(
              cascadeChanges,
              { caseInsensitive: true }
            );
            if (cascadedCount > 0) {
              addLog(`  > [术语回溯] 队列新词已回溯统一前文 ${cascadedCount} 处未译残留`, 'info');
            }
          }
        }
      } catch (err) {
        console.error("Failed to flush pending glossary queue:", err);
      }
    }
  };

  // Auto scroll logs
  useEffect(() => {
    if (isLogDrawerOpen && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isLogDrawerOpen]);

  const addLog = (message: string, type: ProcessingLog['type'] = 'info') => {
    const timestamp = Math.max(Date.now(), lastLogTimestampRef.current + 1);
    lastLogTimestampRef.current = timestamp;
    const newLog: ProcessingLog = { timestamp, message, type };
    setLogs(prev => [...prev, newLog]);
    // Async save log
    persistenceService.current.saveLog(newLog).catch(e => console.error("Failed to save log", e));
  };

  const recordTokenUsage = (usage: TokenUsage) => {
    const prev = tokenStatsRef.current;
    const next: TokenUsageStats = {
      promptTokens: prev.promptTokens + usage.promptTokens,
      cachedTokens: prev.cachedTokens + usage.cachedTokens,
      completionTokens: prev.completionTokens + usage.completionTokens,
      reasoningTokens: prev.reasoningTokens + usage.reasoningTokens,
      totalTokens: prev.totalTokens + usage.totalTokens,
      requestCount: prev.requestCount + 1,
    };
    tokenStatsRef.current = next;
    setTokenStats(next);
  };

  const runBookStyleClassification = async (
    chaptersList: Chapter[],
    cssTexts: string[],
    activeCfg: AppConfig,
    options?: { allowAi?: boolean; sessionSnapshot?: SessionState }
  ): Promise<BookStyleRoleMap> => {
    const bodyChaptersHtml = chaptersList
      .filter((c) => !c.isFootnoteSource && Boolean(c.content))
      .map((c) => c.content);
    if (bodyChaptersHtml.length === 0) {
      return bookStyleRolesRef.current;
    }

    const { candidates, roles: localRoles } = styleClassifierRef.current.classifyLocal(
      bodyChaptersHtml,
      cssTexts
    );
    if (!bookStyleRolesAiDoneRef.current && Object.keys(bookStyleRolesRef.current).length === 0 && Object.keys(localRoles).length > 0) {
      updateBookStyleRoles(localRoles);
    }

    if (
      !options?.allowAi ||
      bookStyleRolesAiDoneRef.current ||
      !activeCfg.apiKey ||
      !activeCfg.baseUrl ||
      candidates.length === 0 ||
      isClassifyingStylesRef.current
    ) {
      return bookStyleRolesRef.current;
    }

    isClassifyingStylesRef.current = true;
    try {
      const aiStyleService = new AiService(activeCfg, recordTokenUsage);
      let aiSucceeded = false;
      const { roles: mergedRoles } = await styleClassifierRef.current.classifyBookStylesAi(
        bodyChaptersHtml,
        cssTexts,
        (cands) =>
          aiStyleService.classifyBookStyles(cands).then((res) => {
            aiSucceeded = true;
            return res;
          })
      );

      if (aiSucceeded) {
        bookStyleRolesAiDoneRef.current = true;
      }

      if (Object.keys(mergedRoles).length > 0) {
        updateBookStyleRoles(mergedRoles);

        const cssProfiles = parseEpubCssProfiles(cssTexts);
        const domEngine = new DomMutationEngine();
        let updatedAnyChapter = false;
        const nextChapters = chaptersRef.current.map((ch) => {
          if (ch.translatedMarkdown || ch.proofreadMarkdown || ch.isFootnoteSource || !ch.content) {
            return ch;
          }
          const extracted = domEngine.extractTranslatablePayload(
            ch.content,
            ch.internalizedFootnotes,
            cssProfiles,
            mergedRoles
          );
          if (extracted.payloadText && extracted.payloadText !== ch.markdown) {
            updatedAnyChapter = true;
            const refreshed = {
              ...ch,
              markdown: extracted.payloadText,
              slottedMarkdown: extracted.payloadText
            };
            persistenceService.current.updateChapter(refreshed).catch(() => {});
            return refreshed;
          }
          return ch;
        });

        if (updatedAnyChapter) {
          chaptersRef.current = nextChapters;
          setChapters(nextChapters);
        }

        const latestSession = await persistenceService.current.loadSession();
        const baseSession = latestSession || options?.sessionSnapshot;
        if (baseSession && baseSession.fileName) {
          await persistenceService.current.saveSession({
            ...baseSession,
            cssContents: cssTexts.length > 0 ? cssTexts : baseSession.cssContents,
            bookStyleRoles: mergedRoles,
            bookStyleRolesAiDone: bookStyleRolesAiDoneRef.current,
            tokenStats: tokenStatsRef.current,
            lastUpdated: Date.now()
          });
        }

        addLog(
          `[StyleClassifier] 全书样式语义识别完成（${Object.keys(mergedRoles).length} 个样式类），已应用于赫蹏精排。`,
          'info'
        );
        return mergedRoles;
      }
    } catch {
      // Keep local deterministic fallback roles silently
    } finally {
      isClassifyingStylesRef.current = false;
    }

    return bookStyleRolesRef.current;
  };

  const handleFileSelect = async (file: File) => {
    try {
        // Clear previous session
        await persistenceService.current.clearSession();
    } catch (e) {
        console.error("Failed to clear background session:", e);
    }
    
    setCurrentFile(file);
    revokeDownloadUrl();
    setLogs([]);
    lastLogTimestampRef.current = 0;
    updateLiveGlossary('');
    setGlossaryEntries([]);
    savedGlossaryEntriesRef.current = [];
    pendingGlossaryQueueRef.current = [];
    activeChapterIndexRef.current = -1;
    activeChunkIndexRef.current = 0;
    driftFixesRef.current = [];
    
    // Clear persisted data for new file
    chaptersRef.current = [];
    setChapters([]);
    setPreviewChapter(null);
    setIsMissingZip(false);
    setExportNotification(null);
    coverPathRef.current = undefined;
    cssContentsRef.current = [];
    setBookCssTexts([]);
    updateBookStyleRoles({});
    bookStyleRolesAiDoneRef.current = false;
    isClassifyingStylesRef.current = false;
    updateProgress(0);
    setStatus(AppStatus.IDLE);
    setRestoredSession(false);
    tokenStatsRef.current = EMPTY_TOKEN_STATS;
    setTokenStats(EMPTY_TOKEN_STATS);
    addLog(`Selected file: ${file.name}`, 'info');

    // AUTO-PARSE EPUB IMMEDIATELY
    try {
        setStatus(AppStatus.PARSING);
        addLog("Parsing EPUB and converting XHTML to Markdown...", "process");
        const { 
            chapters: extractedChapters, 
            images, 
            coverPath,
            opfPath,
            opfDir,
            cssFiles,
            cssContents,
            detectedLanguage,
            detectedLanguageSource
        } = await epubService.current.parseEpub(file);
        
        opfPathRef.current = opfPath;
        opfDirRef.current = opfDir;
        cssFilesRef.current = cssFiles;
        cssContentsRef.current = cssContents || [];
        setBookCssTexts(cssContents || []);

        const nextConfig: AppConfig = {
            ...config,
            sourceLanguage: detectedLanguage || config.sourceLanguage
        };
        setConfig(nextConfig);
        setDetectedLanguageInfo({
            language: detectedLanguage,
            source: detectedLanguageSource
        });

        try {
            const arrayBuffer = await file.arrayBuffer();
            await persistenceService.current.saveOriginalZip(arrayBuffer);
        } catch (zipError) {
            console.error("Failed to save original ZIP:", zipError);
        }

        chaptersRef.current = extractedChapters;
        setChapters(extractedChapters); // Sync state for UI
        coverPathRef.current = coverPath;
        footnotePoolRef.current = new FootnotePool();

        // Persist initial data
        await persistenceService.current.saveChapters(extractedChapters);
        await persistenceService.current.saveImages(images);
        
        // Save initial session state
        const initialSession: SessionState = {
            status: AppStatus.IDLE, // Keep IDLE so user can review chapters before starting
            config: nextConfig,
            progress: 0,
            fileName: file.name,
            coverPath: coverPath,
            lastUpdated: Date.now(),
            opfPath,
            opfDir,
            cssFiles,
            cssContents: cssContents || []
        };
        lastSavedConfigJsonRef.current = JSON.stringify(nextConfig);
        await persistenceService.current.saveSession(initialSession);

        const totalInternalizedNotes = extractedChapters.reduce(
            (sum, c) => sum + Object.keys(c.internalizedFootnotes || {}).length,
            0
        );
        const fnSourceCount = extractedChapters.filter(c => c.isFootnoteSource).length;
        addLog(`Extracted ${extractedChapters.length} chapters and ${Object.keys(images).length} images.`, "success");
        addLog(`Detected source language: ${detectedLanguage} (via ${detectedLanguageSource}).`, "info");
        if (totalInternalizedNotes > 0) {
            addLog(`Internalized ${totalInternalizedNotes} cross-file/same-page footnotes (${fnSourceCount} source file(s) protected with 0-Offset).`, "info");
        }
        if (coverPath) {
            addLog(`Cover image detected.`, 'info');
        }

        // Stage 2: Async lightweight AI classification for ambiguous transition pages
        if (config.apiKey && config.baseUrl && extractedChapters.some(c => c.classification?.category === 'ambiguous')) {
            const aiClassifier = new AiService(config, recordTokenUsage);
            pageClassifierRef.current.classifyAmbiguousPagesAi(
                extractedChapters,
                (payload) => aiClassifier.classifyPageSnippet(payload),
                (updatedCh, idx) => {
                    const current = chaptersRef.current[idx];
                    if (!current || current.classification?.stage === 'user_override' || current.isSystemProtected) {
                        return;
                    }
                    chaptersRef.current[idx] = updatedCh;
                    setChapters([...chaptersRef.current]);
                    persistenceService.current.updateChapter(updatedCh).catch(() => {});
                }
            ).catch(() => {});
        }

        // Whole-book local CSS style census (zero-token on import; 1-shot AI deferred until translation starts)
        runBookStyleClassification(
          extractedChapters,
          cssContents || [],
          nextConfig,
          { allowAi: false, sessionSnapshot: initialSession }
        ).catch(() => {});
        
        // Auto-switch to studio preview view so user sees the book content immediately
        setSelectedChapterIndex(0);
        setViewMode('preview');
        setStatus(AppStatus.IDLE); // Return to idle for user to adjust settings/chapters
    } catch (parseError) {
        console.error("Auto-parse failed:", parseError);
        addLog(`Failed to parse EPUB: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`, "error");
        setStatus(AppStatus.ERROR);
    }
  };

  const handleReset = async () => {
    addLog("Clearing all cache and state...", "info");
    try {
        await persistenceService.current.clearSession();
        addLog("Database cleared successfully.", "success");
    } catch (e) {
        console.error("Failed to clear session from DB:", e);
        addLog("Failed to clear database cache. Some data may persist.", "error");
    }
    revokeDownloadUrl();
    setLogs([]);
    lastLogTimestampRef.current = 0;
    updateLiveGlossary('');
    setGlossaryEntries([]);
    savedGlossaryEntriesRef.current = [];
    setEditingTermKey(null);
    pendingGlossaryQueueRef.current = [];
    activeChapterIndexRef.current = -1;
    activeChunkIndexRef.current = 0;
    driftFixesRef.current = [];
    footnotePoolRef.current = new FootnotePool();
    chaptersRef.current = [];
    setChapters([]);
    setSelectedChapterIndex(0);
    setPreviewChapter(null);
    setIsMissingZip(false);
    setExportNotification(null);
    coverPathRef.current = undefined;
    opfPathRef.current = undefined;
    opfDirRef.current = undefined;
    cssFilesRef.current = undefined;
    cssContentsRef.current = [];
    setBookCssTexts([]);
    updateBookStyleRoles({});
    bookStyleRolesAiDoneRef.current = false;
    isClassifyingStylesRef.current = false;
    updateProgress(0);
    setStatus(AppStatus.IDLE);
    setCurrentFile(null);
    setDetectedLanguageInfo(null);
    setRestoredSession(false);
    setShowConfirmReset(false);
    tokenStatsRef.current = EMPTY_TOKEN_STATS;
    setTokenStats(EMPTY_TOKEN_STATS);
    lastSavedConfigJsonRef.current = JSON.stringify(config);
    addLog("Workflow reset.", "info");
  };

  const SOURCE_LANG_ZH_MAP: Record<string, string> = {
    English: '英语',
    Japanese: '日语',
    Korean: '韩语',
    French: '法语',
    German: '德语',
    Spanish: '西班牙语',
    Russian: '俄语',
    Italian: '意大利语',
    Portuguese: '葡萄牙语',
    Dutch: '荷兰语',
    Arabic: '阿拉伯语',
    Latin: '拉丁语',
    Chinese: '中文',
  };

  const buildEffectiveSystemInstruction = (cfg: AppConfig): string => {
    const rawSource = cfg.sourceLanguage.trim() || 'English';
    const localizedSource = SOURCE_LANG_ZH_MAP[rawSource] || rawSource;
    let basePrompt = '';
    if (cfg.enableProofreading) {
      basePrompt = TWO_STEP_BASE_PROMPT.replace(/\[SOURCE_LANG\]/g, localizedSource);
    } else if (cfg.useRecommendedPrompts) {
      basePrompt = RECOMMENDED_TRANSLATION_PROMPT.replace(/\[SOURCE_LANG\]/g, localizedSource);
    } else {
      basePrompt = `你是一位专业的文学翻译专家。请把${localizedSource}内容重写为中文，确保译文生动、地道，并保持原有的段落结构与占位符标签，严禁生成任何标题符号（#）或引用块符号（>）。`;
    }

    return cfg.additionalContext
      ? `${basePrompt}\n\n【书籍元信息与特定翻译要求】\n${cfg.additionalContext}`
      : basePrompt;
  };

  const processChapter = async (
    index: number, 
    aiService: AiService, 
    chapters: Chapter[], 
    effectiveSystemInstruction: string,
    forceTranslateIndices: number[] = [],
    startGlossary: string = ""
  ): Promise<string> => {
    const chapter = chapters[index];
    if (epubService.current.refreshChapterPayloadIfNeeded(chapter)) {
        await persistenceService.current.updateChapter(chapter);
        setChapters([...chaptersRef.current]);
    }
    let updated = false;
    const freshEntries = await persistenceService.current.loadGlossaryEntries();
    savedGlossaryEntriesRef.current = freshEntries.map(e => ({ ...e }));
    const effectiveEntries =
      pendingGlossaryQueueRef.current.length > 0
        ? mergeGlossaryEntries(freshEntries, pendingGlossaryQueueRef.current.flat())
        : freshEntries;
    let currentGlossary = glossaryEntriesToOutputStr(effectiveEntries);
    if (!currentGlossary && startGlossary) {
      currentGlossary = startGlossary;
    }
    
    // Skip empty chapters usually
    if (!chapter.markdown || chapter.markdown.trim().length < 10) {
       if (!chapter.translatedMarkdown) { 
           addLog(`Skipping empty/short chapter: ${chapter.title}`, "info");
       }
       return currentGlossary;
    }
    
    // Handle Footnote Source / Skippable / Reference Logic
    if (
      isFootnoteSourceChapter(chapter) ||
      isChapterEffectivelySkippable(chapter, config.smartSkip)
    ) {
        return currentGlossary;
    }

    if (isChapterEffectivelyReference(chapter, config.smartSkip)) {
        // Keep original: clear any stale translation fields without polluting translatedMarkdown
        const hasStaleTranslation = Boolean(
            chapter.translatedMarkdown !== undefined ||
            chapter.proofreadMarkdown !== undefined ||
            (chapter.translatedChunks && chapter.translatedChunks.length > 0) ||
            (chapter.proofreadChunks && chapter.proofreadChunks.length > 0) ||
            (chapter.translatedFootnotes && Object.keys(chapter.translatedFootnotes).length > 0)
        );
        if (hasStaleTranslation) {
            addLog(`Keeping "${chapter.title}" as original (Reference mode)...`, "info");
            chapter.translatedMarkdown = undefined;
            chapter.proofreadMarkdown = undefined;
            chapter.translatedChunks = undefined;
            chapter.proofreadChunks = undefined;
            chapter.fallbackChunks = undefined;
            chapter.fallbackProofreadChunks = undefined;
            chapter.translatedFootnotes = undefined;
            chapter.chunkGlossaries = undefined;
            chapter.glossary = undefined;
            updated = true;
            await persistenceService.current.updateChapter(chapter);
            setChapters([...chaptersRef.current]);
        }
        return currentGlossary;
    }

    // --- Translation ---
    const needsProofread = config.enableProofreading && !chapter.proofreadMarkdown;
    if (chapter.translatedMarkdown && !needsProofread && forceTranslateIndices.length === 0) {
        // Already translated (and proofread if required), return the current ordered master glossary
        // Do NOT overwrite it with chapter.glossary, which would wipe manual edits!
        return currentGlossary;
    } else {
        setStatus(AppStatus.TRANSLATING);
        setSelectedChapterIndex(index);
        addLog(`Translating [${index+1}/${chapters.length}]: ${chapter.title}${forceTranslateIndices.length ? ' (Retrying failed parts)' : ''}`, "process");
        
        if (!chapter.translatedChunks) chapter.translatedChunks = [];
        if (!chapter.fallbackChunks) chapter.fallbackChunks = [];
        if (!chapter.chunkGlossaries) chapter.chunkGlossaries = [];
        
        const initialGlossaryForChapter = currentGlossary;

        const result = await aiService.translateContent(
            chapter.markdown, 
            'Chinese (Simplified)', 
            effectiveSystemInstruction,
            async (current, total, chunkResult, updatedGlossary, isFallback, stats, chunkFootnotes, chunkUsage) => {
                activeChapterIndexRef.current = index;
                activeChunkIndexRef.current = current;

                if (isPauseRequested.current) {
                    throw new Error("PAUSE_SIGNAL");
                }
                if (isFallback) {
                  const reasonSuffix = stats?.fallbackReason ? ` (${stats.fallbackReason})` : '';
                  addLog(`  > ⚠️ API returned empty/error for part ${current}/${total} of "${chapter.title}"${reasonSuffix}. Kept original.`, 'error');
                  if (!chapter.fallbackChunks!.includes(current - 1)) {
                      chapter.fallbackChunks!.push(current - 1);
                  }
              } else {
                  // Merge new glossary entries into master database (strictly append-only chronological order)
                  if (updatedGlossary) {
                      const deltaEntries = parseGlossaryEntries(updatedGlossary);
                      if (deltaEntries.length > 0) {
                          const existingLower = new Set([
                              ...savedGlossaryEntriesRef.current.map(e => normalizeGlossaryKey(e.key)),
                              ...parseGlossaryEntries(currentGlossary).map(e => normalizeGlossaryKey(e.key))
                          ]);
                          const trulyNewEntries: GlossaryEntry[] = [];
                          for (const entry of deltaEntries) {
                              const lower = normalizeGlossaryKey(entry.key);
                              if (!lower || existingLower.has(lower)) continue;
                              existingLower.add(lower);
                              trulyNewEntries.push(entry);
                          }

                          if (trulyNewEntries.length > 0) {
                              if (isCleaningGlossaryRef.current) {
                                  pendingGlossaryQueueRef.current.push(trulyNewEntries);
                                  // Keep in-memory currentGlossary up-to-date so subsequent chunks don't lose newly discovered terms
                                  const mergedEntries = mergeGlossaryEntries(
                                      parseGlossaryEntries(currentGlossary),
                                      trulyNewEntries
                                  );
                                  currentGlossary = glossaryEntriesToOutputStr(mergedEntries);
                              } else {
                                  const addedCount = await persistenceService.current.saveGlossaryTerms(trulyNewEntries);
                                  if (addedCount > 0) {
                                      const masterEntries = await persistenceService.current.loadGlossaryEntries();
                                      savedGlossaryEntriesRef.current = masterEntries.map(e => ({ ...e }));
                                      setGlossaryEntries(masterEntries);
                                      const fullStr = glossaryEntriesToOutputStr(masterEntries);
                                      updateLiveGlossary(fullStr);
                                      currentGlossary = fullStr;

                                      // 自动将新发现的术语回溯替换到前文已译章节/分片中的未译英文残留
                                      const cascadeChanges = filterSafeCascadeChanges(
                                          detectGlossaryChanges({}, glossaryEntriesToRecord(trulyNewEntries))
                                      );
                                      if (cascadeChanges.length > 0) {
                                          const cascadedCount = await syncGlossaryChangesToChapters(
                                              cascadeChanges,
                                              { caseInsensitive: true }
                                          );
                                          if (cascadedCount > 0) {
                                              addLog(`  > [术语回溯] 新增术语已回溯统一前文 ${cascadedCount} 处未译残留`, 'info');
                                          }
                                      }
                                  }
                              }
                          }
                      }
                  }

                  let glossaryInfo = '';
                  if (stats && stats.originalCount > 0) {
                      const dropped = stats.originalCount - stats.filteredCount;
                      glossaryInfo = `(Glossary: ${stats.filteredCount} kept, ${dropped} dropped)`;
                  } else {
                      const termCount = updatedGlossary ? updatedGlossary.trim().split('\n').filter(l => l.trim()).length : 0;
                      glossaryInfo = `(New Glossary: ${termCount} entries)`;
                  }
                  
                  const actionWord = config.enableProofreading ? "Translated & Reviewed" : "Translated";
                  addLog(`  > ${actionWord} part ${current}/${total} of "${chapter.title}"... ${glossaryInfo}${formatUsageTag(chunkUsage)}`, 'info');
                  if (stats?.corruptedCharCount && stats.corruptedCharCount > 0) {
                      addLog(
                        `  > ⚠️ 检测到模型返回 ${stats.corruptedCharCount} 处编码乱码字符（\uFFFD），建议在章节列表中手动重译「${chapter.title}」第 ${current}/${total} 部分。`,
                        'error'
                      );
                  }
                  

                  if (chapter.fallbackChunks) {
                    chapter.fallbackChunks = chapter.fallbackChunks.filter(idx => idx !== current - 1);
                  }
              }
              
              // Incrementally persist chunk footnotes into chapter state
              if (chunkFootnotes && Object.keys(chunkFootnotes).length > 0) {
                  chapter.translatedFootnotes = {
                      ...(chapter.translatedFootnotes || {}),
                      ...chunkFootnotes
                  };
              }

              if (chapter.translatedChunks) {
                  chapter.translatedChunks![current - 1] = chunkResult;
                  if (!isFallback) {
                      if (!chapter.chunkGlossaries) chapter.chunkGlossaries = [];
                      chapter.chunkGlossaries[current - 1] = updatedGlossary || '';
                  }
                  chapter.translatedMarkdown = chapter.translatedChunks.filter(Boolean).join('\n\n');
                  setChapters([...chaptersRef.current]);
                  await persistenceService.current.updateChapter(chapter);
                  await saveSessionState(AppStatus.TRANSLATING);
              }

              return currentGlossary;
          },
          chapter.translatedChunks,
          forceTranslateIndices,
          initialGlossaryForChapter,
          buildPosteriorTextForChapter(chapters, index, config.smartSkip),
          chapter.internalizedFootnotes || {},
          footnotePoolRef.current
        );
        chapter.translatedMarkdown = result.content;
        chapter.translatedFootnotes = {
            ...(chapter.translatedFootnotes || {}),
            ...(result.translatedFootnotes || {})
        };
        chapter.glossary = result.glossary;
        if (result.driftFixes && result.driftFixes.length > 0) {
            for (const fix of result.driftFixes) {
                driftFixesRef.current.push({ chapterTitle: chapter.title, ...fix });
                addLog(`  > [术语修正] "${chapter.title}" 中 "${fix.key}" 的漂移译名 "${fix.newVal}" 已统一为 "${fix.oldVal}" (${fix.count} 处)`, "info");
            }
        }
        
        currentGlossary = result.glossary;
        
        // If in combined mode, we treat the translation result as the proofread result too
        if (config.enableProofreading) {
            chapter.proofreadMarkdown = result.content;
            chapter.proofreadChunks = [...(chapter.translatedChunks || [])];
            chapter.fallbackProofreadChunks = [...(chapter.fallbackChunks || [])];
        } else {
            chapter.proofreadMarkdown = undefined;
            chapter.proofreadChunks = undefined;
            chapter.fallbackProofreadChunks = undefined;
        }

        updated = true;
        setChapters([...chaptersRef.current]);
    }

    if (updated) {
        await persistenceService.current.updateChapter(chapter);
    }
    return currentGlossary;
  };

  const handleRetryChapter = async (index: number) => {
    if (
      status !== AppStatus.IDLE &&
      status !== AppStatus.ERROR &&
      status !== AppStatus.COMPLETED &&
      status !== AppStatus.PAUSED
    ) {
      return;
    }
    isPauseRequested.current = false;
    
    try {
        const aiService = new AiService(config, recordTokenUsage);
        const chapters = chaptersRef.current;
        const chapter = chapters[index];
        if (epubService.current.refreshChapterPayloadIfNeeded(chapter)) {
            await persistenceService.current.updateChapter(chapter);
            setChapters([...chaptersRef.current]);
        }
        footnotePoolRef.current.restoreFromChapters(chapters);

        // If chapter is skip, reference, or footnote source, do not run AI translation
        if (isChapterNonTranslatable(chapter, config.smartSkip)) {
            addLog(`Chapter "${chapter.title}" is marked as skipped/reference/footnote-source and does not need translation.`, 'info');
            return;
        }

        if (!bookStyleRolesAiDoneRef.current) {
            if (config.apiKey && config.baseUrl) {
                addLog("正在使用大模型识别全书 CSS 排版语义（1-Shot）...", "process");
            }
            await runBookStyleClassification(
                chaptersRef.current,
                cssContentsRef.current,
                config,
                { allowAi: true }
            ).catch(() => {});
        }
        const activeChapters = chaptersRef.current;
        const activeChapter = activeChapters[index];
        {
            // Use AI split to recover original chunk structure
            const sourceChunks = aiService.splitTextIntoChunks(
                activeChapter.markdown,
                config.enableProofreading ? 1800 : undefined
            );
            
            // Sync local fallbacks with detection if needed
            const explicit = activeChapter.fallbackChunks || [];
            const implicit: number[] = [];
            // If translatedMarkdown exists but chunks are missing/mismatched, scan by content
            sourceChunks.forEach((sChunk, i) => {
                const trimmed = sChunk.trim();
                if (trimmed.length > 20 && activeChapter.translatedMarkdown?.includes(trimmed)) {
                    implicit.push(i);
                }
            });
            activeChapter.fallbackChunks = [...new Set([...explicit, ...implicit])].sort((a,b) => a-b);
            
            // Re-initialize chunks array if it's stale/missing
            if (!activeChapter.translatedChunks || activeChapter.translatedChunks.length !== sourceChunks.length) {
                activeChapter.translatedChunks = new Array(sourceChunks.length).fill(null);
                activeChapter.chunkGlossaries = new Array(sourceChunks.length).fill('');
            }
        }

        const effectiveSystemInstruction = buildEffectiveSystemInstruction(config);
            
        let failedIndices = [...(activeChapter.fallbackChunks || [])];
        if (config.enableProofreading && activeChapter.fallbackProofreadChunks) {
            activeChapter.fallbackProofreadChunks.forEach(idx => {
                if (!failedIndices.includes(idx)) failedIndices.push(idx);
            });
        }
        failedIndices.sort((a, b) => a - b);
        
        // If still no failed indices, it means user wants a FULL re-translation (the button says "Re-Translate")
        if (failedIndices.length === 0 && (activeChapter.translatedMarkdown || activeChapter.proofreadMarkdown)) {
            addLog(`Chapter "${activeChapter.title}" requested for full re-translation.`, 'info');
            // Force ALL chunks to be retried
            const sourceChunks = aiService.splitTextIntoChunks(activeChapter.markdown, config.enableProofreading ? 1800 : undefined);
            failedIndices = sourceChunks.map((_, i) => i);
            activeChapter.chunkGlossaries = new Array(sourceChunks.length).fill('');
        }
        
        // Fetch the latest ordered master glossary from DB for accurate retry
        const freshEntries = await persistenceService.current.loadGlossaryEntries();
        const runningGlossary = glossaryEntriesToOutputStr(freshEntries);
        
        await processChapter(index, aiService, activeChapters, effectiveSystemInstruction, failedIndices, runningGlossary);
        
        // Update percentages
        const totalSteps = chapters.length;
        const stepsDoneCount = chapters.reduce((acc, c) => {
            if (isChapterNonTranslatable(c, config.smartSkip)) return acc + 1;
            const tDone = c.translatedMarkdown ? 1 : 0;
            return acc + tDone;
        }, 0);
        const currentProgress = Math.min(100, (stepsDoneCount / totalSteps) * 100);
        updateProgress(currentProgress);
        
        // If reached 100% or was already completed, rebuild to ensure the download reflects the retry
        // We use Math.floor to be safe with float precision
        if ((status === AppStatus.COMPLETED || Math.floor(currentProgress) >= 100) && currentFile) {
            await rebuildEpub(chapters, config, currentFile.name);
        } else {
            // Keep current status if it was COMPLETED (rebuildEpub will set it anyway)
            // or stay IDLE/ERROR
            if (status !== AppStatus.COMPLETED) {
                setStatus(AppStatus.IDLE);
            }
        }
    } catch (e) {
        if (e instanceof Error && e.message === "PAUSE_SIGNAL") {
            addLog("Process paused by user.", "info");
            setStatus(AppStatus.PAUSED);
            await saveSessionState(AppStatus.PAUSED);
            return;
        }
        addLog(`Retry failed: ${e instanceof Error ? e.message : 'Unknown error'}`, 'error');
        setStatus(AppStatus.ERROR);
    }
  };

  const saveSessionState = async (currentStatus: AppStatus, progressOverride?: number) => {
      if (!currentFile) return;
      lastSavedConfigJsonRef.current = JSON.stringify(config);
      await persistenceService.current.saveSession({
          status: currentStatus,
          config,
          progress: progressOverride ?? progressRef.current,
          fileName: currentFile.name,
          coverPath: coverPathRef.current,
          lastUpdated: Date.now(),
          opfPath: opfPathRef.current,
          opfDir: opfDirRef.current,
          cssFiles: cssFilesRef.current,
          cssContents: cssContentsRef.current,
          bookStyleRoles: bookStyleRolesRef.current,
          bookStyleRolesAiDone: bookStyleRolesAiDoneRef.current,
          tokenStats: tokenStatsRef.current
      });
  };

  const syncGlossaryChangesToChapters = async (
    changes: TermChange[],
    options?: { caseInsensitive?: boolean }
  ) => {
    if (changes.length === 0) return 0;

    let totalReplaced = 0;
    let chaptersAffected = 0;
    const updatedChapters = [...chaptersRef.current];

    for (let i = 0; i < updatedChapters.length; i++) {
      const ch = updatedChapters[i];
      if (!ch.translatedMarkdown) continue;

      let chapterChanged = false;
      let chapterCount = 0;

      for (const change of changes) {
        const res = safeReplaceKeyword(ch.translatedMarkdown, change.oldTarget, change.newTarget, options);
        if (res.count > 0) {
          ch.translatedMarkdown = res.replacedText;
          chapterCount += res.count;
          chapterChanged = true;
        }

        if (ch.proofreadMarkdown) {
          const pRes = safeReplaceKeyword(ch.proofreadMarkdown, change.oldTarget, change.newTarget, options);
          if (pRes.count > 0) {
            ch.proofreadMarkdown = pRes.replacedText;
            chapterChanged = true;
          }
        }

        if (ch.translatedChunks && ch.translatedChunks.length > 0) {
          ch.translatedChunks = ch.translatedChunks.map(chunk => {
            if (!chunk) return chunk;
            const cRes = safeReplaceKeyword(chunk, change.oldTarget, change.newTarget, options);
            return cRes.replacedText;
          });
        }

        if (ch.proofreadChunks && ch.proofreadChunks.length > 0) {
          ch.proofreadChunks = ch.proofreadChunks.map(chunk => {
            if (!chunk) return chunk;
            const pRes = safeReplaceKeyword(chunk, change.oldTarget, change.newTarget, options);
            return pRes.replacedText;
          });
        }

        if (ch.translatedFootnotes) {
          for (const fnKey of Object.keys(ch.translatedFootnotes)) {
            const raw = ch.translatedFootnotes[fnKey];
            if (raw) {
              const fnRes = safeReplaceKeyword(raw, change.oldTarget, change.newTarget, options);
              if (fnRes.count > 0) {
                ch.translatedFootnotes[fnKey] = fnRes.replacedText;
                chapterChanged = true;
              }
            }
          }
        }
      }

      if (chapterChanged) {
        chaptersAffected++;
        totalReplaced += chapterCount;
        await persistenceService.current.updateChapter(ch);
      }
    }

    if (chaptersAffected > 0) {
      chaptersRef.current = updatedChapters;
      setChapters([...updatedChapters]);
      footnotePoolRef.current.restoreFromChapters(updatedChapters);
      if (status === AppStatus.COMPLETED) {
        revokeDownloadUrl();
        setDownloadUrl(null);
        addLog("术语已更新至章节内容，点击「下载电子书」可导出最新版本。", "info");
      }
    }

    return totalReplaced;
  };

  const handleUpdateGlossary = async (newText: string) => {
    const newEntries = parseGlossaryEntries(newText);
    const changes = detectGlossaryChanges(
      glossaryEntriesToRecord(savedGlossaryEntriesRef.current),
      glossaryEntriesToRecord(newEntries)
    );
    await persistenceService.current.replaceGlossary(newEntries);
    const updated = await persistenceService.current.loadGlossaryEntries();
    setGlossaryEntries(updated);
    updateLiveGlossary(glossaryEntriesToOutputStr(updated));
    savedGlossaryEntriesRef.current = updated.map(e => ({ ...e }));

    if (changes.length > 0) {
      const replacedCount = await syncGlossaryChangesToChapters(changes);
      const changeSummaries = changes.map(c => `「${c.oldTarget}」→「${c.newTarget}」`).join('、');
      addLog(`[术语联动] 纯文本术语库已保存，并联动替换已译章节：${changeSummaries}（共更新 ${replacedCount} 处）。`, "success");
    } else {
      addLog("全书术语库已手动更新。", "success");
    }
  };

  const commitTermKeyRename = (oldKey: string, rawNewKey: string) => {
    setEditingTermKey(null);
    const { entries: nextEntries, conflictKey } = resolvePendingTermKeyRename(
      glossaryEntries,
      { origKey: oldKey, draft: rawNewKey }
    );
    if (conflictKey) {
      addLog(`术语「${conflictKey}」已存在，已取消覆盖。`, "error");
      return;
    }
    if (nextEntries === glossaryEntries) return;
    setGlossaryEntries(nextEntries);
    updateLiveGlossary(glossaryEntriesToOutputStr(nextEntries));
  };

  const handleToggleBulkEdit = () => {
    if (isBulkEdit) {
      const parsed = parseGlossaryEntries(liveGlossaryRef.current);
      setEditingTermKey(null);
      setGlossaryEntries(parsed);
      setIsBulkEdit(false);
    } else {
      const { entries: resolved, conflictKey } = resolvePendingTermKeyRename(glossaryEntries, editingTermKey);
      if (conflictKey) {
        addLog(`术语「${conflictKey}」已存在，已取消覆盖。`, "error");
      }
      setEditingTermKey(null);
      setGlossaryEntries(resolved);
      updateLiveGlossary(glossaryEntriesToOutputStr(resolved));
      setIsBulkEdit(true);
    }
  };

  const handleDeleteTerm = (key: string) => {
    if (editingTermKey?.origKey === key) {
      setEditingTermKey(null);
    }
    const nextEntries = glossaryEntries.filter(e => e.key !== key);
    setGlossaryEntries(nextEntries);
    updateLiveGlossary(glossaryEntriesToOutputStr(nextEntries));
  };

  const handleAddTerm = () => {
     const existingKeys = new Set(glossaryEntries.map(e => e.key));
     let index = glossaryEntries.length + 1;
     let newKey = `新词条_${index}`;
     while (existingKeys.has(newKey)) {
       index++;
       newKey = `新词条_${index}`;
     }
     const nextEntries = [...glossaryEntries, { key: newKey, value: "" }];
     setGlossaryEntries(nextEntries);
     updateLiveGlossary(glossaryEntriesToOutputStr(nextEntries));
  };

  const handleUpdateTermTarget = (key: string, newTarget: string) => {
    const nextEntries = glossaryEntries.map(e =>
      e.key === key ? { key: e.key, value: newTarget } : e
    );
    setGlossaryEntries(nextEntries);
    updateLiveGlossary(glossaryEntriesToOutputStr(nextEntries));
  };

  const handleSaveGlossaryMap = async () => {
    const { entries: resolved, conflictKey } = resolvePendingTermKeyRename(glossaryEntries, editingTermKey);
    if (conflictKey) {
      addLog(`术语「${conflictKey}」已存在，已取消覆盖。`, "error");
    }
    setEditingTermKey(null);
    const cleanEntries = buildCleanedGlossaryEntries(resolved);
    const changes = detectGlossaryChanges(
      glossaryEntriesToRecord(savedGlossaryEntriesRef.current),
      glossaryEntriesToRecord(cleanEntries)
    );
    await persistenceService.current.replaceGlossary(cleanEntries);
    setGlossaryEntries(cleanEntries);
    updateLiveGlossary(glossaryEntriesToOutputStr(cleanEntries));
    savedGlossaryEntriesRef.current = cleanEntries.map(e => ({ ...e }));

    if (changes.length > 0) {
      const replacedCount = await syncGlossaryChangesToChapters(changes);
      const changeSummaries = changes.map(c => `「${c.oldTarget}」→「${c.newTarget}」`).join('、');
      addLog(`[术语联动] 已保存术语库，并联动替换已译章节：${changeSummaries}（共更新 ${replacedCount} 处）。`, "success");
    } else {
      addLog("全书术语库已保存。", "success");
    }
  };

  const handleManualSyncGlossary = async () => {
    let cleanEntries: GlossaryEntry[];
    if (isBulkEdit) {
      cleanEntries = parseGlossaryEntries(liveGlossaryRef.current);
    } else {
      const { entries: resolved, conflictKey } = resolvePendingTermKeyRename(glossaryEntries, editingTermKey);
      if (conflictKey) {
        addLog(`术语「${conflictKey}」已存在，已取消覆盖。`, "error");
      }
      setEditingTermKey(null);
      cleanEntries = buildCleanedGlossaryEntries(resolved);
    }
    const changes = detectGlossaryChanges(
      glossaryEntriesToRecord(savedGlossaryEntriesRef.current),
      glossaryEntriesToRecord(cleanEntries)
    );
    if (changes.length === 0) {
      addLog("[术语联动] 当前术语表未检测到新旧译法变更。如需按最新术语重写上下文，可在章节列表中点击「重新翻译」。", "info");
      return;
    }
    await persistenceService.current.replaceGlossary(cleanEntries);
    setGlossaryEntries(cleanEntries);
    updateLiveGlossary(glossaryEntriesToOutputStr(cleanEntries));
    savedGlossaryEntriesRef.current = cleanEntries.map(e => ({ ...e }));
    const count = await syncGlossaryChangesToChapters(changes);
    addLog(`[术语联动] 手动触发联动完成，共更新已译章节 ${count} 处。`, "success");
  };

  const toggleChapterSkip = async (index: number) => {
    const target = chaptersRef.current[index];
    if (!target || isFootnoteSourceChapter(target)) return;

    const updatedChapters = [...chaptersRef.current];
    const nextSkippable = !isChapterEffectivelySkippable(target, config.smartSkip);
    updatedChapters[index] = {
      ...target,
      isSkippable: nextSkippable,
      isReference: false,
      classification: {
        category: target.classification?.category || (nextSkippable ? 'front_matter' : 'content'),
        disposition: nextSkippable ? 'skip' : 'translate',
        confidence: target.classification?.confidence ?? 1,
        reason: target.classification?.reason || '用户手动设置',
        stage: 'user_override',
        isSystemProtected: target.classification?.isSystemProtected
      }
    };
    chaptersRef.current = updatedChapters;
    setChapters(updatedChapters);

    const doneCount = updatedChapters.filter(
      (c) => isChapterNonTranslatable(c, config.smartSkip) || Boolean(c.translatedMarkdown)
    ).length;
    updateProgress(updatedChapters.length > 0 ? Math.min(100, (doneCount / updatedChapters.length) * 100) : 0);

    await persistenceService.current.updateChapter(updatedChapters[index]);
    addLog(`Chapter "${updatedChapters[index].title}" marked as ${nextSkippable ? 'Skipped (Excluded from EPUB)' : 'Included'}.`, 'info');
    
    if (status === AppStatus.COMPLETED) {
      revokeDownloadUrl();
      setDownloadUrl(null);
      addLog("章节跳过状态已更新，点击「下载电子书」可导出最新版本。", "info");
    }
  };

  const toggleChapterReference = async (index: number) => {
    const target = chaptersRef.current[index];
    if (!target || isFootnoteSourceChapter(target)) return;

    const updatedChapters = [...chaptersRef.current];
    const nextReference = !isChapterEffectivelyReference(target, config.smartSkip);
    updatedChapters[index] = {
      ...target,
      isReference: nextReference,
      isSkippable: false,
      ...(nextReference
        ? {
            translatedMarkdown: undefined,
            proofreadMarkdown: undefined,
            translatedChunks: undefined,
            proofreadChunks: undefined,
            fallbackChunks: undefined,
            fallbackProofreadChunks: undefined,
            translatedFootnotes: undefined
          }
        : {}),
      classification: {
        category: target.classification?.category || (nextReference ? 'back_matter' : 'content'),
        disposition: nextReference ? 'keep_original' : 'translate',
        confidence: target.classification?.confidence ?? 1,
        reason: target.classification?.reason || '用户手动设置',
        stage: 'user_override',
        isSystemProtected: target.classification?.isSystemProtected
      }
    };
    chaptersRef.current = updatedChapters;
    setChapters(updatedChapters);

    const doneCount = updatedChapters.filter(
      (c) => isChapterNonTranslatable(c, config.smartSkip) || Boolean(c.translatedMarkdown)
    ).length;
    updateProgress(updatedChapters.length > 0 ? Math.min(100, (doneCount / updatedChapters.length) * 100) : 0);

    await persistenceService.current.updateChapter(updatedChapters[index]);
    addLog(`Chapter "${updatedChapters[index].title}" marked as ${nextReference ? 'Reference (Keep original, no translation)' : 'To Translate'}.`, 'info');

    if (status === AppStatus.COMPLETED) {
      revokeDownloadUrl();
      setDownloadUrl(null);
      addLog("章节参考状态已更新，点击「下载电子书」可导出最新版本。", "info");
    }
  };

  const handlePause = () => {
    if (status === AppStatus.TRANSLATING ||  status === AppStatus.PARSING) {
        isPauseRequested.current = true;
        addLog("Pause requested. Finish current chapter and stopping...", "info");
    }
  };

  const triggerFileDownload = (blob: Blob, downloadFileName: string) => {
    try {
      revokeDownloadUrl();
      const url = URL.createObjectURL(blob);
      lastDownloadUrlRef.current = url;
      setDownloadUrl(url);

      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.setAttribute('download', downloadFileName);
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        try {
          if (document.body.contains(a)) {
            document.body.removeChild(a);
          }
        } catch {
          // ignore
        }
      }, 10000);
      return { success: true, url };
    } catch (err) {
      console.error("Failed to trigger file download via anchor:", err);
      return { success: false, url: '' };
    }
  };

  const handleMissingZipFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (chaptersRef.current.length === 0) {
      await handleFileSelect(file);
      return;
    }
    try {
      addLog("正在恢复原始 EPUB 缓存...", "process");
      setExportNotification({
        type: 'process',
        message: '正在恢复原始 EPUB 缓存并继续导出...'
      });
      const arrayBuffer = await file.arrayBuffer();
      await persistenceService.current.saveOriginalZip(arrayBuffer);

      const parsed = await epubService.current.parseEpub(file);
      opfPathRef.current = parsed.opfPath;
      opfDirRef.current = parsed.opfDir;
      cssFilesRef.current = parsed.cssFiles;
      cssContentsRef.current = parsed.cssContents || [];
      setBookCssTexts(parsed.cssContents || []);

      setCurrentFile(file);
      setIsMissingZip(false);
      addLog("原始 EPUB 缓存恢复成功，正在自动执行导出...", "success");

      const pending = pendingExportRef.current;
      pendingExportRef.current = null;
      if (pending && pending.kind === 'single') {
        await handleDownloadWithMode(pending.mode, pending.wereadMode);
      } else {
        await handleDownloadAllZip();
      }
    } catch (err: any) {
      console.error("Failed to restore zip:", err);
      addLog(`恢复 EPUB 缓存失败：${err.message}`, "error");
      setExportNotification({
        type: 'error',
        message: `恢复 EPUB 缓存失败：${err.message}`
      });
    } finally {
      e.target.value = '';
    }
  };

  const rebuildEpub = async (chaptersList: Chapter[], sessionConfig: AppConfig, fileName: string) => {
    setStatus(AppStatus.PACKAGING);
    addLog(`Recompiling EPUB...`, "process");
    setExportNotification({
      type: 'process',
      message: '正在编译并生成 EPUB 电子书...'
    });
    
    try {
        const ctx = await prepareEpubExportContext(
          { kind: 'single', mode: 'none', wereadMode: true },
          { chaptersList, sessionConfig, fileName }
        );
        const originalZip = await new JSZip().loadAsync(ctx.zipBuffer);
        const blob = await epubService.current.generateEpub(
          ctx.chaptersToPack,
          originalZip,
          ctx.opfPath,
          ctx.opfDir,
          ctx.cssFiles,
          ctx.baseName,
          'Chinese (Simplified)',
          undefined,
          ctx.excludeFileNames,
          'none',
          true,
          bookStyleRolesRef.current
        );
        
        const downloadFileName = `${ctx.baseName}【TransLit-微信专版】.epub`;
        const { success: triggered, url } = triggerFileDownload(blob, downloadFileName);
        setStatus(AppStatus.COMPLETED);
        addLog(`EPUB 导出成功：${downloadFileName}`, "success");
        if (triggered) {
          setExportNotification({
            type: 'success',
            message: `《${downloadFileName}》导出成功，浏览器已发起下载！`,
            downloadUrl: url,
            fileName: downloadFileName
          });
        }
        await saveSessionState(AppStatus.COMPLETED);
    } catch (e: any) {
        addLog(`Packaging failed: ${e instanceof Error ? e.message : 'Unknown error'}`, "error");
        setStatus(AppStatus.ERROR);
        setExportNotification({
          type: 'error',
          message: `导出失败：${e?.message || '未知错误'}`
        });
    }
  };

  const EXPORT_VARIANTS: Array<{
    mode: BilingualMode;
    wereadMode: boolean;
    label: string;
    editionLabel: string;
    suffix: string;
  }> = [
    { mode: 'none', wereadMode: true, label: '纯译文版', editionLabel: '微信读书专版', suffix: '【TransLit-微信专版】' },
    { mode: 'source_first', wereadMode: true, label: '双语对照·原文在前', editionLabel: '微信读书专版', suffix: '【TransLit-双语-原文在前-微信专版】' },
    { mode: 'target_first', wereadMode: true, label: '双语对照·译文在前', editionLabel: '微信读书专版', suffix: '【TransLit-双语-译文在前-微信专版】' },
    { mode: 'none', wereadMode: false, label: '纯译文版', editionLabel: '通用电子版', suffix: '【TransLit-通用电子版】' },
    { mode: 'source_first', wereadMode: false, label: '双语对照·原文在前', editionLabel: '通用电子版', suffix: '【TransLit-双语-原文在前】' },
    { mode: 'target_first', wereadMode: false, label: '双语对照·译文在前', editionLabel: '通用电子版', suffix: '【TransLit-双语-译文在前】' },
  ];

  const prepareEpubExportContext = async (
    pendingAction: { kind: 'all' } | { kind: 'single'; mode: BilingualMode; wereadMode: boolean },
    overrides?: { chaptersList?: Chapter[]; sessionConfig?: AppConfig; fileName?: string }
  ) => {
    const activeChapters = overrides?.chaptersList ?? chaptersRef.current;
    const activeConfig = overrides?.sessionConfig ?? config;

    const chaptersToPack = activeChapters
      .filter(c => !isChapterEffectivelySkippable(c, activeConfig.smartSkip))
      .map(c => {
        const effRef = isChapterEffectivelyReference(c, activeConfig.smartSkip);
        return effRef
          ? { ...c, isReference: true, translatedMarkdown: undefined, proofreadMarkdown: undefined, translatedFootnotes: undefined }
          : { ...c, isReference: false };
      });
    if (chaptersToPack.length === 0) {
      throw new Error("没有可导出的章节内容。");
    }

    const excludeFileNames = activeChapters
      .filter(c => isChapterEffectivelySkippable(c, activeConfig.smartSkip))
      .map(c => c.fileName);

    let zipBuffer = await persistenceService.current.loadOriginalZip();
    if (!zipBuffer && currentFile && typeof (currentFile as any).arrayBuffer === 'function') {
      zipBuffer = await (currentFile as any).arrayBuffer();
      await persistenceService.current.saveOriginalZip(zipBuffer);
    }

    if (!zipBuffer) {
      pendingExportRef.current = pendingAction;
      setIsMissingZip(true);
      if (missingZipInputRef.current) {
        missingZipInputRef.current.click();
      }
      throw new Error("当前为恢复的历史翻译进度。打包 EPUB 需要提供一次原始文件以保留原书排版与图片，已为您打开文件选择器。");
    }

    if (opfPathRef.current == null || opfDirRef.current == null) {
      const tempZip = await new JSZip().loadAsync(zipBuffer);
      const containerFile = tempZip.file("META-INF/container.xml");
      if (containerFile) {
        const containerXml = await containerFile.async("string");
        const rootfileMatch = containerXml.match(/full-path="([^"]+)"/);
        if (rootfileMatch) {
          opfPathRef.current = rootfileMatch[1];
          const lastSlash = rootfileMatch[1].lastIndexOf('/');
          opfDirRef.current = lastSlash >= 0 ? rootfileMatch[1].substring(0, lastSlash + 1) : '';
          const opfFile = tempZip.file(opfPathRef.current);
          if (opfFile) {
            const opfContent = await opfFile.async("string");
            const cssMatches = [...opfContent.matchAll(/href="([^"]+\.css)"/g)];
            cssFilesRef.current = cssMatches.map(m => opfDirRef.current + m[1]);
          }
        }
      }
    }

    if (opfPathRef.current == null || opfDirRef.current == null) {
      throw new Error("无法读取 EPUB 结构（缺少 OPF 路径），请重新导入电子书。");
    }

    setIsMissingZip(false);
    const fileName = overrides?.fileName || currentFile?.name || 'book';
    const baseName = fileName.replace(/\.epub$/i, '') || 'translated_book';

    return {
      chaptersToPack,
      excludeFileNames,
      zipBuffer,
      opfPath: opfPathRef.current,
      opfDir: opfDirRef.current,
      cssFiles: cssFilesRef.current || [],
      baseName,
    };
  };

  const handleDownloadAllZip = async () => {
    setIsDownloadDropdownOpen(false);
    setIsPackagingBilingual(true);

    addLog(`正在打包全部 ${EXPORT_VARIANTS.length} 个版本的 EPUB 合集压缩包...`, "process");
    setExportNotification({
      type: 'process',
      message: `正在编译并打包全版本合集 (0/${EXPORT_VARIANTS.length})，请稍候...`
    });

    try {
      const ctx = await prepareEpubExportContext({ kind: 'all' });
      const bundleZip = new JSZip();

      for (let i = 0; i < EXPORT_VARIANTS.length; i++) {
        const variant = EXPORT_VARIANTS[i];
        setExportNotification({
          type: 'process',
          message: `正在编译并打包全版本合集 (${i + 1}/${EXPORT_VARIANTS.length})：${variant.editionLabel}·${variant.label}...`
        });

        // generateEpub mutates the passed JSZip instance, so load a fresh copy per variant
        const originalZip = await new JSZip().loadAsync(ctx.zipBuffer);
        const epubBlob = await epubService.current.generateEpub(
          ctx.chaptersToPack,
          originalZip,
          ctx.opfPath,
          ctx.opfDir,
          ctx.cssFiles,
          ctx.baseName,
          'Chinese (Simplified)',
          undefined,
          ctx.excludeFileNames,
          variant.mode,
          variant.wereadMode,
          bookStyleRolesRef.current
        );

        const epubFileName = `${ctx.baseName}${variant.suffix}.epub`;
        bundleZip.file(epubFileName, epubBlob);
      }

      setExportNotification({
        type: 'process',
        message: '正在生成 ZIP 压缩包，请稍候...'
      });

      const zipBlob = await bundleZip.generateAsync({
        type: 'blob',
        compression: 'STORE'
      });

      const downloadFileName = `${ctx.baseName}【TransLit-全版本合集】.zip`;
      const { success: triggered, url } = triggerFileDownload(zipBlob, downloadFileName);
      if (triggered) {
        addLog(`合集导出成功：${downloadFileName}`, "success");
        setExportNotification({
          type: 'success',
          message: `《${downloadFileName}》导出成功，已包含全部 ${EXPORT_VARIANTS.length} 个版本！`,
          downloadUrl: url,
          fileName: downloadFileName
        });
      } else {
        throw new Error("浏览器拦截了自动下载，请允许本页下载文件。");
      }
    } catch (e: any) {
      console.error("Bundle export error:", e);
      addLog(`合集导出失败：${e?.message || '未知错误'}`, "error");
      setExportNotification({
        type: 'error',
        message: `导出失败：${e?.message || '未知错误'}`
      });
    } finally {
      setIsPackagingBilingual(false);
    }
  };

  const handleDownloadWithMode = async (mode: BilingualMode = 'none', wereadMode: boolean = true) => {
    setIsDownloadDropdownOpen(false);
    setIsPackagingBilingual(true);

    const variant = EXPORT_VARIANTS.find(v => v.mode === mode && v.wereadMode === wereadMode) || EXPORT_VARIANTS[0];
    addLog(`正在编译并导出 EPUB (${variant.editionLabel}·${variant.label})...`, "process");
    setExportNotification({
      type: 'process',
      message: `正在编译并导出《${variant.editionLabel}·${variant.label}》，请稍候...`
    });

    try {
      const ctx = await prepareEpubExportContext({ kind: 'single', mode, wereadMode });
      const originalZip = await new JSZip().loadAsync(ctx.zipBuffer);
      const blob = await epubService.current.generateEpub(
        ctx.chaptersToPack,
        originalZip,
        ctx.opfPath,
        ctx.opfDir,
        ctx.cssFiles,
        ctx.baseName,
        'Chinese (Simplified)',
        undefined,
        ctx.excludeFileNames,
        mode,
        wereadMode,
        bookStyleRolesRef.current
      );

      const downloadFileName = `${ctx.baseName}${variant.suffix}.epub`;

      const { success: triggered, url } = triggerFileDownload(blob, downloadFileName);
      if (triggered) {
        addLog(`导出成功：${downloadFileName}`, "success");
        setExportNotification({
          type: 'success',
          message: `《${downloadFileName}》导出成功，浏览器已发起下载！`,
          downloadUrl: url,
          fileName: downloadFileName
        });
      } else {
        throw new Error("浏览器拦截了自动下载，请允许本页下载文件。");
      }
    } catch (e: any) {
      console.error("Export error:", e);
      addLog(`导出失败：${e?.message || '未知错误'}`, "error");
      setExportNotification({
        type: 'error',
        message: `导出失败：${e?.message || '未知错误'}`
      });
    } finally {
      setIsPackagingBilingual(false);
    }
  };

  const startProcessing = async (mode: 'normal' | 'retry' = 'normal') => {
    if (!currentFile && !chaptersRef.current.length) return;

    try {
      const aiService = new AiService(config, recordTokenUsage);
      
      // Step 1: Parse EPUB (Only if not already parsed - fallback safety)
      if (chaptersRef.current.length === 0 && currentFile) {
        setStatus(AppStatus.PARSING);
        addLog("Parsing EPUB and converting XHTML to Markdown...", "process");
        const { 
            chapters: extractedChapters, 
            images, 
            coverPath,
            opfPath,
            opfDir,
            cssFiles,
            cssContents
        } = await epubService.current.parseEpub(currentFile);
        
        opfPathRef.current = opfPath;
        opfDirRef.current = opfDir;
        cssFilesRef.current = cssFiles;
        cssContentsRef.current = cssContents || [];
        setBookCssTexts(cssContents || []);

        try {
            const arrayBuffer = await currentFile.arrayBuffer();
            await persistenceService.current.saveOriginalZip(arrayBuffer);
        } catch (zipError) {
            console.error("Failed to save original ZIP in startProcessing:", zipError);
        }

        chaptersRef.current = extractedChapters;
        setChapters(extractedChapters); // Sync state
        coverPathRef.current = coverPath;

        // Persist initial data
        await persistenceService.current.saveChapters(extractedChapters);
        await persistenceService.current.saveImages(images);
        
        // Save initial session state
        const fallbackSession: SessionState = {
            status: AppStatus.PARSING,
            config,
            progress: 0,
            fileName: currentFile.name,
            coverPath: coverPath,
            lastUpdated: Date.now(),
            opfPath,
            opfDir,
            cssFiles,
            cssContents: cssContents || []
        };
        await persistenceService.current.saveSession(fallbackSession);

        addLog(`Extracted ${extractedChapters.length} chapters and ${Object.keys(images).length} images.`, "success");
        if (coverPath) {
            addLog(`Cover image detected.`, 'info');
        }
      }

      const effectiveSystemInstruction = buildEffectiveSystemInstruction(config);
        
      const modelDisplay = config.enableProofreading ? `${config.modelName} (Two-Step)` : config.modelName;
      addLog(`Starting translation using ${modelDisplay}...`, "info");
      
      let chaptersTranslatedCount = 0;
      
      if (config.smartSkip) {
        addLog("Smart Skip enabled: Title pages, Copyright, TOC will be REMOVED. References will be KEPT (untranslated).", "info");
      }

      let runningGlossary = "";
      // Load current ordered master glossary from persistence
      const initialGlossaryEntries = await persistenceService.current.loadGlossaryEntries();
      savedGlossaryEntriesRef.current = initialGlossaryEntries.map(e => ({ ...e }));
      setGlossaryEntries(initialGlossaryEntries);
      runningGlossary = glossaryEntriesToOutputStr(initialGlossaryEntries);
      updateLiveGlossary(runningGlossary);

      isPauseRequested.current = false; // Reset pause flag
      driftFixesRef.current = [];
      footnotePoolRef.current.restoreFromChapters(chaptersRef.current);
      setStatus(AppStatus.TRANSLATING);

      if (!bookStyleRolesAiDoneRef.current) {
        if (config.apiKey && config.baseUrl) {
          addLog("正在使用大模型识别全书 CSS 排版语义（1-Shot）...", "process");
        }
        await runBookStyleClassification(
          chaptersRef.current,
          cssContentsRef.current,
          config,
          { allowAi: true }
        ).catch(() => {});
        if (isPauseRequested.current) {
          addLog("Process paused by user.", "info");
          setStatus(AppStatus.PAUSED);
          await saveSessionState(AppStatus.PAUSED);
          return;
        }
      }

      for (let i = 0; i < chaptersRef.current.length; i++) {
        if (isPauseRequested.current) {
            addLog("Process paused by user.", "info");
            setStatus(AppStatus.PAUSED);
            await saveSessionState(AppStatus.PAUSED);
            return;
        }

        // Re-check skip/reference status in each iteration to respect real-time user changes
        const currentChapter = chaptersRef.current[i];
        if (isChapterEffectivelySkippable(currentChapter, config.smartSkip)) {
            continue;
        }

        // AUTO-RETRY logic: Only retry if mode is explicitly 'retry'
        // This follows user request: "Ignore failed parts, finish untouched first"
        let chapterFallbacks: number[] = [];
        if (mode === 'retry') {
            chapterFallbacks = [...(currentChapter.fallbackChunks || [])];
            if (config.enableProofreading && currentChapter.fallbackProofreadChunks) {
                // Merge unique indices
                currentChapter.fallbackProofreadChunks.forEach(idx => {
                    if (!chapterFallbacks.includes(idx)) chapterFallbacks.push(idx);
                });
            }
            chapterFallbacks.sort((a, b) => a - b);
        }

        runningGlossary = await processChapter(i, aiService, chaptersRef.current, effectiveSystemInstruction, chapterFallbacks, runningGlossary);
        chaptersTranslatedCount++;
        addLog(`Finished Chapter ${i+1}`, "success");
        
        // Update progress
        const currentTotalSteps = chaptersRef.current.length;
        const stepsDone = chaptersRef.current.reduce((acc, c) => {
             if (isChapterNonTranslatable(c, config.smartSkip)) return acc + 1;
             const tDone = c.translatedMarkdown ? 1 : 0;
             return acc + tDone;
        }, 0);
        
        const newProgress = Math.min(100, (stepsDone / currentTotalSteps) * 100);
        updateProgress(newProgress);
        await saveSessionState(AppStatus.TRANSLATING, newProgress);
      }

      // Final Step: Packaging
      if (currentFile) {
          updateProgress(100);

          addLog(`----------------------------------------`, "info");
          addLog(`Translation Completed!`, "success");
          addLog(`Chapters Processed: ${chaptersTranslatedCount}`, "info");
          if (driftFixesRef.current.length > 0) {
              const totalReplaced = driftFixesRef.current.reduce((sum, f) => sum + f.count, 0);
              addLog(`[术语一致性修复汇总] 共在 ${driftFixesRef.current.length} 项记录、${totalReplaced} 处正文中将新译名统一回旧译名：`, "info");
              for (const fix of driftFixesRef.current) {
                  addLog(`  · [${fix.chapterTitle}] ${fix.key}: "${fix.newVal}" → "${fix.oldVal}" (${fix.count} 处)`, "info");
              }
          }
          addLog(`----------------------------------------`, "info");
          
          await rebuildEpub(chaptersRef.current, config, currentFile.name);
      } else {
          addLog("Missing file context for packaging.", "error");
          setStatus(AppStatus.ERROR);
      }

    } catch (error) {
      if (error instanceof Error && error.message === "PAUSE_SIGNAL") {
          addLog("Process paused immediately.", "info");
          setStatus(AppStatus.PAUSED);
          await saveSessionState(AppStatus.PAUSED);
          return;
      }
      console.error(error);
      setStatus(AppStatus.ERROR);
      await saveSessionState(AppStatus.ERROR);
      addLog(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, "error");
    }
  };

  const getActionText = () => {
      const hasPendingTranslation = chapters.some(c => 
          c.markdown && c.markdown.trim().length >= 10 && !isChapterNonTranslatable(c, config.smartSkip) && !c.translatedMarkdown
      );
      const hasPendingProofread = config.enableProofreading && chapters.some(c => 
          c.markdown && c.markdown.trim().length >= 10 && !isChapterNonTranslatable(c, config.smartSkip) && c.translatedMarkdown && !c.proofreadMarkdown
      );
      const hasAnyFallbacks = chapters.some(c => 
          !isChapterNonTranslatable(c, config.smartSkip) && (
            (c.fallbackChunks && c.fallbackChunks.length > 0) || 
            (config.enableProofreading && c.fallbackProofreadChunks && c.fallbackProofreadChunks.length > 0)
          )
      );

      if (status === AppStatus.COMPLETED) {
          if (hasPendingTranslation) return "继续翻译";
          if (hasPendingProofread) return "开始润色";
          if (hasAnyFallbacks) return "重试失败片段";
          return "重新导出";
      }
      
      if (status === AppStatus.ERROR || status === AppStatus.PAUSED || status === AppStatus.IDLE) {
          if (hasPendingTranslation) return "继续翻译";
          if (hasPendingProofread) return "继续润色";
          if (hasAnyFallbacks) return "重试失败片段";
          return chapters.length > 0 ? "重新导出" : "开始翻译";
      }
      
      return "开始处理";
  };

  const handleMainActionClick = () => {
    const text = getActionText();
    if (text === "重新导出") {
      handleDownloadAllZip();
    } else {
      startProcessing(text.includes("重试") ? "retry" : "normal");
    }
  };

  const chapterFallbacksMap = useMemo(() => {
    const map = new Map<string, { detectedFallbacks: number[]; detectedProofreadFallbacks: number[] }>();
    for (const chapter of chapters) {
      const explicitFallbacks = chapter.fallbackChunks || [];
      const implicitFallbacks: number[] = [];
      const shouldSkipHeuristic = isChapterEffectivelyReference(chapter, config.smartSkip);

      if (chapter.translatedMarkdown && chapter.fallbackChunks === undefined && !shouldSkipHeuristic) {
        const sourceChunks = splitTextIntoChunks(
          chapter.markdown || '',
          config.enableProofreading ? 1800 : 3000
        );
        if (chapter.translatedChunks && chapter.translatedChunks.length === sourceChunks.length) {
          chapter.translatedChunks.forEach((chunk, i) => {
            if (i < sourceChunks.length && chunk && chunk.trim() === sourceChunks[i].trim() && !explicitFallbacks.includes(i)) {
              implicitFallbacks.push(i);
            }
          });
        }
        if (implicitFallbacks.length === 0 && explicitFallbacks.length === 0) {
          sourceChunks.forEach((sChunk, i) => {
            const trimmed = sChunk.trim();
            if (trimmed.length > 40 && chapter.translatedMarkdown!.includes(trimmed)) {
              implicitFallbacks.push(i);
            }
          });
        }
      }

      map.set(chapter.id, {
        detectedFallbacks: [...new Set([...explicitFallbacks, ...implicitFallbacks])].sort((a, b) => a - b),
        detectedProofreadFallbacks: chapter.fallbackProofreadChunks || [],
      });
    }
    return map;
  }, [chapters, config.enableProofreading, config.smartSkip]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <header className="bg-white border-b border-black px-8 py-5 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-4">
          <img src={logoUrl} alt="TransLit Logo" className="w-9 h-9 object-contain" />
          <div>
            <h1 className="text-2xl font-mono font-bold text-black tracking-widest uppercase">TransLit</h1>
            <p className="text-[10px] font-mono font-bold text-neutral-500 uppercase tracking-widest mt-0.5">电子书 AI 翻译与排版引擎</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
            {restoredSession && status !== AppStatus.TRANSLATING && (
                <span className="h-9 px-3.5 bg-neutral-100 text-black border border-black flex items-center gap-2 font-mono text-xs uppercase tracking-wider select-none shrink-0 shadow-none">
                    <Save className="w-4 h-4 text-black shrink-0" />
                    <span>已恢复进度</span>
                </span>
            )}
            {(downloadUrl || chapters.length > 0) && status !== AppStatus.TRANSLATING && status !== AppStatus.PARSING && status !== AppStatus.PACKAGING && (
              <div className="relative" ref={downloadDropdownRef}>
                <div className="inline-flex h-9 border border-black divide-x divide-neutral-700 bg-black shrink-0 shadow-none">
                  <button
                    onClick={handleDownloadAllZip}
                    disabled={isPackagingBilingual}
                    title="打包下载全部 6 个版本 (ZIP)"
                    className="h-full flex items-center gap-2 bg-black hover:bg-neutral-800 text-white px-4 font-mono text-xs tracking-wider uppercase transition-colors shadow-none disabled:opacity-50"
                  >
                    {isPackagingBilingual ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <Download className="w-4 h-4 shrink-0" />}
                    <span>{isPackagingBilingual ? '正在打包...' : '下载电子书'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsDownloadDropdownOpen(prev => !prev)}
                    disabled={isPackagingBilingual}
                    className="h-full flex items-center justify-center px-2.5 bg-black hover:bg-neutral-800 text-white transition-colors disabled:opacity-50"
                    title="选择单独下载版本"
                  >
                    <ChevronDown className="w-4 h-4 shrink-0" />
                  </button>
                </div>

                {isDownloadDropdownOpen && (
                  <div className="absolute right-0 mt-1 w-60 bg-white border border-black shadow-lg z-50 py-1 font-mono text-xs divide-y divide-neutral-100">
                    {[
                      { wereadMode: true, title: '微信读书专版', recommended: true },
                      { wereadMode: false, title: '通用电子版', recommended: false },
                    ].map(group => {
                      const groupVariants = EXPORT_VARIANTS.filter(v => v.wereadMode === group.wereadMode);
                      return (
                        <div key={group.title}>
                          <div className={`px-3 py-1.5 bg-neutral-100 text-[10px] font-bold uppercase tracking-wider flex items-center justify-between ${group.recommended ? 'text-teal-900' : 'text-neutral-600'}`}>
                            <span>{group.title}</span>
                            {group.recommended && (
                              <span className="text-[9px] bg-teal-800 text-white px-1.5 py-0.5 rounded-none font-bold">推荐</span>
                            )}
                          </div>
                          {groupVariants.map((variant, idx) => (
                            <button
                              key={`${variant.wereadMode}-${variant.mode}`}
                              onClick={() => handleDownloadWithMode(variant.mode, variant.wereadMode)}
                              className={`w-full text-left px-4 py-2 hover:bg-neutral-100 transition-colors font-medium text-black ${idx < groupVariants.length - 1 ? 'border-b border-neutral-100' : ''}`}
                            >
                              {variant.label}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
        </div>
      </header>

      {/* Hidden File Input for Missing Zip Recovery */}
      <input 
        id="missing-zip-input"
        data-testid="missing-zip-input"
        type="file" 
        ref={missingZipInputRef} 
        accept=".epub" 
        className="hidden" 
        onChange={handleMissingZipFileSelect} 
      />

      {/* Missing Original EPUB Banner for Restored Sessions */}
      {isMissingZip && (
        <div className="bg-amber-50 border-b border-amber-300 px-8 py-3 flex items-center justify-between text-xs font-mono text-amber-900 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>当前为恢复的历史翻译进度。打包 EPUB 需要原始文件以保留内嵌图片与原书排版：</span>
          </div>
          <label className="cursor-pointer bg-black text-white px-3.5 py-1.5 hover:bg-neutral-800 transition-colors uppercase font-bold text-[11px] shrink-0">
            选取原始 EPUB 并自动导出
            <input 
              id="banner-missing-zip-input"
              data-testid="banner-missing-zip-input"
              type="file" 
              accept=".epub" 
              className="hidden" 
              onChange={handleMissingZipFileSelect} 
            />
          </label>
        </div>
      )}

      {/* Export Process & Download Status Notification */}
      {exportNotification && (
        <div className={`px-8 py-2.5 flex items-center justify-between text-xs font-mono shrink-0 transition-all ${
          exportNotification.type === 'error' ? 'bg-red-50 text-red-900 border-b border-red-300' :
          exportNotification.type === 'success' ? 'bg-emerald-50 text-emerald-900 border-b border-emerald-300' :
          'bg-neutral-100 text-neutral-900 border-b border-neutral-300'
        }`}>
          <div className="flex items-center gap-3 flex-wrap">
            {exportNotification.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            ) : exportNotification.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <Loader2 className="w-4 h-4 animate-spin text-neutral-600 shrink-0" />
            )}
            <span className="font-medium">{exportNotification.message}</span>
            {exportNotification.downloadUrl && (
              <a
                href={exportNotification.downloadUrl}
                download={exportNotification.fileName || 'book.epub'}
                className="ml-2 px-3 py-1 bg-black hover:bg-neutral-800 text-white font-bold text-[11px] uppercase tracking-wider inline-flex items-center gap-1.5 transition-colors shrink-0 shadow-none"
              >
                <Download className="w-3.5 h-3.5 text-white" />
                <span>点此直接保存文件</span>
              </a>
            )}
          </div>
          <button 
            type="button"
            onClick={() => setExportNotification(null)}
            className="text-neutral-400 hover:text-black font-bold text-sm px-2 cursor-pointer"
          >
            ×
          </button>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex flex-col md:flex-row">
        
        {/* Left Panel: Configuration & Input */}
        <div className="w-full md:w-1/2 lg:w-5/12 p-6 md:p-8 overflow-y-auto border-r border-black custom-scrollbar bg-neutral-50/40">
          
          <div className="max-w-xl mx-auto space-y-6">
            {/* Book Upload or Book Active Studio Card */}
            {!currentFile ? (
              <FileUpload 
                onFileSelect={handleFileSelect} 
                disabled={isWorking}
              />
            ) : (
               <div className="bg-white border border-black rounded-none p-5 shadow-none transition-shadow space-y-4">
                 <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="bg-black p-3 rounded-none border border-black shrink-0 text-white">
                            <FileCheck className="w-5 h-5" />
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="font-mono text-sm font-bold text-black truncate uppercase tracking-wider" title={currentFile.name}>
                              {currentFile.name.replace(/\.epub$/i, '')}
                            </span>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] font-mono px-2 py-0.5 bg-neutral-100 text-neutral-700 border border-neutral-300">
                                {chapters.length} 章节
                              </span>
                              <span className="text-[10px] font-mono text-neutral-500">
                                {status === AppStatus.TRANSLATING ? '● 翻译进行中' : 
                                 status === AppStatus.COMPLETED ? '✓ 全部完成' : 
                                 status === AppStatus.PAUSED ? '已暂停' : 
                                 status === AppStatus.ERROR ? '异常' : '工坊就绪'}
                              </span>
                            </div>
                        </div>
                    </div>
                    {/* Clear / Replace Actions */}
                    {!isWorking && (
                      <div className="flex items-center gap-1 shrink-0">
                        <input 
                          type="file" 
                          ref={fileInputRef} 
                          accept=".epub" 
                          className="hidden" 
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleFileSelect(file);
                            e.target.value = '';
                          }} 
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="p-1.5 text-neutral-500 hover:text-black border border-transparent hover:border-black transition-colors"
                          title="更换电子书"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                        {showConfirmReset ? (
                          <div className="flex items-center gap-1 bg-white rounded-none p-1 border border-black shadow-none font-mono">
                              <span className="text-[10px] text-black font-bold px-1.5">清空？</span>
                              <button 
                                  onClick={handleReset}
                                  className="text-white bg-black px-2 py-1 text-[10px] font-bold uppercase transition-colors"
                              >
                                  确定
                              </button>
                              <button 
                                  onClick={() => setShowConfirmReset(false)}
                                  className="text-black bg-white px-2 py-1 text-[10px] font-bold uppercase transition-colors"
                              >
                                  取消
                              </button>
                          </div>
                        ) : (
                          <button 
                              onClick={() => setShowConfirmReset(true)}
                              className="text-neutral-500 hover:text-red-600 transition-colors p-1.5 border border-transparent hover:border-black"
                              title="移除文件并清空进度"
                          >
                              <Trash2 className="w-3.5 h-3.5"/>
                          </button>
                        )}
                      </div>
                    )}
                 </div>

                 {/* Progress Bar & Chapter Count */}
                 {chapters.length > 0 && (
                   <div className="space-y-1.5 pt-1">
                     <div className="flex items-center justify-between text-[11px] font-mono text-neutral-600">
                       <span>全书翻译进度</span>
                       <span className="font-bold text-black">
                         {Math.round(progress)}% ({chapters.filter(c => c.translatedMarkdown || isChapterNonTranslatable(c, config.smartSkip)).length}/{chapters.length} 章)
                       </span>
                     </div>
                     <div className="h-1.5 bg-neutral-100 border border-neutral-300 w-full overflow-hidden">
                       <div 
                         className="h-full bg-black transition-all duration-300 ease-out"
                         style={{ width: `${Math.min(100, progress)}%` }}
                       />
                     </div>
                   </div>
                 )}

                 {/* Workflow Control Buttons */}
                 <div className="pt-2">
                    {/* Start / Resume Button */}
                    {(status === AppStatus.IDLE || status === AppStatus.PAUSED) && (
                    <button
                        onClick={handleMainActionClick}
                        className="w-full bg-black hover:bg-neutral-800 text-white px-5 py-3.5 rounded-none text-xs font-mono tracking-widest uppercase transition-all shadow-none border border-black flex items-center justify-center gap-2 font-bold"
                    >
                        <Sparkles className="w-3.5 h-3.5" />
                        {getActionText()}
                    </button>
                    )}

                    {/* Pause Button */}
                    {(status === AppStatus.TRANSLATING ||  status === AppStatus.PARSING) && (
                        <button 
                            onClick={handlePause}
                            className="w-full bg-white hover:bg-black hover:text-white text-black px-5 py-3.5 rounded-none text-xs font-mono tracking-widest uppercase transition-all shadow-none flex items-center justify-center gap-2 border border-black font-bold"
                        >
                            <Pause className="w-3.5 h-3.5" /> 暂停翻译
                        </button>
                    )}

                    {/* Resume Button */}
                    {status === AppStatus.ERROR && (
                    <button
                        onClick={handleMainActionClick}
                        className="w-full bg-black hover:bg-neutral-800 text-white px-5 py-3.5 rounded-none text-xs font-mono tracking-widest uppercase transition-all shadow-none flex items-center justify-center gap-2 border border-black font-bold"
                    >
                        <RefreshCw className="w-3.5 h-3.5" /> {getActionText()}
                    </button>
                    )}
                    
                    {/* Restart Button (If Completed) */}
                     {status === AppStatus.COMPLETED && (
                        <button
                            onClick={handleMainActionClick}
                            className="w-full bg-black hover:bg-neutral-800 text-white px-5 py-3.5 rounded-none text-xs font-mono tracking-widest uppercase transition-all shadow-none border border-black flex items-center justify-center gap-2 font-bold"
                        >
                            <Sparkles className="w-3.5 h-3.5" />
                            {getActionText()}
                        </button>
                    )}
                 </div>
               </div>
            )}

            <SettingsPanel 
              config={config} 
              setConfig={setConfig} 
              disabled={isWorking}
              detectedLanguageInfo={detectedLanguageInfo}
            />
            
            {status === AppStatus.PAUSED && (
                <div className="bg-white border border-black text-black p-5 rounded-none flex items-start gap-4 text-sm shadow-none font-mono">
                    <Info className="w-5 h-5 shrink-0 mt-0.5 text-black" />
                    <div className="flex flex-col gap-1.5">
                        <span className="font-bold text-xs uppercase tracking-widest">翻译已暂停</span>
                        <span className="text-neutral-500 leading-relaxed text-[10px]">
                            翻译已由用户暂停，当前进度已安全保存。点击“{getActionText()}”即可随时从断点处继续。
                        </span>
                    </div>
                </div>
            )}
            
            {status === AppStatus.ERROR && (
                <div className="bg-white border border-black text-black p-5 rounded-none flex items-start gap-4 text-sm shadow-none font-mono">
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-black" />
                    <div className="flex flex-col gap-1.5 w-full">
                        <span className="font-bold text-xs uppercase tracking-widest">处理遇到问题</span>
                        <span className="text-neutral-500 leading-relaxed text-[10px]">
                            处理过程被中断或遇到异常，当前进度已保存。点击“{getActionText()}”即可从断点处继续。
                        </span>
                        {isMissingZip && (
                            <div className="mt-4 border border-red-500/60 bg-neutral-950 p-4 w-full">
                                <span className="block font-bold text-red-400 text-xs mb-2">原始 EPUB 文件缺失</span>
                                <span className="block text-red-600 text-[10px] mb-3 leading-relaxed">
                                    本地缓存已清理或超出限额，重新导出需要原始 EPUB。请在下方提供文件以继续打包。
                                </span>
                                <label className="cursor-pointer bg-red-600 hover:bg-red-700 text-white px-4 py-2 text-[10px] uppercase font-bold inline-block border border-red-800 transition-colors">
                                    提供原始 EPUB
                                    <input 
                                        type="file" 
                                        accept=".epub" 
                                        className="hidden" 
                                        onChange={handleMissingZipFileSelect}
                                    />
                                </label>
                            </div>
                        )}
                    </div>
                </div>
            )}
          </div>
        </div>

        {/* Right Panel: Studio Typesetting & Workbench */}
        <div className="w-full md:w-1/2 lg:w-7/12 bg-white text-black p-0 flex flex-col relative border-l border-neutral-300">
          <div className="p-3 border-b border-neutral-300 bg-neutral-100/90 flex flex-wrap items-center justify-between z-10 shadow-none px-5 gap-3">
             <div className="flex gap-1.5 p-1 bg-white rounded-none border border-neutral-300">
                <button 
                    onClick={() => setViewMode('preview')}
                    className={`px-3 py-1.5 rounded-none text-xs font-mono tracking-wider transition-all flex items-center gap-1.5 ${
                        viewMode === 'preview' ? 'bg-black text-white font-bold' : 'text-neutral-600 hover:text-black'
                    }`}
                >
                    <BookOpen className="w-3.5 h-3.5" />
                    排版预览
                </button>
                <button 
                    onClick={() => setViewMode('chapters')}
                    className={`px-3 py-1.5 rounded-none text-xs font-mono tracking-wider transition-all flex items-center gap-1.5 ${
                        viewMode === 'chapters' ? 'bg-black text-white font-bold' : 'text-neutral-600 hover:text-black'
                    }`}
                >
                    <FileText className="w-3.5 h-3.5" />
                    章节目录 ({chapters.length})
                </button>
                {config.enableGlossary && (
                    <button 
                        onClick={() => setViewMode('glossary')}
                        className={`px-3 py-1.5 rounded-none text-xs font-mono tracking-wider transition-all flex items-center gap-1.5 ${
                            viewMode === 'glossary' ? 'bg-black text-white font-bold' : 'text-neutral-600 hover:text-black'
                        }`}
                    >
                        <Tag className="w-3.5 h-3.5" />
                        全书术语库 ({glossaryEntries.length})
                    </button>
                )}
             </div>

             <div className="flex items-center gap-2">
                {/* Chapter & Mode Selectors when in Preview Mode */}
                {viewMode === 'preview' && chapters.length > 0 && (
                    <>
                        <div className="hidden sm:flex bg-white border border-neutral-300 p-0.5 font-mono text-[11px]">
                          <button
                            onClick={() => setPreviewDisplayMode('translation')}
                            className={`px-2 py-0.5 transition-colors ${previewDisplayMode === 'translation' ? 'bg-black text-white font-bold' : 'text-neutral-600 hover:text-black'}`}
                          >
                            译文
                          </button>
                          <button
                            onClick={() => setPreviewDisplayMode('bilingual')}
                            className={`px-2 py-0.5 transition-colors ${previewDisplayMode === 'bilingual' ? 'bg-black text-white font-bold' : 'text-neutral-600 hover:text-black'}`}
                          >
                            双语
                          </button>
                          <button
                            onClick={() => setPreviewDisplayMode('source')}
                            className={`px-2 py-0.5 transition-colors ${previewDisplayMode === 'source' ? 'bg-black text-white font-bold' : 'text-neutral-600 hover:text-black'}`}
                          >
                            原文
                          </button>
                        </div>

                        <div className="flex items-center border border-neutral-300 bg-white">
                          <button
                            onClick={() => setSelectedChapterIndex(prev => Math.max(0, prev - 1))}
                            disabled={selectedChapterIndex === 0}
                            className="p-1 hover:bg-neutral-100 disabled:opacity-30 text-black border-r border-neutral-200"
                            title="上一章"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <select 
                            value={selectedChapterIndex}
                            onChange={(e) => setSelectedChapterIndex(Number(e.target.value))}
                            className="text-[11px] font-mono px-2 py-1 bg-transparent text-black outline-none max-w-[130px] truncate cursor-pointer"
                          >
                            {chapters.map((ch, idx) => {
                              const marker = isChapterEffectivelySkippable(ch, config.smartSkip)
                                ? '⊘'
                                : isChapterEffectivelyReference(ch, config.smartSkip)
                                ? '≡'
                                : ch.translatedMarkdown
                                ? '✓'
                                : '';
                              return (
                                <option key={ch.id} value={idx}>
                                  {idx + 1}. {ch.title} {marker}
                                </option>
                              );
                            })}
                          </select>
                          <button
                            onClick={() => setSelectedChapterIndex(prev => Math.min(chapters.length - 1, prev + 1))}
                            disabled={selectedChapterIndex >= chapters.length - 1}
                            className="p-1 hover:bg-neutral-100 disabled:opacity-30 text-black border-l border-neutral-200"
                            title="下一章"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                    </>
                )}

                <div className="text-[10px] font-mono text-neutral-600 bg-white px-2.5 py-1.5 rounded-none border border-neutral-300 flex items-center gap-1.5 tracking-wider uppercase">
                    {status !== AppStatus.IDLE && status !== AppStatus.COMPLETED && status !== AppStatus.ERROR && status !== AppStatus.PAUSED ? (
                       <>
                         <Loader2 className="w-3 h-3 animate-spin text-black" /> 
                         <span className="font-bold text-black">
                            {status === AppStatus.PARSING ? '解析中' : 
                             status === AppStatus.TRANSLATING ? '翻译中' :
                             status === AppStatus.PACKAGING ? '导出中' : '处理中'}
                         </span>
                       </>
                    ) : (
                        <span className="font-bold text-neutral-700">
                            {status === AppStatus.IDLE ? '就绪' : 
                             status === AppStatus.PAUSED ? '已暂停' :
                             status === AppStatus.COMPLETED ? '已完成' :
                             status === AppStatus.ERROR ? '异常' : '空闲'}
                        </span>
                    )}
                </div>
             </div>
          </div>
          
          <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col relative pb-12">
            {viewMode === 'preview' ? (
                chapters.length === 0 ? (
                    <div className="flex-1 bg-neutral-50 flex flex-col items-center justify-center p-8 text-center min-h-[500px]">
                        <div className="w-12 h-12 rounded-none bg-white border border-neutral-300 flex items-center justify-center mb-3 text-neutral-400">
                            <BookOpen className="w-5 h-5 stroke-[1.5]" />
                        </div>
                        <p className="font-mono text-xs text-neutral-400 uppercase tracking-widest">
                            等待导入电子书
                        </p>
                    </div>
                ) : (
                    (() => {
                        const activeChapter = chapters[selectedChapterIndex] || chapters[0];
                        return (
                            <div className="flex-1 bg-neutral-100/90 overflow-y-auto custom-scrollbar p-6 md:p-10 pb-16">
                                <div className="max-w-2xl mx-auto bg-white border border-neutral-300 shadow-sm p-8 md:p-14 min-h-[750px] flex flex-col justify-between transition-all">
                                    <div>
                                        {/* Running Header */}
                                        <div className="border-b border-neutral-200 pb-3 mb-7 text-[11px] font-mono uppercase tracking-widest text-neutral-400 flex items-center justify-between gap-4 select-none">
                                            <span className="truncate max-w-[220px]">
                                                {currentFile?.name ? currentFile.name.replace(/\.epub$/i, '') : 'TransLit Studio'}
                                            </span>
                                            <span className="flex items-center gap-2 min-w-0">
                                                <span className="truncate max-w-[200px] normal-case tracking-normal text-neutral-500">
                                                    {activeChapter.title || activeChapter.fileName}
                                                </span>
                                                <span className="text-neutral-300 shrink-0">·</span>
                                                <span className="shrink-0 font-bold text-neutral-500">
                                                    第 {selectedChapterIndex + 1} / {chapters.length} 章
                                                </span>
                                            </span>
                                        </div>

                                        {/* Chapter Status Banner */}
                                        {status === AppStatus.TRANSLATING && activeChapterIndexRef.current === selectedChapterIndex ? (
                                            <div className="mb-6 p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-mono flex items-center justify-between animate-pulse">
                                                <div className="flex items-center gap-2">
                                                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-700" />
                                                    <span className="font-bold">正在实时流式翻译本章中...</span>
                                                </div>
                                                <span>片段流式更新中</span>
                                            </div>
                                        ) : isChapterEffectivelySkippable(activeChapter, config.smartSkip) ? (
                                            <div className="mb-6 p-3 bg-neutral-100 border border-neutral-300 text-neutral-600 text-xs font-mono flex items-center justify-between gap-3">
                                                <span>此章节已标记为跳过（不包含在导出 EPUB 中）</span>
                                                {!isWorking && (
                                                    <button
                                                        onClick={() => toggleChapterSkip(selectedChapterIndex)}
                                                        className="px-2.5 py-1 bg-white text-black border border-neutral-300 hover:border-black text-[10px] font-bold uppercase tracking-wider shrink-0"
                                                    >
                                                        恢复包含
                                                    </button>
                                                )}
                                            </div>
                                        ) : isFootnoteSourceChapter(activeChapter) ? (
                                            <div className="mb-6 p-3 bg-amber-50 border border-amber-300 text-amber-900 text-xs font-mono">
                                                系统注释源文件 · 0偏移保护已启用（导出时转换为标准锚点）
                                            </div>
                                        ) : isChapterEffectivelyReference(activeChapter, config.smartSkip) ? (
                                            <div className="mb-6 p-3 bg-sky-50 border border-sky-300 text-sky-900 text-xs font-mono flex items-center justify-between gap-3">
                                                <span>此章节已标记为保持原文（不翻译 · 保留在导出 EPUB 中）</span>
                                                {!isWorking && (
                                                    <button
                                                        onClick={() => toggleChapterReference(selectedChapterIndex)}
                                                        className="px-2.5 py-1 bg-white text-sky-900 border border-sky-300 hover:border-sky-700 text-[10px] font-bold uppercase tracking-wider shrink-0"
                                                    >
                                                        恢复翻译
                                                    </button>
                                                )}
                                            </div>
                                        ) : !activeChapter.translatedMarkdown ? (
                                            <div className="mb-6 p-3 bg-neutral-100 border border-neutral-200 text-neutral-600 text-xs font-mono flex items-center justify-between">
                                                <span>本章尚未翻译 · 当前展示 EPUB 原文</span>
                                                {!isWorking && (
                                                    <button
                                                        onClick={() => handleRetryChapter(selectedChapterIndex)}
                                                        className="px-2.5 py-1 bg-black text-white hover:bg-neutral-800 text-[10px] font-bold uppercase tracking-wider"
                                                    >
                                                        单独翻译本章
                                                    </button>
                                                )}
                                            </div>
                                        ) : null}

                                        {/* Content Area */}
                                        {(() => {
                                            const hasRichHtmlContent = Boolean(
                                                activeChapter.content && /<[a-z][\s\S]*>/i.test(activeChapter.content)
                                            );

                                            if (hasRichHtmlContent) {
                                                return (
                                                    <EpubFinishedPreview
                                                        chapter={activeChapter}
                                                        displayMode={previewDisplayMode}
                                                        bookCssTexts={bookCssTexts}
                                                        bookStyleRoles={bookStyleRoles}
                                                        opfDir={opfDirRef.current}
                                                        persistence={persistenceService.current}
                                                        isStreamingCurrentChapter={
                                                            status === AppStatus.TRANSLATING &&
                                                            activeChapterIndexRef.current === selectedChapterIndex
                                                        }
                                                        forceOriginal={isChapterEffectivelyReference(activeChapter, config.smartSkip)}
                                                    />
                                                );
                                            }

                                            const markdownPreviewComponents = {
                                                img: ({ src, alt }: { src?: string; alt?: string }) => (
                                                    <MarkdownImage 
                                                        src={src} 
                                                        alt={alt} 
                                                        chapterPath={activeChapter.fileName} 
                                                        persistence={persistenceService.current} 
                                                    />
                                                ),
                                                a: ({ href, title, children }: any) => {
                                                    if (href?.startsWith('#fn-')) {
                                                        const fnId = href.slice(1);
                                                        return (
                                                            <a
                                                                href={href}
                                                                title={title ? `注释：${title}` : '查看本章注释'}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    const el = document.getElementById(fnId);
                                                                    if (el) {
                                                                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                                                        el.classList.add('bg-amber-100', 'ring-2', 'ring-amber-400');
                                                                        setTimeout(() => {
                                                                            el.classList.remove('bg-amber-100', 'ring-2', 'ring-amber-400');
                                                                        }, 2000);
                                                                    }
                                                                }}
                                                                className="inline-flex items-center justify-center align-super text-[11px] font-mono font-bold text-teal-900 bg-teal-50 hover:bg-teal-100 border border-teal-300 px-1 py-0.2 mx-0.5 rounded-none cursor-pointer transition-all shadow-none select-none hover:border-teal-600"
                                                            >
                                                                {children}
                                                            </a>
                                                        );
                                                    }
                                                    return (
                                                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-neutral-700 underline hover:text-black">
                                                            {children}
                                                        </a>
                                                    );
                                                },
                                                p: ({ children }: any) => (
                                                    <p className="text-[15.5px] font-serif leading-[1.9] text-justify text-[#2c2a29] mb-5 tracking-wide">
                                                        {children}
                                                    </p>
                                                ),
                                                h1: ({ children }: any) => (
                                                    <h1 className="text-2xl font-serif font-bold text-neutral-900 mt-8 mb-4 border-b border-neutral-200 pb-2">
                                                        {children}
                                                    </h1>
                                                ),
                                                h2: ({ children }: any) => (
                                                    <h2 className="text-xl font-serif font-bold text-neutral-900 mt-6 mb-3">
                                                        {children}
                                                    </h2>
                                                ),
                                                h3: ({ children }: any) => (
                                                    <h3 className="text-lg font-serif font-bold text-neutral-800 mt-5 mb-2">
                                                        {children}
                                                    </h3>
                                                ),
                                                blockquote: ({ children }: any) => (
                                                    <blockquote className="border-l-2 border-neutral-400 pl-4 py-1 my-4 italic text-neutral-600 font-serif">
                                                        {children}
                                                    </blockquote>
                                                )
                                            };

                                            const forceOriginalPreview = isChapterEffectivelyReference(activeChapter, config.smartSkip);

                                            if (previewDisplayMode === 'bilingual') {
                                                const src = activeChapter.slottedMarkdown || activeChapter.markdown || '';
                                                const transRaw = forceOriginalPreview
                                                    ? ''
                                                    : (activeChapter.proofreadMarkdown || activeChapter.translatedMarkdown || '');
                                                const trans = transRaw ? restoreHeadingPrefixesFromSource(src, transRaw) : '';

                                                if (!src && !trans) {
                                                    return <div className="text-neutral-400 font-mono text-xs py-8 text-center">本章无文本内容</div>;
                                                }

                                                const sBlocks = splitMarkdownIntoBlocks(src);
                                                const tBlocks = trans ? splitMarkdownIntoBlocks(trans) : [];
                                                const pairs = alignMarkdownBlocks(sBlocks, tBlocks);

                                                if (pairs.length === 0) {
                                                    return <div className="text-neutral-400 font-mono text-xs py-8 text-center">本章无文本内容</div>;
                                                }

                                                return (
                                                    <div className="space-y-6">
                                                        {pairs.map((pair, pIdx) => {
                                                            const formattedSrc = formatMarkdownForPreview(
                                                                pair.sourceContent || '',
                                                                activeChapter.internalizedFootnotes,
                                                                forceOriginalPreview ? undefined : activeChapter.translatedFootnotes
                                                            );
                                                            const formattedTrans = formatMarkdownForPreview(
                                                                pair.targetContent || '',
                                                                activeChapter.internalizedFootnotes,
                                                                forceOriginalPreview ? undefined : activeChapter.translatedFootnotes,
                                                                { isTranslation: true }
                                                            );

                                                            if (pair.type === 'hr') {
                                                                return <hr key={pIdx} className="my-6 border-neutral-300" />;
                                                            }

                                                            return (
                                                                <div key={pIdx} className="border-b border-neutral-200/60 pb-5">
                                                                    {formattedSrc && (
                                                                        <div className="text-xs font-sans text-neutral-500 mb-2 leading-relaxed">
                                                                            <ReactMarkdown components={markdownPreviewComponents}>
                                                                                {formattedSrc}
                                                                            </ReactMarkdown>
                                                                        </div>
                                                                    )}
                                                                    <div className="text-[15.5px] font-serif text-neutral-900 leading-[1.85] pl-3 border-l-2 border-neutral-300 heti-prose">
                                                                        {formattedTrans ? (
                                                                            <ReactMarkdown components={markdownPreviewComponents}>
                                                                                {formattedTrans}
                                                                            </ReactMarkdown>
                                                                        ) : status === AppStatus.TRANSLATING && activeChapterIndexRef.current === selectedChapterIndex ? (
                                                                            <span className="text-emerald-700 text-xs font-mono animate-pulse">正在流式翻译本段...</span>
                                                                        ) : (
                                                                            <span className="text-neutral-400 text-xs font-mono">（等待翻译...）</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                );
                                            }

                                            const isTranslationView =
                                                !forceOriginalPreview &&
                                                previewDisplayMode !== 'source' &&
                                                Boolean(activeChapter.proofreadMarkdown || activeChapter.translatedMarkdown);
                                            const sourceMarkdown = activeChapter.slottedMarkdown || activeChapter.markdown || '';
                                            const contentRaw = (previewDisplayMode === 'source' || forceOriginalPreview)
                                                ? sourceMarkdown
                                                : (activeChapter.proofreadMarkdown || activeChapter.translatedMarkdown || activeChapter.markdown || '');

                                            const formattedContent = formatMarkdownForPreview(
                                                contentRaw,
                                                activeChapter.internalizedFootnotes,
                                                forceOriginalPreview ? undefined : activeChapter.translatedFootnotes,
                                                isTranslationView ? { isTranslation: true, sourceMarkdown } : undefined
                                            );

                                            return (
                                                <div className={`prose prose-neutral max-w-none text-neutral-800 ${isTranslationView ? 'heti-prose' : ''}`}>
                                                    <ReactMarkdown components={markdownPreviewComponents}>
                                                        {formattedContent}
                                                    </ReactMarkdown>
                                                </div>
                                            );
                                        })()}

                                        {/* Fallback Chapter Footnotes Area (only when raw HTML DOM is unavailable) */}
                                        {!(activeChapter.content && /<[a-z][\s\S]*>/i.test(activeChapter.content)) &&
                                            activeChapter.internalizedFootnotes &&
                                            Object.keys(activeChapter.internalizedFootnotes).length > 0 && (
                                            <div className="mt-12 pt-6 border-t border-neutral-300">
                                                <h4 className="text-[11px] font-mono uppercase tracking-widest text-neutral-400 font-bold mb-3">
                                                    本章注释 ({Object.keys(activeChapter.internalizedFootnotes).length})
                                                </h4>
                                                <div className="space-y-2 text-xs font-serif text-neutral-600 leading-relaxed">
                                                    {Object.entries(activeChapter.internalizedFootnotes).map(([k, v]) => {
                                                        const cleanKey = k.replace(/^fn-/, '');
                                                        const noteText = (!isChapterEffectivelyReference(activeChapter, config.smartSkip) && (
                                                                           activeChapter.translatedFootnotes?.[cleanKey] ||
                                                                           activeChapter.translatedFootnotes?.[k]
                                                                         )) ||
                                                                         v.plainText ||
                                                                         v.html;
                                                        return (
                                                            <div key={k} id={`fn-${cleanKey}`} className="flex gap-2 p-1.5 rounded-none transition-all duration-300">
                                                                <span className="font-mono text-teal-800 font-bold shrink-0">[注{v.label || cleanKey}]</span>
                                                                <span>{noteText}</span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Running Footer */}
                                    <div className="border-t border-[#e5e1d8] pt-4 mt-12 flex items-center justify-between text-[11px] font-mono text-neutral-400 select-none">
                                        <span>字数: ~{(isChapterEffectivelyReference(activeChapter, config.smartSkip) ? (activeChapter.markdown || '') : (activeChapter.translatedMarkdown || activeChapter.markdown || '')).length} 字符</span>
                                        <span>- {selectedChapterIndex + 1} -</span>
                                        <span>注释: {Object.keys(activeChapter.internalizedFootnotes || {}).length} 条</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })()
                )
            ) : viewMode === 'chapters' ? (
                chapters.length === 0 ? (
                    <div className="flex-1 relative">
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <LogoWatermark />
                            <p className="text-neutral-400 text-xs font-mono uppercase tracking-widest mt-4">暂无章节</p>
                        </div>
                    </div>
                ) : (
                <div className="p-6 space-y-3 bg-neutral-50 min-h-full">
                    {
                        chapters.map((chapter, idx) => {
                            const { detectedFallbacks, detectedProofreadFallbacks } = chapterFallbacksMap.get(chapter.id) || {
                                detectedFallbacks: [],
                                detectedProofreadFallbacks: []
                            };
                            const hasFallbacks = detectedFallbacks.length > 0;
                            const hasProofreadFallbacks = detectedProofreadFallbacks.length > 0;

                        const isFootnoteSource = isFootnoteSourceChapter(chapter);
                        const isSkipped = isChapterEffectivelySkippable(chapter, config.smartSkip);
                        const isReference = isChapterEffectivelyReference(chapter, config.smartSkip);
                        const isDone = !isSkipped && !isReference && !isFootnoteSource && chapter.translatedMarkdown && (!config.enableProofreading || chapter.proofreadMarkdown);
                        const isPartiallyDone = !isSkipped && !isReference && !isFootnoteSource && (chapter.translatedMarkdown || (config.enableProofreading && chapter.proofreadMarkdown)) && 
                                              (hasFallbacks || (config.enableProofreading && hasProofreadFallbacks));

                        return (
                            <div key={chapter.id} className={`group border rounded-none p-4 transition-all ${
                                isSkipped ? 'bg-neutral-100 border-neutral-300 opacity-60' :
                                isReference ? 'bg-sky-50/40 border-sky-300 hover:border-sky-500' :
                                isPartiallyDone ? 'bg-amber-50/70 border-amber-300 hover:border-amber-500 shadow-xs' :
                                isDone ? 'bg-white border-neutral-300 hover:border-black shadow-xs' :
                                'bg-white border-neutral-200 hover:border-neutral-400'
                            }`}>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        <span className="text-[11px] font-mono text-neutral-400 w-6 font-bold">{idx + 1}</span>
                                        <div className="flex flex-col">
                                            <div className="flex items-center gap-2">
                                                <span 
                                                    onClick={() => {
                                                        setSelectedChapterIndex(idx);
                                                        setViewMode('preview');
                                                    }}
                                                    className={`font-mono transition-colors text-sm cursor-pointer hover:underline ${
                                                        isSkipped ? 'text-neutral-500' :
                                                        isPartiallyDone ? 'text-amber-900 font-bold' :
                                                        isDone ? 'text-black font-bold' : 'text-neutral-800'
                                                    }`}
                                                >
                                                    {chapter.title || '未命名章节'}
                                                </span>
                                                {isPartiallyDone && (
                                                    <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-none bg-amber-100 border border-amber-300">
                                                        <AlertTriangle className="w-3 h-3 text-amber-700" />
                                                        <span className="text-[9px] text-amber-900 uppercase font-bold tracking-tighter">存在失败片段</span>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex flex-wrap gap-2 mt-1.5 items-center">
                                                {isFootnoteSource ? (
                                                    <span className="text-[9px] font-mono uppercase tracking-widest text-amber-900 bg-amber-50 px-1.5 py-0.5 rounded-none border border-amber-300" title={chapter.classification?.reason || '系统注释源文件，导出时由0偏移占位符替代'}>
                                                        系统注释源文件 • 0偏移保护
                                                    </span>
                                                ) : isSkipped ? (
                                                     <span className="text-[9px] font-mono uppercase tracking-widest text-neutral-500 bg-neutral-100 px-1.5 py-0.5 rounded-none border border-neutral-300">已跳过</span>
                                                ) : isReference ? (
                                                     <span className="text-[9px] font-mono uppercase tracking-widest text-sky-900 bg-sky-50 px-1.5 py-0.5 rounded-none border border-sky-300 font-bold">保持原文</span>
                                                ) : (
                                                    <>
                                                        <span className={`text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-none border flex items-center gap-1 ${
                                                            chapter.translatedMarkdown 
                                                                ? (detectedFallbacks.length > 0 ? 'bg-amber-100 text-amber-900 font-bold border-amber-300' : 'bg-black text-white border-black font-bold') 
                                                                : 'bg-neutral-100 text-neutral-500 border-neutral-300'
                                                        }`}>
                                                            {chapter.translatedMarkdown ? (detectedFallbacks.length > 0 ? `已翻译 (${detectedFallbacks.length} 处回退)` : '已翻译') : '未翻译'}
                                                        </span>
                                                        {config.enableProofreading && (
                                                            <span className={`text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-none border flex items-center gap-1 ${
                                                                chapter.proofreadMarkdown 
                                                                    ? (detectedProofreadFallbacks.length > 0 ? 'bg-amber-100 text-amber-900 font-bold border-amber-300' : 'bg-neutral-800 text-white border-neutral-800')
                                                                    : 'bg-neutral-100 text-neutral-500 border-neutral-300'
                                                            }`}>
                                                                {chapter.proofreadMarkdown ? (detectedProofreadFallbacks.length > 0 ? `已润色 (${detectedProofreadFallbacks.length} 处回退)` : '已润色') : '未润色'}
                                                            </span>
                                                        )}
                                                    </>
                                                )}
                                                {chapter.internalizedFootnotes && Object.keys(chapter.internalizedFootnotes).length > 0 && (
                                                    <span className="text-[9px] font-mono uppercase tracking-widest text-teal-800 bg-teal-50 px-1.5 py-0.5 rounded-none border border-teal-300">
                                                        {Object.keys(chapter.internalizedFootnotes).length} 条内嵌注释
                                                    </span>
                                                )}
                                                {chapter.classification && !isFootnoteSource && (
                                                    <span className="text-[9px] font-mono uppercase tracking-widest text-neutral-600 bg-neutral-100 px-1.5 py-0.5 rounded-none border border-neutral-300" title={chapter.classification.reason}>
                                                        {chapter.classification.stage === 'lightweight_ai' ? 'AI' : chapter.classification.stage === 'user_override' ? '用户' : '规则'}: {chapter.classification.category}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        {isFootnoteSource ? (
                                            <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500 bg-neutral-100 border border-neutral-300 px-2.5 py-1 rounded-none">
                                                已锁定
                                            </span>
                                        ) : !isSkipped ? (
                                            <div className="flex gap-1 mr-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button 
                                                    onClick={() => {
                                                        setSelectedChapterIndex(idx);
                                                        setViewMode('preview');
                                                    }}
                                                    className="p-1.5 rounded-none border border-neutral-300 bg-white text-neutral-700 hover:text-black hover:border-black transition-all"
                                                    title="排版预览本章"
                                                >
                                                    <BookOpen className="w-3.5 h-3.5" />
                                                </button>
                                                <button 
                                                    onClick={() => setPreviewChapter(chapter)}
                                                    className="p-1.5 rounded-none border border-neutral-300 bg-white text-neutral-700 hover:text-black hover:border-black transition-all"
                                                    title="预览原文"
                                                >
                                                    <Eye className="w-3.5 h-3.5" />
                                                </button>
                                                <button 
                                                    onClick={() => toggleChapterReference(idx)}
                                                    className={`p-1.5 rounded-none border transition-all ${isReference ? 'bg-black text-white border-black' : 'border-neutral-300 bg-white text-neutral-700 hover:text-black hover:border-black'}`}
                                                    title={isReference ? "恢复翻译" : "保持原文（不翻译）"}
                                                >
                                                    <FileCode className="w-3.5 h-3.5" />
                                                </button>
                                                <button 
                                                    onClick={() => toggleChapterSkip(idx)}
                                                    className="p-1.5 rounded-none border border-neutral-300 bg-white text-neutral-700 hover:text-black hover:border-black transition-all"
                                                    title="跳过此章节"
                                                >
                                                    <Ban className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        ) : (
                                            <button 
                                                onClick={() => toggleChapterSkip(idx)}
                                                className="mr-3 p-1.5 rounded-none border border-neutral-300 bg-white text-neutral-700 hover:text-black hover:border-black transition-all"
                                                title="恢复此章节"
                                            >
                                                <RefreshCw className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                        {!isSkipped && !isReference && !isFootnoteSource && (
                                            <div className="flex gap-2">
                                                {(hasFallbacks || status === AppStatus.IDLE || status === AppStatus.COMPLETED || status === AppStatus.ERROR || status === AppStatus.PAUSED) && (
                                                    <button 
                                                        onClick={() => {
                                                            // Sync detected fallbacks to the chapter object before retrying
                                                            chapter.fallbackChunks = detectedFallbacks;
                                                            chapter.fallbackProofreadChunks = detectedProofreadFallbacks;
                                                            // Ensure translatedChunks is at least pre-split if missing
                                                            const sourceChunks = splitTextIntoChunks(
                                                                chapter.markdown || '',
                                                                config.enableProofreading ? 1800 : 3000
                                                            );
                                                            if (!chapter.translatedChunks || chapter.translatedChunks.length !== sourceChunks.length) {
                                                                chapter.translatedChunks = new Array(sourceChunks.length).fill(null);
                                                                chapter.chunkGlossaries = new Array(sourceChunks.length).fill('');
                                                            }
                                                            handleRetryChapter(idx);
                                                        }}
                                                        disabled={status !== AppStatus.IDLE && status !== AppStatus.ERROR && status !== AppStatus.COMPLETED && status !== AppStatus.PAUSED}
                                                        className={`text-[10px] px-2.5 py-1 rounded-none border transition-all flex items-center gap-1.5 disabled:opacity-50 shadow-none font-mono tracking-widest uppercase ${
                                                            hasFallbacks 
                                                                ? 'bg-amber-600 hover:bg-amber-700 text-white border-amber-600 font-bold' 
                                                                : 'bg-white hover:bg-neutral-100 text-black border-neutral-300 opacity-0 group-hover:opacity-100'
                                                        }`}
                                                    >
                                                        <RefreshCw className="w-3 h-3" /> {hasFallbacks ? `重试 ${detectedFallbacks.length} 处片段` : '重新翻译'}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {(() => {
                                    const chapterNewGlossary =
                                        config.enableGlossary && !isSkipped && !isReference && !isFootnoteSource
                                            ? mergeChunkGlossaries(chapter.chunkGlossaries)
                                            : '';
                                    return chapterNewGlossary ? (
                                        <div className="mt-3 pt-3 border-t border-neutral-200">
                                            <details className="cursor-pointer">
                                                <summary className="text-[10px] font-mono text-neutral-500 hover:text-neutral-800 uppercase tracking-widest transition-colors focus:outline-none">
                                                    查看本章提取术语
                                                </summary>
                                                <div className="mt-2 text-[11px] font-mono text-neutral-700 bg-neutral-50 p-2.5 rounded border border-neutral-200 whitespace-pre-wrap leading-relaxed">
                                                    {chapterNewGlossary}
                                                </div>
                                            </details>
                                        </div>
                                    ) : null;
                                })()}
                            </div>
                        );
                    })
                    }
                </div>
                )
            ) : (
                <div className="p-8 h-full flex flex-col bg-neutral-50">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex flex-col">
                            <h2 className="text-black font-mono text-xl uppercase tracking-widest font-bold">全书术语库</h2>
                        </div>
                        <div className="flex items-center gap-2">
                             <button 
                                onClick={handleManualSyncGlossary}
                                disabled={isWorking}
                                className="text-[10px] px-3 py-1.5 rounded-none font-mono tracking-widest uppercase text-neutral-700 hover:text-black bg-white hover:bg-neutral-100 border border-neutral-300 transition-all disabled:opacity-50"
                                title="将最新修改的术语译法批量同步到前面已翻译的章节"
                            >
                                联动已译章节
                            </button>
                             <button 
                                onClick={() => optimizeGlossary()}
                                disabled={isCleaningGlossary || isWorking}
                                className={`text-[10px] px-3 py-1.5 rounded-none flex items-center gap-1.5 border transition-all font-mono tracking-widest uppercase ${
                                    isCleaningGlossary 
                                        ? 'bg-black text-white border-black' 
                                        : 'text-neutral-700 hover:text-black bg-white hover:bg-neutral-100 border-neutral-300'
                                } disabled:opacity-50`}
                                title="使用 AI 深度去重并净化术语库"
                            >
                                {isCleaningGlossary ? <Loader2 className="w-3 h-3 animate-spin"/> : <Sparkles className="w-3 h-3" />}
                                {isCleaningGlossary ? '正在净化...' : '智能去重净化'}
                            </button>
                             <button 
                                onClick={handleToggleBulkEdit}
                                className="text-[10px] px-3 py-1.5 rounded-none font-mono tracking-widest uppercase text-neutral-700 hover:text-black bg-white hover:bg-neutral-100 border border-neutral-300 transition-all"
                            >
                                {isBulkEdit ? '切换表格' : '切换纯文本'}
                            </button>
                             <button 
                                onClick={() => isBulkEdit ? handleUpdateGlossary(liveGlossary) : handleSaveGlossaryMap()}
                                disabled={isWorking}
                                className="text-[10px] px-3 py-1.5 rounded-none bg-black hover:bg-neutral-800 text-white font-bold font-mono uppercase tracking-widest transition-all shadow-none flex items-center gap-1.5 border border-black disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Save className="w-3 h-3" /> 保存修改
                            </button>
                        </div>
                    </div>
                    
                    <div className="flex-1 overflow-hidden flex flex-col bg-white border border-neutral-300 rounded-none relative group shadow-none">
                        {isBulkEdit ? (
                            <textarea 
                                value={liveGlossary}
                                onChange={(e) => updateLiveGlossary(e.target.value)}
                                disabled={isWorking}
                                placeholder="暂无术语"
                                className="w-full h-full p-6 font-mono text-sm text-neutral-800 outline-none transition-colors resize-none bg-white custom-scrollbar disabled:opacity-50"
                            />
                        ) : (
                                <div className="flex-1 overflow-hidden flex flex-col">
                                    {/* Stats & Search Bar */}
                                    <div className="p-3 border-b border-neutral-200 bg-neutral-50 flex flex-wrap items-center justify-between gap-3">
                                        <div className="flex items-center gap-2 text-[10px] font-mono text-neutral-600 uppercase tracking-widest">
                                            <Tag className="w-3 h-3 text-neutral-500" />
                                            <span>{glossaryEntries.length} 条术语 · 按出现顺序</span>
                                        </div>
                                        <div className="relative flex-1 max-w-xs">
                                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
                                            <input 
                                                type="text" 
                                                placeholder="搜索原文或统一译法..." 
                                                value={glossarySearch}
                                                onChange={(e) => setGlossarySearch(e.target.value)}
                                                className="w-full bg-white border border-neutral-300 hover:border-neutral-400 focus:border-black pl-8 pr-3 py-1 text-xs text-black outline-none font-mono transition-colors"
                                            />
                                        </div>
                                    </div>

                                    {/* Table View */}
                                    <div className="flex-1 overflow-x-auto overflow-y-auto custom-scrollbar p-2">
                                        <table className="w-full text-left border-collapse min-w-[640px]">
                                            <thead>
                                                <tr className="border-b border-neutral-200">
                                                    <th className="p-3 text-[10px] uppercase tracking-widest text-neutral-500 font-mono font-bold w-1/2">原文词汇</th>
                                                    <th className="p-3 text-[10px] uppercase tracking-widest text-neutral-500 font-mono font-bold w-1/2">统一译法</th>
                                                    <th className="p-3 w-10"></th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-neutral-200">
                                                {glossaryEntries
                                                    .filter(({ key, value }) => {
                                                        if (!glossarySearch.trim()) return true;
                                                        const q = normalizeGlossaryKey(glossarySearch);
                                                        const parsed = parseGlossaryValue(value);
                                                        return normalizeGlossaryKey(key).includes(q) || 
                                                               normalizeGlossaryKey(parsed).includes(q);
                                                    })
                                                    .map(({ key, value }) => {
                                                        const parsed = parseGlossaryValue(value);
                                                        const isEditingKey = editingTermKey?.origKey === key;
                                                        return (
                                                            <tr key={key} className="group/row hover:bg-neutral-50 transition-colors align-top">
                                                                <td className="p-1.5">
                                                                    <input 
                                                                        type="text" 
                                                                        value={isEditingKey ? editingTermKey.draft : key}
                                                                        onFocus={() => setEditingTermKey({ origKey: key, draft: key })}
                                                                        onChange={(e) => setEditingTermKey({ origKey: key, draft: e.target.value })}
                                                                        onBlur={() => {
                                                                          if (editingTermKey && editingTermKey.origKey === key) {
                                                                            commitTermKeyRename(key, editingTermKey.draft);
                                                                          }
                                                                        }}
                                                                        onKeyDown={(e) => {
                                                                          if (e.key === 'Enter') {
                                                                            e.currentTarget.blur();
                                                                          } else if (e.key === 'Escape') {
                                                                            setEditingTermKey(null);
                                                                          }
                                                                        }}
                                                                        disabled={isWorking}
                                                                        className="w-full bg-transparent p-1.5 text-black outline-none focus:bg-neutral-100 rounded-none transition-colors font-mono text-sm font-semibold disabled:opacity-50"
                                                                    />
                                                                </td>
                                                                <td className="p-1.5">
                                                                    <input 
                                                                        type="text" 
                                                                        value={parsed}
                                                                        onChange={(e) => handleUpdateTermTarget(key, e.target.value)}
                                                                        disabled={isWorking}
                                                                        className="w-full bg-transparent p-1.5 text-neutral-800 focus:text-black outline-none focus:bg-neutral-100 rounded-none transition-colors font-mono text-sm disabled:opacity-50"
                                                                    />
                                                                </td>
                                                                <td className="p-1.5 text-right">
                                                                    <button 
                                                                        onClick={() => handleDeleteTerm(key)}
                                                                        disabled={isWorking}
                                                                        className="p-1.5 text-neutral-400 hover:text-red-600 transition-colors rounded-none hover:bg-neutral-100 opacity-0 group-hover/row:opacity-100 border border-transparent hover:border-neutral-300 disabled:opacity-0"
                                                                        title="删除术语"
                                                                    >
                                                                        <X className="w-3.5 h-3.5" />
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                {glossaryEntries.length === 0 && (
                                                    <tr>
                                                        <td colSpan={3} className="p-8 text-center text-neutral-400 font-mono text-sm">
                                                            暂无术语
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                        <div className="p-3 border-t border-neutral-200 mt-1">
                                            <button 
                                                onClick={handleAddTerm}
                                                disabled={isWorking}
                                                className="flex items-center gap-2 text-[10px] font-mono text-neutral-600 hover:text-black transition-colors uppercase tracking-widest py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                <Plus className="w-3 h-3" /> 新增术语
                                            </button>
                                        </div>
                                    </div>
                                </div>
                        )}
                    </div>
                </div>
            )}
          </div>

          {/* Bottom Collapsible Status Capsule & Console Log Drawer */}
          <div className="absolute bottom-0 left-0 right-0 z-30 flex flex-col bg-neutral-950 text-white border-t border-neutral-800 transition-all duration-300">
            {/* Expanded Terminal Panel */}
            {isLogDrawerOpen && (
              <div className="h-64 flex flex-col border-b border-neutral-800 bg-black/95">
                <div className="px-4 py-2 border-b border-neutral-800 flex items-center justify-between gap-3 bg-neutral-900/90 select-none">
                  <div className="flex items-center gap-2 text-xs font-mono text-neutral-300 min-w-0">
                    <Terminal className="w-3.5 h-3.5 text-white shrink-0" />
                    <span className="font-bold uppercase tracking-wider shrink-0">控制台</span>
                    <span className="text-[10px] text-neutral-500 font-mono shrink-0">({logs.length})</span>
                    {tokenStats.requestCount > 0 && (
                      <span
                        className="text-[10px] text-neutral-400 font-mono truncate hidden sm:inline tabular-nums ml-2 pl-2 border-l border-neutral-700"
                        title={`总计 ${tokenStats.totalTokens.toLocaleString()} tokens（共 ${tokenStats.requestCount} 次请求）`}
                      >
                        输入 {tokenStats.promptTokens.toLocaleString()} · 缓存 {tokenStats.cachedTokens.toLocaleString()} ({tokenStats.promptTokens > 0 ? Math.round((tokenStats.cachedTokens / tokenStats.promptTokens) * 100) : 0}%) · 输出 {tokenStats.completionTokens.toLocaleString()}
                        {tokenStats.reasoningTokens > 0 ? ` · 思考 ${tokenStats.reasoningTokens.toLocaleString()}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setLogs([])}
                      className="text-[10px] font-mono text-neutral-400 hover:text-white px-2 py-0.5 border border-neutral-700 hover:border-neutral-500 transition-colors"
                    >
                      清空
                    </button>
                    <button
                      onClick={() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
                      className="text-[10px] font-mono text-neutral-400 hover:text-white px-2 py-0.5 border border-neutral-700 hover:border-neutral-500 transition-colors"
                    >
                      最新
                    </button>
                    <button
                      onClick={() => setIsLogDrawerOpen(false)}
                      className="text-neutral-400 hover:text-white p-1 ml-1"
                      title="收起控制台"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 p-4 font-mono text-xs overflow-y-auto custom-scrollbar space-y-2 text-neutral-300">
                  {logs.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-neutral-600 text-xs">
                      暂无运行记录
                    </div>
                  ) : (
                    logs.map((log, idx) => (
                      <div key={idx} className={`flex gap-3 leading-relaxed ${
                        log.type === 'error' ? 'text-red-400 bg-red-950/20 p-1 border-l-2 border-red-500' :
                        log.type === 'success' ? 'text-emerald-400 font-semibold' :
                        log.type === 'process' ? 'text-neutral-200' : 'text-neutral-400'
                      }`}>
                        <span className="opacity-40 shrink-0 select-none text-[10px]">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                        <span className="break-words">{log.message}</span>
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} className="h-4" />
                </div>
              </div>
            )}

            {/* Compact Bottom Bar (Always Visible Capsule) */}
            <div className="h-10 px-4 flex items-center justify-between text-xs font-mono bg-neutral-950 select-none border-t border-neutral-800">
              <div className="flex items-center gap-3 min-w-0 pr-4">
                {/* Status indicator dot */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={`w-2 h-2 rounded-full ${
                    isWorking ? 'bg-emerald-400 animate-pulse' :
                    status === AppStatus.COMPLETED ? 'bg-emerald-400' :
                    status === AppStatus.PAUSED ? 'bg-amber-400' :
                    status === AppStatus.ERROR ? 'bg-red-400' : 'bg-neutral-500'
                  }`} />
                  <span className="font-bold text-white text-[11px] uppercase tracking-wider">
                    {status === AppStatus.PARSING ? '解析中' :
                     status === AppStatus.TRANSLATING ? '翻译中' :
                     status === AppStatus.PACKAGING ? '导出中' :
                     status === AppStatus.COMPLETED ? '已完成' :
                     status === AppStatus.PAUSED ? '已暂停' :
                     status === AppStatus.ERROR ? '异常' : '就绪'}
                  </span>
                </div>

                <span className="text-neutral-700 hidden sm:inline">|</span>

                {/* Chapters & Glossary Stats */}
                <span className="text-[11px] text-neutral-400 shrink-0 hidden sm:inline">
                  {chapters.filter(c => c.translatedMarkdown || isChapterNonTranslatable(c, config.smartSkip)).length}/{chapters.length} 章 · 术语 {glossaryEntries.length} 条
                </span>

                {tokenStats.requestCount > 0 && (
                  <>
                    <span className="text-neutral-700 hidden sm:inline">|</span>
                    <span
                      className="text-[11px] text-neutral-300 shrink-0 hidden sm:inline tabular-nums"
                      title={`请求 ${tokenStats.requestCount} 次 | 输入 ${tokenStats.promptTokens.toLocaleString()} | 缓存命中 ${tokenStats.cachedTokens.toLocaleString()} | 输出 ${tokenStats.completionTokens.toLocaleString()}${tokenStats.reasoningTokens > 0 ? ` | 思考 ${tokenStats.reasoningTokens.toLocaleString()}` : ''}`}
                    >
                      Token {formatTokenCount(tokenStats.totalTokens)} · 缓存 {tokenStats.promptTokens > 0 ? Math.round((tokenStats.cachedTokens / tokenStats.promptTokens) * 100) : 0}%
                    </span>
                  </>
                )}

                <span className="text-neutral-700 hidden md:inline">|</span>

                {/* Latest log snippet */}
                <span className="text-[11px] text-neutral-400 truncate hidden md:inline font-mono">
                  {logs.length > 0 ? logs[logs.length - 1].message : '就绪'}
                </span>
              </div>

              {/* Drawer Toggle */}
              <button
                onClick={() => setIsLogDrawerOpen(!isLogDrawerOpen)}
                className="flex items-center gap-1.5 text-[11px] text-neutral-300 hover:text-white px-2.5 py-1 bg-neutral-900 border border-neutral-700 hover:border-neutral-500 transition-colors shrink-0"
              >
                <Terminal className="w-3 h-3 text-neutral-400" />
                <span>控制台</span>
                <span className="px-1 py-0.2 bg-neutral-800 text-[10px] text-neutral-300 font-bold">
                  {logs.length}
                </span>
                {isLogDrawerOpen ? <ChevronDown className="w-3 h-3 ml-0.5" /> : <ChevronUp className="w-3 h-3 ml-0.5" />}
              </button>
            </div>
          </div>
        </div>

      </main>

      {/* Preview Modal */}
      {previewChapter && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-10 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-white w-full max-w-4xl h-[90vh] flex flex-col rounded-none shadow-none overflow-hidden border border-black animate-in zoom-in-95 duration-200">
                  <div className="bg-black px-6 py-4 flex items-center justify-between border-b border-black">
                      <div className="flex items-center gap-3 min-w-0 pr-4">
                        <Info className="w-5 h-5 text-white shrink-0" />
                        <h2 className="text-sm md:text-base font-mono uppercase tracking-widest font-bold text-white truncate">
                          章节原文预览 · {previewChapter.title || previewChapter.fileName}
                        </h2>
                      </div>
                      <button 
                        onClick={() => setPreviewChapter(null)}
                        className="p-2 hover:bg-neutral-800 rounded-none transition-colors text-neutral-400 hover:text-white border border-transparent hover:border-white/20 shrink-0"
                      >
                          <X className="w-6 h-6" />
                      </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-8 md:p-12 font-sans text-black leading-relaxed bg-white">
                      <div className="max-w-2xl mx-auto">
                        {previewChapter.content && /<[a-z][\s\S]*>/i.test(previewChapter.content) ? (
                            <EpubFinishedPreview
                                chapter={previewChapter}
                                displayMode="source"
                                bookCssTexts={bookCssTexts}
                                opfDir={opfDirRef.current}
                                persistence={persistenceService.current}
                            />
                        ) : (
                            <div className="markdown-body prose prose-stone prose-lg max-w-none">
                                <ReactMarkdown
                                    components={{
                                        img: ({ src, alt }) => (
                                            <MarkdownImage 
                                                src={src} 
                                                alt={alt} 
                                                chapterPath={previewChapter.fileName} 
                                                persistence={persistenceService.current} 
                                            />
                                        )
                                    }}
                                >
                                    {formatMarkdownForPreview(previewChapter.markdown || "", previewChapter.internalizedFootnotes, undefined)}
                                </ReactMarkdown>
                            </div>
                        )}
                      </div>
                  </div>
                  <div className="bg-white px-6 py-4 flex items-center justify-center border-t border-black text-black font-mono text-[10px] uppercase tracking-widest font-bold">
                      此为按原书样式渲染的 EPUB 章节原文。
                  </div>
              </div>
          </div>
      )}
    </div>
  );
};

export default App;