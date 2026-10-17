#!/usr/bin/env bash
# Compare the loaded plugin's version against the version this project last applied.
# Three outcomes: silent (equal), "---Upgrade Available---" (plugin newer — evolve),
# "---Stale Plugin Runtime---" (config newer — a stale install copy is loaded, which
# evolve cannot fix and must not be asked to).
# Designed to be called from the SessionStart hook.
# Output exception: sectioned text, not JSON. startup-context.ts injects it verbatim
# as hook context, and brief relays the section's lines to the operator.
#
# Usage: bash scripts/check-upgrade.sh <plugin_root>
# Exit: always 0 (advisory only)

PLUGIN_ROOT="${1:-${CLAUDE_PLUGIN_ROOT}}"
CONFIG=".hermit/config.json"

[ -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ] || exit 0
[ -f "$CONFIG" ] || exit 0

# Extract version from plugin.json (simple grep — avoids interpreter startup)
PLUGIN_VER=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PLUGIN_ROOT/.claude-plugin/plugin.json" | head -1 | grep -o '"[^"]*"$' | tr -d '"')
[ -z "$PLUGIN_VER" ] && exit 0

# Extract config version + always_on AND compute the version relation in the same bun
# pass. The relation is computed here, not in shell: `sort -V` orders prereleases
# differently and varies by platform, and evolve-plan.ts / evolve-finalize.ts decide the
# same question with cmpSemver — all three surfaces must agree on the direction, so this
# mirrors cmpSemver exactly (compare the leading X.Y.Z triple; unparseable reads as equal,
# which keeps this advisory check silent rather than misdirecting).
# try/catch inside the snippet: bun exits 0 on uncaught fs errors, so a shell `||` fallback alone is not enough.
# The catch (config.json present but unreadable/invalid JSON — absence already exited above) deliberately
# reports "ahead", not "equal": the advisory banner then routes the operator to hermit-evolve, which
# reports the real `config_json_invalid` instead of going silent on a corrupt config. Only an unparseable
# VERSION STRING on either side reads as equal (silent).
CONFIG_OUT=$(bun -e '
try {
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const configVer = (c._hermit_versions ?? {})["hermitd"] ?? "0.0.0";
  const triple = (v) => { const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; };
  const a = triple(process.argv[2]), b = triple(configVer);
  let rel = "equal";
  if (a && b) for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) { rel = a[i] > b[i] ? "ahead" : "behind"; break; } }
  console.log(configVer);
  console.log(c.always_on === true ? "true" : "false");
  console.log(rel);
} catch { console.log("0.0.0"); console.log("false"); console.log("ahead"); }
' "$CONFIG" "$PLUGIN_VER" 2>/dev/null || printf '0.0.0\nfalse\nahead\n')
CONFIG_VER=$(printf '%s\n' "$CONFIG_OUT" | sed -n '1p')
ALWAYS_ON=$(printf '%s\n' "$CONFIG_OUT" | sed -n '2p')
RELATION=$(printf '%s\n' "$CONFIG_OUT" | sed -n '3p')

[ "$RELATION" = "equal" ] && exit 0

# Config ahead of the loaded plugin: the session is running a stale install copy.
# hermit-evolve is the wrong remedy here (it would no-op, or downgrade the applied
# stamp), so this branch never emits an evolve directive — not even under always_on.
# The path goes last: startup-context.ts slices this section to 500 chars, so a very
# long install path truncates instead of eating the instruction.
if [ "$RELATION" = "behind" ]; then
  echo "---Stale Plugin Runtime---"
  echo "Loaded plugin v${PLUGIN_VER} is older than this hermit's applied state v${CONFIG_VER} — a stale install copy. hermit-evolve cannot fix this: find the \`claude plugin list\` entry matching the path below, run \`claude plugin update hermitd@hermitd --scope <its scope>\`, then restart."
  echo "Loaded from: ${PLUGIN_ROOT}"
  exit 0
fi

echo "---Upgrade Available---"
if [ "$ALWAYS_ON" = "true" ]; then
  echo "Plugin v${PLUGIN_VER} ≠ config v${CONFIG_VER}. REQUIRED: run /hermitd:hermit-evolve unattended NOW, before any other work this session."
else
  echo "Plugin v${PLUGIN_VER} ≠ config v${CONFIG_VER}. Run /hermitd:hermit-evolve"
fi
