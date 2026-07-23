---
kind: task
last_updated: '2026-07-23T01:45:44+00:00'
last_writer: hand-off
last_agent: hermes-agent
session_id: session-2026-07-23-mdimg
last_verified: '2026-07-23T01:45:44+00:00'
---

# Task — markdown image localizer (Phase 1)

**Branch:** `feat/markdown-image-localizer` (based on `e8bdec6`, upstream v0.6.5 tip)
**Overall status:** Plan approved, not yet implemented. 5 commits laid out below.

## Reference documents

```
plans/markdown-image-localizer.md
```

The plan doc has full design details (§1-9), test list (§5), and risk register (§7).

## Commit plan (execute in order)

### [ ] Commit 1 — MultimodalConfig schema + defaults

File to modify:

```
src/stores/wiki-store.ts
```

Add to `MultimodalConfig` interface:

- `localizeMarkdownImages: 'never' | 'alt-title-only' | 'full'` (default `'alt-title-only'`)
- `minImagePixelSize: number` (default `100`)
- `urlCacheTtlDays: number` (default `45`)

Verify: `npm run typecheck`

### [ ] Commit 2 — CaptionEntry optional fields

File to modify:

```
src/lib/image-caption-pipeline.ts
```

Add optional `title?: string`, `originalUrl?: string` to `CaptionEntry`. Forward-compat: existing cache files with old shape still load.

Verify: `npm run test` — existing 21 caption-pipeline cases must stay green.

### [ ] Commit 3 — Localizer core (no VLM yet)

Files to create:

```
src/lib/markdown-image-localizer.ts
src/lib/markdown-image-localizer.test.ts
```

Scope: URL classification, URL cache, HTTP download with SSRF reuse, SHA-256 dedup, canonical file write, dimension probe. Tests 1, 2, 6-14, 18-19 from plan §5.

Verify: new module tests all green.

### [ ] Commit 4 — Localizer VLM + rewrite modes

Extend the same two files with:

- `captionImage` integration
- Three-mode rewrite (`never` / `alt-title-only` / `full`)
- Title escaping
- Idempotency marker parsing

Add tests 3, 4, 5, 15-17, 20 from plan §5.

Verify: all 20 new module tests green.

### [ ] Commit 5 — autoIngestImpl integration

File to modify:

```
src/lib/ingest.ts
```

Add Step 0.4 hook after source-read (~line 704) and a parallel call in the cache-hit branch (~line 731).

Verify: full `npm run test` + smoke ingest a fixture md file with 3 remote images.

## Non-goals (Phase 2 / 3)

- Rust `image` crate features (jpeg/webp/gif) + `probe_and_resize_image_bytes` command — Phase 2
- Settings UI panel for the three new config fields — Phase 3
- `.md.bak` backup, frontmatter `image_sources:` mapping — Phase 3
- HTML `<img>` support, reference-style images, SVG dimension sniffing — deferred
