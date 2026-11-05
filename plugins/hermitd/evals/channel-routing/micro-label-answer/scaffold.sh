#!/usr/bin/env bash
# Seeds a resident hermit state dir so the real SessionStart hook injects the live task policy (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state
cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md
# Stamp the loaded plugin version so the hook injects no upgrade notice.
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{"agent_name":"assistant","timezone":"Europe/Lisbon","operator_profile":"technical","language":null,"channels":{"discord":{"allowed_users":["100000000000000001"]}},"_hermit_versions":{"hermitd":"$ver"}}
HERMIT_CONFIG
# The pending question, so the pending-question stage reports it as it would live.
cat > .hermit/state/micro-proposals.json <<'HERMIT_MP'
{"pending":[{"id":"MP-0020","tier":1,"status":"pending","follow_up_count":0,"ts":"2026-10-01T09:00:00Z","question":"How often should the backup report run? daily / weekly","options":["daily","weekly"],"chat":"discord:400000000000000001"}]}
HERMIT_MP
