#!/usr/bin/env bash
# Seeds a resident hermit state dir for this case (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state
cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{
  "operator_profile": "technical",
  "channels": {
    "discord": {
      "allowed_users": [
        "100000000000000001",
        "100000000000000002"
      ],
      "default_chat_id": "400000000000000001"
    }
  },
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-090000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-090000
type: task
title: "Archive old helper reports"
created: 2026-10-01T09:00:00.000Z
summary: "Archive old helper reports"
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
conversation: discord:400000000000000001
card_chat_id: null
card_message_id: null
waiting_on: admin
waiting_since: 2026-10-01T09:00:00.000Z
result: null
result_at: null
stall_at: null
stall_status: null
stall_next: null
dedupe_key: proposal:T-20261001-090000
check: null
last_worker: null
kind: proposal
decision: "{\"purpose\":\"consent\",\"authority\":\"admin\",\"generation\":1}"
approved_rev: null
approved_by: null
source: null
category: null
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
Archive old helper reports
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
# Answer boundary stand-in; no other script is mocked.
if [ "$1" = task ] && [ "$2" = answer ]; then
cat <<'ANSWER'
{"status":"refused","reason":"not_decider"}
ANSWER
else
  echo '{"status":"ok"}'
fi
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
