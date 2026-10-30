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
  "timezone": "UTC",
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
cat > '.hermit/tasks/T-20261001-100000.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100000
type: task
title: "Update the supplier price list"
created: 2026-10-20T09:00:00.000Z
summary: "Update the supplier price list from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-0
owner: resident
closed_at: __TODAY__T16:10:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The supplier price list is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-20T11:00:00.000Z: The supplier price list takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-21T11:00:00.000Z: The supplier price list takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-22T11:00:00.000Z: The supplier price list takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-20T12:00:00.000Z hermit: Kept the existing structure of the supplier price list because the operator reads it on a phone and a new layout would not fit.
- 2026-10-21T12:00:00.000Z hermit: Kept the existing structure of the supplier price list because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100001.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100001
type: task
title: "Update the autumn tea range"
created: 2026-10-20T09:00:00.000Z
summary: "Update the autumn tea range from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-1
owner: resident
closed_at: __TODAY__T16:11:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The autumn tea range is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-21T11:00:00.000Z: The autumn tea range takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-22T11:00:00.000Z: The autumn tea range takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-23T11:00:00.000Z: The autumn tea range takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-21T12:00:00.000Z hermit: Kept the existing structure of the autumn tea range because the operator reads it on a phone and a new layout would not fit.
- 2026-10-22T12:00:00.000Z hermit: Kept the existing structure of the autumn tea range because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100002.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100002
type: task
title: "Update the gift box stock"
created: 2026-10-20T09:00:00.000Z
summary: "Update the gift box stock from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-2
owner: resident
closed_at: __TODAY__T16:12:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The gift box stock is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-22T11:00:00.000Z: The gift box stock takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-23T11:00:00.000Z: The gift box stock takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-24T11:00:00.000Z: The gift box stock takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-22T12:00:00.000Z hermit: Kept the existing structure of the gift box stock because the operator reads it on a phone and a new layout would not fit.
- 2026-10-23T12:00:00.000Z hermit: Kept the existing structure of the gift box stock because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100003.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100003
type: task
title: "Update the shipping rates"
created: 2026-10-20T09:00:00.000Z
summary: "Update the shipping rates from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-3
owner: resident
closed_at: __TODAY__T16:13:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The shipping rates is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-23T11:00:00.000Z: The shipping rates takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-24T11:00:00.000Z: The shipping rates takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-25T11:00:00.000Z: The shipping rates takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-23T12:00:00.000Z hermit: Kept the existing structure of the shipping rates because the operator reads it on a phone and a new layout would not fit.
- 2026-10-24T12:00:00.000Z hermit: Kept the existing structure of the shipping rates because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100004.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100004
type: task
title: "Update the newsletter draft"
created: 2026-10-20T09:00:00.000Z
summary: "Update the newsletter draft from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-4
owner: resident
closed_at: __TODAY__T16:14:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The newsletter draft is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-24T11:00:00.000Z: The newsletter draft takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-25T11:00:00.000Z: The newsletter draft takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-26T11:00:00.000Z: The newsletter draft takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-24T12:00:00.000Z hermit: Kept the existing structure of the newsletter draft because the operator reads it on a phone and a new layout would not fit.
- 2026-10-25T12:00:00.000Z hermit: Kept the existing structure of the newsletter draft because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100005.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100005
type: task
title: "Update the returns policy"
created: 2026-10-20T09:00:00.000Z
summary: "Update the returns policy from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-5
owner: resident
closed_at: __TODAY__T16:15:00.000Z
closed_by: cancelled
closed_actor: null
closed_reason: "Operator dropped it, the supplier closed"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
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
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-25T11:00:00.000Z: The returns policy takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-26T11:00:00.000Z: The returns policy takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-27T11:00:00.000Z: The returns policy takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-25T12:00:00.000Z hermit: Kept the existing structure of the returns policy because the operator reads it on a phone and a new layout would not fit.
- 2026-10-26T12:00:00.000Z hermit: Kept the existing structure of the returns policy because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100006.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100006
type: task
title: "Update the tasting notes"
created: 2026-10-20T09:00:00.000Z
summary: "Update the tasting notes from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-6
owner: resident
closed_at: __TODAY__T16:16:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The tasting notes is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-26T11:00:00.000Z: The tasting notes takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-27T11:00:00.000Z: The tasting notes takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-20T11:00:00.000Z: The tasting notes takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-26T12:00:00.000Z hermit: Kept the existing structure of the tasting notes because the operator reads it on a phone and a new layout would not fit.
- 2026-10-27T12:00:00.000Z hermit: Kept the existing structure of the tasting notes because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100007.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100007
type: task
title: "Update the wholesale invoices"
created: 2026-10-20T09:00:00.000Z
summary: "Update the wholesale invoices from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-7
owner: resident
closed_at: __TODAY__T16:17:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The wholesale invoices is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-27T11:00:00.000Z: The wholesale invoices takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-20T11:00:00.000Z: The wholesale invoices takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-21T11:00:00.000Z: The wholesale invoices takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-27T12:00:00.000Z hermit: Kept the existing structure of the wholesale invoices because the operator reads it on a phone and a new layout would not fit.
- 2026-10-20T12:00:00.000Z hermit: Kept the existing structure of the wholesale invoices because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100008.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100008
type: task
title: "Update the loose leaf labels"
created: 2026-10-20T09:00:00.000Z
summary: "Update the loose leaf labels from the current sources"
audience: discord:100000000000000001
status: open
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-8
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: discord:100000000000000001
waiting_since: 2026-10-21T10:00:00.000Z
result: null
result_at: null
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-20T11:00:00.000Z: The loose leaf labels takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-21T11:00:00.000Z: The loose leaf labels takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-22T11:00:00.000Z: The loose leaf labels takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-20T12:00:00.000Z hermit: Kept the existing structure of the loose leaf labels because the operator reads it on a phone and a new layout would not fit.
- 2026-10-21T12:00:00.000Z hermit: Kept the existing structure of the loose leaf labels because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100009.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100009
type: task
title: "Update the courier contract"
created: 2026-10-20T09:00:00.000Z
summary: "Update the courier contract from the current sources"
audience: discord:100000000000000001
status: open
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-9
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: discord:100000000000000001
waiting_since: 2026-10-21T10:00:00.000Z
result: null
result_at: null
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-21T11:00:00.000Z: The courier contract takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-22T11:00:00.000Z: The courier contract takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-23T11:00:00.000Z: The courier contract takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-21T12:00:00.000Z hermit: Kept the existing structure of the courier contract because the operator reads it on a phone and a new layout would not fit.
- 2026-10-22T12:00:00.000Z hermit: Kept the existing structure of the courier contract because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100010.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100010
type: task
title: "Update the storefront photos"
created: 2026-10-20T09:00:00.000Z
summary: "Update the storefront photos from the current sources"
audience: discord:100000000000000001
status: open
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-10
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The storefront photos is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-22T11:00:00.000Z: The storefront photos takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-23T11:00:00.000Z: The storefront photos takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-24T11:00:00.000Z: The storefront photos takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-22T12:00:00.000Z hermit: Kept the existing structure of the storefront photos because the operator reads it on a phone and a new layout would not fit.
- 2026-10-23T12:00:00.000Z hermit: Kept the existing structure of the storefront photos because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100011.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100011
type: task
title: "Update the loyalty discounts"
created: 2026-10-20T09:00:00.000Z
summary: "Update the loyalty discounts from the current sources"
audience: discord:100000000000000001
status: open
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-11
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
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
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-23T11:00:00.000Z: The loyalty discounts takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-24T11:00:00.000Z: The loyalty discounts takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-25T11:00:00.000Z: The loyalty discounts takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-23T12:00:00.000Z hermit: Kept the existing structure of the loyalty discounts because the operator reads it on a phone and a new layout would not fit.
- 2026-10-24T12:00:00.000Z hermit: Kept the existing structure of the loyalty discounts because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100012.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100012
type: task
title: "Update the matcha reorder"
created: 2026-10-20T09:00:00.000Z
summary: "Update the matcha reorder from the current sources"
audience: discord:100000000000000001
status: open
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-12
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
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
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-24T11:00:00.000Z: The matcha reorder takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-25T11:00:00.000Z: The matcha reorder takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-26T11:00:00.000Z: The matcha reorder takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-24T12:00:00.000Z hermit: Kept the existing structure of the matcha reorder because the operator reads it on a phone and a new layout would not fit.
- 2026-10-25T12:00:00.000Z hermit: Kept the existing structure of the matcha reorder because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100013.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100013
type: task
title: "Update the tax summary"
created: 2026-10-20T09:00:00.000Z
summary: "Update the tax summary from the current sources"
audience: discord:100000000000000001
status: open
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-13
owner: resident
closed_at: null
closed_by: null
closed_actor: null
closed_reason: null
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
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
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-25T11:00:00.000Z: The tax summary takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-26T11:00:00.000Z: The tax summary takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-27T11:00:00.000Z: The tax summary takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-25T12:00:00.000Z hermit: Kept the existing structure of the tax summary because the operator reads it on a phone and a new layout would not fit.
- 2026-10-26T12:00:00.000Z hermit: Kept the existing structure of the tax summary because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100014.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100014
type: task
title: "Update the packaging samples"
created: 2026-10-20T09:00:00.000Z
summary: "Update the packaging samples from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-14
owner: resident
closed_at: 2026-10-20T16:00:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The packaging samples is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-26T11:00:00.000Z: The packaging samples takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-27T11:00:00.000Z: The packaging samples takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-20T11:00:00.000Z: The packaging samples takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-26T12:00:00.000Z hermit: Kept the existing structure of the packaging samples because the operator reads it on a phone and a new layout would not fit.
- 2026-10-27T12:00:00.000Z hermit: Kept the existing structure of the packaging samples because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100015.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100015
type: task
title: "Update the customer survey"
created: 2026-10-20T09:00:00.000Z
summary: "Update the customer survey from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-15
owner: resident
closed_at: 2026-10-20T16:00:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The customer survey is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-27T11:00:00.000Z: The customer survey takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-20T11:00:00.000Z: The customer survey takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-21T11:00:00.000Z: The customer survey takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-27T12:00:00.000Z hermit: Kept the existing structure of the customer survey because the operator reads it on a phone and a new layout would not fit.
- 2026-10-20T12:00:00.000Z hermit: Kept the existing structure of the customer survey because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100016.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100016
type: task
title: "Update the holiday calendar"
created: 2026-10-20T09:00:00.000Z
summary: "Update the holiday calendar from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-16
owner: resident
closed_at: 2026-10-20T16:00:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The holiday calendar is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-20T11:00:00.000Z: The holiday calendar takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-21T11:00:00.000Z: The holiday calendar takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-22T11:00:00.000Z: The holiday calendar takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-20T12:00:00.000Z hermit: Kept the existing structure of the holiday calendar because the operator reads it on a phone and a new layout would not fit.
- 2026-10-21T12:00:00.000Z hermit: Kept the existing structure of the holiday calendar because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100017.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100017
type: task
title: "Update the blend recipes"
created: 2026-10-20T09:00:00.000Z
summary: "Update the blend recipes from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-17
owner: resident
closed_at: 2026-10-20T16:00:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The blend recipes is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-21T11:00:00.000Z: The blend recipes takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-22T11:00:00.000Z: The blend recipes takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-23T11:00:00.000Z: The blend recipes takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-21T12:00:00.000Z hermit: Kept the existing structure of the blend recipes because the operator reads it on a phone and a new layout would not fit.
- 2026-10-22T12:00:00.000Z hermit: Kept the existing structure of the blend recipes because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100018.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100018
type: task
title: "Update the stock count"
created: 2026-10-20T09:00:00.000Z
summary: "Update the stock count from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-18
owner: resident
closed_at: 2026-10-20T16:00:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The stock count is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-22T11:00:00.000Z: The stock count takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-23T11:00:00.000Z: The stock count takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-24T11:00:00.000Z: The stock count takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-22T12:00:00.000Z hermit: Kept the existing structure of the stock count because the operator reads it on a phone and a new layout would not fit.
- 2026-10-23T12:00:00.000Z hermit: Kept the existing structure of the stock count because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100019.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100019
type: task
title: "Update the review replies"
created: 2026-10-20T09:00:00.000Z
summary: "Update the review replies from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-19
owner: resident
closed_at: 2026-10-20T16:00:00.000Z
closed_by: confirmed
closed_actor: null
closed_reason: "Confirmed by the operator"
requester_name: null
origin_message_id: null
approver: null
due: null
conversation: discord:100000000000000001
card_chat_id: null
card_message_id: null
waiting_on: null
waiting_since: null
result: "The review replies is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
result_at: 2026-10-21T10:00:00.000Z
stall_at: null
stall_status: null
stall_next: null
dedupe_key: null
check: null
skill_review: null
last_worker: null
muted: false
delegated: false
tags: ["task"]
claims: []
result_rev: 0
---
## Progress
- 2026-10-20T09:00:00.000Z hermit: Opened

## Lessons
- 2026-10-23T11:00:00.000Z: The review replies takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-24T11:00:00.000Z: The review replies takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-25T11:00:00.000Z: The review replies takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-23T12:00:00.000Z hermit: Kept the existing structure of the review replies because the operator reads it on a phone and a new layout would not fit.
- 2026-10-24T12:00:00.000Z hermit: Kept the existing structure of the review replies because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
