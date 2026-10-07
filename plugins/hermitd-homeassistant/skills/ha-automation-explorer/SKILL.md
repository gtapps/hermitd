---
name: ha-automation-explorer
description: Browse and explain the hermit's Home Assistant automations — list by topic, filter by keyword with plain-language YAML explanations, or sort by last-fired. Read-only. Use when the operator asks "what automations do I have / what does this one do / which haven't fired."
allowed-tools:
  - Bash
  - Read
  - mcp__homeassistant__GetDateTime
  - mcp__homeassistant__llm__GetDateTime
---

# HA Automation Explorer

Read-only. No writes, no proposals, no actuation.

## Shared preamble (all modes)

1. Read operator language from OPERATOR.md (`## HA hermit` section). Use this locale for all output.
2. Read `.hermit/raw/snapshot-ha-normalized-latest.json`. Check the file's `mtime` with `stat`. If missing or older than 24 hours, append this warning to all output:
   > "Context snapshot is stale — run `/hermitd-homeassistant:ha-refresh-context` for accurate entity data."
3. Extract `entity_index` and `silence_summary` from the snapshot. Build the automation list: all entries in `entity_index` whose key starts with `automation.`.

## Mode 1 — List all automations

Invoked as `/hermitd-homeassistant:ha-automation-explorer` (no args).

1. If the automation list is empty, output: "No automations found in the context snapshot." Stop.
2. Group automations by topic, inferring from `friendly_name` (from `attributes.friendly_name`) and `entity_id`. Buckets (best-effort — no area registry exists):
   - **Security**: alarm, lock, door, gate, camera, motion, presence
   - **Comfort**: climate, temperature, heating, cooling, fan, blind, curtain, cover
   - **Presence**: arrive, leave, away, home, person
   - **Energy**: power, energy, solar, charge, saving
   - **Other**: anything that doesn't fit the above
3. Derive a one-line description from `friendly_name` for each automation. Do not fetch configs here.
4. Mark automations that appear in `silence_summary.dead_automations` with `⚠ dead (N days)`. For `never_fired: true` entries, use `⚠ never fired`.
5. Output the catalog grouped by topic:
   ```
   **Security**
   - automation.alarm_away — "Arm alarm when everyone leaves" ⚠ dead (12 days)

   **Comfort**
   - automation.morning_blinds — "Open blinds at sunrise"
   ```

## Mode 2 — Explain automations matching a keyword

Invoked as `/hermitd-homeassistant:ha-automation-explorer <keyword>`.

1. Filter the automation list: keep entries where `keyword` appears (case-insensitive) in `friendly_name` or `entity_id`.
2. If no matches: output "No automations matching '<keyword>'." Stop.
3. If more than 8 matches, the keyword is too broad to explain at once. List the matching `entity_id` + `friendly_name` pairs and ask the operator to narrow the keyword. Do not fetch any configs. Stop.
4. For each match, check `attributes.id`. If null (YAML-packaged automation, not retrievable via REST), note: "Config not retrievable — automation is YAML-packaged." Skip the config fetch for that entry.
5. For each match with a numeric `id`, fetch its config:
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha get-automation-config <id>
   ```
6. Explain the fetched YAML in plain language in the operator's locale:
   - **Triggers**: what starts this automation (time, state change, event, etc.)
   - **Conditions**: any guards that must be true for it to run
   - **Actions**: what it does, step by step
   - **State**: enabled / disabled; `⚠ dead` if in `silence_summary.dead_automations`

## Mode 3 — Sort by last fired

Invoked as `/hermitd-homeassistant:ha-automation-explorer --last-fired`.

1. Call `GetDateTime` for the current UTC timestamp.
2. Sort all automations by `entity_index[entity_id].attributes.last_triggered` descending (most recently fired first). Automations with null `last_triggered` go at the bottom.
3. Compute human-readable "N days ago" using the timestamp from Step 1. For null `last_triggered`: show "never fired."
4. Enrich with `silence_summary.dead_automations` to mark stale entries — do NOT call `fetch-history`. An automation is dead if it appears in `silence_summary.dead_automations` (30+ days silent while enabled, or never fired).
5. Output the sorted roster, one automation per line:
   ```
   1. automation.morning_blinds — "Open blinds at sunrise" — fired 2 days ago
   2. automation.alarm_away — "Arm alarm when everyone leaves" — fired 14 days ago ⚠ dead
   ...
   N. automation.old_routine — "Old routine" — never fired ⚠ dead
   ```
6. End with: "X automations total. Y dead or never fired."

## Notes

- This skill is the on-demand browsing view. `ha-analyze-patterns` is the scheduled, proposal-generating silence audit — it remains authoritative for surfacing dead automations via the proposal pipeline.
- **Mode 1 and Mode 3 flag never-fired automations differently, by design.** Mode 1 reads `silence_summary.dead_automations`, which only lists a never-fired automation once it is 30+ days old — so a recently-created automation that has never fired is *not* flagged in Mode 1. Mode 3 reads `attributes.last_triggered` directly, so it shows "never fired" immediately regardless of age.
- For deep pattern analysis, use `/hermitd-homeassistant:ha-analyze-patterns`.
- For building new automations, use `/hermitd-homeassistant:ha-build-automation`.
