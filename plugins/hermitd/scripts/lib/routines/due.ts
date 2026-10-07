// `routines.ts due` — deterministic scheduler for monitor-mode routines. Polled every
// interval by routine-monitor.sh. Owns all gating (pause and operator turns), all state writes
// (state/routine-schedule.json cursors, state/routine-monitor-liveness.json), and emits
// a single ROUTINE_DUE line only for routines that should actually wake the session.
//
// Usage: bun routines.ts due <hermit-dir>
// Output (stdout): nothing, or exactly one line:
//   ROUTINE_DUE [hermit-routine:<id1>] [hermit-routine:<id2>] ...
// The bracketed markers are load-bearing — cost-tracker.ts classifySource reads this
// ROUTINE_DUE line to attribute the wake turn: one id → routine:<id>, ≥2 ids (a co-fire)
// → the routine:multi bucket. Also load-bearing: record-operator-action.ts
// isRoutinePrompt() drops this line; tests/heartbeat-monitor-emissions.test.ts drift guard syncs it.
//
// State model (state/routine-schedule.json): { "<id>": { "last_consumed_mark": "<ISO minute>", "held_at"?: "<ISO minute>" } }
// `held_at` is the last poll at which an occurrence was deferred for an open operator
// turn; lateness is measured from it instead of the occurrence, so time spent deferred
// does not count while a gap the monitor did not observe (downtime) still does. It is
// re-stamped on every held poll and dropped by any consume, which rewrites the entry.
// A routine is due when a cron-matching minute mark exists in (last_consumed_mark, now],
// lower-bounded at now-24h. Gate order per due routine: paused →
// lateness (consume, no emit when expired) → operator-turn-open (defer, no consume) →
// precheck (consume, no emit on SKIP) → emit
// (consume). Missing entry inits to now, fires nothing — exact CronCreate-death parity,
// no catch-up (operator-confirmed). The precheck is the routine's declared world-state
// gate (lib/routines/gate.ts); it never changes what is emitted, only whether.
//
// heartbeat-restart is hardcoded excluded — it stays the CronCreate re-arm anchor.
//
// Exit 0 always. All errors fail-soft: emit nothing, still write liveness, stderr only —
// a corrupt config must not print an error line every poll.

import fs from 'node:fs';
import path from 'node:path';
import { isPaused } from '../pause';
import { validateCronSchedule, ROUTINE_ID_RE } from '../../validate-config';
import { latestFires } from '../cron';
import { readJson as readJSON } from '../cli';
import { readConfigRaw } from '../config-read';
import { logRoutineEvent } from './event';
import { runGate } from './gate';
import { operatorTurnOpen } from '../operator-turn';

type Json = any;

const ANCHOR_ID = 'heartbeat-restart';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const hermitDir = process.argv[2];
if (!hermitDir) process.exit(0);

const stateDir = path.join(hermitDir, 'state');
const schedulePath = path.join(stateDir, 'routine-schedule.json');
const livenessPath = path.join(stateDir, 'routine-monitor-liveness.json');

function now(): Date {
  if (process.env.HERMIT_NOW) {
    const d = new Date(process.env.HERMIT_NOW);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS);
}

