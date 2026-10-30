#!/usr/bin/env bun
/**
 * Scaffolds the static `.hermit/` state tree for /hatch Step 2.
 *
 * Step 2 is otherwise many mechanical mkdir/cp/chmod calls building a tree that
 * is byte-identical for every hatch — zero per-project reasoning. This collapses
 * it into one deterministic call. The reasoned artifacts (config.json, OPERATOR.md
 * *content*, CLAUDE.local.md) are NOT scaffolded here; they keep their own steps.
 *
 * Usage: bun hatch-scaffold.ts <PROJECT_ROOT> [--reinit=true|false]
 *
 * File classes (resolves the ambiguous re-init semantics in hatch SKILL.md L16
 * toward MAXIMAL PRESERVATION — never clobber anything an operator could have
 * edited or accumulated):
 *   - REFRESH (hermit-owned pristine, operator never hand-edits): overwritten on
 *     --reinit=true, created on fresh. = templates/* and bin/* .
 *   - PRESERVE (operator-editable or accumulated state): created only if absent,
 *     in BOTH modes. = OPERATOR.md, HEARTBEAT.md, knowledge-schema.md,
 *     every state/* file (reflection-state, alert-state, micro-proposals, *.jsonl).
 *   - NEVER created: retired lifecycle state.
 * On a FRESH hatch every class is created, so behaviour is identical to today;
 * the classes only diverge on --reinit.
 *
 * `state/template-manifest.json` is NOT seeded here — that stays deferred to the
 * end of hatch Step 8 (it needs the bun-script permission Step 8 merges).
 *
 * Prints { created, overwritten, preserved, operator_existed } JSON to stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { localISOStamp } from './lib/time';
import { markGuest } from './lib/guest-marker';
import { flagValue, exitError } from './lib/cli';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const TEMPLATES = path.join(PLUGIN_ROOT, 'state-templates');

const projectRoot = process.argv[2];
if (!projectRoot) exitError();
const reinit = process.argv.slice(3).some((a) => a === '--reinit=true' || a === '--reinit');

const hermit = path.join(projectRoot, '.hermit');

const created: string[] = [];
const overwritten: string[] = [];
const preserved: string[] = [];

function rel(p: string): string {
  return path.relative(hermit, p);
}

// REFRESH-class: write/overwrite from a producer. Overwrite only on reinit.
function refresh(dest: string, produce: () => void): void {
  const had = fs.existsSync(dest);
  if (had && !reinit) {
    preserved.push(rel(dest));
    return;
  }
  produce();
  (had ? overwritten : created).push(rel(dest));
}

// PRESERVE-class: only ever create when absent (both modes).
function seedIfAbsent(dest: string, produce: () => void): boolean {
  if (fs.existsSync(dest)) {
    preserved.push(rel(dest));
    return true; // already existed
  }
  produce();
  created.push(rel(dest));
  return false;
}

function copy(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
}

// --- directory tree (mkdir -p is idempotent; not counted) ---
for (const d of ['proposals', 'templates', 'state', 'raw/.archive', 'compiled', 'bin']) {
  fs.mkdirSync(path.join(hermit, d), { recursive: true });
}

markGuest(path.join(hermit, 'state'), flagValue(process.argv.slice(3), '--session-id'));

// --- REFRESH: hermit-owned pristine templates ---
for (const name of ['PROPOSAL.md.template']) {
  const dest = path.join(hermit, 'templates', name);
  refresh(dest, () => copy(path.join(TEMPLATES, name), dest));
}

// --- REFRESH: bin/ executables (enumerate source, never hardcode) ---
for (const name of fs.readdirSync(path.join(TEMPLATES, 'bin')).sort()) {
  const src = path.join(TEMPLATES, 'bin', name);
  if (!fs.statSync(src).isFile()) continue;
  const dest = path.join(hermit, 'bin', name);
  refresh(dest, () => {
    copy(src, dest);
    fs.chmodSync(dest, 0o755);
  });
}

// --- PRESERVE: operator-editable files seeded from templates ---
const operatorExisted = seedIfAbsent(path.join(hermit, 'OPERATOR.md'), () =>
  copy(path.join(TEMPLATES, 'OPERATOR.md'), path.join(hermit, 'OPERATOR.md')),
);
seedIfAbsent(path.join(hermit, 'HEARTBEAT.md'), () =>
  copy(path.join(TEMPLATES, 'HEARTBEAT.md.template'), path.join(hermit, 'HEARTBEAT.md')),
);
seedIfAbsent(path.join(hermit, 'TASKS.md'), () =>
  copy(path.join(TEMPLATES, 'TASKS.md.template'), path.join(hermit, 'TASKS.md')),
);
fs.mkdirSync(path.join(hermit, 'tasks'), { recursive: true });
seedIfAbsent(path.join(hermit, 'knowledge-schema.md'), () =>
  copy(path.join(TEMPLATES, 'knowledge-schema.md.template'), path.join(hermit, 'knowledge-schema.md')),
);
// --- PRESERVE: state files (accumulated runtime/learning/proposal data) ---
seedIfAbsent(path.join(hermit, 'state', 'alert-state.json'), () =>
  copy(path.join(TEMPLATES, 'alert-state.json.template'), path.join(hermit, 'state', 'alert-state.json')),
);
seedIfAbsent(path.join(hermit, 'state', 'micro-proposals.json'), () =>
  copy(path.join(TEMPLATES, 'micro-proposals.json.template'), path.join(hermit, 'state', 'micro-proposals.json')),
);
seedIfAbsent(path.join(hermit, 'state', 'reflection-state.json'), () => {
  const reflectionState = {
    last_reflection: null,
    counters: {
      total_runs: 0,
      empty_runs: 0,
      runs_with_candidates: 0,
      judge_accept: 0,
      judge_downgrade: 0,
      judge_suppress: 0,
      proposals_created: 0,
      micro_proposals_queued: 0,
      last_run_at: null,
      last_output_at: null,
      since: localISOStamp(),
    },
  };
  fs.writeFileSync(
    path.join(hermit, 'state', 'reflection-state.json'),
    JSON.stringify(reflectionState, null, 2) + '\n',
  );
});
for (const jsonl of [
  'routine-metrics.jsonl',
  'proposal-metrics.jsonl',
  'observations.jsonl',
  'update-history.jsonl',
  'channel-replies.jsonl',
]) {
  const dest = path.join(hermit, 'state', jsonl);
  // 0600, not the umask default a bare writeFileSync would leave: these ledgers
  // carry channel and user IDs.
  seedIfAbsent(dest, () => fs.writeFileSync(dest, '', { mode: 0o600 }));
}
// retired lifecycle state: deliberately never created.

console.log(JSON.stringify({ created, overwritten, preserved, operator_existed: operatorExisted }));
process.exit(0);
