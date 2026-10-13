// drift.ts — detectors for storage-layout and schema drift.
// Used by startup-context.ts (display) and reflect-precheck.ts (capture to observations ledger).

import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter, globDir } from './frontmatter';
import { readSettledConfig } from './config-read';
import { parseSchema } from '../knowledge-lint';

export function findStorageDrift(hermitDir: string): string[] {
  const KNOWN_DIRS = new Set(['tasks', 'raw', 'compiled', 'sessions', 'proposals', 'state', 'templates',
    'memory', 'bin', 'docker', 'memory-mirror', 'helper-reports']);

  // Fail-open: any parse error → no exemptions applied.
  const listed = readSettledConfig(hermitDir).storage_drift.ignore;
  const ignoreDirs = new Set<string>(listed.filter((d: unknown): d is string => typeof d === 'string'));

  const hits: string[] = [];

  function countEntries(dir: string): number {
    try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')).length; } catch { return 0; }
  }

  // Unknown top-level dirs inside .hermit/
  try {
    for (const entry of fs.readdirSync(hermitDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!KNOWN_DIRS.has(entry.name) && !ignoreDirs.has(entry.name)) {
        const n = countEntries(path.join(hermitDir, entry.name));
        hits.push(`.hermit/${entry.name}/ (${n} file${n !== 1 ? 's' : ''})`);
      }
    }
  } catch {}

  // Subdirs under raw/ and compiled/ (except .archive)
  for (const side of ['raw', 'compiled']) {
    try {
      for (const entry of fs.readdirSync(path.join(hermitDir, side), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.archive') continue;
        const n = countEntries(path.join(hermitDir, side, entry.name));
        hits.push(`.hermit/${side}/${entry.name}/ (${n} file${n !== 1 ? 's' : ''})`);
      }
    } catch {}
  }

  return hits;
}

export function findSchemaDrift(hermitDir: string): { type: string; example: string }[] {
  try {
    const schemaPath = path.join(hermitDir, 'knowledge-schema.md');
    const schema = parseSchema(schemaPath);
    if (!schema) return [];

    const compiledDir = path.join(hermitDir, 'compiled');
    const compiledFiles = globDir(compiledDir, /^[^.].*\.md$/);
    const undeclared = new Map<string, string>(); // type -> first filename
    for (const f of compiledFiles) {
      const fm = readFrontmatter(f);
      if (!fm || !fm.type) continue;
      if (!schema.workProducts.has(fm.type) && !undeclared.has(fm.type)) {
        undeclared.set(fm.type, path.basename(f));
      }
    }
    return Array.from(undeclared.entries()).map(([type, example]) => ({ type, example }));
  } catch {
    return [];
  }
}
