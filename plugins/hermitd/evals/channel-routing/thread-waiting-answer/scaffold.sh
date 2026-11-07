#!/usr/bin/env bash
# Seeds a resident hermit state dir so the real SessionStart hook injects the live task policy (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state .hermit/bin
cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md
# Stamp the loaded plugin version so the hook injects no upgrade notice.
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{"agent_name":"assistant","timezone":"Europe/Lisbon","operator_profile":"technical","language":null,"channels":{"discord":{"allowed_users":["100000000000000001"]}},"_hermit_versions":{"hermitd":"$ver"}}
HERMIT_CONFIG
# Answer boundary stand-in (the case grants Bash; run with --allow-tools Bash).
cat > .hermit/bin/hermitd-run <<'RUNNER'
#!/usr/bin/env bash
echo '{"status":"match","id":"T-20261001-091400","purpose":"input","reply":"ops-reports"}'
RUNNER
chmod +x .hermit/bin/hermitd-run
