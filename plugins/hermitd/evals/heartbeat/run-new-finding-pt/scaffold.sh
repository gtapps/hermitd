#!/usr/bin/env bash
# Seeds a resident hermit state dir for this case (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state
cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{
  "agent_name": "assistant",
  "timezone": "Europe/Lisbon",
  "escalation": "balanced",
  "language": "pt-PT",
  "channels": {
    "discord": {
      "enabled": true,
      "allowed_users": [
        "100000000000000001"
      ],
      "default_chat_id": "400000000000000001"
    }
  },
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit"
cat > '.hermit/HEARTBEAT.md' <<'HERMIT_FIXTURE'
# Heartbeat Checklist
<!-- End each item with [ask] (default), [act], or [note] to set its trust policy; keep the token trailing so its item key stays stable. -->
<!-- Keep under 10 items. Move periodic checks to routines (/hermit-settings routines). -->

## Standing Checks
- Review `proposals/` for any with `status: proposed` needing operator review. Skip `accepted` (operator-owned, implementation underway), `resolved`, `deferred`, and `dismissed`.
- Read `state/doctor-report.json` → the `credential-expiry` check; if its status is warn or fail, tell the operator which credential needs re-auth and name the plugin's reauth skill from the report detail.

## Project Checks
- Root disk usage above 85% [ask]
HERMIT_FIXTURE
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Prefers short messages.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
