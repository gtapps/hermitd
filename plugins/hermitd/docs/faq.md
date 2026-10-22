# FAQ

---

## Does this work on Windows?

Only via WSL2. Clone your project inside WSL2 (`/home/you/project`), not on the Windows filesystem. Docker Desktop with WSL2 backend works for always-on mode, with the caveat that it stops when Windows sleeps or you log out — a hermit expected to be up overnight wants a machine that stays up.

---

## How does bash sandboxing work?

The sandbox isolates bash tool calls at the OS level — `sandbox-exec` on macOS (built in, nothing to install) and `bwrap` + `socat` on Linux/WSL2. Hermit doesn't manage it: run Claude Code's own `/sandbox` command to enable it (its Dependencies tab checks `bwrap`/`socat` for you), or see the [sandbox docs](https://code.claude.com/docs/en/sandboxing).

If your tooling uses a custom certificate authority (e.g. `gcloud` with a MITM proxy), you may need `"enableWeakerNetworkIsolation": true` in your `sandbox` settings block — see the [Claude Code sandbox docs](https://code.claude.com/docs/en/settings#sandbox-settings).

Native Windows is not supported by hermit in general; use WSL2.

---

## Can I use this with multiple projects?

Yes. Each project gets its own `.hermit/` state directory. Install the plugin with `--scope local` or `--scope project`. For always-on, each project runs its own Docker container or tmux session.

---

## What Claude model does it use?

Whatever model your Claude Code instance uses by default. Override with `/hermit-settings model` (e.g., `sonnet`, `opus`). Task record mutations run through deterministic scripts; an executable check runs through the separately gated `task-check.ts`.

---

## How much does it cost to run?

Depends on usage. Key cost drivers:

- **Heartbeat interval** — 5m with Opus is expensive; `30m` is the default and usually sufficient.
- **Autocompact threshold** — default 65% keeps context lean.
- **Thinking tokens** — capped at 10K by default.

Set a per-session budget with `/hermit-settings budget`. A typical interactive session costs $1-5. Always-on agents are significantly cheaper than interactive use: quiet heartbeat polls never reach the model, so the interval itself costs nothing when there is nothing to do.

---

## What happens if my auth token expires?

The hermit stops responding. Re-run `claude /login` inside the container to refresh credentials:

```bash
hermitd docker login
```

Then restart: `hermitd restart`

---

## Can I use an API key instead of a subscription?

Yes. Set `ANTHROPIC_API_KEY` in `.env` and choose "apikey" during `/docker-setup`. You'll pay per-token instead of using your subscription quota.

---

## Can I use this without Docker?

Yes. Docker is the guided always-on path, not a requirement. Use `hermitd-start`/`hermitd-stop` for bare tmux; the first always-on boot registers the watchdog scheduler so dead sessions come back (opt out with `hermitd watchdog uninstall`, or `watchdog.scheduler_enabled: false` before the first boot). For interactive-only use, just run `/hermitd:resident-start`. No tmux or Docker needed.

---

## Can I stop my assistant while it's mid-task?

Send `!stop` or `!pause` from your channel and the assistant is blocked from every action except replying to you, until you send `!resume`. Between turns this takes effect immediately. If the assistant is mid-task when your message lands, the rest of that task can run to completion before the block takes hold: Claude Code delivers a mid-task channel message to the assistant as steering rather than interrupting it, so a remote `!stop` is reliable but not guaranteed to be an instant kill mid-task. (`!snooze 2h` pauses for a set time; `!resume` clears it.)

---

## How do I move my hermit to another machine?

`git clone` handles your tracked files. Copy `.hermit/` — at minimum `OPERATOR.md`, `HEARTBEAT.md` and `config.json` (plus `claude-settings.json` if you created it); copy `tasks/` to preserve commitments; `proposals/`, `raw/`, `compiled/` and frozen archives preserve history, and `state/`, `bin/`, `templates/` regenerate on their own. Copy `.claude/settings.local.json` too if `.hermit/state/hatch-options.json` shows `"target": "local"` — that file carries hermit's hook permissions and deny patterns. Never copy `.env` or `.claude.local/`; recreate those secrets and channel state dirs on the destination and re-pair channels. The gitignored `.claude/output-styles/hermit-voice.md` doesn't travel with the clone, but copying `config.json` is enough on its own — the next boot re-renders it. A skill or agent your hermit created for you (rather than one you wrote yourself) is excluded the same way when `target` is `"local"`, but via `.git/info/exclude` rather than `.gitignore` — that file lives outside `.hermit/` and a `git clone` never carries it, so recreate or re-request that skill on the destination.

On the destination: run `/hermitd:hatch` (it preserves OPERATOR.md, config.json, and HEARTBEAT.md on re-init), then `/hermitd:hermit-evolve` if the plugin version differs. Update the machine-specific `config.json` fields: `timezone`, `channels.*.default_chat_id`, `tmux_session_name`, `permission_mode`.

For always-on Docker setups, see [Moving to a new host](always-on.md#moving-to-a-new-host).

---

## How do I uninstall a hermit?

From the hermit's folder, run:

```bash
curl -fsSL https://gtapps.github.io/hermitd/uninstall.sh | bash
```

This removes the watchdog, stops the session, and uninstalls the folder-scoped plugin. State is kept by default and deleted only when you confirm on an interactive terminal; the script then prints a Claude prompt for cleaning shared-file leftovers. Only this folder is affected, so the marketplace registration and other hermits remain untouched. To deactivate only the watchdog, run `hermitd watchdog uninstall`; to stop always-on mode but keep the hermit, run `hermitd stop` or `hermitd stop`.

---

## How do I reset everything and start over?

For full removal, follow [How do I uninstall a hermit?](#how-do-i-uninstall-a-hermit). To discard the state and hatch again without uninstalling the plugin:

```bash
rm -rf .hermit/
# Then re-run:
/hermitd:hatch
```

Your proposals, task records, and config will be gone. OPERATOR.md can be regenerated by the wizard.

---

## Can the hermit modify OPERATOR.md?

Only when you ask, and only with your approval. OPERATOR.md is human-curated: the hermit never edits it on its own initiative. The seeded permission rules put `Edit` (and `Write`, which Claude Code folds into the same `Edit` glob) of OPERATOR.md behind an approval prompt under Standard, and hard-block it under Hardened. Tell the hermit "update OPERATOR.md with [change]": under Standard it makes the edit and Claude Code asks you to approve it; under Hardened, or when you decline, it proposes the diff for you to apply.

---

## OPERATOR.md vs CLAUDE.md — where does it go?

- **OPERATOR.md** holds the operator's standing instructions to the hermit: mission, focus, red lines and what to ask first. Its first 50 lines, up to 2,000 characters, load at startup, `/clear` and after compaction, including when the hermit's own subagents compact. The hermit edits it only at your request, behind the approval prompt.
- **CLAUDE.md** (or **CLAUDE.local.md**) holds project-wide context and instructions using Claude Code's native memory loading.

Rule of thumb: `CLAUDE.md` is read by every session in the project, helpers and subagents included; `OPERATOR.md` holds standing instructions only the resident agent needs. Project facts and code rules go in `CLAUDE.md`.

---

## What's the difference between a "hermit" and a "hermit plugin"?

- **Hermit** = the running assistant instance in your project — what you get after running `/hatch`.
- **hermitd** = the base plugin package that provides task records, proposals, heartbeat, and the learning loop.
- **Hermit plugin** = a third-party extension that adds domain-specific agents, skills, and hooks (e.g., `hermitd-dev` adds repo mapping, implementation, and code review agents). Layers on top of the core.

---

## What's the difference between heartbeat and monitor?

**Heartbeat** is the built-in periodic health check — polls every 30m by default, evaluates the `HEARTBEAT.md` checklist, and alerts you only when something needs attention. It's always-on infrastructure.

**Watch** (`/watch`) covers two cases. Config watches in `monitors` keep running across restarts: the background monitor starts at boot, restarts a command that exits, and applies config edits live. `/hermitd:watch stop` on one sets `enabled: false`. An ad-hoc `/watch` is for one current concern, such as "watch for CI failures every 5 minutes", and ends with the session.

---

## How does memory work?

Hermit uses several layers of memory:

- **Task records** (`tasks/T-*.md`): commitments, progress, outcomes and lessons, updated through `task.ts`.
- **TASKS.md**: operator policy for deciding which assignments get records.
- **OPERATOR.md** — your persistent instructions, read at every session start
- **Claude Code memory** — cross-session learning that persists between conversations (the hermit reflects on its experience and saves what it learns)
- **Proposals** (`PROP-NNN.md`) — structured improvement recommendations with evidence

Reflection combines memory with the three most recent done, cancelled or unconfirmed task records. Frozen pre-upgrade archives remain available to recall but are ignored by task readers.

---

## What happens when my hermit is idle?

It handles channel messages and scheduled duties. Runnable resident records left beyond `tasks.queue_nudge_minutes` (default 60) produce a heartbeat queue notice: conservative escalation notifies the requester; balanced and autonomous escalation continue the record. Reflection has its own schedule. Idle time never closes commitments.

---

## What are scheduled checks?

`scheduled_checks` holds session-triggered skills that run at task completion. Configure them with `/hermit-settings scheduled-checks`; see [Config Reference](config-reference.md#scheduled_checks).

For periodic checks, create an ordinary routine whose skill is `hermitd:reflect --check-id my-check --check my-plugin:my-audit-skill` and give it a cron schedule. Each fire evaluates that skill's findings through the reflection gates; a quiet result produces no proposal. Manage cadence with `/hermit-settings routines`. [Routine Authoring](routine-authoring.md) covers optional model pins and gates that skip the wake when there is no work.

---

## When should I run `/hermitd:resident-start`?

Use it to initialize or recover a resident and receive a readiness report. It checks process/execution state and open commitments, loads context and activates configured duties. It does not choose a task or accept `--task`; give the hermit your assignment after startup.

Always-on Docker and tmux launches invoke it automatically.

## Does a finished answer close the task?

Not by itself. A reported result stays unconfirmed until a named person confirms it, the requester clearly accepts it in any wording or language, or its recorded check succeeds. A named approver confirms in their own words. Explicit cancellation closes a commitment without reporting success. Ask "Confirm that task" or "Cancel it because the requirement changed" in the task's conversation.

## Why did the conversation clear while tasks were open?

Task records survive context resets. The standalone clear rule defaults to one quiet hour, a maximum context age of 24 hours, or a policy change, and requires a safe idle boundary plus at least 20,000 compactible tokens. It does not close the records or stop native monitors.
