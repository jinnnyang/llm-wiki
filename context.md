---
kind: context
last_updated: '2026-07-26T10:33:13+00:00'
last_writer: hand-off
last_agent: hermes-devops
session_id: handoff-20260726
last_verified: '2026-07-26T10:33:13+00:00'
---

# Context — llm-wiki

Session-independent invariants for the `feat/markdown-image-localizer` work.

## Repository facts

- Repo root: `C:\Users\jinnn\Documents\llm-wiki` [git:origin]
- Fork of `nashsu/llm_wiki` (upstream). Working branch `main` mirrors `origin/main`; `upstream` branch mirrors `nashsu/main`. [git:remote]
- Layout convention: `main` is rolling mirror of `origin/main` which may be ahead of `origin/upstream` (fork sometimes pulls community PRs before upstream releases them). Currently `main` = `upstream` = `e8bdec6` (v0.6.5 tip). [git:log]
- Active feature branch: `feat/markdown-image-localizer`, cut from `e8bdec6`. Head is `3cda623` (Phase 3 metadata embedding). 12 commits total on branch. [git:branch]
- Package manager: npm. Verify commands: `npm run test`, `npm run typecheck`, `npm run build`. [user:workspace-snapshot]
- Test framework: vitest. [git:package.json]
- Node 24.15.0, TypeScript strict. [user:profile]

## Toolchain state at session end

- GitNexus index: current as of `c2f626d` (a merge commit that got reset). After the reset to `e8bdec6`, index has 6,696 nodes / 17,677 edges / 456 communities. Contents match `e8bdec6` because tree was byte-identical to the merge commit. Index is now stale relative to branch head `3cda623`. [test:gitnexus-analyze-log]
- Working tree carries two files that predate this feature branch and should not be assumed as branch changes: `M package-lock.json` and untracked `CLAUDE.md`. [git:status]

## Framing invariants (locked, from post-review round v2 + v3)

- `raw/sources/` is an **llm-wiki-managed copy** of the imported material, not the user's real original input. `importSourceFiles` (`source-lifecycle.ts:262`) explicitly `copyFile`s external files into it; `importSourceUrls` writes URL captures into it. Modifying the copy is not modifying user input. [user:decision-2026-07-23-review]
- Traceability from a localized image back to its source URL lives in **frontmatter `image_sources:` mapping**, not in the raw markdown body. [user:decision-2026-07-23-review]
- Master toggle `multimodalConfig.localizeMarkdownImages: boolean` (default `true`). Enables the entire Step 0.4 pipeline; disable = byte-identical to pre-v0.6.6. [user:decision-2026-07-23-review]
- **Accessibility metadata is user work.** VLM captioning is a gap-filler, not a rewriter. The v3 decision matrix (§1 of plan) gates VLM on `alt` being empty — non-empty author alt is preserved verbatim; VLM never runs on it. This differs from the PDF/DOCX path where `captionMarkdownImages` still overwrites placeholders (correct for those sources; no author alt exists there). [user:decision-2026-07-23-v3]

## Image pipeline landmarks (predecessor v0.6.4 work)

- `src/lib/image-caption-pipeline.ts:283` — `captionMarkdownImages`, the VLM caption orchestrator for PDF/DOCX-extracted images. Does aggressive alt overwrite; that's correct for those sources. Not called from the new localizer path. [git:blob]
- `src/lib/image-caption-pipeline.ts:141` — `MD_IMAGE_RE`. Does NOT capture `"title"`; splits url at whitespace. Do not modify — the new module ships an extended regex `MD_IMAGE_RE_WITH_TITLE` alongside it. [git:blob]
- `src/lib/vision-caption.ts` — `captionImage(imageBase64, mediaType, llmConfig, signal, options)`. Codex-CLI transport is a no-op (early return). [git:blob]
- `src/lib/extract-source-images.ts:200` — `extractAndSaveMarkdownImages` handles **local relative** md image refs today. When `localizeMarkdownImages` is enabled, this call is **skipped** at both call sites in `ingest.ts` (~738 and ~836); the new localizer's `local-relative` classification covers the same job plus VLM captioning. When the master toggle is off, the legacy call still runs. [user:decision-2026-07-23-v3]
- `src/lib/url-source-import.ts:86` — `fetchImportUrl` with SSRF/private-network/redirect defenses. Reuse verbatim. [git:blob]
- `src/lib/tauri-fetch.ts:41` — `getHttpFetch` wrapper. [git:blob]
- `src/commands/fs.ts` — `writeFileBase64(path, base64)` → Rust `write_file_base64`. Also `readFileAsBase64(path)` → Rust `read_file_base64`. [git:blob]
- `src/lib/frontmatter.ts:37` — `parseFrontmatter(content) → { frontmatter, body, rawBlock }`. Round-trips untouched YAML via `rawBlock`. Reuse for `image_sources:` mapping merge. [git:blob]
- `src/lib/markdown-image-resolver.ts:50` — `isInsideProject(path, projectPath): boolean`. **Reuse for path-traversal defense** in localizer's `resolveLocalRelative` helper. [user:decision-2026-07-23-v3]
- `src/lib/ingest-cache.ts:61` — `checkIngestCache(projectPath, sourceIdentity, sourceContent) → filesWritten | null`. Validates file existence on hit. Parameter is *named* `sourceFileName` in the implementation but semantically holds `sourceIdentity` — historical parameter name, do not rename. [git:blob]
- `src/lib/ingest-cache.ts:98` — `saveIngestCache(projectPath, sourceIdentity, sourceContent, filesWritten)`. [git:blob]
- `src/lib/ingest.ts:637` — `autoIngestImpl`. Step 0.4 hook goes after source read (~line 710), **before** cache check (~line 729). Uniform placement — no cache-hit special branch. [git:blob]
- `src/lib/ingest.ts:649` — `sourceIdentity = sourceIdentityForPath(pp, sp)`. Do not introduce a third name for this variable in v3; call all `ingest-cache.ts` functions with `sourceIdentity` at every site. [user:decision-2026-07-23-v3]
- `src/stores/wiki-store.ts:296` — `MultimodalConfig` interface. Add new fields here. Store init defaults at line ~579. [git:blob]

