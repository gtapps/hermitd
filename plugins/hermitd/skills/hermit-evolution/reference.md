# Hermit Evolution — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md.
The subagent reads files and runs scripts in a fresh context (no inherited session state), then
returns the assembled evolution report. The calling main session decides where to deliver it
(channel reply vs conversation) — this spec produces the report text, it does not send anything.

## Inputs (read fresh — do not reuse cached values)

The dispatch prompt supplies the absolute plugin root for non-command files and the Commands entries used below. Run those entries verbatim with the stated arguments.

Gracefully skip any file, glob, or script that doesn't exist or exits non-zero.

Steps are independent — read files and run scripts concurrently where possible.

1. `.hermit/compiled/review-weekly-*.md` — glob all, sort by `week` frontmatter
   descending, read the 8 most recent. Extract per-file: `week`, `total_cost_usd`,
   `proposals_created`, `proposals_resolved`.
2. Partial-week total: from the step 5 `cost-report.ts reflect` output (its
   `total_usd`), when the review file for the current week doesn't exist yet. Skip if
   step 5 is unavailable.
3. `.hermit/state/proposal-metrics.jsonl` — scan from the end (most recent first); stop
   at entries older than 30 days. Use `resolved_at` and `created_at` to compute resolution days.
4. Run `proposal-metrics` (Commands) and
   capture stdout. Skip gracefully if unavailable. (Steps 4 and 5 may run concurrently.)
5. Run `cost-report-reflect` (Commands) with arguments `30` and capture
   stdout. This prints a 30-day cost breakdown as one JSON object, including `by_source`. Skip
   gracefully if unavailable or `status: "empty"`.
6. `.hermit/config.json` — read `routines[]` (id, schedule, enabled), `monitors[]`
   (id, enabled), `heartbeat.every`.
7. Run `routines-health` (Commands) with arguments `--days 30` and capture
   stdout — one JSON object with per-routine `fires`, `failures`, `incomplete`, `cost_usd` and a
   `source` status. Skip gracefully if unavailable. Do not read `routine-metrics.jsonl` directly.
8. Read the last 30 days of records through `scripts/lib/task-report.ts`. Use their outcomes, lessons and source paths. List filenames in `.hermit/compiled/` created in the last 30 days.
9. `.hermit/OPERATOR.md` and `state-templates/OPERATOR.md` under the plugin root —
   read both.
10. List dirs under `.claude/skills/` in the target project root and under
    `skills/` under the plugin root.

## Analysis

**Cost:** From review files, extract `total_cost_usd` per week and show the 4 most recent as a
trend with Δ% between the two most recent weeks. If fewer than 2 reviews exist, note "not enough
data". From the step 5 output's `by_source` entries, compute two buckets:
**scheduled** (sum of all `routine:*` and `heartbeat` sources) vs **interactive** (the `other`
source). Note that watches (Monitor tool) cost ~0 tokens when quiet and will not appear. If step 5
is unavailable, omit the split.

**Proposal velocity:** From `proposal-metrics.jsonl`, median days `created_at` → `resolved_at`
for proposals resolved in the last 30 days. From step 4's `segments`, show an acceptance-by-source
table (survival and acceptance rates with their counts, segments with `sample` > 0 only). Note
any segment whose `status` is `kill`, with its `kill_reasons`.

**Routines & watches:** From config.json, list enabled routines with their `schedule` cron
string. Use the step 7 output for 30-day fire counts, and flag any routine whose `incomplete`,
`unhandled`, or `failure_total` is non-zero. List enabled monitors and heartbeat cadence. Omit disabled entries.

**Top-3 produced (inferred):** From step 8, rank outputs by operator signal — prefer: (1)
proposals accepted or resolved, then (2) sessions with Artifacts/Changed. Pick the top 3
and describe each in one line. Label: _inferred — no operator-used signal exists._

**Grown since hatch (approximated):** From step 9, diff `.hermit/OPERATOR.md`
against the template and note sections the operator added or meaningfully filled in. From step 10,
list skill names present under `.claude/skills/` but absent from `skills/` under the plugin root
— those are organically created. Label: _approximated — no hatch baseline stored._

## Return Value

Assemble the report as a single `report` string, target ≤1500 chars. If data is abundant, drop
to one line per section rather than letting it balloon. Use this structure (omit sections with
no data rather than showing a heading with an empty body; keep each bullet to one line):

```
### Cost
- Trend (weekly): $A → $B → $C → $X (Δ +/-N%)
- Last 30d: $X.XX total — scheduled (routines/heartbeat): $Y (N%), interactive: $Z (N%)

### Proposal velocity
- Median resolution: Nd (N proposals, last 30d)
[acceptance-by-source table, rows n>0 only; note triggered kill gates]

### Routines & watches
- heartbeat: every X
- <routine-id>: <cron> · fired N× in last 30d
- watch <monitor-id>: active

### Top-3 produced (inferred)
- <one-line description>
- <one-line description>
- <one-line description>
(inferred — no operator-used signal exists)

### Grown since hatch (approximated)
- OPERATOR.md: <sections added, or "no additions vs template">
- Skills: <project-local skill names, or "none">
(approximated — no hatch baseline stored)
```

Return a single JSON object — no prose, no markdown wrapping. The field is required.

<!-- hermit-evolution-eval-schema:start -->
```json
{
  "report": "<assembled ≤1500-char report, section structure above>"
}
```
<!-- hermit-evolution-eval-schema:end -->
