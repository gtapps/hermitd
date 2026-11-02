import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserDisplaySession, reserveDisplay, maybeStartBrowserDisplay, stopBrowserDisplay } from '../scripts/browser-display';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('browser-display-');
afterAll(cleanup);
test('hermits reserve distinct displays and reclaim only dead reservations', () => {
  const data = freshDir();
  const first = reserveDisplay(data, () => false);
  const second = reserveDisplay(data, () => false);
  expect(first.display).toBe(':10'); expect(second.display).toBe(':11');
  fs.writeFileSync(first.reservation, '{"pid":99999999}');
  expect(reserveDisplay(data, () => false).display).toBe(':10');
  expect(reserveDisplay(data, number => number === 12).display).toBe(':13');
  expect(browserDisplaySession('hermit-demo').startsWith('hermit-demo')).toBe(false);
});
test('interactive, disabled, and missing-package boots do not start a sidecar', () => {
  const dir = freshDir(); let spawns = 0;
  const spawn = (() => { spawns++; }) as any;
  maybeStartBrowserDisplay('interactive', dir, spawn, true);
  maybeStartBrowserDisplay('tmux', dir, spawn, false);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"browser":{"enabled":false}}');
  maybeStartBrowserDisplay('tmux', dir, spawn, true);
  expect(spawns).toBe(0);
});


test('shutdown takes teardown without waking a waiter and bounds the close subprocess', async () => {
  const dir = freshDir();
  const { browserLease } = await import('../scripts/lib/browser-lease');
  browserLease('claim', 'old', dir); browserLease('claim', 'queued', dir);
  browserLease('takeover', undefined, dir, Date.now(), { login: 'admin' });
  const calls: string[] = [];
  const spawn = ((command: string, args: string[], options: any) => {
    if (args.some(arg => arg.endsWith('/browser-agent.ts'))) {
      expect(browserLease('inspect', undefined, dir)).toMatchObject({ holder: 'shutdown', human: null });
      expect(options.timeout).toBe(5000); expect(options.killSignal).toBe('SIGKILL');
      calls.push('close');
    } else {
      expect(browserLease('inspect', undefined, dir).holder).toBeNull();
      expect(args[0]).toBe('kill-session'); calls.push('kill');
    }
    return { status: 0 };
  }) as any;
  stopBrowserDisplay(dir, spawn, () => true);
  expect(calls).toEqual(['close', 'kill']);
  expect(browserLease('inspect', undefined, dir).waiters).toHaveLength(1);
});

test('tmux display startup is idempotent with an injected tmux runner', () => {
  const dir = freshDir(); let calls = 0;
  const spawn = (() => { calls++; return { status: 0 }; }) as any;
  maybeStartBrowserDisplay('tmux', dir, spawn, true, () => false);
  // macOS intentionally has no sidecar.
  const { browserHostPlatform } = require('../scripts/lib/browser-runtime');
  expect(calls).toBe(browserHostPlatform() === 'linux' ? 1 : 0);
  maybeStartBrowserDisplay('tmux', dir, spawn, true, () => true);
  expect(calls).toBe(browserHostPlatform() === 'linux' ? 1 : 0);
});
