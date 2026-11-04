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
      "allowed_users": [
        "100000000000000001"
      ]
    }
  },
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Runs a small online tea shop alone. Prefers short messages.
HERMIT_FIXTURE
mkdir -p ".hermit/helper-reports"
cat > '.hermit/helper-reports/domain12.md' <<'HERMIT_FIXTURE'
The domain renewal comparison is ready for approval.
HERMIT_FIXTURE
mkdir -p ".hermit/helper-reports"
cat > '.hermit/helper-reports/invoice12.md' <<'HERMIT_FIXTURE'
The invoice discrepancy review is ready for approval.
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/channel-chats.json' <<'HERMIT_FIXTURE'
{"discord":{"chats":{"400000000000000001":{"type":1}}}}
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261021-090000-0.md' <<'HERMIT_FIXTURE'
---
id: T-20261021-090000-0
type: task
title: "Review invoice"
created: 2026-10-21T09:00:00.000Z
summary: "Recommendation approved"
audience: discord:400000000000000001
status: open
opened_at: 2026-10-21T09:00:00.000Z
requester: discord:100000000000000001
handle: review-invoice
owner: worker:b1b2c3d4
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:400000000000000001
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
delegated: true
tags: ["task","discord:100000000000000001"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-21T09:00:00.000Z discord:100000000000000001: Opened: Recommendation approved

## Decisions

## Approvals

## Lessons

## Outcome
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261021-090000.md' <<'HERMIT_FIXTURE'
---
id: T-20261021-090000
type: task
title: "Renew domain"
created: 2026-10-21T09:00:00.000Z
summary: "Recommendation approved"
audience: discord:400000000000000001
status: open
opened_at: 2026-10-21T09:00:00.000Z
requester: discord:100000000000000001
handle: renew-domain
owner: worker:a1b2c3d4
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:400000000000000001
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
delegated: true
tags: ["task","discord:100000000000000001"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-21T09:00:00.000Z discord:100000000000000001: Opened: Recommendation approved

## Decisions

## Approvals

## Lessons

## Outcome
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
