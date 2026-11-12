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
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
# hermitd-run stand-in: what the real task.ts printed at generation time, per verb and record id.
verb="$2"; id=""
for a in "$@"; do case "$a" in T-*) id="$a";; esac; done
[ "$1" = task ] || { echo OK; exit 0; }
case "$verb${id:+ $id}" in
  'list') cat <<'OUT'
{"rows":[{"id":"T-20261021-090000","handle":"renew-domain","kind":null,"decision":null,"approved_rev":null,"approved_by":null,"source":null,"category":null,"tags":["task","discord:100000000000000001"],"listing":["open"],"requester":"discord:100000000000000001","title":"Renew domain","due":null,"result_rev":0,"owner":"worker:a1b2c3d4","last_worker":null,"delegated":true,"result":null,"result_len":0,"waiting_on":null,"closed_by":null,"check":null,"conversation":"discord:400000000000000001","card_chat_id":null,"card_message_id":null},{"id":"T-20261021-090000-0","handle":"review-invoice","kind":null,"decision":null,"approved_rev":null,"approved_by":null,"source":null,"category":null,"tags":["task","discord:100000000000000001"],"listing":["open"],"requester":"discord:100000000000000001","title":"Review invoice","due":null,"result_rev":0,"owner":"worker:b1b2c3d4","last_worker":null,"delegated":true,"result":null,"result_len":0,"waiting_on":null,"closed_by":null,"check":null,"conversation":"discord:400000000000000001","card_chat_id":null,"card_message_id":null}],"total":2,"omitted":0}
OUT
  ;;
  'note T-20261021-090000-0') cat <<'OUT'
{"id":"T-20261021-090000-0","result_rev":1}
OUT
  ;;
  'note T-20261021-090000') cat <<'OUT'
{"id":"T-20261021-090000","result_rev":1}
OUT
  ;;
  'answer T-20261021-090000') cat <<'OUT'
{"status":"none","reason":"no_pending"}
OUT
  ;;
  'answer T-20261021-090000-0') cat <<'OUT'
{"status":"none","reason":"no_pending"}
OUT
  ;;
  'answer') cat <<'OUT'
{"status":"none","reason":"no_pending"}
OUT
  ;;
  'close T-20261021-090000') cat <<'OUT'
{"id":"T-20261021-090000","closed_by":"confirmed","result_rev":1,"next_queued":null,"next":"before the close reply, read .hermit/guides/learn.md"}
OUT
  ;;
  'close T-20261021-090000-0') cat <<'OUT'
{"id":"T-20261021-090000-0","closed_by":"confirmed","result_rev":1,"next_queued":null,"next":"before the close reply, read .hermit/guides/learn.md"}
OUT
  ;;
  *) echo OK ;;
esac
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
owner: resident
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
waiting_on: discord:100000000000000001
waiting_since: 2026-10-01T13:30:00.000Z
result: "The invoice discrepancy review is ready for approval.\n"
result_at: 2026-10-01T13:30:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
last_worker: b1b2c3d4
kind: null
decision: null
approved_rev: null
approved_by: null
source: null
category: null
muted: false
delegated: true
tags: ["task","discord:100000000000000001"]
claims: []
result_rev: 1
---
## Progress
- 2026-10-21T09:00:00.000Z discord:100000000000000001: Opened: Recommendation approved

## Decisions

## Approvals

## Lessons

## Outcome
- 2026-10-01T13:30:00.000Z hermit: The invoice discrepancy review is ready for approval.
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
owner: resident
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
waiting_on: discord:100000000000000001
waiting_since: 2026-10-01T13:30:00.000Z
result: "The domain renewal comparison is ready for approval.\n"
result_at: 2026-10-01T13:30:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
last_worker: a1b2c3d4
kind: null
decision: null
approved_rev: null
approved_by: null
source: null
category: null
muted: false
delegated: true
tags: ["task","discord:100000000000000001"]
claims: []
result_rev: 1
---
## Progress
- 2026-10-21T09:00:00.000Z discord:100000000000000001: Opened: Recommendation approved

## Decisions

## Approvals

## Lessons

## Outcome
- 2026-10-01T13:30:00.000Z hermit: The domain renewal comparison is ready for approval.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
