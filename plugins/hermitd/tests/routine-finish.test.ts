// Contract tests for `routines.ts finish` — the terminal gate that decides
// whether a routine fire is recorded as `fired`. Exercised as a subprocess, the
// same shape as tests/routine-precheck.test.ts (both resolve the hermit root via
// lib/cc-compat's hermitDir()).
//
// The regression this file exists for: a routine's success used to be logged
// from the dispatched subagent's self-report, so a skill that wrote nothing (or
// wrote to the wrong path) still produced a clean `fired` row.
//
// Usage: bun test tests/routine-finish.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { setPause } from '../scripts/lib/pause';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

const readMetricsRows = (dir: string) => {
  try {
    return fs.readFileSync(hermit(dir, 'state', 'routine-metrics.jsonl'), 'utf-8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const events = (dir: string, id: string) =>
  readMetricsRows(dir).filter((r) => r.routine_id === id).map((r) => r.event);

const writeConfig = (dir: string, routines: unknown[], timezone: string | null = 'UTC') =>
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone, routines }));

const writeArtifact = (dir: string, rel: string, body: string) => {
  const abs = hermit(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

const precheck = (dir: string, id: string) =>
  runScript('routines.ts', { args: ['precheck', id], cwd: dir });
const finish = (dir: string, id: string, stdin = '') =>
  runScript('routines.ts', { args: ['finish', id, '--outcome-stdin'], cwd: dir, stdin });

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

/** Today's YYYY-MM-DD in UTC — matches what resolveArtifactPath freezes for a UTC config. */
const todayUTC = () => new Date().toISOString().slice(0, 10);

describe('routines.ts finish — routines with no artifact contract', () => {
  test('logs fired unconditionally (legacy behavior preserved)', withDir(async (dir) => {
    writeConfig(dir, [{ id: 'plain', schedule: '0 9 * * *', skill: 'x', enabled: true }]);
    await precheck(dir, 'plain');
    const r = await finish(dir, 'plain');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'plain')).toEqual(['started', 'fired']);
  }));

  test('logs fired even with no run record and no config at all', withDir(async (dir) => {
    const r = await finish(dir, 'orphan');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'orphan')).toEqual(['fired']);
  }));
});