## Metadata embedding module (Phase 3, added 2026-07-26)

- `src/lib/image-metadata-embed.ts` — pure byte-manipulation module, zero external deps. Exports `embedImageMetadata({ absPath, alt, title, mimeType }) → { written, format, error? }`. [git:blob]
- Supported formats: JPEG (APP1 XMP + APP13 IPTC IIM), PNG (iTXt + XMP chunk), WebP (VP8X + EXIF + XMP), SVG (`<metadata>` XMP + `<title>` + `<desc>`). [user:decision-2026-07-26]
- Explicitly excluded: RAW, BMP, GIF (user constraint). AVIF, HEIC, TIFF, ICO skipped (ISOBMFF complexity / niche). [user:decision-2026-07-26]
- Multi-vendor field duplication: same alt/title written to multiple metadata fields per format for maximum reader compatibility (e.g. JPEG gets `dc:description` + `dc:title` + `AltTextAccessibility` + IPTC `Caption-Abstract` + `Headline`). [user:decision-2026-07-26]
- PNG uses iTXt (UTF-8) exclusively, never `tEXt` (Latin-1 only, would corrupt CJK). [user:decision-2026-07-26]
- Idempotent: strips existing metadata blocks before inserting new ones. [git:blob]
- Integration point: Phase 3 loop in `localizeMarkdownImages`, after VLM captioning, before `savedImages` construction. Only runs for `vlmOutcome === "captioned" | "cache-hit"`. Non-fatal — errors counted in `stats.metadataSkipped`. [git:blob]
- `LocalizeResult.stats` gained `metadataEmbedded` and `metadataSkipped` counters. `ingest.ts` log line includes `meta-embed` count. [git:blob]
- `sha8OfBytes` export preserved in `markdown-image-localizer.ts` despite internal dedup to `sha256Hex` — tests import it directly (`markdown-image-localizer.test.ts:32`). [git:blob]

## Caches on disk

- Existing: `<project>/.llm-wiki/image-caption-cache.json` — SHA-256 → `{ caption, mimeType, model, capturedAt }`. New optional fields `title`, `originalUrl` added by Commit 2 are forward-compatible with old files. [git:blob]
- Existing: `<project>/.llm-wiki/ingest-cache.json` — `sourceIdentity → { hash, timestamp, filesWritten }`. No schema change; usage discipline changes (Commit 5 propagates `workingSourceContent` at 5 call sites; Commit 1 folds `localizeMarkdownImages` into the hash input). [git:blob]
- New: `<project>/.llm-wiki/image-url-cache.json` — URL → `{ sha256, mimeType, width, height, bytesLen, fetchedAt, canonicalRelPath }`. TTL 45 days. **Per-entry upsert**, not one big pipeline-end write, to keep the concurrent-ingest race window small. [plan:markdown-image-localizer.md]

## Design invariants (locked, do not revisit)

