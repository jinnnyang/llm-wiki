---
kind: context
last_updated: '2026-07-23T02:20:04+00:00'
last_writer: hand-off
last_agent: hermes-agent
session_id: session-2026-07-23-mdimg-review
last_verified: '2026-07-23T02:20:04+00:00'
---

# Context — llm-wiki

Session-independent invariants for the `feat/markdown-image-localizer` work.

## Repository facts

- Repo root: `C:\Users\jinnn\Documents\llm-wiki` [git:origin]
- Fork of `nashsu/llm_wiki` (upstream). Working branch `main` mirrors `origin/main`; `upstream` branch mirrors `nashsu/main`. [git:remote]
- Layout convention: `main` is rolling mirror of `origin/main` which may be ahead of `origin/upstream` (fork sometimes pulls community PRs before upstream releases them). Currently `main` = `upstream` = `e8bdec6` (v0.6.5 tip). [git:log]
- Active feature branch: `feat/markdown-image-localizer`, cut from `e8bdec6`. Head is now `c696737` after the doc-only revision commit. [git:branch]
- Package manager: npm. Verify commands: `npm run test`, `npm run typecheck`, `npm run build`. [user:workspace-snapshot]
- Test framework: vitest. [git:package.json]
- Node 24.15.0, TypeScript strict. [user:profile]

## Toolchain state at session end

- GitNexus index: current as of `c2f626d` (a merge commit that got reset). After the reset to `e8bdec6`, index has 6,696 nodes / 17,677 edges / 456 communities. Contents match `e8bdec6` because tree was byte-identical to the merge commit. [test:gitnexus-analyze-log]
- Working tree carries two files that predate this session and should not be assumed as this session's changes: `M package-lock.json` and untracked `CLAUDE.md`. [git:status]

## Framing invariants (locked, from post-review round)

- `raw/sources/` is an **llm-wiki-managed copy** of the imported material, not the user's real original input. `importSourceFiles` (`source-lifecycle.ts:262`) explicitly `copyFile`s external files into it; `importSourceUrls` writes URL captures into it. Modifying the copy is not modifying user input. [user:decision-2026-07-23-review]
- Traceability from a localized image back to its source URL lives in **frontmatter `image_sources:` mapping**, not in the raw markdown body. [user:decision-2026-07-23-review]
- Single toggle `multimodalConfig.localizeMarkdownImages: boolean` (default `true`). No three-mode design. [user:decision-2026-07-23-review]

## Image pipeline landmarks (predecessor v0.6.4 work)

- `src/lib/image-caption-pipeline.ts:283` — `captionMarkdownImages`, the VLM caption orchestrator. [git:blob]
- `src/lib/image-caption-pipeline.ts:141` — `MD_IMAGE_RE`. Does NOT capture `"title"`; splits url at whitespace. Do not modify — the new module ships an extended regex `MD_IMAGE_RE_WITH_TITLE` alongside it. [git:blob]
- `src/lib/vision-caption.ts` — `captionImage(imageBase64, mediaType, llmConfig, signal, options)`. Codex-CLI transport is a no-op (early return). Line number to be confirmed in Commit 3. [git:blob]
- `src/lib/extract-source-images.ts:200` — `extractAndSaveMarkdownImages` handles **local relative** md image refs today. Do NOT overlap; the new localizer handles remote/data only. [git:blob]
- `src/lib/url-source-import.ts:86` — `fetchImportUrl` with SSRF/private-network/redirect defenses. Reuse verbatim. [git:blob]
- `src/lib/tauri-fetch.ts:41` — `getHttpFetch` wrapper. [git:blob]
- `src/commands/fs.ts` — `writeFileBase64(path, base64)` → Rust `write_file_base64`. Line number to be confirmed in Commit 3. [git:blob]
- `src/lib/frontmatter.ts:37` — `parseFrontmatter(content) → { frontmatter, body, rawBlock }`. Round-trips untouched YAML via `rawBlock`. Reuse for `image_sources:` mapping merge. [git:blob]
- `src/lib/ingest-cache.ts:61` — `checkIngestCache(projectPath, sourceIdentity, sourceContent) → filesWritten | null`. Validates file existence on hit. [git:blob]
- `src/lib/ingest-cache.ts:98` — `saveIngestCache(projectPath, sourceIdentity, sourceContent, filesWritten)`. **This is the "Step 8a rebind" entry point** — call it after the localizer rewrites the copy so source-watch reenqueue becomes an I/O-free cache hit. [user:decision-2026-07-23-review]
- `src/lib/ingest.ts:637` — `autoIngestImpl`. Step 0.4 hook goes after source read (line ~710), **before** cache check (line ~729). Uniform placement — no cache-hit special branch. [git:blob]
- `src/stores/wiki-store.ts:296` — `MultimodalConfig` interface. Add new fields here. Store init defaults at line ~579. [git:blob]

