import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { updateClaudeState, withClaudeStateLock } from '../scripts/lib/claude-state';
import { trustWorkspace } from '../scripts/trust-workspace';
import { freshDirFactory } from './helpers/workdir';
import { runPinnedScript, runScript } from './helpers/run';

const { freshDir, cleanup } = freshDirFactory('hermit-trust-');
afterAll(cleanup);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'fixture');
}

function fixture() {
  const root = freshDir();
  const state = path.join(root, '.hermit');
  const clone = path.join(root, 'clone');
  fs.mkdirSync(state);
  repo(clone);
  return { root, state, clone };
}

async function check(state: string, dir: string) {
  const result = await runPinnedScript('trust-workspace.ts', state, ['check', state, dir], {
    cwd: path.dirname(state), env: { GIT_CEILING_DIRECTORIES: path.dirname(state) },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

async function apply(state: string, dir: string, config: string) {
  const result = await runPinnedScript('trust-workspace.ts', state, ['apply', state, dir], {
    cwd: path.dirname(state), env: { CLAUDE_CONFIG_DIR: config, GIT_CEILING_DIRECTORIES: path.dirname(state) },
  });
  expect(result.stderr).toBe('');
  return { ...result, verdict: JSON.parse(result.stdout) };
}

/** Points the Claude state file at a fresh directory and stubs the settle wait. */
async function withStateFile(
  run: (file: string, sleep: { mock: { calls: unknown[] } }) => Promise<void>,
  onSleep: (file: string) => void = () => {},
): Promise<void> {
  const config = freshDir();
  const file = path.join(config, '.claude.json');
  const original = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async () => onSleep(file));
  try {
    await run(file, sleep);
  } finally {
    sleep.mockRestore();
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
  }
}

const emptyActivates = { hooks: [], allow_rules: [], additional_directories: [], env_keys: [],
  helper_commands: [], mcp_commands: [], agent_hooks: [], unreadable: [], truncated: false };

describe('Claude state writer', () => {
  test('waits for a held lock, writes, and leaves the lock in place', () => {
    const file = path.join(freshDir(), '.claude.json');
    fs.mkdirSync(`${file}.lock`);
    const start = Date.now();
    expect(updateClaudeState((state) => { state.value = true; return true; }, file)).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: true });
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
  }, 5000);

  test('releases its own lock on failure', () => {
    const file = path.join(freshDir(), '.claude.json');
    expect(() => withClaudeStateLock(file, () => fs.writeFileSync(path.join(file, 'missing'), 'data'))).toThrow();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  test('preserves the existing file mode', () => {
    const file = path.join(freshDir(), '.claude.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o666);
    updateClaudeState((state) => { state.value = true; return true; }, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o666);
  });
});

describe('trust-workspace check', () => {
  test('reports repository config and MCP names without writing', async () => {
    const { state, clone } = fixture();
    fs.mkdirSync(path.join(clone, '.claude'));
    fs.writeFileSync(path.join(clone, '.claude/settings.json'), '{}');
    fs.writeFileSync(path.join(clone, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }));
    const before = git(clone, 'status', '--short');
    expect(await check(state, clone)).toEqual({
      status: 'eligible', activates: emptyActivates, key: clone,
      repo_config: ['.claude/settings.json', '.mcp.json'], mcp_servers: ['alpha', 'beta'],
    });
    expect(git(clone, 'status', '--short')).toBe(before);
  });

  test('refuses outside, root, home, sibling-prefix and symlink escapes', async () => {
    const { root, state } = fixture();
    const outside = freshDir();
    repo(path.join(outside, 'repo'));
    const prefix = `${root}-sibling`;
    fs.mkdirSync(prefix);
    try {
      fs.symlinkSync(path.join(outside, 'repo'), path.join(root, 'escape'));
      for (const dir of ['/', process.env.HOME!, prefix, path.join(root, 'escape')]) {
        expect(await check(state, dir)).toEqual({ status: 'refused', reason: 'outside_launch_root' });
      }
    } finally {
      fs.rmdirSync(prefix);
    }
  });

  test('refuses a non-repository and tracked local settings when MCP servers exist', async () => {
    const { root, state, clone } = fixture();
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await check(state, plain)).toEqual({ status: 'refused', reason: 'not_a_repository' });
    fs.mkdirSync(path.join(clone, '.claude'));
    fs.writeFileSync(path.join(clone, '.claude/settings.local.json'), '{}');
    fs.writeFileSync(path.join(clone, '.mcp.json'), '{"mcpServers":{"server":{}}}');
    git(clone, 'add', '-f', '.claude/settings.local.json');
    expect(await check(state, clone)).toEqual({ status: 'refused', reason: 'local_settings_tracked' });
  });

  test('refuses a repository subfolder, whose configuration differs from the root', async () => {
    const { state, clone } = fixture();
    const sub = path.join(clone, 'packages/app');
    fs.mkdirSync(path.join(sub, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.claude/settings.json'), '{"hooks":{}}');
    expect(await check(state, sub)).toEqual({ status: 'refused', reason: 'not_repository_root' });
  });

  test('does not run a repository fsmonitor hook before approval', async () => {
    const { root, state, clone } = fixture();
    const marker = path.join(root, 'hook-ran');
    const hook = path.join(root, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(clone, 'tracked'), 'data');
    git(clone, 'add', 'tracked');
    git(clone, 'config', 'core.fsmonitor', hook);
    fs.writeFileSync(path.join(clone, '.mcp.json'), '{"mcpServers":{"server":{}}}');
    await check(state, clone);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('linked worktrees key on the main checkout and reject an outside main checkout', async () => {
    const { root, state, clone } = fixture();
    const worktree = path.join(root, 'worktree');
    git(clone, 'worktree', 'add', '-q', '--detach', worktree);
    expect(await check(state, worktree)).toEqual({ status: 'eligible', activates: emptyActivates, key: clone, repo_config: [], mcp_servers: [] });
    const outside = path.join(freshDir(), 'outside');
    repo(outside);
    const foreignWorktree = path.join(root, 'foreign-worktree');
    git(outside, 'worktree', 'add', '-q', '--detach', foreignWorktree);
    expect(await check(state, foreignWorktree)).toEqual({ status: 'refused', reason: 'outside_launch_root' });
  });

  test('submodules retain their own toplevel', async () => {
    const { state, clone } = fixture();
    const source = path.join(freshDir(), 'source');
    repo(source);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub');
    expect(await check(state, path.join(clone, 'sub'))).toEqual({
      status: 'eligible', activates: emptyActivates, key: path.join(clone, 'sub'), repo_config: [], mcp_servers: [],
    });
  });

  test('usage errors have a single JSON verdict', async () => {
    const result = await runScript('trust-workspace.ts', { args: ['check'] });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: 'usage' });
  });
});

describe('trustWorkspace', () => {
  test('records fresh trust and preserves existing projects and fields', () => withStateFile(async (file, sleep) => {
    expect(await trustWorkspace('/fresh', { settleMs: 0 })).toBe(1);
    fs.writeFileSync(file, JSON.stringify({
      other: true, projects: { '/sibling': { kept: true }, '/repo': { hasTrustDialogAccepted: false, extra: 1 } },
    }));
    expect(await trustWorkspace('/repo', { settleMs: 0 })).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      other: true, projects: { '/sibling': { kept: true }, '/repo': { hasTrustDialogAccepted: true, extra: 1 } },
    });
    expect(sleep.mock.calls).toHaveLength(2);
  }));

  test('already trusted still settles without rewriting', () => withStateFile(async (file, sleep) => {
    fs.writeFileSync(file, '{"projects":{"/repo":{"hasTrustDialogAccepted":true}}}');
    const before = fs.statSync(file);
    expect(await trustWorkspace('/repo', { settleMs: 0 })).toBe(0);
    expect(sleep.mock.calls).toHaveLength(1);
    expect(fs.statSync(file).ino).toBe(before.ino);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  }));

  for (const losses of [1, 2]) {
    test(`retries after ${losses} lost write${losses === 1 ? '' : 's'}`, () => {
      let waits = 0;
      return withStateFile(async () => {
        if (losses === 1) expect(await trustWorkspace('/repo', { settleMs: 0 })).toBe(2);
        else await expect(trustWorkspace('/repo', { settleMs: 0 })).rejects.toThrow('seed_lost');
        expect(waits).toBe(2);
      }, (file) => {
        if (++waits <= losses) fs.writeFileSync(file, '{"projects":{}}');
      });
    });
  }
});

describe('trust-workspace apply', () => {
  test('merges MCP approvals and adds the git exclude once', async () => {
    const { state, clone } = fixture();
    const config = freshDir();
    fs.mkdirSync(path.join(clone, '.claude'));
    fs.writeFileSync(path.join(clone, '.claude/settings.local.json'), '{"custom":true,"enabledMcpjsonServers":["old","alpha"]}');
    fs.writeFileSync(path.join(clone, '.mcp.json'), '{"mcpServers":{"alpha":{},"beta":{}}}');
    const first = await apply(state, clone, config);
    expect(first.exitCode).toBe(0);
    expect(first.verdict).toEqual({ status: 'recorded', key: clone, writes: 1, mcp_approved: ['alpha', 'beta'] });
    const second = await apply(state, clone, config);
    expect(second.exitCode).toBe(0);
    expect(second.verdict).toEqual({ status: 'recorded', key: clone, writes: 0, mcp_approved: ['alpha', 'beta'] });
    expect(JSON.parse(fs.readFileSync(path.join(clone, '.claude/settings.local.json'), 'utf8'))).toEqual({
      custom: true, enabledMcpjsonServers: ['old', 'alpha', 'beta'],
    });
    const exclude = path.resolve(clone, git(clone, 'rev-parse', '--git-path', 'info/exclude'));
    expect(fs.readFileSync(exclude, 'utf8').split('\n').filter((s) => s === '/.claude/settings.local.json')).toHaveLength(1);
    expect(git(clone, 'status', '--short', '--', '.claude/settings.local.json')).toBe('');
  }, 10000);

  test('a linked worktree reports and approves its own configuration', async () => {
    const { root, state, clone } = fixture();
    const config = freshDir();
    const worktree = path.join(root, 'worktree');
    git(clone, 'worktree', 'add', '-q', '--detach', worktree);
    fs.writeFileSync(path.join(clone, '.mcp.json'), '{"mcpServers":{"main-server":{}}}');
    fs.writeFileSync(path.join(worktree, '.mcp.json'), '{"mcpServers":{"worktree-server":{}}}');
    expect(await check(state, worktree)).toEqual({
      status: 'eligible', activates: emptyActivates, key: clone, repo_config: ['.mcp.json'], mcp_servers: ['worktree-server'],
    });
    const applied = await apply(state, worktree, config);
    expect(applied.verdict).toEqual({ status: 'recorded', key: clone, writes: 1, mcp_approved: ['worktree-server'] });
    expect(JSON.parse(fs.readFileSync(path.join(worktree, '.claude/settings.local.json'), 'utf8'))).toEqual({
      enabledMcpjsonServers: ['worktree-server'],
    });
    expect(fs.existsSync(path.join(clone, '.claude/settings.local.json'))).toBe(false);
    expect(git(worktree, 'status', '--short', '--', '.claude/settings.local.json')).toBe('');
  }, 10000);

  test('malformed MCP, local settings, and state stay byte-identical', async () => {
    const { state, clone } = fixture();
    const config = freshDir();
    const mcp = path.join(clone, '.mcp.json');
    const local = path.join(clone, '.claude/settings.local.json');
    const stateFile = path.join(config, '.claude.json');
    fs.mkdirSync(path.dirname(local));
    fs.writeFileSync(mcp, '{broken-mcp');
    let result = await apply(state, clone, config);
    expect(result.exitCode).toBe(1);
    expect(result.verdict).toEqual({ error: 'invalid_mcp_config' });
    expect(fs.readFileSync(mcp, 'utf8')).toBe('{broken-mcp');
    fs.writeFileSync(mcp, '{"mcpServers":{"alpha":{}}}');
    fs.writeFileSync(local, '{broken-local');
    result = await apply(state, clone, config);
    expect(result.exitCode).toBe(1);
    expect(result.verdict).toEqual({ error: 'invalid_local_settings' });
    expect(fs.readFileSync(local, 'utf8')).toBe('{broken-local');
    fs.writeFileSync(local, '{"keep":true}');
    fs.writeFileSync(stateFile, '{broken-state');
    result = await apply(state, clone, config);
    expect(result.exitCode).toBe(1);
    expect(result.verdict).toEqual({ error: 'invalid_state' });
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('{broken-state');
    expect(fs.readFileSync(local, 'utf8')).toBe('{"keep":true}');
  });
});


test('check discloses bounded settings and agent hooks without env values or execution', async () => {
  const { state, clone } = fixture();
  fs.mkdirSync(path.join(clone, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(clone, '.claude/settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hook' }] }] },
    permissions: { allow: ['Bash(echo *)'], additionalDirectories: ['/extra'] },
    env: { SECRET: 'never-disclose' }, apiKeyHelper: 'echo helper',
  }));
  fs.writeFileSync(path.join(clone, '.claude/settings.local.json'), '{bad');
  fs.writeFileSync(path.join(clone, '.mcp.json'), JSON.stringify({ mcpServers: { server: { command: 'echo', args: ['mcp'] } } }));
  fs.writeFileSync(path.join(clone, '.claude/agents/helper.md'), '---\nname: helper\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: echo agent\n---\n');
  const result = await check(state, clone);
  expect(result.activates).toMatchObject({ allow_rules: ['Bash(echo *)'], additional_directories: ['/extra'], env_keys: ['SECRET'], unreadable: ['.claude/settings.local.json'], truncated: false });
  expect(result.activates.hooks.join()).toContain('echo hook');
  expect(result.activates.helper_commands.join()).toContain('echo helper');
  expect(result.activates.mcp_commands.join()).toContain('mcp');
  expect(result.activates.agent_hooks.join()).toContain('echo agent');
  expect(JSON.stringify(result)).not.toContain('never-disclose');
  fs.writeFileSync(path.join(clone, '.claude/settings.json'), JSON.stringify({ permissions: { allow: Array(25).fill('x'.repeat(600)) } }));
  const capped = (await check(state, clone)).activates;
  expect(capped.truncated).toBe(true);
  expect(capped.allow_rules).toHaveLength(20);
  expect(capped.allow_rules.every((rule: string) => rule.length <= 500)).toBe(true);
});
