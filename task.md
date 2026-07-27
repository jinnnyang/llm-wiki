---
kind: task
last_updated: '2026-07-27T01:09:15+00:00'
last_writer: hand-off
last_agent: hermes-agent
session_id: hermes-default
last_verified: '2026-07-27T01:09:15+00:00'
---

# Task — markdown image localizer (Phase 1)

**Branch:** `feat/markdown-image-localizer` (based on `e8bdec6`, upstream v0.6.5 tip)
**Overall status:** All 5 planned commits done. Code review fixes + Phase 3 metadata embedding landed. Second code review found and fixed 4 bugs in metadata embedder + ingest cache-hit path.

## Reference documents

```
plans/markdown-image-localizer.md   ← spec v3
```

Plan doc has full design details (§1-12), test matrix (34 cases across 6 groups), risk register (12 items), and verification checklist.

## Post-review key decisions

### From v2 revision (2026-07-23 morning)

- **Master toggle** `localizeMarkdownImages: boolean` gates the entire Step 0.4 hook.
- **Frontmatter `image_sources:` mapping** (originally Phase 3, promoted to Phase 1) carries traceability for remote/data-URI images without polluting the body.
- **Concurrency is internal to the localizer.** Download pool = `min(4, mmCfg.concurrency)`; caption pool = `mmCfg.concurrency`. No public API surface.
- **Codex-CLI:** downloads + rewrites still run; caption step skipped; alt stays original.

### From v3 revision (2026-07-23 afternoon)

- **Two-axis decision matrix (§1 of plan):** URL kind × author alt. VLM runs only when alt is empty (and image is over threshold, on a captionable URL kind). Non-empty author alt is preserved verbatim — accessibility work belongs to the author.
- **Two-form body output:** `LocalizeResult` returns both `rewrittenSourceMarkdown` (source-root-relative, e.g. `<source-root>/wiki/media/…`) and `rewrittenWikiMarkdown` (wiki-root-relative, e.g. `<wiki-root>/media/…`). Neither can be derived from the other.
- **Cache convergence via `workingSourceContent` propagation.** The v2 "Step 8a rebind" idea had a hole on the cold-start path. v3 replaces it with propagating `workingSourceContent` through 5 downstream call sites in `autoIngestImpl` — every hash computation uses the current on-disk state.
- **`extractAndSaveMarkdownImages` skipped when localizer enabled.** Local-relative paths now flow through the localizer's own copy path, gaining VLM captioning as a bonus.
- **`already-localized` uses 3-step check** (resolve → regex → exists) against the absolute path form.
- **Frontmatter lifecycle:** full-rewrite semantics on every Step 0.4 run. Remote and data-URI entries only; data URI value truncated to 64 chars + `…`.
- **30s timeout, Content-Length preflight, `isInsideProject` path-traversal defense.**

## Commit plan (execute in order)

### [x] Commit 1 — MultimodalConfig schema + cache fingerprint

Files:

```
src/stores/wiki-store.ts
src/lib/ingest-cache.ts
src/lib/ingest-cache.test.ts
```

Add to `MultimodalConfig`:

- `localizeMarkdownImages: boolean` (default `true`)
- `minImagePixelSize: number` (default `100`)
- `urlCacheTtlDays: number` (default `45`)
- `imageFetchTimeoutMs: number` (default `30_000`)

Extend `ingest-cache.ts` sha256 input with the fingerprint suffix (see plan §8 "Cache-key composition"). Add tests: (a) hit when field unchanged, (b) miss when field flips, (c) miss when source content changes.

Verify: `npm run typecheck` + `ingest-cache.test.ts` green.

### [x] Commit 2 — CaptionEntry optional fields

File:

```
src/lib/image-caption-pipeline.ts
```

Add optional `title?: string`, `originalUrl?: string` to `CaptionEntry`. Forward-compat with pre-existing cache files.

Verify: `npm run test` — existing 21 caption-pipeline cases must stay green.

### [x] Commit 3 — Localizer core plumbing (no VLM yet)

Files:

```
src/lib/markdown-image-localizer.ts
src/lib/markdown-image-localizer.test.ts
```

Scope (I/O layer only, no policy):

- `MD_IMAGE_RE_WITH_TITLE` regex + parser side
- `classifyImageUrl` with 3-step `already-localized` check on resolved absolute path
- `resolveLocalRelative` w/ `isInsideProject` path-traversal defense (reuse from `markdown-image-resolver.ts:50`)
- URL cache with per-entry upsert
- HTTP download with SSRF reuse + Content-Length preflight + 30s timeout + 20MB body cap
- `copyFile` local path
- `resolveDataUri` with truncation for frontmatter
- SHA-256 dedup, canonical file write
- `createImageBitmap` dimension probe (mockable)

Tests (plan §Testing Groups A, D, E): 1-2, 14-23.

Verify: new module tests all green (17 tests).

### [x] Commit 4 — Localizer decision matrix + VLM + rewrite + frontmatter

Extend the same two files with:

- §1 decision-matrix axis-B gating (VLM only when alt empty)
- `captionImage` integration (with codex-cli fallback)
- Two-form body rewrite: both `rewrittenSourceMarkdown` and `rewrittenWikiMarkdown` outputs via §7 regex + §4 relative-path helper
- Frontmatter merge via `parseFrontmatter` per §11 lifecycle rules (full-rewrite; remote/data-URI only; data URI value truncated)
- Generator-side escape (curly quote for `"`, `\]` for `]`, newline → space)
- Idempotency marker parsing (already covered by §5 3-step check from Commit 3, but tests here confirm end-to-end)

