---
name: ha-update-check
description: Detect pending Home Assistant updates (Core, OS, Supervisor, add-ons, HACS) from the update.* domain and surface them as actionable proposals. Runs daily as a routine via reflect --check-id ha-update-check --check hermitd-homeassistant:ha-update-check.
allowed-tools:
  - Bash
---

# HA Update Check

## Purpose

Home Assistant surfaces pending updates as `update.*` entities — one domain covering Core, OS/Supervisor, add-ons, and HACS integrations, each carrying `installed_version`/`latest_version`/`release_summary`/`release_url`. This skill lists what's pending and reports it in a fixed format the proposal pipeline can fan out into per-update proposals.

Native fields only — no web fetch for breaking-change detail (keeps this check cheap; fetch on accept if that's ever needed). HA-native `skipped_version` is honored: an update the operator skipped in the HA UI stays quiet here too.

## Steps

Run the update check via the CLI:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha updates
```

The CLI:
- Fetches live entity states and filters to `update.*` entities where `state == "on"` (an update is pending) and the pending version hasn't been skipped in HA.
- Classifies each into a tier: `core` (HA Core), `os` (Operating System), `supervisor`, `addon`, or `hacs`. Core/OS/Supervisor are recognized by their well-known entity_ids; add-ons are recognized by the native backup capability they advertise (HA's `supported_features` BACKUP bit), which HACS/custom-integration updates lack; anything without it aggregates into the `hacs` bucket rather than risking noise.
- Prints one JSON object: `date`, `total`, `updates` (each individual update's `tier`, `title`, `installed_version`, `latest_version`, `release_url`) and `hacs_pending`, or `{"date","status":"skipped","reason":"ha_unreachable","detail"}` when HA is unreachable.

## Output contract

`reflect --check-id ha-update-check --check hermitd-homeassistant:ha-update-check` routes the findings block through the proposal pipeline. Render it from the JSON in this fixed shape: `Updates pending:` carries `total`, one line per `updates` entry (a null version renders as `?`; omit ` — <release_url>` when it is null), and one `[hacs]` line when `hacs_pending` is above 0:

```
ha-update-check findings — <date>
Updates pending: N
- [core] Home Assistant Core: 2026.6.3 → 2026.7.1 — <release_url>
- [addon] Mosquitto broker: 6.4 → 6.5 — <release_url>
- [hacs] 7 HACS updates pending
```

If `total` is 0: `No actionable findings. (no updates pending)`.
If `status` is `skipped`: `No actionable findings. (skipped: <detail>)`.

Keep the output to this shape: no prose, no extra sections. Each proposal title should carry the concrete target version (e.g. `[ha-update] HA Core → 2026.7.1`): that keeps same-version re-emits byte-identical so proposal-triage reliably suppresses repeats; Core/OS/Supervisor and each add-on become individual proposals, all pending HACS updates aggregate into one.

## On accept

If `ha_update_auto_apply` is enabled in `.hermit/config.json`, route acceptance through `/hermitd-homeassistant:ha-apply-update` rather than applying directly — it enforces the tier rule (add-ons/HACS may auto-apply; Core/OS/Supervisor always wait for an explicit operator go-ahead). If the flag is absent or false, the proposal is purely advisory: resolve it once the operator has applied the update themselves in the HA UI.
