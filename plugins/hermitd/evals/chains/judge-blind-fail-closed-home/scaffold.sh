#!/usr/bin/env bash
# Seeds a hermit state dir and auto-memory for this case (runs only with --scaffold).
set -e
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Household of two adults and a cat. Prefers short messages.

## Preferences
- Don't add more daily or weekly reports; the morning brief is enough.
- Never unlock doors automatically.
HERMIT_FIXTURE
mkdir -p ".hermit/compiled"
cat > '.hermit/compiled/topic-energy-baseline.md' <<'HERMIT_FIXTURE'
---
title: Energy usage baseline
type: topic
created: 2026-09-01T09:00:00+01:00
tags: [energy]
---

Average daily use 9.4 kWh.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100004.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100004
type: task
title: "Notify when the washing machine finishes"
created: 2026-08-14T10:00:00+01:00
summary: "Notify when the washing machine finishes"
audience: operator
status: closed
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100004
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
dedupe_key: proposal:T-20260814-100004
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
Laundry sat wet for hours because nobody knew the cycle had ended.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100009.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100009
type: task
title: "Skip garden irrigation when rain is forecast"
created: 2026-08-14T10:00:00+01:00
summary: "Skip garden irrigation when rain is forecast"
audience: operator
status: open
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100009
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
dedupe_key: proposal:T-20260814-100009
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
The sprinklers run on schedule even on days with heavy rain, wasting water.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100011.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100011
type: task
title: "Daily energy usage report in the morning brief"
created: 2026-08-14T10:00:00+01:00
summary: "Daily energy usage report in the morning brief"
audience: operator
status: closed
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100011
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
dedupe_key: proposal:T-20260814-100011
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
No daily view of electricity use.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100013.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100013
type: task
title: "Send household notices in Portuguese"
created: 2026-08-14T10:00:00+01:00
summary: "Send household notices in Portuguese"
audience: operator
status: open
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100013
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
dedupe_key: proposal:T-20260814-100013
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
Half the household reads Portuguese more comfortably than English.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/tasks"
cat > '.hermit/tasks/T-20260814-100015.md' <<'HERMIT_FIXTURE'
---
id: T-20260814-100015
type: task
title: "Auto-lock the front door at midnight"
created: 2026-08-14T10:00:00+01:00
summary: "Auto-lock the front door at midnight"
audience: operator
status: open
opened_at: 2026-08-14T10:00:00+01:00
requester: agent
handle: t-20260814-100015
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
dedupe_key: proposal:T-20260814-100015
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
The front door was found unlocked in the morning several times.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
- [no-camera-automations](feedback_no_camera_automations.md) — Do not propose automations that use the indoor cameras
- [fewer-phone-notifications](feedback_fewer_phone_notifications.md) — No new phone notifications for routine household events
- [irrigation-entities](reference_irrigation_entities.md) — Entity names for the garden irrigation valves and the rain sensor
- [household](user_household.md) — Who lives in the house
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/feedback_fewer_phone_notifications.md' <<'HERMIT_FIXTURE'
---
name: fewer-phone-notifications
description: No new phone notifications for routine household events
type: feedback
---

Don't add new phone notifications for routine household events.
**Why:** notification fatigue.
**How to apply:** prefer the morning brief over a push.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/feedback_no_camera_automations.md' <<'HERMIT_FIXTURE'
---
name: no-camera-automations
description: Do not propose automations that use the indoor cameras
type: feedback
---

Don't propose automations driven by the indoor cameras.
**Why:** privacy; the cameras are for when the house is empty.
**How to apply:** treat camera-based ideas as already decided against.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/reference_irrigation_entities.md' <<'HERMIT_FIXTURE'
---
name: irrigation-entities
description: Entity names for the garden irrigation valves and the rain sensor
type: reference
---

Valves: valve.garden_front, valve.garden_back_zone2, switch.drip_line. Rain sensor: binary_sensor.rain_gauge.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/user_household.md' <<'HERMIT_FIXTURE'
---
name: household
description: Who lives in the house
type: user
---

Two adults and a cat.
HERMIT_FIXTURE
