#!/usr/bin/env bash
# Seeds the shared busy install plus this case's changes (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../_seed/busy.sh"
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100010.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100010
type: task
title: "Update the storefront photos"
created: __TODAY__T00:05:00.000Z
summary: "Update the storefront photos from the current sources"
audience: discord:100000000000000001
status: open
opened_at: __TODAY__T00:05:00.000Z
requester: discord:100000000000000001
handle: update-10
owner: helper:photos
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "Storefront photos done: two draft pull requests open, not merged or deployed\n\nEach photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. Each photo was resized, compressed and checked on a phone screen. "
result_at: __TODAY__T00:30:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- __TODAY__T00:05:00.000Z hermit: Opened

## Lessons

## Decisions
- 2026-10-22T12:00:00.000Z hermit: Kept the existing structure of the storefront photos because the operator reads it on a phone and a new layout would not fit.
- 2026-10-23T12:00:00.000Z hermit: Kept the existing structure of the storefront photos because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
sed -i "s/__TODAY__/$(date -u +%F)/g" .hermit/tasks/*.md
