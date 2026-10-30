import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-doctor-projection-');
afterAll(cleanup);

test('doctor reports on the real root without creating state in a projection', async () => {
  const root = freshDir();
  const realHermit = path.join(root, '.hermit');
  const nested = path.join(root, 'nested');
  const projection = path.join(nested, '.hermit');
  fs.mkdirSync(path.join(realHermit, 'state'), { recursive: true });
  fs.mkdirSync(projection, { recursive: true });
  fs.writeFileSync(path.join(realHermit, 'config.json'), '{}');
  fs.writeFileSync(path.join(projection, 'config.json'), '{}');
  fs.writeFileSync(path.join(realHermit, 'state', 'broken.json'), '{');

  const result = await runScript('doctor-check.ts', {
    cwd: nested,
    args: ['.hermit'],
    env: { AGENT_DIR: '', CLAUDE_PROJECT_DIR: '' },
  });

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(fs.readFileSync(path.join(realHermit, 'state', 'doctor-report.json'), 'utf8'));
  expect(JSON.parse(result.stdout)).toEqual(report);
  expect(report.checks.find((check: { id: string }) => check.id === 'state').detail).toContain('broken.json');
  expect(fs.existsSync(path.join(projection, 'state'))).toBe(false);
});

test('doctor retains a state directory that fails the pin', async () => {
  const root = freshDir();
  const localHermit = path.join(root, '.hermit');
  const foreignHermit = path.join(root, 'foreign', '.hermit');
  fs.mkdirSync(path.join(localHermit, 'state'), { recursive: true });
  fs.mkdirSync(path.join(foreignHermit, 'state'), { recursive: true });
  fs.writeFileSync(path.join(localHermit, 'config.json'), '{}');
  fs.writeFileSync(path.join(foreignHermit, 'config.json'), '{}');

  const result = await runScript('doctor-check.ts', {
    cwd: root,
    args: [foreignHermit],
    env: { AGENT_DIR: '', CLAUDE_PROJECT_DIR: '' },
  });

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(fs.readFileSync(path.join(foreignHermit, 'state', 'doctor-report.json'), 'utf8'));
  expect(JSON.parse(result.stdout)).toEqual(report);
  expect(fs.existsSync(path.join(localHermit, 'state', 'doctor-report.json'))).toBe(false);
});
