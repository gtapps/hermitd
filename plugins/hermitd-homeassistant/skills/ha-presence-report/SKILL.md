---
name: ha-presence-report
description: Presence history & tracker-health report — current home/away state, reliability, recent arrival/departure transitions, and activity patterns for person/device_tracker entities. Use when the operator asks about presence history or when a presence-dependent automation (locks, alarm, vacuum, climate) misbehaves.
allowed-tools:
  - Bash
  - Read
  - mcp__homeassistant__GetDateTime
  - mcp__homeassistant__llm__GetDateTime
---

# HA Presence Report

## Steps

1. Call `GetDateTime` for the current time reference. Read the stored locale from `.hermit/OPERATOR.md` under `## HA hermit` (fall back to English if absent).

2. Read `.hermit/raw/snapshot-ha-normalized-latest.json`.
   - If the file is missing or older than 24 hours, prepend a staleness warning to the output:
     > "Context snapshot is stale — run `/hermitd-homeassistant:ha-refresh-context` for accurate data."
   - Filter `entity_index` to keys starting with `person.` or `device_tracker.`. **If no matching keys exist, emit "no presence entities found — presence tracking isn't configured in this HA instance" and stop. Do not proceed to the history fetch.**
   - From the matched entities derive:
     - **Current state**: value of `state` field (home / away / unknown / unavailable) and `last_changed` → "since HH:MM" relative to now.
     - **Reliability flags**: mark an entity unreliable if `state == "unavailable"` OR `last_changed` is more than 48 hours ago (stale tracker).

3. Run:
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha fetch-history \
     --window-days 7 \
     --entities "device_tracker.*" "person.*" \
     --include-transitions
   ```
   This writes `.hermit/raw/snapshot-ha-history-7d-latest.json`.

4. Read `snapshot-ha-history-7d-latest.json`. For each presence entity:
   - **Recent transitions**: show the last 5 entries from `transitions` (ordered chronologically), formatted as `HH:MM DD-Mon — <state>`.
   - **Home/away split**: derive from `state_durations` — what percentage of the window was "home" vs "away".
   - **Typical activity windows**: bucket the `transitions` list by UTC hour, keyed on direction: transitions *to* `home` are arrivals, transitions *to* `away` are departures. Report the top 1–2 arrival hours and departure hours separately (e.g. "typically arrives around 18:00 UTC, leaves around 08:00 UTC"). With ≥7d of data and ≥5 total transitions, state the windows; below that threshold, say "insufficient data for pattern detection." (`hour_histogram` counts all events regardless of direction, so use it only as a fallback for entities whose states aren't home/away.)

5. Compose and print the inline report in the operator's locale:
   ```
   ## Presence Report — <date>

   ### Current State
   <per-entity: who is home/away/unknown, since when>

   ### Tracker Health
   <list unreliable entities with reason; "All trackers healthy." if none>

   ### Recent Transitions (last 7 days)
   <per-entity: last 5 home/away events with timestamp>

   ### Activity Patterns
   <per-person: typical arrival/departure windows, or "insufficient data">
   ```

6. Write `compiled/presence-report-<YYYY-MM-DD>.md` with frontmatter:
   ```yaml
   title: "Presence Report — <YYYY-MM-DD>"
   type: presence-report
   created: <ISO 8601 with UTC offset>
   task: <T-... for the open record in this turn; omit this field otherwise>
   tags: [presence, ha]
   ```
   Body: the inline report from step 5.

7. Inside an open record's turn, pipe `[[compiled/presence-report-<date>.md]]` into `.hermit/bin/hermitd-run task note .hermit <id>`. Otherwise skip the note.

## Failure modes

- **HA unreachable** (fetch-history exits non-zero): print "Presence history unavailable — HA unreachable. Current state from snapshot shown above." and stop after step 2. Do not write the compiled artifact.
- **No presence entities** (step 2 short-circuit): print the message and stop. This is not an error.
- **Snapshot stale/missing** (step 2): include the staleness warning but continue — current-state and reliability from the snapshot will be degraded or absent; history fetch may still work.
