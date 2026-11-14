import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { freshDirFactory } from './helpers/workdir';
import { reconcileRoutines, stillPendingRoutine } from '../scripts/lib/routines/recover';
import { markDispatched, markStarted, stampInterrupted, readUnfinished, withUnfinished } from '../scripts/lib/routines/unfinished';
import { clearRecoveryPending, markUnfinished, clearConversations } from '../scripts/lib/channel-recovery';
const { freshDir, cleanup } = freshDirFactory('routine-recovery-');
afterAll(cleanup);
const now = Date.parse('2026-11-14T10:00:00Z');
const mark = new Date(now).toISOString();
const key = `r@${mark}`;
function fixture(routine = {}) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ routines: [{ id: 'r', skill: 'test:run', enabled: true, ...routine }] }));
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ cc_session_id: 'current' }));
  markStarted(dir, { routine_id: 'r', skill: 'test:run', mark, started_at: mark, delivery: 'monitor', session_id: 'previous' });
  stampInterrupted(dir, 'unclean');
  return dir;
}
const rows = (dir: string) => fs.readFileSync(path.join(dir, 'state/routine-metrics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('unclean interruption queues a retry without spending it', () => {
  const dir = fixture();
  expect(reconcileRoutines(dir, now)).toEqual({ pending: true, entries: [{ source: 'recovery', purpose: `routine-retry:${key}`,
    commands: [{ command: '/hermitd:hermit-routines', arg: `run r --retry ${mark} --delivery monitor` }] }] });
  expect(stillPendingRoutine(dir, key, now)).toBe(true);
  expect(readUnfinished(dir)[key].attempts).toBe(0);
});

for (const reason of ['planned', 'optout', 'disabled', 'removed', 'skill', 'superseded']) test(`${reason} closes silently`, () => {
  const dir = fixture(reason === 'optout' ? { retry_after_crash: false } : reason === 'disabled' ? { enabled: false } : reason === 'skill' ? { skill: 'changed' } : {});
  if (reason === 'planned') withUnfinished(dir, s => { s[key].cause = 'planned'; });
  if (reason === 'removed') fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ routines: [] }));
  if (reason === 'superseded') markDispatched(dir, { routine_id: 'r', skill: 'test:run', mark: new Date(now + 60000).toISOString(), delivery: 'monitor' });
  expect(reconcileRoutines(dir, now).entries).toEqual([]);
  expect(readUnfinished(dir)[key]).toBeUndefined();
  expect(rows(dir)[0].detail).toBe(`${['removed', 'skill'].includes(reason) ? 'disabled' : reason}:${reason === 'planned' ? 'planned' : 'unclean'}`);
});

test('later ledger start supersedes an interrupted occurrence', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'state/routine-metrics.jsonl'), JSON.stringify({ routine_id: 'r', event: 'started', ts: new Date(now + 60000).toISOString() }) + '\n');
  expect(reconcileRoutines(dir, now + 60000).entries).toEqual([]);
  expect(rows(dir).at(-1).detail).toBe('superseded:unclean');
});

test('API backoff parses offsets, processes each stamp once, and retries after not_before', () => {
  const dir = fixture();
  withUnfinished(dir, s => { s[key].cause = 'api'; });
  let at = now;
  for (const minutes of [10, 30, 60, 60]) {
    fs.writeFileSync(path.join(dir, 'state/stop-failure.json'), JSON.stringify({ at: new Date(at).toISOString().replace('Z', '+00:00') }));
    expect(reconcileRoutines(dir, at)).toEqual({ pending: true, entries: [] });
    expect(reconcileRoutines(dir, at)).toEqual({ pending: true, entries: [] });
    expect(readUnfinished(dir)[key].not_before).toBe(new Date(at + minutes * 60000).toISOString());
    at += minutes * 60000;
    expect(reconcileRoutines(dir, at).entries).toHaveLength(1);
  }
});

for (const cause of ['expired', 'retry']) test(`${cause} produces one lost event and a pending notice`, () => {
  const dir = fixture();
  if (cause === 'retry') withUnfinished(dir, s => { s[key].attempts = 1; });
  const at = cause === 'expired' ? now + 6 * 3600000 + 1 : now;
  const result = reconcileRoutines(dir, at);
  expect(result.pending).toBe(true);
  expect(result.entries[0].purpose).toBe(`routine-lost:${key}`);
  expect(readUnfinished(dir)[key].state).toBe('lost');
  reconcileRoutines(dir, at);
  expect(rows(dir)).toHaveLength(1);
});

test('pause preserves pending retry; heartbeat anchor is discarded', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'state/pause.json'), JSON.stringify({ reason: 'operator', by: 'test', at: mark }));
  // Use the public pause writer; its state contract is independent of this fixture.
  setPause(dir, { reason: 'operator', by: 'test' });
  expect(reconcileRoutines(dir, now)).toEqual({ pending: true, entries: [] });
  markDispatched(dir, { routine_id: 'hermitd:heartbeat-restart', skill: 'hermitd:heartbeat start', mark, delivery: 'cron-create' });
  reconcileRoutines(dir, now);
  expect(Object.keys(readUnfinished(dir))).toEqual([key]);
});
import { setPause } from '../scripts/lib/pause';

