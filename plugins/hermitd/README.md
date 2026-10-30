
<p align="center">
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.4.23-green.svg" alt="Version 1.4.23" /></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/gtapps/hermitd/_gh_traffic_stats/.github/badges/clones.json" alt="Downloads" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# Like Claude Tag, but local.

Run an always-on Claude Code agent on your own machine, for you or your team. Start sessions from your chat in any project it can reach, on the model and effort you choose, and steer them through the agent or take over in the Claude app or CLI.

Use it from your terminal or the Claude app via [Remote Control](https://code.claude.com/docs/en/remote-control), or connect Discord, Telegram, iMessage, or a custom Claude Code [channel](https://code.claude.com/docs/en/channels).

Give it ongoing responsibilities: maintain research, monitor systems, run routines, and follow up on unfinished work. Between requests, it checks those responsibilities, carries progress across sessions, and reaches you when something needs attention.

Run it on your Claude subscription and extend it with your own MCP servers, skills, and plugins.

**It's Claude Code.** hermitd is a plugin for the official Claude Code CLI, which runs as Anthropic ships it. New Claude models, features, and fixes work as soon as Claude Code supports them.

<p align="center">
  <img src="assets/cover.png" alt="Always-on Claude Code agent" />
</p>

<a id="quick-start"></a>

## Set up

**Choose one installation method below.** Run it from the folder where you want your agent, empty or existing. Uses your Claude subscription on Linux, macOS, or Windows via WSL2. See [prerequisites](docs/how-to-use.md#prerequisites).

<details open>
<summary>Already run Claude Code? Install the plugin</summary>

With Claude Code 2.1.308+ and Bun 1.4+ installed:

```bash
claude plugin install hermitd --marketplace gtapps/hermitd --scope local
claude "/hermitd:hatch"
```

</details>

<details>
<summary>Fresh machine? Use the bootstrap installer</summary>

Prepares Claude Code, Bun, and tmux, installs the plugin, and launches setup:

```bash
curl -fsSL https://gtapps.github.io/hermitd/install.sh | bash
```

</details>

Both options set up your agent in this folder. Plain `/hermitd:hatch` asks where you want to chat, guides private token entry and pairing when needed, and starts your agent in tmux. Your first message opens a conversation that confirms the time, sets up one real job, and offers to save its purpose. Use `/hermitd:hatch advanced` for the full wizard or Docker deployment.

## Keep it running

Plain hatch starts your agent itself. The advanced wizard prints the next steps for your chosen deployment.

### On your machine

Run in a persistent tmux session:

```bash
hermitd start
```

Requires tmux. The watchdog recovers failed sessions while your machine stays on. Claude Code's `/sandbox` is recommended for unattended use. To add or repair a chat later, run `/hermitd:channel-setup`. Private token entry is `hermitd run channel-token-set <channel>` from a separate project terminal; pasting in chat keeps the token in session history.

[Host setup and operations](docs/always-on-ops.md)

### In Docker

Run the guided setup in Claude Code:

```text
/hermitd:docker-setup
```

Builds and starts the container, then walks you through authentication and channel pairing. Requires Docker Compose v2.

[Docker setup](docs/always-on.md)

**Customize the container.** Ask the agent to add tools, packages, or services to its Docker setup. For example: “Add ffmpeg to the container.”

Optional [Docker security controls](docs/docker-security.md) cover local-network access, DNS policy, resource limits, and plugin installation auditing.

## What the plugin adds

- **Continuity.** Persistent working state and archived session handoffs carry progress across compaction and restarts. An external watchdog recovers failed sessions, while context management keeps long-running sessions manageable.

- **Proactive work.** Heartbeats regularly check the responsibilities you give the agent. Routines run scheduled work, and watches surface changes. Together, they let the agent follow up without waiting for another request.

- **Work through chat.** Assign work and receive results in your connected chat. Longer assignments get threaded progress updates, with a separate reply when the agent needs a decision. Assignments can also carry a persistent task record with requester, due date, result confirmation, and a dashboard view by person.

- **Your network.** Local databases, SSH, LAN devices, filesystem are reachable because the agent runs where they are.

- **Token efficiency.** With Claude Code’s [Monitor](https://code.claude.com/docs/en/tools-reference#monitor-tool), heartbeat checks and optional routine prechecks run outside the model. Quiet checks and skipped routines use no model tokens; eligible routines due together can share a wake.

- **Lasting knowledge.** Turn source material in `raw/` into maintained knowledge in `compiled/`, alongside Claude Code's auto memory. `/recall` searches past sessions, knowledge, proposals, and captured channel conversations.

- **Learning from experience.** The agent reviews evidence from its work and operation, saves useful lessons, and verifies proposed behavior changes before bringing them to you for approval.

- **Control and visibility.** Track progress, proposals, and usage through the dashboard. Pause is enforced at the tool boundary, and optional usage caps can alert you or pause further work.

**Part of your project channel.** With passive mode, the agent saves incoming group messages to look back on later, and wakes when someone you allow @mentions it. It also remembers instructions for that channel. Fixed policies you set for a chat change only through an approval prompt, and an optional scheduled review proposes rule updates when the same correction keeps coming up.

**Work that belongs to a chat.** Routines, watches, and reminders created from a chat report back to that chat. A team chat lists and edits its own routines, and changing one it does not own asks for approval. [Third-party channel plugins](docs/channel-plugins.md) can join in: a small send script gives them proactive notices and routine chats, and Docker approves them for you.

<a id="configure-it"></a>

## Configure

Tune from a terminal with `/hermit-settings`, or change permitted settings from a trusted connected chat. Every write is validated and recorded in a redacted audit ledger; `/hermit-settings history [setting]` shows what changed. Some of the settings available:

| Key | Default / options (default **bold**) |
|-----|--------------------------------------|
| `agent_name` | your assistant's name |
| `operator_profile` | primary-chat audience: **`technical`** / `non-technical` |
| `timezone` | detected during setup; fallback **`UTC`** |
| `language` | detected during setup; fallback **`en`** |
| `escalation` | how much it does before asking: `conservative` / **`balanced`** / `autonomous` |
| `model` | session model: **`sonnet`** |
| `effort` | session reasoning effort: **unset** (Claude Code default) |
| `permission_mode` | how freely the unattended agent acts: **`auto`** |
| `AGENT_HOOK_PROFILE` | guardrail profile: `minimal` / **`standard`** (interactive) / **`strict`** (always-on) |
| `channels` | Discord / Telegram / iMessage / third-party channel plugins (+ `allowed_users`) |
| `channels.primary` | which channel gets outbound pings |
| `channels.<name>.maintainer_channel_id` | optional separate chat for technical alerts, diagnostics, and usage details |
| `push_notifications` | native/mobile push on alerts: **`true`** |
| `remote` | remote control; `false` also requires approval for cross-machine peer messages; **`true`** |
| `ask_gate` | route unattended questions to a paired channel: **`true`** |
| `budget` | optional daily / weekly / monthly caps; **`alert`** or binding `pause` action |
| `artifacts` | dashboard / proposals / weekly review: **dashboard and proposals enabled** |
| `heartbeat.enabled` | timed idle sweeps: **`true`** |
| `heartbeat.every` | idle sweep cadence: **`30m`** |
| `heartbeat.active_hours` | active window: **`08:00`–`23:00`** |
| `heartbeat.model` / `heartbeat.effort` | heartbeat evaluator: **`haiku`** at **`high`** |
| `routines` | persistent routines managed via `/hermit-routines` |
| `monitors` | persistent background watches managed via `/watch` |
| `scheduled_checks` | session-triggered skills at task completion |
| `reflection.graduation_min_sessions` | proposal recurrence bar: **`1`** |
| `quality_gate.tier` | post-change cleanup spend: **`budget`** / `balanced` / `quality` |
| `knowledge.compiled_budget_chars` | fresh/resumed startup catalog budget: **`2500`** |
| `knowledge.raw_retention_days` | `raw/` retention: **`14`** |
| `knowledge.working_set_warn` | warn above N compiled docs: **`20`** |
| `auto_session` | auto-start session on boot: **`true`** |
| `boot_skill` / `shutdown_skill` | custom boot / teardown skill |
| `context_hygiene.clear` | safe-boundary context clear: enabled, quiet **`1h`**, max age **`24h`**, minimum **20,000** tokens |
| `context_hygiene.compact` | compact long-running active context: **enabled**, `100000` compactible tokens / `4h` cooldown |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | auto-compact at % of context: **`65`** |
| `MAX_THINKING_TOKENS` | thinking-token cap per turn: **`10000`** |
| `watchdog.scheduler_enabled` | OS scheduler for the watchdog tick: **`true`** on tmux always-on (auto-installed at boot); `false` or `hermitd-watchdog uninstall` opts out |
| `watchdog.enabled` | recovery/restart tier: **`false`** until first scheduler registration (or `/docker-setup`); hygiene still runs |

Full schema in the [Config Reference](docs/config-reference.md)

**Your own prompt.** Replace the agent's built-in prompt and rules with `.hermit/resident-prompt.md`, and spawned helpers' with `.hermit/helper-prompt.md`. Delete the file to return to the shipped prompt. See [Replacing the resident prompt](docs/how-to-use.md#replacing-the-resident-prompt).

## Observe

**Artifacts.** The agent uses [Claude Code Artifacts](https://code.claude.com/docs/en/artifacts) to provide an interactive dashboard and custom pages generated on demand that you can view, interact with, and share. Ask it to build your own personalized agent dashboard.

Ask for an update from your terminal or connected chat:

| Command | What it gives you |
|---------|-------------------|
| `/brief` | Current status and a summary of recent work. |
| `/recall` | Search past sessions, knowledge, proposals, and captured conversations. |
| `/hermit-health` | Alerts, routines, channels, blockers, and recent learnings. |
| `/hermit-doctor` | Diagnostics for the installation, runtime, scheduling, credentials, and permissions. |
| `/hermit-evolution` | Cost trends, proposal activity, routines, and what the agent has produced over time. |
| `/cost-reflect` | A breakdown of usage by token type, session, and what triggered the work. |
| `/hermit-dashboard-design` | A dashboard designed around what your agent actually tracks. |

## Learning loop

The agent reviews evidence from its work and operation. Durable lessons go to memory. When skill learning is enabled, completed work can save or revise reusable skills automatically. Other proposed behavior changes are verified, deduplicated, and brought to you for approval.

The reflection and proposal path works like this:

```text
Work produces evidence
          │
          ▼
Reflect when due
          │
          ▼
Verify and deduplicate
          │
     ┌────┴────┐
     ▼         ▼
Remember    Propose
a lesson    a change
                 │
                 ▼
           You approve?
              │     │
             no    yes
              │     │
         No change  Implement
                        │
                        ▼
                  Verify result
                        │
                        ▼
                  Future evidence
```

Reflection runs at eligible task or session pauses, daily, and after routines configured to reflect. Approved changes can start now, become a task, or be left for manual implementation. Proposals are resolved when verification passes or later evidence shows the problem is gone.

## Ask it from your chat

| Ask | What it does |
|-----|--------------|
| “Start X in `~/code/api` on Opus at high effort, in its own worktree.” | Starts a session in any project, on your model and effort. |
| “Tell me when my session in `~/code/web` finishes.” | Watches your other Claude Code sessions. |
| `!pause` · `!snooze 2h` · `!model sonnet` · `!effort high` | Claude Code controls, straight from chat. |
| “`/later` check tomorrow whether those errors have returned.” | Checks whether a fix held up over time. |
| “remind me Monday at 14:00 to pay the invoice” | Delivers a durable reminder at the due minute in monitor mode, even after a restart. |
| “Download last month's invoices from the supplier portal.” | Works in web apps through [Claude in Chrome](docs/how-to-use.md#browser-tasks) on any machine signed in to the same claude.ai account as the agent, Docker agents included. |
| “When I ask for a status update, include blockers.” | Remembers instructions for that channel. |
| “What else could you be doing for me?” | Proposes new capabilities from your work and its tools. |

## Cost

Quiet heartbeat checks, skipped routines, and passive chat capture use no model tokens. Work, evaluations, and replies consume usage; context management keeps conversation history bounded.

```text
event: a file, a log line, a webhook, a schedule
   │
   ▼
precheck (plain script, no model tokens)
   │
   ├── nothing changed ──▶ back to sleep
   │
   ▼ something to do
Claude Code turn on your machine
   │
   ├── needs a decision ──▶ asks you in chat
   │
   ▼
result in your chat  +  usage recorded
```

- **See what drives usage.** Token usage is recorded per call, including the model, input/output/cache split, and whether work came from a routine, heartbeat, channel, or another source. Session and daily totals feed the dashboard, weekly review, and `/cost-reflect`.
- **Set limits.** Optional daily, weekly, and monthly caps can alert you or enforce a pause until the exceeded budget window resets. Under Claude subscription billing, dollar figures are usage estimates rather than additional per-token charges.
- **Choose where to spend.** Set the session model and effort, and optionally a model and effort per routine or per task. Heartbeat checks run on Haiku at high effort by default. Routine models run in isolated subagents, so use them for work that can return a concise result.

See [budgets](docs/config-reference.md#budget) and [routine scheduling](docs/routine-authoring.md) for configuration and scheduler fallback behavior.

## Remote work

Reach the running agent through your connected channels or Claude Code Remote Control. You can also start separate sessions for additional work:

- **Background sessions with follow-up.** Through [`/spawn-session`](skills/spawn-session/SKILL.md), the agent launches a local Claude Code helper in the project, or in another folder with `--cwd`, and relays its status when it becomes idle. Claude Code isolates the helper's edits in a Git worktree unless the project sets `worktree.bgIsolation` to `none`; pass `--worktree` to give it one from the start. Set the helper’s model and effort with options such as `--model sonnet --effort high`.
- **Task threads for helpers.** A task thread can be bound to a spawned session: follow-ups in the thread go to that session, its reports land on the task, and `!model` or `!effort` in the thread switch that helper without losing its conversation. A request that continues the same work goes back to the same session.
- **Local [Remote Control](https://code.claude.com/docs/en/remote-control) gate.** Through [`/rc-gate`](skills/rc-gate/SKILL.md), the agent manages a Remote Control server on your machine or server. While the gate is open, you can spawn new Claude Code sessions from the Claude app, using your local files and tools. Each session gets its own Git worktree, while the agent keeps running.

Both session-spawning paths require a Git workspace. Remote Control requires a Claude sign-in through `/login` on the machine running the agent.

**Watch other sessions.** Through [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), ask the agent to watch a local Claude Code session, including one you started interactively, and notify you when it next becomes idle.

**Claude Code controls from chat.** Use `!model sonnet`, `!effort high`, `!advisor opus`, `!compact`, `!clear`, `!doctor` (alias `!checkup`), and `!permission-mode auto` directly from your connected chat. Control the agent’s work with `!pause`, `!resume`, and `!snooze 2h`. Use [`/when-done-switch-to --model sonnet`](skills/when-done-switch-to/SKILL.md) to switch automatically at the end of the current turn.

## Extensions

Optional plugins that add domain tools and workflows to your agent.

- [dev-hermit](../hermitd-dev/README.md): Branch discipline, push guards, and gated PR workflows.
- [homeassistant-hermit](../hermitd-homeassistant/README.md): Home Assistant tools, automation workflows, and safety checks.
- [fitness-hermit](../hermitd-fitness/README.md): Strava integration, activity analysis, and training routines.
- [hermitd-feed](../hermitd-feed/README.md): Source curation, recurring briefs, and weekly synthesis.
- [hermitd-laravel-forge](../hermitd-laravel-forge/README.md): Laravel Forge deployments, logs, and server management.
- [hermitd-scribe](../hermitd-scribe/README.md): GitHub issues and comments from proposals through a dedicated bot identity.

You can run separate agents for different responsibilities, each with its own working state, knowledge, and routines. See [Creating Your Own Hermit](docs/creating-your-own-hermit.md).

**External orchestration.** Other agents and tools can check the agent’s status, health, and recent work through its [MCP interface](docs/external-control-surface.md), and request a wake when needed.

## Maintenance

**Sign-in renewal from chat.** When your agent’s Claude sign-in needs renewing, use `/relogin` from your connected chat. Open the link in your browser, sign in, and send the code back in chat.

**Tool sign-ins from chat.** When a connected tool or claude.ai connector needs you to sign in again, ask your agent in chat to log you in. Open each link it sends, approve access, and paste back the address your browser fails to load; the tool works again without a restart.

**Scheduled backups.** Optional backups preserve the agent’s knowledge, session reports, settings, and Claude Code memory in Git, with an optional private remote copy. Backups run without model tokens.

## Upgrading from claude-code-hermit

Claude Code 2.1.287 blocks plugins named `claude*`, so this project moved from `claude-code-hermit` to `hermitd`. Stop every agent in this Claude config directory, then follow the [migration prompt](docs/upgrading.md#upgrading-from-claude-code-hermit).

## Upgrading

Coming from `claude-code-hermit`? See [how to migrate](#upgrading-from-claude-code-hermit).

Run `hermitd update` from the project folder, or `hermitd update <name>` from anywhere. Docker updates refresh the host core first, then the container. The update waits for a quiet moment, applies migrations, then restarts the agent once and resumes the conversation.

`hermitd list` shows registered and discovered agents on this host, including stopped and missing projects. `hermitd status [name]` shows transport, execution and its age, open and waiting tasks, and the first runnable task. Both support `--json`. Listing never removes entries; `hermitd prune` removes missing projects.

Use `hermitd start|stop|restart|attach [name]` for lifecycle commands, `hermitd pause [name] on|off|snooze <duration>|status`, `hermitd watchdog [name] run|install|uninstall`, or `hermitd run [name] <script> [args]` for maintenance. Names match the project folder or agent name; with no name, the nearest project above the current folder is used.

`hermitd agents [name]` opens Claude Code's agent view (`claude agents`) where the agent runs: inside the container for Docker agents, on the host under the agent's Claude config folder otherwise. On the host that view lists every session in the config folder, so pass `--cwd <path>` to narrow it. Extra flags pass through, and `--json` works from scripts.

`hermitd skills [name] status|pin|unpin|rollback|archive|restore [skill]` inspects or controls learned skills. Use `status --skill <skill>` for one bounded history and its last use. Mutations run inside the container when the Docker agent is up. A task close can save a reusable procedure automatically; "keep this skill" pins it and "stop doing it that way" about a named learned skill rolls back its latest revision.

See the [Upgrade guide](docs/upgrading.md) for details.

<a id="tips--tuning"></a>

## Guides

- **Configure:** the [Config Reference](docs/config-reference.md) covers the full schema and tuning details.
- **Use:** [Getting Started](docs/how-to-use.md) and the [Owner's Guide](docs/owners-guide.md) cover everyday work, decisions, and controls.
- **Automate:** [Routine Authoring](docs/routine-authoring.md) covers schedules and prechecks. [Channel configuration](docs/config-reference.md#channels) includes third-party channel plugins.
- **Observe:** [Artifacts](docs/artifacts.md) explains the dashboard, proposals, and weekly reviews.
- **Maintain:** [Upgrading](docs/upgrading.md), [Backup](docs/backup.md), [Troubleshooting](docs/troubleshooting.md), and [Uninstalling](docs/how-to-use.md#install).
- **Understand:** [Architecture](docs/architecture.md), [Security](docs/security.md), and [FAQ](docs/faq.md).

[All documentation](docs/)

## Community

Join the [Discord community](https://discord.gg/54sJqAxhUh) for setup help and discussion. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for reporting bugs or contributing.

## Credits

[Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) inspired the `raw/` → `compiled/` knowledge system.

## License

[MIT](../../LICENSE)

Independent project, not affiliated with Anthropic.
