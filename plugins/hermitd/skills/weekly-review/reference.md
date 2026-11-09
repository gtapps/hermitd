# Weekly Review — Topic-Page Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md step 3.
For **this** spec the subagent reads only files (no inherited session context) and returns structured
JSON; the calling main session composes the channel summary from what it returns, and this spec asks
for no writes.

## Inputs (read fresh — do not reuse cached values)

- Every `.hermit/compiled/topic-*.md` — read full bodies.
- Run `task-report` (Commands) for normalized task outcomes, titles and lessons. Never open frozen task records. Skip this read if no topic pages exist.
- `MEMORY.md` — operator's auto-memory index, in the directory `memory-dir` prints (its path is named in the
  dispatch) — to resolve wikilink targets.

If no `compiled/topic-*.md` files exist, return `topic_findings: []` and do nothing else.

## Semantic check of topic pages

Read every `compiled/topic-*.md` and look for:
- claims contradicted by another topic page or by a more recent task record
- stale claims — old `updated` date on a subject with recent task activity
- broken `[[wikilinks]]` — targets that match no compiled page or memory entry

Cap at 3 findings, one line each. If none, or no topic pages exist, return `topic_findings: []`.

## Return Value

Return a single JSON object — no prose, no markdown wrapping. The field is required; use `[]` when
there are no findings, never omit the key.

<!-- weekly-review-eval-schema:start -->
```json
{
  "topic_findings": [ "<one-line finding>" ]
}
```
<!-- weekly-review-eval-schema:end -->

The main session renders `topic_findings` as a `Topic pages:` line in the weekly channel summary
(step 6) when non-empty, and omits the line entirely when `[]`.

Weekly report totals use records with `closed_at` inside the review window. The report includes the `taskStandup` by-person summary and a Duties section from `duties-summary` (Commands), showing requested and observed state separately. Open unconfirmed work stays visibly separate from completed work.
