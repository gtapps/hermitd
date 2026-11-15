#!/usr/bin/env bash
set -e
mkdir -p .hermit/state .claude.local/channels/team
cat > .hermit/channel-guide.md <<'GUIDE'
The packaged plugin is team-channel from acme/team-tools, registered marketplace team-tools, server key team. It declares claude/channel. Notifications carry chat_id, message_id and user_id with display name user, and its reply tool accepts chat_id. Inbound senders are gated by an external admission service. That service's current policy cannot be read in this session. It reads credentials from TEAM_STATE_DIR/.env at runtime. Its own credential skill asks the operator to create that file privately. No send command or permission-relay capability is documented. Do not infer either capability from the reply tool.
GUIDE
cat > .hermit/config.json <<'CONFIG'
{}
CONFIG
