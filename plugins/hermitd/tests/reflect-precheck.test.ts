import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import { runScript, runPinnedScript, PLUGIN_ROOT } from './helpers/run';
import { withDir, hermit, write, readJson } from './helpers/workdir';
import { isoSec, daysAgo } from './helpers/fixture-dates';

const runReflectPrecheck = (dir: string, opts: { cwd?: string; env?: Record<string, string> } = {}) =>
  runPinnedScript('reflect-precheck.ts', hermit(dir), [hermit(dir), PLUGIN_ROOT], opts);

async function seedComputeActivity(dir: string) {
  const opened = await runScript('task.ts', { args: ['open', hermit(dir), '--title', 'Compute activity', '--requester', 'operator', '--done', 'Verified'], cwd: dir });
  expect(opened.exitCode).toBe(0);
  const id = JSON.parse(opened.stdout).id;
  const result = await runScript('task.ts', { args: ['block', hermit(dir), id, '--result-stdin'], stdin: 'Completed work', cwd: dir });
  expect(result.exitCode).toBe(0);
}

function seedReflect(dir: string, stateJson: object) {
  write(hermit(dir, 'config.json'), '{"timezone":"UTC"}');
  write(hermit(dir, 'state', 'runtime.json'), '{}');
  fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  // Default a recent behavior-digest cursor so the weekly `behavior` phase stays
  // quiet unless a test opts in (callers override by including the key).
  write(hermit(dir, 'state', 'reflection-state.json'),
    JSON.stringify({ last_behavior_digest_at: isoSec(new Date()), ...stateJson }));
}

describe('reflect-precheck', () => {
  const since30 = () => isoSec(daysAgo(30));

  // 21. EMPTY — all timestamps recent, session idle, no accepted proposals
  test('reflect-precheck (EMPTY: no due phases)', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      last_reflection: today, last_resolution_check: null, last_digest_at: today,
      counters: { total_runs: 5, empty_runs: 2, runs_with_candidates: 3, last_run_at: today, since: since30() },
    });
    // No cost log or task results newer than last_run_at
    const r = await runReflectPrecheck(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd()).toBe('{"status":"empty"}');
  }));

  // 22. EMPTY path leaves frozen SHELL.md unchanged.
  test('reflect-precheck (EMPTY: frozen SHELL.md is unchanged)', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      last_reflection: today,
      counters: { total_runs: 1, empty_runs: 0, last_run_at: today, since: since30() },
    });
    const frozen = '# Frozen journal\n';
    write(hermit(dir, 'sessions', 'SHELL.md'), frozen);
    await runReflectPrecheck(dir);
    expect(fs.readFileSync(hermit(dir, 'sessions', 'SHELL.md'), 'utf-8')).toBe(frozen);
  }));

  // 23. EMPTY path: empty_runs incremented in reflection-state.json
  test('reflect-precheck (EMPTY: empty_runs incremented)', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      counters: { total_runs: 3, empty_runs: 1, runs_with_candidates: 2, last_run_at: today, since: since30() },
    });
    await runReflectPrecheck(dir);
    const d = readJson(hermit(dir, 'state', 'reflection-state.json'));
    expect(d.counters.empty_runs).toBe(2);
    expect(d.counters.total_runs).toBe(4);
  }));

  // 24. RUN — resolution_check due (accepted proposal + last_resolution_check > 7 days)
  test('reflect-precheck ignores obsolete resolution_check', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      counters: { total_runs: 5, empty_runs: 2, last_run_at: today, since: since30() },
      last_resolution_check: '2026-04-01T00:00:00Z',
    });
    write(hermit(dir, 'proposals', 'PROP-001.md'),
      '---\nstatus: accepted\naccepted_date: 2026-04-01\ntitle: Test\n---\nBody\n');
    const r = await runReflectPrecheck(dir);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'empty' });
  }));

  // 24b. RUN — resolution_check due via new-format proposal filename (PROP-NNN-slug-HHMMSS.md)
  test('reflect-precheck ignores accepted legacy proposal files', withDir(async (dir) => {
    const today = isoSec(new Date());
    seedReflect(dir, {
      counters: { total_runs: 5, empty_runs: 2, last_run_at: today, since: since30() },
      last_resolution_check: '2026-04-01T00:00:00Z',
    });
    write(hermit(dir, 'proposals', 'PROP-002-test-new-format-103612.md'),
      '---\nid: PROP-002-test-new-format-103612\nstatus: accepted\naccepted_date: 2026-04-01\ntitle: Test new format\n---\nBody\n');
    const r = await runReflectPrecheck(dir);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'empty' });
  }));

  // 25. RUN: compute activity from a new task result
  test('reflect-precheck (RUN: compute activity detected)', withDir(async (dir) => {
    seedReflect(dir, {
      counters: { total_runs: 2, empty_runs: 1, last_run_at: '2026-01-01T00:00:00Z', since: since30() },
    });
    await seedComputeActivity(dir);
    const r = await runReflectPrecheck(dir);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'run', phases: { compute: true }, phase: 'adult' });
  }));

  test('reflect-precheck ignores a large frozen journal and omits archive_due', withDir(async (dir) => {
    seedReflect(dir, {
      counters: { total_runs: 2, empty_runs: 1, last_run_at: '2026-01-01T00:00:00Z', since: since30() },
    });
    const frozen = '# Frozen journal\n' + 'Historical work\n'.repeat(450);
    write(hermit(dir, 'sessions', 'SHELL.md'), frozen);
    await seedComputeActivity(dir);
    const result = await runReflectPrecheck(dir);
    expect(JSON.parse(result.stdout).phases.compute).toBe(true);
    expect(result.stdout).not.toContain('archive_due');
    expect(fs.readFileSync(hermit(dir, 'sessions', 'SHELL.md'), 'utf-8')).toBe(frozen);
    expect(fs.existsSync(hermit(dir, 'sessions', 'snapshots'))).toBe(false);
  }));

  test('reflect-precheck --quick: empty with no records, a run hash under --force', withDir(async (dir) => {
    seedReflect(dir, {});
    const quick = (flags: string[]) => runPinnedScript('reflect-precheck.ts', hermit(dir), [hermit(dir), PLUGIN_ROOT, ...flags]);
    expect((await quick(['--quick'])).stdout.trimEnd()).toBe('{"status":"empty"}');
    const forced = JSON.parse((await quick(['--quick', '--force'])).stdout);
    expect(forced.status).toBe('run');
    expect(forced.hash).toMatch(/^[0-9a-f]{64}$/);
  }));

});