function writeJSONAtomic(p: string, value: Json): boolean {
  // Test-only seam: force the schedule persist to fail (leaving liveness writable) so a
  // test can reach the skip branches with a valid cursor, then verify the persist-before-
  // stamp ordering. Scoped to schedulePath so it never affects liveness or other writes.
  if (process.env.HERMIT_DUE_FORCE_PERSIST_FAIL && p === schedulePath) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

function writeLiveness(): void {
  writeJSONAtomic(livenessPath, {
    last_peek_at: new Date().toISOString(),
    ...(process.env.MONITOR_SUPERVISOR_PID ? { pid: Number(process.env.MONITOR_SUPERVISOR_PID) } : {}),
  });
}

function stamp(id: string, event: string, detail?: string): void {
  try {
    logRoutineEvent(id, event, hermitDir, 'monitor', detail);
  } catch { /* fail-open — a stamp failure must not block the routine */ }
}

// Exit early on any hard failure — always write liveness first so the doctor still
// sees a live proof-of-life even on a bad run.
function finish(lines: string[]): never {
  writeLiveness();
  if (lines.length) process.stdout.write(lines.join(' ') + '\n');
  process.exit(0);
}

const nowDate = now();
const nowMinute = floorToMinute(nowDate);
const windowFloor = new Date(nowMinute.getTime() - WINDOW_MS);

// Raw, not settled: absent/unreadable config must short-circuit before cursor
// init/pruning below — a settled empty routines list would still run them.
const config = readConfigRaw(hermitDir);
if (!config) finish([]);

const configuredLateness = config.routine_max_lateness_minutes;
const maxLatenessMinutes = Number.isInteger(configuredLateness) && configuredLateness >= 1 && configuredLateness <= 1440
  ? configuredLateness : 60;

// A bad tz finds no match (fail-soft), but cursor init/reset and pruning below still run.
const timezone: string | null = typeof config.timezone === 'string' ? config.timezone : null;
const routines: Json[] = Array.isArray(config.routines) ? config.routines : [];
const eligible = routines.filter((r: Json) =>
  r && r.enabled === true && r.id && r.skill && r.schedule && r.id !== ANCHOR_ID);

const turnOpen = operatorTurnOpen(hermitDir, nowDate.getTime());

let paused = false;
try {
  paused = isPaused(hermitDir).paused;
} catch {
  paused = false; // fail-open: unresolvable pause state reads as unpaused
}

const schedule: Json = readJSON(schedulePath) || {};
let scheduleChanged = false;
const dueIds: string[] = [];
// Skip stamps are deferred and flushed only after the schedule persists — a failed persist
// must not leave a skipped-* row whose cursor advance was rolled back (phantom ledger rows).
const pendingStamps: Array<[string, string, string?]> = [];

for (const routine of eligible) {
  const id: string = routine.id;
  if (!ROUTINE_ID_RE.test(id)) {
    process.stderr.write(`routine-due: skipping routine with invalid id "${id}"\n`);
    continue;
  }
  if (validateCronSchedule(routine.schedule)) {
    process.stderr.write(`routine-due: skipping routine "${id}" — invalid schedule "${routine.schedule}"\n`);
    continue;
  }

  const entry = schedule[id];
  let cursor: Date | null = entry && typeof entry.last_consumed_mark === 'string'
    ? new Date(entry.last_consumed_mark)
    : null;
  if (!cursor || isNaN(cursor.getTime()) || cursor.getTime() > nowMinute.getTime()) {
    // Missing, corrupt, or future (clock skew) — initialize to now, fire nothing.
    schedule[id] = { last_consumed_mark: nowMinute.toISOString() };
    scheduleChanged = true;
    continue;
  }

  const from = cursor.getTime() < windowFloor.getTime() ? windowFloor : cursor;

  const latestMatch: Date | null = latestFires(routine.schedule, timezone, from, nowMinute, 1)[0] ?? null;

  if (!latestMatch) {
    // No match in (from, now]: advance the cursor to nowMinute so the next poll re-scans only
    // new minutes instead of re-walking this dead window every interval. Safe — nothing
    // matched up to now, and anything before windowFloor is intentionally abandoned (no
    // catch-up). Guard against a redundant write when the cursor is already at nowMinute.
    if (cursor.getTime() < nowMinute.getTime()) {
      schedule[id] = { last_consumed_mark: nowMinute.toISOString() };
      scheduleChanged = true;
    }
    continue;
  }


  if (paused) {
    schedule[id] = { last_consumed_mark: latestMatch.toISOString() };
    scheduleChanged = true;
    pendingStamps.push([id, 'skipped-paused']);
    continue;
  }
  // Expire before deferring: a busy turn must not keep a stale occurrence pending
  // (`held_at`, above). A future stamp (clock skew) is ignored rather than trusted —
  // crediting it would hold the occurrence forever, the same reason the cursor
  // reinits above.
  const heldAt = typeof entry.held_at === 'string' ? Date.parse(entry.held_at) : NaN;
  const latenessFrom = !isNaN(heldAt) && heldAt <= nowMinute.getTime()
    ? Math.max(heldAt, latestMatch.getTime())
    : latestMatch.getTime();
  if (nowMinute.getTime() - latenessFrom > maxLatenessMinutes * MINUTE_MS) {
    schedule[id] = { last_consumed_mark: latestMatch.toISOString() };
    scheduleChanged = true;
    pendingStamps.push([id, 'skipped-late']);
    continue;
  }
  if (turnOpen) {
    // Defer: live operator exchange — do NOT consume; next poll re-derives from
    // the untouched cursor and fires at the first post-turn poll.
    schedule[id] = { ...entry, held_at: nowMinute.toISOString() };
    scheduleChanged = true;
    continue;
  }

  // World-state gate. The only check that can consume a fire without waking the
  // session, and the only one that runs code the operator wrote. Placed after the
  // turn-open defer on purpose: that branch does not consume, so a gate above it
  // would re-run every poll for the whole open turn (a mail poll a minute).
  if (routine.precheck !== undefined && routine.precheck !== null) {
    const gate = runGate(routine, hermitDir, latestMatch.toISOString());
    // A gate may legitimately take up to five minutes. Liveness is otherwise only
    // written by finish(), so without this a slow gate reads as a dead monitor and
    // earns a watchdog re-arm — a paid turn to recover from working as designed.
    writeLiveness();
    if (gate.verdict === 'skip') {
      schedule[id] = { last_consumed_mark: latestMatch.toISOString() };
      scheduleChanged = true;
      pendingStamps.push([id, 'skipped-precheck']);
      continue;
    }
    // error → fall through and wake: a broken gate must cost no more than no gate.
    // The detail rides the ledger row so health/doctor can surface a gate that has
    // been erroring on every fire (the operator is paying wakes they meant to skip).
    if (gate.verdict === 'error') pendingStamps.push([id, 'precheck-error', gate.detail]);
  }

  schedule[id] = { last_consumed_mark: latestMatch.toISOString() };
  scheduleChanged = true;
  dueIds.push(id);
}

// Prune entries for ids no longer enabled/non-anchor.
const eligibleIds = new Set(eligible.map((r: Json) => r.id));
for (const id of Object.keys(schedule)) {
  if (!eligibleIds.has(id)) {
    delete schedule[id];
    scheduleChanged = true;
  }
}

if (scheduleChanged) {
  const persisted = writeJSONAtomic(schedulePath, schedule);
  if (!persisted) {
    // Ordering contract: persist before emit AND before stamping. A failed write must not
    // emit or stamp — otherwise the subprocess-side dedup/ledger guarantee is void.
    process.stderr.write(`routine-due: failed to persist ${schedulePath} — emitting nothing this poll\n`);
    finish([]);
  }
}

// Persist succeeded (or nothing changed) — now flush the deferred skip stamps.
for (const [id, event, detail] of pendingStamps) stamp(id, event, detail);

for (const id of dueIds) stamp(id, 'dispatched');

finish(dueIds.length ? [`ROUTINE_DUE ${dueIds.map(id => `[hermit-routine:${id}]`).join(' ')}`] : []);
