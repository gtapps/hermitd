import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { taskStandup } from '../scripts/lib/tasks';
import { costLogPath } from '../scripts/lib/cc-compat';
import { updateCostIndex, costIndexPath } from '../scripts/lib/cost-log';

test('task windows split shared rows and scan beyond retention', async () => {
  const f = taskFixture();
  try {
    const a = await f.open();
    const b = await f.open();
    const log = costLogPath(f.dir);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, [
      { timestamp: new Date().toISOString(), bucket: 'tasks', task_ids: [a.id, b.id], estimated_cost_usd: 6 },
      { timestamp: new Date(Date.now() - 100 * 86400000).toISOString(), bucket: 'tasks', task_id: a.id, estimated_cost_usd: 8 },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    updateCostIndex(log, costIndexPath(f.dir));
    expect(taskStandup(f.dir, 7).by_person[0].promised.map(r => r.cost_usd)).toEqual([3, 3]);
    expect(taskStandup(f.dir, 120).by_person[0].promised.map(r => r.cost_usd)).toEqual([11, 3]);
  } finally { f.cleanup(); }
});
