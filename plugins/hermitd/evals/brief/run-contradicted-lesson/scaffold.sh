#!/usr/bin/env bash
# Seeds the shared busy install plus this case's changes (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../_seed/busy.sh"
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100000
type: task
title: "Update the supplier price list"
created: 2026-10-20T09:00:00.000Z
summary: "Update the supplier price list from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-0
owner: resident
closed_at: __TODAY__T00:10:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The price list import worked on the new spreadsheet, every row imported and verified."
result_at: 2026-10-21T10:00:00.000Z
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
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-20T11:00:00.000Z: The price list import does not work on the new spreadsheet.
- 2026-10-20T11:00:00.000Z: The supplier price list takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-21T11:00:00.000Z: The supplier price list takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-22T11:00:00.000Z: The supplier price list takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-20T12:00:00.000Z hermit: Kept the existing structure of the supplier price list because the operator reads it on a phone and a new layout would not fit.
- 2026-10-21T12:00:00.000Z hermit: Kept the existing structure of the supplier price list because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
sed -i "s/__TODAY__/$(date -u +%F)/g" .hermit/tasks/*.md
