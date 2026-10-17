#!/usr/bin/env bash
# Compare the loaded plugin's version against the version this project last applied.
# Prints bare OK when they agree, else one JSON object:
#   {"status":"upgrade_available","plugin_version":..,"config_version":..,"always_on":bool}
#     plugin newer: hermit-evolve applies it.
#   {"status":"stale_plugin_runtime","plugin_version":..,"config_version":..,"plugin_root":..}
#     config newer: the session runs a stale install copy. hermit-evolve is the wrong
#     remedy (it would no-op, or downgrade the applied stamp), so callers never turn
#     this status into an evolve directive, not even under always_on.
# Callers compose any operator or context text from these fields; startup-context.ts
# renders the SessionStart section.
#
# Usage: bash scripts/check-upgrade.sh <plugin_root>
# Exit: 0 for every outcome; 1 only when bun itself cannot run.

PLUGIN_ROOT="${1:-${CLAUDE_PLUGIN_ROOT}}"
CONFIG=".hermit/config.json"

[ -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ] || { echo OK; exit 0; }
[ -f "$CONFIG" ] || { echo OK; exit 0; }

# Extract version from plugin.json (simple grep, no JSON parse needed)
PLUGIN_VER=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PLUGIN_ROOT/.claude-plugin/plugin.json" | head -1 | grep -o '"[^"]*"$' | tr -d '"')
[ -z "$PLUGIN_VER" ] && { echo OK; exit 0; }

# Read config version + always_on, compute the version relation and print the verdict
# in one bun pass (bun also does the JSON escaping). The relation is computed here, not
# in shell: `sort -V` orders prereleases differently and varies by platform, and
# evolve-plan.ts / evolve-finalize.ts decide the same question with cmpSemver. All three
# surfaces must agree on the direction, so this mirrors cmpSemver exactly (compare the
# leading X.Y.Z triple; unparseable reads as equal, which keeps this advisory check
# quiet rather than misdirecting).
# try/catch inside the snippet: bun exits 0 on uncaught fs errors.
# The catch (config.json present but unreadable/invalid JSON; absence already exited above) deliberately
# reports upgrade_available, not OK: that routes the operator to hermit-evolve, which reports the real
# `config_json_invalid` instead of going quiet on a corrupt config. Only an unparseable VERSION STRING
# on either side reads as equal (OK).
bun -e '
const [configPath, pluginVer, pluginRoot] = process.argv.slice(1);
let configVer = "0.0.0", alwaysOn = false, rel = "ahead";
try {
  const c = JSON.parse(require("fs").readFileSync(configPath, "utf8"));
  configVer = String((c._hermit_versions ?? {})["hermitd"] ?? "0.0.0");
  alwaysOn = c.always_on === true;
  const triple = (v) => { const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; };
  const a = triple(pluginVer), b = triple(configVer);
  rel = "equal";
  if (a && b) for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) { rel = a[i] > b[i] ? "ahead" : "behind"; break; } }
} catch { configVer = "0.0.0"; alwaysOn = false; rel = "ahead"; }
if (rel === "equal") console.log("OK");
else if (rel === "behind") console.log(JSON.stringify({ status: "stale_plugin_runtime", plugin_version: pluginVer, config_version: configVer, plugin_root: pluginRoot }));
else console.log(JSON.stringify({ status: "upgrade_available", plugin_version: pluginVer, config_version: configVer, always_on: alwaysOn }));
' "$CONFIG" "$PLUGIN_VER" "$PLUGIN_ROOT" 2>/dev/null || { echo '{"error":"bun_failed"}'; exit 1; }
