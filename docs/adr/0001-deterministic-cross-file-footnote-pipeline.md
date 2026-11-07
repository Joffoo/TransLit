# Deterministic Cross-File Footnote Internalization, Slotting, and 0-Offset Packaging

We extract and internalize cross-file EPUB footnotes via a deterministic DOM/AST pipeline (`FootnoteResolver` → `PageClassifier` → `FootnotePool` → `ContextAwareChunker` → `Epub3AsideFootnote`), replace in-text footnote markers with opaque `__FN_REF_{id}__` slots before calling the LLM while maintaining the `translateChunk(string) -> Promise<string>` contract, and overwrite drained standalone footnote files with 0-Offset XHTML placeholders instead of deleting them from the archive.

## Context & Trade-offs

- **Why opaque slots (`__FN_REF_{id}__`) instead of Markdown `[^id]`**: LLMs frequently corrupt Markdown footnote syntax (turning `[^1]` into `(1)`, moving markers, or emitting full-width colons `[^1]：`). Replacing markers with `__FN_REF_{id}__` and deterministically validating and restoring them after translation eliminates syntax hallucinations while keeping the string-in/string-out LLM chunk contract intact.
- **Why global `FootnoteTranslationPool`**: A single footnote can be cited across multiple chunks or chapters. Caching the first translation in `FootnoteTranslationPool` and passing subsequent hits as read-only reference context prevents conflicting translations and saves tokens; oversized footnotes are split and translated independently to prevent chunk token overflow.
- **Why 0-Offset XHTML placeholders instead of physical file deletion**: Deleting a drained `notes.xhtml` requires mutating `content.opf` manifest/spine, `toc.ncx`, `nav.xhtml`, and any internal links across the book, risking broken archives in strict EPUB readers. Retaining the file entry with a lightweight informational XHTML body preserves 100% manifest/TOC integrity at zero offset.
