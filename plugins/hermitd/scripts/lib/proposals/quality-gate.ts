// `proposal.ts quality-gate <stateDir> <proposal-file> [--files-json <json>]` —
// the single decider for whether an accepted-proposal implementation gets a
// `/simplify` cleanup pass.
//
// This module exists because the rubric used to live as prose in two places
// (proposal-act/SKILL.md's dispatched-subagent prompt and its in-main step e.5)
// and the two copies had already diverged: the dispatched copy carried no
// bookkeeping-path filter, so an implementation whose only diff was
// `sessions/task records` ran /simplify (~$0.25) on one path and skipped on the
// other. Both paths now call this, so they cannot disagree.
//
// Authoritative inputs are read here, never accepted from the caller — a caller
// that supplies the tier is a caller that can supply the wrong tier:
//   tier     ← <stateDir>/config.json  quality_gate.tier
//   category ← the proposal file's own frontmatter
// `--files-json` is the one caller-supplied input, and only because the touched
// set is knowledge the caller has and the filesystem doesn't (an in-main
// implementation knows what it wrote). Absent it, the working-tree diff decides.
// Its paths are repo-root-relative — the same frame `git diff --name-only` emits
// and the frame a hermit session naturally writes, since sessions launch from the
// project root. Every path this module hands to git is resolved in that one frame.
//
// Output: one JSON object, always exit 0 —
//   {"tier":"...","status":"run"|"skip","reason":"<token>","detail":"<prose>","focus_files":[...]}
// Reasons: budget_tier, quality_tier, no_file_evidence, no_files_changed,
// bookkeeping_only, code_changed, instruction_changed, structural_change,
// no_substantive_change. `detail` is the human-readable why (file, category).
// Fail-safe by design: an unreadable config, a missing proposal, a broken git
// invocation, or an empty candidate set all resolve to a bounded skip with the
// reason naming what was missing. The gate is cleanup, not correctness — the
// `## Verification` gate is what blocks resolution — so a gate failure must
// never block an implementation.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFrontmatter } from '../frontmatter';
import { flagValue } from '../cli';
import { readSettledConfig } from '../config-read';
import { QUALITY_GATE_TIER } from '../settings/enums';

type Json = any;

export type Status = 'run' | 'skip';
export interface Verdict {
  tier: string;
  status: Status;
  reason: string;
  detail: string;
  focus_files: string[];
}

// Session bookkeeping the hermit rewrites on its own schedule. A diff made
// entirely of these is not an implementation, so it is never worth a cleanup
// pass. This list is the only copy — proposal-act/SKILL.md deliberately does not
// restate it; tests/proposal-quality-gate.test.ts asserts each entry individually.
const BOOKKEEPING: RegExp[] = [
  /(^|\/)sessions\/SHELL\.md$/,
  /(^|\/)state\/runtime\.json$/,
  /(^|\/)state\/monitors\.runtime\.json$/,
  /(^|\/)state\/state-summary\.md$/,
  /(^|\/)state\/[^/]+\.jsonl$/,
  /(^|\/)HEARTBEAT\.md$/,
  /(^|\/)proposals\/PROP-[^/]*\.md$/,
];

const CODE_EXT = ['.ts', '.js', '.sh', '.py', '.go', '.rs'];
const STRUCT_EXT = ['.json', '.yml', '.yaml'];

function isBookkeeping(p: string): boolean {
  return BOOKKEEPING.some(re => re.test(p));
}

function isCode(p: string): boolean {
  return CODE_EXT.includes(path.extname(p));
}

/** SKILL.md and agents/*.md carry instruction text the model executes — code by any useful definition. */
function isInstruction(p: string): boolean {
  return path.basename(p) === 'SKILL.md' || /(^|\/)agents\/[^/]+\.md$/.test(p);
}

function isStructured(p: string): boolean {
  return STRUCT_EXT.includes(path.extname(p));
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, out: '' };
  return { ok: true, out: r.stdout ?? '' };
}

/** Repo root, so a repo-root-relative path can be used as a pathspec; null outside git. */
function gitRoot(cwd: string): string | null {
  const { ok, out } = git(['rev-parse', '--show-toplevel'], cwd);
  const root = out.trim();
  return ok && root ? root : null;
}

/**
 * True when a structured file's diff only changed values, leaving the key set
 * intact — a version bump or a threshold tweak, nothing for a reviewer to clean.
 *
 * `file` is repo-root-relative and `root` is the repo root, because git reads a
 * command-line pathspec relative to the process cwd: run from a hermit dir below
 * the root, `-- <file>` would match nothing and every structured file would come
 * back structural.
 *
 * Deliberately conservative: anything this cannot prove is value-only (a changed
 * array element, an unparseable hunk, no git at all) reports false and the file
 * counts as structural. A false RUN costs ~$0.25; a false SKIP silently drops
 * the cleanup, so the bias goes to RUN.
 */
