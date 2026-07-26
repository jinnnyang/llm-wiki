# Commit 4 tail audit — wiki-page seeding

**Scope.** Per plan §8 acceptance criteria: every read of `sourceContent`
inside `autoIngestImpl` (`src/lib/ingest.ts:660–1296`) is classified as
either **raw-form target** (needs `workingSourceContent`, i.e. the body
rewritten with `../../wiki/media/...` refs) or **wiki-form target**
(needs `workingWikiSourceContent = result.rewrittenWikiMarkdown`, i.e.
`../media/...` refs relative to `wiki/sources/<slug>.md`). Sign-off
line at the bottom.

**Method.**
1. `grep -n "sourceContent"` inside `autoIngestImpl` (660–1296): **12
   code references**, plus 6 comment references (ignored — no runtime
   effect).
2. For each code reference, trace what happens with the value:
   - Fed to a helper that mutates the raw-sources copy or its cache key
     → **raw-form** (workingSourceContent).
   - Fed to a helper that eventually lands in `wiki/sources/<slug>.md`
     or the LLM analysis/generation prompt (which produces wiki-side
     files) → **wiki-form** (workingWikiSourceContent).
   - Fed to a helper that only reads image URL SHAPE (not the file
     path form), e.g. `hasMineruImageRefs` → **raw-form is safe**
     (both forms tag mineru refs identically; the SHAPE is the same,
     only the RELATIVE path prefix differs).

**Line numbers.** Anchored at v3 tip (post-4a/4b/4c, before Commit 5).
Commit 5 will shift these by ~15–20 lines when it inserts Step 0.4;
use symbol grep as the durable anchor.

---

## Classification table

| Line | Context | Call | Classification | Rationale |
|------|---------|------|----------------|-----------|
| 727 | initial destructured read | `[sourceContent, ...] = Promise.all([tryReadSourceTextFile(sp), ...])` | **source of truth** | This IS the seed variable; nothing to swap. Commit 5 declares `workingSourceContent` right after this line. |
| 734 | pre-cache mineru re-scan | `hasMineruImageRefs(sourceContent, sourceSummarySlug)` | **raw-form OK, no swap needed** | Runs BEFORE Step 0.4; the localizer hasn't executed yet, so `sourceContent === workingSourceContent`. Detects mineru markers by regex which is form-independent. |
| 735 | pre-cache mineru rebuild | `savedImagesFromMineruMarkdown(pp, sourceSummarySlug, sourceContent)` | **raw-form OK, no swap needed** | Same reason as 734: pre-Step-0.4. |
| 752 | cache lookup | `checkIngestCache(pp, sourceIdentity, sourceContent)` | **raw-form (workingSourceContent + fingerprint)** | Cache key MUST reflect on-disk state post-Step-0.4. Commit 5 swap: `checkIngestCache(pp, sourceIdentity, buildIngestHashInput(workingSourceContent, mmCfg))`. |
| 757 | cache-hit mineru gate | `hasMineruImageRefs(sourceContent, sourceSummarySlug)` | **raw-form (workingSourceContent)** | Post-cache branch, but still checks source-side markers. Both forms tag mineru identically; swap for consistency and to avoid drift when Step 0.4 wrote v2 to disk. |
| 761 | cache-hit legacy extractor | `extractAndSaveMarkdownImages(pp, sp, sourceContent, sourceSummarySlug)` | **REMOVE when `mmCfg.localizeMarkdownImages`** | Per plan §8 coordination note: skip entirely when localizer is on (double-copy + naming drift). When disabled, keep + swap to `workingSourceContent` for consistency (Step 0.4 didn't run → they're equal). |
| 790 | cache-hit caption pipeline | `captionMarkdownImages(pp, appendSavedImageRefsForCaption(sourceContent, savedImages), ...)` | **raw-form (workingSourceContent)** | `appendSavedImageRefsForCaption` reads the body to detect which images are already-referenced. Must see the post-localize body so it doesn't re-append the same refs. When localizer is on the ideal is to SKIP this whole cache-hit caption pipeline (already captioned in Step 0.4); plan §8 defers that decision to Commit 5. |
| 854 | full-pipeline mineru gate | `hasMineruImageRefs(sourceContent, sourceSummarySlug)` | **raw-form (workingSourceContent)** | Same as 757. |
| 859 | full-pipeline legacy extractor | `extractAndSaveMarkdownImages(pp, sp, sourceContent, sourceSummarySlug)` | **REMOVE when `mmCfg.localizeMarkdownImages`** | Same as 761. |
| 909 | caption-pipeline enrichment | `appendSavedImageRefsForCaption(sourceContent, savedImages)` | **wiki-form (workingWikiSourceContent)** | The result flows into `enrichedSourceContent`, which is fed to the ANALYSIS prompt (line 1005) and the GENERATION prompt (line 1052). These prompts drive what the LLM writes into `wiki/sources/<slug>.md` and other `wiki/**` pages. The image URLs the LLM sees MUST be wiki-form so it preserves the correct relative path in its output. This is the ONE site in the full pipeline that needs wiki-form. |
| 917 | strip-images fallback | `enrichedSourceContent = sourceContent.replace(/!\[.../g, " ")` | **wiki-form (workingWikiSourceContent)** | Same downstream as 909 — feeds the analysis/generation prompts. But it's a full REPLACE that strips ALL image refs, so raw-form vs wiki-form is irrelevant for the OUTPUT (both are stripped). For consistency + defense against a future partial-strip refactor, swap anyway. |
| 1250 | pipeline-end cache save | `saveIngestCache(pp, sourceIdentity, sourceContent, writtenPaths)` | **raw-form (workingSourceContent + fingerprint)** | Same reason as 752. Commit 5 swap: `saveIngestCache(pp, sourceIdentity, buildIngestHashInput(workingSourceContent, mmCfg), writtenPaths)`. |

