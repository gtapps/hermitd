import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markGuest } from '../scripts/lib/guest-marker';
import { runPinnedScript, runScript, type RunResult } from './helpers/run';

let project: string;
let hermitDir: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-request-restart-'));
  hermitDir = path.join(project, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'state'));
});

const restart = (...args: string[]) => runPinnedScript('request-restart.ts', hermitDir, [hermitDir, ...args], { cwd: project });

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

test.serial('the channel helper requests a detached watchdog restart', async () => {
  const { out, reason } = await withWatchdog(() => restart());
  expect(out.exitCode).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ status: 'requested' });
  expect(reason).toBe('requested');
});

test.serial('the channel helper requests a restart for a session without a guest marker', async () => {
  const { out } = await withWatchdog(() => restart('--session-id', 'resident-1'));
  expect(out.exitCode).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ status: 'requested' });
});

test.serial('the channel helper refuses a guest session before reaching the watchdog', async () => {
  // No watchdog installed: a restart attempt would exit with watchdog_missing.
  markGuest(path.join(hermitDir, 'state'), 'helper-1');
  const out = await restart('--session-id', 'helper-1');
  expect(out.exitCode).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ status: 'refused', reason: 'guest_session' });
});

test.serial('the channel helper check reports the residency verdict', async () => {
  markGuest(path.join(hermitDir, 'state'), 'helper-1');
  expect(JSON.parse((await restart('--check', '--session-id', 'helper-1')).stdout)).toEqual({ status: 'guest' });
  expect(JSON.parse((await restart('--check', '--session-id', 'resident-1')).stdout)).toEqual({ status: 'resident' });
});

test.serial('the channel helper rejects malformed flags', async () => {
  expect((await restart('--session-id')).exitCode).toBe(1);
  expect((await restart('--session-id', '')).exitCode).toBe(1);
});

test.serial('the channel helper reports a missing watchdog', async () => {
  const out = await restart();
  expect(out.exitCode).toBe(1);
  expect(JSON.parse(out.stdout)).toEqual({ error: 'watchdog_missing' });
});

test.serial('the channel helper refuses a foreign state directory', async () => {
  const foreign = path.join(project, 'other', '.hermit');
  fs.mkdirSync(path.join(foreign, 'bin'), { recursive: true });
  const out = await runPinnedScript('request-restart.ts', hermitDir, [foreign], { cwd: project });
  expect(out.exitCode).toBe(1);
  expect(JSON.parse(out.stdout).error).toStartWith('foreign_state_dir:');
});

test.serial('the token mint finish path still requests a reauth restart', async () => {
  const { out, reason } = await withWatchdog(() => runScript('setup-token-mint.ts', {
    args: ['finish'],
    cwd: project,
    env: { HERMIT_DIR: hermitDir, CLAUDE_CONFIG_DIR: path.join(project, '.claude') },
  }));
  expect(out.exitCode).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ ok: true, stage: 'restarting' });
  expect(reason).toBe('reauth');
});

test.serial('default permissions leave the channel restart helper ungranted', async () => {
  const out = await runScript('apply-settings.ts', {
    args: ['.claude/settings.local.json', 'permissions-plan'],
    cwd: project,
  });
  expect(out.exitCode).toBe(0);
  const { missing } = JSON.parse(out.stdout) as { missing: string[] };
  expect(missing.length).toBeGreaterThan(0);
  expect(missing.some(rule => rule.includes('request-restart'))).toBe(false);
});
