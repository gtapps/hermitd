# Task branches

Rare-branch procedures for `task/SKILL.md`. Read only the section the skill names; each one is normative.

## Conversation command

- `helper-switch`: invoke `/hermitd:spawn-session --switch <n> --record <id>` with the annotation's flags; `<n>` is the owner minus `helper:`.
- `!help`: list `!help`, `!mute`, `!unmute`, and `!restart`. `!model` and `!effort` switch the helper on a helper thread and are unsupported per conversation elsewhere. Global controls still affect the resident.
- `!mute` / `!unmute`: run `task-note` (Commands) with arguments `<id> --muted true|false`, then acknowledge. Muting suppresses unmentioned steering.
- `!restart`: when the record's `owner` names a listed agent, stop it with `TaskStop`; no match means it is already gone. On a stop failure, report it and start nothing. Then dispatch a fresh worker as `SKILL.md` **Replace an unreachable worker** does, history file included, and run `task-note` (Commands) with arguments `<id> --owner worker:<agentId>`.
