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
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
- [Project facts](facts.md): Current project facts
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/a.md' <<'HERMIT_FIXTURE'
---
name: a
description: Project facts
---
Deploys use region blue.
Deploys use port 9090.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/b.md' <<'HERMIT_FIXTURE'
---
name: b
description: Project facts
---
Deploys use region blue.
Deploys use port 9090.
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/facts.md' <<'HERMIT_FIXTURE'
---
name: facts
description: Project facts
---
Existing unrelated fact: retain the blue deployment region.
HERMIT_FIXTURE

