---
name: browser
description: Use the hermit's own browser for web tasks, or the operator's Chrome when their account is needed.
---

# Browser

Use the hermit's own `agent-browser` by default. Use Claude in Chrome only for the operator's own account, only when `config.chrome` is on and its tools are available. Never switch browsers after a failure: report the blocker and wait.

At a login, leave the login page open. Never request passwords. If `docker.browser_port` is unset, stop and explain phone sign-in setup in the same conversation using [setup.md](setup.md). Do not invent a viewer link or silently switch browsers.

When set up, choose an admin from `docker.browser_admins` who has a mention for the current channel. Use that channel's stored mention verbatim, with no platform-specific wording. If none is available, ask the operator to complete setup in this conversation. Block the task before sending the link:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <task-id> --waiting-on <admin-login> --status-line 'Waiting for browser sign-in' --next 'Take over, sign in, then Hand back'
```

Post in the same conversation, mentioning that admin, with `https://<host>:<docker.browser_port>/?task=<task-id>`. Use the verified host address saved during setup. Ask them to tap Take over, sign in, then Hand back. The link names the task even if its claim expires while the admin is away. Do not poll the page or retry a `human_has_control` refusal: wait for the declared monitor's event. A task with no sign-in request of its own claims the profile instead and follows the result. Anonymous named sessions may continue independently.

For a `browser-handback` event, ignore a null `task`. For a non-null task and `waiting_since`, clear only that exact wait before taking any other action:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <event-task> --clear-waiting --if-waiting-since <event-waiting_since>
```

On a `stale_wait` or `not_open` refusal, take no action, including no page read or reply; replay and an event for an older wait are harmless. On a successful clear, claim the profile for that task again if its claim expired. Respect `busy` by queuing; never touch another holder's page. For `hand_back`, verify the expected page and account with `agent-browser --task <event-task> snapshot` before resuming the task once. Hand back leaves Chrome and its page running; do not restart it. For `released`, `expired` or `browser_lost`, clear with the same conditional command, never report login success, and re-check the page with `agent-browser --task <event-task> snapshot` before asking for sign-in again. Browser loss may leave a blank page; reopen the task URL with `agent-browser --task <event-task> open <url>` and verify it.

For opt-in phone sign-in setup, follow [setup.md](setup.md): collect admins in chat, use `settings-edit` behind its native prompt, print one host command once, verify it, and declare the `browser-handback` stream monitor.

Before signed-in work, claim the shared profile with:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts claim <task-id>
```

A `claimed` result permits commands that pass `--task <task-id>` instead of `--session`, for example `agent-browser --task <task-id> open <url>`. `browser_not_claimed` with a `holder` means another task holds the profile: claim again and do not touch its page. A `busy` result names `holder`: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <task-id> --waiting-on <holder> --status-line ... --next ...`, with the status line explaining the busy browser and the next step describing the retry. Report that it is waiting. A `human` result means a person has control and queues the task: block the same way with `--waiting-on <human.login>`; the wait clears after control returns. Release after the task with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts release <task-id>`; this clears the next task's wait. A `not_holder` result means your claim expired and `holder` took over: leave its claim alone. `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts status` reports the current claim. Commands renew the claim; 15 minutes idle expires it and the next heartbeat wakes a waiter. Reclaim after expiry before continuing.

For public, anonymous work use a unique `--session <name>` (letters, numbers, hyphens and underscores). These sessions are headless and separate from the signed-in profile. At most three are live at once; close your session when finished, because an unclosed one holds its slot until it has been idle for an hour. On `session_cap`, wait for a slot rather than retrying with the shared profile.

Read upstream command guidance with `agent-browser --session <name> skills get core`; do not guess command syntax. Use a named session for this read because the shared profile requires a claim.

After a browser restart, the next command lands on a blank page. Reopen the task URL and check the page before continuing; the profile keeps sign-ins. A hard kill within about 30 seconds of login can lose the sign-in.

If `agent-browser` is missing, explain that this install has no managed browser. New Docker setups include it unless `docker.browser` is false; an existing Docker operator can explicitly rerun `/hermitd:docker-setup`. Host installs need their own browser setup. Do not install packages or switch to the operator's Chrome silently.

The wrapper coordinates supported CLI use, not hostile code: the real binary and raw CDP can bypass it. It provides no password vault or confidentiality boundary between chats.
