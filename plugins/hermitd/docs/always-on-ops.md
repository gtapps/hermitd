# Always-On Operations (Non-Docker)

tmux-based setup for running your hermit without Docker, plus the lifecycle reference that applies to all always-on modes. For Docker setup, see [Always-On Setup](always-on.md).

---

## Prerequisites

| Requirement              | For          | Notes                                      |
| ------------------------ | ------------ | ------------------------------------------ |
| **tmux**                 | Boot scripts | `brew install tmux` / `apt install tmux` — see [Installing tmux](https://github.com/tmux/tmux/wiki/Installing) for other platforms |
| **Bun 1.3+**             | Hooks, scripts | Every hook and helper script runs on Bun |
| **Claude Code v2.1.292+** | Channels, sandbox | Minimum supported version |

tmux is required. Channels are optional.

---

## 1. Starting a Persistent Session

```bash
cd /path/to/your/project
hermitd start
```

This reads `config.json`, starts a tmux session with your configured channels and permissions, and auto-runs `/hermitd:resident-start`. To stop:

```bash
hermitd stop        # graceful resident shutdown
hermitd stop --force # immediate kill
```

To pause/resume the running session without stopping it (also triggerable from a channel via the `!pause`/`!resume`/`!snooze <dur>` message commands):

```bash
hermitd pause on|off|snooze <dur>|status
```

**Config options:** If `remote: true`, adds `--remote-control` and names the session after `agent_name`. If `remote: false`, boot writes `isolatePeerMachines: true`, so cross-machine peer messages require operator approval. If `model` is set, passes it to Claude Code.

**Restarting dead sessions.** The first tmux always-on boot (`hermitd-start`) registers the watchdog scheduler on a 5-minute schedule (systemd user timer on Linux/WSL2, LaunchAgent on macOS, a cron line printed as fallback). That tick restarts dead sessions, nudges wedged ones, and keeps long-running context compacted. A boot that cannot write the resident launch overlay refuses to start; the watchdog keeps retrying until the cause is cleared. The overlay carries `pause-gate`, `ask-gate`, `component-privacy`, and `permission-denied-notify` instead of plugin-manifest entries and is read at launch only. The first registration also sets `watchdog.enabled: true` in `config.json`; a repair re-run of install leaves that setting as you have it. Opt out with `hermitd watchdog uninstall` — it removes the timer and sets both flags off. Setting `watchdog.scheduler_enabled: false` by hand only stops future boots from re-registering; an already-installed timer keeps ticking. On Linux add `loginctl enable-linger` if the hermit has to come back after a reboot before anyone logs in. Docker hermits need none of this: the entrypoint runs the same watchdog on its own cycle, and the container restart policy handles a dead session.

### Manual tmux (alternative)

```bash
tmux new-session -d -s hermit
tmux attach -t hermit
cd /path/to/your/project
claude --permission-mode auto
```

> **Why `--permission-mode auto`?** The default `auto` mode lets a classifier review each action before it runs — safer than `bypassPermissions`, more reviewed than `acceptEdits`. Deny patterns and hooks provide an additional safety layer. **Run `claude` interactively once first** to accept the workspace trust prompt — without this, the agent hangs in tmux.
>
> For fully unattended containers/VMs where any pause would stall the hermit, set `permission_mode: "bypassPermissions"` in `config.json` — `hermitd-start` maps this to `--dangerously-skip-permissions`. See [Always-On Setup](always-on.md) for the Docker workflow and [Permission Modes](https://code.claude.com/docs/en/permission-modes).

### Remote access

[Remote control](https://code.claude.com/docs/en/remote-control) connects from any browser or phone. Enable via config (`/hermit-settings remote`) or `--remote-control`. Connect at [claude.ai/code](https://claude.ai/code).

To spawn *new* sessions into a project from your phone, run `/hermitd:rc-gate` yourself — the hermit does not open the gate on its own — or supervise a standalone server per project with the systemd recipe in [Remote Endpoint](remote-endpoint.md). Both need a claude.ai `/login` on the machine.

---

## 2. Always-On Lifecycle

The resident process stays available while individual task records track commitments. Heartbeat, monitors and channels continue between assignments.

### Task flow

1. `hermitd-start` launches Claude Code in tmux and invokes `resident-start` for boot recovery and readiness, without selecting a task.
2. An assignment opens a record when `TASKS.md` policy calls for one. Progress, waiting reasons and lessons are written through `task.ts`.
3. A result stays open and unconfirmed until a check passes, a named person confirms it, or the requester clearly adopts it (acts on it, thanks for it as finished, or builds the next request on it). A named approver still confirms in words. Explicit cancellation closes it without claiming success. Check closure is prompt-free only under auto permission mode; on default mode each run raises the normal permission prompt.
4. Close or cancel returns the next runnable resident record. Continue that work in the same turn.
5. `hermitd-stop` shuts down the resident process. Open commitments remain records for the next boot.

Quiet hours and midnight never complete work. A task with a waiting reason remains open until its state changes, without parking the whole resident.

### Context clears

`context_hygiene.clear` defaults to an hour of operator quiet, a maximum context age of 24 hours, and a floor of 20,000 compactible tokens. A policy change is another trigger. The watchdog sends `/clear` only after the execution boundary is safe and the pane is unchanged across two ticks. No model wake is needed and native monitors keep running. See [context hygiene](config-reference.md#context_hygiene) for fields and guards.

### Background work

Quiet heartbeat polls stay in scripts. An EVALUATE wake handles checklist work and notices; clean results are damped by `heartbeat.clean_recheck_cooldown`. Reflection runs on its own schedule. Brief and weekly review consume task outcomes and requested/observed duty summaries, not frozen archives.



### Daily rhythm

If routines are configured (default after init or upgrade):

- **Morning routine** — `brief --morning` at configured time (default: active hours start + 30m): generates a brief, reviews pending proposals, checks priorities. Framing adapts to `always_on` setting.
- **Evening routine** — `brief --evening` at configured time (default: active hours end - 30m): summarizes the day's task outcomes and flags tomorrow's priorities.

Both fire from `/hermitd:hermit-routines`: a native plugin monitor started by the activation skill where available, per-session CronCreate jobs as fallback. Configure with `/hermitd:hermit-settings routines`.

### Idle agency

A runnable record is open, owned by `resident`, and has neither a result nor a waiting reason. When one has waited longer than `tasks.queue_nudge_minutes` (default 60), heartbeat emits a notice with an acknowledgement token. Under `conservative`, it notifies the requester in the task's place; under `balanced` or `autonomous`, it continues the record in that turn. A matching acknowledgement suppresses repeat notices for that record state.

Reflection is not driven by idleness; it runs on the `reflect` schedule under `/hermitd:hermit-routines`.

### Edge cases

- **Crash during work:** records persist. `resident-start` reports open work and the execution observation without prompting to archive it or selecting a new task.
- **Waiting for input:** the record's `waiting_on` remains visible; unrelated resident duties continue.
- **Already running:** `hermitd-start` verifies runtime metadata and reports attach guidance. Missing metadata requires a restart so recovery can establish the correct process identity.
- **Container shutdown:** stopping the process does not confirm or cancel its open records.

---

## Routines

Routines are time-triggered skills managed by the `/hermitd:hermit-routines` skill. Where the Monitor tool is available, all enabled routines except `heartbeat-restart` run from one native plugin monitor started by the activation skill: it evaluates every routine's cron schedule directly (no LLM needed to check the clock), so a skipped fire costs zero model tokens and routines due in the same poll batch into a single wake. `heartbeat-restart` stays a CronCreate re-arm anchor that keeps the monitor alive. Where Monitor is unavailable, `load` falls back to registering every enabled routine as its own per-session CronCreate job, idle-gated at the harness turn level. Scheduled work that needs only a github.com repository, with no local files or services, can use Claude Code's native [`/schedule`](https://code.claude.com/docs/en/routines), which runs in the cloud on a one-hour minimum interval and requires a claude.ai subscription login; hermit routines are for precheck-gated work on this machine.

### Config

Routines live in `config.json` as a `routines` array:

```json
"routines": [
  {"id": "morning", "schedule": "30 8 * * *", "skill": "hermitd:brief --morning", "enabled": true},
  {"id": "evening", "schedule": "30 22 * * *", "skill": "hermitd:brief --evening", "enabled": true},
  {"id": "heartbeat-restart", "schedule": "0 4 * * *", "skill": "hermitd:hermit-routines load", "enabled": true},
  {"id": "weekly-deps", "schedule": "0 9 * * 1", "skill": "my-plugin:dependency-audit", "enabled": false}
]
```

- `id`: unique name for dedup and display
- `schedule`: 5-field cron expression (`minute hour dom month dow`), written in `config.timezone`. Monitor mode evaluates it directly in that timezone; the CronCreate anchor/fallback path converts it to machine-local time at registration (see [Config reference — routines.schedule](../docs/config-reference.md#cron-schedule-rules))
- `skill`: full slash-command name (e.g. `hermitd:brief --morning` for plugin skills, `ha-refresh-context` for local project skills)
- `model`: optional — one of `opus`, `sonnet`, `haiku`. Runs the skill in a subagent at that model to save cost on lightweight routines (e.g. URL checks, threshold comparisons). Subagents run in isolated context and return only a one-line status, so only use it on stateless routines — not ones whose value is chat/transcript output, and not `heartbeat-restart` (ignored there). See [config-reference](config-reference.md#routines) for details.
- `enabled`: toggle without removing

Manage with `/hermitd:hermit-settings routines`. Changes take effect immediately — `hermit-settings` auto-runs `/hermitd:hermit-routines load` after writing config. If you edit `config.json` by hand, run `/hermitd:hermit-routines load` to apply.

### How it works

`hermitd-start.ts` auto-sends `/hermitd:hermit-routines load` after launching the always-on session. The skill resolves `$CLAUDE_PLUGIN_ROOT`, then asks `scripts/routines.ts arm begin` what actually needs arming — a `HEALTHY` verdict (monitor registered for this boot, ticking, and matching config; anchor current) stops the skill right there with no `TaskStop`/`Monitor`/`Cron*` calls at all. On `ARM` it executes the plan the verb printed:

**Monitor mode (tried first).** Activates one native plugin monitor started by the activation skill (`scripts/routine-monitor.sh`, 60s poll) running `scripts/routines.ts due`, which reads `config.routines` directly, evaluates each enabled non-anchor routine's schedule against `state/routine-schedule.json` cursors, applies the pause and execution gates itself, and prints a single `ROUTINE_DUE [hermit-routine:<id>] ...` line only for routines that should actually wake the session ; a routine that's due-but-skipped costs zero model tokens. `hermit-routines run <ids>` handles the wake: it re-runs `scripts/routines.ts precheck` for the `started` stamp, invokes the skill on `PROCEED`, then calls `scripts/routines.ts finish`, which verifies any declared `expect_artifact` contract and writes the one terminal row to `state/routine-metrics.jsonl`. The anchor (`heartbeat-restart`) still registers via a single `CronCreate`, kept fresh by the same diff-planner (`scripts/routines.ts arm`) described below, scoped to that one routine.

**CronCreate fallback** applies when the Monitor tool is unavailable (Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, or `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set) or when the monitor subprocess never produced a liveness tick. Every enabled routine, anchor included, registers as its own per-session CronCreate. `scripts/routines.ts arm begin --fallback` diffs against `state/cron-registry.json` (a derived mirror, keyed to the current boot via `state/.boot-id`) — unchanged (`KEEP`), re-registered (`DELETE`+`CREATE`) on a schedule/metadata edit, or re-registered regardless of config changes once aging toward CC's 7-day auto-expiry cliff. The schedule shift (`config.timezone` → machine local time, via `lib/cron-shift.ts`) happens inside this step — monitor-mode routines skip it, evaluating directly in `config.timezone`. Each `CREATE` gets a prompt that runs `scripts/routines.ts precheck`, invokes the skill on `PROCEED`, then calls `scripts/routines.ts finish`, which verifies any declared `expect_artifact` contract and writes the one terminal row to `state/routine-metrics.jsonl`; each `DELETE` tears down the matching `[hermit-routine:*]` entry first. On an unchanged, fresh config this is a no-op with zero `CronList`/`CronCreate`/`CronDelete` calls. CronCreate fires only between REPL turns — never mid-task; a fire that comes due during `in_progress` is deferred (not dropped) until idle.

`/hermitd:hermit-routines load --reset` bypasses both diffs and does an unconditional sweep — the escape hatch for suspected drift.

`routines.ts precheck` gates every routine fire regardless of delivery mechanism (the `heartbeat-restart` anchor is the exception — its rendered prompt runs `arm anchor`, which applies the pause gate and the `started`/`fired` stamps itself): it suppresses a routine with a `skipped-paused` event when the binding pause flag is set; otherwise it stamps `started` and returns `PROCEED`. When the routine declares `expect_artifact`, `precheck` also freezes that fire's contract into `state/routine-run.json` — the `{date}` token resolved in `config.timezone` at start, plus the target's filesystem identity — which `routines.ts finish` compares against afterwards. In monitor mode, `routines.ts due` applies the pause gate itself before ever waking the session, plus a lateness gate (occurrences older than `routine_max_lateness_minutes`, default 60, are consumed with a `skipped-late` event and never wake the session) and an operator-turn defer (Stop-cleared `state/operator-turn-open.json` marker, 60-min TTL backstop) approximating the idle gate CronCreate gets for free from the harness. A deferred occurrence records a `held_at` poll stamp in `state/routine-schedule.json`: its lateness clock runs from that stamp, so time spent deferred does not count and the occurrence fires at the first poll after the turn clears. Only observed polls earn that credit: an occurrence already past the limit when the turn opens is still consumed as `skipped-late`, and so is one whose deferral was interrupted by downtime.

**`heartbeat-restart`** fires at 4am daily and re-invokes `load`, re-arming the routine monitor (or, in fallback mode, the routine CronCreates — which expire after 7 days without this daily re-arm); unless `heartbeat.enabled` is explicitly false, the same fire re-registers the heartbeat Monitor.

Inspect live state with `/hermitd:hermit-routines status` (monitor liveness + anchor, or the full CronCreate list in fallback mode). Inspect fire history with `tail .hermit/state/routine-metrics.jsonl` — each row's `delivery` field is `monitor` or `cron-create`.

### Relationship to heartbeat and monitors

|                | Routines                         | Heartbeat                      | Monitors                          |
| -------------- | -------------------------------- | ------------------------------ | --------------------------------- |
| Timing         | Exact cron schedule              | Every N minutes                | Event-driven or interval          |
| Engine         | Monitor subprocess (60s poll, gates in-script); CronCreate anchor + fallback | CC Monitor (subprocess poll)   | Monitor tool (OS subprocess)      |
| Cost           | Zero tokens for a skipped fire (monitor mode) | Zero tokens when quiet         | Zero tokens when quiet            |
| Survives exit  | No (re-registered on launch; anchor re-arms daily) | No (re-armed daily by heartbeat-restart) | No (session-scoped)    |
| Mid-task fire  | Deferred while an operator turn is open (Stop-cleared marker, 60-min TTL) — coarser than CronCreate's turn-level idle gate, can interject | Yes (interrupts)               | Yes (interrupts)                  |
| Use for        | Scheduled tasks (briefs, audits) | Continuous monitoring          | Reactive watching / quiet polling |

**Hybrid model:** Monitors handle reactive event streams (interrupt-OK). Routines handle scheduled work, gated outside the session for near-zero cost. Heartbeat handles continuous health checks. Neither replaces the others.

Config-defined watches auto-register at session start. Runtime truth: `.hermit/state/monitors.runtime.json`. See `/hermitd:watch` for ad-hoc watching.

---

## 3. Channels

Channels let you talk to your hermit from your phone via Telegram, Discord, or iMessage. Setup, pairing, and Docker-specific config are covered in [Always-On Setup](always-on.md#channels-in-docker) and the [Claude Code Channels docs](https://code.claude.com/docs/en/channels).

For bare-tmux setups, Hermit scopes channel config to `.claude.local/channels/<name>/` by default, including when `channels.<name>.state_dir` is omitted. `hermitd-start` exports the derived `<NAME>_STATE_DIR` so the channel MCP server uses that project-local directory. Keep `.claude.local/` gitignored.

---

## 4. Cost Management

The `cost-tracker` hook tracks spend automatically. For detailed token optimization settings, budgets, and env config, see [Always-On Setup: Cost Management](always-on.md#cost-management).

Quick summary: set installation-wide daily, weekly, and monthly USD caps in the `budget` block of `config.json` (warns once at 80%; at 100% it alerts, or pauses the resident until the window resets, per `budget.action`) and project-level budgets in OPERATOR.md.

### Cheap always-on

Four levers, in rough order of impact:

**1. Whole-session model** (`config.model: "haiku"`). The single highest-leverage cut. Every idle turn (routines, interactive) inherits the session model; heartbeat evaluation uses `heartbeat.model` (default `haiku`, `null` to inherit). Tradeoff: your interactive work and idle task pickup also drop to Haiku. It is whole-session, not heartbeat-only. Set via `/hermit-settings` or directly in `config.json`.

**2. Per-routine model override** (since v1.0.20). Routines that are self-contained and stateless (URL checks, threshold comparisons, file audits) can run their skill in a subagent at a cheaper model:

```json
{"id": "cortex-refresh", "schedule": "0 6 * * *", "skill": "...", "model": "haiku"}
```

Not suitable for routines whose value is chat or transcript output (subagent output collapses to one line) or for `heartbeat-restart` (must run in-session). See the [Routines](#routines) section above and [config-reference](config-reference.md#routines).

**3. Interval and active hours.** Cost is wakes/day × cost/wake. Widen `heartbeat.every` (default `30m`) or tighten `active_hours` in `config.json`. Only `EVALUATE` wakes cost tokens; the `--peek` poll between them is free.

**4. Checklist curation.** A shorter, sharper `HEARTBEAT.md` lets the free OK precheck path fire more often, skipping the full LLM eval. `/hermitd:heartbeat edit` warns when the list exceeds 10 items.

**Measure before and after:** run `/hermitd:cost-reflect` to see spend broken down by trigger source (`heartbeat`, `routine:<id>`, `routine:multi`, `channel:<name>`, `peer`, `other`) and by token type. The routine rows are the ones a per-routine model override shrinks; `heartbeat` responds to interval/checklist changes; `channel:<name>` identifies channel-triggered turns; `peer` appears as "other sessions on this machine"; `other` covers interactive and unattributed turns.

---

## 5. Reconnecting After Disconnects

Restarts the watchdog detects (a dead session, a frozen pane, a dead monitor) resume the resident conversation when the session id is known and no other restart happened in the previous hour (`last_restart_at` in `state/watchdog-state.json`); a missing id starts fresh as `fresh: no-session-id` and a crash loop starts fresh as `fresh: recent-restart`, both recorded in `state/watchdog-events.jsonl`. A restart requested through `hermitd-watchdog restart`, such as a login renewal, always starts fresh (`fresh: requested`). `hermitd-start` still starts fresh when the transcript has no user turn. The restart notice says whether the conversation was restored or started fresh.

For a manual start that keeps the conversation, use `hermitd-start --resume` or `hermitd-docker restart --resume` (`hermitd-docker up --resume` also accepts the opt-in). Manual resume skips the loop guard but still requires a transcript with a user turn. Starts without `--resume` create a fresh conversation. Resume applies only to always-on boots with a bootstrap prompt; the existing archive-or-resume recovery question still controls whether work continues.

Progress and waiting reasons remain in task records even when a restart starts a fresh conversation.

1. Run `hermitd-status` to check current state (includes the tmux attach command for Docker)
2. Reattach to tmux, start Claude Code
3. SessionStart hook loads OPERATOR.md, TASKS.md and open task records
4. `resident-start` reports recovery state and open commitments without selecting work.
5. Confirm resume or start fresh

---

## 6. Login Renewal

A hermit on subscription auth can hold a **long-lived login token** minted with `claude setup-token` — offered right after login in `/docker-setup`, recommended. It lasts a year, and because the hermit mints it, the expiry date is known from day one — the CLI itself exposes no expiry surface for these tokens, so the hermit tracks it in `state/setup-token.json`.

This is not Docker-only. A **host** install (systemd unit, launchd job, cron entry) holds the token the same way and gets the same renewal relay. The difference is invisible from the outside: under Docker, compose hands the watchdog loop and the session one environment, so the watchdog can read the session's auth setup straight from its own. On a host the unit carries only `PATH`, so the watchdog learns where the token lives from the `config_dir` stamp the session writes into `state/runtime.json` at `SessionStart`. Before that stamp existed, a host token hermit with a custom `CLAUDE_CONFIG_DIR` was misread as a `/login` hermit and told to go sign in by hand instead of being offered the relay.

A hermit can equally run on the plain claude.ai sign-in itself — `auth_mode: login` — and that is the only credential Remote Control accepts. Both modes renew the same way, over your channel, with no server access; they differ in cadence and in one mechanical detail. A sign-in lasts about **30 days** (its `refreshTokenExpiresAt`, the one field a silent refresh does not move) against the token's year. And where a token is installed on the spot, a renewed sign-in is written to a staging config dir and left there: the resident session rewrites `.credentials.json` roughly every 8 hours, so a renewal written underneath it can be silently undone. The watchdog moves the staged file into place inside its own restart — after the old session is verifiably dead and before the new one starts — which is the only window in which nothing is holding the file. Until that restart the sign-in is staged, not live, and `setup-token-mint status` reports `pending: true`.

`auth_mode` is resolved from the credential volume when it is unset, so a hermit that predates the key behaves exactly as it did. macOS is the one platform where the volume can lie: Claude Code keeps a `/login` credential in the encrypted Keychain rather than in `.credentials.json`, and keys that Keychain entry to `CLAUDE_CONFIG_DIR`, so a sign-in staged under a staging config dir could never be moved into place anyway. An install with no credential file therefore resolves as `external` and sits every renewal path out. Two macOS cases are unaffected: a **token** hermit authenticates from `CLAUDE_CODE_OAUTH_TOKEN` with the Keychain out of the picture, and a **sign-in made over SSH**, where the locked Keychain makes Claude Code fall back to `.credentials.json`: the file is there, the install resolves as `login`, and it renews like any other. An API key or cloud-provider credential in the environment resolves as `external` too — no relay can renew what the operator's own shell owns.

**Three days before expiry** — either mode, matching the window Claude Code itself warns on — the hermit asks you over your channel. Reply and it sends a one-time sign-in link; open it, send back the code it gives you, and the hermit renews and restarts itself. Doctor's `credential-expiry` check reports the same thing if you'd rather see it there.

**If a credential lapses unnoticed**, the hermit recovers itself. It can't think without a working login, so this path runs deterministically in the watchdog: it messages you that it's down and waits. Reply `reauth` when you're at a browser, and the same link-and-code exchange follows. Nothing happens until you reply — a one-time link minted at 3am while you're asleep would just expire unused. The same recovery fires when a credential stops working *before* its recorded expiry (revoked, rotated, restored from an old backup): the record still reads healthy, so the watchdog goes by what the session is actually saying on screen.

**If the relay can't reach you at all** — no channel configured, or the send itself fails — it stamps `state/relay-unreachable.json` and the watchdog honours that for 24 hours: one push notification, then silence, instead of respawning a doomed relay every tick. After a day it tries again, since an unreachable channel is usually an outage rather than a permanent state.

You can also renew from a terminal at any time:

```bash
hermitd docker setup-token
```

Notes:

- The sign-in link and the code travel over your channel. **The token itself never does** — it goes straight into a `0600` file on the container's config volume, and is never printed or logged.
- The token is deliberately not stored in `.env`: Docker applies `env_file` only when a container is created, so a token there could not be rotated without recreating the container from the host — the manual step this whole flow exists to remove.
- **Never run `/logout` inside the container.** It deletes the stored credentials *and* resets first-launch state, after which the interactive wizard demands a login and won't accept the token. Renewal never needs it.
- A fresh install still does one attended `/login` before minting the token, because the first-launch wizard requires it. Initial setup is attended anyway, so this costs nothing after day one.

---

## 7. Security

See [Security](security.md).

---

## 8. Operational Concerns

### Rate limits

Claude Max 20x ($200/month) recommended for overnight agents. Pro plan stalls during multi-hour sessions. Rate limit pauses are **silent** — add to OPERATOR.md:

```markdown
## Constraints

If you hit a rate limit, record the waiting reason through `task.ts block` for the affected task.
```

### Data persistence

Task records are durable local state. Back up `.hermit/tasks/` with your other resident state. Docker users can also use named volumes — see [Always-On Setup](always-on.md).

### Channel resilience

If Telegram/Discord goes down, your hermit keeps running — just loses remote communication. Enable remote control as a backup. Inspect task records via SSH if channels are unavailable.

### Multi-operator warning

Hermit assumes one person giving it direction per project. For teams, use separate branches or git worktrees with isolated state directories.

### Auto-restart on reboot

**Linux (systemd):**

```bash
# /etc/systemd/system/hermit.service
[Unit]
Description=Claude Code Hermit
After=network.target

[Service]
Type=forking
User=your-username
WorkingDirectory=/home/your-username/my-project
ExecStart=/home/your-username/my-project/.hermit/bin/hermitd-start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Alongside `ExecStart=`, add `ExecStop=/home/your-username/my-project/.hermit/bin/hermitd-stop` under `[Service]`. Scheduler commands call the project wrappers directly so recovery does not depend on the host shim.

**macOS (launchd):** Create a plist in `~/Library/LaunchAgents/` that runs `hermitd-start` at login. The SessionStart hook reloads session context automatically.

**Docker:** `restart: unless-stopped` handles it automatically — see [Always-On Setup](always-on.md). The entrypoint's SIGTERM trap ensures graceful session close on system shutdown.

A manual `claude --resume` or a new Claude session launched from a shell opened through `hermitd-attach` is a guest. Guests ignore channel messages, including sessions that inherit the resident's environment. The verdict is taken at session start and never revisited, so a guest keeps leaving channel messages alone even after the resident stops. Recognising an environment-inheriting session needs the resident's `session_pid` stamp in `state/runtime.json`, and a session already running when the plugin update lands is only classified at its next start. Use `hermitd start --resume` to bring an old transcript back as the resident.
