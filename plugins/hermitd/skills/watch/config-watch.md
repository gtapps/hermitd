# Saved watches

Return to [SKILL.md](SKILL.md) for status, stopping, and event handling. Save a watch when the watch itself is the request, even inside a task thread. A watch that is a step toward another outcome is temporary.

## Create

1. Choose a filename-safe lowercase id that never starts with `adhoc-`. Read `config.json` and avoid existing ids. Write a check that prints the current state and exits 0 when observed; exit nonzero when observation fails. The helper supplies `WATCH_LAST_STATE` with the last successful state for hysteresis. An operator's own script may be the check. For a stream source, keep a plain stream command instead.
2. Build an entry `{id, description, command, class, enabled, chat?}`. For a poll, use `.hermit/bin/hermitd-run watch-poll <id> --every <interval> -- <check>` with a default interval of `5m` and a minimum of `1m`. Commands run from the project root and inherit its environment; shell profile functions are unavailable. Use project-relative paths or `.hermit/bin/hermitd-run`, because the plugin path in skill text is versioned.
3. Use `enabled: true` for a primary sender or the terminal. Omit `chat` for the terminal or home chat; otherwise bind it to the asking chat's `<sourceKey>:<chat_id>`. For another admitted member, use `enabled: false` and bind `chat` to the asking chat. Never silently target another chat.
4. Append the JSON object as a single-quoted argument:

   ```bash
   .hermit/bin/hermitd-run settings-edit .hermit/config.json append monitors '<entry>'
   ```

   On `duplicate_id`, read the matching entry: if its command is identical, say it is already being watched and do not write. Otherwise choose a new id and retry once. On an error, report it. A native prompt may appear; No is final, with no substitute path.
5. For a member's disabled watch, queue one micro-proposal and send the same neutral yes/no question in the asking chat. Write the question in the chat's language and name what the watch checks. Replace placeholders with the actual question, id and chat:

   ```bash
   .hermit/bin/hermitd-run proposal queue-micro .hermit <<'HERMIT_MP'
   {"tier":1,"question":"<yes/no question naming the watch>","on_resolve":"/hermitd:watch enable <id> --answer {answer}","chat":"<sourceKey>:<chat_id>","key":"watch-enable:<id>"}
   HERMIT_MP
   ```

   If queuing fails, report it and leave the watch disabled. Confirm the outcome with `/hermitd:watch status`.

## Enable

For `/hermitd:watch enable <id> --answer <answer>`, act only on a primary sender's yes in the watch's owning chat. A no is final: leave the watch disabled. If a non-primary sender answers yes, leave it disabled and queue the same question again for a primary sender. Read the current `monitors[]`, find the id and its current index, then run:

```bash
.hermit/bin/hermitd-run settings-edit .hermit/config.json set monitors.<n>.enabled true
```

If the watch is absent, belongs to another chat, or is already enabled, report its status instead of writing. A declined native prompt is final, with no substitute. Confirm with `/hermitd:watch status`.
