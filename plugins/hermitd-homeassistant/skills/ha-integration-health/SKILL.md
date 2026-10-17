---
name: ha-integration-health
description: Detect dropped HA integrations by computing per-domain unavailable-entity ratios from the latest context snapshot. Flags domains where most entities are unavailable, suggesting the integration lost its connection. Runs daily as a routine via reflect --check-id ha-integration-health --check hermitd-homeassistant:ha-integration-health.
allowed-tools:
  - Bash
---

# HA Integration Health

## Purpose

When an HA integration loses its connection (lost WiFi, API change, expired token), its entities go `unavailable`. This skill reads the latest normalized snapshot, groups entities by domain, and flags domains with a high unavailable ratio.

## Steps

Run the integration-health check via the CLI:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha integration-health
```

The CLI:
- Checks that `snapshot-ha-normalized-latest.json` exists and is fresh (< 24h). If stale or missing, runs `ha refresh-context` first to bring it up to date, then proceeds with analysis.
- Groups entities by domain prefix, computes unavailable ratios, and flags domains where `total >= 3` AND `ratio >= 0.5`.
- Writes `.hermit/state/integration-health-degraded-domains.json` — a machine-readable state artifact consumed by `ha-analyze-patterns` (via `silence.ts`) to suppress overlapping `long_unavailable` findings.
- Prints one JSON object: `date`, `scanned_domains` and `degraded` (each entry `domain`, `unavailable`, `total`, `percent`), or `{"date","status":"skipped","reason","detail"}` with `reason` `refresh_failed` (snapshot stale or missing and HA unreachable) or `snapshot_unreadable`.

## Output contract

reflect --check-id ha-integration-health --check hermitd-homeassistant:ha-integration-health routes the findings block through the proposal pipeline. Render it from the JSON in this fixed shape, one line per `degraded` entry with `percent` to one decimal:

```
ha-integration-health findings — <date>
Degraded domains: N
- <domain>: <unavailable>/<total> entities unavailable (<percent>%)
```

If `degraded` is empty: `No actionable findings. (<scanned_domains> domains scanned)`.
If `reason` is `refresh_failed`: `No actionable findings. (skipped: snapshot stale, refresh failed — <detail>)`.
If `reason` is `snapshot_unreadable`: `No actionable findings. (skipped: snapshot unreadable — <detail>)`.

Keep the output to this shape: no prose, no extra sections.
