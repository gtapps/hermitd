# Brief evaluation reference

Return structured JSON for the calling skill to compose and deliver. Read fresh bounded digests; never read frozen session archives .

## Inputs

The caller supplies `plugin_root` (absolute), `mode` (`morning`, `evening`, `daily`), `today` (ISO date), and morning `context_recovery`.

Run `task-report` (Commands) with arguments `--limit 20 --today` for normalized records and `task-list` (Commands) with arguments `--open --owner resident --json` for open resident work. Run `duties-summary` (Commands) for requested and observed duties, returning any discrepancy in `findings`; a `skipped-precheck` `last_event` is healthy (the routine ran its precheck and had nothing to do), not a discrepancy. `last_woke` moves only when a run completes cleanly, so an old `last_woke` beside a recent `skipped-precheck` is healthy, and beside a recent `failed-*` event is a discrepancy.

Open, waiting and queued items come only from the `task-list` and `task-report` rows returned in this run. Never take them from an earlier brief (`state/last-brief.json`, `compiled/brief-*`).

## Per-mode instructions

For morning, run `proposal-index` (Commands), then read `state/proposals-index.json`; put proposed auto-detected entries in `pending_proposals`. When the dispatch names `decision-refresh.md` and there is at least one `decision_items` or `pending_proposals` entry, read it and apply it to the `decision_items` followed by each `pending_proposals` entry as `proposal-pending:<PROP-NNN>`. Read `OPERATOR.md` for `operator_priorities` if present. Populate `queued_work` from runnable open resident records. If `context_recovery` is true, summarize the newest normalized record; otherwise `report_summary` is null.

For evening and daily, use `closed_today` and the open records in `opened_today` returned by `task-report`, which selects the day in the configured timezone. Populate `sessions_today` with task source paths as the compatibility `session` identifier and one-line summaries from `closed_reason` for a cancelled record, otherwise from the record's `result` when set, otherwise from the title plus the check output after `check:exit-0:` in `closed_reason` for a record closed by `check`, otherwise from title and outcome. Populate `findings` from the selected records' lessons, skipping any lesson the record's `result` contradicts, without filtering lessons by date. Populate `tomorrow` from runnable open records, leaving waiting ones to `waiting`. Do not count `cancelled` or `unconfirmed` as done.

For morning, evening and daily, populate `waiting` from `task-list` rows with a non-null `result` or `waiting_on`, one entry per row: `<title>: finishing up, nothing needed from you` when `listing` includes `finishing` and not `late`, `<title>: result awaiting confirmation` (adding ` from <waiting_on>` when set) when `result` is otherwise set, otherwise `<title>: waiting on <waiting_on>`.

For morning, evening and daily, populate `decisions` from report rows' decision lines stamped within the last day as `<task title>: <what changed, why>`, dropping timestamp and actor; otherwise an empty array.

For `report_summary`, map `done` to `completed`, waiting work to `blocked`, and other outcomes to `partial`, naming the actual outcome in the summary. Use `opened_at` for date, empty tags, title for working_on, and waiting reason or open work for next_start_point. No records means null summary, never an archive fallback.

## Return value

Keep the existing compatibility keys below; `sessions_today` contains task records. Every field is required; unused fields are null or empty arrays. When you applied `decision-refresh.md`, also return its `refresh` key.

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
