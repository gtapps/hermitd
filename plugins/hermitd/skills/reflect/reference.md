# Reflect — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md step 6.
The subagent reads only files (no inherited session context); writes and notifications are handled by the
calling main session after it receives the subagent's structured JSON return value. Where an instruction
below says "update frontmatter", "append metrics", "return a finding", or "note in Findings",
populate the corresponding field in the return JSON instead — the main session applies those actions.

## Inputs (read fresh — do not reuse cached values)

The dispatch prompt's first line is `Anchor: root=<absolute hermit root> memory_dir=<absolute auto-memory dir>`.
Every `.hermit/…` path below is relative to that `root` — read and glob it as
`<root>/…`, and pass `<root>` where a command below spells `.hermit`. Your working
directory is inherited from the caller and may sit anywhere, so a relative path reads an empty tree
without erroring. `memory_dir` is the auto-memory directory this file calls `memory-dir`.

- `.hermit/state/reflection-state.json` — for `last_resolution_check`, `last_sparse_nudge`
- `.hermit/proposals/PROP-*.md` — for accepted proposals (Resolution Check)
- Normalized records from `task-report` (Commands): the three most recent outcomes `done`, `cancelled`, or `unconfirmed`. Never open frozen session archives.
- routine fires, failures and cost — via `routines.ts health` in Step 2, never by reading
  `routine-metrics.jsonl` or `cost-log.jsonl` directly
- `MEMORY.md` — operator's auto-memory index (procedure detection)

The calling skill passes `phases_json` (the precheck output object listing which phases are due) and
`last_resolution_check` (the cursor from reflection-state.json) in the dispatch prompt. Read them from
the prompt; do not re-read reflection-state.json for the cursor (the main session already read it).
The dispatch prompt also supplies the absolute plugin root for non-command files and the Commands entries used below. Run those entries verbatim with the stated arguments.

## Step 1 — Resolution Check

Run this step only if `resolution_check` is listed in `phases_json`.

**a.** Read all proposals with `status: accepted` from `.hermit/proposals/PROP-*.md`.
   Sort by `accepted_date` ascending. Resume from the proposal after `last_resolution_check` (the cursor
   passed in the dispatch prompt), wrapping around. Take up to 5.

**b.** If the accepted list is empty, skip to the return value (emit `resolution_actions: []`).

**c.** For each proposal: read `title`, `success_signal`, `accepted_in_session`, `accepted_date`,
   `tags`, `related_sessions`, and the Evidence section.

   **If `success_signal` is non-null** — run the predicate:
   Run `proposal-success-signal` (Commands) with arguments `"<accepted_date>" "<accepted_in_session|null>" "<success_signal>"`.
   Parse its JSON. Branch on `status`:
   - `insufficient_data` → skip; add nothing to `resolution_actions` for this proposal.
   - `met` → auto-resolve. Populate one `resolution_actions` entry:
     ```json
     { "proposal_id": "PROP-NNN",
       "action": "auto-resolve",
       "frontmatter_patch": { "status": "resolved", "resolved_date": "<now ISO>" },
       "shell_findings_line": "PROP-NNN resolved — success signal met: avg session cost $<observed> over <sessions_counted> sessions (target <op> $<threshold>)." }
     ```
   - `unmet` → nudge if debounce allows. Check `last_sparse_nudge.<PROP-NNN>` (from dispatch prompt or
     reflection-state.json if not in prompt). If present and < 7 days elapsed, skip (add nothing).
     Otherwise, populate one `resolution_actions` entry:
     ```json
     { "proposal_id": "PROP-NNN",
       "action": "nudge",
       "frontmatter_patch": null,
       "shell_findings_line": "PROP-NNN success signal NOT met: avg session cost $<observed> over <sessions_counted> sessions (target <op> $<threshold>). Run /hermitd:proposal-act resolve|dismiss PROP-NNN, or revise." }
     ```

   **If `success_signal` is null** — use the prose pattern-absence test:

   Reuse the three normalized records. Check the proposal's pattern against each title,
   lessons, outcome and waiting reason. A result with outcome `unconfirmed` is evidence of an
   observation, not proof of completion.

   **Same-area guard:** establish overlap using proposal-title or Evidence keywords in record
   titles or lessons. If no record overlaps, skip the proposal. Do not open legacy `related_sessions`
   reports for tags or cadence. Resolve task IDs in that compatibility field against normalized
   records and use their `opened_at` dates for `original_cadence_days`; missing task references
   mean sparse evidence. A single matching record has cadence 0 days.

   If the pattern IS present in any of the 3 records: add `action: "skip"`, no other fields.

   If the pattern is **absent** from all 3:
   - **Frequent** (`original_cadence_days ≤ 14`) and ≥ 14 days elapsed since `accepted_date`:
     → auto-resolve (same entry shape as the `met` branch above). Do not emit a metrics row —
     `apply-reflection-actions.ts` derives the `resolved` row from `proposal_id`.
   - **Sparse** (`original_cadence_days > 14`) and elapsed ≥ `2 × original_cadence_days` since
     `accepted_date` and debounce allows (same `last_sparse_nudge` check as `unmet` branch):
     → nudge (populate `shell_findings_line`:
     `"PROP-NNN appears resolved (pattern absent 3/3 recent records, original cadence Nd, Xd since accept). Run /hermitd:proposal-act resolve PROP-NNN to confirm."`)
   - Elapsed guard not yet met: add `action: "skip"`, no other fields.

