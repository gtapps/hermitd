# Getting Started

## Prerequisites

A paid Claude plan (Pro, Max, Teams, or Enterprise). Linux, macOS, or Windows via WSL2.

Claude Code auto memory must stay enabled (the default): learning, preferences, and standing roles live there. Setting `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` disables them.

The installer below provisions the rest: [Claude Code](https://code.claude.com) v2.1.292+, **Bun** ≥1.4 (the hooks and scripts are TypeScript run directly by `bun`), and **tmux** for always-on mode.

---

## Install

```bash
cd /path/to/your/project   # or any folder — even an empty one
curl -fsSL https://gtapps.github.io/hermitd/install.sh | bash
```

To uninstall this folder's hermit later:

```bash
curl -fsSL https://gtapps.github.io/hermitd/uninstall.sh | bash
```

It installs anything missing, registers the marketplace, installs the plugin for this folder, then launches Claude Code with the `/hatch` setup wizard after a short countdown (Ctrl+C skips the launch and prints the command to run instead; so does running without a terminal, e.g. over plain ssh or in CI). It takes no arguments.

To read it before running it:

```bash
curl -fsSL https://gtapps.github.io/hermitd/install.sh -o install.sh
less install.sh
bash install.sh
```

### Manual install

The installer is a convenience, not a requirement. With Claude Code and Bun already present:

```bash
cd /path/to/your/project
claude plugin install hermitd --marketplace gtapps/hermitd --scope local
```

`--scope local` keeps the hermit personal to this folder rather than committing it to the repo for everyone. `/hatch` asks the shared-vs-personal question separately.

> **Upgrading is not a second `curl`.** Once installed, use `hermitd update` (local/tmux), `hermitd update` (Docker), or `claude plugin update hermitd@hermitd --scope local`. Re-running the installer is harmless but moves nothing.

---

## Initialize

```
/hermitd:hatch
```

The wizard sets up your agent's identity (name, language, timezone, [autonomy level](config-reference.md#escalation-levels)) and operational preferences (channels, remote control, heartbeat, daily routines, budgets). Then it scans your folder and generates an `OPERATOR.md` — your rulebook. Starting fresh with an empty folder? It'll ask what the assistant is for.

### OPERATOR.md

Hermit reads this at startup, `/clear` and after compaction. Be specific — the more precise you are, the better it performs.

Good:

```markdown
# Your Standing Instructions

You serve me as an assistant for my inventory business.
Focus your unattended time on finding ways to reduce manual order handling.
Never spend money or make purchases on your own.
Ask me before contacting suppliers or customers.
```

Not useful:

```markdown
# Your Standing Instructions

A web app. Be careful.
```

Code rules such as "Never modify migrations/" belong in CLAUDE.md.

The first 50 lines, up to 2,000 characters, load at startup, `/clear` and after compaction. The same section also reaches the hermit's own subagents when they compact. Keep essential instructions within this limit. Edit OPERATOR.md yourself; the hermit can propose a change for you to apply.

Rule of thumb: `CLAUDE.md` is read by every session in the project, helpers and subagents included; `OPERATOR.md` holds standing instructions only the resident agent needs. See [the FAQ](faq.md#operatormd-vs-claudemd--where-does-it-go).

### Replacing the resident prompt

The hermit's built-in behavior rules come from the plugin's resident prompt. OPERATOR.md and memory already take precedence over those rules; to replace the rules themselves, create `.hermit/resident-prompt.md`. At every start the hermit then uses that file as its whole resident prompt instead of the shipped one. Claude Code's own system prompt stays underneath, and spawned helper sessions keep their own prompt (see [Replacing the helper prompt](#replacing-the-helper-prompt)). Empty or delete the file to go back to the shipped prompt. Changes take effect at the next restart, and a write by the hermit to this file asks for your approval first.

Start from a copy of the prompt the hermit runs today:

```bash
cp .hermit/state/resident-system-prompt.md .hermit/resident-prompt.md
```

Before you cut anything:

- **Keep `## Watches`.** It maps the heartbeat, routine and background-task signals to the skills that handle them. Without it the heartbeat, routines and task completion stop, with no error.
- Keep `## Operator Notification`: skills point at it by name for how to reach you.
- What you remove is yours. The shipped rules on secrets, peer messages and proposals no longer apply; hooks such as the pause gate and the settings gate still enforce on their own.
- Upgrades never touch this file, so later changes to the shipped prompt don't reach you. After an upgrade, compare your file with `prompts/resident.md` and `prompts/rules.md` in the installed hermitd plugin.

### Replacing the helper prompt

Helper sessions the hermit spawns get their own prompt, built from the plugin's `prompts/helper.md` and the same shared rules. To replace it, create `.hermit/helper-prompt.md`. At every start the hermit uses that file as every helper's prompt, filling in `{{PROJECT_ROOT}}` with this project's path and `{{RESIDENT_NAME}}` with the hermit's name; Claude Code's own system prompt stays underneath. Empty or delete the file to go back to the shipped prompt. Changes reach helpers spawned after the next restart, and a write by the hermit to this file asks for your approval first.

Start from a copy of the prompt helpers get today, which already holds this project's path and the hermit's name:

```bash
cp .hermit/state/helper-system-prompt.md .hermit/helper-prompt.md
```

Before you cut anything:

- **Keep the `GUEST_REPORT` block and the instruction to send it to the hermit by name.** That message is how a helper hands its result back. Without it the hermit never records the outcome, with no error.
- Keep the project path lines: they point helpers working in a worktree at the hermit's real state folder.
- What you remove is yours: the shipped rules you cut no longer reach helpers.
- The copy holds today's path and name. Put `{{PROJECT_ROOT}}` and `{{RESIDENT_NAME}}` back in their place if you want the file to follow a moved project or a renamed hermit.
- Upgrades never touch this file. After an upgrade, compare it with `prompts/helper.md` and `prompts/rules.md` in the installed hermitd plugin; lines you paste from `prompts/helper.md` keep working, placeholders included.

---

## Your First Task

Tell the hermit what outcome you need, for example: "Add request validation to the API and verify invalid payloads are rejected." Your `TASKS.md` policy determines when an assignment gets a record.

The record in `tasks/T-*.md` keeps the requester, owner, definition of done, progress and lessons together. The hermit updates it through `task.ts`, rather than editing the file by hand. In a guild channel, the assignment can also get its own resident-owned thread.

Ask "What are you working on?" for a brief or "Show open tasks" for the queue. A result awaiting confirmation remains open. A passing recorded check, named human confirmation, or the requester clearly accepting the result closes it as done; a named approver confirms in their own words. Cancellation closes it without claiming completion. Closing a task can continue the next runnable record immediately.

For boot recovery and readiness, run:

```text
/hermitd:resident-start
```

This initializes the resident without selecting a task. Always-on launches run it automatically.

---

## Talk to Your Hermit

Hermit isn't just a work engine. During any session, you can ask it to reflect and improve:

- **"remember for this channel: when X, do Y"** saves a standing role in memory. "For this channel" pins it to that chat; a plain "remember" applies hermit-wide only from a primary operator (`channels.<name>.operators`, or the first allowed user when unset). Other senders pin to the requesting chat. Ask "what do you remember about this channel?" to list roles or "forget the X rule" to remove one. Posts not addressed to the hermit never trigger a role.
- **"Can you understand voice notes?"** Not out of the box. [Voice Notes](voice-notes.md) is the two-step setup: a speech-to-text tool where the hermit runs, then one standing role.
- **"What slowed you down recently?"** — Reviews its experience and tells you what caused delays.
- **"What permissions do you keep getting blocked on?"** — Suggests the exact `settings.json` entries to add so it stops getting prompted.
- **"Suggest specialized agents for this project."** — Proposes new [sub-agents](https://code.claude.com/docs/en/sub-agents) based on the kind of work you've been doing. You approve, it creates them.
- **"How can you be more efficient?"** — Suggests workflow improvements, configuration tweaks, or structural changes.
- **"Create a self-improvement proposal."** — Formalizes what it's learned into a proposal you can accept or reject.

You're always in control. Hermit suggests. You decide.

**Handing this off to a non-developer owner?** Give them the [Owner's Guide](owners-guide.md) (talk, approve, pause, spend, who to call) and [What Your Assistant Can and Cannot Do](what-your-assistant-can-do.md) — both written for someone who'll never open a terminal.

---

## Tips

- **Don't create session/proposal files by hand.** Skills handle lifecycle tracking.
- **After plugin updates**, run `/hermitd:hermit-evolve`.
- **Talk to your hermit.** Ask how it can improve. It gets better when you tell it what you need.

---

## Daily Rhythm

If daily routines are enabled (default: yes), Hermit follows a schedule tied to your active hours:

- **Morning** — `brief --morning` at the configured time (default: active hours start + 30m): reviews what happened overnight, checks pending proposals, surfaces priorities. Sends a brief via channel if configured.
- **Evening** — `brief --evening` at the configured time (default: active hours end - 30m): summarizes the day's task outcomes and flags tomorrow's priorities.

Both fire once per day from the routine monitor. Configure with `/hermitd:hermit-settings routines`.

---

## Going Always-On

Docker is the guided way to run your hermit autonomously: container isolation, a reproducible environment, and a container that restarts itself. tmux runs the same hermit on the host with no image build — see [Always-On Setup](always-on.md) for how to pick. The default `auto` mode works either way; use `bypassPermissions` as an explicit opt-in if you need zero prompts for fully unattended operation.

```bash
/hermitd:docker-setup    # generates hermit Docker files, walks you through deployment
```

See [Always-On Setup](always-on.md) for the full guide — auth, channels, pausing the hermit, cost management.

**Without Docker?** You can run directly in tmux:

```bash
hermitd start
hermitd stop
```

To activate a channel in tmux mode, run `/hermitd:channel-setup` — it adds the channel to `config.json` if you skipped that at hatch, installs the plugin, configures the token, and guides pairing. `hermitd-start` passes `--channels` automatically on boot.

See [Always-On Operations](always-on-ops.md) for tmux setup and operational details.

---

## Browser Tasks

Turn on `chrome: true` via `/hermitd:hermit-settings` to let your hermit browse sites, fill forms, and work in web apps you are signed into.

Requirements:

- A claude.ai `/login` sign-in (`auth_mode: login`). Setup-tokens and env credentials keep Chrome off; boot and doctor warn when Chrome is requested with either.
- The Claude in Chrome extension signed in to the same claude.ai account and organization as the hermit.
- Chrome open on any machine on that account, including when the hermit runs on another host or in Docker.

Enabling Chrome adds context cost because browser tools and their instructions are always loaded. See [Claude Code's Chrome documentation](https://code.claude.com/docs/en/chrome) for setup and context usage.

Docker hermits also need `auth_mode: login`. If netguard filters DNS, its allowlist needs `server=/claudeusercontent.com/1.1.1.1`; the shipped template includes it. Existing installs receive the entry through `/hermitd:hermit-evolve`, and it takes effect after `hermitd-docker down && hermitd-docker up` on the host.

The hermit pauses at logins and CAPTCHAs for you to handle them. Overnight unattended browser runs are untested.

## Common Workflows

**Disconnected?** — Restart Claude Code. Hermit detects the active session and shows where you left off. Type "continue."

**What's next?** — When it finishes, just tell it what's next. It records the outcome and continues the next runnable commitment.

**Found an improvement?** — `/hermitd:proposal-create` captures it without interrupting the current work.

**What's Hermit been struggling with?** — `/hermitd:proposal-list` shows auto-detected patterns. Or just ask.

---

## Task and Runtime State

```
.hermit/
├── tasks/
│   └── T-*.md                 <- commitments, progress, outcomes and lessons
├── proposals/
│   └── PROP-001.md            <- improvement ideas
├── state/                     <- runtime observations (agent-owned)
│   ├── runtime.json           <- process identity, config/auth and recovery state
│   ├── execution.json         <- hook-observed idle/in-flight state
│   ├── alert-state.json       <- heartbeat alert dedup + self-eval evidence
│   ├── reflection-state.json  <- last reflection timestamp + scheduled check state
│   ├── routine-metrics.jsonl <- append-only routine fire log
│   ├── proposal-metrics.jsonl <- append-only event log
│   ├── usage-metrics.jsonl    <- append-only compiled-read usage log
│   ├── micro-proposals.json   <- pending micro-approvals list (pending[])
│   └── state-summary.md       <- auto-generated health snapshot
├── raw/                       <- domain inputs (fetched content, snapshots, logs)
│   └── .archive/              <- expired raw artifacts
├── compiled/                  <- durable domain outputs (briefings, decisions, review-weekly-YYYY-Www.md)
├── knowledge-schema.md        <- what this hermit produces and when
├── OPERATOR.md                <- your rulebook
├── TASKS.md                   <- your task-record policy
├── HEARTBEAT.md               <- background checklist
└── config.json                <- settings
```

> Files in `state/` are managed by the plugin at runtime; do not edit them manually. Files you own and can edit: `config.json`, `OPERATOR.md`, `TASKS.md`, `HEARTBEAT.md`, and the optional `resident-prompt.md` and `helper-prompt.md`. Task files are script-owned; ask the hermit to update them.

---

## Model and Effort

**`config.model`** controls which Claude model your hermit runs on. Default: `"sonnet"`. Set to `"opus"` for premium reasoning or `"haiku"` for cheap idle loops. See the [Claude Code model configuration docs](https://code.claude.com/docs/en/model-config) for aliases, version pinning, and tier behavior.

Use [`/when-done-switch-to`](../skills/when-done-switch-to/SKILL.md) inside a task turn to switch model and effort when that turn ends idle.

**`CLAUDE_CODE_EFFORT_LEVEL`** (optional) sets the reasoning effort level. Add it to `config.env` if you want to override the model default — note the env var takes highest priority and overrides runtime `/effort`, so omit it for interactive sessions where you want per-turn control. Valid values and defaults: [CC model-config docs](https://code.claude.com/docs/en/model-config#adjust-effort-level).

A trusted channel sender can also pair the main model with an experimental [advisor model](https://code.claude.com/docs/en/advisor) mid-session via `!advisor <model>` (and clear it with `!advisor off`) — unlike `model`/`effort` above, this selection is not re-asserted at boot. Claude Code writes it to its own user-level settings, so it persists across restarts, applies to every session sharing that config directory, and keeps adding spend until a trusted sender sends `!advisor off`.

---

## Hook Profiles

| Profile                | What runs                                      | Best for                       |
| ---------------------- | ---------------------------------------------- | ------------------------------ |
| **minimal**            | Cost tracking only                             | Experimenting                  |
| **standard** (interactive default) | + session quality checks                       | Day-to-day work                |
| **strict** (always-on default)      | + safety hooks from hermits                    | Always-on, production-adjacent |

You usually don't set this. With nothing configured, an always-on launch (tmux or Docker) resolves **strict** and an interactive one **standard**, so a managed hermit gets the safety hooks without being asked. The launch output's `Hook profile:` line tells you what was resolved and where it came from.

To override, edit `config.json` directly:

```json
"env": { "AGENT_HOOK_PROFILE": "standard" }
```

`/hermit-settings env` deliberately refuses this key: the profile is resolved at boot, and an ambient value from Docker compose or your shell outranks whatever is in `config.json`.

The value is process-scoped: it reaches the managed session through the tmux env file or the Docker compose environment block, and is never written to `.claude/settings.local.json`. A `claude` you launch by hand in the same project is unaffected by it.

---

## Safety Rails

Hermit seeds native Claude Code permission rules. Standard (the `/hatch` default) hard-blocks `rm -rf`, `chmod 777`, casual credential dumps and more in `permissions.deny`, and puts risky-but-legitimate operations (`ssh`, `docker`, `kubectl`, `npm publish`, `git push --force`, `--no-verify`, settings and OPERATOR.md edits) behind an approval prompt in `permissions.ask`. Hardened puts both classes in `permissions.deny`. The deny entries hold in every permission mode, `bypassPermissions` included; ask entries are mode-dependent (`dontAsk` turns them into denies, `bypassPermissions` skips the prompt).

See [Security](security.md) for the full rule list and defense-in-depth model.

---

## Permissions

The init wizard adds the required permissions to `.claude/settings.json` automatically — including a `Bash(bun */scripts/*.ts*)` entry per hermit script. A representative subset:

```json
{
  "permissions": {
    "allow": [
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(git log:*)",
      "Bash(bun */scripts/cost-tracker.ts*)",
      "Bash(bash -c 'AGENT_DIR=\".hermit\"*)"
    ]
  }
}
```

Or just ask Hermit: "What permissions do you need?" — it'll tell you exactly what to add.

---

## Skills at a Glance

Most common actions auto-trigger from natural language — just say what you mean. Slash commands (`/hermitd:*`) are the precision fallback for when auto-triggers don't fire.

| Category       | Skills                                                             |
| -------------- | ------------------------------------------------------------------ |
| **Tasks**      | `resident-start`, `task`                        |
| **Status**     | `brief`                                                            |
| **Monitoring** | `watch`, `heartbeat`                                               |
| **Learning**   | `proposal-create`, `proposal-list`, `proposal-act`, `reflect`      |
| **Config**     | `hermit-settings`, `hatch`, `hermit-evolve`                        |
| **Docker**     | `docker-customize`; `docker-setup`, `docker-security` (type the last two; they never auto-trigger) |
| **Channels**   | `channel-responder`, `voice-notes`                                 |
| **Summaries**  | `hermit-evolution`, `hermit-health`, `weekly-review`              |
