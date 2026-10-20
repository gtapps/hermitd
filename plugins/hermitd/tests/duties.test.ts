import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { runScript } from './helpers/run';
import { normalizeItemKey } from '../scripts/lib/heartbeat-items';

it('derives routine last run and verdict without advancing suppressed replay', async () => { const f = taskFixture(); try { f.put('config.json', { routines: [{ id: 'daily' }] }); fs.writeFileSync(path.join(f.dir, 'state/routine-metrics.jsonl'), JSON.stringify({ routine_id: 'daily', event: 'fired', ts: '2026-09-14T10:00:00Z' }) + '\n'); const r = await runScript('duties.ts', { args: ['list', f.dir, '--json'], env: { AGENT_DIR: f.dir } }); expect(r.exitCode).toBe(0); expect(JSON.parse(r.stdout).rows).toContainEqual(expect.objectContaining({ name: 'routine:daily', last_run: '2026-09-14T10:00:00Z', last_verdict: 'fired' })); } finally { f.cleanup(); } });
for (const corrupt of [false, true]) it(`heartbeat derives verdict, ambiguous=${corrupt}`, async () => { const f = taskFixture(); try { fs.writeFileSync(path.join(f.dir, 'state/alert-state.json'), corrupt ? '{' : JSON.stringify({ alerts: {}, total_ticks: 1, last_clean_eval_at: '2026-09-14T10:00:00Z' })); const r = await runScript('duties.ts', { args: ['list', f.dir], env: { AGENT_DIR: f.dir } }); expect(r.exitCode).toBe(0); expect(JSON.parse(r.stdout).rows).toContainEqual(expect.objectContaining({ name: 'heartbeat', last_verdict: corrupt ? 'frozen' : 'ok' })); } finally { f.cleanup(); } });
it('watch record only updates its runtime entry', async () => { const f = taskFixture(); try { f.put('state/monitors.runtime.json', { monitors: [{ id: 'watch-1', started_at: '2026-09-14T10:00:00Z' }] }); const before = fs.readFileSync(path.join(f.dir, 'state/runtime.json'), 'utf8'); const r = await runScript('duties.ts', { args: ['record', f.dir, 'watch', 'watch-1', '--verdict', 'ok'], env: { AGENT_DIR: f.dir } }); expect(r.exitCode).toBe(0); expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/monitors.runtime.json'), 'utf8')).monitors[0].last_verdict).toBe('ok'); expect(fs.readFileSync(path.join(f.dir, 'state/runtime.json'), 'utf8')).toBe(before); expect(fs.existsSync(path.join(f.dir, 'state/duties.json'))).toBe(false); } finally { f.cleanup(); } });
it('trailing act leaves the heartbeat item key stable', () => { expect(normalizeItemKey('Review deployed service health [act]')).toBe(normalizeItemKey('Review deployed service health')); });
it('sqlite checklist items keep separate keys', () => { expect(normalizeItemKey('- Run sqlite3 bills.db: any bill due? [act]')).not.toBe(normalizeItemKey('- Run sqlite3 reviews.db: any review stale?')); });
it('symbol differences keep separate checklist keys', () => { expect(normalizeItemKey('- review stale >7d')).not.toBe(normalizeItemKey('- review stale <7d')); });
it('note and list markers leave the heartbeat item key stable', () => { expect(normalizeItemKey('Check disk [note]')).toBe(normalizeItemKey('- Check disk')); expect(normalizeItemKey('- Check disk')).toBe(normalizeItemKey('- [ ] Check disk')); });
it('indented item keeps the heartbeat item key', () => { expect(normalizeItemKey('  - Check disk')).toBe(normalizeItemKey('- Check disk')); });
it('duties foreign root exits 1', async () => { const f = taskFixture(); try { const r = await runScript('duties.ts', { args: ['list', '/foreign'], env: { AGENT_DIR: f.dir } }); expect(r.exitCode).toBe(1); expect(JSON.parse(r.stdout)).toEqual({ error: `foreign_state_dir:${f.dir}` }); } finally { f.cleanup(); } });


it('omits metrics-only routines and retains configured routines without history', async () => {
  const f = taskFixture();
  try {
    f.put('config.json', { routines: [{ id: 'new' }] });
    fs.writeFileSync(path.join(f.dir, 'state/routine-metrics.jsonl'), JSON.stringify({ routine_id: 'removed', event: 'fired', ts: '2026-09-14T10:00:00Z' }) + '\n');
    const r = await runScript('duties.ts', { args: ['list', f.dir, '--json'], env: { AGENT_DIR: f.dir } });
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout).rows;
    expect(rows).not.toContainEqual(expect.objectContaining({ name: 'routine:removed' }));
    expect(rows).toContainEqual({ name: 'routine:new', last_run: null, last_verdict: null });
  } finally { f.cleanup(); }
});

it('summary prints requested and observed state as rows; a missing watch is a refusal', async () => {
  const f = taskFixture();
  try {
    f.put('config.json', { routines: [{ id: 'daily', enabled: true, schedule: '0 9 * * *' }] });
    const r = await runScript('duties.ts', { args: ['summary', f.dir], env: { AGENT_DIR: f.dir } });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).rows).toContainEqual({ name: 'routine:daily', enabled: true, schedule: '0 9 * * *', mode: null, pid: null, last_woke: null, last_event: null });
    const missing = await runScript('duties.ts', { args: ['record', f.dir, 'watch', 'gone', '--verdict', 'ok'], env: { AGENT_DIR: f.dir } });
    expect(missing.exitCode).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({ status: 'refused', reason: 'watch_not_found' });
  } finally { f.cleanup(); }
});

