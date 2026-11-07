// Pending decisions and their confirmed-delivery budget. Reads fail closed.
import fs from 'node:fs';
import path from 'node:path';
import { readTaskInventory, decodeDecision, type Task, type Decision } from './tasks';
export type PendingDecision = { task: Task; decision: Decision; delivered: number };
export function readDeliveryBudget(dir: string): Record<string, number> {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'decision-deliveries.json'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(count => !Number.isInteger(count) || Number(count) < 0 || Number(count) > 2)) throw new Error('invalid_decision_budget');
  return value as Record<string, number>;
}
export function pendingDecisions(dir: string): { ok: true; records: PendingDecision[] } | { ok: false } {
  const inventory = readTaskInventory(dir);
  if (!inventory.ok) return { ok: false };
  try {
    const counts = readDeliveryBudget(dir);
    return { ok: true, records: inventory.records.filter(task => task.status === 'open' && task.waiting_on !== null && task.decision !== null).map(task => {
      const decision = decodeDecision(task.decision!);
      return { task, decision, delivered: counts[`${task.id}:${decision.generation}`] ?? 0 };
    }) };
  } catch { return { ok: false }; }
}
