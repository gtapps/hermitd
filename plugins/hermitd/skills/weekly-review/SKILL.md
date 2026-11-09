---
name: weekly-review
description: Generate the weekly review report for the current ISO week. Writes to .hermit/compiled/review-weekly-YYYY-Www.md (dev-facing detail) and sends a plain-language channel summary (Delivered / Decisions / Waiting on you / Spend). Runs every Sunday at 23:00 via routine.
---

Record notes only inside an open record's turn, using `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id>` with the note on stdin. Otherwise skip record notes. Never edit a task file directly.

# Weekly Review

Generates the weekly review for the current ISO week.

## Commands
- `duties-summary`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/duties.ts summary .hermit`
- `task-report`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-report.ts .hermit --recent --limit 3`
- `artifact-render`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts render <type> .hermit`

## Steps

1. Run:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/weekly-review.ts .hermit
   ```

2. Report the review's `path`. When `knowledge_findings` is non-zero, summarize the review's **Knowledge Health** section to the operator; when `usage_docs` is, relay its **Usage** section: the script has already auto-archived the docs with no tracked use in the window (move-only, into `compiled/.archive/` — restoring one is moving the file back, and a restored doc is never archived again). Don't archive anything further yourself, and never on judgment alone: semantic changes (merging or rewriting topic pages, reclassifying a compiled conclusion as raw, tagging `foundational`) always wait for explicit operator approval. Tracked use for this section is compiled/ Reads including subagent reads; startup injection isn't tracked.

3. **Dispatch the week's topic semantic check** to `hermitd:skill-eval-runner` once, passing no `model` parameter so it inherits the session model. Point it only at `${CLAUDE_PLUGIN_ROOT}/skills/weekly-review/reference.md`, which reads topic pages for contradictions, stale claims and broken wikilinks, capped at three findings. Copy the Commands entries verbatim into the dispatch prompt. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/memory-dir.ts` and name the returned absolute `dir` for resolving memory links, plus the current ISO week from step 1. The check only reports; semantic rewrites from its findings still require operator approval.

   The runner returns:

<!-- weekly-review-eval-schema:start -->
```json
{
  "topic_findings": [ "<one-line finding>" ]
}
```
<!-- weekly-review-eval-schema:end -->

   **Failure policy:** on null or malformed JSON carry `topic_findings: []` and continue. Show `Topic pages:` in the channel summary only when findings are non-empty.

