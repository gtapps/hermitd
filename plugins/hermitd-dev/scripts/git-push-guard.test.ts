// Tests for git-push-guard.ts
// Run with: bun scripts/git-push-guard.test.ts

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

type Json = any;

// findHermitDir() honors CLAUDE_PROJECT_DIR. These tests run inside a Claude Code
// session, where it names the real repo — every fixture below would resolve to the
// repo's own hermit state instead of its temp project. Scrub it for the whole file;
// the two cases that need it set pass it explicitly.
delete process.env.CLAUDE_PROJECT_DIR;

const GUARD = path.join(import.meta.dir, 'git-push-guard.ts');

let passed = 0;
let failed = 0;

function makeInput(command: string): string {
  return JSON.stringify({ tool_input: { command } });
}

function run(command: string, env: Json = {}) {
  return runRaw(makeInput(command), env);
}

function runRaw(rawInput: string, env: Json = {}, unset: string[] = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  const childEnv: Json = { ...process.env, ...env };
  for (const key of unset) delete childEnv[key];
  try {
    const result = spawnSync(process.execPath, [GUARD], {
      input: rawInput,
      env: childEnv,
      encoding: 'utf-8',
      cwd: tmpDir,
    });
    return result.status;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Run guard with a temporary config that sets custom protected branches
function runWithConfig(command: string, protectedBranches: string[], env: Json = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  try {
    const hermitDir = path.join(tmpDir, '.hermit');
    // state/ alongside config.json is what marks a real root: config.json on its
    // own is the worktree-projection shape, which findHermitDir walks past.
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(hermitDir, 'config.json'),
      JSON.stringify({ 'hermitd-dev': { protected_branches: protectedBranches } })
    );
    const result = spawnSync(process.execPath, [GUARD], {
      input: makeInput(command),
      env: { ...process.env, AGENT_HOOK_PROFILE: 'strict', ...env },
      encoding: 'utf-8',
      cwd: tmpDir,
    });
    return result.status;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Like runRaw but returns the full result so tests can assert on stderr.
function runCapture(command: string, env: Json = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  try {
    return spawnSync(process.execPath, [GUARD], {
      input: makeInput(command),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      cwd: tmpDir,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Build a throwaway git repo on `branch` (default main) and run the guard
// against it. `detach` checks out a detached HEAD; `guardCwd` runs the guard
// from a different directory (for `git -C <repo>` cases); `protectedBranches`
// seeds a hermit config inside the repo.
function runInGitRepo(
  command: string,
  opts: { branch?: string; detach?: boolean; guardCwd?: string; protectedBranches?: string[]; env?: Json } = {}
) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-repo-'));
  const extraDir = opts.guardCwd === 'other' ? fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cwd-')) : null;
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8', env: gitEnv });
  try {
    git(['init']);
    // Version-independent branch selection: works on an unborn HEAD.
    git(['symbolic-ref', 'HEAD', `refs/heads/${opts.branch || 'main'}`]);
    if (opts.detach) {
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x']);
      git(['checkout', '--detach']);
    }
    if (opts.protectedBranches) {
      const hermitDir = path.join(repo, '.hermit');
      fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
      fs.writeFileSync(
        path.join(hermitDir, 'config.json'),
        JSON.stringify({ 'hermitd-dev': { protected_branches: opts.protectedBranches } })
      );
    }
    const runCommand = command.replace(/__REPO__/g, repo);
    const result = spawnSync(process.execPath, [GUARD], {
      input: makeInput(runCommand),
      env: { ...process.env, AGENT_HOOK_PROFILE: 'strict', ...(opts.env || {}) },
      encoding: 'utf-8',
      cwd: extraDir || repo,
    });
    return result.status;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    if (extraDir) fs.rmSync(extraDir, { recursive: true, force: true });
  }
}

function assert(description: string, actual: number | null, expected: number) {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — expected exit ${expected}, got ${actual}`);
    failed++;
  }
}

function assertContains(description: string, haystack: string, needle: string) {
  if (haystack.includes(needle)) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — expected stderr to contain "${needle}", got: ${JSON.stringify(haystack)}`);
    failed++;
  }
}

function assertEmpty(description: string, haystack: string) {
  if (!haystack) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — expected empty stderr, got: ${JSON.stringify(haystack)}`);
    failed++;
  }
}

// --- Non-strict profile: everything passes through ---
console.log('\nNon-strict profile (AGENT_HOOK_PROFILE=standard):');
assert('--no-verify passes through', run('git commit --no-verify', { AGENT_HOOK_PROFILE: 'standard' }), 0);
assert('force push passes through', run('git push --force origin feature/x', { AGENT_HOOK_PROFILE: 'standard' }), 0);

console.log('\nNon-strict profile (AGENT_HOOK_PROFILE unset):');
assert('push to main passes through when unset', runRaw(makeInput('git push origin main'), {}, ['AGENT_HOOK_PROFILE']), 0);

// --- Strict profile: blocked commands ---
console.log('\nStrict profile — blocked:');
assert('--no-verify on commit is blocked', run('git commit --no-verify', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--no-verify on push is blocked', run('git push --no-verify origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('push to main is blocked', run('git push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('push to master is blocked', run('git push origin master', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force push to feature branch is blocked', run('git push --force origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('-f push to feature branch is blocked', run('git push -f origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('stacked -fu (force+set-upstream) push is blocked', run('git push -fu origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('stacked -uf push is blocked', run('git push -uf origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force-with-lease to main is blocked', run('git push --force-with-lease origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force-with-lease to master is blocked', run('git push --force-with-lease origin master', { AGENT_HOOK_PROFILE: 'strict' }), 2);

// --- Strict profile: allowed commands ---
console.log('\nStrict profile — allowed:');
assert('push to feature branch is allowed', run('git push origin feature/my-feature', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('non-git command is allowed', run('npm test', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('"main" in branch name like main-staging is allowed', run('git push origin main-staging', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// v0.3.0 policy: --force-with-lease to a non-protected branch with explicit refspec is the safe case.
assert('--force-with-lease to feature branch with refspec is allowed', run('git push --force-with-lease origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Edge cases (existing) ---
console.log('\nEdge cases:');
assert('empty stdin exits cleanly', runRaw('', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('malformed JSON exits cleanly', runRaw('not-json', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Parser improvements: git -C, env prefix, -c key=val ---
console.log('\nParser improvements:');
assert('git -C /path push origin main is blocked', run('git -C /some/path push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('git -C /path push to feature is allowed', run('git -C /some/path push origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('env GIT_SSH=x git push origin main is blocked', run('GIT_SSH=x git push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('git -c http.extraHeader=x push origin main is blocked', run('git -c http.extraHeader=foo push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);

// --- Chained commands ---
console.log('\nChained commands:');
assert('git checkout main && git push origin feature/x is allowed', run('git checkout main && git push origin feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('git push origin feature/x && git push origin main is blocked', run('git push origin feature/x && git push origin main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('git push origin feature/x; git push origin master is blocked', run('git push origin feature/x; git push origin master', { AGENT_HOOK_PROFILE: 'strict' }), 2);

// --- Refspec forms ---
console.log('\nRefspec forms:');
assert('HEAD:main refspec is blocked', run('git push origin HEAD:main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('HEAD:feature is allowed', run('git push origin HEAD:feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('+main force refspec is blocked', run('git push origin +main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('+feature force refspec is allowed', run('git push origin +feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert(':main delete-by-empty-source is blocked', run('git push origin :main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert(':feature delete-by-empty-source is allowed', run('git push origin :feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('refs/heads/main is blocked', run('git push origin refs/heads/main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('refs/heads/feature/x is allowed', run('git push origin refs/heads/feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
// Branches with "main" as a path segment (not the destination) must not be blocked.
assert('feature/main branch is allowed', run('git push origin feature/main', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('HEAD:feature/main refspec is allowed', run('git push origin HEAD:feature/main', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Delete and dangerous flags ---
console.log('\nDelete and dangerous flags:');
assert('--delete main is blocked', run('git push origin --delete main', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--delete feature/x is allowed', run('git push origin --delete feature/x', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('--mirror is blocked', run('git push --mirror origin', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--all is blocked', run('git push --all origin', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('-a is blocked', run('git push -a origin', { AGENT_HOOK_PROFILE: 'strict' }), 2);

// --- Plain push (no refspec) ---
console.log('\nPlain push:');
assert('git push origin (remote, no refspec) is allowed', run('git push origin', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Force-with-lease policy ---
console.log('\nForce-with-lease policy:');
assert('--force-with-lease without refspec is blocked', run('git push --force-with-lease origin', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force-with-lease alone (no remote) is blocked', run('git push --force-with-lease', { AGENT_HOOK_PROFILE: 'strict' }), 2);
assert('--force-with-lease to branch named with literal "push" word is allowed', run('git push --force-with-lease origin feature/push-button-fix', { AGENT_HOOK_PROFILE: 'strict' }), 0);

// --- Config-driven protected branches ---
console.log('\nConfig-driven protected branches:');
assert('release/1.2 blocked when release/* is protected', runWithConfig('git push origin release/1.2', ['release/*']), 2);
assert('release/1.2 allowed with default config', run('git push origin release/1.2', { AGENT_HOOK_PROFILE: 'strict' }), 0);
assert('staging blocked when staging is in config', runWithConfig('git push origin staging', ['main', 'staging']), 2);
assert('feature/x allowed with custom config', runWithConfig('git push origin feature/x', ['main', 'staging']), 0);

// --- Current-branch resolution (bare push / HEAD) ---
console.log('\nCurrent-branch resolution:');
assert('bare push on main is blocked', runInGitRepo('git push', { branch: 'main' }), 2);
assert('bare push on feature branch is allowed', runInGitRepo('git push', { branch: 'feature/x' }), 0);
assert('push origin HEAD on main is blocked', runInGitRepo('git push origin HEAD', { branch: 'main' }), 2);
assert('push origin HEAD on feature branch is allowed', runInGitRepo('git push origin HEAD', { branch: 'feature/x' }), 0);
assert('HEAD:main refspec from feature branch is still blocked', runInGitRepo('git push origin HEAD:main', { branch: 'feature/x' }), 2);
assert('HEAD:feature/y refspec from main is allowed (dest not protected)', runInGitRepo('git push origin HEAD:feature/y', { branch: 'main' }), 0);
assert('bare push on detached HEAD is allowed (fail open)', runInGitRepo('git push', { branch: 'main', detach: true }), 0);
assert('git -C <repo-on-main> push from elsewhere is blocked', runInGitRepo('git -C __REPO__ push', { branch: 'main', guardCwd: 'other' }), 2);
assert('bare push on staging blocked when staging is protected', runInGitRepo('git push', { branch: 'staging', protectedBranches: ['main', 'staging'] }), 2);

// --- Inactive-profile notice ---
console.log('\nInactive-profile notice:');
{
  const r = runCapture('git push origin main', { AGENT_HOOK_PROFILE: 'standard' });
  assert('non-strict push exits 0', r.status, 0);
  assertContains('non-strict push warns guard is inactive', r.stderr || '', 'inactive');
}
{
  const r = runCapture('npm test', { AGENT_HOOK_PROFILE: 'standard' });
  assert('non-strict non-push exits 0', r.status, 0);
  assertEmpty('non-strict non-push emits no notice', r.stderr || '');
}

// --- CLAUDE_PROJECT_DIR precedence (drifted cwd) ---
// The guard's config lookup used to start at process.cwd(); a session that had
// `cd`-ed anywhere outside the project silently lost operator protected_branches
// and fell back to the built-in main/master list.
console.log('\nCLAUDE_PROJECT_DIR precedence:');
{
  // A hatched project whose config protects release/*, and a drifted cwd outside it.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-proj-'));
  const drifted = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-drift-'));
  const hermitDir = path.join(proj, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(hermitDir, 'config.json'),
    JSON.stringify({ 'hermitd-dev': { protected_branches: ['release/prod'] } })
  );
  const guardFrom = (cwd: string, env: Json) =>
    spawnSync(process.execPath, [GUARD], {
      input: makeInput('git push origin release/prod'),
      env: { ...process.env, AGENT_HOOK_PROFILE: 'strict', ...env },
      encoding: 'utf-8',
      cwd,
    }).status;

  try {
    assert(
      'env-named project wins over a drifted cwd',
      guardFrom(drifted, { CLAUDE_PROJECT_DIR: proj }),
      2
    );
    assert(
      'stale env falls through to the walk-up',
      guardFrom(proj, { CLAUDE_PROJECT_DIR: path.join(os.tmpdir(), 'guard-no-such-dir') }),
      2
    );
    assert(
      'no env and a drifted cwd still degrades to the built-in list',
      guardFrom(drifted, {}),
      0
    );
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(drifted, { recursive: true, force: true });
  }
}

// --- Worktree projection ---
// `.worktreeinclude` copies config.json (never state/) into a `claude --worktree`
// worktree so skills can Read it at the relative path. Resolving THERE would hand
// the guard an empty config and silently drop the operator's protected_branches.
console.log('\nWorktree projection:');
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-wtproj-'));
  const hermitDir = path.join(proj, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(hermitDir, 'config.json'),
    JSON.stringify({ 'hermitd-dev': { protected_branches: ['release/prod'] } })
  );
  const wt = path.join(proj, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(path.join(wt, '.hermit'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.hermit', 'config.json'), JSON.stringify({}));

  const guardFrom = (cwd: string, env: Json) =>
    spawnSync(process.execPath, [GUARD], {
      input: makeInput('git push origin release/prod'),
      env: { ...process.env, AGENT_HOOK_PROFILE: 'strict', ...env },
      encoding: 'utf-8',
      cwd,
    }).status;

  try {
    assert('walk-up from a worktree reaches the main checkout config', guardFrom(wt, {}), 2);
    assert(
      'CLAUDE_PROJECT_DIR naming the worktree still reaches it',
      guardFrom(wt, { CLAUDE_PROJECT_DIR: wt }),
      2
    );
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

// --- False positives: "git" and "push" appearing inside a filename/argument,
// never as an actual `git ... push` invocation ---
console.log('\nFalse positives (no real git push invocation):');
{
  const claudeArgs = "claude --bg --worktree tackle-task-prop-301-1790285463 --name tackle-task-prop-301-1790285463 " +
    "--permission-mode auto --remote-control tackle-task-prop-301-1790285463 --model fable --effort high " +
    "--append-system-prompt-file /tmp/helper-system-prompt.md " +
    "'/tackle-task @/tmp/proposals/PROP-301-tech-debt-git-push-guard-222133.md'";
  assert(
    'claude --bg command whose only "git"/"push" occurrence is inside a proposal filename is allowed',
    run(claudeArgs, { AGENT_HOOK_PROFILE: 'strict' }),
    0
  );
}

{
  const start = performance.now();
  run('git' + ' -a'.repeat(40) + ' status', { AGENT_HOOK_PROFILE: 'strict' });
  assert('many global flags without push resolves fast (no backtracking blowup)', performance.now() - start < 2000 ? 0 : 1, 0);
}

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
