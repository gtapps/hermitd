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
mkdir -p ".hermit/guides"
cp "$here/../../../skills/task/learn.md" ".hermit/guides/learn.md"
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Runs a small online tea shop alone. Prefers short messages.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261019-090000.md' <<'HERMIT_FIXTURE'
---
id: T-20261019-090000
type: task
title: "Add the autumn teas to the shop page"
created: 2026-10-19T09:00:00.000Z
summary: "The autumn teas are live on the shop page"
audience: operator
status: closed
opened_at: 2026-10-19T09:00:00.000Z
requester: operator
handle: add-the-autumn-teas-to-the-shop-
owner: resident
closed_at: 2026-10-19T11:00:00.000Z
closed_by: confirmed
closed_actor: operator
closed_reason: "PR #42 merged."
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
dedupe_key: helper:PROP-044
check: null
skill_review: pending
last_worker: null
muted: false
delegated: true
tags: ["task","operator"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-19T09:00:00.000Z operator: Opened: The autumn teas are live on the shop page
- 2026-10-19T10:00:00.000Z hermit: [guest:shop-page] Added the nine autumn teas and opened PR #42.

## Decisions

## Approvals

## Lessons

## Outcome
- 2026-10-19T11:00:00.000Z operator: PR #42 merged.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
