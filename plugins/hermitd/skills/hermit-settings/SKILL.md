---
name: hermit-settings
description: View or change hermit configuration for this project. Manages model, channels, morning brief, heartbeat, routines, compaction thresholds, Docker packages, and unattended mode.
---

# Hermit Settings

View or modify the hermit configuration for this project.

## Commands
- `artifact-render`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts render <type> .hermit`
- `channel-group-add`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" group-add`
- `proposal-queue-micro`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts queue-micro .hermit`

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

Everyday settings apply through `settings-edit`. A static list in `scripts/settings-gate.ts` protects trust, disclosure, credentials, executable configuration, and existing guarded settings with Claude Code's native permission prompt. Protected writes ask in either direction. Parent replacements ask only when protected content changes; routine containers keep their existing precheck comparison. A No is the operator's answer: never retry or route around it, and never edit `config.json` directly. The channel plugin delivers the prompt to the operator's DM or the terminal pane.

On a channel-tagged turn, every free-form `Ask:` prompt below is delivered via the reply tool instead of waiting on terminal input — the branch proceeds as an over-channel exchange (ask, then act on the reply when it arrives), the same as any other channel conversation. **Never call `AskUserQuestion` on a channel-tagged turn** — it renders in the terminal, invisible to a remote operator. The one bounded ask in this skill (`quality-gate`, below) additionally queues a durable micro-proposal entry per `channel-responder` § Channel-safe ask bridge (schema: `reflect` § Queuing procedure), so it survives compaction or a session restart; free-form asks queue nothing.

## Usage

```
/hermitd:hermit-settings              — show all current settings
/hermitd:hermit-settings name          — set agent name
/hermitd:hermit-settings language       — set preferred language
/hermitd:hermit-settings voice          : edit how the hermit talks (style: everyday; custom prose: native permission prompt)
/hermitd:hermit-settings timezone       — set timezone
/hermitd:hermit-settings escalation     — set escalation threshold
/hermitd:hermit-settings channels       — configure channels
/hermitd:hermit-settings remote          — toggle remote control
/hermitd:hermit-settings model           — set Claude model
/hermitd:hermit-settings brief          — configure morning brief
/hermitd:hermit-settings permissions    — configure unattended mode
/hermitd:hermit-settings heartbeat      — enable/disable, interval, quiet mode, active hours
/hermitd:hermit-settings watchdog       — scheduler_enabled, enable/disable, stale_factor, wedge_floor, escalate_after, operator_grace, context hygiene compaction
/hermitd:hermit-settings routines        — manage scheduled routines (add/edit/remove/enable/disable)
/hermitd:hermit-settings env              — view/edit environment variables
/hermitd:hermit-settings docker           — view Docker packages (read-only); edit recommended plugins
/hermitd:hermit-settings scheduled-checks    — manage scheduled plugin skill checks
/hermitd:hermit-settings boot-skill       — view/clear/change the always-on boot skill
/hermitd:hermit-settings quality-gate     — set post-implementation /simplify gate tier (budget|balanced|quality)
/hermitd:hermit-settings reflection       — tune graduation threshold (graduation_min_sessions)
/hermitd:hermit-settings push-notifications — toggle PushNotification doorbell (fires when no channel is enabled or a configured channel is unreachable)
/hermitd:hermit-settings artifact-dashboard — toggle the Hermit Dashboard artifact (single-URL status/proposals/weekly-evolution page)
/hermitd:hermit-settings artifact-proposals — toggle the Proposals-page artifact (full-text open-proposal page)
/hermitd:hermit-settings artifact-weekly-review — toggle the Weekly-review artifact (stable-URL passthrough of the compiled weekly report)
/hermitd:hermit-settings artifact-authorization — record the unattended Artifact publish decision (applied by hermitd-start at boot, not from this session)
/hermitd:hermit-settings artifact-backend — where pages publish: `claude` (default), or the name of a connected MCP artifact server you registered yourself
/hermitd:hermit-settings history [path] — recent recorded settings changes (who changed what, when)
```

## Plan

### 1. Read config

Read `.hermit/config.json`. If it doesn't exist, inform the operator: "No config found — type `/hermitd:hatch` first, in a terminal or the Claude app."

Scalar and enum edits below are written through `scripts/settings-edit.ts`, which read-modify-writes the whole config (preserving every sibling key) and refuses a malformed file. Shorthand used in this skill:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json show                    # operator-facing summary of live values
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json get [dotted.path]      # dump whole config, or one value
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json set <dotted.path> <value>   # 'none'/'clear' → null; value is JSON-parsed then falls back to raw string
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json toggle <dotted.path>       # boolean flip (absent → true)
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json unset <dotted.path>        # delete a key (siblings and parents untouched)
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json history [dotted.path] [--limit N]   # recent audited changes
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json record-file HEARTBEAT.md            # record checklist fingerprint
```

