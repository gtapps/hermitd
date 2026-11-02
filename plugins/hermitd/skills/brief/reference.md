# Brief evaluation reference

Return structured JSON for the calling skill to compose and deliver.

## Inputs

The caller supplies `plugin_root` (absolute) and `mode` (`morning`, `evening`, `daily`).

Run `brief-digest` (Commands) once, appending the mode. Keep the project root as the working directory; `plugin_root` locates the script, while `.hermit` is the project's state directory. This is the only task, duty and proposal data read. Do not open task files, proposal files, caches or frozen session archives to supplement it. For morning priorities, also read `.hermit/OPERATOR.md` if present. Apply the decision refresh below when requested.

Use the digest's `duties` for requested and observed duties, returning any discrepancy in `findings`; a `skipped-precheck` `last_event` is healthy (the routine ran its precheck and had nothing to do), not a discrepancy. `last_woke` moves only when a run completes cleanly, so an old `last_woke` beside a recent `skipped-precheck` is healthy, and beside a recent `failed-*` event is a discrepancy. Return each duty as one line with its name, requested settings and observed liveness in `duties`.

Open, waiting and queued items come only from the digest's `open` rows returned in this run. Never take them from an earlier brief (`state/last-brief.json`, `compiled/brief-*`). A `result_truncated` result is an excerpt, never complete evidence. Return the digest's `omitted` counts unchanged so main can say when items were left out; do not recover omitted data with more reads.

## Per-mode instructions

For morning, put each digest `proposals` row in `pending_proposals` as `<id>: <title>`. When the dispatch names `decision-refresh.md` and there is at least one `decision_items` or `pending_proposals` entry, read it and apply it to the `decision_items` followed by each `pending_proposals` entry as `proposal-pending:<PROP-NNN>`. Use `.hermit/OPERATOR.md` for `operator_priorities` if present. Populate `queued_work` from `open` rows with `state: runnable`. Summarize `latest` in `report_summary`.

For evening and daily, use the digest's `records`, which selects the day in the configured timezone. Populate `tasks_today` with each record's `id` as `task` and one-line summaries from `closed_reason` for a cancelled record, otherwise from the record's `result` when set, otherwise from the title plus the check output after `check:exit-0:` in `closed_reason` for a record closed by `check`, otherwise from title and outcome. For a record with `result_truncated`, the summary is its title and outcome, with nothing taken from the excerpt. Populate `findings` from the selected records' lessons, skipping any lesson the record's `result` contradicts, without filtering lessons by date. Populate `tomorrow` from `open` rows with `state: runnable`, leaving other states to `waiting`. Do not count `cancelled` or `unconfirmed` as done.

For morning, evening and daily, populate `waiting` from the digest's `open` rows whose `state` is `finishing`, `unconfirmed` or `waiting`. Copy `title`, `state` and `waiting_on`, one entry per row.

For morning, evening and daily, populate `decisions` from the digest's recent decision rows as `<task title>: <what changed, why>`, dropping the actor from `text`; otherwise an empty array. The leading timestamp has already been removed.

For the morning `report_summary`, map `done` to `completed`, waiting work to `blocked`, and other outcomes to `partial`, naming the actual outcome in the summary. Use `closed_at`, else `opened_at`, for date, empty tags, title for working_on, and waiting reason or open work for next_start_point. No records means null summary, never an archive fallback.

## Return value

Every field is required; unused fields are null or empty arrays. When you applied `decision-refresh.md`, also return its `refresh` key.

<!-- brief-eval-schema:start -->
```json
{
  "report_summary": { "date": "<ISO>", "tags": ["<tag>"], "working_on": "<one-line>",
                       "status": "<completed|partial|blocked>", "next_start_point": "<text>" }|null,
  "tasks_today": [ { "task": "T-...", "summary": "<one-line>" } ],
  "findings": ["<text>"],
  "decisions": ["<text>"],
  "tomorrow": ["<text>"],
  "pending_proposals": ["<PROP-NNN: title>"],
  "operator_priorities": ["<text>"],
  "queued_work": ["<text>"],
  "waiting": [ { "title": "<text>", "state": "<finishing|unconfirmed|waiting>", "waiting_on": "<key>"|null } ],
  "duties": ["<one line: name, requested, observed>"],
  "omitted": { "clipped": 0, "lessons": 0, "records": 0, "decisions": 0, "open": 0, "proposals": 0, "duties": 0 }
}
```
<!-- brief-eval-schema:end -->
