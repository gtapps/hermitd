#!/usr/bin/env bash
set -e
mkdir -p .hermit/state
cat > .hermit/config.json <<'CONFIG'
{"chrome":false,"browser":{"enabled":false},"channels":{"discord":{"enabled":true,"state_dir":".claude.local/channels/discord"}}}
CONFIG
cat > .hermit/channel-guide.md <<'GUIDE'
Discord Developer Portal: create an application, open Bot, enable Message Content Intent, then reset and copy the bot token. Keep it private. The Discord channel reads DISCORD_BOT_TOKEN from its configured state directory's .env.
GUIDE