describe('routines.ts finish — declared artifact contract', () => {
  const CONTRACT = 'raw/snapshot-calendar-{date}.md';
  const declared = (extra: Record<string, unknown> = {}) => [
    { id: 'cal', schedule: '0 6 * * *', skill: 'calendar-fetch-light', enabled: true, expect_artifact: CONTRACT, ...extra },
  ];

  test('absent before, written during the run → fired', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    writeArtifact(dir, `raw/snapshot-calendar-${todayUTC()}.md`, 'fresh events\n');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'cal')).toEqual(['started', 'fired']);
  }));

  test('never written → failed-artifact-missing, not fired', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    const r = await finish(dir, 'cal');
    expect(JSON.parse(r.stdout)).toEqual({ status: 'failed', reason: 'artifact_missing', detail: `raw/snapshot-calendar-${todayUTC()}.md` });
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-missing']);
    expect(events(dir, 'cal')).not.toContain('fired');
  }));

  // The 2026-08-06 incident: an older file from an earlier same-day dispatch was
  // still on disk, so a plain existence check would have passed.
  test('stale file left untouched by the run → failed-artifact-unchanged', withDir(async (dir) => {
    writeConfig(dir, declared());
    writeArtifact(dir, `raw/snapshot-calendar-${todayUTC()}.md`, 'yesterday-ish content\n');
    await precheck(dir, 'cal');
    const r = await finish(dir, 'cal');
    expect(JSON.parse(r.stdout)).toEqual({ status: 'failed', reason: 'artifact_unchanged', detail: `raw/snapshot-calendar-${todayUTC()}.md` });
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-unchanged']);
  }));

  test('pre-existing file rewritten during the run → fired', withDir(async (dir) => {
    writeConfig(dir, declared());
    const rel = `raw/snapshot-calendar-${todayUTC()}.md`;
    writeArtifact(dir, rel, 'old\n');
    await precheck(dir, 'cal');
    writeArtifact(dir, rel, 'new content, different size\n');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'cal')).toEqual(['started', 'fired']);
  }));

  test('a symlink at the target path never counts as the artifact', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    const real = writeArtifact(dir, 'raw/elsewhere.md', 'content\n');
    fs.symlinkSync(real, hermit(dir, `raw/snapshot-calendar-${todayUTC()}.md`));
    const r = await finish(dir, 'cal');
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'failed', reason: 'artifact_missing' });
  }));

  test('missing run record for a declared contract → verification-error, never fired', withDir(async (dir) => {
    writeConfig(dir, declared());
    // No precheck: nothing froze a baseline. The artifact even exists — that must
    // not be enough, because nothing proves this run produced it.
    writeArtifact(dir, `raw/snapshot-calendar-${todayUTC()}.md`, 'unattributable\n');
    const r = await finish(dir, 'cal');
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'failed', reason: 'verification_error' });
    expect(events(dir, 'cal')).toEqual(['failed-verification-error']);
  }));

  test('finalize is idempotent — a replayed finish writes no second terminal row', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    writeArtifact(dir, `raw/snapshot-calendar-${todayUTC()}.md`, 'written\n');
    const first = await finish(dir, 'cal');
    const second = await finish(dir, 'cal');
    expect(first.stdout.trim()).toBe('{"status":"fired"}');
    expect(second.stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'cal')).toEqual(['started', 'fired']);
  }));

  test('a replayed failure re-reports the failure, and still writes one row', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    await finish(dir, 'cal');
    const second = await finish(dir, 'cal');
    expect(JSON.parse(second.stdout)).toMatchObject({ status: 'failed', reason: 'artifact_missing' });
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-missing']);
  }));

  // Without this, the stale record's `outcome` short-circuits finish forever:
  // every later fire logs `started` with no terminal row (which reflect reads as
  // an errored routine) and re-emits a failure line the skill escalates to the
  // operator, for a contract that no longer exists.
  test('dropping expect_artifact from config restores the legacy fired path', withDir(async (dir) => {
    writeConfig(dir, declared());
    await precheck(dir, 'cal');
    await finish(dir, 'cal'); // fails — nothing written

    writeConfig(dir, [{ id: 'cal', schedule: '0 6 * * *', skill: 'calendar-fetch-light', enabled: true }]);
    await precheck(dir, 'cal');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-missing', 'started', 'fired']);
    expect(JSON.parse(fs.readFileSync(hermit(dir, 'state', 'routine-run.json'), 'utf-8')).cal).toBeUndefined();
  }));

  // validate-config.ts is a PostToolUse advisory — a hand-edited config can land a
  // traversal on disk. precheck must refuse it rather than freeze a baseline
  // pointing outside the state dir.
  test('an invalid expect_artifact is refused at fire time, never silently verified', withDir(async (dir) => {
    writeConfig(dir, declared({ expect_artifact: 'raw/../../../escape.md' }));
    await precheck(dir, 'cal');
    expect(fs.existsSync(hermit(dir, 'state', 'routine-run.json'))).toBe(false);
    const r = await finish(dir, 'cal');
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'failed', reason: 'verification_error' });
    expect(events(dir, 'cal')).toEqual(['started', 'failed-verification-error']);
  }));

  test('the next fire re-arms: a new precheck clears the previous outcome', withDir(async (dir) => {
    writeConfig(dir, declared());
    const rel = `raw/snapshot-calendar-${todayUTC()}.md`;
    await precheck(dir, 'cal');
    await finish(dir, 'cal'); // fails — nothing written
    await precheck(dir, 'cal');
    writeArtifact(dir, rel, 'this time it wrote\n');
    const r = await finish(dir, 'cal');
    expect(r.stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-missing', 'started', 'fired']);
  }));
});

