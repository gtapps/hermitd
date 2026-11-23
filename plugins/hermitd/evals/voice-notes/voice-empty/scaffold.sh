#!/usr/bin/env bash
set -e
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../seed.sh" '{"status":"empty","path":".claude.local/channels/discord/inbox/1763636400000-voice-message.ogg"}'
