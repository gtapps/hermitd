// Pending decisions and their confirmed-delivery budget. Reads fail closed.
import fs from 'node:fs';
import path from 'node:path';
import { readTaskInventory, decodeDecision, type Task, type Decision } from './tasks';
export type PendingDecision = { task: Task; decision: Decision; delivered: number; attempted_at: string | null };
// A budget entry is a bare confirmed-delivery count, or that count with the last attempt stamp.
export type BudgetEntry = { delivered: number; attempted_at: string | null };
export const DECISION_ATTEMPT_INTERVAL_MS = 24 * 3600000;
const validCount = (count: unknown): count is number => Number.isInteger(count) && Number(count) >= 0 && Number(count) <= 2;
export function readDeliveryBudget(dir: string): Record<string, BudgetEntry> {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'decision-deliveries.json'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_decision_budget');
  const out: Record<string, BudgetEntry> = {};
  for (const [key, entry] of Object.entries(value as Record<string, any>)) {
    if (validCount(entry)) { out[key] = { delivered: entry, attempted_at: null }; continue; }
    if (!entry || typeof entry !== 'object' || !validCount(entry.delivered) || typeof entry.attempted_at !== 'string') throw new Error('invalid_decision_budget');
    out[key] = { delivered: entry.delivered, attempted_at: entry.attempted_at };
  }
  return out;
}
/** A delivery attempt is due: budget unspent and no attempt in the last 24h. */
export function deliveryDue(row: PendingDecision, nowMs: number): boolean {
  if (row.delivered >= 2) return false;
  const last = row.attempted_at ? Date.parse(row.attempted_at) : NaN;
  return isNaN(last) || nowMs - last >= DECISION_ATTEMPT_INTERVAL_MS;
}
export function pendingDecisions(dir: string): { ok: true; records: PendingDecision[] } | { ok: false } {
  const inventory = readTaskInventory(dir);
  if (!inventory.ok) return { ok: false };
  try {
    const budget = readDeliveryBudget(dir);
    return { ok: true, records: inventory.records.filter(task => task.status === 'open' && task.waiting_on !== null && task.decision !== null).map(task => {
      const decision = decodeDecision(task.decision!);
      const entry = budget[`${task.id}:${decision.generation}`];
      return { task, decision, delivered: entry?.delivered ?? 0, attempted_at: entry?.attempted_at ?? null };
    }) };
  } catch { return { ok: false }; }
}
