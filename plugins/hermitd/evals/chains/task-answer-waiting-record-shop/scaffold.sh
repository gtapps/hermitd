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
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261019-090000.md' <<'HERMIT_FIXTURE'
---
id: T-20261019-090000
type: task
title: "Reprice the autumn tea range"
created: 2026-10-19T09:00:00.000Z
summary: "Every autumn tea repriced against the current supplier list"
audience: discord:700000000000000002
status: open
opened_at: 2026-10-19T09:00:00.000Z
requester: discord:100000000000000001
handle: reprice-the-autumn-tea-range
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:700000000000000002
card_chat_id: null
card_message_id: null
waiting_on: discord:100000000000000001
waiting_since: 2026-10-19T10:00:00.000Z
result: null
result_at: null
stall_at: 2026-10-19T10:00:00.000Z
stall_status: "Compared 6 of 9 teas against the September list"
stall_next: "Which supplier price list should I use, the September or the October one?"
dedupe_key: null
check: null
last_worker: a1b2c3d4e5f6a7b8c
muted: false
delegated: true
tags: ["task","discord:100000000000000001"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-19T09:00:00.000Z discord:100000000000000001: Opened: Every autumn tea repriced against the current supplier list
- 2026-10-19T10:00:00.000Z hermit: Compared 6 of 9 teas against the September list; next: Which supplier price list should I use, the September or the October one?

## Decisions

## Approvals

## Lessons

## Outcome
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
