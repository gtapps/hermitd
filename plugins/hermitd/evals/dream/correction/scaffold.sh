#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p memory .hermit/compiled .hermit/state inputs
mkdir -p ".hermit"
cat > '.hermit/config.json' <<'HERMIT_FIXTURE'
{"channels":{},"always_on":false}
HERMIT_FIXTURE
mkdir -p ".hermit"
cat > '.hermit/knowledge-schema.md' <<'HERMIT_FIXTURE'
# Knowledge
Topic pages require title, type, created, tags and audience.
HERMIT_FIXTURE
mkdir -p "inputs"
cat > 'inputs/night.txt' <<'HERMIT_FIXTURE'
SESSION synthetic-dream: fixture, 2026-11-08
AUDIENCE: shared
USER: I am correcting my November 1 deployment decision: from today, November 8, the deployment port is 9090. Keep that as our current port.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
- [Project facts](facts.md): Current project facts
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/facts.md' <<'HERMIT_FIXTURE'
---
name: facts
description: Project facts
---
Deployment uses port 8080, decided 2026-11-01.
Existing unrelated fact: retain the blue deployment region.
HERMIT_FIXTURE

