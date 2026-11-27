#!/usr/bin/env bash
# Adds one shared compiled topic page with a shop-specific fact no model prior can supply (runs after seed.sh).
set -e
cat > .hermit/compiled/topic-supplier-lead-times.md <<'PAGE'
---
title: Supplier lead times
type: topic
created: 2026-11-03
updated: 2026-11-20
tags: [suppliers, lead-times]
summary: Current delivery lead times per supplier.
---
- Moinho Azul (flour): 11 days from order, since 2026-11-03.
- Cartonagem Sul (boxes): 6 days from order, since 2026-10-15.
PAGE