4. Prune channel-log rows by age, independently of the nightly transcript maintenance:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-log.ts .hermit prune <knowledge.channel_log_retention_days from config.json, default 90>
   ```
   A genuine DB failure is fail-open: report it and continue with the review.

5. Read the frontmatter needed for the channel summary from the freshly-written review file:
   - Read `.hermit/compiled/review-weekly-<current-week>.md` frontmatter (just written in step 1) — do not read the body; every value the channel message needs lives in frontmatter (`delivered_count`, `delivered`, `proposals_accepted`, `proposals_resolved`, `open_loops_count`, `total_cost_usd`, `usage_untouched_count`, `usage_auto_archived`, `skills_new`, `skills_archived`, `skills_often_patched`).
   - Also read the prior week's `compiled/review-weekly-*.md` frontmatter (sort by `week` descending, take the second file) for the Spend delta.
   - If no prior week file exists: omit the "vs prior week" comparison and show this week's spend only.
   - If the current-week file is missing (script failed): skip step 6 entirely and fall back to a plain note ("Weekly review didn't generate this week — nothing to send.").

6. **Channel voice rule:** the message below is for the person who owns this hermit, not a developer. Never emit task ids (`T-...`), raw token counts, cron strings, or file paths. Speak in plain outcomes and counts.

   Channel-send the combined weekly summary:
   - Refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, note it for the message below.
   - Publish the weekly-review artifact when `config.artifacts.weekly_review` is on: render it with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts render weekly .hermit` (the page id is `weekly`, not the config key), then follow the hash-gate/publish/state-write steps in `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md` under state key `weekly_review`; if it returns a URL, note it for the message below too.
   - Compose the message in these sections. Show a line only when it has something to report — except Dream and Spend, which always show (spend visibility matters even at $0):
     ```
     Delivered: <delivered_count> thing(s) — <up to 5 of the delivered names, comma-joined and plain; add "and N more" for the rest> [omit this whole line when delivered_count is 0]
     Decisions: <proposals_accepted> approved, <proposals_resolved> resolved this week [omit this whole line when both are 0]
     Waiting on you: <open_loops_count> thing(s) need a yes/no [omit this whole line when 0]
     Tidied: put <usage_auto_archived count> unused doc(s) away — <up to 5 of the usage_auto_archived names, comma-joined and plain; add "and N more" for the rest> — say "restore <name>" to bring one back [omit this whole line when the list is empty]
     Unused: <usage_untouched_count> doc(s) look dormant — say "archive them" if you want them tidied away [omit this whole line when 0]
     Skills: <skills_new> new, <skills_archived> put away, <skills_often_patched> often adjusted [omit when all are 0]
     Dream: <step 1 dream.runs> runs, <dream.flagged> flagged, <dream.changes> file changes
     Spend: $<total_cost_usd> this week (vs $<prior week's total_cost_usd>, if a prior file exists) — an estimate, not a bill
     ```
     Followed by the `Topic pages:` findings from step 3 when present, plus a final line listing whichever of the dashboard/weekly-review URLs were returned (e.g. `📎 <dashboard url> · 📎 <weekly-review url>` — omit either half that wasn't returned).
   - Deliver via `channel-send.ts --notice` (see prompts/resident.md § Operator Notification), with two
     audience parts:
     - `client` = the composed message **with the Spend line omitted**
     - `maintainer` = the **Spend line plus technical detail only**. When both audiences share
       a chat the script sends the two parts together, so neither repeats the other.
   - On `relay`, send the client text through the reply tool per § Operator Notification.
   - If a leg didn't land (`status` not `delivered` or a relayed reply; on an `error`, fix the payload and
     re-run instead), follow § Operator Notification's fallback (push if
     enabled, log to Findings) rather than a bespoke branch here — weekly-review is a recurring
     routine, not an alert, so still skip a `channel-send-unavailable` issue for this call.
   - To set a preferred channel, add `"primary": "<channel-name>"` inside `channels` in `config.json`.

7. Archive expired raw artifacts:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/archive-raw.ts .hermit
   ```
   Report how many were archived, retained, and skipped.

8. Archive superseded compiled artifacts:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/archive-compiled.ts .hermit
   ```
   Report how many were archived, retained, and skipped.

## Notes

- Safe to run manually at any time — re-runs overwrite the current week's review.
- `archive-raw.ts` only moves files — it never deletes. Archived files land in `raw/.archive/` and can be restored manually.
- `archive-compiled.ts` only moves files — it never deletes. Keeps the newest 2 artifacts per type; `foundational`-tagged artifacts and `topic` pages are always retained (living pages compact by merging, not archival). Archived files land in `compiled/.archive/` and can be restored manually.
- Usage tracking (`state/usage-metrics.jsonl`, fed by `usage-track.ts` on `Read`) sees compiled/ Reads — including subagent reads, since PostToolUse fires for sidechain tool calls (probed on CC 2.1.239). Startup injection isn't tracked, which is why `foundational` and `topic` artifacts are exempt.
- Auto-archival is usage-evidence-based and move-only: docs with no tracked read in `knowledge.usage_stale_days` (default 30) go to `compiled/.archive/`. It is gated three ways — the ledger must itself be that old, it must hold at least one recorded compiled read (no reads at all reads as a tracking gap, not as disuse), and at most 10 docs move per run. Restoring one is moving the file back; `state/usage-archived.json` remembers every stem already archived, so a restored doc is never taken again. Set `knowledge.usage_auto_archive: false` for suggest-only, and semantic changes stay operator-approved.

Learned skills retire only with create-ledger provenance, no pin, no routine naming them, no use or change in 30 days, recent `skillUsage` capture evidence, and no prior archive. At most ten move per run; others stay suggestions. Relay the script's Skills line. Maintainer restore hint: `hermitd skills <agent> restore <skill>`; in client chat offer to bring the named skill back in plain language. Never archive additional skills on judgment.
