// Contract tests for `routines.ts precheck` — consolidates a routine fire's
// pre-dispatch gate (pause-check) and the `started` stamp into one
// script call. Exercised as a subprocess (argv/stdout/exit-code/file writes), the same
// way tests/hermitd-pause.test.ts exercises hermitd-pause.ts (both resolve the hermit
// root via lib/cc-compat's hermitDir(), which fails open to a path resolved against
// the child process's cwd when no config.json is present — see setupWorkdir()).
//
// Usage: bun test tests/routine-precheck.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { setPause } from '../scripts/lib/pause';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const metricsPath = (dir: string) => hermit(dir, 'state', 'routine-metrics.jsonl');
const readMetricsRows = (dir: string) => {
  try {
    return fs.readFileSync(metricsPath(dir), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const run = (id: string, dir: string) =>
  runScript('routines.ts', { args: ['precheck', id], cwd: dir });

describe('routine-precheck', () => {
  test('unpaused → PROCEED + one started row', withDir(async (dir) => {
    const r = await run('morning-brief', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{"status":"proceed"}');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'morning-brief', event: 'started', delivery: 'cron-create' });
    expect(typeof rows[0].ts).toBe('string');
  }));

  test('paused (operator) → SKIP + skipped-paused row', withDir(async (dir) => {
    setPause(hermit(dir), { reason: 'operator', by: 'test' });
    const r = await run('weekly-review', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{"status":"skip","reason":"paused"}');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'weekly-review', event: 'skipped-paused' });
  }));

  test('malformed runtime.json → fail-open PROCEED, no crash', withDir(async (dir) => {
    fs.writeFileSync(hermit(dir, 'state', 'runtime.json'), '{not valid json');
    const r = await run('daily-brief', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{"status":"proceed"}');
    const rows = readMetricsRows(dir);
    expect(rows[0]).toMatchObject({ routine_id: 'daily-brief', event: 'started' });
  }));

  test('missing routine id → fail-open PROCEED, no metrics row written', withDir(async (dir) => {
    const r = await runScript('routines.ts', { args: ['precheck', ], cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{"status":"proceed"}');
    expect(readMetricsRows(dir)).toHaveLength(0);
  }));

  test('subdir with a config.json ancestor resolves to the project root', withDir(async (dir) => {
    // Mirrors the log-routine-event.sh "subdir resolves to ancestor" case: hermitDir()'s
    // walk-up branch requires config.json to exist (setupWorkdir() doesn't seed one, so
    // the root-cwd cases above rely on the fail-open branch instead — see file header).
    fs.writeFileSync(hermit(dir, 'config.json'), '{}');
    fs.mkdirSync(path.join(dir, 'app', 'sub'), { recursive: true });
    const r = await runScript('routines.ts', {
      args: ['precheck', 'nested-routine'],
      cwd: path.join(dir, 'app', 'sub'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{"status":"proceed"}');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'nested-routine', event: 'started' });
  }));

  test('row schema is exactly (ts, routine_id, event, delivery)', withDir(async (dir) => {
    await run('schema-check', dir);
    const rows = readMetricsRows(dir);
    expect(Object.keys(rows[0]).sort()).toEqual(['delivery', 'event', 'routine_id', 'ts']);
  }));

  test('explicit delivery arg "monitor" serializes delivery: monitor', withDir(async (dir) => {
    const r = await runScript('routines.ts', { args: ['precheck', 'test-routine', 'monitor'], cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{"status":"proceed"}');
    const rows = readMetricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'test-routine', event: 'started', delivery: 'monitor' });
  }));

  test('no delivery arg defaults to delivery: cron-create (unchanged)', withDir(async (dir) => {
    const r = await run('legacy-routine', dir);
    expect(r.exitCode).toBe(0);
    const rows = readMetricsRows(dir);
    expect(rows[0]).toMatchObject({ event: 'started', delivery: 'cron-create' });
    expect(Object.keys(rows[0]).sort()).toEqual(['delivery', 'event', 'routine_id', 'ts']);
  }));
});

// CronCreate fallback has no `due`, so this verb is the wake gate's only chance
// to run there. The wake is already paid for by the time it does: behavior
// parity with monitor mode, not cost parity.
describe('routine-precheck — wake gate in fallback delivery', () => {
  const writeGatedConfig = (dir: string, precheck: string) =>
    fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({
      timezone: 'UTC',
      routines: [{ id: 'gated', schedule: '0 9 * * *', skill: 'my-plugin:thing', enabled: true, precheck }],
    }));
  const writeGate = (dir: string, body: string): string => {
    const rel = path.join('tools', 'gate.sh');
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, { mode: 0o755 });
    return rel;
  };

  test('SKIP short-circuits before the started stamp', withDir(async (dir) => {
    writeGatedConfig(dir, writeGate(dir, '#!/usr/bin/env bash\necho SKIP\n'));
    const r = await runScript('routines.ts', { args: ['precheck', 'gated', 'cron-create'], cwd: dir });
    expect(r.stdout.trim()).toBe('{"status":"skip","reason":"gate_skip"}');
    const rows = readMetricsRows(dir);
    // No `started`: a fire that never opened must not read as abandoned later.
    expect(rows.map((x: any) => x.event)).toEqual(['skipped-precheck']);
  }), 20000);

  test('WAKE proceeds and opens the attempt', withDir(async (dir) => {
    writeGatedConfig(dir, writeGate(dir, '#!/usr/bin/env bash\necho WAKE\n'));
    const r = await runScript('routines.ts', { args: ['precheck', 'gated', 'cron-create'], cwd: dir });
    expect(r.stdout.trim()).toBe('{"status":"proceed"}');
    expect(readMetricsRows(dir).map((x: any) => x.event)).toEqual(['started']);
  }), 20000);

  test('a failing gate proceeds and records why', withDir(async (dir) => {
    writeGatedConfig(dir, writeGate(dir, '#!/usr/bin/env bash\nexit 2\n'));
    const r = await runScript('routines.ts', { args: ['precheck', 'gated', 'cron-create'], cwd: dir });
    expect(r.stdout.trim()).toBe('{"status":"proceed"}');
    const rows = readMetricsRows(dir);
    expect(rows.map((x: any) => x.event)).toEqual(['precheck-error', 'started']);
    expect(rows[0].detail).toBe('exit:2');
  }), 20000);

  test('SKIP on a fallback retry consumes the occurrence', withDir(async (dir) => {
    writeGatedConfig(dir, writeGate(dir, '#!/usr/bin/env bash\necho SKIP\n'));
    const mark = '2026-11-14T09:00:00.000Z';
    markDispatched(hermit(dir), { routine_id: 'gated', skill: 'my-plugin:thing', mark, delivery: 'cron-create' });
    stampInterrupted(hermit(dir), 'unclean');
    const r = await runScript('routines.ts', { args: ['precheck', 'gated', '--retry', mark, '--delivery', 'cron-create'], cwd: dir });
    expect(JSON.parse(r.stdout).status).toBe('skip');
    expect(readUnfinished(hermit(dir))).toEqual({});
  }), 20000);

  test('monitor delivery does not re-run the gate — due already decided', withDir(async (dir) => {
    writeGatedConfig(dir, writeGate(dir, [
      '#!/usr/bin/env bash',
      'echo ran >> "$HERMIT_DIR/state/gate-calls.txt"',
      'echo SKIP',
      '',
    ].join('\n')));
    const r = await runScript('routines.ts', { args: ['precheck', 'gated', 'monitor'], cwd: dir });
    expect(r.stdout.trim()).toBe('{"status":"proceed"}');
    expect(fs.existsSync(hermit(dir, 'state', 'gate-calls.txt'))).toBe(false);
  }), 20000);
});

import { markDispatched, readUnfinished, stampInterrupted } from '../scripts/lib/routines/unfinished';
import { readRunRecord, writeRunRecord } from '../scripts/lib/routines/run-record';

const retryRoutine = { id: 'retry-me', skill: 'test:run', schedule: '* * * * *', enabled: true, expect_artifact: 'raw/retry.md' };
function retryFixture(dir: string) {
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone: 'UTC', routines: [retryRoutine] }));
  fs.writeFileSync(hermit(dir, 'state/runtime.json'), JSON.stringify({ cc_session_id: 'resident' }));
  fs.writeFileSync(hermit(dir, 'state/routine-schedule.json'), JSON.stringify({ 'retry-me': { last_consumed_mark: '2026-11-14T10:00:00Z' } }));
  markDispatched(hermit(dir), { routine_id: 'retry-me', skill: 'test:run', mark: '2026-11-14T10:00:00Z', delivery: 'monitor' });
}
const retryRun = (dir: string) => runScript('routines.ts', { cwd: dir,
  args: ['precheck', 'retry-me', '--retry', '2026-11-14T10:00:00Z', '--delivery', 'monitor'] });

test('monitor dispatch proceeds to started; retry preserves its baseline and finish clears it', withDir(async dir => {
  retryFixture(dir);
  await runScript('routines.ts', { cwd: dir, args: ['precheck', 'retry-me', 'monitor'] });
  const original = readRunRecord(hermit(dir), 'retry-me');
  expect(Object.values(readUnfinished(hermit(dir)))[0]).toMatchObject({ state: 'started', session_id: 'resident', skill: 'test:run' });
  fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
  fs.writeFileSync(hermit(dir, 'raw/retry.md'), 'written before crash');
  stampInterrupted(hermit(dir), 'unclean');
  expect((await retryRun(dir)).exitCode).toBe(0);
  expect(readRunRecord(hermit(dir), 'retry-me')).toEqual(original);
  expect(readMetricsRows(dir).at(-1).detail).toBe('retry');
  expect(Object.values(readUnfinished(hermit(dir)))[0].attempts).toBe(1);
  const result = await runScript('routines.ts', { cwd: dir, args: ['finish', 'retry-me'] });
  expect(JSON.parse(result.stdout).status).toBe('fired');
  expect(readUnfinished(hermit(dir))).toEqual({});
}));

for (const change of ['outcome', 'path']) test(`retry re-captures a baseline with ${change}`, withDir(async dir => {
  retryFixture(dir);
  stampInterrupted(hermit(dir), 'unclean');
  writeRunRecord(hermit(dir), 'retry-me', { started_ts: 'old', resolved_path: change === 'path' ? 'raw/other.md' : 'raw/retry.md',
    baseline: null, ...(change === 'outcome' ? { outcome: 'fired' } : {}) });
  await retryRun(dir);
  expect(readRunRecord(hermit(dir), 'retry-me')).toMatchObject({ resolved_path: 'raw/retry.md' });
  expect(readRunRecord(hermit(dir), 'retry-me')?.started_ts).not.toBe('old');
}));

test('forged or changed-skill retry proceeds as manual without spending a retry', withDir(async dir => {
  retryFixture(dir);
  await retryRun(dir); // dispatched is not eligible
  expect(readMetricsRows(dir).at(-1).detail).toBeUndefined();
  expect(Object.values(readUnfinished(hermit(dir)))[0].attempts).toBe(0);
  stampInterrupted(hermit(dir), 'unclean');
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ routines: [{ ...retryRoutine, skill: 'test:changed' }] }));
  await retryRun(dir);
  expect(readMetricsRows(dir).at(-1).detail).toBeUndefined();
  expect(Object.values(readUnfinished(hermit(dir)))[0].skill).toBe('test:changed');
}));

test('paused retry remains interrupted; fallback creates its latest schedule occurrence', withDir(async dir => {
  retryFixture(dir);
  stampInterrupted(hermit(dir), 'unclean');
  setPause(hermit(dir), { reason: 'operator', by: 'test' });
  expect(JSON.parse((await retryRun(dir)).stdout).status).toBe('skip');
  expect(Object.values(readUnfinished(hermit(dir)))[0]).toMatchObject({ state: 'interrupted', attempts: 0 });
}));

test('fallback proceed creates an occurrence using latest schedule fire', withDir(async dir => {
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone: 'UTC', routines: [retryRoutine] }));
  await run('retry-me', dir);
  const entry = Object.values(readUnfinished(hermit(dir)))[0];
  expect(entry).toMatchObject({ state: 'started', delivery: 'cron-create', skill: 'test:run' });
  expect(new Date(entry.mark).getUTCSeconds()).toBe(0);
}));

test('eligible retry emits an already-sent digest; forged retry emits none', withDir(async dir => {
  retryFixture(dir);
  expect(JSON.parse((await retryRun(dir)).stdout).retry).toBeUndefined();
  stampInterrupted(hermit(dir), 'unclean');
  const output = JSON.parse((await retryRun(dir)).stdout);
  expect(output.retry).toMatchObject({ cause: 'unclean', already_sent: [] });
  expect(output.retry.log_note).toContain('no live sender');
  const cli = await runScript('routines.ts', { cwd: dir, args: ['recover', '--context', 'retry-me'] });
  expect(JSON.parse(cli.stdout).retry).toMatchObject({ cause: 'unclean', already_sent: [] });
}));