**d.** Set `last_resolution_check` in the return value to the last PROP-NNN checked (or null if the
   batch was empty).

**e.** Set the top-level `last_sparse_nudge` return field to the union of every proposal nudged this
   run: for each `resolution_actions` entry with `action: "nudge"` (both the `unmet` and sparse-pattern
   branches above), add `{ "PROP-NNN": "<now ISO>" }`. Emit `{}` if no proposal was nudged. This
   top-level map is the only nudge write-back — the calling session merges it into `reflection-state.json`
   to honour the 7-day debounce. Do not return nudge timestamps inside the individual `resolution_actions`
   entries; only the top-level map is read.

## Step 2 — Routine Check

Run this step when the calling skill's execution observation is `idle`. If it is unknown
or in flight, emit `routine_candidates: []` and skip this step.

Run this once and use its output for every detection below. Do not read
`routine-metrics.jsonl` or `cost-log.jsonl` yourself — the counting, the 14-day window, and the
cost attribution are all this script's job:

Run `routines-health` (Commands) with arguments `--days 14`.

It prints one JSON object:

- `source` — `ok` | `missing` | `unreadable`. If it is not `ok`, emit `routine_candidates: []` and
  skip the rest of this step: an unreadable ledger is not evidence that routines are healthy.
- `malformed_rows` — corrupt ledger lines skipped. Mention in a finding only if non-zero.
- `routines[]` — per routine: `fires`, `failures` (counts keyed by bare reason),
  `failure_total`, `incomplete`, `orphan_terminals`, `open_attempt`, `unhandled`,
  `unhandled_open`, `skips`, `last_fire`, `cost_usd`.
- `unattributable_multi_cost_usd` — spend from wakes that served two or more routines at once. It
  belongs to no single routine; never fold it into one routine's evidence.

**Errored-routine detection:**

`incomplete` counts attempts that started and never reached a terminal row — a crash, a killed
session, a hung skill. If `incomplete >= 2` for a routine, produce a `routine_candidates` entry:

```json
{ "routine_id": "<id>", "action": "diagnostic", "tier": 1, "schedule": null,
  "evidence": "routine '<id>' started but never completed N× in the last 14 days",
  "sessions": [],
  "shell_findings_line": "routine '<id>' started but never completed N× in the last 14 days — its output and cost are unattributed." }
```

`unhandled` counts emits the session never picked up — fired but the session never ran the
wrapper, so the fire and its cost are unrecorded. If `unhandled >= 2` for a routine, produce
the same entry shape with that wording, not the crash wording.

**Failed-contract detection:**

`failures` is a different fault and gets different wording: the routine ran and its declared
`expect_artifact` contract was not met (`artifact-missing`, `artifact-unchanged`,
`verification-error`). If `failure_total >= 2`, produce the same entry shape naming the dominant
reason — "routine '<id>' ran but its output did not land (artifact-missing) N× in the last 14
days" — not the generic errored wording. These are not crashes and the fix is different.

`orphan_terminals` (a terminal row with no matching start) and `open_attempt` (an attempt still
running at the window edge) are diagnostic context, not candidates on their own. `unhandled_open`
is the same for a dispatch still open at the window edge; on a routine that fires less often than
the window it is more likely a dropped wake than a live turn.

