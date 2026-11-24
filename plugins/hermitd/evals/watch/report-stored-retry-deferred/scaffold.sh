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
{"status":"watched","followup":"Also update the checkout tests.","row":{"id":"T-20261021-090200","handle":"fix-checkout-button","title":"Fix the checkout button","status":"open","owner":"helper:checkout-fix","delegated":true,"result_rev":2,"report_id":"q3n8v5c2z0","report_kind":"result","delivery":"no_channel","report_verdict":"Auto mode denied writing the checkout test file; nothing changed","report_decisions":[],"conversation":null,"card_chat_id":null,"card_message_id":null,"waiting_on":null}}
JSON
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
