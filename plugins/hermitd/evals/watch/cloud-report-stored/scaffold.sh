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
      "allowed_users": [
        "100000000000000001",
        "100000000000000002"
      ]
    }
  },
  "monitors": [],
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
cat <<'JSON'
{"status":"claimed","row":{"id":"T-20261021-090100","handle":"audit-laptop-backups","title":"Audit the laptop backups","status":"open","owner":"helper:laptop-audit","delegated":true,"result_rev":1,"report_id":"r7k2m9q4x1","report_kind":"result","delivery":"relay","report_verdict":"Backups run nightly; one share is excluded","report_decisions":[],"conversation":"discord:400000000000000001","card_chat_id":null,"card_message_id":null,"waiting_on":null}}
JSON
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
