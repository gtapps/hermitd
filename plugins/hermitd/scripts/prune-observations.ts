// Prunes the sub-threshold observations ledger (state/observations.jsonl).
// Zero npm dependencies, Node stdlib only.
// Usage: bun prune-observations.ts <hermit-state-dir>
// Output: `{"pruned":N,"kept":N}` (a missing ledger is `{"pruned":0,"kept":0}`).
//
// Keep rule: an entry survives iff its ts is within the retention window, OR
// any entry sharing its pattern is within the window (recurrence keeps a
// pattern's full history alive so graduation can cite every sighting).
// Unparseable lines are kept verbatim — never destroy data we can't read.

import fs from 'node:fs';
import path from 'node:path';
import { emitJson, exitError } from './lib/cli';

type Json = any;

const RETENTION_DAYS = 30;

const stateDir = process.argv[2];

if (!stateDir) exitError();

const ledgerPath = path.join(stateDir, 'state', 'observations.jsonl');

let content: string;
try {
  content = fs.readFileSync(ledgerPath, 'utf-8');
} catch {
  emitJson({ pruned: 0, kept: 0 });
}

const cutoffMs = Date.now() - RETENTION_DAYS * 86400000;
const lines = content.split('\n').filter(l => l.trim());

const freshPatterns = new Set<string>();
const parsed = lines.map((line): Json => {
  try {
    const e = JSON.parse(line);
    const tsMs = Date.parse(e.ts);
    const fresh = Number.isFinite(tsMs) && tsMs >= cutoffMs;
    if (fresh && e.pattern) freshPatterns.add(e.pattern);
    return { line, pattern: e.pattern, fresh };
  } catch {
    return { line, keep: true };
  }
});

const kept = parsed.filter(p => p.keep || p.fresh || freshPatterns.has(p.pattern));

if (kept.length < lines.length) {
  const tmp = ledgerPath + '.tmp';
  fs.writeFileSync(tmp, kept.map(p => p.line).join('\n') + (kept.length ? '\n' : ''), 'utf-8');
  fs.renameSync(tmp, ledgerPath);
}

emitJson({ pruned: lines.length - kept.length, kept: kept.length });
