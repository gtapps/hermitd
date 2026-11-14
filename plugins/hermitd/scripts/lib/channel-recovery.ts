// Resident-owned unfinished conversations. The chat log remains the message history.
import fs from 'node:fs';
import path from 'node:path';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { writeFileAtomic } from './md-write';
import { readJson } from './cli';
import { readSettledConfig } from './config-read';
import { isKey } from './conversation-key';
import { conversationHistory, isLoggingEnabled } from './channel-log';
import { allowedUserIds } from './channel-auth';
import { threadRecords } from './tasks';
import { cachedChat, isThreadChannelType, classifyChat } from './channel-chats';
import { parseDuration } from './time';
import type { QueueRequest } from './harness-mod';

type Entry = {
  since: string;
  attempts: number;
  not_before: string | null;
  last_attempt_at: string | null;
  refunds?: number;
  refunded_at?: string;
};
type Store = Record<string, Entry>;
const storePath = (dir: string) => path.join(dir, 'state', 'channel-unfinished.json');

function readStore(dir: string): Store {
  const value = readJson(storePath(dir));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function withStore<T>(dir: string, body: (store: Store) => T): T {
  const file = storePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  if (!acquireLockWithWait(lock, 5000)) throw new Error('channel_recovery_locked');
  try {
    const store = readStore(dir);
    const result = body(store);
    if (Object.keys(store).length) writeFileAtomic(file, JSON.stringify(store) + '\n');
    else { try { fs.unlinkSync(file); } catch {} }
    return result;
  } finally { releaseLock(lock); }
}

function conversation(key: string) {
  const [source, target] = key.split(':');
  const at = target.indexOf('~');
  return { source, chatId: at < 0 ? target : target.slice(0, at), thread: at < 0 ? undefined : target.slice(at + 1) };
}

export function markUnfinished(dir: string, key: string, ts: string): void {
  if (!isKey(key) || !Number.isFinite(Date.parse(ts))) return;
  withStore(dir, store => {
    if (store[key]) {
      if (Date.parse(ts) < Date.parse(store[key].since)) store[key].since = ts;
    } else store[key] = { since: ts, attempts: 0, not_before: null, last_attempt_at: null };
    fs.writeFileSync(path.join(dir, 'state', 'recovery-pending'), '');
  });
}

// The bridge calls this only once all producers are empty. Admission takes this
// same lock, so a new conversation cannot lose its wake marker to an older scan.
export function clearRecoveryPending(dir: string): void {
  withStore(dir, store => {
    if (!Object.keys(store).length) {
      try { fs.unlinkSync(path.join(dir, 'state', 'recovery-pending')); } catch {}
    }
  });
}

export function clearConversations(dir: string, keys: string[]): void {
  withStore(dir, store => { for (const key of keys) delete store[key]; });
}

export function stillUnfinished(dir: string, key: string): boolean {
  if (!isKey(key) || !Object.hasOwn(readStore(dir), key)) return false;
  const config = readSettledConfig(dir);
  const { source, chatId, thread } = conversation(key);
  if (config.channel_recovery?.enabled === false || !config.channels?.[source] || !isLoggingEnabled(config, source)) return false;
  const records = threadRecords(dir).filter(record => record.conversation === key);
  if (records.some(record => record.muted)) return false;
  const inThread = source === 'discord' ? isThreadChannelType(cachedChat(dir, chatId)) : thread !== undefined;
  return !inThread || !records.some(record => record.owner !== 'resident');
}

export function claimAttempt(dir: string, key: string, now: number): boolean {
  return withStore(dir, store => {
    const entry = store[key];
    if (!entry || entry.attempts >= 2 || Date.parse(entry.not_before ?? '') > now) return false;
    entry.attempts++;
    entry.last_attempt_at = new Date(now).toISOString();
    return true;
  });
}

async function eligible(dir: string, key: string, config: any): Promise<boolean> {
  if (!isKey(key)) return false;
  const { source, chatId, thread } = conversation(key);
  if (!config.channels?.[source] || !isLoggingEnabled(config, source)) return false;
  const records = threadRecords(dir).filter(record => record.conversation === key);
  if (records.some(record => record.muted)) return false;
  return !records.some(record => record.owner !== 'resident')
    || await classifyChat(dir, config, source, chatId, thread) !== 'thread';
}

export async function reconcileChannels(
  dir: string, now: number, _options: { lastTurnCompleteAt?: number | null },
): Promise<{ entries: QueueRequest[]; pending: boolean }> {
  const config = readSettledConfig(dir);
  if (config.channel_recovery?.enabled === false) {
    withStore(dir, store => { for (const key of Object.keys(store)) delete store[key]; });
    return { entries: [], pending: false };
  }
  const eligibility = new Map<string, boolean>();
  for (const key of Object.keys(readStore(dir))) eligibility.set(key, await eligible(dir, key, config));
  return withStore(dir, store => {
    const entries: QueueRequest[] = [];
    const failure = readJson(path.join(dir, 'state', 'stop-failure.json'));
    const failureAt = Date.parse(failure?.at ?? '');
    const maxAge = parseDuration(config.channel_recovery?.max_age, 6 * 3600000);
    for (const [key, entry] of Object.entries(store)) {
      if (eligibility.get(key) === false || !Number.isFinite(Date.parse(entry.since)) || now - Date.parse(entry.since) > maxAge) {
        delete store[key];
        continue;
      }
      if (Number.isFinite(failureAt) && entry.refunded_at !== failure.at
          && (entry.last_attempt_at === null || failureAt >= Date.parse(entry.last_attempt_at))) {
        if (entry.last_attempt_at !== null) entry.attempts = Math.max(0, entry.attempts - 1);
        const delay = [10, 30, 60][Math.min(entry.refunds ?? 0, 2)] * 60000;
        entry.not_before = new Date(Math.min(failureAt + delay, now + 60 * 60000)).toISOString();
        entry.refunds = (entry.refunds ?? 0) + 1;
        entry.refunded_at = failure.at;
      }
      if (entry.attempts >= 2) { delete store[key]; continue; }
      if (entry.not_before && Date.parse(entry.not_before) > now + 60 * 60000) entry.not_before = new Date(now + 60 * 60000).toISOString();
      if (Date.parse(entry.not_before ?? '') > now) continue;
      entries.push({ source: 'recovery', purpose: `channel-recover:${key}`, commands: [{ command: '/hermitd:channel-responder', arg: `recover ${key}` }] });
    }
    return { entries, pending: Object.keys(store).length > 0 };
  });
}

export function historyFor(dir: string, key: string) {
  const entry = readStore(dir)[key];
  if (!entry || !isKey(key)) return null;
  const { source, chatId, thread } = conversation(key);
  const config = readSettledConfig(dir);
  return { conversation: key, source, chatId, thread, rows: conversationHistory(dir, source, chatId, {
    limit: 100, senderIds: allowedUserIds(config, source), since: entry.since, thread,
  }) };
}
