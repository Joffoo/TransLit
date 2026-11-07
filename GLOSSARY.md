# TransLit

Pure front-end EPUB translation and terminology engine that parses, internalizes, chunks, translates, and repackages EPUB 2/3 books with native popup footnotes.

## Language

### Footnote Topology & Resolution

**FootnoteNode**:
A discrete footnote definition extracted during global pre-scanning of all EPUB XHTML files, including all contiguous multi-paragraph sibling blocks belonging to that note.
_Avoid_: Note item, raw footnote, endnote fragment

**Noteref**:
An in-text anchor in a chapter body that points to a **FootnoteNode** (either same-page `#id` or cross-file `notes.xhtml#id`), normalized into a chapter-namespaced same-page reference (`#fn-{chIndex}-{uniqueIndex}`).
_Avoid_: Footnote link, superscript tag, citation link

**FootnoteSourceFile**:
A standalone XHTML file in the EPUB whose primary purpose is hosting **FootnoteNode** definitions referenced by other chapters, marked as a protected system footnote source so users do not accidentally delete its footnotes.
_Avoid_: Endnotes chapter, appendix page

**ZeroOffsetPlaceholder**:
An empty, valid XHTML skeleton written back into a drained **FootnoteSourceFile** at packaging time so `content.opf` (Manifest/Spine) and navigation files (`toc.ncx` / `nav.xhtml`) remain structurally intact without dead links.
_Avoid_: Deleted file, stripped file

### Page Classification

**PageCategory**:
The semantic role of an EPUB spine item (`copyright`, `media_only`, `toc`, `footnote_source`, `content`, `front_matter`, `back_matter`) determined by the two-stage classifier to pre-populate the user's disposition choice (`translate`, `skip`, `keep_original`, `system_protected`).
_Avoid_: Chapter type, skip flag

### Translation & Chunking Pipeline

**FootnoteSlot**:
An opaque, immutable token (`__FN_REF_{id}__`) that replaces a **Noteref** inside a text chunk before LLM translation so the model cannot hallucinate, drop, or reformat Markdown footnote syntax.
_Avoid_: Markdown footnote marker, citation placeholder

**FootnoteTranslationPool**:
A book-wide dictionary (`Map<footnoteId, TranslatedFootnote>`) that caches translated **FootnoteNode** entries so cross-chunk citations reuse the canonical translation as read-only context instead of re-translating inconsistently.
_Avoid_: Footnote cache, note glossary

**OversizedFootnote**:
A **FootnoteNode** whose token estimate exceeds the single-chunk threshold, detached from the inline chunk payload to be translated in dedicated sub-chunks and reassembled by ID.
_Avoid_: Long note, overflow note

**ContextAwareChunk**:
A single translation unit assembled from top-level DOM/Markdown blocks within the token budget, pairing body text (with **FootnoteSlot** tokens) alongside pending **FootnoteNode** items to translate and already-translated reference notes from the **FootnoteTranslationPool**.
_Avoid_: Text slice, raw paragraph batch

**Epub3AsideFootnote**:
The standard EPUB 3 `<aside id="fn-{id}" epub:type="footnote" class="footnote-popup">` markup paired with `<a id="fnref-{id}" href="#fn-{id}" epub:type="noteref" class="noteref">` that triggers native popup bubbles in modern reading systems and degrades gracefully at the chapter bottom in legacy readers.
_Avoid_: Bottom footnote list, `<section class="footnotes">`