it('config-watch duties have a separate writer file and list only enabled config watches', async () => {
  const f = taskFixture();
  try {
    f.put('config.json', { monitors: [{ id: 'configured', enabled: true }, { id: 'disabled', enabled: false }, { id: 'new', enabled: true }] });
    f.put('state/monitors.runtime.json', { monitors: [{ id: 'adhoc' }] });
    f.put('state/watch-monitor.runtime.json', { watches: [{ id: 'configured', pid: 123 }] });
    const pollerBefore = fs.readFileSync(path.join(f.dir, 'state/watch-monitor.runtime.json'), 'utf8');
    const registryBefore = fs.readFileSync(path.join(f.dir, 'state/monitors.runtime.json'), 'utf8');
    const result = await runScript('duties.ts', { args: ['record', f.dir, 'watch', 'configured', '--verdict', 'handled'], env: { AGENT_DIR: f.dir } });
    expect(result.exitCode).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(path.join(f.dir, 'state/watch-duties.json'), 'utf8')).watches.configured;
    expect(recorded.last_verdict).toBe('handled');
    expect(Date.parse(recorded.last_event_at)).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(f.dir, 'state/watch-monitor.runtime.json'), 'utf8')).toBe(pollerBefore);
    expect(fs.readFileSync(path.join(f.dir, 'state/monitors.runtime.json'), 'utf8')).toBe(registryBefore);
    const listed = await runScript('duties.ts', { args: ['list', f.dir, '--json'], env: { AGENT_DIR: f.dir } });
    const rows = JSON.parse(listed.stdout).rows;
    expect(rows).toContainEqual({ name: 'watch:configured', last_run: recorded.last_event_at, last_verdict: 'handled', scope: 'since session start' });
    expect(rows).toContainEqual({ name: 'watch:new', last_run: null, last_verdict: null, scope: 'since session start' });
    expect(rows).toContainEqual({ name: 'watch:adhoc', last_run: null, last_verdict: null, scope: 'since session start' });
    expect(rows.some((row: any) => row.name === 'watch:disabled')).toBe(false);
  } finally { f.cleanup(); }
});
