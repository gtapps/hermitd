#!/usr/bin/env bash
# Seeds the shared busy install plus this case's changes (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../_seed/busy.sh"
mkdir -p ".hermit"
cat > '.hermit/config.json' <<'HERMIT_FIXTURE'
{
  "agent_name": "assistant",
  "timezone": "UTC",
  "always_on": true,
  "channels": {
    "discord": {
      "default_chat_id": "100000000000000001"
    }
  },
  "routines": [
    {
      "id": "group-morning",
      "chat": "discord:group-brief",
      "skill": "hermitd:brief --morning"
    }
  ]
}
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-001.md' <<'HERMIT_FIXTURE'
---
status: proposed
source: auto-detected
title: Agent-wide proposal
---
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/channel-chats.json' <<'HERMIT_FIXTURE'
{"discord":{"chats":{"group-brief":{"type":0,"parent_id":null,"guild_id":"shop","fetched_at":"2026-11-06T00:00:00Z"}}}}
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100011.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100011
type: task
title: "Update the loyalty discounts"
created: 2026-10-20T09:00:00.000Z
summary: "Update the loyalty discounts from the current sources"
audience: discord:group-brief
status: open
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:group-brief
handle: update-11
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:group-brief
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: null
result_at: null
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
- 2026-10-23T11:00:00.000Z: The loyalty discounts takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-24T11:00:00.000Z: The loyalty discounts takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-25T11:00:00.000Z: The loyalty discounts takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-23T12:00:00.000Z hermit: Kept the existing structure of the loyalty discounts because the operator reads it on a phone and a new layout would not fit.
- 2026-10-24T12:00:00.000Z hermit: Kept the existing structure of the loyalty discounts because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
sed -i "s/__TODAY__/$(date -u +%F)/g" .hermit/tasks/*.md
