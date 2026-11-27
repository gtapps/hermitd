// The resident's turn lifecycle, owned in one place. Three state files describe it:
//   execution.json            in flight, idle or unknown, plus the hermit-evolve mark
//   operator-turn-open.json   an operator turn is running (routines defer behind it)
//   last-operator-action.json the quiet clock (context clearing, watchdog, dream)
// Hooks and the mod bridge report turn events here; readers ask for turn state.
// Each hook runs as its own short-lived process, in parallel with its siblings, so
// this stays a small library with no task-library import. Guest gating stays in
// the callers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './cli';
import { writeFileAtomic } from './md-write';
import { findResident } from './session-registry';

const HOUR = 3600000;
const EXECUTION = 'execution.json';
const TURN_OPEN = 'operator-turn-open.json';
const LAST_ACTION = 'last-operator-action.json';

const file = (dir: string, name: string) => path.join(dir, 'state', name);
const iso = (value: string) => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));

export interface Execution { state: 'in_flight' | 'idle' | 'unknown'; turn_id: string | null; at: string | null; source: string | null; cc_session_id: string | null; reason: string | null; registry?: string | null; waiting_for?: string | null; display?: string }
export type BackgroundTask = { type?: unknown; status?: unknown; agent_type?: unknown };
/** How a turn ended. Stop and StopFailure report as the turn ends; an interrupt fires
 *  neither, so the mod reports it after the fact with the time it ended. */
export type TurnEnd =
  | { cause: 'stop' | 'stop-failure'; session: string | null; backgroundTasks: BackgroundTask[]; at?: number }
  | { cause: 'interrupt'; session: string | null; at: number; reason: string };

/** The stored execution stamp as written, without the staleness downgrade. */
export function readExecutionRaw(dir: string): any {
  return readJson(file(dir, EXECUTION));
}

export function readExecution(dir: string, options: { registryFallback?: true } = {}): Execution {
  const raw = readExecutionRaw(dir);
  const empty: Execution = { state: 'unknown', turn_id: null, at: null, source: null, cc_session_id: null, reason: null };
  const result: Execution = !raw || !['in_flight', 'idle', 'unknown'].includes(raw.state) || !iso(raw.at ?? '') ? empty
    : { ...empty, ...raw, state: raw.state === 'in_flight' && Date.now() - Date.parse(raw.at) > HOUR ? 'unknown' : raw.state };
  if (options.registryFallback && result.state === 'unknown') {
    const runtime = readJson(path.join(dir, 'state/runtime.json'));
    const resident = findResident(runtime, runtime?.config_dir) as (ReturnType<typeof findResident> & { waitingFor?: string });
    result.registry = resident?.status ?? null;
    result.waiting_for = typeof resident?.waitingFor === 'string' ? resident.waitingFor : null;
    if (resident) result.display = `execution: unknown (registry: ${resident.status}${result.waiting_for ? ', ' + result.waiting_for : ''}, live process)`;
  }
  return result;
}

/** A `hermit-evolve` turn is running: the prompt hook marked its source `upgrade`, and an
 *  auto-compaction within the last hour keeps that turn running until Stop marks it idle. */
export function evolveTurnRunning(execution: Execution): boolean {
  return execution.source === 'upgrade' && (execution.state === 'in_flight'
    || (execution.state === 'unknown' && execution.reason === 'precompact' && Date.now() - Date.parse(execution.at ?? '') < HOUR));
}

export function operatorTurnOpen(dir: string, nowMs: number): boolean {
  const marker = readJson(file(dir, TURN_OPEN));
  const at = marker && typeof marker.at === 'string' ? new Date(marker.at).getTime() : NaN;
  const age = nowMs - at;
  // The TTL bounds an orphaned marker when no Stop arrives.
  return age >= 0 && age <= HOUR;
}

