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
  "channels": {
    "discord": {
      "enabled": true,
      "operators": [
        "100000000000000001"
      ],
      "allowed_users": [
        "100000000000000001"
      ],
      "default_chat_id": "400000000000000001"
    }
  },
  "routines": [
    {
      "id": "hermitd:make-me-proactive",
      "skill": "hermitd:make-me-proactive",
      "schedule": "0 9 * * *",
      "enabled": true
    }
  ],
  "monitors": [],
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit"
cat > '.hermit/HEARTBEAT.md' <<'HERMIT_FIXTURE'
# Standing checks
HERMIT_FIXTURE
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
echo OK
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/proposal-digest.json' <<'HERMIT_FIXTURE'
{"total":0,"omitted":0,"proposals":[]}
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
- [Supplier price](project_supplier_price.md) — Manual supplier price check before wholesale orders
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/project_supplier_price.md' <<'HERMIT_FIXTURE'
---
name: supplier-price
description: Manual supplier case price check
type: project
---

The operator runs bash tools/supplier-price every morning before ordering wholesale tea, and orders when the case price falls below €50. The command prints the current price and exits nonzero when it cannot read it.
HERMIT_FIXTURE
mkdir -p "tools"
cat > 'tools/supplier-price' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
printf "52.00\n"
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
mkdir -p eval-stand-ins
printf '{"root":"%s/.hermit","memory_dir":"%s/memory"}\n' "$PWD" "$PWD" > eval-stand-ins/proposal-anchor.json