function isValueOnlyChange(file: string, root: string): boolean {
  const { ok, out } = git(['diff', '-U0', '--no-color', 'HEAD', '--', file], root);
  if (!ok || !out.trim()) return false;

  const keyOf = (line: string): string | null => {
    const body = line.slice(1);
    const json = body.match(/^\s*"([^"]+)"\s*:/);
    if (json) return json[1];
    const yaml = body.match(/^\s*([A-Za-z0-9_.-]+)\s*:/);
    if (yaml) return yaml[1];
    return null;
  };

  const added: string[] = [];
  const removed: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    const k = keyOf(line);
    if (k === null) return false; // array element or free text — cannot prove value-only
    (line.startsWith('+') ? added : removed).push(k);
  }
  if (!added.length || added.length !== removed.length) return false;
  return added.slice().sort().join('\0') === removed.slice().sort().join('\0');
}

function resolveTier(stateDir: string): string {
  const cfg = readSettledConfig(stateDir);
  const tier = cfg.quality_gate.tier;
  return typeof tier === 'string' && (QUALITY_GATE_TIER as readonly string[]).includes(tier) ? tier : 'budget';
}

function resolveCategory(proposalFile: string | undefined): string | null {
  if (!proposalFile) return null;
  const fm = readFrontmatter(proposalFile);
  const c = fm?.category;
  return typeof c === 'string' && c ? c : null;
}

/** Working-tree diff against HEAD plus untracked files; null when git can't answer. */
function worktreeFiles(cwd: string): string[] | null {
  const tracked = git(['diff', '--name-only', 'HEAD'], cwd);
  if (!tracked.ok) return null;
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd);
  const lines = (tracked.out + '\n' + (untracked.ok ? untracked.out : ''))
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  return Array.from(new Set(lines));
}

export function decide(
  stateDir: string,
  proposalFile: string | undefined,
  suppliedFiles: string[] | null,
  cwd: string,
): Verdict {
  const tier = resolveTier(stateDir);
  if (tier === 'budget') {
    return { tier, status: 'skip', reason: 'budget_tier', detail: 'budget tier — cleanup never runs', focus_files: [] };
  }

  const inGit = suppliedFiles ? null : worktreeFiles(cwd);
  const raw = suppliedFiles ?? inGit;
  if (raw === null) {
    return { tier, status: 'skip', reason: 'no_file_evidence', detail: 'no file evidence — not a git worktree and no --files-json', focus_files: [] };
  }

  const candidates = raw.filter(p => !isBookkeeping(p));
  if (!candidates.length) {
    const dropped = raw.length;
    return {
      tier,
      status: 'skip',
      reason: dropped ? 'bookkeeping_only' : 'no_files_changed',
      detail: dropped ? `only session bookkeeping changed (${dropped} path${dropped === 1 ? '' : 's'})` : 'no files changed',
      focus_files: [],
    };
  }

  if (tier === 'quality') {
    return { tier, status: 'run', reason: 'quality_tier', detail: 'quality tier — cleanup always runs', focus_files: candidates };
  }

  // balanced — decide on the observed change, never on the proposal's prose.
  const category = resolveCategory(proposalFile);
  // Only structured candidates consult the root, and the loop usually breaks on a
  // code or instruction file first — so don't spawn `git rev-parse` for nothing.
  const root = candidates.some(isStructured) ? gitRoot(cwd) : null;
  let hit: { reason: string; detail: string } | null = null;
  for (const f of candidates) {
    if (isCode(f)) { hit = { reason: 'code_changed', detail: `code changed (${f})` }; break; }
    if (isInstruction(f)) { hit = { reason: 'instruction_changed', detail: `instruction text changed (${f})` }; break; }
    // No repo root means no diff to inspect, so the file cannot be proven value-only.
    if (isStructured(f) && (!root || !isValueOnlyChange(f, root))) { hit = { reason: 'structural_change', detail: `structural config changed (${f})` }; break; }
  }

  const suffix = category ? ` [category: ${category}]` : '';
  if (hit) {
    return { tier, status: 'run', reason: hit.reason, detail: hit.detail + suffix, focus_files: candidates };
  }

  return {
    tier,
    status: 'skip',
    reason: 'no_substantive_change',
    detail: `no code, instruction, or structural change among ${candidates.length} touched file${candidates.length === 1 ? '' : 's'}` + suffix,
    focus_files: [],
  };
}

/**
 * The first bare token, skipping any `--flag`'s value. Without the skip, a call
 * that omits the proposal file (`quality-gate <dir> --files-json '["a.ts"]'`)
 * would take the JSON payload as the proposal path.
 */
function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    return args[i];
  }
  return undefined;
}

export function run(stateDir: string, args: string[]): void {
  const proposalFile = firstPositional(args);

  let supplied: string[] | null = null;
  const filesJson = flagValue(args, '--files-json');
  if (filesJson) {
    try {
      const parsed = JSON.parse(filesJson);
      if (Array.isArray(parsed)) supplied = parsed.map(String).filter(Boolean);
    } catch {
      // Malformed payload falls through to the working-tree diff rather than
      // failing the call — the gate never blocks an implementation.
    }
  }

  const cwd = fs.existsSync(stateDir) ? path.dirname(path.resolve(stateDir)) : process.cwd();
  const verdict = decide(stateDir, proposalFile, supplied, cwd);
  process.stdout.write(JSON.stringify(verdict) + '\n');
}
