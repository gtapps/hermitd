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
        "100000000000000001"
      ]
    }
  },
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit/guides"
cp "$here/../../../prompts/helper.md" ".hermit/guides/helper.md"
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Runs a small online tea shop alone. Prefers short messages.
HERMIT_FIXTURE
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
[[ "$1" == task && "$2" == report ]] || exit 1
cat >/dev/null
printf '%s\n' '{"report":"abcdef1234","task":"T-20261021-090000","recorded":true,"result_rev":1,"delivery":"sent"}'
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
mkdir -p "."
cat > 'sample.csv' <<'HERMIT_FIXTURE'
sku,name,price,wholesale
T-01,Sencha,12.00,8.40
T-02,Earl Grey,10.00,7.00
HERMIT_FIXTURE
mkdir -p "."
cat > 'source.csv' <<'HERMIT_FIXTURE'
sku,wholesale
T-01,8.40
T-02,7.00
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
