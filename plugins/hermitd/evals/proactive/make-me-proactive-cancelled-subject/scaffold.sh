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
      "operators": [
        "100000000000000001"
      ],
      "allowed_users": [
        "100000000000000001"
      ],
      "default_chat_id": "400000000000000001"
    }
  },
  "routines": [
    {
      "id": "hermitd:make-me-proactive",
      "skill": "hermitd:make-me-proactive",
      "schedule": "0 9 * * *",
      "enabled": true
    }
  ],
  "monitors": [],
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit"
cat > '.hermit/HEARTBEAT.md' <<'HERMIT_FIXTURE'
# Standing checks
HERMIT_FIXTURE
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
echo OK
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/proposal-digest.json' <<'HERMIT_FIXTURE'
{"total":1,"omitted":0,"proposals":[{"id":"T-20261001-090000","handle":"t-20261001-090000","title":"Watch supplier price","source":"auto-detected","category":"improvement","tags":"[\"make-me-proactive\"]","status":"closed","closed_by":"cancelled","reason":"Consent declined: no","summary":"Watch supplier price","proposal":"## Progress\n\n## Decisions\n\n## Approvals\n\n## Lessons\n\n## Outcome\n\n## Proposal\n\n## Context\nThe operator checks the supplier page by hand every morning to decide when to buy.\n\n## Proposed Solution\nkind: watch\nowner: hermitd:watch\nwhat: Check the supplier case price with bash tools/supplier-price (watch id supplier-price).\nwhen: Every six hours.\nends: Ask whether to stop when the case price falls below €50.\nmessage_when: The case price falls below €50; alerts may arrive at any hour.\nchat: The home Discord chat.\nApply with `/hermitd:make-me-proactive apply T-20261001-090000`.\n\n## References\nproject_supplier_price.md\n\n## Verification\nThe watch id is in .hermit/config.json.\n"}]}
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-090000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-090000
type: task
title: "Watch supplier price"
created: 2026-10-01T09:00:00.000Z
summary: "Watch supplier price"
audience: operator
status: closed
opened_at: 2026-10-01T09:00:00.000Z
requester: agent
handle: t-20261001-090000
owner: resident
closed_at: 2026-10-01T09:05:00.000Z
closed_by: cancelled
closed_actor: 100000000000000001
closed_reason: "Consent declined: no"
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
dedupe_key: proactive:supplier-price
check: null
last_worker: null
kind: proposal
decision: "{\"purpose\":\"consent\",\"authority\":\"admin\",\"generation\":1,\"resume\":\"/hermitd:make-me-proactive apply\"}"
approved_rev: null
approved_by: null
source: auto-detected
category: improvement
report_id: null
report_kind: null
delivery: null
muted: false
delegated: false
tags: "[\"make-me-proactive\"]"
claims: []
result_rev: 0
---
## Progress

## Decisions

## Approvals

## Lessons

## Outcome

## Proposal

## Context
The operator checks the supplier page by hand every morning to decide when to buy.

## Proposed Solution
kind: watch
owner: hermitd:watch
what: Check the supplier case price with bash tools/supplier-price (watch id supplier-price).
when: Every six hours.
ends: Ask whether to stop when the case price falls below €50.
message_when: The case price falls below €50; alerts may arrive at any hour.
chat: The home Discord chat.
Apply with `/hermitd:make-me-proactive apply T-20261001-090000`.

## References
project_supplier_price.md

## Verification
The watch id is in .hermit/config.json.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
- [Supplier price](project_supplier_price.md) — Manual supplier price check before wholesale orders
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/project_supplier_price.md' <<'HERMIT_FIXTURE'
---
name: supplier-price
description: Manual supplier case price check
type: project
---

The operator runs bash tools/supplier-price every morning before ordering wholesale tea, and orders when the case price falls below €50. The command prints the current price and exits nonzero when it cannot read it.
HERMIT_FIXTURE
mkdir -p "tools"
cat > 'tools/supplier-price' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
printf "52.00\n"
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
