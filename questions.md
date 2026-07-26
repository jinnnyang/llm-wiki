---
kind: questions
version: 1
last_updated: '2026-07-26T10:33:24+00:00'
last_verified: '2026-07-26T10:33:11+00:00'
last_agent: hermes-devops
last_writer: hand-off
session_id: handoff-20260726
status: in-progress
---

# Questions

> [!NOTE]
> Human-input questions and blockers. Two sections:
> - **`## Open`** — active questions awaiting input.
> - **`## Closed`** — archived (historical reference only, permanent).
>
> **Lifecycle markers**:
> - `<!-- resolved -->` on a `## Open` entry → next hand-off will **archive it into `## Closed`** (not delete).
> - `<!-- keep -->` → keep in current section (typically Open).
> - Placeholder bodies (`- None.`, `TBD.`, `N/A.`, or empty) are always retained.
>
> Auto-generated SOFT-conflict warnings from `check-reality --apply-soft-conflicts` are appended under `## Open` as timestamped entries — resolve them by adding `<!-- resolved -->` once addressed.

## Open

### H2 product decision · localizeMarkdownImages default · 2026-07-26

<!-- keep -->

`wiki-store.ts:609` sets `localizeMarkdownImages: true` by default. This means every markdown ingest will download remote images and run VLM captioning unless the user explicitly disables it. Code review flagged this as H2 (high priority, product decision). Options:

1. Keep `true` — aggressive localization, best link-rot protection, but surprises users with network + VLM costs on first ingest.
2. Default `false` — opt-in, conservative, but most users won't discover the feature.
3. Default `true` + first-run prompt in Settings UI (Phase 3) — best UX but requires UI work.

No decision made yet. Current code ships with `true`.

## Closed

- None.
### Acceptance override · reviewer_false_positives · 2026-07-23T02:30:00+00:00

take-over Step 1.5 review-handoff returned `reject` on two heuristic checks that don't reflect real content:

- `context_description_empty` — reviewer looks for a `## Project Description` header; context.md uses the richer `## Repository facts` / `## Framing invariants` / `## Image pipeline landmarks` structure instead. Content is not empty.
- `task_list_empty` — reviewer looks for `- [ ]` items; task.md uses `### [ ] Commit N` heading format for its 5-commit plan.
- 13 `context_path_not_found` WARNs — all target valid `src/lib/*.ts` files that exist; the reviewer's regex forgets to strip trailing `:NNN` line-number suffixes.

User explicitly instructed take-over to force-continue ("准备对新功能的需求和设计进行评审"). Risk logged; no data loss. <!-- resolved -->

### Acceptance override · reviewer_false_positives · 2026-07-26T00:00:00+00:00

take-over Step 1.5 review-handoff produced the same two REJECTs + 13 WARNs as the 2026-07-23 override above (heading-level `### [ ] Commit N` mis-classified as `task_list_empty`; `## Repository facts` etc. mis-classified as `context_description_empty`; `path:line` refs not stripped). Documents themselves are intact and rich (context.md 91 lines, task.md 148 lines, questions.md preserved).

User invoked take-over skill again to resume work on `feat/markdown-image-localizer` (branch head `bb7fd20`, Commit 3c completed, next: Commit 4). Same known-false-positive set, same decision to force-continue. <!-- resolved -->

### Acceptance override · check_reality_illustrative_paths · 2026-07-26T00:00:00+00:00

take-over Step 2 check-reality flagged 2 HARD conflicts of type `missing_file_in_task`:

- `../../wiki/media/...` and `../media/...` in task.md — these are **illustrative rewrite-pattern strings** from plan §4 (source-form vs wiki-form path shape). The trailing `...` is a literal ellipsis, not a glob. reviewer resolves them as real relative paths against pwd and stat()s them.

Not real path references. Force-continue accepted. Fixed in task.md by replacing with `<source-root>/wiki/media/…` placeholder notation. <!-- resolved -->

- None.

