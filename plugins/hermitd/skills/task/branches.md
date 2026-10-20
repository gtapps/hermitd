# Task branches

Rare-branch procedures for `task/SKILL.md`. Read only the section the skill names; each one is normative.

## Conversation command

- `helper-switch`: invoke `/hermitd:spawn-session --switch <n> --record <id>` with the annotation's flags; `<n>` is the owner minus `helper:`.
- `help`: list `!help`, `!mute`, `!unmute`, and `!restart`. `!model` and `!effort` switch the helper on a helper thread and are unsupported per conversation elsewhere. Global controls still affect the resident.
- `mute` / `unmute`: run `task-note` (Commands) with arguments `<id> --muted true|false`, then acknowledge. Take `<id>` from `task=` in a `[closed task thread …]` annotation when present. Muting suppresses unmentioned steering.
- `restart`: when the record's `owner` names a listed agent, stop it with `TaskStop`; no match means it is already gone. On a stop failure, report it and start nothing. Then follow § Replace an unreachable worker.

## Replace an unreachable worker

Write the output of `conversation` (Commands) with arguments `history --source '<source>' --chat-id '<chat_id>' --limit 100` to `.hermit/helper-reports/<id>-history.md` (its `rows` may be empty). Dispatch a fresh worker as `SKILL.md` **Dispatch the worker** says, with the record's notes and that path, then run `task-note` (Commands) with arguments `<id> --owner worker:<new-agentId>`.

## Standup and duties

`standup --json` groups promised, late and waiting work by stable identity. Execution is advisory. A shared turn divides its cost equally across its bound tasks; a missed progress note may bill to conversation. `pre_upgrade: true` means some cost rows in the window carry no bucket.

Duties open deduplicated records only when a human must act and `config.tasks.duties_open_records` permits it. Otherwise post plain messages. An ambiguous duty read never closes a record.
