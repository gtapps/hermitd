#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin="$(cd "$here/../../.." && pwd)"
mkdir -p .hermit/state .hermit/tasks .claude.local/channels/discord
cp "$plugin/state-templates/TASKS.md.template" .hermit/TASKS.md
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$plugin/.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<CONFIG
{"approvals":"team","language":"Portuguese","timezone":"UTC","_hermit_versions":{"hermitd":"$version"},"channels":{"discord":{"allowed_users":["100000000000000002","100000000000000001"],"maintainer_channel_id":"700000000000000009","state_dir":".claude.local/channels/discord"}}}
CONFIG
printf '{"allowFrom":["100000000000000001"]}\n' > .claude.local/channels/discord/access.json
bun "$plugin/scripts/task.ts" open .hermit --title 'Approval for ana: docker ps' --done 'Answer recorded' --requester agent --dedupe-key docker-ps-members --conversation discord:700000000000000009 --waiting-on admin --decision '{"purpose":"input","authority":"chat","generation":1,"resume":"Run exactly docker ps, requested by ana in discord:700000000000000008"}'
