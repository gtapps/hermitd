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
  "heartbeat": {
    "active_hours": {
      "start": "08:00",
      "end": "22:00"
    }
  },
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
# Verificações da casa

## Sempre
- Rever `proposals/` com `status: proposed` à espera da minha decisão. Ignorar `accepted`, `resolved`, `deferred` e `dismissed`.

## Casa
- Porta da frente destrancada depois das 23h [ask]
- Temperatura do congelador acima de -15 °C [ask]
HERMIT_FIXTURE
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Prefers short messages.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
