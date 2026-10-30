#!/usr/bin/env bash
# Seeds the shared busy install plus this case's changes (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../_seed/busy.sh"
sed -i "s/__TODAY__/$(date -u +%F)/g" .hermit/tasks/*.md
