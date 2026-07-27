---
kind: walkthrough
last_updated: '2026-07-27T01:09:35+00:00'
last_writer: hand-off
last_agent: hermes-agent
session_id: hermes-default
last_verified: '2026-07-27T01:09:25+00:00'
---

# Walkthrough — llm-wiki

## 2026-07-26 (evening) — Second code review: 4 bugs fixed in metadata embedder + ingest

<!-- keep -->

### Session arc

1. **User requested full code review** of the `feat/markdown-image-localizer` branch — "请你评审当前代码修改，仔细排查所有BUG与隐患".
2. **Reviewed ~7,300 lines across 21 files** (git diff main). Read every changed source file line-by-line: `markdown-image-localizer.ts` (2,112 lines), `image-metadata-embed.ts` (709 lines), `ingest.ts` diff (+156 lines), plus 6 smaller changed files.
3. **Ran verification baseline**: `npx tsc --noEmit` clean, `npx vitest run` → 1,877 pass / 6 fail (all pre-existing: MCP server tests + real-TCP CORS env issues).
4. **Found 4 bugs + 1 pre-existing type error**, ordered by severity:
   - **BUG 1 (CRITICAL)** — `image-metadata-embed.ts:618`: EXIF TIFF builder `buildExifTiff` wrote `view.setUint16(off, 4, true); off += 4` — a 2-byte write advancing the offset by 4. IFD entry became 14 bytes instead of 12, shifting all subsequent fields. `exifIfdOffset` pointed 2 bytes before the actual ExifIFD → WebP EXIF metadata silently corrupt. Fix: `off += 2`.
   - **BUG 2 (MEDIUM)** — `image-metadata-embed.ts:216`: IPTC IIM builder `buildIptcIim` set `nameLen = 1` but the code writes 2 bytes (Pascal string count byte + pad byte at lines 233-234). Buffer underallocated by 1; when `iimTotal` is odd, the padding math produces a buffer 2 bytes too short → `Uint8Array.set()` silently truncates the last IIM record. Fix: `nameLen = 2`.
   - **BUG 3 (MEDIUM)** — `image-metadata-embed.ts:509`: `embedSvg` used `text.indexOf(">")` to find the `<svg>` tag end. SVGs with `<?xml version="1.0"?>` declarations hit the `?>` closing bracket instead; the subsequent `/<svg[\s>]/i` regex failed on the XML prolog → function returned `null`, metadata embedding silently skipped. Fix: `text.search(/<svg[\s>]/i)` to locate the tag start, then `text.indexOf(">", svgTagStart)` for the closing bracket.
   - **BUG 4 (MEDIUM)** — `ingest.ts:860`: cache-hit branch skipped `extractAndSaveMarkdownImages` when localizer enabled (correct) but never added `markdownLocalizedImages` to `savedImages`. The full-pipeline branch (line 964) had the correct `else` clause. Result: first ingest worked; second ingest (cache hit, e.g. source-watch re-trigger) lost all localized images from downstream caption + source-summary injection. Fix: added matching `else { savedImages = [...savedImages, ...markdownLocalizedImages] }`.
   - **Pre-existing type error** — `image-metadata-embed.test.ts:134`: mock resolved `{ base64, path }` but `FileBase64` interface requires `{ base64, mimeType }`. Fix: replaced `path` with `mimeType: "image/png"`.
5. **Also identified 4 non-bug observations** (code hygiene / product, not fixed):
   - `sha8OfBytes` exported but unused in production (tests import it directly).
   - `bytesToBase64` duplicated across two modules.
   - `localizeMarkdownImages` defaults to `true` — open product decision (H2).
   - `findImageSourcesBlockInYaml` KV regex can't handle escaped quotes in foreign entries.
6. **User said "开始修复"** — applied all 5 fixes across 3 files.
7. **Verification**: `npm run typecheck` clean (0 errors), `npm run build` clean (23.26s), `npx vitest run` → 1,877 pass / 6 fail (same pre-existing set), 158/158 localizer+metadata tests pass.

