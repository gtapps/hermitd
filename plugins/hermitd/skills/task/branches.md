# Task branches

Conditional procedures for `task/SKILL.md`. Read only the section the skill names; each one is normative.

## Reuse an idle helper

When `remote_environments` has entries and `.hermit/bin/hermitd-run cloud-session lookup .hermit --task <T>` matches a continuation's task, follow [cloud-environment.md](../spawn-session/cloud-environment.md) § Status and follow-ups instead.

For new work, unless the requester asks for a fresh helper, run `helper-eligible` (Commands) with `--folder <absolute-work-folder> --conversation <key>`. Use the work's base chat and omit `--conversation` for terminal work. Only on `eligible: true`, check that the matching bg id in `claude agents --json` has `status == "idle"` and judge whether that helper already works on this area. If both hold, use the new record and its thread if it has one, download any attachments, bind the record with `task-note` (Commands) `<id> --owner <helper>` using the `helper` value `helper-eligible` returned (never the bg id), and follow [reuse-spawned-helper.md](../spawn-session/reuse-spawned-helper.md) with the candidate bg id. Otherwise continue ordinary intake.

## Steer the bound session

Confirmations and parking work as for `owner=resident`; `!` commands follow **Conversation command**.

When `remote_environments` has entries and `.hermit/bin/hermitd-run cloud-session lookup .hermit --task <T>` matches, follow [cloud-environment.md](../spawn-session/cloud-environment.md) § Status and follow-ups with the operator's words verbatim, note the steer and stop here.

Before sending a steer or answer, run `task-list` (Commands) with `--id <T> --json` and capture its `report_id` as `prior_report`. Then read the helper's row in `claude agents --json`. With no row the session is gone and a send is never delivered, even when SendMessage reports it queued: take the **No row** branch of [spawn-session/reuse-spawned-helper.md](../spawn-session/reuse-spawned-helper.md) with the operator's words as the instructions. Otherwise include the task id, `helper:<n>`, operator language and the operator's words verbatim in the SendMessage with `notify_when_idle: true`. Register it with the record and baseline even if the helper already has a live entry, using [watch/session-watch.md](../watch/session-watch.md) § Registering an existing idle subscription. Note the steer. If it cannot resume, return ownership to the resident, say so and offer a worker. Approvals happen in the session (attach or Remote Control). A confirmation asking for the next phase closes the record and routes the new work at intake.

## Take a worker's result

Check that the named record's `owner` or `last_worker` is the sender; a stored report has already returned the record to the resident. When `owner` is still the sender, run `task-note` (Commands) with `<task-id> --owner resident`. If the completion carries `Delivery: blocked <reason>` with report id `none`, send one plain line in the operator's language that the report was not stored and why, leave the task open, and skip the receipt lookup and closure. Otherwise, with `task-list` (Commands), look up the receipt using `--all --id <task-id> --json --with-decisions`. Match the returned report id to the completion and follow [watch/notices.md](../watch/notices.md) § Report receipts. Never read or record a sent result again. For `Unreachable:`, give the maintainer-only notice and wait on `maintainer`. Follow the task skill's Closure rules for checks and confirmations.

## Conversation command

- `helper-switch`: invoke `/hermitd:spawn-session --switch <n> --record <id>` with the annotation's flags; `<n>` is the owner minus `helper:`.
- `help`: list `!help`, `!status`, `!scheduled`, `!mute`, `!unmute`, and `!restart`; outside task threads, use `!restart` for the sole open task or `!restart <handle>`. `!model` and `!effort` switch the helper on a helper thread and are unsupported per conversation elsewhere. Global controls still affect the resident.
- `mute` / `unmute`: only in a task thread, run `task-note` (Commands) with arguments `<id> --muted true|false`, then acknowledge. Take `<id>` from `task=` in a `[closed task thread …]` annotation when present. Muting suppresses unmentioned steering.
- `restart`: take `<id>` from `task=` in the annotation when present. When the record's `owner` names a listed agent, stop it with `TaskStop`; no match means it is already gone. On a stop failure, report it and start nothing. Then follow § Replace an unreachable worker.

## Replace an unreachable worker

Write the output of `conversation` (Commands) with arguments `history --source '<source>' --chat-id '<chat_id>' --limit 100` to `.hermit/helper-reports/<id>-history.md` (its `rows` may be empty). Dispatch a fresh worker as `SKILL.md` **Dispatch the worker** says, with the record's notes, that path, the operator language and the requester's message unchanged, then run `task-note` (Commands) with arguments `<id> --owner worker:<new-agentId>`.

## Standup and duties

`standup --json` groups promised, late and waiting work by stable identity. Execution is advisory. A shared turn divides its cost equally across its bound tasks; a missed progress note may bill to conversation. `pre_upgrade: true` means some cost rows in the window carry no bucket.

Duties open deduplicated records only when a human must act and `config.tasks.duties_open_records` permits it. Otherwise post plain messages. An ambiguous duty read never closes a record.

## Busy thread

On `thread_busy` from `thread-open` or `task.ts open`, keep the original thread as the reply destination for the handoff notice.

- With `chat_id`, post the new task’s “On it” card at the top level of that chat, with no thread reply parameter. Re-run `thread-open` with that chat and the card’s message id. Open the task with the returned key and `--card` pointing at the top-level card, then reply in the original thread naming the new task. Continue with the task’s intake dispatch or explicit after-this queue rule.
- With `reason: no_top_level`, say a separate task cannot be opened here and create no record. A Discord forum post cannot host a second task.

`task.ts open` reports only `status: refused, reason: thread_busy`; recover the destination by re-running `thread-open` for the original thread, then apply the result above.
