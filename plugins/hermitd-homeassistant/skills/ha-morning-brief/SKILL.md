---
name: ha-morning-brief
description: Morning house brief — live status, overnight anomalies, energy snapshot, pending proposals, and today's priorities. Runs as a daily routine or on demand.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Write
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
  - mcp__homeassistant__llm__GetDateTime
---

# HA Morning Brief

A house-focused morning brief that combines live HA state with hermit session context. Designed to run as the `morning-brief` routine at start of day.

When both `hermitd` and `hermitd-homeassistant` are installed and `morning-brief` is enabled, this skill subsumes `/hermitd:brief --morning` — operators should disable the core `morning` routine to avoid duplicate notifications. For hermits without HA, `/hermitd:brief --morning` remains the standalone path.

## Steps

1. **Time & context** — Call `GetDateTime` for current time. Read `.hermit/OPERATOR.md` for priorities and language preferences.

2. **Fetch overnight history**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha fetch-history --window-days 1`. On non-zero exit, pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) (`history fetch failed: <stderr first line>`) and skip the `Overnight:` section entirely: no fallback wording in the brief. On success, read `.hermit/raw/snapshot-ha-history-1d-latest.json`.

3. **Live house snapshot** — Call `GetLiveContext`. Extract and organize:
   - Presence (who is home/away)
   - Lights still on (unexpected at morning time?)
   - Cover/blind positions
   - Climate: indoor temps, HVAC mode
   - Any devices unavailable or in error state
   - Security: alarm state (read-only)

4. **Overnight highlights** (only when 1d history artifact is present): read `.hermit/raw/snapshot-ha-normalized-latest.json` for `silence_summary.silent_event_sensors`, then surface 1–3 highlights for the `Overnight:` section using only honest signals:
   - **Top-active entity between 00:00–06:00**: scan `entity_aggregates[*].hour_histogram[0:7]` for the highest sum across all entities. If any non-trivial activity (sum > 0), emit one line — e.g., "`light.kitchen` — 12 state changes between 00:00 and 06:00".
   - **Stuck event sensors**: from `silence_summary.silent_event_sensors`, emit sensors still silent — e.g., "`binary_sensor.motion_corridor` — no events for 14 days".
   - **HVAC duration**: for each `climate.*` entity, read `state_durations` from the history artifact. If `state_durations["heat"]` or `state_durations["cool"]` ≥ 1800 seconds (30 min), emit one line — e.g., "`climate.heat_pump` — heated ~Xh overnight" where X is derived directly from `state_durations`. Never substitute event count for active hours.

5. **Energy snapshot** — From the live context, pull current power draw and any energy sensors. Compare with known baselines from memory if available. Flag anything unusual (e.g., high overnight consumption).

6. **Context freshness** — Check `.hermit/raw/snapshot-ha-context-latest.json` modification time. If older than 24h, note it as stale.

7. **Overnight activity**: Read the latest HA pattern-analysis artifact, if present, and surface any alerts or notable overnight patterns alongside the history digest.

8. **Cost-spike check** — Read `.hermit/state/reflection-state.json` if it exists. Look for any `cost_spike` entry with a timestamp within the last 24 hours. If found, include a "Cost alert" bullet in the brief with the flagged amount.

8a. **Pending updates**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha updates --digest` and capture stdout. Branch on its content (the command always exits 0 — never branch on exit code):
   - Contains `(skipped:`: pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) (`updates fetch failed: <detail after "skipped:">`) and omit the `Updates:` section entirely.
   - Contains `(no updates pending)` — omit the `Updates:` section entirely.
   - Otherwise — render the digest lines as the `Updates:` section, translating tier labels into the operator's language. For each `[tier] Title: installed → latest` line (skip the `+ N more …` collapse line and the `[hacs]` aggregate line), `Glob` `.hermit/proposals/PROP-*.md` for a `[ha-update]` proposal whose title carries the same tier and target version (e.g. `[ha-update] HA Core → 2026.7.1`) and append `(PROP-NNN)`; if none matches yet, render the line without an id. Step 9 reuses this glob result when this branch ran it.

