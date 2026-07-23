---
kind: walkthrough
last_updated: '2026-07-23T03:00:00+00:00'
last_writer: take-over
last_agent: hermes-agent
session_id: session-2026-07-23-mdimg-review-2
last_verified: '2026-07-23T03:00:00+00:00'
---

# Walkthrough — llm-wiki

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