- **v3 decision matrix (§1 of plan)** is the specification of localizer per-image behavior. Two axes: URL kind (`remote-http` / `data-uri` / `local-relative` / `already-localized` / `unsupported`) × author `alt` (empty vs non-empty). VLM runs only when alt is empty AND image is over threshold AND classification is one of the three "I/O runs" cells. [user:decision-2026-07-23-v3]
- Two-form output: `LocalizeResult` returns both `rewrittenSourceMarkdown` (source-root-relative paths, for `raw/sources/`) and `rewrittenWikiMarkdown` (wiki-root-relative paths, for `wiki/sources/`). Neither can be computed from the other by string replace. [user:decision-2026-07-23-v3]
- Frontmatter `image_sources:` mapping carries entries only for `remote-http` and `data-uri` (truncated to 64 chars) URL kinds. Local-relative and already-localized get no entries. **Full-rewrite semantics** on each Step 0.4 run — user-deleted image references disappear from the mapping. [user:decision-2026-07-23-v3]
- Small images (<100px either dim) with empty alt download locally but skip VLM caption. Threshold is a **secondary** VLM gate — non-empty alt short-circuits VLM before the threshold is checked. [user:decision-2026-07-23]
- Two-tier cross-document caching. URL cache eliminates redundant HTTP; SHA cache eliminates redundant VLM. Author-alt-non-empty short-circuits both because VLM never runs. [user:decision-2026-07-23]
- Per-source directory storage (`wiki/media/<sourceSummarySlug>/`), not shared pool. Matches existing conventions and keeps `cascadeDeleteWikiPage` orphan-media reap logic unchanged. `sourceSummarySlug` is the SAME name across §4, §6 `LocalizeOptions`, and the `sourceSummarySlug` local var in `autoIngestImpl`. [user:decision-2026-07-23-v3]
- Filenames end with `-<sha8>.<ext>` where sha8 = first 8 hex chars of SHA-256. Doubles as idempotency marker. [plan:markdown-image-localizer.md]
- `already-localized` requires **three-step check**: resolve to absolute path → regex `/wiki/media/[^/]+/[^/]+-[0-9a-f]{8}\.[a-z0-9]+$/` on absolute path → `fileExists`. Missing file falls through to `local-relative`. [user:decision-2026-07-23-v3]
- URL cache TTL: 45 days. Configurable via `multimodalConfig.urlCacheTtlDays`. [user:decision-2026-07-23]
- 20 MB body size cap on image downloads. Content-Type must start with `image/`. **Content-Length preflight** rejects before body read when the header is present. Same 20 MB cap applies to decoded data URIs. [plan:markdown-image-localizer.md]
- Timeout: 30s (configurable via `multimodalConfig.imageFetchTimeoutMs`). CJK-locale networks need more headroom than 15s. [user:decision-2026-07-23-v3]
- Concurrency internalized: download pool = `min(4, multimodalConfig.concurrency)`; caption pool = `multimodalConfig.concurrency`; copyFile pool = unlimited. Not on public API. [user:decision-2026-07-23-review]
- Cache-key fingerprint folds in only the `localizeMarkdownImages` enable/disable toggle; `minImagePixelSize` and `urlCacheTtlDays` are NOT part of the fingerprint. [user:decision-2026-07-23-review]
- Step 0.4 placement: **before `checkIngestCache`**, uniform. Cache convergence via **`workingSourceContent` propagation across 5 call sites** in `autoIngestImpl` (see plan §8 table): 729 (checkIngestCache), 738 (remove `extractAndSaveMarkdownImages`), 767 (appendSavedImageRefsForCaption), 836 (remove `extractAndSaveMarkdownImages`), 1227 (saveIngestCache). [user:decision-2026-07-23-v3]
- Toggle `false` path is byte-identical to today's behavior — including that the legacy `extractAndSaveMarkdownImages` still runs. Test this in Commit 5 regression pass. [plan:markdown-image-localizer.md]
- Codex-CLI: downloads + copies + rewrites still run; caption step skipped; empty alt stays empty; `stats.captioned=0`. [user:decision-2026-07-23-review]
- Generator-side escape strategy: sanitize `"` → curly quote, `]` → `\]`, newlines → space. Never emit backslash-escaped quotes in generated output. Parser-side accepts both `"..."` and `'...'` title delimiters but does NOT unfold backslash-escapes (round-trip preservation only). [user:decision-2026-07-23-v3]

## Deferred to Phase 2 / 3

- Rust `image` crate features `jpeg,webp,gif` + `probe_and_resize_image_bytes` Tauri command (Phase 2). [plan:markdown-image-localizer.md]
- Settings > Multimodal UI panel for the new fields (Phase 3). [plan:markdown-image-localizer.md]
- Source-watch self-write suppression (currently accepted as one redundant activity-panel entry on first localize) (Phase 3). [user:decision-2026-07-23-review]
- Per-image "re-caption anyway" UI button for author-alt-preserved images (Phase 3). [user:decision-2026-07-23-v3]
- HTML `<img>`, reference-style images, SVG dimension probing (never). [plan:markdown-image-localizer.md]

## Working conventions used this session

- Small commits, one per concern (5 commits planned for Phase 1). [user:profile]
- Doc-only revisions land as a single commit before code (this branch already has `c696737` for v2; a v3 commit follows). [user:decision-2026-07-23-review]
- Design reviews follow the `design-doc-review` skill's tiered contract (CRITICAL/WORTH/SMALL/DEFER) with a mandatory `clarify` before implementation. [user:profile]