Tests (plan §Testing Groups B, C, F + integration): 3-13, 24-34.

Verify: all 34 new module tests green.

### [x] Commit 5 — autoIngestImpl integration + workingSourceContent propagation

File:

```
src/lib/ingest.ts
```

Add Step 0.4 hook after source-read (~line 710). Then propagate `workingSourceContent` across the 5 call sites per plan §8 table:

| Line | Change |
|---|---|
| 729 | `checkIngestCache(pp, sourceIdentity, workingSourceContent)` |
| 738 | Skip `extractAndSaveMarkdownImages` when `mmCfg.localizeMarkdownImages` |
| 767 | `appendSavedImageRefsForCaption(workingSourceContent, savedImages)` |
| 836 | Skip `extractAndSaveMarkdownImages` when `mmCfg.localizeMarkdownImages` |
| 1227 | `saveIngestCache(pp, sourceIdentity, workingSourceContent, writtenPaths)` |

Also wire `result.rewrittenWikiMarkdown` into the wiki-page seeder (candidate: `ingest.ts:~1000` where the LLM generation prompt is assembled — audit at commit time).

Grep-audit: `grep -n sourceContent src/lib/ingest.ts` after the edits; every post-Step-0.4 reference must be intentional.

Verify: full `npm run test` + smoke ingest a fixture md file exercising all 4 decision-matrix cells (per plan §Testing "Integration (manual smoke)"). Confirm second ingest is a cache-hit no-op.

## Post-plan work (2026-07-26)

### [x] Code review fixes (commit `2182625`)

- H1: CRLF offset in `findImageSourcesBlockInYaml` — regex now preserves `\r\n` separator length.
- H3: `AbortSignal.any` fallback — manual `AbortController` composition when unavailable.
- M1: removed duplicate `sha256OfBytesFull`, unified on `sha256Hex`.
- M2: single SHA-256 per image, `sha8 = sha256.slice(0, 8)`.

### [x] Phase 3 — metadata embedding (commit `3cda623`)

New module `src/lib/image-metadata-embed.ts` + 15 tests. Writes VLM alt/title into image file metadata:

- JPEG: APP1 XMP + APP13 IPTC IIM
- PNG: iTXt chunks + XMP standard chunk
- WebP: VP8X + EXIF + XMP chunks
- SVG: `<metadata>` XMP RDF/XML + `<title>` + `<desc>`

Integrated as Phase 3 loop in `localizeMarkdownImages` (after VLM captioning, before `savedImages` construction). Non-fatal. `ingest.ts` log gains `meta-embed` counter.

### [x] Second code review — bug fixes (2026-07-26, uncommitted)

Full review of the branch (~7,300 lines, 21 files). Found and fixed 4 bugs + 1 pre-existing type error:

1. **EXIF TIFF offset error** (`image-metadata-embed.ts:618`): `off += 4` after a 2-byte `setUint16` write → IFD entry 14 bytes instead of 12, corrupting all WebP EXIF metadata. Fixed: `off += 2`.
2. **IPTC IIM buffer underallocation** (`image-metadata-embed.ts:216`): `nameLen = 1` but code writes 2 bytes (Pascal string count + pad). Fixed: `nameLen = 2`.
3. **SVG with XML declaration silently skipped** (`image-metadata-embed.ts:509`): `indexOf(">")` hit `<?xml?>` closing, regex failed. Fixed: `search(/<svg[\s>]/i)` + `indexOf(">", svgTagStart)`.
4. **Cache-hit branch drops localized images** (`ingest.ts:860`): missing `else { savedImages = [...savedImages, ...markdownLocalizedImages] }` — re-ingest lost all localized images. Fixed.
5. **Pre-existing type error** (`image-metadata-embed.test.ts:134`): mock didn't satisfy `FileBase64` interface. Fixed: added `mimeType`, removed extraneous `path`.

Verification: `npm run typecheck` clean, `npm run build` clean, 158/158 localizer+metadata tests pass, full suite 1877 pass (6 pre-existing env failures unchanged).

## Open review items (not yet addressed)

- **H2:** `localizeMarkdownImages` defaults to `true` in `wiki-store.ts:609` — product decision needed on whether to default `false` or add first-run prompt.
- **M3:** caption cache batch write vs URL cache per-entry write inconsistency.
- **M4:** `classifyImageUrl` could return parsed result to avoid duplicate `resolveLocalRelative`.
- **M5:** `readBodyWithLimit` fallback buffers fully before size check.
- **M6:** no integration-layer unit tests for `ingest.ts` Step 0.4 hook.

## Non-goals (Phase 2 / 3)

- Rust `image` crate features (jpeg/webp/gif) + `probe_and_resize_image_bytes` command — Phase 2
- Settings UI panel for the new config fields — Phase 3
- Source-watch self-write suppression (currently accepted as a redundant activity-panel entry on first ingest) — Phase 3
- Per-image "re-caption anyway" button for author-alt-preserved images — Phase 3
- `.md.bak` backup — deferred, likely unnecessary given raw-sources is already a copy
- HTML `<img>` support, reference-style images, SVG dimension sniffing — deferred