**Uncited-routine detection:**

For each routine with `fires >= 5`, reuse the three normalized records. If no record's
lessons or title cites the routine's `routine_id` or output as producing findings, decisions,
or follow-ups, apply the
Three-Condition Rule:
1. Repeated pattern: ≥5 fires with zero citation.
2. Meaningful consequence: routine runs but produces no downstream effect.
3. Operator-actionable: disable or reschedule.
If all three hold, produce a `routine_candidates` entry with `action: "disable"` or `"retime"` (prefer
retime if timing mismatch is apparent from `last_fire` vs. session activity times). Quantify the
consequence with the routine's own `cost_usd` from the health output — that is the spend buying
nothing:
```json
{ "routine_id": "<id>", "action": "disable", "tier": 1, "schedule": null,
  "evidence": "<fire count + window + citation count + $cost_usd over the window>",
  "sessions": ["<T-id>", ...],
  "shell_findings_line": null }
```

## Step 3 — Settled-memory placement

Run this step only if `compute` is listed in `phases_json`. Read the operator's MEMORY.md index in the auto-memory directory named in your dispatch (`memory-dir`). Do not discover recurring procedures from task lessons or memory workflow patterns. Close-time learning owns procedure creation.

The compatibility field `procedure_candidates` carries only the ownership signal below. Emit `procedure_candidates: []` when no unplaced settled-memory preference exists. Each entry has `slug`, `title`, `tier`, `evidence_source`, `evidence_origin`, `evidence`, `sessions`, and `artifact`; use `evidence_source: "settled-memory"`, `tier: 2`, `evidence_origin: "own-work"`, `sessions: "none"`, and `artifact: null`.

**Ownership signal:** emit one entry per MEMORY.md preference that records an explicit
operator endpoint for a task-scoped output ("from now on, always X" — a settled voice, template,
format, decision rule, or quality bar). Use the entry shape above with `evidence_source: "settled-memory"`
(the override for this signal only — recurrence is not required; the recorded endpoint declaration is
the human-initiated evidence; the shape's `tier` is ignored for these — the main session's
`skill-preference:*` routing sets it). `evidence` must cite the memory topic **filename** plus the **verbatim
endpoint line** (the main session's judge greps for it; the filename doubles as the dedup key — derive
`title` from it). Emit nothing for session-wide one-liners (memory is their correct home) and nothing
for pointer-form memories that already name the skill or surface holding the content (already placed), or for hook lines tagged `[role` (channel standing roles whose home is memory).
Do not read skill files or prose surfaces to check ownership — the main session owns that; your
evidence is the memory entry alone.

## Return Value

Return a single JSON object — no prose, no markdown wrapping. Every field is required; use `[]` / `null`
/ `{}` for empty values, never omit a key.

<!-- reflect-eval-schema:start -->
```json
{
  "resolution_actions": [ { "proposal_id": "PROP-NNN", "action": "auto-resolve|nudge|skip",
                            "frontmatter_patch": {"status":"resolved","resolved_date":"<ISO>"}|null,
                            "shell_findings_line": "<pre-rendered finding text>"|null } ],
  "routine_candidates": [ { "routine_id": "<id>", "action": "disable|retime|diagnostic",
                            "tier": 1, "schedule": "<new-cron>"|null,
                            "evidence": "<text>", "sessions": ["<T-...>"],
                            "shell_findings_line": "<pre-rendered>"|null } ],
  "procedure_candidates": [ { "slug": "<slug>", "title": "<title>", "tier": 3,
                              "evidence_source": "settled-memory", "evidence_origin": "own-work",
                              "evidence": "<text>", "sessions": ["<T-...>"]|"none",
                              "artifact": "<file — value>"|null } ],
  "last_resolution_check": "PROP-NNN|null",
  "last_sparse_nudge": { "PROP-NNN": "<ISO>" }
}
```
<!-- reflect-eval-schema:end -->

`resolution_actions` and the two cursor fields are applied directly by the calling session. `routine_candidates` and `procedure_candidates` carry cross-session evidence and go through `reflection-judge` then `proposal-triage` before any proposal is created. Applied fields carry the exact string the main session writes — no recomputation needed.
