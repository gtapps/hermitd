#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../settings-model-change/scaffold.sh"
mkdir -p .claude.local/channels/discord
printf '%s\n' '{"allowFrom":["100000000000000001"]}' > .claude.local/channels/discord/access.json
