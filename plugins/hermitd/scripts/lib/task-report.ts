import path from 'node:path';
import { readTasks, readTaskCostRows, type Task } from './tasks';
import { readCostIndex, costIndexPath, computeIndex, allocateTaskShares, BY_TASK_RETENTION_DAYS } from './cost-log';
import { costLogPath } from './cc-compat';
import { readConfigRaw } from './config-read';
import { extractSection } from './md-write';
import { todayYMD } from './time';

export interface TaskReport {
  source_path: string;
  outcome: 'done' | 'cancelled' | 'unconfirmed' | 'open';
  result: string | null;
  result_at: string | null;
  closed_reason: string | null;
  title: string;
  opened_at: string;
  closed_at: string | null;
  requester: string;
  due: string | null;
  waiting_on: string | null;
  cost: number;
  lessons: string[];
  decisions: string[];
}

export function taskReport(dir: string, record: Task, cost = 0): TaskReport {
  return {
    source_path: path.join(dir, 'tasks', `${record.id}.md`),
    outcome: record.status === 'closed' ? (['check', 'confirmed'].includes(record.closed_by ?? '') ? 'done' : 'cancelled') : record.result ? 'unconfirmed' : 'open',
    result: record.result, result_at: record.result_at, closed_reason: record.closed_reason,
    title: record.title, opened_at: record.opened_at, closed_at: record.closed_at,
    requester: record.requester, due: record.due, waiting_on: record.waiting_on,
    cost,
    lessons: (extractSection(record.body, 'Lessons') ?? '').split('\n').map(line => line.trim()).filter(line => line.startsWith('- ')).map(line => line.slice(2)),
    decisions: (extractSection(record.body, 'Decisions') ?? '').split('\n').map(line => line.trim()).filter(line => line.startsWith('- ')).map(line => line.slice(2)),
  };
}

export function readTaskCostTotals(dir: string, records: Pick<Task, 'id' | 'opened_at'>[]): Record<string, { cost: number; tokens: number }> {
  const totals: Record<string, { cost: number; tokens: number }> = {};
  if (!records.length) return totals;
  const timezone = readConfigRaw(dir)?.timezone ?? 'UTC';
  const cutoff = todayYMD(timezone, new Date(Date.now() - BY_TASK_RETENTION_DAYS * 86400000));
  if (records.some(record => todayYMD(timezone, new Date(record.opened_at)) < cutoff)) {
    // Lifetime reports can outlive the bounded index. Fold the log once for all
    // requested records, without adding its recent rows to the same indexed rows.
    const ids = new Set(records.map(record => record.id));
    for (const row of readTaskCostRows(dir)) {
      if (!Number.isFinite(Date.parse(row?.timestamp))) continue;
      for (const share of allocateTaskShares(row)) {
        if (!ids.has(share.task_id)) continue;
        const total = totals[share.task_id] ??= { cost: 0, tokens: 0 };
        total.cost += share.cost;
        total.tokens += share.tokens;
      }
    }
  } else {
    const index = readCostIndex(costIndexPath(dir)) ?? computeIndex(costLogPath(dir), timezone);
    for (const record of records) {
      const total = totals[record.id] = { cost: 0, tokens: 0 };
      for (const bucket of Object.values(index.by_task?.[record.id] ?? {}) as { cost: number; tokens: number }[]) {
        total.cost += bucket.cost;
        total.tokens += bucket.tokens;
      }
    }
  }
  return totals;
}

export function readTaskReports(dir: string): TaskReport[] {
  const records = readTasks(dir);
  const totals = readTaskCostTotals(dir, records);
  return records.map(record => taskReport(dir, record, totals[record.id]?.cost));
}
