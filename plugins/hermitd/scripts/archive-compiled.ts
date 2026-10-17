#!/usr/bin/env bun
// archive-compiled.ts — rotates old compiled artifacts into compiled/.archive/
// Zero npm dependencies. Node stdlib only.
// Usage: bun archive-compiled.ts <hermit-state-dir>
//   hermit-state-dir: path to .hermit/ in the target project (default: .hermit)
// Output: `{"archived":N,"retained":N,"skipped":N}`.
//
// Retention: keeps the newest KEEP_PER_TYPE artifacts per type; foundational-tagged
// artifacts and topic pages (type: topic) are always retained and excluded from the
// per-type count — living pages compact by merging, not archival.

import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter, globDir } from './lib/frontmatter';
import { emitJson } from './lib/cli';

type Json = any;

const KEEP_PER_TYPE = 2;

const hermitDir = process.argv[2] || '.hermit';
const compiledDir = path.join(hermitDir, 'compiled');
const archiveDir = path.join(compiledDir, '.archive');

const fullPaths = globDir(compiledDir, /^[^.].*\.md$/);
if (fullPaths.length === 0) emitJson({ archived: 0, retained: 0, skipped: 0 });

fs.mkdirSync(archiveDir, { recursive: true });

let archived = 0;
let retained = 0;
let skipped = 0;

const artifacts: Json[] = [];
for (const filePath of fullPaths) {
  const filename = path.basename(filePath);
  const fm = readFrontmatter(filePath);

  if (!fm || !fm.type || !fm.created) {
    skipped++;
    continue;
  }

  const created = new Date(fm.created);
  if (isNaN(created.getTime())) {
    skipped++;
    continue;
  }

  artifacts.push({ filePath, filename, fm, created });
}

const rotatable: Json[] = [];
for (const a of artifacts) {
  // topic pages are living documents — they compact by merging, not archival
  if ((a.fm.tags || []).includes('foundational') || a.fm.type === 'topic') {
    retained++;
  } else {
    rotatable.push(a);
  }
}

const byType = new Map<string, Json>();
for (const a of rotatable) {
  if (!byType.has(a.fm.type)) byType.set(a.fm.type, []);
  byType.get(a.fm.type).push(a);
}

for (const [, group] of byType) {
  group.sort((a: Json, b: Json) => b.created - a.created);

  for (let i = 0; i < group.length; i++) {
    if (i < KEEP_PER_TYPE) {
      retained++;
      continue;
    }
    let dest = path.join(archiveDir, group[i].filename);
    if (fs.existsSync(dest)) {
      const ext = path.extname(dest);
      const base = path.basename(dest, ext);
      dest = path.join(archiveDir, `${base}-${Date.now()}${ext}`);
    }
    try {
      fs.renameSync(group[i].filePath, dest);
      archived++;
    } catch {
      skipped++;
    }
  }
}

emitJson({ archived, retained, skipped });