**Every write goes through these verbs — never edit `config.json` with Edit/Write.** The script preserves siblings, refuses a change that would make the config invalid, and records the change in the audit ledger that `history` reads. A hand-edit bypasses all three.

### 2. Show or modify

**If no argument** (or argument is "all"):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json show
```

Print its output. It renders the operator's live values grouped by area, with the argument that changes each one and when the change takes effect. Do not hand-render a settings summary — the script reads the same registry the table below is built from, so anything you compose by hand drifts from what the config actually holds.

**Scalar and enum arguments — one table, one shape.**

Each row is the same shape: ask the operator for a value, then write it with

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json apply-known <argument> <value>
```

Pass the **argument name**, not the dotted path — the script looks the path up, coerces the value by kind, and refuses an out-of-enum value or an unknown argument with exit 1 (this matters: `settings-edit` writes through `fs`, so the `validate-config.ts` PostToolUse hook never sees the write and a bad value would otherwise land silently). On success it prints the confirmation line, including when the change applies; relay that. `none`/`clear` maps to null wherever a row is marked nullable. Compose the prompt itself from the hint and the enum values.

| Argument | Config path | Type | Values | Applies |
|---|---|---|---|---|
| `name` | `agent_name` | string, nullable | any; any string, or 'none' to clear | immediately |
| `timezone` | `timezone` | string, nullable | any; IANA tz (UTC, Europe/Lisbon, America/New_York) | immediately |
| `escalation` | `escalation` | enum | conservative / balanced / autonomous; how much it acts without asking | immediately |
| `remote` | `remote` | boolean | yes / no; connect from claude.ai/code or phone | next hermitd-start |
| `auth-mode` | `auth_mode` | enum, nullable | login / token; login (claude.ai sign-in, renew ~monthly) or token (long-lived, renew yearly) | run /relogin to sign in with the new method |
| `model` | `model` | string, nullable | any; model name passed straight to --model, or 'none' for the Claude Code default | next hermitd-start |
| `boot-skill` | `boot_skill` | string, nullable | any; namespaced skill run at always-on launch, or 'none' for /hermitd:resident-start | next hermitd-start |
| `permissions` | `permission_mode` | enum | auto / acceptEdits / default / plan / dontAsk / bypassPermissions; how much Claude Code asks before acting | next hermitd-start |
| `push-notifications` | `push_notifications` | boolean | yes / no; doorbell when no channel is reachable | immediately |
| `reflection` | `reflection.graduation_min_sessions` | integer | any; distinct sessions before a pattern becomes a proposal candidate | next reflect run |
| `artifact-dashboard` | `artifacts.dashboard` | boolean | yes / no; status, proposal queue, weekly evolution | next refresh |
| `artifact-proposals` | `artifacts.proposals` | boolean | yes / no; full text of open proposals | next refresh |
| `artifact-weekly-review` | `artifacts.weekly_review` | boolean | yes / no; the compiled weekly report at a stable URL | next refresh |
| `artifact-backend` | `artifacts.backend` | string | any; 'claude', or the name of a connected MCP artifact server | next refresh |

The enum values, dotted paths, and "applies" notes come from `scripts/lib/settings/registry.ts` — the same module `show` renders from and `validate-config.ts` shares its enums with. When a setting is added, add the row there; this table mirrors it.

**`model` takes whatever Claude Code takes.** The stored value is passed verbatim to `--model` by `hermitd-start.ts`, so no model list lives here. Offer the operator the aliases Claude Code itself accepts (`opus`, `sonnet`, `haiku`) or a full model ID, and pass it through.

