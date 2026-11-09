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
cat > 'memory/facts.md' <<'HERMIT_FIXTURE'
---
name: facts
description: Project facts
---
Tidewick requires Python 3.11 or newer.
It uses only the Python standard library, including unittest.
Station file times use local standard time year-round, without daylight-saving handling.
HERMIT_FIXTURE
for file in "$here/../_fixtures/transcripts/"*; do
  { printf 'AUDIENCE: shared
'; cat "$file"; } > "inputs/$(basename "$file")"
done
bun -e 'const path=require("node:path");const fs=require("node:fs");const root=process.cwd();const inputs=fs.readdirSync("inputs").sort().map(n=>path.join(root,"inputs",n));fs.writeFileSync("export-ready.json",JSON.stringify({status:"ready",run_dir:path.join(root,".hermit/state/dream/fixture"),inputs,memory_dir:path.join(root,"memory"),compiled_dir:path.join(root,".hermit/compiled"),est_tokens:71000,pending:false}));'
