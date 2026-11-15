#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin="$(cd "$here/../../.." && pwd)"
mkdir -p .hermit/state .hermit/tasks .claude.local/channels/test
cp "$plugin/state-templates/TASKS.md.template" .hermit/TASKS.md
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$plugin/.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<CONFIG
{"approvals":"team","language":"Portuguese","timezone":"UTC","_hermit_versions":{"hermitd":"$version"},"channels":{"test":{"allowed_users":["ana","admin"],"maintainer_channel_id":"console","state_dir":".claude.local/channels/test"}}}
CONFIG
printf '{"allowFrom":["admin"]}\n' > .claude.local/channels/test/access.json
bun "$plugin/scripts/task.ts" open .hermit --title 'Approval for ana: docker ps' --done 'Answer recorded' --requester agent --dedupe-key docker-ps-members --conversation test:console --waiting-on admin --decision '{"purpose":"input","authority":"chat","generation":1,"resume":"Run exactly docker ps, requested by ana in test:members"}'
