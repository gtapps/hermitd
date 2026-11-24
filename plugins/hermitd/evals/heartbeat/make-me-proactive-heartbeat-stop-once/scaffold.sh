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
  "escalation": "balanced",
  "heartbeat": {
    "active_hours": {
      "start": "08:00",
      "end": "22:00"
    }
  },
  "channels": {
    "discord": {
      "enabled": true,
      "allowed_users": [
        "100000000000000001"
      ],
      "default_chat_id": "400000000000000001"
    }
  },
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit"
cat > '.hermit/HEARTBEAT.md' <<'HERMIT_FIXTURE'
# Heartbeat Checklist
<!-- End each item with [ask] (default), [act], or [note] to set its trust policy; keep the token trailing so its item key stays stable. -->
<!-- Keep under 10 items. Move periodic checks to routines (/hermit-settings routines). -->

## Standing Checks

- Read `state/doctor-report.json` → the `credential-expiry` check; if its status is warn or fail, tell the operator which credential needs re-auth and name the plugin's reauth skill from the report detail.

## Project Checks
- Check the offsite backup during check-ins until the migration finishes [note]
- Check the carrier page until the tea order has arrived [note]
HERMIT_FIXTURE
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Prefers short messages.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-080000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-080000
type: task
title: "Stop checking the carrier page?"
created: 2026-10-01T09:00:00.000Z
summary: "Stop checking the carrier page?"
audience: operator
status: closed
opened_at: 2026-10-01T09:00:00.000Z
requester: agent
handle: t-20261001-080000
owner: resident
closed_at: 2026-10-01T08:11:00.000Z
closed_by: confirmed
closed_actor: 100000000000000001
closed_reason: "Keep checking"
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
dedupe_key: heartbeat-stop:checklist:checkthecarrierpageuntiltheteaor-3f5785ba
check: null
last_worker: null
kind: null
decision: "{\"purpose\":\"input\",\"authority\":\"admin\",\"generation\":1,\"resume\":\"/hermitd:heartbeat edit --remove checklist:checkthecarrierpageuntiltheteaor-3f5785ba --answer {answer}\"}"
approved_rev: null
approved_by: null
source: null
category: null
report_id: null
report_kind: null
delivery: null
muted: false
delegated: false
tags: null
claims: []
result_rev: 0
---
## Progress

## Decisions

## Approvals

## Lessons

## Outcome

## Proposal
Stop checking the carrier page?
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
