import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hermitDir } from './cc-compat';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { writeFileAtomic } from './md-write';
import { mutateTask, readTasks } from './tasks';

export const BROWSER_IDLE_MS = 15 * 60 * 1000;
interface Waiter { task: string; waiting_on: string }
export const HUMAN_IDLE_MS = 30 * 60 * 1000;
export interface HumanLease {
  login: string; generation: number; task: string | null; waiting_since: string | null;
  since: number; disconnected_at: number | null;
}
export interface BrowserEvent {
  id: string; reason: 'hand_back' | 'released' | 'expired' | 'browser_lost';
  task: string | null; waiting_since: string | null;
}
export interface BrowserLease {
  holder: string | null; expires_at: number; waiters: Waiter[];
  epoch: number; human: HumanLease | null; pending: BrowserEvent[];
}

export function browserEventSequence(id: string): number {
  const sequence = Number(id.split('-')[0]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid_browser_event');
  return sequence;
}

export function browserEventCursor(dir: string): number {
  try {
    const { sequence } = JSON.parse(fs.readFileSync(path.join(dir, 'state/browser-events.cursor.json'), 'utf8'));
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid_browser_cursor');
    return sequence;
  } catch (error: any) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

/** Chrome for Testing's managed persistent profile, never a named headless session. */
export function persistentChromeAlive(): boolean {
  return fs.readdirSync('/proc').some(pid => {
    if (!/^\d+$/.test(pid)) return false;
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      return args.some(arg => arg === '--user-data-dir=/home/claude/.claude/browser/profile')
        && !args.some(arg => arg.startsWith('--type='));
    } catch { return false; }
  });
}

function readLease(file: string): BrowserLease {
  try {
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!lease || !(lease.holder === null || (typeof lease.holder === 'string' && lease.holder))
      || !Number.isFinite(lease.expires_at) || !Number.isInteger(lease.epoch) || lease.epoch < 0
      || !Array.isArray(lease.pending) || lease.pending.some((event: BrowserEvent) => !event || typeof event.id !== 'string'
        || !['hand_back', 'released', 'expired', 'browser_lost'].includes(event.reason)
        || !(event.task === null || typeof event.task === 'string') || !(event.waiting_since === null || typeof event.waiting_since === 'string'))
      || !(lease.human === null || (lease.human && typeof lease.human.login === 'string' && lease.human.login
        && Number.isInteger(lease.human.generation) && lease.human.generation > 0 && Number.isFinite(lease.human.since)
        && (lease.human.task === null || typeof lease.human.task === 'string')
        && (lease.human.waiting_since === null || typeof lease.human.waiting_since === 'string')
        && (lease.human.disconnected_at === null || Number.isFinite(lease.human.disconnected_at))))
      || !Array.isArray(lease.waiters)
      || lease.waiters.some((waiter: Waiter) => !waiter || typeof waiter.task !== 'string' || typeof waiter.waiting_on !== 'string')) {
      throw new Error('invalid_browser_lease');
    }
    return lease;
  } catch (error: any) {
    if (error.code === 'ENOENT') return { holder: null, expires_at: 0, waiters: [], epoch: 0, human: null, pending: [] };
    throw error;
  }
}

/** Lock-free for the viewer's per-frame input path: lease writes are atomic renames. */
export function humanGeneration(dir: string): number | null {
  return readLease(path.join(dir, 'state/browser-lease.json')).human?.generation ?? null;
}

