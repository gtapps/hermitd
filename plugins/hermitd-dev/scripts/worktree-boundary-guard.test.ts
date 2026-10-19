// Run with: bun scripts/worktree-boundary-guard.test.ts
//
// Builds a real git fixture (main repo + linked worktree mirroring `.claude/worktrees/<name>/`)
// so the guard's git-based detection runs against actual worktree state, not a mock.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

type Json = any;

const GUARD = path.join(import.meta.dir, 'worktree-boundary-guard.ts');

let passed = 0;
let failed = 0;

function assert(description: string, actual: number | null, expected: number) {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — expected exit ${expected}, got ${actual}`);
    failed++;
  }
}

function spawnGuard(rawInput: string, cwd: string, env: Json = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: rawInput,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    cwd,
  });
}

function runRaw(rawInput: string, cwd: string, env: Json = {}) {
  return spawnGuard(rawInput, cwd, env).status;
}

function runEdit(filePath: string, cwd: string, env: Json = {}) {
  return runRaw(JSON.stringify({ tool_input: { file_path: filePath } }), cwd, env);
}

function blockReason(filePath: string, cwd: string): string {
  return spawnGuard(JSON.stringify({ tool_input: { file_path: filePath } }), cwd).stderr || '';
}

function assertIncludes(description: string, haystack: string, needle: string) {
  if (haystack.includes(needle)) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
    failed++;
  }
}

// --- Fixture: main repo + nested linked worktree ---
// realpathSync resolves any /tmp symlink so paths match `git rev-parse` output exactly.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtguard-')));
const mainRepo = path.join(tmp, 'main');
fs.mkdirSync(mainRepo);

function g(args: string[], cwd = mainRepo) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

try {
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 'tester']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(mainRepo, 'README.md'), 'x');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);

  const wt = path.join(mainRepo, '.claude', 'worktrees', 'wt');
  g(['worktree', 'add', '-q', '-b', 'wt-branch', wt]);

  console.log('\nWorktree session:');
  assert('edit inside the worktree is allowed', runEdit(path.join(wt, 'src', 'a.js'), wt), 0);
  assert('relative path inside the worktree is allowed', runEdit('src/a.js', wt), 0);
  assert('edit into main source is blocked', runEdit(path.join(mainRepo, 'plugins', 'x.js'), wt), 2);
  assert('relative path escaping into main is blocked', runEdit('../../../README.md', wt), 2);
  // Background-session recovery coaching is actionable when this guard fires.
  assertIncludes('block reason carries background-session retry coaching',
    blockReason(path.join(mainRepo, 'plugins', 'x.js'), wt), 're-attempt the edit');
  assert('write to main .hermit/ is allowed (carve-out)', runEdit(path.join(mainRepo, '.hermit', 'state', 'execution.json'), wt), 0);
  assert('edit to an unrelated path outside the repo is allowed', runEdit(path.join(tmp, 'elsewhere', 'note.txt'), wt), 0);
  assert('WORKTREE_GUARD=off disables the guard', runEdit(path.join(mainRepo, 'plugins', 'x.js'), wt, { WORKTREE_GUARD: 'off' }), 0);

  console.log('\nMain session (guard inert):');
  assert('edit in the main checkout is allowed from main', runEdit(path.join(mainRepo, 'plugins', 'x.js'), mainRepo), 0);

  console.log('\nEdge cases:');
  assert('not a git repo exits cleanly', runEdit(path.join(tmp, 'x.txt'), tmp), 0);
  assert('empty stdin exits cleanly', runRaw('', wt), 0);
  assert('malformed JSON exits cleanly', runRaw('not-json', wt), 0);
  assert('missing file_path exits cleanly', runRaw(JSON.stringify({ tool_input: {} }), wt), 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
