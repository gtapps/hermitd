# Watch notices

Follow the shared rules and Watch duty records in [SKILL.md](SKILL.md).
That skill handles Monitor expiry before selecting one of the handlers below.
Read only the selected handler.

Before every entry removal, call `TaskStop` on its `poll_task_id` when present.
An error means the poll already exited; remove the entry anyway.

### Handling self-exit notifications

This handler applies only to ad-hoc/session entries in `state/monitors.runtime.json`. Config watch commands are restarted by the poller; `WATCH_MONITOR_ERROR` is not a registry self-exit.

For a script crash or clean exit, after excluding expiry notices in SKILL.md,
CC sends a completion notification into the conversation. On seeing this:

1. Match the `task_id` from the notification against the runtime registry
2. If found: remove the entry and write registry back
3. Log to the open task record: `[HH:MM] Watch <id> exited`

If the notification is missed (compaction, context pressure), the stale entry is
harmless. The next session start clears the registry unconditionally.

### Handling helper poll exits

Match the completion's task id to a live `poll_task_id`, then read its output. Ignore unmatched completions.

- On `blocked <waitingFor>`, clear only `poll_task_id` and keep the subscription. Send one operator notice in the task thread when available, otherwise per Operator Notification. Name the blocker and offer Remote Control (when enabled), `claude attach <id>` (inside the container for Docker), or a reply here. For a reply, use spawn-session § Resume with new instructions with the blocked-reply input and the record metadata. Include the task id, `helper:<n>` and operator language in the prompt, and capture a fresh baseline before resuming. If the resume fails or runs unwatched, report that outcome.
- On `ended <state>`, use the matched entry for § Handling idle notices’ receipt lookup and delivery rules, consuming it once before reporting. Do not apply the idle-only retry or queued switch. For `failed`, `stopped` or `gone`, use one short failure line in place of “finished without a report” only for an unchanged baseline. Leave the record open and append the ended state through `task-note` (Commands) when it is still open. A completed turn uses the ordinary receipt path.

### Handling idle notices

1. Match the session to a live `peer-idle` entry by target name. Ignore unmatched notices. On subscription expiry, say it expired before completion, append a progress note to each still-open record, stop the poll and remove the entry without applying a queued switch.
2. For each distinct `{record, prior_report}` pair, use `task-list` (Commands) to read `task list --all --id <T> --json --with-decisions`. Closed records can have a new report too. Treat a missing baseline as the current id. A report is new only when its non-null `report_id` differs from the baseline.
3. For the one follow-up retry, inspect the new `report_verdict` when the report id changed, otherwise the idle notice's quoted first line. Retry only when a stored follow-up exists, no retry has run and that text says auto mode denied an action during the work or the helper declined because the instructions came by message. Never retry a denied report submission. Save `retry: true` first. Resume with the operator's stored instructions for the affected record, including the task id, `helper:<n>` and operator language. Capture fresh baselines for the replacement watch and preserve any other records and queued switch. Log the attempted retry on the open record. If a replacement watch is live, defer that record's notice to it. Otherwise report the resume outcome and use the receipt rules. Identify a result that came after one retry.
4. Stop the poll and consume the entry before reporting. For each unchanged baseline, give one plain line saying the named helper finished without a report (use the terminal failure line when applicable). Apply § Report receipts to each new report. A general session watch without records quotes its one-line status when available. For triage, append the verdict to the source task as a progress note and never apply a suggested dismissal.
5. After an idle notice, apply a queued switch with `spawn-session --switch` using the stored flags. Operator answers about numbered decisions go to the same helper with the task id, `helper:<n>` and operator language via spawn-session § Follow-ups. The report never grants consent.

### Handling cloud report notices

- `CLOUD_REPORT_STORED <T>`: use `.hermit/bin/hermitd-run task list .hermit --all --id <T> --json --with-decisions` to look up the task and its current `report_id`. When it has a report, follow § Report receipts using the returned row. Keep the report body unread.
- `CLOUD_REPORT_FAILED <T> <reason>`: send one plain line in the operator's language that the report was not stored and why; for `closed`, say it arrived after the task closed. Leave the task's status as it is.

### Report receipts

Use the row's `delivery` and take one action in the operator's language:

- `sent`: edit the card through the channel's `edit_message` when both card ids exist. Run checks and closure as appropriate for the current record; an already-closed record needs no closure. Do not read the body.
- `relay` or `no_channel`: give a short report-back with the verdict, up to five numbered decision titles, the task handle and the helper session's name for a helper. Offer “say 'full report' to get it”. Use the task conversation's reply tool with its thread parameters for relay, or print it in the resident session with no channel. Do not read the body to compose this reply.
- `pending`: say the report is stored and delivery is unconfirmed. Do not resend.
- `partial` or `failed`: say delivery was incomplete or failed and the report is on the task.

When the row has `attachments`, deliver them once in this turn. Use the task conversation's reply tool file parameter and its thread parameters. Give a short caption naming the task, folded into the existing report-back for `relay` or `no_channel`. In the Claude app or terminal, use `SendUserFile` when available. If the reply tool has no file parameter or there is no channel or available native file tool, describe the files in words without exposing their paths. Use calls within any per-call limit stated by the tool's schema or error, with one attempt per file and no retries. If delivery fails, say the files may not all have attached and are on the task. Keep the report body unread for the receipt.

The script already recorded the result or wait. Retain the task's confirmation or check rules. If the operator asks for the full report, resolve the task in their conversation, look up its current `report_id` and `attachments` with `--with-decisions` (including closed records), read `.hermit/helper-reports/<report_id>.md`, and return it verbatim via that task's own conversation reply tool, with thread parameters, or print it when the task has no channel. Include any attachments using the same delivery rules. Use an authorized request for that conversation and never send its report to another chat.
