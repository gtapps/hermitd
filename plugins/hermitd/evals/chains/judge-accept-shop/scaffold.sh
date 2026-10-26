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
{"agent_name":"assistant","timezone":"Europe/Lisbon"}
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-021-unpaid-invoice-reminders-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-021-unpaid-invoice-reminders-100000
title: "Remind customers about invoices unpaid after 7 days"
status: proposed
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-021 — Remind customers about invoices unpaid after 7 days

## Problem
Wholesale invoices go unpaid for weeks because nobody chases them.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-024-weekly-sales-summary-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-024-weekly-sales-summary-100000
title: "Weekly sales summary to the channel"
status: dismissed
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-024 — Weekly sales summary to the channel

## Problem
No weekly overview of sales.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-026-nightly-db-backup-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-026-nightly-db-backup-100000
title: "Back up the shop database nightly"
status: resolved
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-026 — Back up the shop database nightly

## Problem
The order database had no backup.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/proposals"
cat > '.hermit/proposals/PROP-028-low-stock-reorder-100000.md' <<'HERMIT_FIXTURE'
---
id: PROP-028-low-stock-reorder-100000
title: "Reorder alert when stock falls below 5 units"
status: accepted
source: auto-detected
created: 2026-08-14T10:00:00+01:00
category: improvement
tags: []
---
# Proposal: PROP-028 — Reorder alert when stock falls below 5 units

## Problem
Popular teas sold out before anyone noticed.

## Proposed Solution
See title.
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/proposals-index.json' <<'HERMIT_FIXTURE'
{
  "updated": "2026-10-01T08:00:00Z",
  "count": 4,
  "proposals": [
    {
      "id": "PROP-021-unpaid-invoice-reminders-100000",
      "file": "PROP-021-unpaid-invoice-reminders-100000.md",
      "status": "proposed",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Remind customers about invoices unpaid after 7 days",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    },
    {
      "id": "PROP-024-weekly-sales-summary-100000",
      "file": "PROP-024-weekly-sales-summary-100000.md",
      "status": "dismissed",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Weekly sales summary to the channel",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    },
    {
      "id": "PROP-026-nightly-db-backup-100000",
      "file": "PROP-026-nightly-db-backup-100000.md",
      "status": "resolved",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Back up the shop database nightly",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    },
    {
      "id": "PROP-028-low-stock-reorder-100000",
      "file": "PROP-028-low-stock-reorder-100000.md",
      "status": "accepted",
      "source": "auto-detected",
      "category": "improvement",
      "title": "Reorder alert when stock falls below 5 units",
      "created": "2026-08-14T10:00:00+01:00",
      "tags": []
    }
  ]
}
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
