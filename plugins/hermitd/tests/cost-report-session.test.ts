import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { taskFixture } from './helpers/tasks';
import { costLogPath } from '../scripts/lib/cc-compat';
import { updateCostIndex, costIndexPath } from '../scripts/lib/cost-log';
import { readTaskReports } from '../scripts/lib/task-report';
import { taskStandup } from '../scripts/lib/tasks';

describe('cost-report.ts session: per-task attribution', () => {
  for (const indexed of [true, false]) test(`lifetime costs and tokens survive retention with index=${indexed}`, async () => {
    const f = taskFixture();
    try {
      const old = await f.open();
      const recent = await f.open();
      const openedAt = new Date(Date.now() - 120 * 86400000).toISOString();
      const recordPath = path.join(f.dir, 'tasks', `${old.id}.md`);
      fs.writeFileSync(recordPath, f.text(old.id).replace(/^(created|opened_at): .+$/gm, `$1: ${openedAt}`));
      const log = costLogPath(f.dir);
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, [
        { timestamp: new Date(Date.now() - 100 * 86400000).toISOString(), bucket: 'tasks', task_id: old.id, estimated_cost_usd: 8, total_tokens: 800 },
        { timestamp: new Date().toISOString(), bucket: 'tasks', task_ids: [old.id, recent.id], estimated_cost_usd: 6, total_tokens: 600 },
        { timestamp: new Date().toISOString(), bucket: 'conversation', task_id: old.id, estimated_cost_usd: 9, total_tokens: 900 },
        { timestamp: new Date().toISOString(), bucket: 'duties', estimated_cost_usd: 5, total_tokens: 500 },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      if (indexed) updateCostIndex(log, costIndexPath(f.dir));
      const before = indexed ? fs.readFileSync(costIndexPath(f.dir), 'utf8') : null;

      expect(readTaskReports(f.dir).map(r => r.cost)).toEqual([11, 3]);
      const r = await runScript('cost-report.ts', {
        args: ['session', old.id], cwd: path.dirname(f.dir),
        env: { AGENT_DIR: f.dir, CLAUDE_PROJECT_DIR: path.dirname(f.dir) },
      });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 11, tokens: 1100 });
      expect(taskStandup(f.dir, 7).by_person[0].promised.map(r => r.cost_usd)).toEqual([3, 3]);
      expect(taskStandup(f.dir, 120).by_person[0].promised.map(r => r.cost_usd)).toEqual([11, 3]);
      if (before !== null) expect(fs.readFileSync(costIndexPath(f.dir), 'utf8')).toBe(before);
      else expect(fs.existsSync(costIndexPath(f.dir))).toBe(false);
    } finally { f.cleanup(); }
  });

  test('reports one task share from the index and ignores frozen sessions', async () => {
    const f = taskFixture();
    try {
      const record = await f.open();
      f.put('state/cost-index.json', { version: 4, by_task: { [record.id]: { '2026-09-16': { cost: 1.25, tokens: 500 } }, other: { '2026-09-16': { cost: 9, tokens: 9000 } } } });
      const r = await runScript('cost-report.ts', { args: ['session', record.id], cwd: f.dir, env: { AGENT_DIR: f.dir, CLAUDE_PROJECT_DIR: f.dir } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 1.25, tokens: 500 });
    } finally { f.cleanup(); }
  });

  test('rebuild fallback splits rows across tasks and excludes conversation spend', async () => {
    const f = taskFixture();
    try {
      const record = await f.open();
      const timestamp = new Date().toISOString();
      fs.mkdirSync(path.join(f.dir, '..', '.claude'), { recursive: true });
      fs.writeFileSync(path.join(f.dir, '..', '.claude', 'cost-log.jsonl'), [
        { timestamp, bucket: 'tasks', task_ids: [record.id, 'T-other'], estimated_cost_usd: 2, total_tokens: 1000 },
        { timestamp, bucket: 'conversation', estimated_cost_usd: 9, total_tokens: 9000 },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const r = await runScript('cost-report.ts', { args: ['session', record.id], cwd: f.dir, env: { AGENT_DIR: f.dir, CLAUDE_PROJECT_DIR: path.dirname(f.dir) } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 1, tokens: 500 });
    } finally { f.cleanup(); }
  });

  test('unknown records return zeros even if an index entry exists', async () => {
    const f = taskFixture();
    try {
      f.put('state/cost-index.json', { version: 4, by_task: { unknown: { '2026-09-16': { cost: 9, tokens: 9000 } } } });
      const r = await runScript('cost-report.ts', { args: ['session', 'unknown'], cwd: f.dir, env: { AGENT_DIR: f.dir } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 0, tokens: 0 });
    } finally { f.cleanup(); }
  });
});