9. **Pending work** — Scan for:
   - `Glob` `.hermit/proposals/PROP-*.md` (reuse step 8a's glob result if its `Otherwise` branch already ran it; otherwise run the `Glob` here) — read status from each, list any `pending` proposals. Exclude a `pending` proposal whose title starts with `[ha-update]` **only when the `Updates:` section is present** (it surfaces there instead); when step 8a omitted the `Updates:` section (skipped fetch or no updates pending), keep `[ha-update]` proposals in this list so they are not lost
   - Run `.hermit/bin/hermitd-run task list .hermit --open --owner resident` for open and queued commitments

<!-- keep in sync with plugins/hermitd/skills/brief/SKILL.md — same MP lifecycle protocol -->
9a. **Micro-proposals lifecycle** — age the queue in one call: `.hermit/bin/hermitd-run proposal micro .hermit brief-cycle`. This runs core's writer through the project-resident `bin/hermitd-run`, which resolves core's plugin root (a static `../hermitd/…` path can't — HA's `${CLAUDE_PLUGIN_ROOT}` is `<cache>/<marketplace>/hermitd-homeassistant/<version>/` and the version segment isn't knowable from skill text). It performs the whole `follow_up_count` 0/1/2+ lifecycle atomically (re-nudges count-1 entries, expires count-2+ entries, records each expiry, prunes any entry whose `status` isn't `"pending"`) and prints one JSON line `{"new":[…],"renudged":[…],"expired":[…],"dropped":[…]}`. Never hand-edit `state/micro-proposals.json`. Render from that verdict:
   - Each `new` entry: include in `Awaiting decision:` output (see Output Format).
   - Each `renudged` entry: include in `Awaiting decision:` with softer framing: "Still waiting on MP-YYYYMMDD-N: [question] (ignore again to drop it)".
   - `expired` entries were dropped this cycle — do not surface them.
   - `dropped` entries were already resolved elsewhere (issue 676) — never surface them, never count them.
   - If `new` and `renudged` are both empty: skip this step entirely.

10. **Compose brief** — Write a concise morning brief in the operator's language (from OPERATOR.md preferences). Use the format below.

11. **Write to `compiled/`** — Write the composed brief to `.hermit/compiled/brief-morning-<YYYY-MM-DD>.md` with frontmatter:
   ```yaml
   title: "Morning Brief — <YYYY-MM-DD>"
   type: brief
   created: <ISO8601>
   task: <T-... for the open record in this turn; omit this field otherwise>
   tags: [morning-brief, ha]
   ```
   Inside an open record's turn, pipe `[[compiled/brief-morning-<YYYY-MM-DD>]]` into
   `.hermit/bin/hermitd-run task note .hermit <id>`. Otherwise skip the note.

## Output Format

```
Good morning! Home - [date]

Current state:
- [presence, lights, climate, covers - concise bullets]

Overnight:
- [top-active entity, stuck sensors, HVAC duration — omit section when history unavailable]

Energy:
- [current draw, notable consumption]

Alerts:
- [devices offline, unusual states, or "All clear"]

Updates:
- [tier] Title: installed → latest (PROP-NNN if a matching proposal exists)
- [N HACS updates pending]
- [Omit section entirely when none pending or the fetch was skipped.]

Pending:
- [proposals, queued tasks, or "Nothing pending"]

Awaiting decision:
- [`new` entry: "MP-YYYYMMDD-N (tier N): [question] — Reply `MP-YYYYMMDD-N yes` or `MP-YYYYMMDD-N no`"]
- [`renudged` entry: "Still waiting on MP-YYYYMMDD-N: [question] (ignore again to drop it)"]
- [Omit section entirely when the step-9a verdict's `new` and `renudged` are both empty.]

Cost:
- [cost-spike alert if flagged by reflect]
- [Omit section entirely when no spike is flagged.]

Today's priorities:
- [from OPERATOR.md Current Priority, filtered to actionable items]
```

Adapt the greeting and section headers to the operator's configured language. Keep the entire brief under 25 lines — strip lower-priority lines if the Overnight section pushes over the cap. **`Awaiting decision:` lines are final and non-droppable, and so is `Cost:`** (it only renders on a flagged spike, so its presence is itself the alert) — strip from `Energy`, `Today's priorities`, and `Updates` (in that order) before touching MP lines.

## Delivery

- If invoked as a routine, or `config.always_on` is `true` in `.hermit/config.json`: deliver the composed brief via the Operator Notification protocol in CLAUDE.md (core resolves the channel and falls back to push when no channel is reachable). The terminal is unmonitored in always-on mode. For the push-fallback branch, condense to a single line (per § Operator Notification push format): lead with any overnight anomaly or open `Awaiting decision:` count, then energy/cost if flagged. Example: `House OK overnight, 2 awaiting decision, 14kWh: open CC to view`.
- Otherwise (invoked on demand in an interactive session): output to terminal.
- Never include secrets, tokens, or internal file paths in the brief.
