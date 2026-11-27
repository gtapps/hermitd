import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { openOperatorTurn, operatorTurnOpen, readExecution, readExecutionRaw, recordOperatorActivity, seedOperatorActivity, sessionStarted, turnEnded, turnStarted } from '../scripts/lib/turn-state';

const read = (dir: string, name: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state', name), 'utf8')); } catch { return null; } };
const quiet = (dir: string) => Date.parse(read(dir, 'last-operator-action.json')?.at ?? '');

it('Stop closes the open operator turn and restarts the quiet clock from its end', () => {
  const f = taskFixture(); try {
    const t0 = Date.parse('2026-11-27T10:00:00Z');
    recordOperatorActivity(f.dir, t0);
    openOperatorTurn(f.dir, t0);
    turnStarted(f.dir, 's', null);
    expect(operatorTurnOpen(f.dir, t0 + 1000)).toBe(true);
    turnEnded(f.dir, { cause: 'stop', session: 's', backgroundTasks: [], at: t0 + 60000 });
    expect(operatorTurnOpen(f.dir, t0 + 61000)).toBe(false);
    expect(quiet(f.dir)).toBe(t0 + 60000);
    expect(readExecution(f.dir).state).toBe('idle');
  } finally { f.cleanup(); }
});

it('a Stop with no open operator turn leaves the quiet clock alone', () => {
  const f = taskFixture(); try {
    const t0 = Date.parse('2026-11-27T10:00:00Z');
    recordOperatorActivity(f.dir, t0);
    turnEnded(f.dir, { cause: 'stop', session: 's', backgroundTasks: [], at: t0 + 60000 });
    expect(quiet(f.dir)).toBe(t0);
  } finally { f.cleanup(); }
});

it('a Stop after a startup idle stamp still refreshes the stamp', () => {
  const f = taskFixture(); try {
    sessionStarted(f.dir, 's', 'clear');
    const before = readExecution(f.dir);
    expect(before).toMatchObject({ state: 'idle', reason: 'resident-start:clear' });
    turnEnded(f.dir, { cause: 'stop', session: 's2', backgroundTasks: [] });
    expect(readExecution(f.dir)).toMatchObject({ state: 'idle', cc_session_id: 's2', reason: null });
  } finally { f.cleanup(); }
});

it('StopFailure idles execution and leaves the operator-turn marker', () => {
  const f = taskFixture(); try {
    const t0 = Date.now();
    openOperatorTurn(f.dir, t0);
    turnStarted(f.dir, 's', null);
    turnEnded(f.dir, { cause: 'stop-failure', session: 's', backgroundTasks: [] });
    expect(readExecution(f.dir)).toMatchObject({ state: 'idle', reason: 'stop-failure' });
    expect(operatorTurnOpen(f.dir, t0 + 1000)).toBe(true);
  } finally { f.cleanup(); }
});

it('a late interrupt report leaves the next prompt\'s turn, marker and quiet clock alone', () => {
  const f = taskFixture(); try {
    const t0 = Date.now() - 10000;
    // The interrupted turn ended at t0; the next prompt arrived and stamped all three files after.
    turnStarted(f.dir, 's', null);
    openOperatorTurn(f.dir, t0 + 5000);
    recordOperatorActivity(f.dir, t0 + 5000);
    turnEnded(f.dir, { cause: 'interrupt', session: 's', at: t0, reason: 'aborted' });
    expect(readExecution(f.dir).state).toBe('in_flight');
    expect(operatorTurnOpen(f.dir, t0 + 6000)).toBe(true);
    expect(quiet(f.dir)).toBe(t0 + 5000);
  } finally { f.cleanup(); }
});

it('an interrupt ends the operator turn it interrupted and restarts the quiet clock from its end', () => {
  const f = taskFixture(); try {
    const start = Date.now() - 10000;
    openOperatorTurn(f.dir, start);
    recordOperatorActivity(f.dir, start);
    turnStarted(f.dir, 's', null);
    const end = Date.now() + 1000;
    turnEnded(f.dir, { cause: 'interrupt', session: 's', at: end, reason: 'aborted' });
    expect(readExecution(f.dir)).toMatchObject({ state: 'idle', reason: 'aborted' });
    expect(fs.existsSync(path.join(f.dir, 'state/operator-turn-open.json'))).toBe(false);
    expect(quiet(f.dir)).toBe(end);
  } finally { f.cleanup(); }
});

it('a turn end never moves the quiet clock back', () => {
  const f = taskFixture(); try {
    const t0 = Date.parse('2026-11-27T10:00:00Z');
    recordOperatorActivity(f.dir, t0 + 60000);
    openOperatorTurn(f.dir, t0);
    turnEnded(f.dir, { cause: 'stop', session: 's', backgroundTasks: [], at: t0 });
    expect(quiet(f.dir)).toBe(t0 + 60000);
  } finally { f.cleanup(); }
});

it('the raw read keeps an in_flight stamp older than an hour', () => {
  const f = taskFixture(); try {
    f.put('state/execution.json', { state: 'in_flight', at: '2020-01-01T00:00:00Z', cc_session_id: 's' });
    expect(readExecution(f.dir).state).toBe('unknown');
    expect(readExecutionRaw(f.dir)).toMatchObject({ state: 'in_flight', cc_session_id: 's' });
  } finally { f.cleanup(); }
});

it('the quiet clock seeds only when absent', () => {
  const f = taskFixture(); try {
    seedOperatorActivity(f.dir);
    const first = quiet(f.dir);
    expect(Number.isFinite(first)).toBe(true);
    recordOperatorActivity(f.dir, first - 60000);
    seedOperatorActivity(f.dir);
    expect(quiet(f.dir)).toBe(first - 60000);
  } finally { f.cleanup(); }
});
