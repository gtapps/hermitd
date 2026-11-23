#!/usr/bin/env bash
set -e
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../seed.sh" '{"status":"ok","transcript":"What time is it in Tokyo when it is nine in the morning here in Lisbon?","provider":"local","recorded":true,"echo":"sent"}'
