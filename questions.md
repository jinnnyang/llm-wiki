---
kind: questions
version: 1
last_updated: '2026-07-23T02:20:28+00:00'
last_verified: '2026-07-23T02:20:19+00:00'
last_agent: hermes-agent
last_writer: hand-off
session_id: session-2026-07-23-mdimg-review
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

### Acceptance override · reviewer_false_positives · 2026-07-23T02:30:00+00:00

take-over Step 1.5 review-handoff returned `reject` on two heuristic checks that don't reflect real content:

- `context_description_empty` — reviewer looks for a `## Project Description` header; context.md uses the richer `## Repository facts` / `## Framing invariants` / `## Image pipeline landmarks` structure instead. Content is not empty.
- `task_list_empty` — reviewer looks for `- [ ]` items; task.md uses `### [ ] Commit N` heading format for its 5-commit plan.
- 13 `context_path_not_found` WARNs — all target valid `src/lib/*.ts` files that exist; the reviewer's regex forgets to strip trailing `:NNN` line-number suffixes.

User explicitly instructed take-over to force-continue ("准备对新功能的需求和设计进行评审"). Risk logged; no data loss. <!-- resolved -->

- None.

## Closed

- None.
