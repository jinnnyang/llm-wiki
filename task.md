---
kind: task
last_updated: '2026-07-23T02:30:00+00:00'
last_writer: design-review
last_agent: hermes-agent
session_id: session-2026-07-23-mdimg-review
last_verified: '2026-07-23T02:30:00+00:00'
---

# Task — markdown image localizer (Phase 1)

**Branch:** `feat/markdown-image-localizer` (based on `e8bdec6`, upstream v0.6.5 tip)
**Overall status:** Plan reviewed and revised. 5 commits laid out below.

## Reference documents

```
plans/markdown-image-localizer.md
```

The plan doc has full design details (§1-12), test list, and risk register.

## Post-review key decisions

- **Single toggle** `localizeMarkdownImages: boolean` (not three modes). raw/sources/ is an app-managed copy — no need to preserve original URLs in the body.
- **Frontmatter `image_sources:` mapping** (originally Phase 3, promoted to Phase 1) carries traceability without polluting the body.
- **Cache convergence via Step 8a rebind + fingerprint composition.** After the localizer rewrites the raw-sources copy, `saveIngestCache` immediately rebinds `filesWritten` under the new content hash so source-watch reenqueue is an I/O-free hit. Cache key also folds in `localizeMarkdownImages` so toggling the field invalidates correctly.
- **Concurrency is internal to the localizer.** Download pool = `min(4, mmCfg.concurrency)`; caption pool = `mmCfg.concurrency`. No public API surface for either.
- **Codex-CLI:** downloads + rewrites still run; caption step skipped; alt stays original.

## Commit plan (execute in order)

### [ ] Commit 1 — MultimodalConfig schema + cache fingerprint

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

Extend `ingest-cache.ts` sha256 input with the fingerprint suffix (see plan §8 "Cache-key composition"). Add tests: (a) hit when field unchanged, (b) miss when field flips.

Verify: `npm run typecheck` + `ingest-cache.test.ts` green.

### [ ] Commit 2 — CaptionEntry optional fields

File:

```
src/lib/image-caption-pipeline.ts
```

Add optional `title?: string`, `originalUrl?: string` to `CaptionEntry`. Forward-compat.

Verify: `npm run test` — existing 21 caption-pipeline cases must stay green.

### [ ] Commit 3 — Localizer core (no VLM yet)

Files:

```
src/lib/markdown-image-localizer.ts
src/lib/markdown-image-localizer.test.ts
```

Scope: URL classification (with §5 two-step for `already-localized`), URL cache with per-entry upsert, HTTP download with SSRF reuse, SHA-256 dedup, canonical file write, `createImageBitmap` dimension probe (mockable), data URI handling with `resolveDataUri`.

Tests: 1, 2, 6-14, 18-19 from plan §Testing.

Verify: new module tests all green.

### [ ] Commit 4 — Localizer VLM + rewrite + frontmatter mapping

Extend the same two files with:

- `captionImage` integration (with codex-cli fallback)
- Body rewrite (§7 regex, §4 relative-path resolution)
- Frontmatter merge via `parseFrontmatter` (§11)
- Title escaping
- Idempotency marker parsing

Tests: 3, 4, 5, 15-17, 20, 21 from plan §Testing.

Verify: all 21 new module tests green.

### [ ] Commit 5 — autoIngestImpl integration

File:

```
src/lib/ingest.ts
```

Add Step 0.4 hook after source-read (~line 710) with the Step 8a cache rebind. Uniform placement — runs on both miss and hit paths.

Verify: full `npm run test` + smoke ingest a fixture md file with 3 remote images. Confirm second ingest is a cache-hit no-op.

## Non-goals (Phase 2 / 3)

- Rust `image` crate features (jpeg/webp/gif) + `probe_and_resize_image_bytes` command — Phase 2
- Settings UI panel for the three new config fields — Phase 3
- Source-watch self-write suppression (currently accepted as a redundant activity-panel entry on first ingest) — Phase 3
- `.md.bak` backup — deferred, likely unnecessary given raw-sources is already a copy
- HTML `<img>` support, reference-style images, SVG dimension sniffing — deferred
