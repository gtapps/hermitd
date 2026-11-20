#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../settings-model-change/scaffold.sh"
sed -i 's/"channels":{"discord":{"allowed_users":\["100000000000000001"\]}}/"approvals":"team","channels":{"discord":{"maintainer_channel_id":"400000000000000001","operators":["100000000000000001"]}}/' .hermit/config.json
mkdir -p .claude.local/channels/discord
cat > .claude.local/channels/discord/access.json <<'ACCESS'
{"dmPolicy":"allowlist","allowFrom":["100000000000000001"],"groups":{"400000000000000002":{"requireMention":true,"allowFrom":["100000000000000001"]},"400000000000000003":{"requireMention":false,"allowFrom":[]}},"pending":{}}
ACCESS
