import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { claim, finalize, QUEUE_DIR, OUTCOMES_DIR, QUEUE_PROTOCOL } from '../scripts/lib/harness-mod';
import { gracefulShutdown, shutdownReady } from '../scripts/lib/shutdown';

const workdirs: Workdir[] = [];
afterAll(() => workdirs.forEach(w => w.cleanup()));
function fixture(config: object = { shutdown_skill: '/custom:shutdown' }, loaded = 'resident') {
  const wd = setupWorkdir();
  workdirs.push(wd);
  const dir = path.join(wd.dir, '.hermit');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ cc_session_id: 'resident', runtime_mode: 'headless' }));
  fs.writeFileSync(path.join(dir, 'state/harness-mod-loaded.json'), JSON.stringify({ session_id: loaded, queue: QUEUE_PROTOCOL }));
  return { wd, dir };
}
function execution(dir: string, state: string, at: number) {
  fs.writeFileSync(path.join(dir, 'state/execution.json'), JSON.stringify({ state, at: new Date(at).toISOString() }));
}
const count = (dir: string, sub: string) => { try { return fs.readdirSync(path.join(dir, 'state', sub)).length; } catch { return 0; } };

// A fake clock whose every wait runs one scripted step: the mod and the session, in order.
function scripted(steps: Array<() => void>) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += Math.max(ms, 1); steps.shift()?.(); },
  };
}

test('settle boundary rejects active, missing, or stale observations', () => {
  const after = Date.parse('2026-09-16T12:00:00Z');
  expect(shutdownReady(null, null)).toBe(false);
  expect(shutdownReady({ state: 'in_flight', at: '2026-09-16T12:00:01Z' }, after)).toBe(false);
  expect(shutdownReady({ state: 'idle', at: '2026-09-16T12:00:00Z' }, after)).toBe(false);
  expect(shutdownReady({ state: 'idle', at: '2026-09-16T12:00:01Z' }, after)).toBe(true);
  expect(shutdownReady({ state: 'idle' }, null)).toBe(true);
});

test('no shutdown skill stamps the request and settles', async () => {
  const { dir } = fixture({});
  execution(dir, 'idle', Date.now());
  expect(await gracefulShutdown(dir)).toEqual({ status: 'settled', skill: 'none' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state/runtime.json'), 'utf8')).shutdown_requested_at).toBeDefined();
  expect(count(dir, QUEUE_DIR)).toBe(0);
});

test('waits for the running turn, then for the skill turn; an unrelated turn does not count', async () => {
  const { dir } = fixture();
  const base = Date.now();
  execution(dir, 'in_flight', base);
  let id = '';
  const clock = scripted([
    () => expect(count(dir, QUEUE_DIR)).toBe(0), // nothing queued mid-turn
    () => execution(dir, 'idle', base + 1000),
    // An unrelated turn settles after the enqueue, before the skill runs.
    () => { expect(count(dir, QUEUE_DIR)).toBe(1); execution(dir, 'idle', base + 2000); },
    () => {
      const entry = claim(dir, 'resident', '1.0.0')!;
      id = entry.id;
      expect(entry).toMatchObject({ source: 'stop', purpose: 'stop', commands: [{ command: '/custom:shutdown', arg: null }] });
      finalize(dir, id, { legs: [{ command: '/custom:shutdown', status: 'ok', text: 'submitted', submitted_at: new Date(base + 3000).toISOString() }] });
    },
    () => execution(dir, 'in_flight', base + 3500),
    () => execution(dir, 'idle', base + 4000),
  ]);
  const result = await gracefulShutdown(dir, { ...clock, timeoutSecs: 60 });
  expect(result).toEqual({ status: 'settled', skill: 'ok' });
  expect(clock.now()).toBeGreaterThanOrEqual(6000);
});

test('a second call in the same session finds the first operation', async () => {
  const { dir } = fixture();
  execution(dir, 'idle', Date.now() - 5000);
  const first = gracefulShutdown(dir, { pollMs: 10, timeoutSecs: 5 });
  let entry = null;
  for (let i = 0; i < 200 && !entry; i++) {
    entry = claim(dir, 'resident', '1.0.0');
    if (!entry) await Bun.sleep(10);
  }
  const second = gracefulShutdown(dir, { pollMs: 10, timeoutSecs: 5 });
  finalize(dir, entry!.id, { legs: [{ command: '/custom:shutdown', status: 'ok', text: 'submitted', submitted_at: new Date().toISOString() }] });
  await Bun.sleep(20);
  execution(dir, 'idle', Date.now() + 1000);
  expect(await first).toEqual({ status: 'settled', skill: 'ok' });
  expect(await second).toEqual({ status: 'settled', skill: 'ok' });
  expect(count(dir, QUEUE_DIR) + count(dir, OUTCOMES_DIR)).toBe(1);
});

test('a skipped or failed skill counts as done', async () => {
  const skipped = fixture(undefined, 'old');
  execution(skipped.dir, 'idle', Date.now());
  expect(await gracefulShutdown(skipped.dir)).toEqual({ status: 'settled', skill: 'skipped', reason: 'mod_not_loaded' });

  const failed = fixture();
  execution(failed.dir, 'idle', Date.now());
  const clock = scripted([() => {
    const entry = claim(failed.dir, 'resident', '1.0.0')!;
    finalize(failed.dir, entry.id, { legs: [{ command: '/custom:shutdown', status: 'failed', text: 'stopped' }] });
  }]);
  expect(await gracefulShutdown(failed.dir, clock)).toEqual({ status: 'settled', skill: 'failed', reason: 'rejected', text: 'stopped' });
});

test('waits are bounded by the timeout', async () => {
  const { dir } = fixture();
  execution(dir, 'idle', Date.now());
  const clock = scripted([]);
  expect(await gracefulShutdown(dir, { ...clock, timeoutSecs: 5 })).toEqual({ status: 'timeout', skill: 'unknown', reason: 'skill_not_run' });
  expect(clock.now()).toBe(5000);
});

test('verb prints one JSON object and exits 0', async () => {
  const { wd, dir } = fixture({});
  execution(dir, 'idle', Date.now());
  const result = await runScript('graceful-shutdown.ts', { cwd: wd.dir, env: { AGENT_DIR: dir }, args: ['--timeout', '5'] });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'settled', skill: 'none' });
  const bad = await runScript('graceful-shutdown.ts', { cwd: wd.dir, env: { AGENT_DIR: dir }, args: ['--timeout', 'x'] });
  expect(JSON.parse(bad.stdout)).toEqual({ error: 'invalid_timeout' });
});
