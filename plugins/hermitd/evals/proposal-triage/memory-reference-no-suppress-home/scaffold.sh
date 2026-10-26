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
mkdir -p ".hermit"
cat > '.hermit/config.json' <<'HERMIT_FIXTURE'
{"agent_name": "assistant", "timezone": "Europe/Lisbon"}
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-004-washer-finished-notice-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-004-washer-finished-notice-100000
title: "Notify when the washing machine finishes"
status: resolved
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-004 — Notify when the washing machine finishes

## Problem
Laundry sat wet for hours because nobody knew the cycle had ended.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-009-irrigation-rain-skip-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-009-irrigation-rain-skip-100000
title: "Skip garden irrigation when rain is forecast"
status: proposed
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-009 — Skip garden irrigation when rain is forecast

## Problem
The sprinklers run on schedule even on days with heavy rain, wasting water.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-011-daily-energy-report-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-011-daily-energy-report-100000
title: "Daily energy usage report in the morning brief"
status: dismissed
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-011 — Daily energy usage report in the morning brief

## Problem
No daily view of electricity use.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-013-notices-in-portuguese-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-013-notices-in-portuguese-100000
title: "Send household notices in Portuguese"
status: deferred
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-013 — Send household notices in Portuguese

## Problem
Half the household reads Portuguese more comfortably than English.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-015-auto-lock-midnight-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-015-auto-lock-midnight-100000
title: "Auto-lock the front door at midnight"
status: accepted
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-015 — Auto-lock the front door at midnight

## Problem
The front door was found unlocked in the morning several times.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/proposals-index.json' <<'HERMIT_FIXTURE'
{
  "updated": "2026-10-01T08:00:00Z",
  "count": 5,
  "proposals": [
    {
      "id": "PROP-004-washer-finished-notice-100000",
      "file": "PROP-004-washer-finished-notice-100000.md",
      "status": "resolved",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Notify when the washing machine finishes",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    },
    {
      "id": "PROP-009-irrigation-rain-skip-100000",
      "file": "PROP-009-irrigation-rain-skip-100000.md",
      "status": "proposed",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Skip garden irrigation when rain is forecast",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    },
    {
      "id": "PROP-011-daily-energy-report-100000",
      "file": "PROP-011-daily-energy-report-100000.md",
      "status": "dismissed",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Daily energy usage report in the morning brief",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    },
    {
      "id": "PROP-013-notices-in-portuguese-100000",
      "file": "PROP-013-notices-in-portuguese-100000.md",
      "status": "deferred",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Send household notices in Portuguese",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    },
    {
      "id": "PROP-015-auto-lock-midnight-100000",
      "file": "PROP-015-auto-lock-midnight-100000.md",
      "status": "accepted",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Auto-lock the front door at midnight",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    }
  ]
}
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
