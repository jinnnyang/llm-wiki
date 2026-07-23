---
kind: context
last_updated: '2026-07-23T01:42:37+00:00'
last_writer: hand-off
last_agent: hermes-agent
session_id: session-2026-07-23-mdimg
last_verified: '2026-07-23T01:42:37+00:00'
---

# Context — llm-wiki

Session-independent invariants for the `feat/markdown-image-localizer` work.

## Repository facts

- Repo root: `C:\Users\jinnn\Documents\llm-wiki` [git:origin]
- Fork of `nashsu/llm_wiki` (upstream). Working branch `main` mirrors `origin/main`; `upstream` branch mirrors `nashsu/main`. [git:remote]
- Layout convention: `main` is rolling mirror of `origin/main` which may be ahead of `origin/upstream` (fork sometimes pulls community PRs before upstream releases them). Currently `main` = `upstream` = `e8bdec6` (v0.6.5 tip). [git:log]
- Active feature branch: `feat/markdown-image-localizer`, cut from `e8bdec6`. [git:branch]
- Package manager: npm. Verify commands: `npm run test`, `npm run typecheck`, `npm run build`. [user:workspace-snapshot]
- Test framework: vitest. [git:package.json]
- Node 24.15.0, TypeScript strict. [user:profile]

## Toolchain state at session end

- GitNexus index: current as of `c2f626d` (the merge commit that got reset). After the reset to `e8bdec6`, index has 6,696 nodes / 17,677 edges / 456 communities. Contents match `e8bdec6` because tree was byte-identical to the merge commit. [test:gitnexus-analyze-log]
- Working tree carries two files that predate this session and should not be assumed as this session's changes: `M package-lock.json` and untracked `CLAUDE.md`. [git:status]

## Image pipeline landmarks (predecessor v0.6.4 work)

- `src/lib/image-caption-pipeline.ts:283` — `captionMarkdownImages`, the VLM caption orchestrator. [git:blob]
- `src/lib/image-caption-pipeline.ts:141` — `MD_IMAGE_RE = /(!\[)([^\]]*)(\]\()([^)\s]+)(\))/g`. Does NOT capture `"title"`; splits url at whitespace. Do not modify — the new module ships an extended regex `MD_IMAGE_RE_WITH_TITLE` alongside it. [git:blob]
- `src/lib/vision-caption.ts:155` — `captionImage(imageBase64, mediaType, llmConfig, signal, options)`. Codex-CLI transport is a no-op (early return). [git:blob]
- `src/lib/extract-source-images.ts:200` — `extractAndSaveMarkdownImages` handles **local relative** md image refs today. Do NOT overlap; the new localizer handles remote/data only. [git:blob]
- `src/lib/url-source-import.ts:86` — `fetchImportUrl` with SSRF/private-network/redirect defenses. Reuse verbatim. [git:blob]
- `src/lib/tauri-fetch.ts:41` — `getHttpFetch` wrapper. [git:blob]
- `src/commands/fs.ts:27` — `writeFileBase64(path, base64)` → Rust `write_file_base64`. [git:blob]
- `src/lib/ingest.ts:637` — `autoIngestImpl`. Step 0.4 hook goes after source read (line ~704), before cache check (line ~729). Cache-hit branch (line ~731) needs parallel treatment. [git:blob]
- `src/stores/wiki-store.ts:296` — `MultimodalConfig` interface. Add new fields here. Store init defaults at line ~579. [git:blob]

## Caches on disk

- Existing: `<project>/.llm-wiki/image-caption-cache.json` — SHA-256 → `{ caption, mimeType, model, capturedAt }`. New optional fields `title`, `originalUrl` added by Commit 2 are forward-compatible with old files. [git:blob]
- New: `<project>/.llm-wiki/image-url-cache.json` — URL → `{ sha256, mimeType, width, height, bytesLen, fetchedAt, canonicalRelPath }`. TTL 45 days. Written once at end of pipeline (not per-image). [plan:markdown-image-localizer.md]

## Design invariants (locked, do not revisit)

- Default rewrite mode: `alt-title-only` for user's raw source `.md` files. Preserves original URL, updates alt+title from VLM. [user:decision-2026-07-23]
- Wiki summary page always gets `full`-mode rewrite (self-contained copy). [user:decision-2026-07-23]
- Small images (<100px either dim) download locally but skip VLM caption. [user:decision-2026-07-23]
- Two-tier cross-document caching. URL cache eliminates redundant HTTP; SHA cache eliminates redundant VLM. [user:decision-2026-07-23]
- Per-source directory storage (`wiki/media/<slug>/`), not shared pool. Matches existing conventions and keeps `cascadeDeleteWikiPage` orphan-media reap logic unchanged. [user:decision-2026-07-23]
- Filenames end with `-<sha8>.<ext>` where sha8 = first 8 hex chars of SHA-256. Doubles as idempotency marker. [plan:markdown-image-localizer.md]
- URL cache TTL: 45 days (user override, default was 30). [user:decision-2026-07-23]
- 20 MB body size cap on image downloads. Content-Type must start with `image/`. [plan:markdown-image-localizer.md]
- Concurrency for downloads mirrors `multimodalConfig.concurrency` cap at 4. [plan:markdown-image-localizer.md]
- `never` mode is byte-identical to today's behavior. Test this in Commit 5 regression pass. [plan:markdown-image-localizer.md]

## Deferred to Phase 2 / 3

- Rust `image` crate features `jpeg,webp,gif` + `probe_and_resize_image_bytes` Tauri command (Phase 2). [plan:markdown-image-localizer.md]
- Settings > Multimodal UI panel for the three new fields (Phase 3). [plan:markdown-image-localizer.md]
- `.bak` backup + frontmatter `image_sources:` mapping table (Phase 3). [plan:markdown-image-localizer.md]
- HTML `<img>`, reference-style images, SVG dimension probing (never). [plan:markdown-image-localizer.md]

## Working conventions used this session

- Small commits, one per concern (5 commits planned for Phase 1). [user:profile]
- Update skill immediately when it fails or is incomplete (skill-authoring convention). [user:profile]
- Prefer `--keep` over `--hard` for git resets to preserve working-tree changes. [session:demonstrated]
