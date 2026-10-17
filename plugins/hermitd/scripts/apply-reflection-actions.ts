// scripts/apply-reflection-actions.ts — transactional apply of the reflect eval
// runner's `resolution_actions` (reflect/SKILL.md § eval-runner return schema).
// Replaces the prose-directed apply: the whole batch is validated before ANY
// write, so malformed model output can never leave a proposal half-patched.
//
// Usage: bun apply-reflection-actions.ts <hermit-state-dir>   (stdin: JSON)
// <hermit-state-dir> is validated, not trusted: it must resolve to this
// project's own state dir (or, from a worktree, the main checkout's) via
// cc-compat's assertStateDir. A foreign root exits 1 without writing.
// Stdin: {"resolution_actions":[{proposal_id, action, frontmatter_patch,
//         shell_findings_line}, ...]}   — a non-null `metrics_event` is rejected;
//         the `resolved` row is derived here from proposal_id.
// Output: {"applied":{...}} (+ "errors" when any post-validation write failed),
// or {"error":"<token>"} with zero writes and exit 1. A rejected entry is
// `invalid_action:<index>:<problem>`.
//
// The whole batch validates before writes. Post-validation write failures are
// reported per proposal; no journal or task record is written here.

import fs from 'node:fs';
import path from 'node:path';
import { pinStateDirOrExit } from './lib/cc-compat';
import { emitJson, exitError } from './lib/cli';
import { listProposalFiles, readFileWithFrontmatter } from './lib/frontmatter';
import { appendEvent, resolvedEvent } from './lib/proposals/event';
import { sweepMoot } from './lib/proposals/micro';
import { writeFileAtomic, patchFrontmatter, PATCH_KEY_RE } from './lib/md-write';

type Json = any;

const ACTIONS = new Set(['auto-resolve', 'nudge', 'skip']);

function apply(stateDir: string, stdin: string): Json {
  let input: Json;
  try { input = JSON.parse(stdin); }
  catch { return { error: 'invalid_json' }; }
  const actions = input?.resolution_actions;
  if (!Array.isArray(actions)) return { error: 'missing_resolution_actions' };

  const proposalsDir = path.join(stateDir, 'proposals');
  const resolvedFiles = new Map<number, string>();
  let listed: { ok: boolean; files?: string[] } | null = null;

  // --- Validation pass: reject the whole batch before any write. ---
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const invalid = (problem: string) => ({ error: `invalid_action:${i}:${problem}` });
    if (!a || typeof a !== 'object') return invalid('not_object');
    if (typeof a.proposal_id !== 'string' || !/^PROP-\d+$/.test(a.proposal_id)) return invalid('bad_proposal_id');
    if (!ACTIONS.has(a.action)) return invalid('unknown_action');
    // `metrics_event` was a model-authored JSON string appended verbatim after only a
    // JSON.parse check — the last unschema'd write into proposal-metrics.jsonl. It is
    // gone: the row is always a `resolved` for a proposal_id this function already has,
    // so it is now built from that id below. Reject it if a stale runner still sends one,
    // rather than ignoring it and leaving the caller believing it was recorded.
    if (a.metrics_event != null) return invalid('metrics_event_rejected');
    if (a.shell_findings_line != null && typeof a.shell_findings_line !== 'string') return invalid('bad_shell_findings_line');
    if (a.action !== 'auto-resolve') continue;

    const patch = a.frontmatter_patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return invalid('missing_frontmatter_patch');
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCH_KEY_RE.test(k)) return invalid('bad_patch_key');
      if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) return invalid('non_scalar_patch_value');
    }
    if (listed === null) listed = listProposalFiles(proposalsDir);
    if (!listed.ok) return { error: 'proposals_dir_unreadable' };
    // Boundary-safe prefix match: PROP-1 must never match PROP-12.
    const file = (listed.files ?? []).find(f => f.startsWith(a.proposal_id + '-') || f === a.proposal_id + '.md');
    if (!file) return invalid('no_such_proposal');
    const full = path.join(proposalsDir, file);
    const parsed = readFileWithFrontmatter(full);
    if (!parsed || !parsed.fm) return invalid('frontmatter_unparseable');
    resolvedFiles.set(i, full);
  }

  // --- Apply pass: validation passed; I/O failures collect, don't abort. ---
  const applied = { auto_resolve: 0, nudge: 0, skip: 0 };
  const errors: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.action === 'skip') { applied.skip++; continue; }
    if (a.action === 'auto-resolve') {
      const file = resolvedFiles.get(i)!;
      try {
        writeFileAtomic(file, patchFrontmatter(fs.readFileSync(file, 'utf-8'), a.frontmatter_patch));
      } catch (e: any) {
        errors.push(`${a.proposal_id}: frontmatter patch failed: ${e.message}`);
        continue; // don't record metrics/findings for a proposal that wasn't patched
      }
      try {
        const err = appendEvent(stateDir, resolvedEvent(a.proposal_id));
        if (err) errors.push(`${a.proposal_id}: metrics append: ${err}`);
      } catch (e: any) {
        errors.push(`${a.proposal_id}: metrics append failed: ${e.message}`);
      }
      // Resolving retires any ask parked on this proposal — same reconciliation
      // proposal.ts's patch verb runs, since this path writes frontmatter
      // itself rather than going through it. A miss is reported, never fatal:
      // the proposal really was resolved.
      const swept = sweepMoot(stateDir, a.proposal_id);
      if (!swept.ok) errors.push(`${a.proposal_id}: pending-ask reconciliation: ${swept.error}`);
      applied.auto_resolve++;
    } else {
      applied.nudge++;
    }
  }

  const out: Json = { applied };
  if (errors.length > 0) out.errors = errors;
  return out;
}

if (import.meta.main) {
  const stateDir = process.argv[2];
  if (!stateDir) exitError();
  // The state dir is not caller-chosen. This script patches proposal
  // frontmatter and appends to the metrics ledger, and it is reachable through
  // a pre-approved `Bash(bun */scripts/apply-reflection-actions.ts*)` grant
  // that covers every argument — so an unvalidated root let one such call
  // resolve another project's proposals.
  const pinned = pinStateDirOrExit(stateDir);
  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf-8'); } catch { /* treated as unparseable below */ }
  let result: Json;
  try { result = apply(pinned, stdin); }
  catch (e: any) { result = { error: `unexpected:${e.message}` }; }
  emitJson(result);
}

export { apply, patchFrontmatter };
