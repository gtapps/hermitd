#!/usr/bin/env bash
set -e
mkdir -p .hermit/state .claude.local/channels/telegram
printf '%s\n' '{"always_on":true,"channels":{"telegram":{"enabled":true,"state_dir":".claude.local/channels/telegram"}}}' > .hermit/config.json
printf '%s\n' 'TELEGRAM_BOT_TOKEN=eval-placeholder' > .claude.local/channels/telegram/.env
chmod 600 .claude.local/channels/telegram/.env
