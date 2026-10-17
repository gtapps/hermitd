---
name: ha-apply-update
description: Apply a Home Assistant update surfaced by ha-update-check, when the operator accepts a [ha-update] proposal. Enforces the tier rule -- add-ons/HACS may auto-apply, Core/OS/Supervisor always wait for an explicit operator go-ahead.
allowed-tools:
  - Bash
---

# Apply HA Update

## When this runs

Invoked from `proposal-act`'s Accept flow for a `[ha-update]` proposal (originated by `/hermitd-homeassistant:ha-update-check`). The proposal body carries the entity_id, tier (`core`/`os`/`supervisor`/`addon`/`hacs`), and target version.

## Steps

1. **Read the flag**: check `ha_update_auto_apply` in `.hermit/config.json`.
   - **Absent or `false`**: this is advisory-only. Resolve the proposal — tell the operator the update is available and where (`Settings → System → Updates` in the HA UI), and stop. Do not call `update.install`.
   - **`true`**: show the entity and target version, then continue.

2. **Branch on tier** (from the proposal body). The `addon` vs `hacs` split is defined by the native backup capability: `ha-update-check` tiers an entity `addon` precisely when it advertises HA's BACKUP update feature, so `backup:true` is always valid for an `addon` proposal, and a `hacs` entity is one that can't back itself up (hence the separate full-backup step).

   - **`addon`**: `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha call-service update.install --data '{"entity_id":"<entity_id>","backup":true}'`. HA backs up the add-on natively and rolls back on install failure. Report the result to the operator once done.
   - **`hacs`** (an individual HACS entity accepted out of an aggregated proposal; HACS entities don't support the native `backup` parameter): first `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-backup --agent-ids <configured agent>`. If the backup call is blocked or fails, stop and stay advisory; tell the operator why. Only on a successful backup: `ha call-service update.install --data '{"entity_id":"<entity_id>"}'`.
   - **`core` / `os` / `supervisor`**: never auto-apply, even with the flag on. Show the tier, installed/available versions, and dashboard-access impact. Run: `ha call-service update.install --data '{"entity_id":"<entity_id>","backup":true}'`.

3. **Report**: read the command's JSON output. On success (`data` and `report_path`), tell the operator the update installed and that an audit is at `report_path`. On `{"status":"blocked"}` or `{"error"}`, surface its `detail` or `error` verbatim and leave the proposal open rather than resolving it.

## Approval

`ha_update_auto_apply` permits the update class; Claude Code requests native approval for each installation before execution. Show the target and version first. A policy refusal or native denial stops the operation; do not retry through another route.
