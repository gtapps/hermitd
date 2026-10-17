---
name: ha-safety-audit
description: Audit all live Home Assistant automations and scripts against the safety policy. Catches policy drift from entities added via the HA UI that bypassed this plugin's safety gate. Runs weekly as a routine via reflect --check-id ha-safety-audit --check hermitd-homeassistant:ha-safety-audit.
allowed-tools:
  - Bash
  - Read
---

# HA Safety Audit

## Purpose

The plugin's safety gate only runs when automations are built through `ha-build-automation`. Automations and scripts added directly via the HA UI bypass it. This skill re-audits every live automation and script against the current safety policy and surfaces violations so the operator can review them.

Violations listed in `.hermit/compiled/acknowledged-violations.md` (under `automation_ids` or `script_ids`) are suppressed from the actionable findings and reported separately as acknowledged.

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-automations`.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-scripts`.
3. Each command writes JSON + markdown artifacts under `.hermit/raw/audit-ha-safety-*` and `.hermit/raw/audit-ha-script-safety-*` and prints one JSON object: `date`, `domain`, `scanned`, `passed`, `violations` (each `alias`, `id`, `reasons`), and the counts `acknowledged`, `unmanaged` and `fetch_failures`.
4. Render one block per command as below and join the two with a blank separator line. reflect --check-id ha-safety-audit --check hermitd-homeassistant:ha-safety-audit consumes the result as the scheduled check output.

## Output contract

Render each command's block in this shape, one violation line per entry with its `reasons` joined by `; `:

```
ha-safety-audit findings — YYYY-MM-DD
Policy violations: N
- <alias> (`<id>`): <reasons>
No action needed: M automations passed
Acknowledged (suppressed): K
Skipped (no numeric id): U
Skipped (404 on config fetch): F
```

Scripts use `ha-script-safety-audit findings — YYYY-MM-DD` as the first line and `scripts` in place of `automations`. Leave out a count line whose count is 0.

If `violations` is empty, the `Policy violations`, violation and `No action needed` lines become one: `No actionable findings. (<scanned> automations scanned)` or `No actionable findings. (<scanned> scripts scanned)`.

## Failure modes

- HA unreachable: the CLI prints `{"error":"ha_unreachable:<detail>"}` and exits 1. Treat that as "skipped, cannot audit" in reflect --check-id ha-safety-audit --check hermitd-homeassistant:ha-safety-audit context; do not retry automatically.
- No automations or scripts configured → `No actionable findings. (0 automations/scripts scanned)` — not an error.
