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
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-090000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-090000
type: task
title: "Watch supplier price"
created: 2026-10-01T09:00:00.000Z
summary: "Watch supplier price"
audience: operator
status: open
opened_at: 2026-10-01T09:00:00.000Z
requester: agent
handle: t-20261001-090000
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: null
card_chat_id: null
card_message_id: null
waiting_on: admin
waiting_since: 2026-10-01T09:00:00.000Z
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
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-090001.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-090001
type: task
title: "Watch packing material stock"
created: 2026-10-01T09:00:00.000Z
summary: "Watch packing material stock"
audience: operator
status: open
opened_at: 2026-10-01T09:00:00.000Z
requester: agent
handle: t-20261001-090001
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: null
card_chat_id: null
card_message_id: null
waiting_on: admin
waiting_since: 2026-10-01T09:00:00.000Z
result: null
result_at: null
stall_at: null
stall_status: null
stall_next: null
dedupe_key: proactive:packing-material-stock
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
Watch packing material stock.
Apply with `/hermitd:make-me-proactive apply T-20261001-090001`.

## References
project_supplier_price.md

## Verification
The watch id is in .hermit/config.json.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-090002.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-090002
type: task
title: "Check whether the offsite backup finishes"
created: 2026-10-01T09:00:00.000Z
summary: "Check whether the offsite backup finishes"
audience: operator
status: open
opened_at: 2026-10-01T09:00:00.000Z
requester: agent
handle: t-20261001-090002
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: null
card_chat_id: null
card_message_id: null
waiting_on: admin
waiting_since: 2026-10-01T09:00:00.000Z
result: null
result_at: null
stall_at: null
stall_status: null
stall_next: null
dedupe_key: proactive:offsite-backup
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
Check whether the offsite backup finishes.
Apply with `/hermitd:make-me-proactive apply T-20261001-090002`.

## References
project_supplier_price.md

## Verification
The watch id is in .hermit/config.json.
HERMIT_FIXTURE
mkdir -p "eval-stand-ins"
cat > 'eval-stand-ins/task-answer-without-id.json' <<'HERMIT_FIXTURE'
{"status":"ambiguous","reason":"multiple_pending","choices":[{"id":"T-20261001-090000","title":"Watch supplier price","options":["yes","no"]},{"id":"T-20261001-090001","title":"Watch packing material stock","options":["yes","no"]},{"id":"T-20261001-090002","title":"Check whether the offsite backup finishes","options":["yes","no"]}]}
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
