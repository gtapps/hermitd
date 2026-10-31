---
name: browser
description: Use the hermit's own browser for web tasks, or the operator's Chrome when their account is needed.
---

# Browser

Use the hermit's own `agent-browser` by default. Use Claude in Chrome only for the operator's own account, only when `config.chrome` is on and its tools are available. Never switch browsers after a failure: report the blocker and wait.

Stop at logins. Ask the operator in the same conversation how to proceed; do not request passwords or invent a phone takeover link. Phone takeover is not available in this stage.

Before signed-in work, claim the shared profile with:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts claim <task-id>
```

A `claimed` result permits commands that pass `--task <task-id>` instead of `--session`, for example `agent-browser --task <task-id> open <url>`. `browser_not_claimed` with a `holder` means another task holds the profile: claim again and do not touch its page. A `busy` result names `holder`: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <task-id> --waiting-on <holder> --status-line ... --next ...`, with the status line explaining the busy browser and the next step describing the retry. Report that it is waiting. Release after the task with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts release <task-id>`; this clears the next task's wait. A `not_holder` result means your claim expired and `holder` took over: leave its claim alone. `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts status` reports the current claim. Commands renew the claim; 15 minutes idle expires it and the next heartbeat wakes a waiter. Reclaim after expiry before continuing.

For public, anonymous work use a unique `--session <name>` (letters, numbers, hyphens and underscores). These sessions are headless and separate from the signed-in profile. At most three are live at once; close your session when finished, because an unclosed one holds its slot until it has been idle for an hour. On `session_cap`, wait for a slot rather than retrying with the shared profile.

Read upstream command guidance with `agent-browser --session <name> skills get core`; do not guess command syntax. Use a named session for this read because the shared profile requires a claim.

After a browser restart, the next command lands on a blank page. Reopen the task URL and check the page before continuing; the profile keeps sign-ins. A hard kill within about 30 seconds of login can lose the sign-in.

If `agent-browser` is missing, explain that this install has no managed browser. New Docker setups include it unless `docker.browser` is false; an existing Docker operator can explicitly rerun `/hermitd:docker-setup`. Host installs need their own browser setup. Do not install packages or switch to the operator's Chrome silently.

The wrapper coordinates supported CLI use, not hostile code: the real binary and raw CDP can bypass it. It provides no password vault or confidentiality boundary between chats.
