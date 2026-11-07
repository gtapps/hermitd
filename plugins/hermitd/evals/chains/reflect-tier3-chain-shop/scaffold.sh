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
mkdir -p ".hermit/state"
cat > '.hermit/state/proposal-digest.json' <<'HERMIT_FIXTURE'
{"total":4,"omitted":0,"proposals":[{"id":"T-20260814-100021","handle":"decision-t-20260814-100021","status":"open","closed_by":null,"reason":null,"summary":"Remind customers about invoices unpaid after 7 days","proposal":"## Proposal\n\n## Problem\nWholesale invoices go unpaid for weeks because nobody chases them.\n\n## Proposed Solution\nSee title.\n","title":"Remind customers about invoices unpaid after 7 days","source":"auto-detected","category":"improvement","tags":"[]"},{"id":"T-20260814-100024","handle":"decision-t-20260814-100024","status":"closed","closed_by":"cancelled","reason":"dismissed","summary":"Weekly sales summary to the channel","proposal":"## Proposal\n\n## Problem\nNo weekly overview of sales.\n\n## Proposed Solution\nSee title.\n","title":"Weekly sales summary to the channel","source":"auto-detected","category":"improvement","tags":"[]"},{"id":"T-20260814-100026","handle":"decision-t-20260814-100026","status":"closed","closed_by":"check","reason":"resolved","summary":"Back up the shop database nightly","proposal":"## Proposal\n\n## Problem\nThe order database had no backup.\n\n## Proposed Solution\nSee title.\n","title":"Back up the shop database nightly","source":"auto-detected","category":"improvement","tags":"[]"},{"id":"T-20260814-100028","handle":"decision-t-20260814-100028","status":"open","closed_by":null,"reason":null,"summary":"Reorder alert when stock falls below 5 units","proposal":"## Proposal\n\n## Problem\nPopular teas sold out before anyone noticed.\n\n## Proposed Solution\nSee title.\n","title":"Reorder alert when stock falls below 5 units","source":"auto-detected","category":"improvement","tags":"[]"}]}
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