### Files touched this session

Uncommitted (ready to commit):

```
src/lib/image-metadata-embed.ts       ← BUG 1 + BUG 2 + BUG 3
src/lib/ingest.ts                     ← BUG 4
src/lib/image-metadata-embed.test.ts  ← pre-existing type error
```

Working tree also carries pre-existing `M package-lock.json` and untracked `CLAUDE.md`.

### Key decisions

- All 4 bugs were implementation errors, not design flaws. The module architecture (pure byte manipulation, format dispatch, non-fatal error handling) is sound.
- BUG 1 was the most severe: every WebP image that went through Phase 3 metadata embedding had corrupt EXIF. XMP and IPTC were unaffected (different code paths).
- BUG 4 was a copy-paste omission between the two ingest branches (cache-hit vs full-pipeline). The full-pipeline branch was correct; the cache-hit branch was missing the `else` clause.

### Open items for next session

- **Commit the 3 modified files** (user hasn't decided on commit message yet).
- H2: product decision on `localizeMarkdownImages` default value.
- M3-M6: medium-priority review items (see task.md "Open review items").
- Settings UI for new config fields (Phase 3).


## 2026-07-26 — Code review fixes + Phase 3 metadata embedding

<!-- keep -->

### Session arc

1. **Code review of `feat/markdown-image-localizer` branch** — full review of the 10-commit, +4639/−23 line branch. Produced tiered findings: H1-H3 (high), M1-M6 (medium), L1-L6 (low).
2. **Fixed H1/H3/M1/M2** (commit `2182625`):
   - H1: `findImageSourcesBlockInYaml` used `split(/\r?\n/)` + `line.length + 1`, which undercounts by 1 byte per CRLF line. Fixed with a regex that captures the actual separator (`\r\n` vs `\n`) and adds its real length.
   - H3: `fetchRemoteImage` composed timeout + caller signals via `AbortSignal.any`, but silently dropped the caller signal when `AbortSignal.any` is unavailable (older runtimes). Fixed with a manual `AbortController` + dual `abort` listener composition.
   - M1: deleted duplicate `sha256OfBytesFull` (identical to `sha256Hex`). Kept `sha8OfBytes` export because tests import it directly.
   - M2: three handlers (`handleRemoteHttp`, `handleDataUri`, `handleLocalRelative`) each called `crypto.subtle.digest` twice (once for sha8, once for full sha256). Unified to single `sha256Hex` + `slice(0, 8)`.
3. **User requested metadata embedding feature** — write VLM-generated alt/title into the image file's own metadata after download + captioning. Constraints: no RAW/BMP/GIF; multi-vendor field duplication for compatibility.
4. **Implemented `src/lib/image-metadata-embed.ts`** (710 lines, pure byte manipulation, zero external deps):
   - JPEG: APP1 XMP (`dc:description`, `dc:title`, `Iptc4xmpExt:AltTextAccessibility`) + APP13 IPTC IIM (`Caption-Abstract`, `Headline` via 8BIM wrapper).
   - PNG: iTXt chunks (`Description`, `Title`, `AltTextAccessibility`) + standard XMP chunk (`XML:com.adobe.xmp`). Full UTF-8 — no Latin-1 `tEXt`.
   - WebP: auto-synthesized/updated VP8X flags + EXIF chunk (TIFF `ImageDescription` + `UserComment` UNICODE) + XMP chunk.
   - SVG: `<metadata>` with XMP RDF/XML + `<title>` + `<desc>` elements.
   - All formats: idempotent (strips existing metadata blocks before inserting new ones).
5. **15 unit tests** (`image-metadata-embed.test.ts`) covering all 4 formats, Chinese text, idempotency, unsupported formats, I/O error isolation.
6. **Phase 3 integration** into `localizeMarkdownImages`: loop after VLM captioning, only for `captioned`/`cache-hit` images. Non-fatal — failures count in `stats.metadataSkipped`. `ingest.ts` log gains `meta-embed` counter.
7. **Committed as two separate commits** per user request:
   - `2182625` — review fixes (H1/H3/M1/M2)
   - `3cda623` — Phase 3 metadata embedding (4 files, +1181/−1)
8. **Verification:** `npx tsc --noEmit` clean. 4 test files, 158/158 tests passing (143 pre-existing + 15 new).

### Files touched this session

Committed:

```
2182625 fix(localizer): code review fixes
  src/lib/markdown-image-localizer.ts

3cda623 feat(localizer): Phase 3 — embed VLM alt/title into image file metadata
  src/lib/image-metadata-embed.ts       (new, 710 lines)
  src/lib/image-metadata-embed.test.ts  (new, 436 lines)
  src/lib/markdown-image-localizer.ts   (Phase 3 integration)
  src/lib/ingest.ts                     (log counter)
```

Working tree still carries pre-existing `M package-lock.json` and untracked `CLAUDE.md`.

### Key decisions

- Metadata embedding is Phase 3 of the localizer pipeline (after Phase 1 download, Phase 2 VLM caption).
- Only `captioned` and `cache-hit` images get metadata — `already-localized` and failed images are skipped.
- Non-fatal by design: `embedImageMetadata` catches all errors internally, returns `{ written: false }`.
- `sha8OfBytes` export preserved despite internal dedup — tests import it directly.
- H2 (default `true` for `localizeMarkdownImages`) left as open product decision.

### Open items for next session

- H2: product decision on `localizeMarkdownImages` default value.
- M3-M6: medium-priority review items (see task.md "Open review items").
- Settings UI for new config fields (Phase 3 non-goal).

## 2026-07-23 (afternoon) — Plan v3: respect existing alt/title + review-round-2 fixes

<!-- keep -->

Second design review pass on `plans/markdown-image-localizer.md` (using `design-doc-review` skill's tiered contract). Findings: 3 CRITICAL, 4 WORTH, 5 SMALL, 3 DEFER.

**User raised a new concern** in parallel: v2 spec silently assumed every markdown image needs VLM captioning. That would overwrite accessibility work already done by the doc author. Two-axis model designed in response:

- Axis A: URL kind (`remote-http` / `data-uri` / `local-relative` / `already-localized` / `unsupported`) → drives I/O choice (download / decode / copyFile / no-op)
- Axis B: author `alt` empty vs non-empty → drives VLM choice (run / skip)

This is now §1 of plan v3 as the "decision matrix" table.

**CRITICAL fixes landed:**

1. **Cache chain break on cold start (v2 bug)** — v2's Step 8a rebind claimed idempotency but only rebound on the cache-hit branch. Cold start left line-1227 `saveIngestCache` binding the old `sourceContent` hash while disk held the new content, so source-watch reenqueue thrashed a full second pipeline. v3 fix: propagate `workingSourceContent` across 5 call sites in `autoIngestImpl` (lines 729, 738, 767, 836, 1227). See plan §8 "Unified propagation".
2. **Path asymmetry between raw/sources and wiki/sources** — v2 said "one output body, use `toWikiRelPath` if needed". Wrong: `../../wiki/media/` vs `../media/` differ by depth, can't be derived by string replace. v3 fix: `LocalizeResult` returns both `rewrittenSourceMarkdown` and `rewrittenWikiMarkdown`, generated together from the same `SavedImage[]`.
3. **Name unification** — `sourceIdentity` (ingest.ts local var) vs `sourceFileName` (ingest-cache.ts parameter) vs `sourceSummarySlug` (LocalizeOptions field). v3 fix: `ingest-cache.ts` parameter stays `sourceFileName` (historical name, do not rename); ingest-side var stays `sourceIdentity` at every call site; slug used across §4/§6/§8 is `sourceSummarySlug` uniformly.

**WORTH fixes landed:**

- Already-localized check upgraded from 2-step to 3-step (resolve → regex → exists on absolute path form) to be safe across raw/sources vs wiki/sources relative-path forms.
- `image_sources:` frontmatter lifecycle: full-rewrite semantics per Step 0.4 run, remote and data-URI only, data URI value truncated to 64 chars + `…`.
- Quote escape contract split into generator-strict (curly quote, `\]`, no backslash escapes) vs parser-permissive (accepts both quote styles, no unfolding).
- `extractAndSaveMarkdownImages` explicitly skipped in ingest.ts (~738 and ~836) when localizer is enabled — its work becomes the localizer's `local-relative` classification, with the bonus of VLM captioning empty-alt local images.

**SMALL fixes landed:**

- Timeout 15s → 30s (CJK-network headroom), configurable via new `imageFetchTimeoutMs` field.
- Content-Length response-header preflight added before body read.
- Reused `isInsideProject` from `markdown-image-resolver.ts:50` for path-traversal defense (no new `fs-guards.ts`).
- Test list restructured into 6 groups (A regex+class, B VLM gating, C frontmatter, D caching, E network defense, F concurrency+escape) + integration group. Total 34 test cases up from 21.
- Risk register grew by 3 entries (rows 10-12) covering author-alt-placeholder edge case, two-form-output miswire, and workingSourceContent audit.

Deliverable: plan.md, context.md, task.md all updated. Zero code touched. Single doc-only commit follows the v2 doc-only pattern (`c696737` was v2's revision commit).

## 2026-07-23 (morning) — Markdown image localizer: spec + branch cut

<!-- keep -->

### Session arc

1. **Repo state check** — verified GitNexus indexes both `MediaCrawler` and `llm-wiki`; llm-wiki index was 49 commits stale.
2. **Remote check** — `origin` had 0 new commits on `main`, but nashsu/llm_wiki upstream had 30 new commits including releases v0.6.4 and v0.6.5.
3. **Upstream sync (option B)** — updated the `origin/upstream` tracking branch to `e8bdec6` (nashsu/main head). Local `main` untouched.
4. **Merge into main** — user asked to merge upstream → main. Stashed working-tree modifications to avoid conflict with v0.6.4/v0.6.5 lockfile changes. `git merge --no-ff upstream` succeeded no-conflict (105 files, +6257/-1034). Stash pop auto-3-way-merged package-lock, clean.
5. **User asked why 31 commits ahead of origin/main** — explained `--no-ff` created an extra merge commit. Reset to `upstream` tip via `git reset --keep upstream` (safer than `--hard`, preserves working tree). Now 30 commits ahead.
6. **GitNexus re-index** — ran `gitnexus analyze .` in background. Incremental: 128 changed / 42 added / 2 deleted. Result: 6,696 nodes, 17,677 edges, 456 communities. 60.7s.
7. **User investigation** — asked how llm-wiki handles markdown image/media references and whether there's a cleaning step. Traced the pipeline via GitNexus + code reads. Found: no dedicated cleaning; images are physically extracted from binaries (PDF/DOCX via Rust image-extraction code), remote images in md pass through untouched; VLM captions land in alt-text at ingest time; embedding stage keeps image markdown syntax verbatim so alt-text becomes search signal.
8. **User feature request** — for markdown inputs with `![alt](url "title")`, download remote images, VLM-caption, rewrite md to add accessibility metadata, prevent link rot.
9. **Feasibility analysis** — reported 70% infrastructure already exists (findImageReferences, MD_IMAGE_RE, captionImage, SHA-256 cache, fetchImportUrl with SSRF defense, writeFileBase64, safeSlug). Only new work: HTTP download + local rewrite + optional pre-VLM resize + config knobs.
10. **Initial design (v1)** — three-mode rewrite: `never` / `alt-title-only` (default) / `full`, two-tier cache (URL → SHA + SHA → caption), per-source media directory, 45-day TTL, `-<sha8>` idempotency marker.
11. **Branch cut** — `feat/markdown-image-localizer` from `e8bdec6`.
12. **Plan doc v1 written** — 5-commit plan, 20-test unit test list, 8-risk register, Phase 2/3 deferred items.

## 2026-07-23 — Post design review: simplify to single toggle

<!-- keep -->

### Session arc

1. **Design review via `design-doc-review` skill** — five-pass scan over `plans/markdown-image-localizer.md` + scope files. Produced tiered findings: 3 CRITICAL / 8 WORTH / 6 SMALL / 7 DEFER.
2. **User challenged framing** — asked me to explain the 3 CRITICALs in natural language without special notation. Explained they all stemmed from the "改写用户源文件" mental model + cache-key composition being too shallow.
3. **User reframed the problem** — "`raw/sources/` 就是 llm-wiki 对用户导入的副本" — the app can freely modify this copy; the user's real original is never touched. This dissolved most of the "surprise the user" concerns.
4. **Verified reframing against code** — confirmed `importSourceFiles` (`source-lifecycle.ts:262`) always `copyFile`s into `raw/sources/`, `importSourceUrls` always `writeFile`s into it, source-watch treats it as an app-managed area. The reframe is factually correct.
5. **User proposed cache-key update pattern** — instead of watching hashes flap, update the cache key to the new hash right when the localizer rewrites the copy. Formally: `saveIngestCache(pp, sourceIdentity, workingSourceContent, filesWritten)` immediately after `writeFile(sp, localized)`.
6. **User asked to simplify further** — "简化，如无必要，勿增实体". Adopted:
   - Collapse three modes → single boolean toggle `localizeMarkdownImages: boolean` (default true).
   - Frontmatter `image_sources:` mapping (originally Phase 3) promoted to Phase 1 to carry traceability.
   - Uniform Step 0.4 placement (before `checkIngestCache`, no cache-hit special branch).
   - Cache fingerprint composition folds `localizeMarkdownImages` into the hashed material (2-line change in `ingest-cache.ts`).
   - Concurrency internal to the localizer (download pool = `min(4, mmCfg.concurrency)`, caption pool = `mmCfg.concurrency`); no public API surface.
7. **Locked design decisions** — captured in the revised plan doc as §1–§12. Original 4 CRITICALs collapsed into one coherent mechanism (Step 8a rebind + fingerprint). W1/W2 dissolved with single-toggle. W3/W4/W5/W7 folded into plan body. W8 (source-watch reenqueue) demoted to a documented visible side effect — activity panel shows one extra ingest entry on first localize, cache-hit no-op.
8. **Doc-only commit** — `c696737 docs(handoff): revise plan post design review`. 2 files changed, +250 / -135. Zero code touched.

### Files touched this session

Modified (committed in `c696737`):

```
plans/markdown-image-localizer.md
task.md
```

Working tree still carries pre-existing (not from this session's work) `M package-lock.json` and untracked `CLAUDE.md`.

### Key decisions from this review round

- `raw/sources/` is treated as an app-managed copy — mutating it is not the same as mutating user input.
- One toggle, not three modes.
- Frontmatter `image_sources:` mapping carries traceability; body of the copy is fully localized.
- Cache convergence via `saveIngestCache(pp, id, workingSourceContent, filesWritten)` right after the localizer writes the copy.
- Cache fingerprint = `hash(content + "\n\n---cache-fingerprint---\nlocalize=" + (enabled?1:0))`.
- Step 0.4 placement: before `checkIngestCache`, uniform, no branching by cache state.
- Concurrency internalized.

### Not started

No code files touched by either session. All 5 planned commits still pending.

### Key context files for next session

```
plans/markdown-image-localizer.md   (revised)
plans/multimodal-images.md          (predecessor)
task.md                             (revised commit plan)
context.md                          (invariants)
```
