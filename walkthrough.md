---
kind: walkthrough
last_updated: '2026-07-23T01:47:08+00:00'
last_writer: hand-off
last_agent: hermes-agent
session_id: session-2026-07-23-mdimg
last_verified: '2026-07-23T01:46:42+00:00'
---

# Walkthrough — llm-wiki

## 2026-07-23 — Markdown image localizer: spec + branch cut

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
10. **Locked design decision** — captured in the plan doc:
    - Three-mode rewrite for user's raw md: `never` / `alt-title-only` (default) / `full`
    - Wiki summary always gets `full`-mode (self-contained copy)
    - Small images (<100px either dim) still download but skip VLM
    - Two-tier cache: URL → SHA (new url cache json) + SHA → caption (existing)
    - Per-source directory copy (not shared pool) — preserves existing conventions
    - URL cache TTL: 45 days (user chose over 30-day default)
    - Idempotency via `-<sha8>` marker embedded in filename
11. **Branch cut** — `feat/markdown-image-localizer` from `e8bdec6`.
12. **Plan doc written** — see reference below. 5-commit plan, 20-test unit test list, 8-risk register, Phase 2/3 deferred items.

### Files touched this session

New file:

```
plans/markdown-image-localizer.md
```

Working tree also carries pre-existing (not from this session) `M package-lock.json` and untracked `CLAUDE.md`.

### Not started

No code files touched. All 5 planned commits still pending.

### Key context files for next session

```
plans/markdown-image-localizer.md
plans/multimodal-images.md
task.md
context.md
```
