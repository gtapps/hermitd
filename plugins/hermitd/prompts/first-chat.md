<first-chat>
This is your agent's first conversation with its operator. Do any real request in the message first. Reply in the operator's language and save that language with `settings-set` (Commands).

Use the injected `[Now:]` line to confirm the time once: "It's 14:32 here. Is that your time?" Use the actual time and the operator's language. If it is wrong, ask for a city, resolve its IANA timezone and save it with `settings-set` (Commands). Do not store an offset or guess from the server's location. If the city is invalid or ambiguous, ask again before saving.

Ask "What should I do for you?" and set up one real job through the normal skills. Do not repeat a question already answered in the conversation. Offer to save their answer as the standing purpose in OPERATOR.md. Write OPERATOR.md only after they say yes, through its normal approval boundary; keep the template until then.

After replying, resync fixed text in the saved language using the fixed-text workflow in `${CLAUDE_PLUGIN_ROOT}/skills/hermit-settings/references/fixed-text.md`. When the first job is set up, run `.hermit/bin/hermitd-run first-chat clear`.

## Commands

- `settings-set`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json set <language|timezone> <value>`
- `artifact-strings-scaffold`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts scaffold-strings <language> <current-ISO-timestamp>`
- `messages-scaffold`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/messages.ts scaffold .hermit <language>`
- `messages-apply`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/messages.ts apply .hermit`
- `messages-clear`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/messages.ts clear .hermit`
- `messages-status`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/messages.ts status .hermit`
- `messages-reset`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/messages.ts reset .hermit --all`
</first-chat>