**Permission-mode note (surface when the operator picks one):** `auto` is classifier-reviewed autonomy and the default; `acceptEdits` auto-approves file edits but prompts for shell; `default` prompts on first use of each tool; `plan` is read-only; `dontAsk` denies anything not in `permissions.allow`; `bypassPermissions` is for isolated containers only. `auto` may report unavailable depending on plan/model/provider — see [Permission Modes](https://code.claude.com/docs/en/permission-modes).

The remaining arguments each do more than write one leaf, so they keep their own procedure below.

**If argument is "language":**
Auto-detect the system locale via Bash as a default suggestion.
Ask for the preferred language (e.g. pt, en, es, fr), offering the current value or the detected locale as default.
Run `settings-edit ... set language <value>`.
Then re-sync the artifact-chrome translation table (the dashboard/proposals pages overlay `.hermit/state/artifact-strings.json` per key over the English defaults):
- New value is **not** `en`: emit `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts scaffold-strings <value> <current-ISO-timestamp>`, translate every `strings` value into that language (keep keys and `{placeholder}` tokens verbatim), and write `.hermit/state/artifact-strings.json`.
- New value is `en`: delete `.hermit/state/artifact-strings.json` if it exists (absent file ⇒ English chrome).

**If argument is "voice":**
The hermit's tone lives in a native Claude Code output style, loaded into the system prompt at session start. `config.json`'s `voice` block is what you own; the `outputStyle` key and, for a custom voice, `.claude/output-styles/hermit-voice.md` are rendered from it — at boot, and immediately when this runs in a terminal.

Picking a built-in is an everyday setting (three sealed values, no text). Writing custom prose raises the native permission prompt: it becomes every future session's system prompt. Both go through `settings-edit`. A No is the operator's answer: never retry or route around it.

- Show the current value first: `settings-edit ... get voice`. If it is unset, say so plainly and add what is actually persisted (`/hermit-doctor`'s `voice-carrier` line reports that, across every scope) — a style the operator picked in `/config` themselves is theirs, and this command would take the key over.
- Ask: "How should I talk to you? (Default / Concise / describe it in your own words)". Describe Concise as it behaves — leads with the result, skips narration, keeps error and security detail in full.
- **Default / Concise** →

  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json apply-known voice <default|Concise>
  ```

  `default` is lowercase; the `/config` picker displays "Default" but persists the lowercase literal. Neither writes a file. If a `hermit-voice.md` exists it stays on disk, inert — switching back is one command.
- **Their own words** → write the prose first, then the style (the reverse order is refused — `custom` without prose is invalid):

  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json set voice.prose '"<their words>"'
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json apply-known voice custom
  ```

  Use their wording verbatim, or with only mechanical wrapping into instructions-to-yourself form. Keep it about tone, not work context (that's `OPERATOR.md`), and keep it short — it costs tokens on every API call. When editing an existing custom voice, show the current `voice.prose` and edit that text, not the rendered file.
- **Anything else they name** (`Explanatory`, `Learning`, a style of their own): the hermit doesn't render those. Say so and point at `/config`, which sets `outputStyle` directly — the hermit will report it and leave it alone.
- **Then render it**, terminal turns only:

  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json voice-render
  ```

  Local scope by design, whatever the hatch target: it is the scope `/config` writes and outranks committed settings, and the voice file is gitignored. The op refuses any other target. On a channel-tagged turn **don't run it** — say the change applies at the next restart, the same as an `env` change. Either way the config write already landed.
- Tell the operator it takes effect in the next session — the system prompt is built at session start.
- **Clearing the voice** (`apply-known voice none`) stops the hermit managing the key; it does not undo the last render. Say so: the current style stays until they pick another one here or in `/config`.
- The voice file is a render of `config.json`, so a hand-edit is overwritten at the next boot. If they want to edit prose directly, that is `voice.prose`.

**If argument is "channels":**
Show current channel configuration from `config.json` → `channels` object. The `channels.primary` key (if set) is a magic pointer to the preferred outbound channel, not a channel itself — display it on its own line above the channel list:
```
Channels:
  Primary: discord    (or "none — falls back to first eligible channel in config order")
  discord  enabled  allowed_users: [123456789]  briefing chat: 987654321  morning_brief: 07:00  state_dir: /abs/path/...
  (or "No channels configured")
```
"briefing chat" is `default_chat_id` — where unattended sends go — falling back to the learned `dm_channel_id` when the pin isn't seeded yet (say "not paired yet" when both are empty).
Ask what to do next, offering: add discord / add telegram / remove <name> / edit <name> / primary <name> / primary clear / done (default done).
Offer `add <name>` only for a channel absent from `channels`.
Loop until operator says "done":
- **add <name>:** If the channel is already configured, point to `edit <name>` and write nothing. Otherwise prompt for `allowed_users` (paste user ID or skip) and `state_dir` (relative or absolute path, defaults to `.claude.local/channels/<name>`), then use `settings-edit set channels.<name> '{"enabled":true}'`, including `allowed_users` only when given and `state_dir` only when the operator supplied a non-default path. Do not include learned chat IDs or restate default paths. Channel enrollment raises Claude Code's native permission prompt. Note: "Configure the channel token next: Docker → `/hermitd:docker-setup`; tmux or interactive → `/hermitd:channel-setup`. Type it in a terminal or the Claude app."
- **remove <name>:** `unset channels.<name>`. If `channels.primary === <name>`, run `unset channels.primary` **first** (a dangling pointer fails validation and the write would be refused) and tell the operator: "Also cleared `channels.primary` (was pointing at the removed channel)."
- **edit <name>:** Sub-menu: "What to change? (allowed_users / briefing_chat / morning_brief / enabled / recall / operators / record / group / done)"
  - **allowed_users:** "Paste user IDs (space-separated), or 'clear' to allow everyone, or 'block' for empty array." → `set channels.<name>.allowed_users '["id",...]'` (clear ⇒ `unset channels.<name>.allowed_users`). Channel enrollment raises the native permission prompt.
  - **briefing_chat:** `channels.<name>.default_chat_id` — the destination for unattended sends (briefings, notices, weekly review) and, on a channel with no `allowed_users`, the chat trusted for pause/resume/status. Seeded once at first pairing and never moved by an inbound message, so it takes an explicit change here. This write raises the native permission prompt. Ask: "Paste the chat/channel ID that should receive briefings (current: `<value>`)." ID discovery is the same as for a group chat — Discord: Developer Mode → right-click the chat → Copy Channel ID; Telegram: forward a message from it to `@userinfobot` (group IDs are negative integers). Write it as `set channels.<name>.default_chat_id '"<value>"'` — the value must stay a **string**, and `set` JSON-parses its argument, so an unquoted chat ID lands as a number and the write is refused; clear it with `set channels.<name>.default_chat_id none`. Reject a value equal to that channel's `maintainer_channel_id` yourself before writing (outbound-only chat — see `docs/security.md` § tiered disclosure): that collision only warns, so the write would go through.
  - **morning_brief:** "Enable morning brief for this channel? (yes <time> / no) [current]". Yes ⇒ `set channels.<name>.morning_brief '{"enabled":true,"time":"<HH:MM>"}'`; no ⇒ `set channels.<name>.morning_brief none`.
  - **enabled:** `toggle channels.<name>.enabled`.
  - **recall:** "Isolate chats? (yes / no)" Yes: `unset channels.<name>.isolate_chats`; no: `set channels.<name>.isolate_chats false`. "Chat IDs to share with every chat on every channel, or none?" IDs: `set channels.<name>.shared_chats '["id",...]'`; none: `unset channels.<name>.shared_chats`. Reject an id equal to that channel's `maintainer_channel_id` yourself before writing (outbound-only chat — see `docs/security.md` § tiered disclosure): that collision only warns, so the write would go through and every chat could then recall maintainer-tier messages. Channel enrollment raises the native permission prompt.
  - **operators:** "Paste primary operator user IDs, or clear to restore the default." IDs: `set channels.<name>.operators '["id",...]'`; clear: `unset channels.<name>.operators`. Channel enrollment raises the native permission prompt.
  - **record:** "Record this channel? (yes / no / inherit)" Yes: `set channels.<name>.log_chats true`; no: `set channels.<name>.log_chats false`; inherit: `unset channels.<name>.log_chats`.
  - **group:** Run [the group questionnaire](../channel-setup/references/group-enrollment.md) with the selected channel key, absolute Hermit state directory, and channel-reply delivery on a channel-tagged turn (native prompts otherwise). Relay its result. Pairing and enrolment are refused in bypass mode; pair or enrol from a normal terminal session. Never route a refusal through another writer.


- **primary <name>:** Validate `<name>` exists as a key in `channels` (and is not `primary` itself). If valid, `set channels.primary <name>`. If invalid, reject: "No channel named `<name>` configured. Add it first with `add <name>`."
- **primary clear:** `unset channels.primary`. Outbound sends will fall back to the default `discord` → `telegram` → `imessage` order.
Note: "Channel changes take effect on next `hermitd-start` run. `channels.primary` and `default_chat_id` are consulted live by `scripts/resolve-outbound-channel.ts` on every proactive send — no restart needed for those keys."

**If argument is "brief":**
- If no channels configured: "Morning brief requires channels. Configure channels first with `/hermitd:hermit-settings channels`."
- If channels configured:
  - Show current morning_brief setting per channel: `channels.<name>.morning_brief`
  - Ask: "Enable morning brief delivery? (yes / no) [current value]"
  - If yes: Ask "What time? (e.g., 07:00) [current or 07:00]" and "Which channel? [current or first enabled channel]"
  - Yes ⇒ `set channels.<selected-channel>.morning_brief '{"enabled":true,"time":"<HH:MM>"}'`; no ⇒ `set channels.<selected-channel>.morning_brief none`.

**If argument is "heartbeat":**
- Show current heartbeat config (including `stale_threshold`)
- Ask whether the background heartbeat should be enabled (yes / no, default the current value).
- If yes: show the configurable sub-fields before asking each one:
  ```
  Heartbeat sub-fields (press Enter to keep current value):
    interval  — how often to check (e.g. 5m, 15m, 30m)         [current]
    active    — active hours window (e.g. 08:00-23:00)          [current]
    stale     — alert if no session progress for (e.g. 2h, 30m) [current]
  ```
  Then ask each field in sequence.
- Write each changed field through `settings-edit ... set heartbeat.<field> <value>` (`heartbeat.enabled`, `heartbeat.every`, `heartbeat.active_hours.start`, `heartbeat.active_hours.end`, `heartbeat.stale_threshold`). Per-field dotted sets preserve the untouched siblings (`waiting_timeout`, `clean_recheck_cooldown`, `model`).
- **After the change is written**, reconcile the live Monitor with the new state via the Skill tool. The monitor's poll interval is baked in at `start` time from `heartbeat.every`, so a config-only change otherwise leaves the running monitor on the old cadence (and `/hermit-doctor` would flag the mismatch). Surface the result inline:
  - If heartbeat is now **enabled**: invoke `/hermitd:heartbeat start` (idempotent — stops the old monitor and re-registers at the new interval). Success: "Heartbeat monitor restarted at new interval (`<every>`). Active immediately."
  - If heartbeat is now **disabled**: invoke `/hermitd:heartbeat stop`. Success: "Heartbeat monitor stopped."
  - Failure (either): "Settings saved to config.json, but `/hermitd:heartbeat <start|stop>` failed: <reason>. Run it manually to apply."

**If argument is "watchdog":**
- Show current watchdog config from `config.json`:
  ```
  Watchdog (config.json watchdog)

    scheduler_enabled      true
    enabled                false
    stale_factor           2
    wedge_floor            4h
    escalate_after         3
    operator_grace         15m

  Context hygiene compact (config.json context_hygiene.compact)

    enabled                true
    min_context_tokens     100000
    min_interval           4h
  ```
- Ask whether each always-on boot should register the OS scheduler (yes / no, default the current `scheduler_enabled`, absent = yes), then whether watchdog restarts should be enabled (yes / no, default the current `enabled`).
- If yes: show the configurable sub-fields before asking each one:
  ```
  Watchdog sub-fields (press Enter to keep current value):
    stale_factor           — missed-cycle tolerance multiplier (e.g. 2); effective
                             threshold is max(stale_factor × heartbeat.every, wedge_floor) [current]
    wedge_floor            — lower bound on that threshold, whatever the poll interval
                             (e.g. 4h; lower it for faster detection, 0s = no floor)      [current]
    escalate_after         — consecutive stale cycles before escalation (e.g. 3)          [current]
    operator_grace         — silence window before alert fires (e.g. 15m, 1h)             [current]
  ```
  Then ask each field in sequence.
- Write each changed field through `settings-edit ... set watchdog.<field> <value>` (`watchdog.scheduler_enabled`, `watchdog.enabled`, `watchdog.stale_factor`, `watchdog.wedge_floor`, `watchdog.escalate_after`, `watchdog.operator_grace`). Per-field dotted sets preserve any untouched siblings. `set` JSON-parses its argument, so a bare `0` for `wedge_floor` would be written as a number and read back as the `4h` default — pass `0s` to disable the floor.
  - Note: "Changes take effect on the next watchdog run. `scheduler_enabled` (default true) is the OS-timer policy a tmux always-on boot reads: every `hermitd-start` registers the timer unless it is false. Setting it false by hand only stops future boots from re-registering — to remove a timer that is already installed run `hermitd watchdog uninstall`, which deletes the unit and sets both `scheduler_enabled` and `enabled` false. `hermitd watchdog install` re-registers it, and a first registration also sets `enabled: true`; a later re-install leaves `enabled` as you set it. Docker hermits run the watchdog from the entrypoint loop — no install step needed, and `scheduler_enabled` does not apply there."
- **Context hygiene compact** (`context_hygiene.compact` — runs independently of the "Enable watchdog?" answer above): ask "Enable routine-hygiene compaction? (yes / no) [current: <value>]". If yes, show the sub-fields:
  ```
  Context hygiene compact sub-fields (press Enter to keep current value):
    min_context_tokens     — routine-hygiene /compact when estimated compactible conversation exceeds this (e.g. 100000) [current]
    min_interval           — minimum time between compacts, avoids summary-of-summary loss (e.g. 4h) [current]
  ```
  Then ask each field in sequence. Write each changed field through `settings-edit ... set context_hygiene.compact.<field> <value>` (`context_hygiene.compact.enabled`, `context_hygiene.compact.min_context_tokens`, `context_hygiene.compact.min_interval`). No restart/reconcile step needed — the watchdog reads config.json fresh on every scheduler tick.

**If argument is "routines":**
- Show current routines from `config.routines` array:
  ```
  Routines (config.json routines → routine monitor; CronCreate fallback where Monitor is unavailable):

    #  ID           Schedule       Skill                                Status    Gate
    1. morning      30 8 * * *     hermitd:brief --morning    enabled   —
    2. evening      30 22 * * *    hermitd:brief --evening    enabled   —
    3. reflect      0 9 * * *      hermitd:reflect            enabled   reflect
    4. weekly-deps  0 9 * * 1      hermitd:task list  disabled  tools/deps-gate.sh

  (or "No routines configured" if empty)
  Gate = the routine's `precheck`, run by the routine monitor before it wakes the session;
  `—` means the routine always wakes it. Adding or changing one raises the native permission prompt.
  ```
- Removing a precheck through routine replacement stays silent; direct precheck or timeout leaf edits, including unset, still ask. Routine command changes gain no extra gate.
- Every write below names **one entry** — `routines.<index>`, 0-based, so table number − 1. Never write the
  whole `routines` array: the settings gate reads the value of a container write, and a value it cannot parse
  (`$(cat …)`, a heredoc, a shell variable) raises the native permission prompt even when nothing is gated.
  Entry JSON goes inline, single-quoted, in the command itself.
- **Indices are only valid until the next add or remove.** An add appends and a remove closes the gap, so the
  numbers from the listing above are stale the moment either lands. Re-run `get routines` and re-show the
  table after every add and every remove, and derive the next index from that fresh listing — a stale index
  is an in-range write that silently replaces or edits the wrong routine, with nothing to refuse it.
- Ask what to do next: add / edit / remove / enable / disable / done.
- **Add wizard:** ask for:
  - ID (unique name, e.g., "weekly-deps")
  - Schedule — offer common presets, or accept raw 5-field cron:
    - Daily at 08:30 → `30 8 * * *`
    - Weekdays at 09:00 → `0 9 * * 1-5`
    - Sundays at 23:00 → `0 23 * * 0`
    - Every 15 minutes → `*/15 * * * *`
    - 1st and 15th of month at 10:00 → `0 10 1,15 * *`
    - Custom → operator types raw cron
  - Skill to run (full slash-command name, e.g. `hermitd:brief` for plugin skills, `ha-refresh-context` for local project skills)
  - Enabled (yes/no, default yes)
  - Append it with `set routines.<count> '<entry as JSON>'`, where `<count>` is the number of routines in the
    latest listing (the first free index). A duplicate id is only a warning, so check the id against the
    listed ones before writing; an invalid cron is refused by the script — relay its error rather than
    retrying.
- **Edit:** select by number, then `set routines.<index>.<field> <value>` (one call per changed field; siblings are preserved).
- **Remove:** select by number, then `unset routines.<index>` — one call, and the remaining entries close the gap.
- **Enable/disable:** select by number, `set routines.<index>.enabled true|false`.
- Loop until operator says "done".
- **After all edits are written**, invoke `/hermitd:hermit-routines load` via the Skill tool to apply the new schedule live (no restart). Surface the result inline:
  - Success: "Routines reloaded: <id1>, <id2> (<N> total). Active immediately."
  - Failure: "Settings saved to config.json, but `/hermitd:hermit-routines load` failed: <reason>. Run `/hermitd:hermit-routines load` manually to apply."

**If argument is "env":**
- Show current `env` values from config.json in a table:
  ```
  Environment Variables (config.json env → resident launch overlay)

    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 65
    MAX_THINKING_TOKENS             10000

  Hook profile (process-scoped, not written to settings.local.json)

    AGENT_HOOK_PROFILE              (unset → strict on an always-on launch)
  ```
- **Protected keys** that cannot be changed via this command: `AGENT_HOOK_PROFILE`. If the operator tries to set one, respond: "The hook profile is resolved at boot — unset means strict for an always-on launch and standard for an interactive one, and an ambient value from Docker compose outranks config. To pin it, edit `config.json` `env` directly; the boot script validates it and floors an always-on launch at standard on the next start."
- Ask for an env var to set, change, or remove (forms: `<KEY> <VALUE>`, `remove <KEY>`, or `done`; default done).
- Loop until operator says "done", "skip", or presses Enter:
  - If input targets a protected key: reject with the message above
  - If input is `remove <KEY>`: `unset env.<KEY>`
  - If input is `<KEY> <VALUE>`: `set env.<KEY> '"<VALUE>"'` — env values must stay **strings**, and `set` JSON-parses its argument, so a bare `20000` would land as a number and reach the launch overlay as one.
- Note: "Env changes reach the session through the launch overlay at the next `hermitd-start`. Restart the hermit to apply them."

**If argument is "docker":**
- Show current `docker.packages` list (read-only):
  ```
  Docker Packages (config.json docker.packages → Dockerfile.hermit)

    build-essential
    ffmpeg

  (or "No packages configured" if empty)
  ```
- Note: this list is read only when `/docker-setup` renders the templates. To install something now, add it inside the operator block of `Dockerfile.hermit` (or run `/docker-customize`) and rebuild with `hermitd restart --build`. Do not prompt to add or remove packages and do not `set docker.packages`.

- Then show current `docker.recommended_plugins`:
  ```
  Recommended Plugins (config.json docker.recommended_plugins)

    [enabled]  context7 (claude-plugins-official) — auto-installed on boot
    [enabled]  hermitd-homeassistant (hermitd-homeassistant) — auto-installed on boot

  (or "No recommended plugins configured" if empty)
  ```
  Display each entry as `[enabled/disabled]  <plugin> (<marketplace>)` — show the `org/repo` (the `marketplace` field) in parens.
- Ask: "Enable, disable, add, or remove recommended plugins? (e.g., 'enable context7', 'add context7', 'add superpowers obra/superpowers-marketplace', 'remove superpowers', or 'done') [done]"
- Loop until operator says "done", "skip", or presses Enter:
  - `enable <PLUGIN>`: `set docker.recommended_plugins.<index>.enabled true`
  - `disable <PLUGIN>`: `set docker.recommended_plugins.<index>.enabled false`
  - `remove <PLUGIN>`: read the list, drop that entry, `set docker.recommended_plugins '<remaining array>'`
  - `add <PLUGIN> [<MARKETPLACE>]`: append an entry with `scope: "project"`, `enabled: true` and write the whole list back with `set docker.recommended_plugins '<array>'`. `<MARKETPLACE>` is an `org/repo` (e.g. `obra/superpowers-marketplace`) or omitted (defaults to `anthropics/claude-plugins-official`). The marketplace need not be registered locally: the container entrypoint adds it on first boot. **Dedupe rule:** refuse the add if an existing entry has the same `(plugin, marketplace)` pair (scope is NOT part of the key) — operator should `enable` or `remove` first.
  - If input is just a plugin name without a verb: treat as `enable` if it exists, `add` if it doesn't
- After changes, note: "Restart container to install new plugins: `hermitd restart`"

**If argument is "scheduled-checks":**
- Read `state/reflection-state.json` for last run dates. If missing, show "(no runs yet)".
- List only `scheduled_checks` entries with `trigger: "session"`, under "Session checks", showing ID, plugin, last run, and enabled status. If empty, show "No session checks configured".
- Ask: "Enable, disable, add, remove, or done? (e.g., 'disable my-check', 'add my-check my-plugin /my-plugin:my-skill session') [done]"
- Loop until the operator says "done", "skip", or presses Enter:
  - `enable <id>` / `disable <id>`: for a session entry, `set scheduled_checks.<index>.enabled true|false`. Use its original config-array index, not the filtered display index.
  - `add <id> <plugin> <skill> session`: append a session-triggered entry with `enabled: true`, then `set scheduled_checks '<whole array>'`. Deduplicate by id across the whole array.
  - `remove <id>`: remove the session entry and `set scheduled_checks '<remaining array>'`, then remove its state from `state/reflection-state.json`.
  - Refuse interval additions or cadence edits: periodic checks belong in `routines`. Point the operator to `/hermitd:hermit-settings routines`.
- Preserve other entries and custom keys when writing the array. Session checks run at task completion; changes take effect on the next task completion.

**If argument is "quality-gate":**

**Interactive (terminal) turn:** Ask the operator via `AskUserQuestion` to pick a tier. Show the current value in brackets if `quality_gate.tier` is set.

Prompt: *"Quality-gate tier for accepted-proposal auto-implementations. Controls whether `/simplify` (cleanup pass) runs at step (e.5) of `/proposal-act`."*

Options:
- **Budget** (default; recommended): `/simplify` never runs. Cheapest. No post-implementation cleanup.
- **Balanced**: make an inline RUN/SKIP decision on each implementation from the proposal category and touched files (no subagent) — RUN triggers `/simplify`, SKIP doesn't. Costs one `/simplify` run when the decision is RUN.
- **Quality**: `/simplify` runs on every implementation, no judgment. One `/simplify` run per implementation.

Run `settings-edit ... set quality_gate.tier <chosen>` (creates the `quality_gate` object if missing; a legacy `enabled` sibling is preserved untouched — skill behavior reads `tier` only).

**Channel-tagged turn:** send the same prompt via the channel reply tool with the three tiers numbered (Budget/Balanced/Quality, same descriptions as above), AND queue a pending micro-proposal entry per `reflect` § Queuing procedure: `options: ["budget", "balanced", "quality"]`, `tier: 1`, `on_resolve: "/hermitd:hermit-settings quality-gate --answer {answer}"`. If invoked as `quality-gate --answer <tier>` (channel-responder resolving that entry), skip the ask and run `settings-edit ... set quality_gate.tier <tier>` directly, then confirm via channel.

Note: if you commit autonomous-implementation diffs through a skill that already runs `/simplify` before committing, consider **Budget** — any non-Budget tier here would run the cleanup pass twice per committed implementation.

**If argument is "history":**
Run `settings-edit ... history [dotted.path] [--limit N]` (the operator may name a setting: "history heartbeat"). Relay the rows in the operator's language, naming who made each change — `settings-edit` is an operator edit, `hermit-evolve` a change an upgrade made, `evolve-finalize` an upgrade's version stamp alone, `channel-hook` a channel the hermit learned, `hermitd-start`/`hermitd-stop` a boot flip, `heartbeat-edit` a checklist edit made from chat (hash and line count, never the text). In a channel reply, drop the dotted paths and script names for plain language ("the heartbeat interval went from 2h to 30m on the 18th"). An empty ledger means nothing has changed since the audit trail started, not that the setting is unset.

**If argument is "artifact-authorization":**
This records a decision only — it never runs `apply-settings.ts` and never touches a settings file from this session. A channel reply may only flip hermit config, never permissions (auto-mode classifier invariant); the actual grant is applied by `hermitd-start`'s boot-time `applyArtifactGrant`, outside any session.
Ask: "This hermit publishes status/proposal/weekly-review pages via Claude Code's Artifact tool. Unattended sessions can't answer a permission prompt, so authorize publishes now, or bank the first publish of each enabled page yourself instead?
  1. Authorize — grant applied automatically at next boot
  2. Bank first publishes — you publish the first version of each page now; refreshes then reuse the same URL
[current: <artifacts.publish_authorized value>]"
On answer "Authorize" (or "on"/"yes"): run `settings-edit ... set artifacts.publish_authorized true`. Reply: "Recorded: artifact publish authorized. The grant (permissions.allow `Artifact`) is applied automatically at next boot — `hermitd stop` then `hermitd-start` to apply now. No settings files were modified from this session."
On answer "Bank first publishes" (or "off"/"no"/"decline"): run `settings-edit ... set artifacts.publish_authorized false`. Reply: "Recorded: publishing declined. The standing permission is removed at the next boot from every settings file this install wrote it to, not from this session. An undecided (`null`) flag leaves an existing entry alone. First publish of each enabled page must happen in an attended session (`docs/artifacts.md` § refresh procedure); refreshes then reuse the same URL without prompting."
**Channel-tagged turn:** send the same prompt via the channel reply tool with the two options numbered, AND queue a pending micro-proposal entry per `reflect` § Queuing procedure: `options: ["authorize", "bank first publishes"]`, `tier: 1`, `on_resolve: "/hermitd:hermit-settings artifact-authorization --answer {answer}"`. Note in the message that "Bank first publishes" still needs a terminal session later to do the banking itself — only the decision travels over the channel.
**Channel re-entry:** if invoked as `artifact-authorization --answer "<label>"` (channel-responder resolving a micro-proposal queued by `hermit-evolve`'s Step 10 deferred-migration relay), skip the Ask above and match `<label>` case-insensitively by prefix against `Authorize` / `Bank first publishes`, then run the matching `settings-edit` command and reply exactly as above. This branch is deliberately channel-reachable — the flag is a decision record, not a permission — so it does not raise the native prompt the rest of `artifacts.*` policy sits behind.

### 3. Write config

Every branch persists through `settings-edit` verbs — `apply-known` for the registry table, `set`/`unset`/`toggle` everywhere else (arrays and objects are expressible: the value is JSON-parsed). Nothing in this skill edits `config.json` with the Edit/Write tools: the script preserves siblings, refuses a change that would leave the config invalid, and records every mutation in the audit ledger. If a verb refuses a write, relay its error to the operator instead of falling back to a direct edit.

Confirm the change to the operator.
