#!/usr/bin/env bash
set -e
mkdir -p .hermit/state .claude.local/channels/telegram
cat > .hermit/config.json <<'CONFIG'
{"approvals":"team","channels":{"telegram":{"enabled":true,"state_dir":".claude.local/channels/telegram","bot_username":"PairFixtureBot"}}}
CONFIG
cat > .hermit/chrome-context.md <<'FIXTURE'
Tabs context succeeds and shows Telegram Web.
The signed-in account is Riley Example (@riley_fixture).
FIXTURE
cat > .hermit/chrome-bot-chat.md <<'FIXTURE'
The bot chat is @PairFixtureBot. There is no code in the chat yet.
FIXTURE
cat > .hermit/chrome-bot-reply.md <<'FIXTURE'
After the simulated DM to @PairFixtureBot, its reply in that chat gives code A7B8C9.
FIXTURE
cat > .claude.local/channels/telegram/access.json <<ACCESS
{"dmPolicy":"pairing","allowFrom":[],"groups":{},"pending":{"A7B8C9":{"senderId":"12345","chatId":"12345","expiresAt":$(($(date +%s) * 1000 + 300000))}}}
ACCESS
