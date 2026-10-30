#!/usr/bin/env bash
# Seeds the shared busy install plus this case's changes (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../_seed/busy.sh"
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20261001-100008.md' <<'HERMIT_FIXTURE'
---
id: T-20261001-100008
type: task
title: "Update the loose leaf labels"
created: 2026-10-20T09:00:00.000Z
summary: "Update the loose leaf labels from the current sources"
audience: discord:100000000000000001
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-8
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
result: "The loose leaf labels is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
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
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-9
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
result: "The courier contract is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
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
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-10
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
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-11
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
result: "The loyalty discounts is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
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
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-12
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
result: "The matcha reorder is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
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
status: closed
opened_at: 2026-10-20T09:00:00.000Z
requester: discord:100000000000000001
handle: update-13
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
result: "The tax summary is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline."
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
- 2026-10-25T11:00:00.000Z: The tax summary takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-26T11:00:00.000Z: The tax summary takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.
- 2026-10-27T11:00:00.000Z: The tax summary takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.

## Decisions
- 2026-10-25T12:00:00.000Z hermit: Kept the existing structure of the tax summary because the operator reads it on a phone and a new layout would not fit.
- 2026-10-26T12:00:00.000Z hermit: Kept the existing structure of the tax summary because the operator reads it on a phone and a new layout would not fit.
HERMIT_FIXTURE
sed -i "s/__TODAY__/$(date -u +%F)/g" .hermit/tasks/*.md
