import fs from 'node:fs';
import path from 'node:path';
import { readTasks, isRunnable, type Task } from '../tasks';
import { readSettledConfig } from '../config-read';
import { sha256 } from '../hash';
import { resolveHermitNowMs } from '../time';
import { acquireLockWithWait, releaseLock } from '../lockfile';
import { writeFileAtomic } from '../md-write';

export interface QueueNotice { task_id: string; handle: string; title: string; ack: string }

function token(record: Task): string {
  return sha256(record.id + record.opened_at + record.result_rev);
}

function acknowledgements(dir: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state/queue-ack.json'), 'utf8')); }
  catch { return {}; }
}

export function pendingQueue(dir: string, nowMs = resolveHermitNowMs()): QueueNotice | undefined {
  const minutes = readSettledConfig(dir).tasks.queue_nudge_minutes;
  const acked = acknowledgements(dir);
  const record = readTasks(dir).find(row => isRunnable(row)
    && nowMs - Date.parse(row.opened_at) > minutes * 60_000 && acked[row.id] !== token(row));
  return record ? { task_id: record.id, handle: record.handle, title: record.title, ack: token(record) } : undefined;
}

export function acknowledgeQueue(dir: string, ack: string): { acknowledged: boolean; reason?: string } {
  const lock = path.join(dir, 'state/tasks.lock');
  if (!acquireLockWithWait(lock, 2000)) return { acknowledged: false, reason: 'lock_unavailable' };
  try {
    const record = readTasks(dir).find(row => isRunnable(row) && token(row) === ack);
    if (!record) return { acknowledged: false, reason: 'changed' };
    const acked = acknowledgements(dir);
    acked[record.id] = ack;
    writeFileAtomic(path.join(dir, 'state/queue-ack.json'), JSON.stringify(acked, null, 2) + '\n');
    return { acknowledged: true };
  } finally { releaseLock(lock); }
}
