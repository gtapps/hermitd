// Contract tests for `routines.ts due` — the monitor-mode deterministic
// scheduler. Exercised as a subprocess (argv/stdout/exit-code/file writes), same
// convention as tests/routine-precheck.test.ts.
//
// Usage: bun test tests/routine-due.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { setPause } from '../scripts/lib/pause';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const metricsPath = (dir: string) => hermit(dir, 'state', 'routine-metrics.jsonl');
const schedulePath = (dir: string) => hermit(dir, 'state', 'routine-schedule.json');
const livenessPath = (dir: string) => hermit(dir, 'state', 'routine-monitor-liveness.json');

const readMetricsRows = (dir: string) => {
  try {
    return fs.readFileSync(metricsPath(dir), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const readSchedule = (dir: string): any => {
  try { return JSON.parse(fs.readFileSync(schedulePath(dir), 'utf-8')); } catch { return null; }
};
const writeSchedule = (dir: string, value: any) =>
  fs.writeFileSync(schedulePath(dir), JSON.stringify(value));
const turnMarkerPath = (dir: string) => hermit(dir, 'state', 'operator-turn-open.json');
const writeTurnMarker = (dir: string, at: string) =>
  fs.writeFileSync(turnMarkerPath(dir), JSON.stringify({ at }));
const writeTurnMarkerRaw = (dir: string, raw: string) =>
  fs.writeFileSync(turnMarkerPath(dir), raw);
const writeConfig = (dir: string, routines: any[], timezone: string | null = 'UTC', maxLateness?: unknown) =>
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone, routines, routine_max_lateness_minutes: maxLateness }));

const ROUTINE = (overrides: any = {}) => ({
  id: 'test-routine', skill: 'hermitd:reflect', schedule: '0 9 * * *',
  enabled: true, ...overrides,
});
const ANCHOR = { id: 'heartbeat-restart', skill: 'hermitd:heartbeat start', schedule: '0 4 * * *', enabled: true };

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const run = (dir: string, now: string) =>
  runScript('routines.ts', { args: ['due', hermit(dir)], env: { HERMIT_NOW: now } });