## Caches on disk

- Existing: `<project>/.llm-wiki/image-caption-cache.json` — SHA-256 → `{ caption, mimeType, model, capturedAt }`. New optional fields `title`, `originalUrl` added by Commit 2 are forward-compatible with old files. [git:blob]
- Existing: `<project>/.llm-wiki/ingest-cache.json` — `sourceIdentity → { hash, timestamp, filesWritten }`. No schema change; usage discipline changes (Step 8a rebind after localize; hash input folds in `localizeMarkdownImages` fingerprint). [git:blob]
- New: `<project>/.llm-wiki/image-url-cache.json` — URL → `{ sha256, mimeType, width, height, bytesLen, fetchedAt, canonicalRelPath }`. TTL 45 days. **Per-entry upsert**, not one big pipeline-end write, to keep the concurrent-ingest race window small. [plan:markdown-image-localizer.md]

## Design invariants (locked, do not revisit)

- Single toggle `localizeMarkdownImages: boolean` for the raw-sources rewrite. No three-mode design. [user:decision-2026-07-23-review]
- Frontmatter `image_sources:` mapping in the raw-sources copy carries `local_path → original_url` for traceability. [user:decision-2026-07-23-review]
- Small images (<100px either dim) download locally but skip VLM caption. [user:decision-2026-07-23]
- Two-tier cross-document caching. URL cache eliminates redundant HTTP; SHA cache eliminates redundant VLM. [user:decision-2026-07-23]
- Per-source directory storage (`wiki/media/<slug>/`), not shared pool. Matches existing conventions and keeps `cascadeDeleteWikiPage` orphan-media reap logic unchanged. [user:decision-2026-07-23]
- Filenames end with `-<sha8>.<ext>` where sha8 = first 8 hex chars of SHA-256. Doubles as idempotency marker. [plan:markdown-image-localizer.md]
- `already-localized` requires **two-step check**: regex-on-path + `fileExists`. Missing file falls through to `local-relative`. [user:decision-2026-07-23-review]
- URL cache TTL: 45 days (user override, default was 30). [user:decision-2026-07-23]
- 20 MB body size cap on image downloads. Content-Type must start with `image/`. Same cap applies to decoded data URIs. [plan:markdown-image-localizer.md]
- Concurrency internalized: download pool = `min(4, multimodalConfig.concurrency)`; caption pool = `multimodalConfig.concurrency`. Not on public API. [user:decision-2026-07-23-review]
- Cache-key fingerprint folds in only the `localizeMarkdownImages` enable/disable toggle; `minImagePixelSize` and `urlCacheTtlDays` are NOT part of the fingerprint. [user:decision-2026-07-23-review]
- Step 0.4 placement: **before `checkIngestCache`**, uniform. Cache convergence via Step 8a rebind (`saveIngestCache(pp, id, workingSourceContent, cachedFiles)` immediately after `writeFile(sp, localized)`). [user:decision-2026-07-23-review]
- Toggle `false` path is byte-identical to today's behavior. Test this in Commit 5 regression pass. [plan:markdown-image-localizer.md]
- Codex-CLI: downloads + rewrites still run; caption step skipped; alt stays original; `stats.captioned=0`. [user:decision-2026-07-23-review]

## Deferred to Phase 2 / 3

- Rust `image` crate features `jpeg,webp,gif` + `probe_and_resize_image_bytes` Tauri command (Phase 2). [plan:markdown-image-localizer.md]
- Settings > Multimodal UI panel for the three new fields (Phase 3). [plan:markdown-image-localizer.md]
- Source-watch self-write suppression (currently accepted as one redundant activity-panel entry on first localize) (Phase 3). [user:decision-2026-07-23-review]
- HTML `<img>`, reference-style images, SVG dimension probing (never). [plan:markdown-image-localizer.md]

## Working conventions used this session

- Small commits, one per concern (5 commits planned for Phase 1). [user:profile]
- Doc-only revisions land as a single commit before code (this session's `c696737`). [user:decision-2026-07-23-review]
- Design reviews follow the `design-doc-review` skill's tiered contract (CRITICAL/WORTH/SMALL/DEFER) with a mandatory `clarify` before implementation. [user:profile]