describe('routines.ts finish — outcome line on stdin', () => {
  test('finishes with an open stdin pipe without an outcome flag', withDir(async (dir) => {
    const r = await runScript('routines.ts', { args: ['finish', 'plain', 'monitor'], cwd: dir, openStdin: true });
    expect(r.stdout.trim()).toBe('{"status":"fired"}');
    expect(r.exitCode).toBe(0);
  }));

  test('outcome input preserves one terminal row on a replayed fire', withDir(async (dir) => {
    writeConfig(dir, [
      { id: 'cal', schedule: '0 6 * * *', skill: 'x', enabled: true, expect_artifact: 'raw/s-{date}.md' },
    ]);
    writeArtifact(dir, `raw/s-${todayUTC()}.md`, 'baseline\n');
    await precheck(dir, 'cal');
    writeArtifact(dir, `raw/s-${todayUTC()}.md`, 'fresh content\n');

    expect((await finish(dir, 'cal', 'calendar snapshot refreshed\n')).stdout.trim()).toBe('{"status":"fired"}');

    // The re-triggered fire replays the recorded outcome; it is not a second fire.
    expect((await finish(dir, 'cal', 'calendar snapshot refreshed\n')).stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'cal')).toEqual(['started', 'fired']);
    expect(fs.existsSync(hermit(dir, 'sessions', 'SHELL.md'))).toBe(false);
  }));

  // Most routines declare no contract and so never get a run record, which is what the
  // replay gate above reads. The ledger has to carry the invariant for them, or a
  // re-triggered fire doubles the row while event.ts's #464 guard hides the duplicate.
  test('one row per real fire for a routine with no contract, replay included', withDir(async (dir) => {
    writeConfig(dir, [{ id: 'plain', schedule: '0 9 * * *', skill: 'x', enabled: true }]);
    await precheck(dir, 'plain');

    expect((await finish(dir, 'plain', 'plain routine did the thing\n')).stdout.trim()).toBe('{"status":"fired"}');

    expect((await finish(dir, 'plain', 'plain routine did the thing\n')).stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'plain').filter((e) => e === 'fired')).toHaveLength(1);

    // A genuine next fire still lands its own row: precheck's `started` clears the replay.
    await precheck(dir, 'plain');
    expect((await finish(dir, 'plain', 'plain routine ran again\n')).stdout.trim()).toBe('{"status":"fired"}');
    expect(events(dir, 'plain').filter((e) => e === 'fired')).toHaveLength(2);
  }));

  test('empty stdin leaves retired journal absent and stdout unchanged', withDir(async (dir) => {
    writeConfig(dir, [{ id: 'plain', schedule: '0 9 * * *', skill: 'x', enabled: true }]);
    await precheck(dir, 'plain');

    const r = await finish(dir, 'plain', '   \n');
    expect(r.stdout).toBe('{"status":"fired"}\n');
    expect(fs.existsSync(hermit(dir, 'sessions', 'SHELL.md'))).toBe(false);
  }));

  test('a failed contract with outcome input still records failure', withDir(async (dir) => {
    writeConfig(dir, [
      { id: 'cal', schedule: '0 6 * * *', skill: 'x', enabled: true, expect_artifact: 'raw/s-{date}.md' },
    ]);
    await precheck(dir, 'cal');
    const r = await finish(dir, 'cal', 'calendar fetch produced nothing\n');
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'failed', reason: 'artifact_missing' });
    expect(events(dir, 'cal')).toEqual(['started', 'failed-artifact-missing']);
  }));
});

describe('routines.ts finish — run record', () => {
  test('precheck freezes the resolved path and baseline; the ledger row shape is untouched', withDir(async (dir) => {
    writeConfig(dir, [
      { id: 'cal', schedule: '0 6 * * *', skill: 'x', enabled: true, expect_artifact: 'compiled/digest-{date}.md' },
    ]);
    writeArtifact(dir, `compiled/digest-${todayUTC()}.md`, 'baseline\n');
    await precheck(dir, 'cal');

    const record = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'routine-run.json'), 'utf-8')).cal;
    expect(record.resolved_path).toBe(`compiled/digest-${todayUTC()}.md`);
    expect(record.baseline).toMatchObject({ size: 'baseline\n'.length });
    expect(typeof record.started_ts).toBe('string');

    // The pinned 4-key ledger schema must survive the sidecar's introduction.
    const rows = readMetricsRows(dir);
    expect(Object.keys(rows[0]).sort()).toEqual(['delivery', 'event', 'routine_id', 'ts']);
  }));

  test('no run record is written for a routine without a contract', withDir(async (dir) => {
    writeConfig(dir, [{ id: 'plain', schedule: '0 9 * * *', skill: 'x', enabled: true }]);
    await precheck(dir, 'plain');
    expect(fs.existsSync(hermit(dir, 'state', 'routine-run.json'))).toBe(false);
  }));

  test('a fire the gate skipped writes no run record', withDir(async (dir) => {
    writeConfig(dir, [
      { id: 'cal', schedule: '0 6 * * *', skill: 'x', enabled: true, expect_artifact: 'raw/s-{date}.md' },
    ]);
    setPause(hermit(dir), { reason: 'operator', by: 'test' });
    const r = await runScript('routines.ts', { args: ['precheck', 'cal'], cwd: dir });
    expect(r.stdout.trim()).toBe('{"status":"skip"}');
    expect(fs.existsSync(hermit(dir, 'state', 'routine-run.json'))).toBe(false);
  }));
});

test('finish without a routine id is a usage failure', withDir(async (dir) => {
  const r = await runScript('routines.ts', { args: ['finish'], cwd: dir });
  expect(r.exitCode).toBe(1);
  expect(JSON.parse(r.stdout)).toEqual({ error: 'usage' });
}));
