// `hermitd-run memory-dir` — the one place the auto-memory directory is derived.
//
// Claude Code keys the directory off the absolute project root with every
// non-alphanumeric character replaced by '-' (dots included) and honours
// CLAUDE_CONFIG_DIR. These pin both, so a consumer that used to derive the path
// in prose can point here instead.
//
// Usage: bun test tests/memory-dir.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { transcriptPathKey, resolvedMemoryDir } from '../scripts/lib/cc-compat';

const { freshDir, cleanup } = freshDirFactory('hermit-memdir-');
afterAll(cleanup);

// CLAUDE_CONFIG_DIR is pinned to a scratch dir: runScript merges process.env, so a
// maintainer whose own config dir is set would otherwise resolve somewhere else.
async function run(args: string[], configDir: string, cwd?: string) {
  const r = await runScript('memory-dir.ts', {
    args,
    cwd,
    env: { CLAUDE_CONFIG_DIR: configDir, AGENT_DIR: '', CLAUDE_PROJECT_DIR: '' },
  });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe('memory-dir.ts', () => {
  test('a dotted root keys every non-alphanumeric character to "-"', async () => {
    const configDir = freshDir();
    const root = path.join(freshDir(), 'my.project');
    fs.mkdirSync(root, { recursive: true });

    const out = await run([root], configDir);
    expect(out.dir).toBe(path.join(configDir, 'projects', transcriptPathKey(root), 'memory'));
    expect(path.basename(path.dirname(out.dir))).not.toContain('.');
  });

  test('exists flips false → true once the directory is created', async () => {
    const configDir = freshDir();
    const root = freshDir();

    const before = await run([root], configDir);
    expect(before.exists).toBe(false);

    fs.mkdirSync(before.dir, { recursive: true });
    const after = await run([root], configDir);
    expect(after).toEqual({ dir: before.dir, exists: true });
  });

  test('no argument keys on the current working directory', async () => {
    const configDir = freshDir();
    const root = freshDir();

    const out = await run([], configDir, root);
    expect(out.dir).toBe(path.join(configDir, 'projects', transcriptPathKey(fs.realpathSync(root)), 'memory'));
  });

  test('no argument keys on the hermit root above cwd', async () => {
    const configDir = freshDir();
    const fixture = freshDir();
    const hermit = path.join(fixture, '.hermit');
    fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
    fs.writeFileSync(path.join(hermit, 'config.json'), '{}');
    const sub = path.join(fixture, 'sub');
    fs.mkdirSync(sub);

    const out = await run([], configDir, sub);
    expect(out.dir).toBe(path.join(configDir, 'projects', transcriptPathKey(fs.realpathSync(fixture)), 'memory'));
  });
});


describe('resolvedMemoryDir', () => {
  test('refuses project overrides, ancestor git roots and all settings overrides', () => {
    const root = freshDir();
    const dir = path.join(root, '.hermit');
    const configDir = freshDir();
    const priorConfig = process.env.CLAUDE_CONFIG_DIR;
    const priorName = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    try {
      fs.mkdirSync(dir);
      expect(resolvedMemoryDir(dir)).toBe(path.join(configDir, 'projects', transcriptPathKey(root), 'memory'));
      process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'override';
      expect(resolvedMemoryDir(dir)).toBeNull();
      delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
      fs.mkdirSync(path.join(root, '.git'));
      const nested = path.join(root, 'nested', '.hermit');
      fs.mkdirSync(nested, { recursive: true });
      expect(resolvedMemoryDir(nested)).toBeNull();
      for (const file of [path.join(configDir, 'settings.json'), path.join(root, '.claude/settings.json'),
        path.join(root, '.claude/settings.local.json'), path.join(dir, 'claude-settings.json')]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ autoMemoryDirectory: '/custom' }));
        expect(resolvedMemoryDir(dir)).toBeNull();
        fs.unlinkSync(file);
      }
    } finally {
      if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = priorConfig;
      if (priorName === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
      else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = priorName;
    }
  });
});
