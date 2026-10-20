import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { readTaskReports, selectTodayReports, type TaskReport } from '../scripts/lib/task-report';
import { readTasks } from '../scripts/lib/tasks';
import { runScript } from './helpers/run';

test('normalizes done, cancelled, unconfirmed and open while ignoring frozen reports', async () => {
  const f = taskFixture();
  try {
    const done = await f.open();
    await f.ok('block', [done.id, '--result-stdin'], 'Ready');
    await f.ok('lesson', [done.id], 'Useful lesson');
    await f.ok('note', [done.id, '--decision'], 'Dropped the export, vendor API is read-only');
    await f.ok('close', [done.id, '--by', 'confirmed', '--actor', 'operator', '--result-rev', '1', '--reason-stdin'], 'Accepted');
    const cancelled = await f.open();
    await f.ok('cancel', [cancelled.id, '--actor', 'operator', '--reason-stdin'], 'Withdrawn');
    const unconfirmed = await f.open();
    await f.ok('block', [unconfirmed.id, '--result-stdin'], 'Review this');
    await f.open();
    fs.mkdirSync(path.join(f.dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(f.dir, 'sessions/S-999-REPORT.md'), 'Invalid frozen report');
    const records = readTaskReports(f.dir);
    expect(records.map(r => r.outcome)).toEqual(['done', 'cancelled', 'unconfirmed', 'open']);
    const tasks = readTasks(f.dir);
    for (const report of records) {
      const task = tasks.find(task => report.source_path.endsWith(`/${task.id}.md`))!;
      expect(report.result).toBe(task.result);
      expect(report.result_at).toBe(task.result_at);
      expect(report.closed_reason).toBe(task.closed_reason);
    }
    expect(records[0].result).toBe('Ready');
    expect(records[0].result_at).toEqual(expect.any(String));
    expect(records[0].closed_reason).toBe('Accepted');
    expect(records[1].result).toBeNull();
    expect(records[1].result_at).toBeNull();
    expect(records[1].closed_reason).toBe('Withdrawn');
    expect(records[2].result).toBe('Review this');
    expect(records[2].result_at).toEqual(expect.any(String));
    expect(records[2].closed_reason).toBeNull();
    expect(records[0].lessons[0]).toContain('Useful lesson');
    expect(records[0].decisions[0]).toContain('Dropped the export, vendor API is read-only');
    expect(records[3].decisions).toEqual([]);
    expect(records[2].closed_at).toBeNull();
  } finally { f.cleanup(); }
});

test('selects all closed outcomes and opened records on the configured local day, newest first', () => {
  const records = [
    { title: 'first', outcome: 'done', closed_at: '2026-10-19T23:30:00Z', opened_at: '2026-10-18T12:00:00Z' },
    { title: 'second', outcome: 'cancelled', closed_at: '2026-10-20T10:00:00Z', opened_at: '2026-10-20T09:00:00Z' },
    { title: 'open', outcome: 'open', closed_at: null, opened_at: '2026-10-20T11:00:00Z' },
  ] as TaskReport[];
  const reference = new Date('2026-10-20T12:00:00Z');
  const lisbon = selectTodayReports(records, 'Europe/Lisbon', reference);
  expect(lisbon.today).toBe('2026-10-20');
  expect(lisbon.closed_today.map(row => row.title)).toEqual(['second', 'first']);
  expect(lisbon.opened_today.map(row => row.title)).toEqual(['open', 'second']);
  expect(selectTodayReports(records, 'UTC', reference).closed_today.map(row => row.title)).toEqual(['second']);
  expect(selectTodayReports(records, 'UTC', new Date('2026-10-19T12:00:00Z')).closed_today.map(row => row.title)).toEqual(['first']);
});

test('CLI adds uncapped today selections only with --today, defaulting to UTC', async () => {
  const f = taskFixture();
  try {
    for (let i = 0; i < 2; i++) {
      const task = await f.open();
      await f.ok('cancel', [task.id, '--actor', 'operator', '--reason-stdin'], 'Withdrawn');
    }
    const call = (args: string[]) => runScript('task-report.ts', {
      cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir }, args: [f.dir, '--limit', '1', ...args],
    });
    const plain = await call([]);
    expect(plain.exitCode).toBe(0);
    const report = JSON.parse(plain.stdout);
    expect(Object.keys(report)).toEqual(['rows', 'total', 'omitted']);
    const selected = await call(['--today']);
    expect(selected.exitCode).toBe(0);
    const today = JSON.parse(selected.stdout);
    expect(today.rows).toEqual(report.rows);
    expect(today.total).toBe(2);
    expect(today.omitted).toBe(1);
    // Derive the expected day from the records so a run across UTC midnight stays green.
    const onDay = (stamp: string | null) => stamp?.slice(0, 10) === today.today;
    const all = readTaskReports(f.dir);
    expect(today.closed_today).toHaveLength(all.filter(row => onDay(row.closed_at)).length);
    expect(today.opened_today).toHaveLength(all.filter(row => onDay(row.opened_at)).length);
    expect([new Date(Date.now() - 60000), new Date()].map(d => d.toISOString().slice(0, 10))).toContain(today.today);
  } finally { f.cleanup(); }
});
