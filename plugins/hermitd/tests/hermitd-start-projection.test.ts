import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory, writeConfig } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-start-projection-');
afterAll(cleanup);

test('hermitd-start refuses to boot in a projection and creates no state there', async () => {
  const root = freshDir();
  const nested = path.join(root, 'nested');
  const projection = path.join(nested, '.hermit');
  writeConfig(root, {});
  writeConfig(nested, {});
  fs.mkdirSync(path.join(root, '.hermit', 'state'));

  const result = await runScript('hermitd-start.ts', {
    cwd: nested,
    args: ['--no-tmux'],
    env: { AGENT_DIR: '', CLAUDE_PROJECT_DIR: '' },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain(`inside the agent project at ${root}`);
  expect(fs.existsSync(path.join(projection, 'state'))).toBe(false);
});

test('hermitd-stop refuses to run in a projection and creates no state there', async () => {
  const root = freshDir();
  const nested = path.join(root, 'nested');
  writeConfig(root, {});
  writeConfig(nested, {});
  fs.mkdirSync(path.join(root, '.hermit', 'state'));

  const result = await runScript('hermitd-stop.ts', {
    cwd: nested,
    env: { AGENT_DIR: '', CLAUDE_PROJECT_DIR: '' },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain(`inside the agent project at ${root}`);
  expect(fs.existsSync(path.join(nested, '.hermit', 'state'))).toBe(false);
});

test('hermitd-watchdog refuses to run in a projection and creates no state there', async () => {
  const root = freshDir();
  const nested = path.join(root, 'nested');
  writeConfig(root, {});
  writeConfig(nested, {});
  fs.mkdirSync(path.join(root, '.hermit', 'state'));

  const result = await runScript('hermitd-watchdog.ts', {
    cwd: nested,
    args: ['run'],
    env: { AGENT_DIR: '', CLAUDE_PROJECT_DIR: '' },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain(`inside the agent project at ${root}`);
  expect(fs.existsSync(path.join(nested, '.hermit', 'state'))).toBe(false);
});
