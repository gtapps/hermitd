import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { readTaskReports } from '../scripts/lib/task-report';
import { readTasks } from '../scripts/lib/tasks';

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
