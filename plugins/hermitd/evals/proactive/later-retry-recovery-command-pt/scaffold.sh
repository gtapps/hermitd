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
      "allowed_users": [
        "100000000000000001"
      ],
      "default_chat_id": "400000000000000001"
    }
  },
  "routines": [
    {
      "id": "hermitd:later-check",
      "skill": "hermitd:later run",
      "schedule": "0 9 * * *",
      "enabled": true
    }
  ],
  "language": "pt-PT",
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
echo OK
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/hypotheses.jsonl' <<'HERMIT_FIXTURE'
{"id":"00000000-0000-4000-8000-000000000001","claim":"A exportação contém todas as encomendas","cmd":"printf 'missing orders\\n'; exit 0","due":"2026-10-01T12:00:00.000Z","origin":"hermit","session":null,"created_at":"2026-09-30T12:00:00.000Z","state":"pending","exit":0,"output":"missing orders\n"}
{"id":"00000000-0000-4000-8000-000000000002","claim":"A fila de entregas está vazia","cmd":"exit 1","due":"2026-10-01T12:00:00.000Z","origin":"hermit","session":null,"created_at":"2026-09-30T12:00:00.000Z","state":"pending","exit":1,"output":""}
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