/** The folder shares the lease; the lock covers only the short transaction. */
type LeaseAction = 'claim' | 'release' | 'status' | 'renew' | 'inspect' | 'takeover' | 'hand-back' | 'human-release' | 'disconnect' | 'restart' | 'connect';
interface LeaseOptions {
  login?: string; generation?: number; chromeAlive?: () => boolean;
}
interface LeaseResult extends Partial<BrowserLease> { status: string }
export function browserLease(action: LeaseAction, task?: string, dir = hermitDir(), now = Date.now(), options: LeaseOptions = {}): LeaseResult {
  const file = path.join(dir, 'state/browser-lease.json');
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!acquireLockWithWait(lock, 2000)) throw new Error('browser_lock_unavailable');
  try {
    const lease = readLease(file);
    if (action === 'human-release' && !lease.human) return { status: 'nothing_held' };
    const save = () => writeFileAtomic(file, JSON.stringify(lease) + '\n', 0o600);
    const cursor = browserEventCursor(dir);
    const pending = lease.pending.filter(event => browserEventSequence(event.id) > cursor);
    if (pending.length !== lease.pending.length) { lease.pending = pending; save(); }
    let recovery = false;
    const clearHuman = (reason: BrowserEvent['reason']) => {
      const human = lease.human!;
      lease.pending.push({ id: `${lease.epoch + 1}-${randomUUID()}`, reason, task: human.task, waiting_since: human.waiting_since });
      lease.human = null;
      lease.epoch++;
      if (lease.holder) lease.expires_at = now + BROWSER_IDLE_MS;
      save();
    };
    if (lease.human && action !== 'human-release' && !(options.chromeAlive ?? persistentChromeAlive)()) {
      clearHuman('browser_lost');
      recovery = true;
    } else if (lease.human && lease.human.disconnected_at !== null && now - lease.human.disconnected_at >= HUMAN_IDLE_MS) {
      clearHuman('expired');
    }
    const claimExpired = action !== 'inspect' && !lease.human && !!lease.holder && lease.expires_at <= now;
    if (claimExpired) {
      // Viewer operations may expire a claim, but only the claim API wakes its queue.
      // Keep its task writes out of the viewer's read-only task path.
      lease.holder = null;
      lease.expires_at = 0;
      save();
    }
    if (action === 'takeover') {
      if (!options.login) throw new Error('login_required');
      const waiting = task && readTasks(dir).find(record => record.id === task && record.status === 'open' && record.waiting_since && record.waiting_on);
      // The replaced wait still needs its wake: inherit it, or release it for a different task.
      if (waiting && lease.human?.task && lease.human.task !== waiting.id) clearHuman('released');
      lease.epoch++;
      lease.human = { login: options.login, generation: lease.epoch, task: waiting ? waiting.id : lease.human?.task ?? null,
        waiting_since: waiting ? waiting.waiting_since : lease.human?.waiting_since ?? null, since: now, disconnected_at: null };
      save();
      return { status: 'human', human: lease.human, epoch: lease.epoch };
    }
    if (action === 'hand-back' || action === 'human-release') {
      if (!lease.human) return { status: 'nothing_held' };
      if (action === 'hand-back' && options.generation !== lease.human.generation) return { status: 'stale_generation' };
      clearHuman(action === 'hand-back' ? 'hand_back' : 'released');
      return { status: 'released' };
    }
    if (action === 'connect') {
      if (lease.human && options.generation === lease.human.generation && lease.human.disconnected_at !== null) {
        lease.human.disconnected_at = null;
        save();
      }
      return { status: 'human', human: lease.human, epoch: lease.epoch };
    }
    if (action === 'disconnect' || action === 'restart') {
      if (lease.human && lease.human.disconnected_at === null && (action === 'restart' || options.generation === lease.human.generation)) {
        lease.human.disconnected_at = now;
        save();
      }
      return { status: lease.human ? 'human' : 'available', human: lease.human, epoch: lease.epoch };
    }
    if (action === 'inspect') return { ...lease, status: recovery ? 'recovery' : lease.human ? 'human' : 'available' };
    const queue = (waitingOn: string) => {
      const waiter = lease.waiters.find(waiter => waiter.task === task);
      if (waiter) waiter.waiting_on = waitingOn;
      else lease.waiters.push({ task: task!, waiting_on: waitingOn });
      save();
    };
    if (lease.human) {
      if (action === 'claim' && task?.trim()) queue(lease.human.login);
      return { status: 'human', human: lease.human, epoch: lease.epoch };
    }
    if (!lease.holder && lease.waiters.length && (action === 'status' || claimExpired)) {
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
      queue(lease.holder);
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
