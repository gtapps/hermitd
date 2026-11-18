import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, type RunResult } from './helpers/run';

let project: string;
let hermitDir: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-request-restart-'));
  hermitDir = path.join(project, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'bin'), { recursive: true });
});

afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

async function withWatchdog(run: () => Promise<RunResult>) {
  fs.writeFileSync(path.join(hermitDir, 'bin', 'hermitd-watchdog'), `#!/bin/sh
printf '%s\\n' "$1" "$2" "$$" "$(ps -o pgid= -p "$$")" > watchdog.tmp
mv watchdog.tmp watchdog.receipt
`, { mode: 0o700 });

  const receipt = (async () => {
    const receiptPath = path.join(project, 'watchdog.receipt');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      // The stub publishes the completed receipt by rename.
      if (fs.existsSync(receiptPath)) return fs.readFileSync(receiptPath, 'utf8').trim().split('\n').map(line => line.trim());
      await Bun.sleep(10);
    }
    throw new Error('missing watchdog receipt');
  })();

  const [out, [verb, reason, pid, pgid]] = await Promise.all([run(), receipt]);
  expect(verb).toBe('restart');
  expect(pid).toMatch(/^\d+$/);
  expect(pgid).toBe(pid);
  return { out, reason };
}

test('the channel helper requests a detached watchdog restart', async () => {
  const { out, reason } = await withWatchdog(() =>
    runScript('request-restart.ts', { args: [hermitDir], cwd: project }));
  expect(out.exitCode).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ status: 'requested' });
  expect(reason).toBe('requested');
});

test('the channel helper reports a missing watchdog', async () => {
  const out = await runScript('request-restart.ts', { args: [hermitDir], cwd: project });
  expect(out.exitCode).toBe(1);
  expect(JSON.parse(out.stdout)).toEqual({ error: 'watchdog_missing' });
});

test('the token mint finish path still requests a reauth restart', async () => {
  const { out, reason } = await withWatchdog(() => runScript('setup-token-mint.ts', {
    args: ['finish'],
    cwd: project,
    env: { HERMIT_DIR: hermitDir, CLAUDE_CONFIG_DIR: path.join(project, '.claude') },
  }));
  expect(out.exitCode).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ ok: true, stage: 'restarting' });
  expect(reason).toBe('reauth');
});

test('default permissions leave the channel restart helper ungranted', async () => {
  const out = await runScript('apply-settings.ts', {
    args: ['.claude/settings.local.json', 'permissions-plan'],
    cwd: project,
  });
  expect(out.exitCode).toBe(0);
  const { missing } = JSON.parse(out.stdout) as { missing: string[] };
  expect(missing.length).toBeGreaterThan(0);
  expect(missing.some(rule => rule.includes('request-restart'))).toBe(false);
});
