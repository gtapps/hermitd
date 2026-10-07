# Brief evaluation reference

Return structured JSON for the calling skill to compose and deliver. Read fresh bounded digests; never read frozen session archives .

## Inputs

The caller supplies `plugin_root` (absolute), `mode` (`morning`, `evening`, `daily`, `default-no-session`), `today` (ISO date), and morning `context_recovery`.

Run `task-report` (Commands) with arguments `--limit 20` for normalized records and `task-list` (Commands) with arguments `--open --owner resident --json` for open resident work. Run `duties-summary` (Commands) for requested and observed duties, returning any discrepancy in `findings`; a `skipped-precheck` last event is healthy (the routine ran its precheck and had nothing to do), not a discrepancy.

Open, waiting and queued items come only from the `task-list` and `task-report` rows returned in this run. Never take them from an earlier brief (`state/last-brief.json`, `compiled/brief-*`).

## Per-mode instructions

For morning, run `proposal-index` (Commands), then read `state/proposals-index.json`; put proposed auto-detected entries in `pending_proposals`. Read `OPERATOR.md` for `operator_priorities` if present. Populate `queued_work` from runnable open resident records. If `context_recovery` is true, summarize the newest normalized record; otherwise `report_summary` is null.

For evening and daily, select records whose `closed_at` date matches `today`, and open records whose `opened_at` date matches `today`. Populate `sessions_today` with task source paths as the compatibility `session` identifier and one-line title/outcome summaries. Populate `findings` from lessons and `tomorrow` from runnable open records, leaving waiting ones to `waiting`. Do not count `cancelled` or `unconfirmed` as done.

For morning, evening and daily, populate `waiting` from `task-list` rows with a non-null `result` or `waiting_on`, one entry per row: `<title>: result awaiting confirmation from <waiting_on>` when `result` is set, otherwise `<title>: waiting on <waiting_on>`.

For morning, evening and daily, populate `decisions` from report rows' decision lines stamped within the last day as `<task title>: <what changed, why>`, dropping timestamp and actor; otherwise an empty array.

For default-no-session, summarize the most recent normalized record. Map `done` to `completed`, waiting work to `blocked`, and other outcomes to `partial`, naming the actual outcome in the summary. Use `opened_at` for date, empty tags, title for working_on, and waiting reason or open work for next_start_point. No records means null summary, never an archive fallback. Return an empty `decisions` array.

## Return value

Keep the existing compatibility keys below; `sessions_today` contains task records. Every field is required; unused fields are null or empty arrays.

<!-- brief-eval-schema:start -->
```json
{
  "report_summary": { "date": "<ISO>", "tags": ["<tag>"], "working_on": "<one-line>",
                       "status": "<completed|partial|blocked>", "next_start_point": "<text>" }|null,
  "sessions_today": [ { "session": "T-...", "summary": "<one-line>" } ],
  "findings": ["<text>"],
  "decisions": ["<text>"],
  "tomorrow": ["<text>"],
  "pending_proposals": ["<PROP-NNN: title>"],
  "operator_priorities": ["<text>"],
  "queued_work": ["<text>"],
  "waiting": ["<text>"]
}
```
<!-- brief-eval-schema:end -->
