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

A `claimed` result permits commands without `--session`. A `busy` result names `holder`: block the current task through `task.ts block` with `--waiting-on <holder>`, `--status-line` explaining the busy browser and `--next` describing the retry. Report that it is waiting. Release after the task with `browser.ts release`; this clears the next task's wait. `browser.ts status` reports the current claim. Commands renew the claim; 15 minutes idle expires it. Reclaim after expiry before continuing.

For public, anonymous work use a unique `--session <name>` (letters, numbers, hyphens and underscores). These sessions are headless and separate from the signed-in profile. At most three are live at once; close your session when finished. On `session_cap`, wait for a slot rather than retrying with the shared profile.

Read upstream command guidance with `agent-browser --session <name> skills get core`; do not guess command syntax. Use a named session for this read because commands without one require a claim.

After a browser restart, the next command lands on a blank page. Reopen the task URL and check the page before continuing; the profile keeps sign-ins. A hard kill within about 30 seconds of login can lose the sign-in.

If `agent-browser` is missing, explain that this install has no managed browser. New Docker setups include it unless `docker.browser` is false; an existing Docker operator can explicitly rerun `/hermitd:docker-setup`. Host installs need their own browser setup. Do not install packages or switch to the operator's Chrome silently.

The wrapper coordinates supported CLI use, not hostile code: the real binary and raw CDP can bypass it. It provides no password vault or confidentiality boundary between chats.
