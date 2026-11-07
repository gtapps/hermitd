---
name: browser
description: Drives the agent's own browser, or the operator's Chrome for their accounts. Use when WebFetch or WebSearch fails, times out, or returns a 403, an empty page or a JavaScript-only shell; when a page needs clicks, forms, scrolling or sign-in; or when a screenshot or exact rendered text is needed. Public read-only lookups start with WebSearch or WebFetch.
---

# Browser

Read the top-level `browser` object in config. `browser.enabled` defaults to true and `browser.default` to `agent-browser`. Follow `browser.default` for ordinary tasks; the operator's own account uses Claude in Chrome only when `chrome: true` and its tools are available. Never switch between the agent's browser and the operator's Chrome, or back to a fetch tool, after a browser failure: report the blocker and wait. When `browser.enabled` is false and Claude in Chrome is unavailable, follow the `disabled` row below and do not retry the fetch. Treat a captcha or bot-check page like a login page: a person clears it through Take over in the agent's browser, or report the blocker. Opening a page WebFetch could not pass in the agent's browser is the normal escalation; never route around the check through the operator's Chrome, another fetch tool, another URL spelling, a cache or archive copy, or a fresh session. Each managed command on Docker and hosts is `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser-agent.ts`; never invoke the operator’s own binary.

At a login in an anonymous `--session`, claim the shared profile first, then reopen the URL with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser-agent.ts --task <task-id> open <url>`. Only then request sign-in, so Take over shows the correct page. Respect `busy` and `human` before reopening. On macOS, takeover is unsupported: use configured Claude in Chrome for the operator’s account or report the blocker. Never request a login to an invisible anonymous page.

At a login in the persistent profile, leave the login page open. Never request passwords. If `browser.port` is unset, stop and explain phone sign-in setup in the same conversation using [setup.md](setup.md). Do not invent a viewer link or silently switch browsers.

When set up, choose an admin from `browser.admins` who has a mention for the current channel. Use that channel's stored mention verbatim, with no platform-specific wording. If none is available, ask the operator to complete setup in this conversation. Block the task before sending the link:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <task-id> --waiting-on <admin-login> --status-line 'Waiting for browser sign-in' --next 'Take over, sign in, then Hand back'
```

Post in the same conversation, mentioning that admin, with `https://<host>:<browser.port>/?task=<task-id>`. Read `<host>` from `browser.host` in config, saved by the verified host setup command; never use a knowledge-file address. If `browser.host` is null, finish setup first. Ask them to tap Take over, sign in, then Hand back. The link names the task even if its claim expires while the admin is away. Do not poll the page or retry a `human_has_control` refusal: wait for the declared monitor's event. A task with no sign-in request of its own claims the profile instead and follows the result. Anonymous named sessions may continue independently.

For a `browser-handback` event, ignore a null `task`. For a non-null task and `waiting_since`, clear only that exact wait before taking any other action:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <event-task> --clear-waiting --if-waiting-since <event-waiting_since>
```

On a `stale_wait` or `not_open` refusal, take no action, including no page read or reply; replay and an event for an older wait are harmless. On a successful clear, claim the profile for that task again if its claim expired. Respect `busy` by queuing; never touch another holder's page. For `hand_back`, verify the expected page and account with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser-agent.ts --task <event-task> snapshot` before resuming the task once. Hand back leaves Chrome and its page running; do not restart it. For `released`, `expired` or `browser_lost`, clear with the same conditional command, never report login success, and re-check the page with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser-agent.ts --task <event-task> snapshot` before asking for sign-in again. Browser loss may leave a blank page; reopen the task URL with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser-agent.ts --task <event-task> open <url>` and verify it.

For opt-in phone sign-in setup, follow [setup.md](setup.md): collect admins in chat, use `settings-edit` behind its native prompt, print one host command once, verify it, and declare the `browser-handback` stream monitor.

Before signed-in work, claim the shared profile with:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts claim <task-id>
```

A `claimed` result permits commands that pass `--task <task-id>` instead of `--session`, for example `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser-agent.ts --task <task-id> open <url>`. `browser_not_claimed` with a `holder` means another task holds the profile: claim again and do not touch its page. A `busy` result names `holder`: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <task-id> --waiting-on <holder> --status-line ... --next ...`, with the status line explaining the busy browser and the next step describing the retry. Report that it is waiting. A `human` result means a person has control and queues the task: block the same way with `--waiting-on <human.login>`; the wait clears after control returns. Release after the task with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts release <task-id>`; this clears the next task's wait. A `not_holder` result means your claim expired and `holder` took over: leave its claim alone. `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser.ts status` reports the current claim. Commands renew the claim; 15 minutes idle expires it and the next heartbeat wakes a waiter. Reclaim after expiry before continuing.

For public, anonymous work use a unique `--session <name>` (letters, numbers, hyphens and underscores). These sessions are headless and separate from the signed-in profile. At most three are live at once; close your session when finished, because an unclosed one holds its slot until it has been idle for an hour. On `session_cap`, wait for a slot rather than retrying with the shared profile.

Read upstream command guidance with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser-agent.ts --session <name> skills get core`; do not guess command syntax. Use a named session for this read because the shared profile requires a claim. Substitute `bun ${CLAUDE_PLUGIN_ROOT}/scripts/browser-agent.ts` for every `agent-browser` executable in upstream’s `skills get core` text, including command examples; its flags still pass through this wrapper.

After a browser restart, the next command lands on a blank page. Reopen the task URL and check the page before continuing; the profile keeps sign-ins. A hard kill within about 30 seconds of login can lose the sign-in.

Handle wrapper results before continuing:

| Result | Action |
|---|---|
| `installing` | Rerun after one minute, at most three tries, then report that installation is still pending. |
| `disabled` | Say the page needs a browser, the agent's browser is off, and the agent can turn it on when asked. It takes effect after the next restart, or the next update on Docker. Change it only when asked. |
| `browser_install_failed:<detail>` | Report the download or prerequisite failure; ask the operator to run `hermitd run browser-host`. Do not install packages from the task. |
| `browser_sandbox_blocked` | Relay both fixes in the detail: terminal `hermitd run browser-host`, and the `bun */scripts/browser-agent.ts *` line in `sandbox.excludedCommands`. Never disable Chrome’s sandbox. |
| `takeover_unsupported` | macOS has no phone takeover. Use configured Claude in Chrome for the operator’s account or report the blocker. |
| `browser_display_missing` | Read `reason` and `detail`. Docker `image_missing` or `image_rebuild_pending`: run `hermitd update` on the host; if the detail names a missing managed-browser block, ask the hermit to merge `Dockerfile.hermit` through `/hermitd:docker-customize` first. `display_start_failed`: Docker, report the startup failure and run `hermitd update`; tmux, run `hermitd run browser-host`. `unsupported`: interactive hosts support anonymous public browsing only; use always-on tmux for a host display. |
| `metadata_url_refused` | Report the blocked cloud metadata destination; do not retry through another browser or URL spelling. |
| `docker_host_session` | Run browser work inside the hermit container. |

For Linux/WSL2 host prerequisites and macOS limitations, read [host-setup.md](host-setup.md). This file is also the route for sandbox blockers. Setup is one terminal command; it never asks the hermit for a sudo password.

The wrapper coordinates supported CLI use, not hostile code: the real binary and raw CDP can bypass it. It provides no password vault or confidentiality boundary between chats.
