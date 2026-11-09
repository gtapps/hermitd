#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p memory .hermit/compiled .hermit/state inputs
mkdir -p ".hermit/compiled"
cat > '.hermit/compiled/topic-copy.md' <<'HERMIT_FIXTURE'
---
title: Copy
type: topic
created: 2026-11-01
tags: []
audience: shared
---
The harbor closes at midnight.
HERMIT_FIXTURE
mkdir -p ".hermit/compiled"
cat > '.hermit/compiled/topic-pinned.md' <<'HERMIT_FIXTURE'
---
title: Pinned
type: topic
created: 2026-11-01
tags: [foundational]
audience: shared
---
The harbor closes at midnight.
HERMIT_FIXTURE
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
cat > 'memory/facts.md' <<'HERMIT_FIXTURE'
---
name: facts
description: Project facts
---
Existing unrelated fact: retain the blue deployment region.
HERMIT_FIXTURE