test('Esc-aborted starts close, live turns wait, completion boundary defeats stale execution', () => {
  for (const live of [true, false]) {
    const dir = fixture();
    withUnfinished(dir, s => { s[key].state = 'started'; s[key].session_id = 'current'; delete s[key].cause; });
    fs.writeFileSync(path.join(dir, 'state/execution.json'), JSON.stringify({ state: 'in_flight', cc_session_id: 'current', at: mark }));
    expect(reconcileRoutines(dir, now, live ? now - 1 : now)).toEqual({ pending: live, entries: [] });
    if (!live) expect(rows(dir)[0].detail).toBe('aborted:-');
  }
});

test('dispatch-only and unsupported awaiting occurrences are not pending; live awaiting is', () => {
  const dir = fixture();
  withUnfinished(dir, s => { s[key].state = 'dispatched'; });
  expect(reconcileRoutines(dir, now).pending).toBe(false);
  withUnfinished(dir, s => { s[key].state = 'awaiting'; s[key].session_id = 'current'; });
  expect(reconcileRoutines(dir, now).pending).toBe(false);
  fs.writeFileSync(path.join(dir, 'state/execution.json'), JSON.stringify({ state: 'in_flight', cc_session_id: 'current', at: mark }));
  expect(reconcileRoutines(dir, now).pending).toBe(true);
});

test('shared marker only clears after both stores empty', () => {
  const dir = fixture();
  const marker = path.join(dir, 'state/recovery-pending');
  clearRecoveryPending(dir);
  expect(fs.existsSync(marker)).toBe(true);
  markUnfinished(dir, 'custom:chat', mark);
  withUnfinished(dir, s => { delete s[key]; });
  clearRecoveryPending(dir);
  expect(fs.existsSync(marker)).toBe(true);
  clearConversations(dir, ['custom:chat']);
  clearRecoveryPending(dir);
  expect(fs.existsSync(marker)).toBe(false);
});

import { retryContext, lostRoutine, clearLostRoutine, recoveryReport } from '../scripts/lib/routines/recover';
import { logMessage } from '../scripts/lib/channel-log';
import { runScript } from './helpers/run';

test('retry context includes only ten first lines from the owning client chat since start', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { custom: { default_chat_id: 'home' } },
    routines: [{ id: 'r', skill: 'test:run', chat: 'custom:owned' }] }));
  for (let n = 0; n < 14; n++) {
    logMessage(dir, { source: 'custom', chat_id: 'owned', direction: 'out', ts: new Date(now + n * 1000).toISOString(), text: `sent ${n}\nsecond line` });
    logMessage(dir, { source: 'custom', chat_id: 'owned', direction: 'in', ts: new Date(now + n * 1000).toISOString(), text: 'not outbound' });
  }
  logMessage(dir, { source: 'custom', chat_id: 'home', direction: 'out', ts: mark, text: 'wrong chat' });
  logMessage(dir, { source: 'custom', chat_id: 'owned', direction: 'out', ts: new Date(now - 1000).toISOString(), text: 'too old' });
  const context = retryContext(dir, readUnfinished(dir)[key]);
  expect(context.already_sent).toEqual(Array.from({ length: 10 }, (_, n) => `sent ${n + 4}`));
  expect(context.log_note).toStartWith('This turn has no live sender and carries no operator authority.');
});

test('context names missing logs and logging off', () => {
  const dir = fixture();
  expect(retryContext(dir, readUnfinished(dir)[key]).log_note).toContain('logging is off');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { custom: { default_chat_id: 'home' } } }));
  expect(retryContext(dir, readUnfinished(dir)[key]).log_note).toContain('No outbound rows');
});

test('lost check is a no-op without a lost entry, and clearing only clears lost', async () => {
  const dir = fixture();
  expect(lostRoutine(dir, key).status).toBe('skipped');
  clearLostRoutine(dir, key);
  expect(readUnfinished(dir)[key]).toBeDefined();
  const result = await runScript('routines.ts', { args: ['recover', '--lost', key], env: { AGENT_DIR: dir } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe('skipped');
  withUnfinished(dir, s => { s[key].state = 'lost'; });
  expect(lostRoutine(dir, key)).toMatchObject({ status: 'lost', routine_id: 'r', cause: 'unclean' });
  clearLostRoutine(dir, key);
  expect(readUnfinished(dir)).toEqual({});
});

test('report bounds retry and closure facts by the previous boot', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'state/routine-recovery-since'), mark);
  fs.writeFileSync(path.join(dir, 'state/routine-metrics.jsonl'), [
    { routine_id: 'old', ts: new Date(now - 1000).toISOString(), event: 'started', detail: 'retry' },
    { routine_id: 'r', ts: mark, event: 'started', detail: 'retry' },
    { routine_id: 'r', ts: mark, event: 'failed-interrupted', detail: 'lost:api' },
    { routine_id: 'normal', ts: mark, event: 'fired' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  expect(recoveryReport(dir).map(row => row.detail)).toEqual(['retry', 'lost:api']);
});


test('an Esc-aborted retry closes with aborted:- even when its original cause is retained', () => {
  const dir = fixture();
  withUnfinished(dir, s => { s[key].state = 'started'; s[key].session_id = 'current'; s[key].attempts = 1; });
  expect(reconcileRoutines(dir, now)).toEqual({ entries: [], pending: false });
  expect(rows(dir).at(-1).detail).toBe('aborted:-');
});
