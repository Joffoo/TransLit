
export interface FootnoteNode {
  key: string; // Normalized "fileRelativePath#id"
  sourceFile: string; // File path relative to opfDir
  originalId: string; // Original DOM id attribute
  namespaceId?: string; // Chapter-scoped ID: "{chIndex}-{uniqueIndex}" (used as fn-{id} and __FN_REF_{id}__)
  label: string; // Display label or number
  html: string; // Cleaned HTML (backlinks stripped)
  plainText: string; // Plain text content
  paragraphs: string[]; // Individual paragraphs for multi-paragraph footnotes
  referencedByChapters: number[]; // Indices of chapters referencing this footnote
}

export type PageCategory =
  | 'copyright'
  | 'media_only'
  | 'toc'
  | 'footnote_source'
  | 'front_matter'
  | 'back_matter'
  | 'ambiguous'
  | 'content';

export type PageDisposition =
  | 'skip'
  | 'keep_original'
  | 'system_toc'
  | 'system_footnote_source'
  | 'translate';

export interface PageClassification {
  category: PageCategory;
  disposition: PageDisposition;
  reason: string;
  stage: 'local_rule' | 'lightweight_ai' | 'user_override';
  confidence: number;
  isSystemProtected?: boolean;
}

export interface Chapter {
  id: string;
  index: number; // Added for sorting persistence
  fileName: string;
  title: string;
  content: string; // HTML content
  markdown?: string; // Converted markdown
  slottedMarkdown?: string; // Markdown with __FN_REF_{id}__ slots
  translatedMarkdown?: string; // After AI
  translatedChunks?: string[]; // Intermediate translation chunks
  fallbackChunks?: number[]; // Indices of chunks that returned errors/empty
  proofreadMarkdown?: string; // After 2nd pass
  proofreadChunks?: string[]; // Intermediate proofread chunks
  fallbackProofreadChunks?: number[]; // Indices of chunks that returned errors/empty
  isSkippable?: boolean; // Pages to remove completely (Copyright, TOC, Title Page)
  isReference?: boolean; // Pages to keep but NOT translate (References, Notes)
  isTocPoint?: boolean; // Whether this file is an explicit entry in the original TOC
  isFootnoteSource?: boolean; // Standalone footnote file detected by FootnoteResolver
  isSystemProtected?: boolean; // Protected footnote source file (0-Offset placeholder on export)
  classification?: PageClassification; // Two-stage page classifier result
  internalizedFootnotes?: Record<string, FootnoteNode>; // Footnotes internalized into this chapter keyed by namespaceId
  translatedFootnotes?: Record<string, string>; // Translated footnotes keyed by namespaceId
  glossary?: string; // Cumulative glossary up to the end of this chapter
  chunkGlossaries?: string[]; // Glossary state after each chunk
}

export interface ProcessingLog {
  timestamp: number;
  message: string;
  type: 'info' | 'success' | 'error' | 'process';
}

export interface SessionState {
  status: AppStatus;
  config: AppConfig;
  progress: number;
  fileName: string;
  coverPath?: string;
  lastUpdated: number;
  opfPath?: string;
  opfDir?: string;
  cssFiles?: string[];
}

export enum AppStatus {
  IDLE = 'IDLE',
  PARSING = 'PARSING',
  TRANSLATING = 'TRANSLATING',
  PACKAGING = 'PACKAGING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
  PAUSED = 'PAUSED'
}

export interface AppConfig {
  // AI Settings
  apiKey: string;
  baseUrl: string;
  modelName: string;
  
  // Translation Settings
  sourceLanguage: string;
  additionalContext: string;
  
  // Toggles
  enableProofreading: boolean;
  useRecommendedPrompts: boolean;
  smartSkip: boolean; // Toggle for skipping non-content pages
  enableGlossary: boolean; // Toggle for terminology system
}
