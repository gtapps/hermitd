import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-helper-switch-');
afterAll(cleanup);
const saved = {
  respawnFlags: ['--name', 'review', '--model', 'opus', '--remote-control', '--worktree', 'review', '--mcp-config', "/tmp/helper's folder/mcp.json"],
  resumeSessionId: 'session-id', cwd: '/project', worktreePath: '/project/worktree',
};
function writeState(dir: string, state: unknown) {
  const job = path.join(dir, 'jobs', 'a1b2c3d4');
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state));
}
async function run(state: unknown, args = ['--model', 'sonnet']) {
  const dir = freshDir();
  writeState(dir, state);
  const result = await runScript('helper-switch.ts', { args: ['a1b2c3d4', ...args], env: { CLAUDE_CONFIG_DIR: dir } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout);
}
test('swaps model, preserves valueless flags and quoted paths, and drops worktree', async () => {
  expect(await run(saved)).toEqual({
    verdict: 'ok', sid: 'session-id', name: 'review', cwd: '/project/worktree',
    flags: "'--name' 'review' '--model' 'sonnet' '--remote-control' '--mcp-config' '/tmp/helper'\\''s folder/mcp.json'",
  });
});
test('appends effort and uses a copy cwd', async () => {
  const result = await run({ ...saved, worktreePath: null }, ['--effort', 'xhigh']);
  expect(result.cwd).toBe('/project');
  expect(result.flags).toEndWith("'--effort' 'xhigh'");
  expect(result.flags).toContain("'--model' 'opus'");
});
test('appends model and replaces effort', async () => {
  const result = await run({ ...saved, respawnFlags: ['--name', 'review', '--effort', 'low'] }, ['--model', 'sonnet', '--effort', 'max']);
  expect(result.flags).toBe("'--name' 'review' '--effort' 'max' '--model' 'sonnet'");
});
for (const [label, state, args] of [
  ['no change', saved, []],
  ['invalid effort', saved, ['--effort', 'turbo']],
  ['invalid model', saved, ['--model', 'bad;model']],
  ['flag-shaped model', saved, ['--model', '-p']],
  ['missing model', saved, ['--model']],
  ['missing effort', saved, ['--effort']],
  ['missing state', null, ['--model', 'sonnet']],
  ['missing flags', { ...saved, respawnFlags: null }, ['--model', 'sonnet']],
  ['non-string flags', { ...saved, respawnFlags: [1] }, ['--model', 'sonnet']],
  ['missing name', { ...saved, respawnFlags: [] }, ['--model', 'sonnet']],
  ['missing sid', { ...saved, resumeSessionId: null }, ['--model', 'sonnet']],
] as const) {
  test(`refuses ${label}`, async () => {
    const result = await run(state, [...args]);
    expect(result.verdict).toBe('refuse');
    expect(result.reason).not.toContain('\n');
  });
}
test('refuses unreadable JSON and missing file', async () => {
  const dir = freshDir();
  for (const corrupt of [false, true]) {
    if (corrupt) {
      writeState(dir, saved);
      fs.writeFileSync(path.join(dir, 'jobs/a1b2c3d4/state.json'), '{');
    }
    const result = await runScript('helper-switch.ts', { args: ['a1b2c3d4', '--model', 'sonnet'], env: { CLAUDE_CONFIG_DIR: dir } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe('refuse');
  }
});
test('CLAUDE_CONFIG_DIR wins over HOME/.claude', async () => {
  const dir = freshDir();
  const home = freshDir();
  writeState(dir, saved);
  writeState(path.join(home, '.claude'), { ...saved, resumeSessionId: 'wrong-session' });
  const result = await runScript('helper-switch.ts', { args: ['a1b2c3d4', '--model', 'sonnet'], env: { CLAUDE_CONFIG_DIR: dir, HOME: home } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).sid).toBe('session-id');
});