function observeExecution(dir: string, state: Execution['state'], session: string | null, source: string | null, reason: string | null, endedAt?: number): boolean {
  try {
    const previous = readExecution(dir);
    // A turn end reported after the fact (the mod's interrupt) must not idle a later turn's stamp:
    // the next prompt's hook can run before the mod's write lands.
    if (endedAt !== undefined && (previous.state === 'idle' || !(Date.parse(previous.at ?? '') <= endedAt))) return false;
    // A compaction keeps the source only of a turn the prompt hook tracked; an untracked turn's
    // compaction (a wake that never stamped in_flight) must not inherit the last turn's source.
    const inherited = reason !== 'precompact' || previous.state === 'in_flight' || previous.reason === 'precompact' ? previous.source : null;
    // A prompt arriving mid-turn (a queued channel message) runs this hook too; it must not clear a
    // running hermit-evolve turn's mark, which only Stop, StopFailure or an interrupt ends.
    writeFileAtomic(file(dir, EXECUTION), JSON.stringify({ state, turn_id: state === 'in_flight' ? crypto.randomUUID() : previous.turn_id, at: new Date().toISOString(), source: state === 'in_flight' && evolveTurnRunning(previous) ? 'upgrade' : source ?? inherited, cc_session_id: session, reason }) + '\n');
    return true;
  } catch { /* advisory, never gates the hook */ return false; }
}

function stamp(dir: string, name: string, atMs: number): void {
  try { writeFileAtomic(file(dir, name), JSON.stringify({ at: new Date(atMs).toISOString() }) + '\n'); } catch { /* fail-open */ }
}

/** The prompt hook admitted a resident turn. */
export function turnStarted(dir: string, session: string | null, source: string | null): void {
  observeExecution(dir, 'in_flight', session, source, null);
}

/** PreCompact: a manual compaction runs between turns; an auto-compaction runs inside one. */
export function compacted(dir: string, session: string | null, manual: boolean): void {
  observeExecution(dir, manual ? 'idle' : 'unknown', session, null, 'precompact');
}

/** The resident's SessionStart. A clear only runs between turns; compaction keeps the PreCompact
 *  state, and a manual compaction's idle restarts its clock here, once the compaction has finished. */
export function sessionStarted(dir: string, session: string | null, source: string | null): void {
  if (source !== 'compact') observeExecution(dir, source === 'clear' ? 'idle' : 'unknown', session, null, `resident-start:${source ?? 'startup'}`);
  else if (readExecution(dir).state === 'idle') observeExecution(dir, 'idle', session, null, 'resident-start:compact');
}

/** Marks a turn idle, closes an open operator turn and restarts the quiet clock from its end.
 *  A `hermit-evolve` turn that ends with its background `hermitd:evolve-runner` still running stays
 *  marked: its report arrives in a later turn, which inherits the mark and ends it. A failed turn
 *  ends execution only; its operator-turn marker stays until the next Stop or its TTL. */
export function turnEnded(dir: string, end: TurnEnd): void {
  if (end.cause === 'interrupt') {
    if (!observeExecution(dir, 'idle', end.session, null, end.reason, end.at)) return;
    // A marker newer than the reported end is the next prompt's, opened while the report ran.
    if (Date.parse(readJson(file(dir, TURN_OPEN))?.at ?? '') > end.at) return;
    closeOperatorTurn(dir, end.at);
    return;
  }
  const held = end.backgroundTasks.some(task => task.type === 'subagent' && task.status === 'running' && task.agent_type === 'hermitd:evolve-runner')
    && evolveTurnRunning(readExecution(dir));
  if (!held) observeExecution(dir, 'idle', end.session, null, end.cause === 'stop-failure' ? 'stop-failure' : null);
  if (end.cause === 'stop') closeOperatorTurn(dir, end.at ?? Date.now());
}

/** Quiet time runs from the operator turn's end; a turn with no marker was not the operator's. */
function closeOperatorTurn(dir: string, endedAt: number): void {
  try { fs.unlinkSync(file(dir, TURN_OPEN)); } catch { return; }
  // An interrupt's end is reported after the fact: never move back a stamp a later prompt wrote.
  if (Date.parse(readJson(file(dir, LAST_ACTION))?.at ?? '') > endedAt) return;
  stamp(dir, LAST_ACTION, endedAt);
}

/** A kept operator prompt: restarts the quiet clock. */
export function recordOperatorActivity(dir: string, atMs = Date.now()): void {
  stamp(dir, LAST_ACTION, atMs);
}

/** Starts the quiet clock on a fresh install, so the first quiet window has an origin. */
export function seedOperatorActivity(dir: string): void {
  if (!fs.existsSync(file(dir, LAST_ACTION))) recordOperatorActivity(dir);
}

/** An operator turn is in flight, for the routine defer gate. Stop or an interrupt closes it. */
export function openOperatorTurn(dir: string, atMs = Date.now()): void {
  stamp(dir, TURN_OPEN, atMs);
}
