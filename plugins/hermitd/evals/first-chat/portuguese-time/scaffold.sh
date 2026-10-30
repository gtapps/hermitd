#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state
cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md
cp "$here/../../../state-templates/OPERATOR.md" .hermit/OPERATOR.md
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<CONFIG
{"language":null,"timezone":null,"channels":{},"_hermit_versions":{"hermitd":"$ver"}}
CONFIG
printf '{"armed_at":"2026-10-30T12:00:00Z","attempts":0}\n' > .hermit/state/first-chat.json
