// Resident-owned occurrences; the ledger and chat log remain the history.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../cli';
import { acquireLockWithWait, releaseLock } from '../lockfile';
import { writeFileAtomic } from '../md-write';
import { markRecoveryPending } from '../recovery-marker';

export type Unfinished = {
  routine_id: string;
  skill: string;
  mark: string;
  delivery: string;
  dispatched_at?: string;
  started_at?: string;
  session_id?: string;
  state: 'dispatched' | 'started' | 'awaiting' | 'interrupted' | 'lost';
  cause?: 'unclean' | 'planned' | 'api';
  attempts: number;
  retry?: boolean;
  not_before?: string;
  refunds?: { count: number; at: string };
};
export type UnfinishedStore = Record<string, Unfinished>;
const storePath = (dir: string) => path.join(dir, 'state', 'routine-unfinished.json');

export function readUnfinished(dir: string): UnfinishedStore {
  try {
    const value = readJson(storePath(dir));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function withUnfinished<T>(dir: string, body: (store: UnfinishedStore) => T): T | undefined {
  const file = storePath(dir);
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!acquireLockWithWait(lock, 5000)) return;
    try {
      const store = readUnfinished(dir);
      const result = body(store);
      if (Object.keys(store).length) {
        writeFileAtomic(file, JSON.stringify(store) + '\n');
        markRecoveryPending(dir);
      } else { try { fs.unlinkSync(file); } catch {} }
      return result;
    } finally { releaseLock(lock); }
  } catch { return; }
}

export function markDispatched(dir: string, entry: Omit<Unfinished, 'state' | 'attempts'>): void {
  withUnfinished(dir, store => {
    const key = `${entry.routine_id}@${entry.mark}`;
    store[key] ??= { ...entry, state: 'dispatched', attempts: 0 };
  });
}

export function markStarted(dir: string, entry: Omit<Unfinished, 'state' | 'attempts'>): void {
  withUnfinished(dir, store => {
    const key = `${entry.routine_id}@${entry.mark}`;
    store[key] = { ...store[key], ...entry, state: 'started', attempts: store[key]?.attempts ?? 0 };
  });
}

export function clearEntries(dir: string, matches: (entry: Unfinished, key: string) => boolean): void {
  withUnfinished(dir, store => {
    for (const [key, entry] of Object.entries(store)) if (matches(entry, key)) delete store[key];
  });
}

export function stampInterrupted(dir: string, cause: Unfinished['cause'], sessionId?: string): void {
  withUnfinished(dir, store => {
    for (const entry of Object.values(store)) {
      if (!['dispatched', 'started', 'awaiting'].includes(entry.state)) continue;
      if (sessionId !== undefined && (entry.session_id !== sessionId || entry.state === 'dispatched')) continue;
      entry.state = 'interrupted';
      entry.cause = cause;
    }
  });
}
