import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserLease } from '../scripts/lib/browser-lease';
import { IDLE_WATCH_INTERVAL_MS, watchIdleBrowser } from '../scripts/browser-idle-watch';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('browser-idle-watch-');
afterAll(cleanup);

// Injected clock and sleep: each pass advances `now` by the interval instead of waiting.
function fixture(seconds: number) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ browser: { inactivity_timeout: seconds } }));
  const closed: string[] = [];
  const state = { alive: true, sleeps: 0 };
  const deps = {
    now: 0, pids: () => [1], chromeAlive: () => state.alive,
    wrapperClose: (_: string, task: string) => { closed.push(task); },
    sleep: async (ms: number) => { state.sleeps++; deps.now += ms; if (state.sleeps > 20) state.alive = false; },
  };
  return { dir, deps, closed, state };
}

test('closes an unclaimed browser once it is unused past the timeout, then exits', async () => {
  const { dir, deps, closed, state } = fixture(60);
  browserLease('claim', 'task-a', dir, 0);
  browserLease('release', 'task-a', dir, 1000);
  expect(await watchIdleBrowser(dir, deps)).toBe('closed');
  expect(closed).toEqual(['idle-close']);
  expect(deps.now - 1000).toBeGreaterThanOrEqual(60_000);
  expect(deps.now - 1000).toBeLessThan(60_000 + IDLE_WATCH_INTERVAL_MS);
  expect(state.sleeps).toBe(3);
  expect(browserLease('status', undefined, dir, deps.now).status).toBe('available');
  expect(fs.existsSync(path.join(dir, 'state/browser-idle-watch.lock'))).toBe(false);
});

test('never closes while a person has control, and exits when Chrome is gone', async () => {
  const { dir, deps, closed } = fixture(60);
  browserLease('takeover', undefined, dir, 0, { login: 'admin', admins: ['admin'], chromeAlive: () => true });
  expect(await watchIdleBrowser(dir, deps)).toBe('browser_gone');
  expect(closed).toEqual([]);
});

test('never closes under a live claim', async () => {
  const { dir, deps, closed } = fixture(60);
  browserLease('claim', 'task-a', dir, 0);
  expect(await watchIdleBrowser(dir, deps)).toBe('browser_gone');
  expect(closed).toEqual([]);
});

test('0 disables it, and a second watcher exits while one is alive', async () => {
  const off = fixture(0);
  expect(await watchIdleBrowser(off.dir, off.deps)).toBe('disabled');
  expect(off.state.sleeps).toBe(0);
  const on = fixture(60);
  fs.writeFileSync(path.join(on.dir, 'state/browser-idle-watch.lock'), String(process.ppid));
  expect(await watchIdleBrowser(on.dir, on.deps)).toBe('already_running');
});
