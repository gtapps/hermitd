#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../settings-model-change/scaffold.sh"
sed -i 's/"allowed_users":\["100000000000000001"\]/"allowed_users":["100000000000000001","100000000000000002"]/' .hermit/config.json
mkdir -p .claude.local/channels/discord
printf '%s\n' '{"allowFrom":["100000000000000001"]}' > .claude.local/channels/discord/access.json
