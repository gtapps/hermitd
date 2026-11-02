import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './cc-compat';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { writeFileAtomic } from './md-write';
import { mutateTask, readTasks } from './tasks';

export const BROWSER_IDLE_MS = 15 * 60 * 1000;
interface Waiter { task: string; waiting_on: string }
export interface BrowserLease { holder: string | null; expires_at: number; waiters: Waiter[] }

function readLease(file: string): BrowserLease {
  try {
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!lease || !(lease.holder === null || (typeof lease.holder === 'string' && lease.holder))
      || !Number.isFinite(lease.expires_at) || !Array.isArray(lease.waiters)
      || lease.waiters.some((waiter: Waiter) => !waiter || typeof waiter.task !== 'string' || typeof waiter.waiting_on !== 'string')) {
      throw new Error('invalid_browser_lease');
    }
    return lease;
  } catch (error: any) {
    if (error.code === 'ENOENT') return { holder: null, expires_at: 0, waiters: [] };
    throw error;
  }
}

/** The folder shares the lease; the lock covers only the short transaction. */
export function browserLease(action: 'claim' | 'release' | 'status' | 'renew', task?: string, dir = hermitDir(), now = Date.now()) {
  const file = path.join(dir, 'state/browser-lease.json');
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!acquireLockWithWait(lock, 2000)) throw new Error('browser_lock_unavailable');
  try {
    const lease = readLease(file);
    const save = () => writeFileAtomic(file, JSON.stringify(lease) + '\n', 0o600);
    if (lease.holder && lease.expires_at <= now) {
      clearNextWaiter(dir, lease);
      lease.holder = null;
      lease.expires_at = 0;
      save();
    } else if (action === 'status' && !lease.holder && lease.waiters.length) {
      // Recovers a waiter that blocked after the release meant to wake it.
      clearNextWaiter(dir, lease);
      save();
    }
    if (action === 'status') return lease.holder
      ? { status: 'claimed', holder: lease.holder, expires_at: lease.expires_at }
      : { status: 'available' };
    if (action === 'release') {
      if (task && lease.holder && lease.holder !== task) return { status: 'not_holder', holder: lease.holder };
      if (lease.holder) clearNextWaiter(dir, lease);
      lease.holder = null;
      lease.expires_at = 0;
      save();
      return { status: 'released' };
    }
    if (action === 'claim' && !task?.trim()) throw new Error('task_required');
    if (action === 'claim' && lease.holder && lease.holder !== task) {
      const waiter = lease.waiters.find(waiter => waiter.task === task);
      if (waiter) waiter.waiting_on = lease.holder;
      else lease.waiters.push({ task: task!, waiting_on: lease.holder });
      save();
      return { status: 'busy', holder: lease.holder };
    }
    if (action === 'renew' && !lease.holder) return { status: 'unclaimed' };
    if (action === 'renew' && lease.holder !== task) return { status: 'not_holder', holder: lease.holder };
    if (action === 'claim') {
      lease.holder = task!;
      lease.waiters = lease.waiters.filter(waiter => waiter.task !== task);
    }
    lease.expires_at = now + BROWSER_IDLE_MS;
    save();
    return { status: 'claimed', holder: lease.holder!, expires_at: lease.expires_at };
  } finally {
    releaseLock(lock);
  }
}

/** A holder that never releases has no other trigger for its idle expiry. */
export function sweepBrowserLease(dir: string): void {
  if (fs.existsSync(path.join(dir, 'state/browser-lease.json'))) browserLease('status', undefined, dir);
}

function clearNextWaiter(dir: string, lease: BrowserLease): void {
  if (!lease.waiters.length) return;
  const open = new Map(readTasks(dir).filter(record => record.status === 'open').map(record => [record.id, record]));
  // An open task not waiting yet stays queued: it may be between `busy` and its block.
  lease.waiters = lease.waiters.filter(waiter => open.has(waiter.task));
  const next = lease.waiters.find(waiter => open.get(waiter.task)!.waiting_on === waiter.waiting_on);
  if (!next) return;
  lease.waiters.splice(lease.waiters.indexOf(next), 1);
  mutateTask(dir, 'note', next.task, { 'clear-waiting': true }, '');
}
