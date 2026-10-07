---
name: ha-build-automation
description: Draft a Home Assistant automation or script YAML from a description. Validates against the entity inventory and safety policy. Use when the user wants to create or modify HA automations.
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

# Build HA Automation

## Steps

1. **Gather context**:
   - Read `.hermit/raw/snapshot-ha-normalized-latest.json` for available entities and services.
   - Use the stored language from OPERATOR.md (`## HA hermit` section) for `alias` and `description` fields.
   - Optionally call `GetLiveContext` via MCP for current state.

2. **Draft the YAML**:
   - **Always include `id:` as the first field**, using a stable, language-neutral snake_case value (e.g., `kitchen_motion_after_sunset_notification`). The `validate-apply` command uses this as the REST config ID — omitting it causes a derived, fragile ID that breaks on alias rename.
   - Use the stored locale for `alias` and `description`.
   - Set `mode` explicitly where concurrency matters.
   - Write to `.hermit/raw/automation-<automation_id>.yaml`.

3. **Provision missing helpers**:
   - Scan the drafted YAML for helper entity IDs (`input_boolean.*`, `input_number.*`, `input_text.*`, `input_select.*`, `input_datetime.*`, `timer.*`, `counter.*`, `schedule.*`) that are absent from the entity inventory snapshot. If none are absent, skip to step 4.
   - For each distinct helper type among the absent helpers, run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-helpers --type <type>` once to check whether any absent helper of that type already exists under a different `entity_id`. If found, reference that entity instead.
   - For each helper that genuinely needs to be created, compose the JSON payload. Minimum required fields by type:
     - `input_boolean` / `input_text`: `{"name": "Friendly Name"}`
     - `input_number`: `{"name": "...", "min": <N>, "max": <N>}` (optional: `step`, `initial`, `mode`)
     - `input_select`: `{"name": "...", "options": ["opt_a", "opt_b"]}`
     - `input_datetime`: `{"name": "...", "has_date": true, "has_time": true}`
     - `timer`: `{"name": "...", "duration": "HH:MM:SS"}`
     - `counter`: `{"name": "...", "initial": 0, "step": 1}`
     - `schedule`: `{"name": "..."}` with weekday blocks — run `ha list-helpers --type schedule` to inspect the schema of any existing helper; if none exists, check the HA schedule integration docs for the required block format.
   - Preview the helper, then run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-helper <type> '<json>'` and handle the result:
     - `"blocked": true`; `ha_safety_mode` is `strict`; explain the boundary and create a proposal via `/hermitd:proposal-create`. Do not retry the denied operation. Continue to validation so the operator sees which entities are still missing.
     - `"ok": true` — helper created; continue.
   - If any helpers were created, run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context --incremental` to update the snapshot before validation.

4. **Validate**:
   - Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha simulate <path>` to check entity references and policy.
   - Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <path>` for a safety assessment.

5. **Handle results**:
   - `decision: "allow"`; valid and safe: offer to apply via `/hermitd-homeassistant:ha-apply-change`.
   - `decision: "ask"` (ask mode); explain which sensitive entities are involved, then offer to apply. The apply step will require explicit operator confirmation.
   - `decision: "deny"` (strict mode); explain why and create a proposal using `/hermitd:proposal-create`.
   - If entities are missing: suggest refreshing context first.

## YAML Conventions

- IDs: `snake_case`, language-neutral, descriptive
- Aliases: stored locale, human-readable
- Descriptions: stored locale, explain the purpose
- Triggers: use `platform:` explicitly
- Actions: use `service:` with full domain (e.g., `light.turn_on`)
- Targets: prefer `entity_id` over area/device when specific

## Safety

Under `ha_safety_mode: strict` (explicit): never draft automations that actuate `lock`, `alarm_control_panel`, or security-related `cover`/`button`/`switch`. If the user requests this, explain the safety boundary and create a proposal for manual review. Under `ask`: draft and run `ha policy-check`; the decision field in the result drives step 5.
