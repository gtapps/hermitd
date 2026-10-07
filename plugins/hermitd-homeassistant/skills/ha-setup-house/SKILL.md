---
name: ha-setup-house
description: Guided build-out of a Home Assistant house — create areas, assign entities and devices, provision helpers, and scaffold starter automations. Thin orchestration of existing CLI commands; all structural writes are gated by ha_safety_mode.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
  - mcp__homeassistant__llm__GetDateTime
---

# Set Up Your House

Guided build-out of your Home Assistant house structure. Each step runs existing `ha-agent-lab` commands; no new subsystem. Every write is gated by `ha_safety_mode` (strict = proposal, ask = native approval).

## Steps

### 1. Take inventory

Run all four in parallel and present a summary:

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-areas
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-entities --registry
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-devices
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-helpers
```

Report:
- Number of areas, entities, devices, and helpers found
- Entities with no area assigned (unplaced)
- Devices with no area assigned (unplaced)
- Whether a context snapshot exists at `.hermit/raw/snapshot-ha-normalized-latest.json`

### 2. Create areas

Ask: "Which rooms or zones would you like to create? (e.g. Living Room, Kitchen, Bedroom 1)"

For each area the operator names:
1. Check the `list-areas` output — skip if the area already exists (case-insensitive match on name).
2. Preview the target, then run: `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-area "<name>"`
3. Handle the result:
   - `"ok": true` — created; confirm to operator.
   - `"blocked": true` — `ha_safety_mode` is `strict`; explain and create a proposal via `/hermitd:proposal-create`.

After creating all areas, re-run `ha list-areas` and store the updated area map.

### 3. Assign unplaced entities

From the unplaced entity list (step 1), ask the operator which entities to assign and to which area.

For each assignment:

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-entity-area <entity_id> --area <area_id>
```

Use the `area_id` from the `list-areas` output, not the display name.

Handle success and policy refusal the same as step 2.

### 4. Assign unplaced devices

From the unplaced device list (step 1), follow the same pattern:

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-device-area <device_id> --area <area_id>
```

### 5. Provision helpers

Ask: "Do you want to add any input helpers (toggles, counters, schedules, etc.)?"

For each helper:
1. Run `ha list-helpers --type <type>` to check whether a similar helper already exists.
2. Compose the JSON payload (minimum fields by type — same conventions as `ha-build-automation` step 3).
3. Run: `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-helper <type> '<json>'`

Supported types: `input_boolean`, `input_number`, `input_text`, `input_select`, `input_datetime`, `timer`, `counter`, `schedule`.

### 6. Scaffold starter automations (optional)

Ask: "Would you like to create any starter automations for this house?"

For each automation:
- Delegate to `/hermitd-homeassistant:ha-build-automation` — it handles YAML drafting, helper provisioning, simulation, and apply.

### 7. Refresh context

Run a context refresh so the entity snapshot reflects all changes:

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context
```

### 8. Summary

Print a compact report:

```
ha-setup-house complete
  Areas:    N created, M already existed
  Entities: N assigned to areas
  Devices:  N assigned to areas
  Helpers:  N created
  Automations: N scaffolded (via ha-build-automation)
  Context: refreshed

Ready to explore? Try /hermitd-homeassistant:ha-boot
```
