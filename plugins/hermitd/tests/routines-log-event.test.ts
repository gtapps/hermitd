import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, writeConfig, type Workdir, hermit } from './helpers/workdir';
import { logRoutineEvent } from '../scripts/lib/routines/event';

describe('routines.ts log-event', () => {

  // Empirically confirmed (bun 1.3.14 & 1.4.0): describe.serial does not reliably
  // force sequential execution of its own child tests under --concurrent —
  // only per-test .serial marking does. So each test below is marked individually.
  describe('hermit root resolution', () => {
    let wd: Workdir;
    const metrics = () => hermit(wd.dir, 'state', 'routine-metrics.jsonl');

    beforeAll(() => {
      wd = setupWorkdir();
      fs.mkdirSync(path.join(wd.dir, 'app', 'sub'), { recursive: true });
    });
    afterAll(() => wd.cleanup());

    test.serial('log-event (subdir resolves to ancestor)', async () => {
      // Fired from a subdirectory → appends to the ancestor's state file
      await runScript('routines.ts', { args: ['log-event', 'morning-brief', 'fired'], cwd: path.join(wd.dir, 'app', 'sub') });
      const content = fs.readFileSync(metrics(), 'utf-8');
      expect(content).toContain('"routine_id":"morning-brief","event":"fired"');
    });

    test.serial('log-event (root resolves to state file)', async () => {
      // Fired from the hermit root → unchanged behavior
      expect((await runScript('routines.ts', { args: ['log-event', 'weekly-review', 'skipped-waiting'], cwd: wd.dir })).stdout).toBe('OK\n');
      const content = fs.readFileSync(metrics(), 'utf-8');
      expect(content).toContain('"routine_id":"weekly-review","event":"skipped-waiting"');
    });

    test.serial('log-event (started event serializes correctly)', async () => {
      // started marker emitted before skill invocation — must serialize like other events
      await runScript('routines.ts', { args: ['log-event', 'daily-brief', 'started'], cwd: wd.dir });
      const content = fs.readFileSync(metrics(), 'utf-8');
      expect(content).toContain('"routine_id":"daily-brief","event":"started"');
    });
  });

  // The in-process callers (precheck, finish, due) hand over a hermit dir they
  // already resolved. logRoutineEvent must write under exactly that dir and not
  // re-derive one: when it walked, a config-less dir nested under a hatched
  // parent sent the row to the parent's ledger — a cross-project write, and in
  // finish.ts a split between the run record and the ledger row.
  test('logRoutineEvent writes under the hermit dir it is given, without walking', () => {
    const wd = setupWorkdir();
    try {
      writeConfig(wd.dir, { agent_name: 'test' }); // ancestor is hatched — pass 1 would prefer it
      const child = path.join(wd.dir, 'child', '.hermit');
      fs.mkdirSync(path.join(child, 'state'), { recursive: true }); // no config.json
      expect(logRoutineEvent('nested-routine', 'fired', child, 'monitor')).toBeNull();

      const childLedger = path.join(child, 'state', 'routine-metrics.jsonl');
      expect(fs.readFileSync(childLedger, 'utf-8')).toContain('"routine_id":"nested-routine"');
      // The hatched ancestor a walk would have preferred stays untouched.
      expect(fs.existsSync(hermit(wd.dir, 'state', 'routine-metrics.jsonl'))).toBe(false);
    } finally {
      wd.cleanup();
    }
  });

  // Order-coupled: both tests append to the same shared routine-metrics.jsonl
  // and the second reads a `before` baseline left by the first's writes.
  describe('duplicate fired guard (#464)', () => {
    let wd: Workdir;
    const metrics = () => hermit(wd.dir, 'state', 'routine-metrics.jsonl');
    const firedCount = () =>
      fs
        .readFileSync(metrics(), 'utf-8')
        .split('\n')
        .filter((l) => l.includes('"routine_id":"hermitd:heartbeat-restart","event":"fired"')).length;

    beforeAll(() => {
      wd = setupWorkdir();
    });
    afterAll(() => wd.cleanup());

    test.serial('suppresses a fired that immediately follows another fired', async () => {
      await runScript('routines.ts', { args: ['log-event', 'hermitd:heartbeat-restart', 'started'], cwd: wd.dir });
      await runScript('routines.ts', { args: ['log-event', 'hermitd:heartbeat-restart', 'fired'], cwd: wd.dir });
      await runScript('routines.ts', { args: ['log-event', 'hermitd:heartbeat-restart', 'fired'], cwd: wd.dir });
      expect(firedCount()).toBe(1);
    });

    test.serial('allows the next legitimate started→fired cycle', async () => {
      const before = firedCount();
      await runScript('routines.ts', { args: ['log-event', 'hermitd:heartbeat-restart', 'started'], cwd: wd.dir });
      await runScript('routines.ts', { args: ['log-event', 'hermitd:heartbeat-restart', 'fired'], cwd: wd.dir });
      expect(firedCount()).toBe(before + 1);
    });
  });

  describe('duplicate fired guard reads fields, not bytes', () => {
    // A workdir per test: both seed the same ledger path, so sharing one would
    // make them race (the reason the #464 block above is marked test.serial).
    const seeded = async (row: object, id: string) => {
      const wd = setupWorkdir();
      try {
        const metrics = hermit(wd.dir, 'state', 'routine-metrics.jsonl');
        fs.writeFileSync(metrics, JSON.stringify(row) + '\n');
        await runScript('routines.ts', { args: ['log-event', id, 'fired'], cwd: wd.dir });
        return fs.readFileSync(metrics, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      } finally {
        wd.cleanup();
      }
    };

    test('suppresses against a prior row whose keys are in a different order', async () => {
      // The guard used to substring-match `"event":"fired"`, which made JSON key
      // order load-bearing for correctness. An operator-written or migrated row
      // serialized differently would have silently disabled the guard.
      const rows = await seeded({
        event: 'fired', delivery: 'monitor', routine_id: 'reorder-check', ts: new Date().toISOString(),
      }, 'reorder-check');
      expect(rows).toHaveLength(1);
    });

    test('a routine id that prefixes another does not suppress it', async () => {
      const rows = await seeded({
        ts: new Date().toISOString(), routine_id: 'brief-extended', event: 'fired', delivery: 'monitor',
      }, 'brief');
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ routine_id: 'brief', event: 'fired' });
    });
  });

  describe('no hermit ancestor', () => {
    // No .hermit/ ancestor → non-zero exit with a clear error token
    let exitCode = 0;
    let stdout = '';

    beforeAll(async () => {
      const nohermit = fs.mkdtempSync(path.join(os.tmpdir(), 'no-hermit-'));
      try {
        const r = await runScript('routines.ts', { args: ['log-event', 'x', 'fired'], cwd: nohermit });
        exitCode = r.exitCode;
        stdout = r.stdout;
      } finally {
        try { fs.rmSync(nohermit, { recursive: true, force: true }); } catch {}
      }
    });

    test('log-routine-event (no ancestor exits non-zero)', () => {
      expect(exitCode).not.toBe(0);
    });
    test('log-routine-event (no ancestor diagnostic)', () => {
      expect(JSON.parse(stdout)).toEqual({ error: 'no_hermit_dir' });
    });
  });
});
