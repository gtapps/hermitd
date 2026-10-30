import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { LearnedSkills } from '../scripts/lib/learned-skills';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('skills-cli-');
afterAll(cleanup);
test('skills commands refuse operator skills and provide reversible bounded controls', async () => {
  const dir = freshDir(); const hermit = path.join(dir, '.hermit'); fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  const lib = new LearnedSkills(hermit); const folder = lib.skillDir('sample'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), 'before');
  const run = (...args: string[]) => runScript('skills.ts', { args, cwd: dir, env: { AGENT_DIR: hermit } });
  expect(JSON.parse((await run('pin', 'sample')).stdout).reason).toBe('not_learned');
  lib.record('sample', 'create'); lib.saveRevision('sample'); fs.writeFileSync(path.join(folder, 'SKILL.md'), 'after');
  expect((await run('pin', 'sample', '--origin', 'operator')).stdout).toBe('OK\n');
  expect(lib.ledger().at(-1)?.origin).toBe('operator');
  expect((await run('pin', 'sample')).exitCode).toBe(0);
  expect((await run('unpin', 'sample')).stdout).toBe('OK\n');
  expect((await run('rollback', 'sample')).stdout).toBe('OK\n');
  expect(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8')).toBe('before');
  expect(JSON.parse((await run('rollback', 'sample')).stdout).reason).toBe('no_revision');
  expect((await run('archive', 'sample')).stdout).toBe('OK\n'); expect(fs.existsSync(folder)).toBe(false);
  expect((await run('restore', 'sample')).stdout).toBe('OK\n'); expect(fs.existsSync(folder)).toBe(true);
  for (let n = 0; n < 15; n++) lib.record('sample', 'patch');
  const status = JSON.parse((await run('status', '--skill', 'sample')).stdout);
  expect(status.learned).toBe(1); expect(status.recent.length).toBe(10); expect(status.is_learned).toBe(true);
  expect((await run('status', '--skill', '../escape')).exitCode).toBe(1);
});

test('skill status reports the newest matching use and null for unknown use', async () => {
  const dir = freshDir(); const hermit = path.join(dir, '.hermit');
  const state = path.join(hermit, 'state'); const configDir = path.join(dir, 'test-claude');
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(state, 'runtime.json'), JSON.stringify({ config_dir: configDir }));
  const run = (...args: string[]) => runScript('skills.ts', { args, cwd: dir, env: { AGENT_DIR: hermit } });
  const newest = '2026-03-04T05:06:07.000Z';
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ skillUsage: {
    sample: { lastUsedAt: '2026-01-01T00:00:00.000Z' },
    'plugin:sample': { lastUsedAt: newest },
    '.claude/worktrees/example:sample': { lastUsedAt: '2026-02-01T00:00:00.000Z' },
    'plugin:not-sample': { lastUsedAt: '2027-01-01T00:00:00.000Z' },
  } }));
  expect(JSON.parse((await run('status', '--skill', 'sample')).stdout).last_used_at).toBe(newest);
  expect(JSON.parse((await run('status', '--skill', 'missing')).stdout).last_used_at).toBeNull();
  expect(JSON.parse((await run('status')).stdout)).not.toHaveProperty('last_used_at');
  fs.writeFileSync(path.join(configDir, '.claude.json'), '{');
  expect(JSON.parse((await run('status', '--skill', 'sample')).stdout).last_used_at).toBeNull();
  // No CLAUDE_CONFIG_DIR at launch stamps no config_dir, leaving Claude Code's default file.
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ skillUsage: { sample: { lastUsedAt: newest } } }));
  fs.writeFileSync(path.join(state, 'runtime.json'), '{}');
  const fallback = await runScript('skills.ts', { args: ['status', '--skill', 'sample'], cwd: dir, env: { AGENT_DIR: hermit, CLAUDE_CONFIG_DIR: configDir } });
  expect(JSON.parse(fallback.stdout).last_used_at).toBe(newest);
});