describe('routine-due', () => {
  test('no schedule file + due-now mark → init-to-now, NO emission, entry created', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE(), ANCHOR]);
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    const sched = readSchedule(dir);
    expect(sched['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    expect(sched['heartbeat-restart']).toBeUndefined(); // anchor never tracked
  }));

  test('mark in window → emits bracketed id, consumes latest match', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'test-routine', event: 'dispatched', delivery: 'monitor' });
  }));

  test('two routines due → one line, both bracketed ids, config order', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'first', schedule: '0 9 * * *' }), ROUTINE({ id: 'second', schedule: '0 9 * * *' })]);
    writeSchedule(dir, {
      first: { last_consumed_mark: '2026-07-15T08:00:00.000Z' },
      second: { last_consumed_mark: '2026-07-15T08:00:00.000Z' },
    });
    const r = await run(dir, '2026-07-15T09:05:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:first] [hermit-routine:second]');
  }));

  test('multiple pending marks collapse into one fire, cursor = latest', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ schedule: '0 * * * *' })]); // hourly
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T05:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:00:00Z'); // 3 missed hourly marks (6,7,8) + due now (9)
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('mark older than 24h with no recent match → expired, no fire, cursor advances to nowMinute', withDir(async (dir) => {
    // A daily schedule always has exactly one occurrence inside any 24h lookback
    // window (the window width equals the period), so this case needs a schedule
    // whose period exceeds 24h — weekly Monday 9am, evaluated on a Wednesday, so
    // the (windowFloor(Tue), now(Wed)] window spans neither this nor last Monday.
    // On no-match the cursor converges to nowMinute (not windowFloor) so the next
    // poll re-scans only new minutes instead of re-walking the dead 24h window.
    writeConfig(dir, [ROUTINE({ schedule: '0 9 * * 1' })]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-01T00:00:00.000Z' } }); // long stale
    const r = await run(dir, '2026-07-15T03:00:00Z'); // Wednesday
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T03:00:00.000Z');
  }));

  test('not-yet-due routine advances cursor to nowMinute on a no-match poll', withDir(async (dir) => {
    // Daily 9am, cursor at yesterday's fire, polled at 08:00 — no match in (cursor, now].
    // Old behavior left the cursor put (re-scanning a growing window every poll); now it
    // converges to nowMinute so the next poll's window is just the elapsed minute.
    writeConfig(dir, [ROUTINE({ schedule: '0 9 * * *' })]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-14T09:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T08:00:00Z');
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T08:00:00.000Z');
  }));

  test('invalid config.timezone → fail-soft: no fire, but cursor init and stale-entry prune still run', withDir(async (dir) => {
    // Bun.cron.parse throws on a bad tz, so lib/cron.ts finds no match, but the missing
    // cursor must still initialize and a stale non-eligible entry must still be pruned.
    writeConfig(dir, [ROUTINE({ id: 'live-one' })], 'Not/AZone');
    writeSchedule(dir, { 'gone-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } }); // no longer in config
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    const sched = readSchedule(dir);
    expect(sched['live-one']).toBeDefined();               // missing cursor initialized despite bad tz
    expect(sched['live-one'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    expect(sched['gone-routine']).toBeUndefined();          // stale entry pruned
  }));

  test('incident repro: no operator-turn marker → emits and consumes (extratus starvation)', withDir(async (dir) => {
    // A due routine must fire between operator turns when no marker is present.
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('fresh operator-turn marker → defer, no consume', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeTurnMarker(dir, '2026-07-15T09:15:00.000Z'); // 15 min old at run time, well under the 60-min TTL
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T08:00:00.000Z'); // untouched
  }));

  test('stale marker (> 60-min TTL) → emits (orphaned-marker backstop)', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeTurnMarker(dir, '2026-07-15T08:00:00.000Z'); // 90 min old at run time
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('future-dated marker (clock skew) → emits, not treated as live', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeTurnMarker(dir, '2026-07-15T10:30:00.000Z'); // an hour ahead of run time
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('malformed marker file → fail-open to emit', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeTurnMarkerRaw(dir, '{oops');
    const r = await run(dir, '2026-07-15T09:30:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('in_progress lull catch-up: deferred while marker present, emits once marker clears', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeTurnMarker(dir, '2026-07-15T09:15:00.000Z');
    const r1 = await run(dir, '2026-07-15T09:30:00Z');
    expect(r1.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T08:00:00.000Z');

    fs.rmSync(turnMarkerPath(dir)); // Stop-pipeline cleared it — turn ended
    const r2 = await run(dir, '2026-07-15T09:40:00Z');
    expect(r2.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('paused → no emission, mark consumed, skipped-paused row (delivery=monitor)', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    setPause(hermit(dir), { reason: 'operator', by: 'test' });
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'test-routine', event: 'skipped-paused', delivery: 'monitor' });
  }));

  test('persist failure in skip branch → NO skipped-* row, cursor unchanged; retry writes exactly one', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    setPause(hermit(dir), { reason: 'operator', by: 'test' });

    // Force the schedule persist to fail via the test seam — the deferred skip stamp must
    // not be written and the cursor must not advance (persist-before-stamp ordering).
    const rFail = await runScript('routines.ts', {
      args: ['due', hermit(dir)],
      env: { HERMIT_NOW: '2026-07-15T09:00:00Z', HERMIT_DUE_FORCE_PERSIST_FAIL: '1' },
    });
    expect(rFail.exitCode).toBe(0);
    expect(rFail.stdout.trim()).toBe('');
    expect(readMetricsRows(dir)).toHaveLength(0); // no phantom skipped-* row
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T08:00:00.000Z'); // cursor unchanged
    expect(fs.existsSync(livenessPath(dir))).toBe(true); // liveness still written (seam is schedule-scoped)

    // Retry without the seam — now exactly one skip row, and the cursor advances.
    const rOk = await run(dir, '2026-07-15T09:00:00Z');
    expect(rOk.stdout.trim()).toBe('');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'test-routine', event: 'skipped-paused', delivery: 'monitor' });
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('heartbeat-restart is never emitted, never touched in schedule file', withDir(async (dir) => {
    writeConfig(dir, [ANCHOR]);
    const r = await run(dir, '2026-07-15T04:00:00Z'); // matches anchor's own schedule
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)).toBeNull(); // nothing written — anchor filtered before any state touch
  }));

  test('liveness file written on: normal run, no-op run, and corrupt-config run', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    await run(dir, '2026-07-15T09:00:00Z');
    expect(fs.existsSync(livenessPath(dir))).toBe(true);
    const firstStamp = JSON.parse(fs.readFileSync(livenessPath(dir), 'utf-8')).last_peek_at;

    await run(dir, '2026-07-15T09:00:30Z'); // no-op (same minute, already consumed)
    expect(fs.existsSync(livenessPath(dir))).toBe(true);

    fs.writeFileSync(hermit(dir, 'config.json'), '{not valid json');
    const r3 = await run(dir, '2026-07-15T09:01:00Z');
    expect(r3.exitCode).toBe(0);
    expect(r3.stdout.trim()).toBe('');
    expect(fs.existsSync(livenessPath(dir))).toBe(true);
    expect(typeof firstStamp).toBe('string');
  }));

  test('invalid schedule string on one routine → other routines still evaluated', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'bad', schedule: 'not a cron' }), ROUTINE({ id: 'good', schedule: '0 9 * * *' })]);
    writeSchedule(dir, { good: { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:good]');
    expect(r.stderr).toContain('bad');
  }));

  test('future last_consumed_mark (clock skew) → reset to now, no fire', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-20T00:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('schedule-write failure (directory collision) → exit 0, NO emission, stderr note, liveness still attempted', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    fs.mkdirSync(schedulePath(dir)); // pre-create as a directory: rename(file, dir) fails EISDIR for any uid
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain('routine-due');
    expect(fs.existsSync(livenessPath(dir))).toBe(true);
  }));

  test('invalid routine id (grammar) → skipped with stderr note; other routines unaffected', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'bad id with spaces' }), ROUTINE({ id: 'good-id', schedule: '0 9 * * *' })]);
    writeSchedule(dir, { 'good-id': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    const r = await run(dir, '2026-07-15T09:00:00Z');
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:good-id]');
    expect(r.stderr).toContain('invalid id');
  }));

  test('missing hermit-dir arg → exit 0, no crash, no output', withDir(async (dir) => {
    const r = await runScript('routines.ts', { args: ['due', ] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));
});

describe('routine-due lateness', () => {
  for (const [label, limit, at, fires] of [
    ['omitted default boundary', undefined, '10:00:59', true],
    ['omitted default expired', undefined, '10:01:00', false],
    ['custom boundary', 15, '09:15:00', true],
    ['custom expired', 15, '09:16:00', false],
    ['minimum boundary', 1, '09:01:00', true],
    ['minimum expired', 1, '09:02:00', false],
    ['legacy window', 1440, '23:00:00', true],
    ['explicit default', 60, '10:01:00', false],
    ['null defaults', null, '10:01:00', false],
    ['string defaults', '1440', '10:01:00', false],
    ['out-of-range defaults', 1441, '10:01:00', false],
    ['fraction defaults', 90.5, '10:01:00', false],
  ] as const) {
    test(label, withDir(async (dir) => {
      writeConfig(dir, [ROUTINE()], 'UTC', limit);
      writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
      const result = await run(dir, `2026-07-15T${at}Z`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(fires ? 'ROUTINE_DUE [hermit-routine:test-routine]' : '');
      expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
      expect(readMetricsRows(dir).map((r) => r.event)).toEqual([fires ? 'dispatched' : 'skipped-late']);
    }));
  }

  test('resume after days away emits fresh routines and consumes stale ones only once', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'stale' }), ROUTINE({ id: 'fresh', schedule: '0 * * * *' })]);
    writeSchedule(dir, {
      stale: { last_consumed_mark: '2026-07-01T08:00:00.000Z' },
      fresh: { last_consumed_mark: '2026-07-01T08:00:00.000Z' },
    });
    expect((await run(dir, '2026-07-15T12:30:00Z')).stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:fresh]');
    expect(readMetricsRows(dir).map((r) => [r.routine_id, r.event])).toEqual([
      ['stale', 'skipped-late'], ['fresh', 'dispatched'],
    ]);
    expect((await run(dir, '2026-07-15T12:31:00Z')).stdout.trim()).toBe('');
    expect(readMetricsRows(dir)).toHaveLength(2);
    expect((await run(dir, '2026-07-16T09:00:00Z')).stdout).toContain('[hermit-routine:stale]');
  }));

  test('a routine deferred by a busy turn fires after that turn clears', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeTurnMarker(dir, '2026-07-15T09:15:00.000Z');
    expect((await run(dir, '2026-07-15T09:30:00Z')).stdout).toBe('');
    expect(readMetricsRows(dir)).toHaveLength(0);
    expect((await run(dir, '2026-07-15T10:01:00Z')).stdout).toBe('');
    expect(readMetricsRows(dir)).toHaveLength(0);
    fs.unlinkSync(turnMarkerPath(dir));
    expect((await run(dir, '2026-07-15T10:02:00Z')).stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    expect(readMetricsRows(dir).map((r) => r.event)).toEqual(['dispatched']);
    expect((await run(dir, '2026-07-15T10:03:00Z')).stdout).toBe('');
    expect(readMetricsRows(dir)).toHaveLength(1);
  }));

  test('an occurrence already expired when the turn opens is not rescued by the defer', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeTurnMarker(dir, '2026-07-15T14:00:00.000Z');
    expect((await run(dir, '2026-07-15T14:05:00Z')).stdout).toBe('');
    expect(readMetricsRows(dir).map((r) => r.event)).toEqual(['skipped-late']);
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('a deferral interrupted by downtime expires instead of firing on resume', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    writeTurnMarker(dir, '2026-07-15T09:15:00.000Z');
    expect((await run(dir, '2026-07-15T09:30:00Z')).stdout).toBe('');
    expect(readMetricsRows(dir)).toHaveLength(0);
    fs.unlinkSync(turnMarkerPath(dir)); // monitor down for hours, back with the turn long over
    expect((await run(dir, '2026-07-15T14:00:00Z')).stdout).toBe('');
    expect(readMetricsRows(dir).map((r) => r.event)).toEqual(['skipped-late']);
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('a hold longer than the limit still fires while polls keep observing it', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    // Four hours of conversation, far past the 60-minute limit, polled throughout.
    // Each operator prompt rewrites the marker, so it never hits its own TTL.
    for (const at of ['09:00', '09:30', '10:00', '11:00', '12:00', '13:00']) {
      writeTurnMarker(dir, `2026-07-15T${at}:00.000Z`);
      expect((await run(dir, `2026-07-15T${at}:00Z`)).stdout).toBe('');
      expect(readMetricsRows(dir)).toHaveLength(0);
    }
    fs.unlinkSync(turnMarkerPath(dir));
    expect((await run(dir, '2026-07-15T13:01:00Z')).stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:test-routine]');
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
    expect(readMetricsRows(dir).map((r) => r.event)).toEqual(['dispatched']);
  }));

  test('a held_at in the future is ignored rather than holding the occurrence forever', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, {
      'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z', held_at: '2027-01-01T00:00:00.000Z' },
    });
    expect((await run(dir, '2026-07-15T10:01:00Z')).stdout).toBe('');
    expect(readMetricsRows(dir).map((r) => r.event)).toEqual(['skipped-late']);
    expect(readSchedule(dir)['test-routine'].last_consumed_mark).toBe('2026-07-15T09:00:00.000Z');
  }));

  test('failed expiry persistence leaves no skip row and retries once', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    const initial = { 'test-routine': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } };
    writeSchedule(dir, initial);
    const result = await runScript('routines.ts', {
      args: ['due', hermit(dir)],
      env: { HERMIT_NOW: '2026-07-15T10:01:00Z', HERMIT_DUE_FORCE_PERSIST_FAIL: '1' },
    });
    expect(result.stdout).toBe('');
    expect(readSchedule(dir)).toEqual(initial);
    expect(readMetricsRows(dir)).toHaveLength(0);
    expect((await run(dir, '2026-07-15T10:01:00Z')).stdout).toBe('');
    expect(readMetricsRows(dir).map((r) => r.event)).toEqual(['skipped-late']);
  }));
});
