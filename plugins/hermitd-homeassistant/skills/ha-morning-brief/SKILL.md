---
name: ha-morning-brief
description: Morning house brief — live status, overnight anomalies, energy snapshot, and pending HA updates. Runs as a daily routine or on demand.
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

A house-focused morning brief using live HA state and house artifacts. Designed to run as the `hermitd-homeassistant:morning-brief` routine at start of day. Core's work brief runs independently; neither brief replaces or disables the other.

## Steps

1. **Time & context**: Call `GetDateTime` for current time. Use the session language.

2. **Fetch overnight history**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha fetch-history --window-days 1`. When it prints `{"error"}` (exit 1), pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) (`history fetch failed: <error>`) and skip the `Overnight:` section entirely: no fallback wording in the brief. On success, read `.hermit/raw/snapshot-ha-history-1d-latest.json`.

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

8. **Pending updates**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha updates --digest`. It prints one JSON object and exits 0:
   - `status` is `skipped`: pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) (`updates fetch failed: <detail>`) and omit the `Updates:` section entirely.
   - `total` is 0: omit the `Updates:` section entirely.
   - Otherwise: render the `Updates:` section, translating tier labels into the operator's language. `updates` holds the top updates in tier order, one `[tier] Title: installed → latest` line each (a null version renders as `?`); add `+ N more updates pending` when `more` is above 0 and `[hacs] N HACS updates pending` when `hacs_pending` is above 0.
9. **Compose brief**: Write a concise morning brief in the session language. Use the format below.

10. **Write to `compiled/`** — Write the composed brief to `.hermit/compiled/brief-morning-<YYYY-MM-DD>.md` with frontmatter:
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
- [tier] Title: installed → latest
- [N HACS updates pending]
- [Omit section entirely when none pending or the fetch was skipped.]

```

Adapt the greeting and section headers to the session language. Keep the entire brief under 25 lines; preserve house alerts and strip lower-priority energy and update lines when needed.

## Delivery

- If invoked as a routine, or `config.always_on` is `true` in `.hermit/config.json`: deliver the composed brief via the Operator Notification protocol (core resolves the channel and falls back to push when no channel is reachable). The terminal is unmonitored in always-on mode. For the push-fallback branch, condense to a single line (per § Operator Notification push format): lead with any overnight anomaly, then unusual energy use if present. Example: `House OK overnight, 14kWh: open CC to view`.
- Otherwise (invoked on demand in an interactive session): output to terminal.
- Never include secrets, tokens, or internal file paths in the brief.