## Summary

**12 code references audited:**

- **1 seed** (line 727) — declares `sourceContent`; nothing to swap.
- **3 pre-Step-0.4 reads** (lines 734, 735) — before localizer runs; no
  swap required, but safe to swap after Step 0.4 executes because
  workingSourceContent === sourceContent when the localizer branch is
  a no-op (feature off or same-URL cache hit).
- **6 raw-form targets** (lines 752, 757, 790, 854, 1250, plus 761/859
  when localizer is disabled) → swap to `workingSourceContent`.
  - Lines 752 and 1250 additionally wrap via `buildIngestHashInput`.
- **2 wiki-form targets** (lines 909, 917) → swap to
  `workingWikiSourceContent` where
  `workingWikiSourceContent = result.rewrittenWikiMarkdown ?? workingSourceContent`.
  Fallback to `workingSourceContent` when the localizer branch didn't
  run so the LLM still sees a sensible body.
- **2 conditional deletions** (lines 761, 859) — remove
  `extractAndSaveMarkdownImages` calls when
  `mmCfg.enabled && mmCfg.localizeMarkdownImages`; keep them behind an
  `else` for the legacy path.

**Wiki-form binding site count: 1 canonical + 1 defensive.** Only line
909 truly requires wiki-form; line 917's full-strip fallback would
produce byte-identical output regardless of form, but is included in
the swap set for future-proofing.

**`mmCfg` scope hoist (plan §8 v3.3).** Confirmed exactly **2**
declarations of `useWikiStore.getState().multimodalConfig` inside
`autoIngestImpl`:
- Line **781** — cache-hit branch (Commit 5 deletes).
- Line **911** — full-pipeline branch (Commit 5 hoists to before
  Step 0.4).

Line 3214 is a separate function (`writeFileBlocks` scope) — leave it
alone. Verified by `grep -n "useWikiStore.getState().multimodalConfig"
src/lib/ingest.ts` outside the 660–1296 window returning only 3214.

**`captionLlm` scope hoist.** Confirmed exactly **2** declarations of
`resolveCaptionConfig(mmCfg, llmConfig)` inside `autoIngestImpl`:
- Line **787** — cache-hit branch (Commit 5 deletes).
- Line **912** — full-pipeline branch (Commit 5 hoists alongside `mmCfg`).

Both are dominated by their `mmCfg` sibling and move together.

**`buildIngestHashInput` helper.** Already declared at ingest.ts:652
(present in the working tree). Commit 5 uses it as-is at the two cache
sites — no changes to the helper itself.

**Source-watch reenqueue.** When Step 0.4 rewrites the raw-sources copy
(`rewrittenSourceMarkdown !== sourceContent`), the write triggers
source-watch. The subsequent reenqueued ingest hits the cache at line
752 because `workingSourceContent + fingerprint` matches what
`saveIngestCache` stored at 1250. The activity panel will show one
extra cache-hit row per editing session that adds an image, per plan
§8 "Source-watch reenqueue" note.

## Sign-off

**Audited 12 sites, 2 → wiki-form, 6 → raw-form (of which 2 deleted on
localizer-enabled), 3 pre-Step-0.4 (no swap needed), 1 seed.**

Commit 5 diff can now be built from the classification table
without further exploratory reads.
