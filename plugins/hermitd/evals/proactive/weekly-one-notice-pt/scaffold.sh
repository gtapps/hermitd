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
      "enabled": true,
      "allowed_users": [
        "100000000000000001"
      ],
      "default_chat_id": "400000000000000001"
    }
  },
  "routines": [
    {
      "id": "hermitd:weekly-review",
      "skill": "hermitd:weekly-review",
      "schedule": "0 9 * * *",
      "enabled": true
    }
  ],
  "language": "pt-PT",
  "artifacts": {
    "dashboard": false,
    "weekly_review": false
  },
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p ".hermit/bin"
cat > '.hermit/bin/hermitd-run' <<'HERMIT_FIXTURE'
#!/usr/bin/env bash
echo OK
HERMIT_FIXTURE
mkdir -p ".hermit/compiled"
cat > '.hermit/compiled/review-weekly-2026-W39.md' <<'HERMIT_FIXTURE'
---
week: 2026-W39
total_cost_usd: 2
---
HERMIT_FIXTURE
mkdir -p ".hermit/compiled"
cat > '.hermit/compiled/review-weekly-2026-W40.md' <<'HERMIT_FIXTURE'
---
type: review
title: "Weekly Review: 2026-W40"
created: 2026-10-01T13:30:00.000Z
tags: [weekly, review]
generated: true
week: 2026-W40
tasks_count: 0
delivered_count: 0
delivered: []
proposals_created: 0
proposals_accepted: 0
proposals_resolved: 0
open_loops_count: 0
total_cost_usd: 0.00
total_tokens: 0
avg_task_cost_usd: 0.00
avg_task_tokens: 0
reflect_runs: 0
reflect_surfaced: 0
reflect_accepted: 0
reflect_cost_usd: 0.00
reflect_observations: 0
skills_new: 0
skills_often_patched: 0
usage_untouched_count: 0
usage_auto_archived: []
---
## Week of September 28–October 4, 2026

### Tasks
No closed tasks this week. Week spend $0.00 (0 tokens).

### By person

### Duties
- heartbeat: requested enabled=true, every=30m, mode=auto; observed pid=unknown, last_woke=unknown, last_event=frozen

### Reflect
reflect: 0 runs, 0 surfaced, 0 accepted, ~$0.00; obs: 0 ledger.

### Skills
Skills: 0 new, 0 often patched.

HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE
chmod +x .hermit/bin/hermitd-run
