// Resident-owned state for the native harness command executor: one durable queue that
// chat, the terminal, the watchdog, shutdown, update and pause write and the core mod
// drains with `$.command.run`. No tmux fallback.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { readJson } from './cli';
import { ARG_COMMANDS, ARG_RE, BARE_COMMANDS, COMMAND_MARKER_TTL_SECS, type ParsedCommand } from './harness-command';
import { readRuntimeJson } from './runtime';
import { passesExecutionBoundary } from './tasks';

export type ReplyTarget = { source: string; chat_id: string; thread?: string | null };
export type HarnessRequest = {
  commands: ParsedCommand[];
  by: string;
  reply_to?: ReplyTarget;
  dir: string;
  requested_at?: string;
};
export type HarnessDecision =
  | { decision: 'pass' }
  | { decision: 'refuse'; reason: string; reply_to?: ReplyTarget; silent?: boolean }
  | ({ decision: 'run' } & HarnessRequest);
export const MOD_LOADED_FILE = 'harness-mod-loaded.json';
export const QUEUE_DIR = 'harness-queue';
export const INFLIGHT_DIR = 'harness-inflight';
export const OUTCOMES_DIR = 'harness-outcomes';
const OUTCOME_RETENTION_MS = 24 * 3600 * 1000;

export type QueueSource = 'chat' | 'terminal' | 'watchdog' | 'stop' | 'update' | 'pause';
export type LegStatus = 'ok' | 'failed' | 'unknown' | 'skipped';
export type Leg = { command: string; status: LegStatus; text: string; submitted_at?: string };
export type QueueRequest = {
  source: QueueSource;
  by?: string;
  purpose?: string;
  commands: ParsedCommand[];
  trigger?: string;
  reply_to?: ReplyTarget;
  session_id?: string;
  expect_version?: string;
};
export type QueueEntry = QueueRequest & {
  id: string;
  requested_at: string;
  claimed_at?: string;
  claimer_version?: string;
  legs?: Leg[];
};
export type QueueOutcome = {
  id: string; source: QueueSource; purpose: string | null; commands: ParsedCommand[]; legs: Leg[]; finished_at: string;
};
export type EnqueueResult = { status: 'queued'; id: string } | { status: 'skipped'; reason: string };

export function writeModState(dir: string, file: string, value: unknown): void {
  writeAtomic(path.join(dir, 'state', file), value);
}

/** True when the core mod recorded itself loaded for the resident's current session. */
export function modLoadedForResident(dir: string): boolean {
  const runtime = readRuntimeJson(path.join(dir, 'state'));
  const loaded = readJson(path.join(dir, 'state', MOD_LOADED_FILE));
  return typeof runtime?.cc_session_id === 'string' && !!runtime.cc_session_id && loaded?.session_id === runtime.cc_session_id;
}

/** The leg that stopped a request, or undefined when every leg was ok. */
export function failedLeg(outcome: { legs: Leg[] }): Leg | undefined {
  return outcome.legs.find(leg => leg.status !== 'ok');
}

/** The status a whole request reached: its first non-ok leg's, else ok. */
export function outcomeStatus(outcome: { legs: Leg[] }): LegStatus {
  return failedLeg(outcome)?.status ?? 'ok';
}

export function readOutcome(dir: string, id: string): QueueOutcome | null {
  return readJson(path.join(dir, 'state', OUTCOMES_DIR, `${id}.json`));
}

