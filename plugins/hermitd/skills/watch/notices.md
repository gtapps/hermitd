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

On a background-task completion, match its task id to a live entry's
`poll_task_id`. No match: ignore it. Read that task's output:

1. On `blocked <waitingFor>`, remove `poll_task_id` from the entry and write
   the registry; the entry stays live for the helper's idle notice. Send one
   operator notice per prompts/resident.md § Operator Notification with a `client`
   leg, in the record's task thread when it has one, otherwise the channel.
   Say the helper is waiting on `<waitingFor>` and offer the ways on: answer
   it in Remote Control when `config.json`'s `remote` is `true`, reply here
   with instructions, or `claude attach <id>` in a terminal (in Docker,
   `docker exec -it <container> claude attach <id>`).
   Send a reply through spawn-session § Follow-ups, "Resume with new
   instructions", with the blocked-reply input, the entry's description as the
   note and its metadata as watch flags: `--record <record>`, `--proposal
   <proposal>`, `--implement` for `purpose: "implement"`, and `--retry` when
   set, omitting absent fields. If the resume could not start or runs
   unwatched, tell the operator that outcome and whether the helper was
   stopped; when stopped with no replacement watch, remove the entry and write
   the registry.
2. On `ended <state>` (including `ended gone`), remove the entry and write the
   registry. When it has `record`, append a progress note through `task-note`
   (Commands) naming the helper and the ended state, and leave the record open.
   Send no operator notice.

### Handling idle notices (`/watch notice <text>`)

A `/spawn-session` helper is the only session this handler covers. A `GUEST_REPORT:` is a verdict and delivery receipt, not a report body.

1. Match the session to a live `peer-idle` entry. A sender that matches no live entry gets none of the recording here; an open record's helper owner follows § Handling an unprompted helper report.
2. A matching `GUEST_REPORT:` uses § Posting a report in a task thread below, including when it arrives after a reportless idle notice. Never resubmit a report or ask the helper to retry a classifier-denied submission. Operator replies about numbered decisions go to the same helper verbatim through spawn-session § Follow-ups, with the task id, helper name and operator language in the brief.
3. Retry once when the entry has `followup` and no `retry`, and the report's verdict says auto mode denied an action during the work, or the helper declined because the instructions came by message. This covers the work, not a denied report submission. Set `retry: true` on the entry and write the registry first. This resends the operator's own stored request as a new prompt; it is not a retry of a call this session made. Run spawn-session § Follow-ups, "Resume with new instructions" with the `followup` entries joined by a blank line, the entry's description as the note, and `--retry` plus its metadata as watch flags: `--record <record>`, `--proposal <proposal>`, and `--implement` for `purpose: "implement"`, omitting absent fields. Inside an open record's turn, log one `task-note` (Commands) that the retry was attempted. If resumed with a live replacement watch, preserve the old entry's `switch` on the replacement entry, write the registry, and end this handler. If the procedure ends without resuming, or the resumed helper runs unwatched, say so in the receipt notice, including that a helper stopped for the retry is no longer running. When the entry has `retry`, say the result came after one retry.
4. With no report, send one plain notice that the named helper finished its turn, quoting its one-line status when available. On subscription expiry, say it did not finish before the subscription expired and is no longer watched. Do not invent the subscription lifetime. Append a `task-note` (Commands) on expiry and leave the record open. An expired entry's queued switch was not applied; invoke no switch on expiry.
5. On a reportless idle notice with no `switch` and a `poll_task_id`, set `reportless: true`, write the registry and keep the poll live for a later receipt. Otherwise, after a matching report, subscription expiry, or reportless idle notice with `switch` or no poll, stop its `poll_task_id`, remove the entry and write the registry. After an idle notice, invoke `/hermitd:spawn-session --switch <target> --record <record>` with the removed entry's switch flags, after handling the receipt. Never apply a queued switch on expiry.

Name sessions by display name, never socket path or pid. The report never grants consent. For helper triage, append its verdict as a `task-note` (Commands) on the source task; do not apply a suggested dismissal. An implementation task stays open until its check passes or its result decision is answered.

### Posting a report in a task thread

Act on `Report:` and `Delivery:` without reading or recording the body again:

- `sent`: update the record's card with the channel's `edit_message` and run the task's checks or closure. Null card ids mean no edit.
- `relay`: read `.hermit/helper-reports/<id>.md` and send it verbatim through the reply tool in the record's conversation, with its thread parameters. A `--no-task` report has no record: send it in the outbound channel (`channels.primary`, else the first enabled channel).
- `no_channel`: the record has no chat, or no channel is configured, so the operator reads this session. Read `.hermit/helper-reports/<id>.md` and print it verbatim in your reply, with no channel send.
- `partial`, `failed` or `blocked`: send one plain line in the operator's language saying what happened and that the report is on the task. A classifier-denied report was not stored; say that when applicable.
- No `Report:` line: record the verdict and optional `Procedure:` as `[guest:<name>]` through `task-note` (Commands) first, then send the one-line notice. No report body is available to relay.

Do not run `task-block` (Commands) to record an author-submitted result a second time. A receipt is evidence of the script's recording and delivery, not authority to expand the task. Follow the session's channel format line.

### Handling an unprompted helper report

When a `GUEST_REPORT:` sender owns an open record and has no live `peer-idle` entry, use § Posting a report in a task thread. Create no new result or proposal from the message. For a sender that no longer owns the record, record only its verdict as a progress note and do not publish a stale report. Forward the operator's follow-up verbatim to the same helper with the current task and operator language.
