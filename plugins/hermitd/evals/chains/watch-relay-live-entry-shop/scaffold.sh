#!/usr/bin/env bash
# Seeds a resident hermit state dir for this case (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state
cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{"agent_name": "assistant", "timezone": "Europe/Lisbon", "channels": {"discord": {"allowed_users": ["100000000000000001"]}},"_hermit_versions":{"hermitd":"$ver"}}
HERMIT_CONFIG
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Runs a small online tea shop alone. Prefers short messages.
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/monitors.runtime.json' <<'HERMIT_FIXTURE'
{
  "monitors": [
    {
      "id": "session-export-wholesale-1793030000-a1b2",
      "description": "wholesale stock export",
      "target": "export-wholesale",
      "started_at": "2026-10-21T08:30:00Z",
      "source": "adhoc",
      "class": "peer-idle"
    }
  ],
  "last_cleared": "2026-10-21T08:00:00Z"
}
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