const SKILL_RE = /^\/[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/i;
const FREE_TEXT_MAX = 512;
const freeText = (arg: unknown) => typeof arg === 'string' && arg.trim() !== '' && arg.length <= FREE_TEXT_MAX && !/\p{Cc}/u.test(arg);

/** Each command keeps its own contract; free text only where the command takes it. */
export function validCommand(command: ParsedCommand): boolean {
  if (!command || typeof command.command !== 'string') return false;
  const { command: name, arg } = command;
  if (name === '/permission-mode') return false; // the Shift+Tab cycler owns it, not the mod
  if (ARG_COMMANDS.has(name)) return typeof arg === 'string' && ARG_RE.test(arg);
  if (name === '/compact' || SKILL_RE.test(name)) return arg === null || freeText(arg);
  if (BARE_COMMANDS.has(name) || name === '/reload-plugins') return arg === null;
  return false;
}

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n');
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function withQueueLock<T>(dir: string, body: () => T): T {
  const lock = path.join(dir, 'state', '.harness-queue.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (!acquireLockWithWait(lock, 5000)) throw new Error('harness_queue_locked');
  try { return body(); } finally { releaseLock(lock); }
}

type Listed = { file: string; entry: QueueEntry };
function listEntries(dir: string, sub: string): Listed[] {
  const root = path.join(dir, 'state', sub);
  let names: string[];
  try { names = fs.readdirSync(root).filter(name => name.endsWith('.json')).sort(); } catch { return []; }
  const out: Listed[] = [];
  for (const name of names) {
    const file = path.join(root, name);
    const entry = readJson(file);
    if (entry && typeof entry.id === 'string' && Array.isArray(entry.commands)) out.push({ file, entry });
    else { try { fs.unlinkSync(file); } catch {} }
  }
  return out;
}

/** Validates and appends one request. Never runs anything itself. */
export function enqueue(dir: string, request: QueueRequest, now = Date.now()): EnqueueResult {
  if (!Array.isArray(request.commands) || !request.commands.every(validCommand)
    || (request.source !== 'pause' && request.commands.length === 0)) throw new Error('invalid_command');
  return withQueueLock(dir, () => {
    const runtime = readRuntimeJson(path.join(dir, 'state'));
    if (!modLoadedForResident(dir)) return { status: 'skipped', reason: 'mod_not_loaded' };
    if (runtime.shutdown_requested_at && request.source !== 'stop') return { status: 'skipped', reason: 'shutdown' };
    const sessionId = request.session_id ?? runtime.cc_session_id;
    const queued = listEntries(dir, QUEUE_DIR);
    if (request.purpose) {
      const same = [...queued, ...listEntries(dir, INFLIGHT_DIR)]
        .find(({ entry }) => entry.purpose === request.purpose && entry.session_id === sessionId);
      if (same) return { status: 'queued', id: same.entry.id };
    }
    // File names sort in arrival order, so two requests in one millisecond get distinct stamps.
    const last = Date.parse(queued.at(-1)?.entry.requested_at ?? '');
    const requestedAt = new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
    const entry: QueueEntry = { ...request, session_id: sessionId, id: crypto.randomUUID(), requested_at: requestedAt };
    writeAtomic(path.join(dir, 'state', QUEUE_DIR, `${requestedAt}-${entry.id}.json`), entry);
    return { status: 'queued', id: entry.id };
  });
}

/** Marks every command after the finished legs as never run. */
function padLegs(entry: QueueEntry, legs: Leg[]): Leg[] {
  return [...legs, ...entry.commands.slice(legs.length)
    .map(command => ({ command: command.command, status: 'skipped' as LegStatus, text: 'not run' }))];
}

/** Ends the current leg with `status` and marks the rest as never run. */
function legsFor(entry: QueueEntry, status: LegStatus, text: string): Leg[] {
  const done = entry.legs ?? [];
  const current = entry.commands[done.length];
  return padLegs(entry, current ? [...done, { command: current.command, status, text }] : done);
}

function writeOutcome(dir: string, entry: QueueEntry, legs: Leg[], files: string[], now: number): QueueOutcome {
  const target = path.join(dir, 'state', OUTCOMES_DIR, `${entry.id}.json`);
  const existing = readJson(target) as QueueOutcome | null;
  if (existing) {
    for (const file of files) { try { fs.unlinkSync(file); } catch {} }
    return existing;
  }
  const outcome: QueueOutcome = {
    id: entry.id, source: entry.source, purpose: entry.purpose ?? null, commands: entry.commands, legs,
    finished_at: new Date(now).toISOString(),
  };
  writeAtomic(target, outcome);
  for (const file of files) { try { fs.unlinkSync(file); } catch {} }
  return outcome;
}

function findEntry(dir: string, id: string): Listed | null {
  return [...listEntries(dir, INFLIGHT_DIR), ...listEntries(dir, QUEUE_DIR)].find(({ entry }) => entry.id === id) ?? null;
}

/** The claimed entry, with its reply target and requester, or null once finalized. */
export function readInflight(dir: string, id: string): QueueEntry | null {
  return listEntries(dir, INFLIGHT_DIR).find(({ entry }) => entry.id === id)?.entry ?? null;
}

/** Idempotent: a second call returns the outcome already written. */
export function finalize(dir: string, id: string, outcome: { legs: Leg[] }, now = Date.now()): QueueOutcome | null {
  return withQueueLock(dir, () => {
    const existing = readOutcome(dir, id);
    if (existing) return existing;
    const found = findEntry(dir, id);
    // Legs after the one that stopped the request never ran.
    return found ? writeOutcome(dir, found.entry, padLegs(found.entry, outcome.legs), [found.file], now) : null;
  });
}

/** Records finished legs on the in-flight entry, so a fresh mod copy knows where it stopped. */
export function recordLegs(dir: string, id: string, legs: Leg[]): boolean {
  return withQueueLock(dir, () => {
    const found = listEntries(dir, INFLIGHT_DIR).find(({ entry }) => entry.id === id);
    if (!found) return false;
    writeAtomic(found.file, { ...found.entry, legs });
    return true;
  });
}

/** Expires stale requests and returns the ones still queued. */
function sweep(dir: string, now: number): Listed[] {
  const live: Listed[] = [];
  for (const { file, entry } of listEntries(dir, QUEUE_DIR)) {
    const at = Date.parse(entry.requested_at);
    if (!Number.isFinite(at) || now - at > COMMAND_MARKER_TTL_SECS * 1000) {
      writeOutcome(dir, entry, legsFor(entry, 'skipped', 'expired'), [file], now);
    } else live.push({ file, entry });
  }
  const outcomes = path.join(dir, 'state', OUTCOMES_DIR);
  let names: string[] = [];
  try { names = fs.readdirSync(outcomes); } catch {}
  for (const name of names) {
    const file = path.join(outcomes, name);
    const finished = Date.parse(readJson(file)?.finished_at ?? '');
    if (!Number.isFinite(finished) || now - finished > OUTCOME_RETENTION_MS) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return live;
}

const SESSION_BOUND = new Set<QueueSource>(['watchdog', 'stop', 'pause']);

/**
 * Admits the next request for the caller's session and moves it in flight. A pause
 * goes first; requests that can no longer run are finalized here instead of run.
 */
export function claim(dir: string, sessionId: string, claimerVersion: string, options: { pauseOnly?: boolean } = {}, now = Date.now()): QueueEntry | null {
  return withQueueLock(dir, () => {
    const entries = sweep(dir, now);
    const runtime = readRuntimeJson(path.join(dir, 'state')) ?? {};
    if (runtime.transition || runtime.shutdown_completed_at) return null;
    const ordered = [...entries.filter(e => e.entry.source === 'pause'), ...entries.filter(e => e.entry.source !== 'pause')];
    for (const { file, entry } of ordered) {
      if (SESSION_BOUND.has(entry.source) && entry.session_id !== sessionId) {
        writeOutcome(dir, entry, legsFor(entry, 'unknown', 'stale_session'), [file], now);
        continue;
      }
      if (runtime.shutdown_requested_at && entry.source !== 'stop') {
        writeOutcome(dir, entry, legsFor(entry, 'unknown', 'shutdown'), [file], now);
        continue;
      }
      if (options.pauseOnly && entry.source !== 'pause') continue;
      if (entry.source === 'watchdog') {
        const boundary = passesExecutionBoundary(dir);
        if (!boundary.ok) {
          writeOutcome(dir, entry, legsFor(entry, 'skipped', boundary.reason), [file], now);
          continue;
        }
      }
      const admitted: QueueEntry = { ...entry, claimed_at: new Date(now).toISOString(), claimer_version: claimerVersion };
      writeAtomic(path.join(dir, 'state', INFLIGHT_DIR, path.basename(file)), admitted);
      try { fs.unlinkSync(file); } catch {}
      return admitted;
    }
    return null;
  });
}

/**
 * Settles what an earlier mod copy left in flight. Only a reload that a newer copy of
 * the expected version proves done continues; anything else is an uncertain attempt
 * and ends `unknown`, its later legs never run.
 */
export function recover(dir: string, claimerVersion: string, now = Date.now()): QueueEntry | null {
  return withQueueLock(dir, () => {
    let resumed: QueueEntry | null = null;
    for (const { file, entry } of listEntries(dir, INFLIGHT_DIR)) {
      const legs = entry.legs ?? [];
      const current = entry.commands[legs.length];
      if (!resumed && current?.command === '/reload-plugins' && entry.expect_version
        && entry.expect_version === claimerVersion && entry.claimer_version !== claimerVersion) {
        const done = [...legs, { command: current.command, status: 'ok' as LegStatus, text: `Reloaded to ${claimerVersion}` }];
        if (done.length === entry.commands.length) {
          writeOutcome(dir, entry, done, [file], now);
          continue;
        }
        resumed = { ...entry, legs: done, claimer_version: claimerVersion };
        writeAtomic(file, resumed);
        continue;
      }
      writeOutcome(dir, entry, legsFor(entry, 'unknown', 'worker_lost'), [file], now);
    }
    return resumed;
  });
}
