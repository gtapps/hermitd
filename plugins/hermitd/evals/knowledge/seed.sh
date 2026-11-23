#!/usr/bin/env bash
# Seeds a small-shop resident install with a session report and two compiled pages (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state .hermit/sessions .hermit/compiled .hermit/raw memory
cp "$here/../../state-templates/TASKS.md.template" .hermit/TASKS.md
cp "$here/../../state-templates/knowledge-schema.md.template" .hermit/knowledge-schema.md
: > memory/MEMORY.md
# Stamp the loaded plugin version so the hook injects no upgrade notice.
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{"agent_name":"assistant","timezone":"Europe/Lisbon","operator_profile":"technical","language":null,"channels":{"discord":{"allowed_users":["100000000000000001","100000000000000002"],"default_chat_id":"400000000000000001"}},"_hermit_versions":{"hermitd":"$ver"}}
HERMIT_CONFIG
cat > .hermit/sessions/S-041-REPORT.md <<'REPORT'
---
title: Newsletter schedule review
date: 2026-11-14
---
## Decisions
- Move the shop newsletter from Friday afternoons to Tuesday at 09:00, because Tuesday sends had the higher open rate in October.
REPORT
cat > .hermit/compiled/topic-wholesale-terms-discord-400000000000000002.md <<'PAGE'
---
title: Wholesale terms
type: topic
created: 2026-11-10
updated: 2026-11-10
tags: [wholesale, pricing]
summary: Agreed wholesale terms for Loja Norte.
audience: discord:400000000000000002
---
Loja Norte wholesale discount is 18 percent on orders over 40 units, agreed 2026-11-10.
PAGE
