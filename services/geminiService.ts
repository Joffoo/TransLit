
import { AppConfig, FootnoteNode } from "../types";
import { 
    TRANSLATION_PROMPT_NOTES, 
    TRANSLATION_PROMPT_GLOSSARY_PRINCIPLES, 
    GLOSSARY_OPTIMIZER_ALL_PROMPT,
    GLOSSARY_OPTIMIZER_INCREMENTAL_PROMPT,
    TWO_STEP_BASE_PROMPT,
    FMT_ONE_STEP_GLOSSARY,
    FMT_TWO_STEP_GLOSSARY,
    FMT_TWO_STEP_NO_GLOSSARY,
    FMT_ONE_STEP_NO_GLOSSARY
} from "../prompts";
import { parseGlossaryStr, glossaryToOutputStr } from "../utils/glossaryUtils";
import {
  FootnotePool,
  TranslatedFootnote,
  extractFootnoteSlots,
  validateAndRepairSlots
} from "./footnotePool";
import { LightweightPagePayload, LightweightAiVerdict } from "./pageClassifier";
import Fuse from 'fuse.js';

export class AiService {
  // Safe chunk size to avoid context limits (approx 3000 chars)
  private CHUNK_SIZE = 3000;
  private config: AppConfig;
  private defaultFootnotePool = new FootnotePool();

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Stage 2 Lightweight AI Page Classifier:
   * Sends only `{ title, wordCount, snippet: text.slice(0, 200) }` to classify transition pages.
   */
  async classifyPageSnippet(payload: LightweightPagePayload): Promise<LightweightAiVerdict> {
    const safePayload: LightweightPagePayload = {
      title: payload.title,
      wordCount: payload.wordCount,
      snippet: (payload.snippet || '').slice(0, 200)
    };
    const systemPrompt =
      'You are an EPUB book structure classifier. Respond ONLY in JSON: {"category":"front_matter|back_matter|copyright|content","disposition":"translate|skip|keep_original","reason":"short reason"}';
    const userPrompt = JSON.stringify(safePayload);
    const result = await this.generate(userPrompt, systemPrompt, 0.1);
    try {
      const jsonMatch = result.translation.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result.translation);
      return {
        category: parsed.category || 'front_matter',
        disposition: parsed.disposition || 'translate',
        reason: parsed.reason || 'Classified by lightweight AI',
        confidence: 0.9
      };
    } catch {
      return {
        category: 'front_matter',
        disposition: 'translate',
        reason: 'Fallback to translate',
        confidence: 0.7
      };
    }
  }

  /**
   * Cleans the glossary using Gemini to remove noise and redundancies.
   */
  async optimizeGlossary(glossaryText: string): Promise<string> {
      try {
          const result = await this.generate(`Current Glossary:\n${glossaryText}`, GLOSSARY_OPTIMIZER_ALL_PROMPT, 0.2);
          return result.translation; // translation property holds the text
      } catch (error) {
          console.error("Glossary optimization API call failed:", error);
          throw error;
      }
  }

  /**
   * Cleans newly added terms against a master glossary.
   */
  async optimizeIncrementalGlossary(newTermsText: string, masterGlossaryText: string): Promise<string> {
      try {
          const prompt = `MASTER GLOSSARY:\n${masterGlossaryText || "(Empty)"}\n\nNEW CANDIDATES:\n${newTermsText}`;
          const result = await this.generate(prompt, GLOSSARY_OPTIMIZER_INCREMENTAL_PROMPT, 0.2);
          return result.translation;
      } catch (error) {
          console.error("Incremental glossary optimization failed:", error);
          throw error;
      }
  }

  /**
   * Helper to retry operations with exponential backoff.
   */
  private async retry<T>(
    operation: () => Promise<T>, 
    retries: number = 3, 
    delay: number = 2000
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      if (retries <= 0) {
          throw error;
      }
      
      const errString = String(error) + (typeof error === 'object' ? JSON.stringify(error) : '');
      const isRateLimit = errString.includes('429');
      const isAuthError = errString.includes('401') || errString.includes('403');

      if (isAuthError) throw error; // Never retry auth errors

      const isEmptyOrBadRequest = errString.includes('400') || errString.includes('empty response');
      
      // Allow exactly 1 retry for empty responses or 400 errors.
      // Since default retries is 3, if retries <= 2, we've already retried once.
      if (isEmptyOrBadRequest && retries <= 2) {
          throw error;
      }

      let nextDelay = delay;

      if (isRateLimit) {
          nextDelay = Math.max(delay * 1.5, 5000);
          console.warn(`Rate limit exceeded (429). Pausing for ${nextDelay}ms... (${retries} attempts left)`);
      } else {
          nextDelay = delay * 2;
          console.warn(`API call failed. Retrying in ${nextDelay}ms... (${retries} attempts left).`, error);
      }
      
      await new Promise(resolve => setTimeout(resolve, nextDelay));
      return this.retry(operation, retries - 1, nextDelay);
    }
  }

  /**
   * Splits text into manageable chunks.
   */
  public splitTextIntoChunks(text: string, customSize?: number): string[] {
    const size = customSize || this.CHUNK_SIZE;
    if (!text || text.length <= size) return [text];

    const chunks: string[] = [];
    let currentChunk = '';
    
    const paragraphs = text.split(/\n\n/);

    for (const paragraph of paragraphs) {
      if ((currentChunk.length + paragraph.length + 2) > size) {
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = '';
        }

        if (paragraph.length > size) {
           const lines = paragraph.split('\n');
           let currentLineChunk = '';
           
           for (const line of lines) {
             if ((currentLineChunk.length + line.length + 1) > size) {
                if (currentLineChunk) {
                    chunks.push(currentLineChunk);
                    currentLineChunk = '';
                }
                if (line.length > size) {
                    let remaining = line;
                    while (remaining.length > 0) {
                        chunks.push(remaining.substring(0, size));
                        remaining = remaining.substring(size);
                    }
                } else {
                    currentLineChunk = line;
                }
             } else {
                currentLineChunk += (currentLineChunk ? '\n' : '') + line;
             }
           }
           if (currentLineChunk) chunks.push(currentLineChunk);

        } else {
           currentChunk = paragraph;
        }
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Cleans the model output by removing thinking tags and conversational prefixes.
   * Also extracts translation and glossary if they are wrapped in tags.
   */
  private parseResponse(text: string): { translation: string; glossary?: string } {
    if (!text) return { translation: "" };

    // 1. Remove <think> blocks
    let clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // 2. Try to extract from <translation> and <glossary> tags
    let translationMatch = clean.match(/<translation>([\s\S]*?)<\/translation>/i);
    const glossaryMatch = clean.match(/<glossary>([\s\S]*?)<\/glossary>/i);

    if (!translationMatch) {
      // Robustness: Handle unclosed <translation> tag if LLM output was truncated
      const unclosedMatch = clean.match(/<translation>([\s\S]*)$/i);
      if (unclosedMatch) {
        let content = unclosedMatch[1];
        if (glossaryMatch) {
          content = content.replace(/<glossary>[\s\S]*$/i, '');
        }
        translationMatch = [unclosedMatch[0], content];
      } else {
        // Robustness: If <translation> completely missing in two-step response, fallback to <translation_draft>
        const draftMatch = clean.match(/<translation_draft>([\s\S]*?)(?:<\/translation_draft>|$)/i);
        if (draftMatch) {
          translationMatch = draftMatch;
        }
      }
    }

    if (translationMatch) {
      let translation = translationMatch[1].trim();
      
      // Post-process: Remove leaked step 1 draft if model dumped both passes inside <translation>
      translation = translation.replace(/^(?:#+\s*|\*+|\[)?第一步[:：\s]*[\s\S]*?(?:#+\s*|\*+|\[)?第二步[:：\s]*[^\n]*\n/i, '').trim();
      // Post-process: Remove common step 2 headers that models might include inside the tag
      // Critical: Must use [^\n]* to only strip the heading line, never [^]* which would wipe all subsequent paragraphs
      translation = translation.replace(/^(?:#+\s*|\*+|\[)?第二步[:：\s]*[^\n]*\n/i, '').trim();
      // Also catch the specific user-reported string if it persists
      translation = translation.replace(/^\[第二步：最终审校润色后的内容\]\s*\n?/i, '').trim();
      
      // Salvage any footnote definitions placed inside <translation_draft> or outside </translation>
      const salvagedMap = new Map<string, string>();

      // 1. Tag-based footnote definitions: [FN_DEF:...] or 【FN_DEF:...】 (supports optional closing tag)
      const fnDefRegex = /(?:\[|【)\s*FN_DEF[:：]\s*([^\]】]+?)\s*(?:\]|】)([\s\S]*?)(?:(?:\[|【)\s*[\/／]\s*FN_DEF\s*(?:\]|】)|(?=(?:\[|【)\s*FN_DEF[:：])|(?:<\/translation(?:_draft)?>)|$)/gi;
      let fnMatch: RegExpExecArray | null;
      while ((fnMatch = fnDefRegex.exec(clean)) !== null) {
        const fnId = fnMatch[1].trim();
        const fnBody = fnMatch[2].trim();
        const escapedId = fnId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const alreadyInTranslation = new RegExp(`(?:\\[|【)\\s*FN_DEF[:：]\\s*${escapedId}\\s*(?:\\]|】)`, 'i').test(translation);
        if (!alreadyInTranslation && fnBody) {
          salvagedMap.set(fnId.toLowerCase(), `[FN_DEF:${fnId}]\n${fnBody}\n[/FN_DEF]`);
        }
      }

      // 2. Standard markdown footnote definitions: [^...]: ... (supports Chinese brackets and multiline)
      const mdDefRegex = /(?:^|\n)((?:\[|【|〔)\s*\^\s*(?:fn-)?([^\]】〕]+?)\s*(?:\]|】|〕)[:：][ \t]*([\s\S]*?)(?=(?:\n(?:\[|【|〔)\s*\^\s*(?:fn-)?)|(?:\n\n(?!\s{2,}))|(?:<\/translation(?:_draft)?>)|$))/g;
      let mdMatch: RegExpExecArray | null;
      while ((mdMatch = mdDefRegex.exec(clean)) !== null) {
        const fullMdBlock = mdMatch[1].trim();
        const mdId = mdMatch[2].trim();
        const escapedId = mdId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const alreadyInTranslation =
          new RegExp(`(?:^|\\n)(?:\\[|【|〔)\\s*\\^\\s*(?:fn-)?${escapedId}\\s*(?:\\]|】|〕)[:：]`, 'i').test(translation) ||
          new RegExp(`(?:\\[|【)\\s*FN_DEF[:：]\\s*${escapedId}\\s*(?:\\]|】)`, 'i').test(translation);
        if (!alreadyInTranslation && fullMdBlock) {
          salvagedMap.set(mdId.toLowerCase(), fullMdBlock);
        }
      }

      if (salvagedMap.size > 0) {
        translation = `${translation}\n\n${Array.from(salvagedMap.values()).join('\n\n')}`;
      }

      const glossary = glossaryMatch ? glossaryMatch[1].trim() : undefined;
      return { translation, glossary };
    }

    // Fallback: original cleaning logic if tags are missing
    const codeBlockRegex = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/i;
    const match = clean.match(codeBlockRegex);
    if (match) {
        clean = match[1].trim();
    }

    clean = clean.replace(/^(Here is the translation|Sure|Here is the translated content|Here is the proofread version)[^:\n]*:?\s*/i, '');

    return { translation: clean.trim() };
  }

  /**
   * Generic OpenAI-Compatible Chat Completion
   */
  private async generate(
      prompt: string, 
      systemInstruction: string, 
      temperature: number = 0.3
  ): Promise<{ translation: string; glossary?: string }> {
      const operation = async () => {
        if (!this.config.apiKey) throw new Error("API Key is required.");
        if (!this.config.baseUrl) throw new Error("Base URL is required.");

        const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;

        const body = {
            model: this.config.modelName,
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: prompt }
            ],
            temperature: temperature
        };

        // In dev mode, route through the local Vite proxy to bypass browser CORS restrictions.
        // The proxy middleware reads X-Target-Url and forwards the request server-side.
        // In production, fetch directly to the API endpoint as before.
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.config.apiKey}`
        };
        const fetchUrl = import.meta.env.DEV ? '/__api_proxy' : url;
        if (import.meta.env.DEV) headers["X-Target-Url"] = url;

        const response = await fetch(fetchUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
             throw new Error("Received empty response from API");
        }
        
        return this.parseResponse(content);
      };

      return this.retry(operation);
  }

  /**
   * Verifies the connection to the configured API.
   */
  async testConnection(): Promise<boolean> {
      try {
          const testPrompt = "Ping";
          const testSystem = "Reply with 'Pong' only.";
          const result = await this.generate(testPrompt, testSystem, 0.1);
          return result.translation.toLowerCase().includes('pong') || result.translation.length > 0;
      } catch (e: any) {
          console.error("Connection Test Failed:", e);
          throw e;
      }
  }

  private mergeGlossary(base: string, delta: string): string {
    const baseMap = parseGlossaryStr(base);
    const deltaMap = parseGlossaryStr(delta);
    const merged = { ...baseMap, ...deltaMap };
    return glossaryToOutputStr(merged);
  }

  /**
   * Filters candidate terms in deltaGlossary by searching posterior text.
   * 1. Strips out terms already present in currentGlossary (avoids duplicate trigger).
   * 2. If posteriorText is empty (e.g. final chapter), keeps all remaining terms (last chapter safety).
   * 3. Performs fast O(N) substring and prefix/word checks with .toLowerCase().
   */
  private filterDeltaByPosterior(
    deltaGlossaryText: string, 
    currentGlossaryText: string, 
    posteriorText: string
  ): { filteredText: string; originalCount: number; filteredCount: number } {
    if (!deltaGlossaryText) return { filteredText: "", originalCount: 0, filteredCount: 0 };

    const deltaMap = parseGlossaryStr(deltaGlossaryText);
    const currentMap = parseGlossaryStr(currentGlossaryText);
    
    const deltaEntries = Object.entries(deltaMap);
    const originalCount = deltaEntries.length;
    if (originalCount === 0) return { filteredText: "", originalCount: 0, filteredCount: 0 };

    // 1. Exclude terms already in currentGlossary
    const newCandidates: [string, string][] = [];
    deltaEntries.forEach(([key, val]) => {
      if (!currentMap[key]) {
        newCandidates.push([key, val]);
      }
    });

    // 2. Final Chapter Safety: if no posterior text, keep all new candidates
    const trimmedPosterior = posteriorText ? posteriorText.trim() : "";
    if (!trimmedPosterior) {
      const filteredMap: Record<string, string> = {};
      newCandidates.forEach(([k, v]) => filteredMap[k] = v);
      return {
        filteredText: glossaryToOutputStr(filteredMap),
        originalCount,
        filteredCount: newCandidates.length
      };
    }

    // 3. Fast O(N) Substring & Fallback Check
    const lowerPosterior = trimmedPosterior.toLowerCase();
    const keptMap: Record<string, string> = {};

    newCandidates.forEach(([key, val]) => {
      const lowerKey = key.toLowerCase();

      // Direct Substring Check (covers CJK prefix/suffix & English singular in plural)
      if (lowerPosterior.includes(lowerKey)) {
        keptMap[key] = val;
        console.log(`[Glossary Filter] ✅ Term "${key}" kept (found in posterior text).`);
        return;
      }

      // Reverse Deformation Check (Prefix fallback for keys of length >= 4)
      if (lowerKey.length >= 4) {
        const prefix = lowerKey.substring(0, lowerKey.length - 1);
        if (lowerPosterior.includes(prefix)) {
          keptMap[key] = val;
          console.log(`[Glossary Filter] ✅ Term "${key}" kept via prefix "${prefix}".`);
          return;
        }
      }

      // Multi-word splitting fallback for English phrases (e.g. "Alexander Pierce")
      const words = key.split(/\s+/).filter(w => w.length >= 4);
      if (words.length > 1) {
        for (const word of words) {
          if (lowerPosterior.includes(word.toLowerCase())) {
            keptMap[key] = val;
            console.log(`[Glossary Filter] ✅ Term "${key}" kept via component word "${word}".`);
            return;
          }
        }
      }

      console.log(`[Glossary Filter] 🗑️ Term "${key}" dropped (not found in posterior text).`);
    });

    const filteredCount = Object.keys(keptMap).length;
    return {
      filteredText: glossaryToOutputStr(keptMap),
      originalCount,
      filteredCount
    };
  }

  /**
   * Performs AI-based optimization for redundancy and quality.
   */
  async smartCleanupGlossary(glossaryText: string, referenceText: string): Promise<string> {
    console.log(`[Smart Cleanup] Starting AI optimization...`);
    try {
        const optimizedText = await this.optimizeGlossary(glossaryText);
        const finalMap = parseGlossaryStr(optimizedText);
        console.log(`[Smart Cleanup] Optimization complete. Refined to ${Object.keys(finalMap).length} terms.`);
        return optimizedText;
    } catch (error) {
        console.warn(`[Smart Cleanup] Optimization failed, returning original.`, error);
        return glossaryText;
    }
  }

  async translateContent(
    content: string, 
    targetLanguage: string, 
    systemInstruction: string,
    onProgress?: (
      current: number,
      total: number,
      chunkResult: string,
      updatedGlossary?: string,
      isFallback?: boolean,
      stats?: { originalCount: number; filteredCount: number },
      chunkFootnotes?: Record<string, string>
    ) => Promise<void | string>,
    existingChunks: string[] = [],
    indicesToRetry: number[] = [],
    initialGlossary: string = "",
    fullPosteriorText: string = "",
    internalizedFootnotes: Record<string, FootnoteNode> = {},
    footnotePool?: FootnotePool
  ): Promise<{ content: string; glossary: string; translatedFootnotes: Record<string, string> }> {
    
    const activePool = footnotePool || this.defaultFootnotePool;
    const customChunkSize = this.config.enableProofreading ? 1800 : this.CHUNK_SIZE;
    const chunks = this.splitTextIntoChunks(content, customChunkSize);
    const translatedChunks: string[] = [...existingChunks];
    const chapterTranslatedFootnotes: Record<string, string> = {};

    // Ensure array is large enough
    while (translatedChunks.length < chunks.length) {
        translatedChunks.push("");
    }

    let currentGlossary = initialGlossary;

    const isCombinedMode = this.config.enableProofreading;
    
    let glossaryPart = '';
    if (this.config.enableGlossary) {
        glossaryPart = `\n\n${TRANSLATION_PROMPT_GLOSSARY_PRINCIPLES}`;
    }

    let formatInstruction = '';
    if (isCombinedMode) {
        if (this.config.enableGlossary) {
            formatInstruction = FMT_TWO_STEP_GLOSSARY;
        } else {
            formatInstruction = FMT_TWO_STEP_NO_GLOSSARY;
        }
    } else {
        if (this.config.enableGlossary) {
            formatInstruction = FMT_ONE_STEP_GLOSSARY;
        } else {
            formatInstruction = FMT_ONE_STEP_NO_GLOSSARY;
        }
    }

    const baseSystemInstruction = `${systemInstruction}\n\n${TRANSLATION_PROMPT_NOTES}${glossaryPart}\n\n${formatInstruction}`;

    const translateChunk = async (i: number) => {
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const chunk = chunks[i];
        let glossaryPrompt = "";
        if (this.config.enableGlossary) {
            if (currentGlossary) {
                glossaryPrompt = `\n\nCURRENT GLOSSARY:\n${currentGlossary}`;
            } else {
                glossaryPrompt = "\n\nCURRENT GLOSSARY: (Empty)";
            }
        }

        const chunkInstruction = chunks.length > 1
            ? `${baseSystemInstruction}\n\n[System Note: This is part ${i + 1} of ${chunks.length} of the chapter. Maintain strict terminology and stylistic consistency with previous parts.]${glossaryPrompt}`
            : `${baseSystemInstruction}${glossaryPrompt}`;

        // Inspect __FN_REF_{id}__ slots in this chunk and prepare dual-channel footnotes via FootnotePool
        const slotIds = Array.from(new Set(extractFootnoteSlots(chunk)));
        const pendingFootnotes: FootnoteNode[] = [];
        const referenceOnlyFootnotes: TranslatedFootnote[] = [];
        const chunkFootnotes: Record<string, string> = {};

        for (const fnId of slotIds) {
            const cleanId = fnId.replace(/^fn-/, '');
            const fnNode = internalizedFootnotes[cleanId] || internalizedFootnotes[fnId] || internalizedFootnotes[`fn-${cleanId}`];
            if (!fnNode) continue;

            const cached = activePool.getTranslatedFootnote(fnId, fnNode.key);
            if (cached) {
                referenceOnlyFootnotes.push(cached);
                chapterTranslatedFootnotes[fnId] = cached.translatedText;
                chunkFootnotes[fnId] = cached.translatedText;
                continue;
            }

            if (activePool.isOversizedFootnote(fnNode)) {
                const shunted = await activePool.translateOversizedFootnote(
                    fnNode,
                    async (subPayload: string) => {
                        const subRes = await this.generate(
                            `Translate the following footnote segment into ${targetLanguage}.\n\nCONTENT:\n${subPayload}`,
                            chunkInstruction,
                            0.3
                        );
                        return subRes.translation;
                    }
                );
                referenceOnlyFootnotes.push(shunted);
                chapterTranslatedFootnotes[fnId] = shunted.translatedText;
                chunkFootnotes[fnId] = shunted.translatedText;
                continue;
            }

            pendingFootnotes.push(fnNode);
        }

        const effectiveChunkPayload = activePool.formatDualChannelPayload(
            chunk,
            pendingFootnotes,
            referenceOnlyFootnotes
        );

        const prompt = `Translate the following Markdown content into ${targetLanguage}. \n\nCONTENT:\n${effectiveChunkPayload}`;

        try {
            const result = await this.generate(prompt, chunkInstruction, 0.3);
            const parsedDual = activePool.parseDualChannelResponse(
                result.translation,
                chunk,
                pendingFootnotes
            );

            for (const fnNode of pendingFootnotes) {
                const cleanId = (fnNode.namespaceId || fnNode.originalId).replace(/^fn-/, '');
                const trText = parsedDual.translatedFootnotes[cleanId] || fnNode.plainText;
                activePool.setTranslatedFootnote({
                    footnoteId: cleanId,
                    canonicalKey: fnNode.key,
                    originalText: fnNode.plainText,
                    translatedText: trText,
                    translatedParagraphs: trText
                        .split(/\n{2,}/)
                        .map((p) => p.trim())
                        .filter(Boolean),
                    wasOversizedShunted: false
                });
                chapterTranslatedFootnotes[cleanId] = trText;
                chunkFootnotes[cleanId] = trText;
            }

            const finalChunkText =
                pendingFootnotes.length > 0 || referenceOnlyFootnotes.length > 0
                    ? parsedDual.translatedBody
                    : validateAndRepairSlots(chunk, result.translation).repairedText;

            translatedChunks[i] = finalChunkText;
            let deltaGlossary = result.glossary || "";
            let stats = { originalCount: 0, filteredCount: 0 };
            
            if (this.config.enableGlossary && deltaGlossary) {
                const chapterPosterior = chunks.slice(i + 1).join('\n');
                const combinedPosterior = chapterPosterior + '\n' + fullPosteriorText;
                const filterRes = this.filterDeltaByPosterior(deltaGlossary, currentGlossary, combinedPosterior);
                deltaGlossary = filterRes.filteredText;
                stats = { originalCount: filterRes.originalCount, filteredCount: filterRes.filteredCount };
            }

            if (deltaGlossary) {
                currentGlossary = this.mergeGlossary(currentGlossary, deltaGlossary);
            }
            
            if (onProgress) {
                const syncedGlossary = await onProgress(i + 1, chunks.length, finalChunkText, deltaGlossary, false, stats, chunkFootnotes);
                if (typeof syncedGlossary === 'string') {
                    currentGlossary = syncedGlossary;
                }
            }
        } catch (error) {

            if (error instanceof Error && error.message === "PAUSE_SIGNAL") {
                throw error;
            }
            console.error(`Error translating chunk ${i + 1}/${chunks.length}:`, error);
            translatedChunks[i] = chunk;
            if (onProgress) {
                await onProgress(i + 1, chunks.length, chunk, "", true);
            }
        }
    };

    // 1. Resume from where we left off (sequential)
    const startIndex = existingChunks.length > 0 ? existingChunks.findIndex(c => !c) : 0;
    const start = startIndex === -1 ? existingChunks.length : startIndex;

    for (let i = start; i < chunks.length; i++) {
        // Only process if it's empty OR we haven't reached the end of existing chunks
        if (i >= existingChunks.length || !existingChunks[i]) {
            await translateChunk(i);
        }
    }

    // 2. Explicit retries
    for (const i of indicesToRetry) {
        if (i < chunks.length) {
            await translateChunk(i);
        }
    }

    return { 
        content: translatedChunks.join('\n\n'),
        glossary: currentGlossary,
        translatedFootnotes: chapterTranslatedFootnotes
    };
  }

  async proofreadContent(
    content: string, 
    instruction: string,
    onProgress?: (current: number, total: number, chunkResult: string, isFallback?: boolean) => Promise<void>,
    existingChunks: string[] = [],
    indicesToRetry: number[] = []
  ): Promise<string> {
    
    const chunks = this.splitTextIntoChunks(content);
    const proofreadChunks: string[] = [...existingChunks];

    while (proofreadChunks.length < chunks.length) {
        proofreadChunks.push("");
    }

    const proofreadChunk = async (i: number) => {
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const chunk = chunks[i];
        const prompt = `Check the following Markdown content. ${instruction}\n\nCONTENT:\n${chunk}`;
        
        try {
            const result = await this.generate(prompt, "You are a specialized proofreading assistant. Return ONLY the proofread Markdown.", 0.1);
            proofreadChunks[i] = result.translation; // result is now an object
            
            if (onProgress) {
                await onProgress(i + 1, chunks.length, result.translation);
            }
        } catch (error) {
            if (error instanceof Error && error.message === "PAUSE_SIGNAL") {
                throw error;
            }
            console.error(`Error proofreading chunk ${i + 1}/${chunks.length}:`, error);
            proofreadChunks[i] = chunk;
            if (onProgress) {
                await onProgress(i + 1, chunks.length, chunk, true);
            }
        }
    };

    const startIndex = existingChunks.length > 0 ? existingChunks.findIndex(c => !c) : 0;
    const start = startIndex === -1 ? existingChunks.length : startIndex;

    for (let i = start; i < chunks.length; i++) {
        if (i >= existingChunks.length || !existingChunks[i]) {
            await proofreadChunk(i);
        }
    }

    for (const i of indicesToRetry) {
        if (i < chunks.length) {
            await proofreadChunk(i);
        }
    }

    return proofreadChunks.join('\n\n');
  }
}
