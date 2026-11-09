#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p memory .hermit/compiled .hermit/state inputs
mkdir -p ".hermit/compiled"
cat > '.hermit/compiled/topic-project-discord-99.md' <<'HERMIT_FIXTURE'
---
title: Private project
type: topic
created: 2026-11-01
tags: []
audience: discord:99
---
Private project facts.
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
mkdir -p "inputs"
cat > 'inputs/night.txt' <<'HERMIT_FIXTURE'
SESSION synthetic-dream: fixture, 2026-11-08
AUDIENCE: discord:99
USER: The private migration deploys to region IVORY-TAIGA. This is a non-secret region identifier, not a credential.
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

