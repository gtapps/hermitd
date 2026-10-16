// Contract tests for scripts/hermitd-pause.ts — the operator CLI for the
// binding pause/stop/resume flag (PROP-015). Exercised as a subprocess
// (argv/stdout/exit-code), invoked via .hermit/bin/hermitd-pause
// in real usage.
//
// Usage: bun test tests/hermitd-pause.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { isPaused } from '../scripts/lib/pause';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const run = (args: string[], dir: string) => runScript('hermitd-pause.ts', { args, cwd: dir });

describe('hermitd-pause CLI', () => {
  test('status — not paused by default', withDir(async (dir) => {
    const r = await run(['status'], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('not paused');
  }));

  test('on — pauses indefinitely', withDir(async (dir) => {
    const r = await run(['on'], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('paused indefinitely');
    const status = isPaused(hermit(dir));
    expect(status.paused).toBe(true);
    expect(status.until).toBeNull();
    expect(status.by).toBe('operator-cli');
  }));

  test('status — reflects an active pause', withDir(async (dir) => {
    await run(['on'], dir);
    const r = await run(['status'], dir);
    expect(r.stdout).toContain('paused');
    expect(r.stdout).toContain('operator-cli');
  }));

  test('off — resumes', withDir(async (dir) => {
    await run(['on'], dir);
    const r = await run(['off'], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('resumed');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('off is available even while paused (always works — no gate on the operator shell)', withDir(async (dir) => {
    await run(['on'], dir);
    expect(isPaused(hermit(dir)).paused).toBe(true);
    await run(['off'], dir);
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('snooze 1h — pauses with a future paused_until', withDir(async (dir) => {
    const r = await run(['snooze', '1h'], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('paused until');
    const status = isPaused(hermit(dir));
    expect(status.paused).toBe(true);
    expect(new Date(status.until as string).getTime()).toBeGreaterThan(Date.now());
  }));

  test('snooze with an unparseable duration — exit 1, no state change', withDir(async (dir) => {
    const r = await run(['snooze', 'bogus'], dir);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('could not parse');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('snooze with no duration argument — exit 1, no state change', withDir(async (dir) => {
    const r = await run(['snooze'], dir);
    expect(r.exitCode).toBe(1);
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('no subcommand — prints usage, exit 1', withDir(async (dir) => {
    const r = await run([], dir);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage');
  }));

  test('unknown subcommand — prints usage, exit 1', withDir(async (dir) => {
    const r = await run(['bogus-command'], dir);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage');
  }));
});
