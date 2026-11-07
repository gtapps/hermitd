#!/usr/bin/env bash
# Seeds a hermit state dir and auto-memory for this case (runs only with --scaffold).
set -e
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Runs a small online tea shop alone.

## Preferences
- I decided not to send automated messages to customers without my review.
- Keep answers short.
HERMIT_FIXTURE
mkdir -p ".hermit/compiled"
cat > '.hermit/compiled/topic-wholesale-pipeline.md' <<'HERMIT_FIXTURE'
---
title: Wholesale pipeline
type: topic
created: 2026-09-10T09:00:00+01:00
tags: [wholesale]
---

Four cafes ordering monthly.
HERMIT_FIXTURE
mkdir -p ".hermit"
cat > '.hermit/config.json' <<'HERMIT_FIXTURE'
{
  "agent_name": "assistant",
  "timezone": "Europe/Lisbon"
}
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/proposal-digest.json' <<'HERMIT_FIXTURE'
{"total":4,"omitted":0,"proposals":[{"id":"T-20260814-100021","handle":"decision-t-20260814-100021","status":"open","closed_by":null,"reason":null,"summary":"Remind customers about invoices unpaid after 7 days","proposal":"## Proposal\n\n## Problem\nWholesale invoices go unpaid for weeks because nobody chases them.\n\n## Proposed Solution\nSee title.\n","title":"Remind customers about invoices unpaid after 7 days","source":"auto-detected","category":"improvement","tags":"[]"},{"id":"T-20260814-100024","handle":"decision-t-20260814-100024","status":"closed","closed_by":"cancelled","reason":"dismissed","summary":"Weekly sales summary to the channel","proposal":"## Proposal\n\n## Problem\nNo weekly overview of sales.\n\n## Proposed Solution\nSee title.\n","title":"Weekly sales summary to the channel","source":"auto-detected","category":"improvement","tags":"[]"},{"id":"T-20260814-100026","handle":"decision-t-20260814-100026","status":"closed","closed_by":"check","reason":"resolved","summary":"Back up the shop database nightly","proposal":"## Proposal\n\n## Problem\nThe order database had no backup.\n\n## Proposed Solution\nSee title.\n","title":"Back up the shop database nightly","source":"auto-detected","category":"improvement","tags":"[]"},{"id":"T-20260814-100028","handle":"decision-t-20260814-100028","status":"open","closed_by":null,"reason":null,"summary":"Reorder alert when stock falls below 5 units","proposal":"## Proposal\n\n## Problem\nPopular teas sold out before anyone noticed.\n\n## Proposed Solution\nSee title.\n","title":"Reorder alert when stock falls below 5 units","source":"auto-detected","category":"improvement","tags":"[]"}]}
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100021.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100021
type: task
title: "Remind customers about invoices unpaid after 7 days"
created: 2026-08-14T10:00:00+01:00
summary: "Remind customers about invoices unpaid after 7 days"
audience: operator
status: open
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100021
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
dedupe_key: proposal:T-20260814-100021
check: null
last_worker: null
kind: proposal
decision: "{\"purpose\":\"consent\",\"authority\":\"admin\",\"generation\":1}"
approved_rev: null
approved_by: null
source: auto-detected
category: improvement
muted: false
delegated: false
tags: "[]"
claims: []
result_rev: 0
---
## Proposal

## Problem
Wholesale invoices go unpaid for weeks because nobody chases them.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100024.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100024
type: task
title: "Weekly sales summary to the channel"
created: 2026-08-14T10:00:00+01:00
summary: "Weekly sales summary to the channel"
audience: operator
status: closed
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100024
owner: resident
closed_at: 2026-08-14T10:00:00+01:00
closed_by: cancelled
closed_actor: hermit
closed_reason: dismissed
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
dedupe_key: proposal:T-20260814-100024
check: null
last_worker: null
kind: proposal
decision: null
approved_rev: null
approved_by: null
source: auto-detected
category: improvement
muted: false
delegated: false
tags: "[]"
claims: []
result_rev: 0
---
## Proposal

## Problem
No weekly overview of sales.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100026.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100026
type: task
title: "Back up the shop database nightly"
created: 2026-08-14T10:00:00+01:00
summary: "Back up the shop database nightly"
audience: operator
status: closed
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100026
owner: resident
closed_at: 2026-08-14T10:00:00+01:00
closed_by: check
closed_actor: hermit
closed_reason: resolved
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
dedupe_key: proposal:T-20260814-100026
check: null
last_worker: null
kind: proposal
decision: null
approved_rev: null
approved_by: null
source: auto-detected
category: improvement
muted: false
delegated: false
tags: "[]"
claims: []
result_rev: 0
---
## Proposal

## Problem
The order database had no backup.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100028.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100028
type: task
title: "Reorder alert when stock falls below 5 units"
created: 2026-08-14T10:00:00+01:00
summary: "Reorder alert when stock falls below 5 units"
audience: operator
status: open
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100028
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
waiting_on: null
waiting_since: null
result: null
result_at: null
stall_at: null
stall_status: null
stall_next: null
dedupe_key: proposal:T-20260814-100028
check: null
last_worker: null
kind: proposal
decision: null
approved_rev: 0
approved_by: operator
source: auto-detected
category: improvement
muted: false
delegated: false
tags: "[]"
claims: []
result_rev: 0
---
## Proposal

## Problem
Popular teas sold out before anyone noticed.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
- [no-social-posting](feedback_no_social_posting.md) — Do not propose posting to social media on my behalf
- [q4-priorities](project_q4_priorities.md) — Q4 focus is wholesale orders; the website redesign is postponed to next year
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/feedback_no_social_posting.md' <<'HERMIT_FIXTURE'
---
name: no-social-posting
description: Do not propose posting to social media on my behalf
type: feedback
---

Don't propose posting to social media for me.
**Why:** I want my own voice there.
**How to apply:** suppress social-posting ideas.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/project_q4_priorities.md' <<'HERMIT_FIXTURE'
---
name: q4-priorities
description: Q4 focus is wholesale orders; the website redesign is postponed to next year
metadata:
  type: project
---

Q4 2026: focus on wholesale orders. The website and homepage redesign is postponed until 2027.
**Why:** cash flow.
**How to apply:** no redesign work this quarter.
HERMIT_FIXTURE
