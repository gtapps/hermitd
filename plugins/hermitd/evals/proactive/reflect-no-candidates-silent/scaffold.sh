#!/usr/bin/env bash
# Seeds a resident hermit state dir for this case (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state
cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{
  "agent_name": "assistant",
  "timezone": "Europe/Lisbon",
  "channels": {
    "discord": {
      "enabled": true,
      "allowed_users": [
        "100000000000000001"
      ],
      "default_chat_id": "400000000000000001"
    }
  },
  "routines": [
    {
      "id": "hermitd:reflect",
      "skill": "hermitd:reflect",
      "schedule": "0 9 * * *",
      "enabled": true
    }
  ],
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
echo OK
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/proposal-metrics.jsonl' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-070000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-070000
type: task
title: "Export the order list"
created: 2026-10-01T07:00:00.000Z
summary: "Requested work complete"
audience: operator
status: closed
opened_at: 2026-10-01T07:00:00.000Z
requester: operator
handle: export-the-order-list
owner: resident
closed_at: 2026-10-01T07:00:00.000Z
closed_by: confirmed
closed_actor: operator
closed_reason: "Completed and verified."
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: null
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
kind: null
decision: null
approved_rev: null
approved_by: null
source: null
category: null
muted: false
delegated: false
tags: ["task","operator"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-01T07:00:00.000Z operator: Opened: Requested work complete

## Decisions

## Approvals

## Lessons

## Outcome
- 2026-10-01T07:00:00.000Z operator: Completed and verified.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-080000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-080000
type: task
title: "Update opening hours"
created: 2026-10-01T08:00:00.000Z
summary: "Requested work complete"
audience: operator
status: closed
opened_at: 2026-10-01T08:00:00.000Z
requester: operator
handle: update-opening-hours
owner: resident
closed_at: 2026-10-01T08:00:00.000Z
closed_by: confirmed
closed_actor: operator
closed_reason: "Completed and verified."
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: null
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
kind: null
decision: null
approved_rev: null
approved_by: null
source: null
category: null
muted: false
delegated: false
tags: ["task","operator"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-01T08:00:00.000Z operator: Opened: Requested work complete

## Decisions

## Approvals

## Lessons

## Outcome
- 2026-10-01T08:00:00.000Z operator: Completed and verified.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-090000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-090000
type: task
title: "Check the delivery receipt"
created: 2026-10-01T09:00:00.000Z
summary: "Requested work complete"
audience: operator
status: closed
opened_at: 2026-10-01T09:00:00.000Z
requester: operator
handle: check-the-delivery-receipt
owner: resident
closed_at: 2026-10-01T09:00:00.000Z
closed_by: confirmed
closed_actor: operator
closed_reason: "Completed and verified."
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: null
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
kind: null
decision: null
approved_rev: null
approved_by: null
source: null
category: null
muted: false
delegated: false
tags: ["task","operator"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-01T09:00:00.000Z operator: Opened: Requested work complete

## Decisions

## Approvals

## Lessons

## Outcome
- 2026-10-01T09:00:00.000Z operator: Completed and verified.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
