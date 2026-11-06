# Task branches

Rare-branch procedures for `task/SKILL.md`. Read only the section the skill names; each one is normative.

## Conversation command

- `helper-switch`: invoke `/hermitd:spawn-session --switch <n> --record <id>` with the annotation's flags; `<n>` is the owner minus `helper:`.
- `help`: list `!help`, `!status`, `!scheduled`, `!mute`, `!unmute`, and `!restart`; outside task threads, use `!restart` for the sole open task or `!restart <handle>`. `!model` and `!effort` switch the helper on a helper thread and are unsupported per conversation elsewhere. Global controls still affect the resident.
- `mute` / `unmute`: only in a task thread, run `task-note` (Commands) with arguments `<id> --muted true|false`, then acknowledge. Take `<id>` from `task=` in a `[closed task thread …]` annotation when present. Muting suppresses unmentioned steering.
- `restart`: take `<id>` from `task=` in the annotation when present. When the record's `owner` names a listed agent, stop it with `TaskStop`; no match means it is already gone. On a stop failure, report it and start nothing. Then follow § Replace an unreachable worker.

## Replace an unreachable worker

Write the output of `conversation` (Commands) with arguments `history --source '<source>' --chat-id '<chat_id>' --limit 100` to `.hermit/helper-reports/<id>-history.md` (its `rows` may be empty). Dispatch a fresh worker as `SKILL.md` **Dispatch the worker** says, with the record's notes and that path, then run `task-note` (Commands) with arguments `<id> --owner worker:<new-agentId>`.

## Standup and duties

`standup --json` groups promised, late and waiting work by stable identity. Execution is advisory. A shared turn divides its cost equally across its bound tasks; a missed progress note may bill to conversation. `pre_upgrade: true` means some cost rows in the window carry no bucket.

Duties open deduplicated records only when a human must act and `config.tasks.duties_open_records` permits it. Otherwise post plain messages. An ambiguous duty read never closes a record.

## Busy thread

On `thread_busy` from `thread-open` or `task.ts open`, keep the original thread as the reply destination for the handoff notice.

- With `chat_id`, post the new task’s “On it” card at the top level of that chat, with no thread reply parameter. Re-run `thread-open` with that chat and the card’s message id. Open the task with the returned key and `--card` pointing at the top-level card, then reply in the original thread naming the new task. Continue with the task’s intake dispatch or explicit after-this queue rule.
- With `reason: no_top_level`, say a separate task cannot be opened here and create no record. A Discord forum post cannot host a second task.

`task.ts open` reports only `status: refused, reason: thread_busy`; recover the destination by re-running `thread-open` for the original thread, then apply the result above.
