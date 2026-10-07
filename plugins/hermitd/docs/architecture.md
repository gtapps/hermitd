# Architecture

A Claude Code plugin that turns any Claude Code instance into a self-improving personal assistant. No custom runtime, no server. Just markdown and JavaScript files on top of everything [Claude Code already provides](https://code.claude.com/docs/en/plugins).

---

## Overview

```
 +-----------------------------------------------------------------+
 |                    LAYER 1: CHANNEL SURFACE                      |
 |   Terminal    Remote Control    Channels (Telegram/Discord)      |
 |   Headless (claude -p "...")                                     |
 +-------------------------------|----------------------------------+
                                 |
 +-------------------------------v----------------------------------+
 |                    LAYER 2: TASK RECORDS                         |
 |   tasks/T-*.md           <-- durable commitments                  |
 |   Lifecycle:  open --> work --> check/confirm/cancel              |
 +-------------------------------|----------------------------------+
                                 |
 +-------------------------------v----------------------------------+
 |                    LAYER 3: AGENT LAYER                          |
 |   proposal-triage, reflection-judge, evolve-runner               |
 |   (Hermits add specialized agents here)                          |
 +-------------------------------|----------------------------------+
                                 |
 +-------------------------------v----------------------------------+
 |                    LAYER 4: SKILLS + HOOKS                       |
 |   skills       9 hook events    3 profiles (minimal/standard/strict)   |
 +-------------------------------|----------------------------------+
                                 |
 +-------------------------------v----------------------------------+
 |                    LAYER 5: REPO ARTIFACTS                       |
 |   CLAUDE.md - OPERATOR.md - TASKS.md - tasks/ - proposals/        |
 +-----------------------------------------------------------------+
```

---

## Layer 1: Channel Surface

Input-agnostic. Same session discipline regardless of how your hermit is invoked.

| Channel                                                          | Use                                  |
| ---------------------------------------------------------------- | ------------------------------------ |
| Terminal                                                         | Interactive sessions                 |
| [Remote Control](https://code.claude.com/docs/en/remote-control) | Browser/phone access                 |
| [Channels](https://code.claude.com/docs/en/channels)             | Telegram, Discord, iMessage          |
| Headless                                                         | `claude -p "..."` for scripted tasks |
| [External control surface](external-control-surface.md)          | Orchestrator MCP (stdio)             |

All channels converge on the resident. A chat assignment opens a task record keyed `<sourceKey>:<chat_id>` (its own Discord thread on a guild text or announcement channel) and runs in a `task-worker` subagent; the record's `owner` holds that worker's agent id. Authorized replies in an open thread reach the resident without another mention, and the resident sends them on to the recorded worker, starting a fresh one only when that send fails. The worker edits the thread's progress card itself and returns one line naming its report file. [Claude Tag](https://claude.com/docs/claude-tag/concepts/how-it-works) provides thread-owned sessions natively in Slack; [Remote Control](https://code.claude.com/docs/en/remote-control) connects one person to their session; Hermit's thread ownership serves self-hosted Discord and Telegram.

---

## Layer 2: Task Records

A task record is one commitment with an owner, requester, definition of done, progress, lessons and a named closure actor. Records live in `tasks/T-*.md`; only `task.ts` writes them. Several commitments can remain open while the resident handles channels and scheduled duties.

```text
assignment -> open record -> work -> result awaiting confirmation
                              |              |
                              +---- check or confirmation -> done
                              +---- explicit cancellation -> cancelled
```

**Start:** `/hermitd:resident-start` classifies the boot, inspects execution observations and open records after a crash, and reports readiness. It does not select work or accept a `--task` argument. `TASKS.md` supplies the operator's record policy at SessionStart.

**Work:** `task.ts note`, `block`, and `lesson` update the record. Guild assignments may have resident-owned threads and progress cards. Presentation on a channel never replaces the record. Execution observations in `state/execution.json` and the Claude Code registry describe whether the process is safe to interrupt, independently of whether commitments remain open.

**Close:** A record closes only by a successful check, confirmation, or explicit cancellation. Confirmation is explicit words, or the requester clearly adopting the result. A named approver still confirms in words. A submitted result alone is unconfirmed. Time, midnight, process shutdown and context resets do not close commitments. Close/cancel returns the next runnable resident record so work can continue in the same turn.

**Read:** Brief, reflection, weekly review, health and reporting use `task-report.ts` to distinguish done, cancelled, unconfirmed and open records. Task spend is split equally across a turn's task IDs and indexed by date. Duty summaries show requested configuration beside observed execution.

**Frozen archives:** Existing `sessions/`, including `SHELL.md` and `S-NNN-REPORT.md`, stays on disk after upgrade. Recall still indexes that history; task readers never open it and no history is converted into task records.

---

## Layer 3: Agent Layer

| Agent                    | Model  | Max Turns | Role                                                                              |
| ------------------------ | ------ | --------- | --------------------------------------------------------------------------------- |
| `evolve-runner`          | Sonnet | 50        | Runs the hermit-evolve upgrade in isolation                                       |
| `proposal-triage`        | Haiku  | —         | Pre-creation gate: deduplicates proposals, applies three-condition rule           |
| `reflection-judge`       | Sonnet | —         | Post-reflect validator: verifies cross-session evidence citations before queuing  |

Tools: Read, Write, Edit, Bash, Glob, Grep. No web access. Uses `memory: project` for accumulated knowledge across sessions.

Hermits extend this layer with specialized agents when they ship them; the active set varies per hermit and is documented in each plugin's `CLAUDE.md`.

---

## Layer 4: Skills and Hooks

### Skills

Skills are namespaced `/hermitd:*`; the full set is listed in the plugin's `CLAUDE.md` (Plugin Structure).

### Hooks

The plugin manifest registers 16 shared hooks. The four resident-only hooks (`pause-gate`, `ask-gate`, `component-privacy`, and `permission-denied-notify`) ride the resident's launch overlay with absolute script paths. Claude Code reads this overlay at launch only, so a rewritten overlay needs a resident restart. Guest and helper sessions launched without it never load the four hooks. `hermitd-start` seeds workspace trust before launch and refuses to boot without a written overlay; `hermit-doctor` checks the overlay and trust configuration with `overlay-hooks`.

| Hook | Event and matcher | What it does |
| ---- | ----------------- | ------------ |
| Helper report relay | PreToolUse `.*reply$` | Replaces a `[[helper-report <id>]]` reply with that report from `helper-reports/`, refusing the send when the placeholder is malformed or no single open record owns the chat |
| Cache edit guard | PreToolUse `Edit\|Write` | Warns (or blocks) when Edit/Write targets a marketplace cache copy |
| Settings gate | PreToolUse `Bash\|Edit\|Write` | Raises Claude Code's native permission prompt for execution-adjacent hermit settings, channel enrollment, and direct `config.json` edits |
| Artifact backend guard | PreToolUse `Artifact` | Denies a native Artifact publish when `artifacts.backend` is not claude, with a reason that names the backend |
| Channel responder invoked | PostToolUse `Skill` | Resident-only evidence that the channel responder was invoked |
| Helper report relay | PostToolUse `.*reply$` | Fails the reply when a `[[helper-report <id>]]` placeholder was not substituted |
| Channel hook | PostToolUse `(discord\|telegram\|imessage).*reply` | Captures outbound reply text and persists `dm_channel_id` only for replies to a matching inbound message |
| Config validator | PostToolUse `Edit\|Write` | Validates `config.json`'s required keys, types, routine time formats, and channel structure |
| Summary generator | PostToolUse `Edit\|Write` | Regenerates `state-summary.md` when a `state/` file is edited |
| Usage tracker | PostToolUse `Read` | Appends a usage event to `state/usage-metrics.jsonl` when a `compiled/` artifact is read |
| Prompt pipeline | UserPromptSubmit | Runs resident, conversation and channel gates before audit; shutdown takes precedence over pause and command handling. Its harness mode returns native mod command decisions through the same stages |
| Chat harness mod | `prompt.submit`, `turn.complete` | Executes trusted chat commands and deferred switches natively, observes outcomes and replies through the core verb; dispatch-scoped model approval preserves settings-level deny or ask |
| Context loader | SessionStart | Classifies residency, seeds resident activity when absent, and loads session context; on a managed session (`HERMIT_MANAGED=1`) also stamps the launch env into `runtime.json` |
| Stop pipeline | Stop | Runs cost tracking, permission-mode and doctor delivery, and the heartbeat stamp; a channel checkpoint (intake or reply) may block the stop |
| StopFailure stamp | StopFailure | Records the turn's typed upstream failure to `state/stop-failure.json`; the watchdog classifies from it and notifies |
| Subagent cost | SubagentStop | Captures async-dispatched subagent token cost from the subagent transcript |
| PreCompact stamp | PreCompact | Marks the resident execution unknown and stamps its context reset |
| Pause gate | PreToolUse `*` (launch overlay) | Binding pause/stop/resume gate: while `state/pause.json` says paused, denies every tool call except channel `reply` and PushNotification |
| Ask gate | PreToolUse `AskUserQuestion` (launch overlay) | Denies AskUserQuestion on unattended sessions with a redirect to the channel reply tool and the micro-proposal bridge |
| PermissionDenied notify | PermissionDenied `*` (launch overlay) | Maintainer diagnostic (tool + reason), one 30-min window per tool with a suppressed count; maintainer chat, else primary chat on a technical profile, else Findings; no client message |
| Component privacy | PostToolUse `Edit\|Write` (launch overlay) | Keeps a hermit-created skill or agent private to this install when the operator chose gitignored hatch outputs |

Hermits may add hooks at `strict` (e.g., git-push-guard). Profile-gated hooks check `AGENT_HOOK_PROFILE` internally and return early when the active profile doesn't match.

---

## Layer 5: Repo Artifacts

All state lives in git-tracked files. No database, no external service.

### Plugin file map

```
hermitd/
├── agents/proposal-triage.md, reflection-judge.md, evolve-runner.md, skill-eval-runner.md
├── hooks/hooks.json
├── scripts/               # Hook implementations + boot scripts
├── skills/                 # skill definitions
├── state-templates/        # Copied into projects by init
└── .claude-plugin/plugin.json
```

### Per-project state (after init)

```
your-project/
├── .hermit/
│   ├── tasks/T-*.md
│   ├── proposals/PROP-NNN.md
│   ├── compiled/review-weekly-YYYY-Www.md  # Weekly review reports (weekly-review.ts; type: review)
│   ├── state/                        # Runtime observations (agent-owned, not operator-configured)
│   │   ├── runtime.json              # Process stamp (config_dir, env_auth, inbox_socket, session_pid, peer_name); execution is state/execution.json
│   │   ├── alert-state.json          # Alert dedup state + self-eval evidence (heartbeat-owned)
│   │   ├── reflection-state.json     # Last reflection timestamp (reflect-owned)
│   │   ├── channel-activity.json     # Last channel interaction timestamp (channel-hook-owned)
│   │   ├── channel-replies.jsonl     # Append-only channel reply log (channel-hook-owned)
│   │   ├── channel-log.sqlite        # Episodic DM log + FTS5 index (PROP-010); created lazily, absent until first message
│   │   ├── proposal-metrics.jsonl    # Append-only event log (proposal-create + proposal-act)
│   │   ├── usage-metrics.jsonl       # Append-only compiled-read usage log (usage-track.ts)
│   │   ├── micro-proposals.json      # Pending micro-approvals list (reflect + channel-bridged asks + channel-responder)
│   │   ├── state-summary.md          # Auto-generated health snapshot (generate-summary.ts)
│   │   ├── monitors.runtime.json     # Active watch registry, cleared on session start (watch-owned)
│   │   ├── operator-pause.json       # Operator/watchdog pause (pause stage/watchdog-owned)
│   │   ├── auto-pause.json           # Budget-breach auto-pause (cost-tracker-owned)
│   │   ├── budget-alerts.json        # Budget alert dedup (cost-tracker-owned)
│   │   ├── telemetry-alert.json      # Telemetry export-failure alert dedup (telemetry-export-owned)
│   │   ├── channel-health.json       # Advisory channel send-liveness (channel-send-owned)
│   │   ├── operator-turn-open.json   # Transient "an operator turn is in flight" marker (opened on operator prompts, cleared at Stop)
│   │   ├── .heartbeat                # Activity marker (heartbeat-touch-owned)
│   │   └── .lifecycle.lock           # Always-on lifecycle lock (hermitd-start-owned)
│   ├── bin/hermitd-start, hermitd-stop
│   ├── config.json
│   ├── OPERATOR.md           # Human-curated context — never edit autonomously; always confirm changes
│   └── HEARTBEAT.md
└── CLAUDE.md (session discipline appended)
```

No `package.json`, no `node_modules`, no build step.

#### state/ ownership model

One writer per state file. No shared mutation bus. (Exception: `state/micro-proposals.json` has several writers — reflect and the channel-bridged asking skills queue entries, channel-responder/brief resolve them — but the hermit runs as a single sequential session, so these never overlap; the "one writer" rule is about avoiding concurrent mutation, which single-session execution already guarantees here.)

**The single-session guarantee does not extend to hooks.** Claude Code does not serialise hook invocations: one assistant turn issuing parallel tool calls spawns several hook processes that run concurrently (probed 2026-08-28 — four denials, four pids, every `START` before the first `END`). A hook that owns a state file therefore cannot rely on the rule above, and must either append rather than read-modify-write (`lib/denial-log.ts`) or take the advisory lock (`lib/lockfile.ts`, as `permission-denied-notify.ts` does).

`startup-context.ts`'s session stamp is the one read-modify-write on `runtime.json` from a hook, and it is exempt by timing rather than by locking: `SessionStart` fires once per session, seconds after `hermitd-start` has finished its own write (which lands within milliseconds of `tmux new-session`, before Claude Code has booted). It is also idempotent: every later `SessionStart` in the same session recomputes the same four fields and skips the write when nothing moved, which keeps `updated_at` from drifting forward on a mere compaction and hiding a wedged session from doctor's liveness check.

| File                           | Owner (sole writer)                                 | Readers                                                       |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------- |
| `state/runtime.json`           | hermitd-start + cost-tracker + startup-context.ts (process stamp) | heartbeat, resident-start, /hermit-routines, hermitd-watchdog (config/env, registry, inbox), hermit-doctor (peer inbox) |
| `state/alert-state.json`       | heartbeat only                                      | heartbeat     |
| `state/reflection-state.json`  | reflect + session (non-overlapping phases)          | heartbeat (debounce), hermit-settings (session-check display) |
| `state/channel-responder-invoked.json` | channel-responder-invoked.ts only (resident Skill PostToolUse; session id and invocation time) | channel-reply-reminder stage (compares session and context-reset stamp) |
| `state/channel-activity.json`  | channel-hook.ts only                                | channel-responder, heartbeat                                  |
| `state/channel-replies.jsonl`  | channel-hook.ts (append only)                       | none — reflect's engagement join was removed (the ledger records outbound sends only, so it could not measure operator engagement) |
| `state/channel-log.sqlite`     | channel-reply-reminder stage + channel-hook.ts (append, via `lib/channel-log.ts`); weekly-review marks/prunes | search.ts (recall, fourth source); weekly-review consolidation |
| `state/observations.jsonl`     | reflect-precheck (`cost-spike`, `startup-drift`) + transcript-digest `--record-observation` (`behavior-digest`) + channel-responder via `observations.ts` (`skill-correction`) + reflect (`quick-deferral`, `reflect-noticed`); append only | reflect (step 3b graduation), reflection-judge (§1.4 ledger verification) |
| `state/proposal-metrics.jsonl` | proposal-create + proposal-act (append only)        | generate-summary.ts, proposal.ts metrics (read-only)   |
| `state/usage-metrics.jsonl`    | usage-track.ts (Read PostToolUse, append only; compacted >180d by weekly-review) | weekly-review (untouched-knowledge suggestions) |
| `state/micro-proposals.json`   | reflect + channel-bridged skills (queue, schema owned by reflect § Queuing procedure) + channel-responder/brief (resolve) | brief, generate-summary.ts |
| `state/state-summary.md`       | generate-summary.ts only                            | humans                                                        |
| `state/monitors.runtime.json`  | watch skill only                                    | resident-start and watch lifecycle      |
| `state/heartbeat-monitor.runtime.json` | `lib/heartbeat/start.ts` only — reached by `heartbeat start` and by `hermit-routines load` (`arm commit --heartbeat`) | heartbeat-start (write), heartbeat-stop (clear), heartbeat-restart (rewrite) |
| `state/heartbeat-liveness.json` | heartbeat-monitor.sh (every poll iteration)         | doctor-check.ts (heartbeat liveness check), heartbeat status  |
| `state/cc-stop-snapshot.json`  | stop-pipeline.ts only                               | doctor-check.ts (scheduler/background-task health check)      |
| `state/operator-turn-open.json` | user-prompt-pipeline.ts (opens at hook exit for a kept, non-blocked prompt, via record-operator-action.ts `openTurnMarker`) + record-operator-action.ts `--force`; stop-pipeline.ts (clears at Stop — the only deleter) | routines.ts due + lib/heartbeat/precheck.ts, both via the operator-turn guard (defer gate, 60-min TTL backstop against a marker orphaned by a failed Stop) |
| `state/stop-failure.json`      | stop-failure-stamp.ts (writer), stop-pipeline.ts (deleter — cleared on the next healthy, non-guest Stop) | hermitd-watchdog.ts (upstream API failure tier, preferred over the transcript scan while the stamp is the newer of the two) |
| `state/.heartbeat`             | heartbeat-touch.ts only                             | heartbeat (detect activity gaps)                              |
| `state/.lifecycle.lock`        | hermitd-start.ts only                                | hermitd-stop.ts (cleanup)                                      |
| `state/cost-index.json`        | cost-tracker.ts + subagent-cost.ts (each folds its own append; tmp+rename, offset-based) | cost-tracker.ts (getCumulativeCost fallback), doctor-check.ts |
| `state/watchdog-state.json`    | hermitd-watchdog.ts only                             | doctor-check.ts (`last_run` liveness + `consecutive_stale` + `last_hygiene_eval` + `hygiene_eval_counts`) |
| `state/context-surface.json`   | cost-tracker.ts only (derived at each compaction boundary) | hermitd-watchdog.ts (compact-tier conversation gate), doctor-check.ts (`context-age`) |
| `state/watchdog-events.jsonl`  | hermitd-watchdog.ts + channel-send.ts (append; maintainer fallback and undelivered client notices)                    | doctor-check.ts (event counts), resident-start (restart reason)|
| `state/template-manifest.json` | `manifest-seed.ts` (called by hatch seed, docker-setup baselines, hermit-evolve update-after-copy) | evolve-plan.ts (classify), doctor-check.ts (shape check) |

Per-file update policies for managed files under `.hermit/`:

- **bot-owned-overwrite**: `state/` runtime files, `config.json` keys added by upgrade — written by the hermit, overwritten on upgrade with no review.
- **operator-owned-never**: `OPERATOR.md`, `HEARTBEAT.md`, `sessions/`, `proposals/` — hermit never overwrites.
- **managed-with-merge-gate** (`templates/`): on upgrade, classified against `template-manifest.json` baseline; conflicts parked as `.new` for operator review; `customized-kept` files left untouched.
- **boot-critical-replace** (`bin/`): conflicts replace with the upstream version (`chmod +x`); operator's copy preserved as `.bak`; stale wrappers can dead-end the hermit so keeping them is never safe.

---

## Memory Model

```
+----------------------------------------------+
|  OPERATOR.md                                 |
|  Owner: Human. Lifetime: permanent.          |
|  Project context, priorities, constraints.   |
+----------------------------------------------+
|  Auto-memory (Claude Code built-in)          |
|  Owner: Agent. Lifetime: persistent.         |
|  Engineering lessons, codebase patterns,     |
|  operational experience. Primary input       |
|  for reflection.                             |
+----------------------------------------------+
|  compiled/                                   |
|  Owner: Agent. Lifetime: managed.            |
|  Durable domain outputs — briefings,         |
|  decisions, postmortems, assessments.        |
|  Injected on startup.                        |
+----------------------------------------------+
|  tasks/T-*.md                               |
|  Owner: task.ts. Lifetime: permanent.         |
|  Task, plan, progress, blockers, findings.   |
+----------------------------------------------+
|  TASKS.md                                   |
|  Owner: Agent. Lifetime: permanent.          |
|  Operator policy for recording assignments. |
+----------------------------------------------+
|  state/channel-log.sqlite (PROP-010)         |
|  Owner: Agent (hooks). Lifetime: substrate.  |
|  Forward-only DM log — the conversational    |
|  layer above didn't capture. Consolidated    |
|  weekly into memory/compiled; raw rows       |
|  pruned only after consolidation.            |
+----------------------------------------------+
```

OPERATOR.md is human-curated — your hermit reads it but never modifies it. Auto-memory is Claude Code's built-in [persistent memory](https://code.claude.com/docs/en/sub-agents) and the primary input to learning. `compiled/` is for durable domain outputs the operator wants surfaced across sessions — distinct from auto-memory, which handles operational lessons. Task records hold progress and lessons. Readers consume normalized outcomes; operator policy lives in TASKS.md. `channel-log.sqlite` is the episodic substrate below all of the above: it captures the operator's actual DM text (deterministically, at hook level) so a concluded channel thread survives context compaction even before anything from it gets promoted. It's feature-detected everywhere it's read — a hermit with no channel traffic never creates the file, and recall/consolidation simply see nothing from this source.

The `proposal-triage` and `reflection-judge` gate agents each carry their own private `memory: project` store (at `.claude/agent-memory/<agent-name>/MEMORY.md`). These are **isolated from the operator's memory** — triage accumulates suppression-pattern heuristics, judge accumulates hollow-evidence shapes. Private memory sharpens judgment but is never the sole basis for a suppress verdict. Over-suppression is bounded by the reflect Component Health check (`state/reflection-state.json` and `state/proposal-metrics.jsonl` counters).

### Knowledge directories

```
.hermit/
  raw/          # Domain inputs (fetched data, snapshots, logs) — ephemeral
    .archive/   # Expired raw artifacts, moved by archive-raw.ts
  compiled/     # Domain outputs (briefings, decisions, assessments) — durable
  knowledge-schema.md  # Per-hermit behavioral schema: what to produce and when
```

**Ownership boundary:** Claude Code memory owns instructions, preferences, and recurring operating context; hermit knowledge owns domain artifacts; skills own procedures.

A `procedure-brief` (`type: procedure-brief`) is the boundary case: it lives in `compiled/` as a *record* of what recurring procedure was observed and which sessions showed it. The installed skill under `.claude/skills/` is the live procedure. The brief is not injected at startup (it is a transient record, not a durable domain output); the installed skill is what the operator cares about day-to-day.

**Scope boundary:**

| Concern | Owner |
|---------|-------|
| Operational learning (lessons, patterns, preferences) | Auto-memory |
| Durable domain outputs the operator wants surfaced across sessions | `compiled/` |
| Domain operational inputs | `raw/` |
| Session state | `state/` |

`compiled/` artifacts use the [frontmatter conventions](frontmatter-contract.md) with a required `type` field. Startup injection reads `compiled/` frontmatter and injects the newest artifact of each type within the configured char budget (`knowledge.compiled_budget_chars`, default 2500, range 500–6000). Artifacts tagged `foundational` are always injected first. For deep retrieval of specific history, use `/recall`.

---

## Learning Loop

```
Reflection fires -> three-outcome decision:
    ^                  |
    | Triggers:        +-> no action (nothing notable)
    | - Task boundary  +-> memory update (lesson learned)
    | - Heartbeat idle +-> proposal candidate -> tier classification:
    | - Evening routine|                          |
    | - Session close  |    Tier 1 (silent) ------+-> act directly (reversible/routine)
    |                  |    Tier 2 (micro) -------+-> channel yes/no (meaningful/non-critical)
    |                  |    Tier 3 (full PROP) ---+-> operator review via proposal-act
    |                  |                               |
    |                  |    Three-condition gate:       |
    |                  |    1. Repeated pattern         |
    |                  |    2. Meaningful consequence    |
    |                  |    3. Operator-actionable       |
    |                  |                               v
    |                  +---- /proposal-act accept/defer/dismiss
    |                        -> accepted -> queued task record -> pickup
    |                                                            |
    +---- Memory shows no recurrence -> auto-resolved -----------+
```

Reflection uses auto-memory as primary input. Your hermit reflects on what it remembers: recurring blockers, repeated workarounds, cost patterns, workflow friction. Evidence is conversational ("I've hit this repeatedly") rather than citation-based.

**Three-condition gate:** Every proposal candidate must satisfy the three conditions defined canonically in `skills/proposal-create/SKILL.md` §Three-Condition Rule: repeated pattern across sessions, meaningful consequence if left unaddressed, and an operator-actionable change. This prevents trivial or one-off observations from cluttering the proposal pipeline.

**Micro-proposals (tier 1/2):** For changes that are reversible or non-critical, reflect queues a micro-proposal — a yes/no, or 2-4-option, question sent via channel. Multiple pending micro-proposals can coexist (`state/micro-proposals.json → pending[]`); operator answers by ID. On channel-tagged turns, other skills' bounded asks (e.g. `proposal-act accept`'s 3-way ask, `hermit-settings quality-gate`) queue entries through the same bridge (channel-responder § Channel-safe ask bridge) so the question survives compaction or a session restart. Ignored micro-proposals expire after 2 morning briefs.

Hermit provides the **timing infrastructure** (when to reflect), the **proposal pipeline** (structured proposals with an operator gate), and the **tier classification** (which proposals need what level of approval). Claude handles the intelligence — noticing patterns, assessing confidence, formulating proposals.

### Daily Rhythm

Morning routine (configurable time, default: active hours start + 30m): brief, proposal review, priority check, pending micro-proposals surfaced.
Evening routine (configurable time, default: active hours end - 30m): task outcomes, reflection, preparation for tomorrow.

Both are managed by `/hermitd:hermit-routines`. Where the Monitor tool is available, one native plugin monitor started by the activation skill evaluates every enabled routine's schedule outside the session ; a skipped fire costs zero model tokens, and routines due in the same poll batch into one wake. Eligibility gating defers only while an operator turn is genuinely open (a Stop-cleared `state/operator-turn-open.json` marker, 60-min TTL backstop) ; coarser than CronCreate's harness turn-level idle gate: a routine wake can still interject into an active conversation. `heartbeat-restart` stays a CronCreate **re-arm anchor**, firing daily at 4am to re-invoke `load` (re-arming the monitor) and, unless `heartbeat.enabled` is explicitly false, activate the native heartbeat monitor. Where Monitor is unavailable (Bedrock/Google Cloud Agent Platform/Foundry, `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), `load` falls back to per-routine CronCreate registrations, idle-gated at the harness turn level and re-armed daily by the same anchor before the 7-day expiry cliff.

### Scheduling ownership boundaries

Four mechanisms handle background work — each owns a distinct axis:

- **hermit-routines**: the only place for time-based semantic work (reflect, plugin-check routines, weekly-review). One native plugin monitor started by the activation skill owns eligibility, gating in-script before any wake; a CronCreate anchor and, on platforms without Monitor, per-routine CronCreates cover re-arm and fallback.
- **heartbeat**; health/checklist/idle-wake gate only, on its own fixed cadence (default 30m), separate semantics from routine scheduling. Polls via `--peek` in a bash subprocess (zero model cost when quiet); wakes the model only on `EVALUATE` verdicts. Must not be merged into routines; routines and heartbeat now both reach a zero-token quiet path independently, but they gate on different questions (a routine's own cron vs. the checklist's staleness) and merging would conflate the two.
- **watch** — session-scoped external event streams via the `Monitor` tool. Dies with the session; not a scheduler.
- **watchdog** — out-of-session process recovery (restart, wedge-nudge, re-arm). `context_hygiene.clear` and `context_hygiene.compact` run on every scheduler tick **independent of `watchdog.enabled`**; they are scheduler-owned context-hygiene co-located in the watchdog script, not watchdog features. Setting `enabled: false` disables restart/nudge only.

New periodic semantic work belongs in hermit-routines. A plugin check uses `reflect --check-id <id> --check <namespaced skill>` as its routine skill; `scheduled_checks` is reserved for session-triggered work at task completion. Heartbeat, watchdog, and watch must not become general schedulers.

### Context Hygiene

`context_hygiene.clear` sends `/clear` without a model wake after an hour of operator quiet, after a context reaches 24 hours, or after policy changes. Defaults are `enabled: true`, `quiet: "1h"`, `max_age: "24h"`, and `min_tokens: 20000`.

Every trigger waits for the safe execution boundary: matching runtime identity, idle observed for at least 60 seconds, no running task worker, an idle or shell registry entry when present, enough compactible tokens, and an unchanged pane across two ticks. Lifecycle guards and the lifecycle lock also apply. `state/context-clear.json` records the policy hash and trigger so the same reason does not fire twice for the current reset. Machine-learned chat destinations and version stamps do not count as policy edits. Native monitors survive a clear and are not re-armed for it.

The standalone clear and the routine `context_hygiene.compact` tier are separate. Compaction summarizes the conversation; a clear discards it. Task records survive either action. See [configuration](config-reference.md#context_hygiene).

---

## What You Give Up / What You Gain

**Give up:** No web dashboard, no metrics visualization, no multi-tenant isolation, no custom tool definitions (use Claude Code's native tools or [MCP servers](https://code.claude.com/docs/en/mcp)).

**Gain:** Understand it in 30 minutes. No version conflicts, no build failures. Works with any codebase in any language. Task records are human-readable markdown — grep them, review in GitHub, feed to another agent.

---

## Configuration Reference

### Environment Variable Flow

```
config.env + channel state dirs -> hermitd-start -> launch overlay env -> Claude Code -> hooks, Bash
                                            -> shell env (tmux env file) -> MCP servers
config.voice + config.language -> hermitd-start -> launch overlay outputStyle + language
```

Truthy ambient values win over configured environment values in every carrier.

**Shell environment:** `CLAUDE_CONFIG_DIR` and authentication values reach the launcher through the shell and are forwarded to its child. OAuth credentials remain in `.credentials.json`.

**Operator user or managed settings:** Claude Code may resolve its own config directory from these scopes inside the session. The startup hook records the effective config directory so the watchdog can use the resident's value.

**Launch overlay and process environment:** `config.env` and every channel's derived `*_STATE_DIR` reach only the launched resident through the overlay and shell environment. Relative state dirs resolve against the project root; an omitted channel state dir defaults to `.claude.local/channels/<name>`. The overlay also carries `outputStyle` and `language`; these are native settings, not environment variables.

**Process-scoped profile:** `AGENT_HOOK_PROFILE` remains outside the overlay. The launcher resolves it per boot and forwards it in process environment, including the tmux env file. It is removed from shared local settings.

### config.json env defaults

| Field                             | Value      | Purpose                                            |
| --------------------------------- | ---------- | -------------------------------------------------- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `65`       | Auto-compact at 65% context                        |
| `MAX_THINKING_TOKENS`             | `10000`    | Cap thinking budget                                |
| `AGENT_HOOK_PROFILE`              | _(unset)_  | Active hook profile. Not seeded — absence means "no preference", which resolves to `strict` on a managed launch and `standard` on an interactive one |
| `DISCORD_STATE_DIR`               | (derived)  | Explicit channel path or bare-host project default |
| `TELEGRAM_STATE_DIR`              | (derived)  | Explicit channel path or bare-host project default |

**Compaction ownership.** Context compaction has exactly two tiers: native autocompact (primary, tuned via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) and the watchdog's `maybeContextCompact` backstop (fires with an explicit reason code when native compaction hasn't kept up). The standalone clear (`context_hygiene.clear`) discards the context on quiet, age or policy triggers rather than on size. No hook injects model-visible compaction suggestions.

### Denied operations

Deny patterns block dangerous operations regardless of permission mode. See [Security](security.md) for the full deny list and defense-in-depth model.

---

## Known Limitations

1. ~~**O(n) cost-log scan**~~ — Fixed: `cost-tracker.ts` now maintains `cost-index.json`, an incremental byte-offset index updated on every Stop hook. The `getCumulativeCost` fallback renders from the index; the O(n) scan only runs on first use or after log truncation.

2. **Boot script timing** — `hermitd-start.ts` waits 3 seconds before sending commands to tmux. May not be enough on slow hardware. Fix: poll `tmux capture-pane` for readiness.

3. ~~**Silent cost-log corruption**~~ — Fixed: `cost-index.json` carries a `skipped_corrupt_lines` counter incremented on every `JSON.parse` failure; `doctor-check.ts` surfaces a `warn` when the counter is non-zero.
