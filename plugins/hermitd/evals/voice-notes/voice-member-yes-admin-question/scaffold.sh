#!/usr/bin/env bash
# Reuses the pending admin-only decision from channel-routing, then adds the voice note and the stub.
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../../channel-routing/micro-member-yes-admin-question/scaffold.sh"
exec bash "$here/../seed.sh" '{"status":"ok","transcript":"yes","provider":"nemo-speech","recorded":true,"echo":"sent"}'
