---
name: ha-snapshot-restore
description: Capture the state of a set of Home Assistant entities (lights, covers, climate, switches) to a named artifact and restore it later via scene.apply. Use to make automation testing reversible — snapshot before a risky change, restore if it misbehaves. Restore of sensitive entities is gated by ha_safety_mode.
allowed-tools:
  - Bash
  - Read
---

# HA Snapshot / Restore

## Purpose

Make changes reversible: capture an entity set's current state before testing a new automation or applying a risky change, then restore those exact states if it misbehaves. Capture is read-only; restore actuates devices in one `scene.apply` call.

## Capture (read-only)

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha snapshot-states --name <label> [--domains light,cover,climate,switch] [--entities <id> ...]
```

- `--name` labels the snapshot (default `snapshot`); it becomes part of the artifact filename.
- `--domains` selects which domains to capture (comma-separated; default `light,cover,climate,switch`).
- `--entities` captures an explicit list instead of whole domains.
- Writes `.hermit/raw/snapshot-ha-states-<label>-latest.json` (plus a timestamped copy). Only restore-relevant attributes are stored.

## Restore (actuation — gated)

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha restore-states <artifact>
```

Restore is the plugin's one direct device-actuation path, so it runs through the same `ha_safety_mode` policy as every other actuation:

- **strict (explicit):** if the snapshot contains any sensitive entity (lock, alarm, security-keyworded cover/switch), restore is **blocked**: the CLI prints `{"status":"blocked","reason":"strict_mode",...}` listing the `sensitive` entities; surface it as a proposal. Non-sensitive entities (lights, climate) restore normally.
- **ask:** show the affected entities before restoration; Claude Code requests native approval for sensitive targets before the command executes.
- A successful restore writes an audit report under `.hermit/raw/audit-ha-restore-*`.

## Output contract

Capture prints `{ name, captured, entities, report_path }`.

Restore prints `{ applied, entities, sensitive, report_path }`, or a status with exit 0: `{"status":"blocked","reason":"strict_mode"}` or `{"status":"empty","reason":"no_entities"}`.

## Failure modes

- HA unreachable: the CLI prints `{"error":"ha_unreachable:<detail>"}` and exits 1. An unreadable snapshot file prints `{"error":"snapshot_unreadable:<detail>"}`.
- A snapshot with no matching entities: capture reports `captured: 0`; restore reports `status: "empty"`.
- Restore replays state + captured attributes via `scene.apply`; for cover position and climate setpoints the result depends on what HA's scene integration can reproduce — verify the outcome rather than assuming an exact match.
