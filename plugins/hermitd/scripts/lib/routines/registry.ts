// Diff-based plan/commit for hermit-routines CronCreate registration, behind
// `routines.ts arm begin` / `arm commit` (lib/routines/arm.ts owns the CLI).
//
// forceReset (used by `load --reset`) skips every mirror/hash/age comparison and
// returns every enabled routine as a create with no deletes: the caller is
// expected to do its own unconditional CronList-based sweep for deletes first.
//
// The plan lists deletes (existing CronCreates to tear down before recreating),
// creates (with the timezone-shifted schedule already computed, plus a `warn` for
// ids whose tz-shift fell back to the unshifted schedule) and the keep count.
//
// A create with no matching delete is a brand-new or never-registered routine.
// On boot mismatch (or a missing/corrupt mirror) every enabled routine is a create
// with NO deletes — durable:false crons already died with the prior process, so
// there is nothing live to tear down; deleting anyway would just be a wasted
// CronDelete call on an id CC has already forgotten.
//
// commitCron rebuilds state/cron-registry.json from the last plan's explicit keep
// set: every created id is stamped registered_at=now (resetting its age clock);
// only the plan's keep ids carry forward, with their registered_at UNCHANGED (no
// CronCreate happened for them); every other id is dropped: a skipped or failed
// CronCreate is NOT recorded as live (that would let a real failure hide behind a
// keep next run), and nothing from a dead prior process (boot mismatch → empty keep
// set) is resurrected as a ghost. `load --reset`'s unconditional
// CronList/CronDelete/CronCreate sweep remains the self-healing recovery path for
// any mirror/reality drift.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../hash';
import { shiftCron } from '../cron-shift';
import { installedRootFor } from '../plugin-siblings';
import { parseCronField } from '../../validate-config';

type Json = any;

// Re-register even an unchanged routine once it has been alive this long. CC's
// recurring-task auto-expiry is a hard 7-day-from-creation cliff — it is NOT
// extended by CronList/activity, only by cancel-and-recreate — so this must stay
// comfortably under 7 days. In practice the daily heartbeat-restart reload is what
// crosses this threshold for every routine, exactly as it does with the old
// unconditional-reset design; the diff just skips the ones nowhere near the cliff.
const REREGISTER_AGE_MS = 5 * 24 * 60 * 60 * 1000;

interface MirrorEntry {
  prompt_hash: string;
  registered_at: number;
}

interface Mirror {
  boot_id: string | null;
  routines: Record<string, MirrorEntry>;
}

interface PlanCreate { id: string; schedule: string; warn?: string; }
interface ShiftedRoutine { id: string; schedule: string; }
interface PlanResult { deletes: string[]; creates: PlanCreate[]; keepCount: number; keeps: string[]; enabledShifted: ShiftedRoutine[]; }

function readMirror(mirrorPath: string): Mirror {
  try {
    const parsed = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.routines && typeof parsed.routines === 'object') {
      return { boot_id: typeof parsed.boot_id === 'string' ? parsed.boot_id : null, routines: parsed.routines };
    }
  } catch { /* missing or corrupt — treated as an empty mirror (all-CREATE) below */ }
  return { boot_id: null, routines: {} };
}

function readBootId(hermitDir: string): string | null {
  try {
    const v = fs.readFileSync(path.join(hermitDir, 'state', '.boot-id'), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

// Wraps cron-tz-shift's shiftCron for a single routine. Returns the schedule
// unchanged (no warn) when the machine timezone can't be resolved — the same
// fail-open behavior lib/routines/tz-shift.ts's CLI uses.
function shiftForRoutine(
  schedule: string, configTz: string | null, machineTz: string | null, ref: Date,
): { result: string; warn?: string } {
  if (!machineTz) return { result: schedule };
  const { result, warn } = shiftCron(schedule, configTz || '', machineTz, ref);
  return { result, warn };
}

// Hash over every input that determines what gets registered — a change to any
// of these must force a delete+recreate. Schedule is the already-shifted value,
// so a DST re-shift changes the hash exactly like an id/skill/flag edit would.
function promptHash(r: Json, shiftedSchedule: string, pluginRoot: string): string {
  return sha256(JSON.stringify({
    id: r.id,
    skill: r.skill,
    model: r.model ?? null,
    // Spread only when set so existing routines keep their hash and are not re-registered.
    ...(r.effort != null ? { effort: r.effort } : {}),
    reflect_after: !!r.reflect_after,
    expect_artifact: r.expect_artifact ?? null,
    precheck: r.precheck ?? null,
    precheck_timeout_s: r.precheck_timeout_s ?? null,
    shifted_schedule: shiftedSchedule,
    // Claude Code can cache one release as both `<ver>` and `<ver>-<sha12>` (see
    // sameMonitorCommand); either copy is the same build, so the suffix is not drift.
    // A marketplace clone root hashes as its same-version cache dir for the same reason.
    pluginRoot: installedRootFor(pluginRoot).replace(/-[0-9a-f]{12}$/, ''),
  }));
}

// No network/Date.now() inside, and the only fs access is the one plugin.json read
// that maps a marketplace clone root (installedRootFor). Callers inject now/machineTz
// so this (and its test fixtures) are fully deterministic.
function planCron(
  routines: Json[],
  mirror: Mirror,
  currentBootId: string | null,
  pluginRoot: string,
  configTz: string | null,
  machineTz: string | null,
  nowMs: number,
  forceReset = false,
): PlanResult {
  const enabled = routines.filter(r => r && r.enabled === true && r.id && r.skill && r.schedule);
  // forceReset (load --reset) always takes the all-CREATE/no-DELETE branch below,
  // regardless of mirror state — the caller does its own unconditional CronList
  // sweep for deletes, so the planner only needs to hand back shifted schedules.
  const bootMismatch = forceReset || !mirror.boot_id || !currentBootId || mirror.boot_id !== currentBootId;
  const ref = new Date(nowMs);
  const root = installedRootFor(pluginRoot);

  const deletes: string[] = [];
  const creates: PlanCreate[] = [];
  const keeps: string[] = [];
  const enabledShifted: ShiftedRoutine[] = [];
  const seen = new Set<string>();

  for (const r of enabled) {
    if (seen.has(r.id)) continue; // duplicate id in config (validator only warns) — register once
    seen.add(r.id);
    const shift = shiftForRoutine(r.schedule, configTz, machineTz, ref);
    enabledShifted.push({ id: r.id, schedule: shift.result }); // for the wake-spread lint, regardless of create/keep
    const hash = promptHash(r, shift.result, root);
    const existing = mirror.routines[r.id];

    if (bootMismatch) {
      creates.push({ id: r.id, schedule: shift.result, warn: shift.warn });
      continue;
    }
    if (!existing) {
      creates.push({ id: r.id, schedule: shift.result, warn: shift.warn });
      continue;
    }
    const changed = existing.prompt_hash !== hash;
    // A non-finite registered_at (malformed/hand-edited mirror) must fail safe to a
    // re-register — not read as "never aged" and silently ride past CC's expiry cliff.
    const aged = !Number.isFinite(existing.registered_at) || (nowMs - existing.registered_at) > REREGISTER_AGE_MS;
    if (changed || aged) {
      deletes.push(r.id);
      creates.push({ id: r.id, schedule: shift.result, warn: shift.warn });
      continue;
    }
    keeps.push(r.id);
  }

  // Mirror entries for routines that are no longer enabled/present — only plausibly
  // live (and thus worth a CronDelete) when the mirror's boot_id matches this process.
  if (!bootMismatch) {
    for (const id of Object.keys(mirror.routines)) {
      if (!seen.has(id)) deletes.push(id);
    }
  }

  return { deletes, creates, keepCount: keeps.length, keeps, enabledShifted };
}

// Wake-clustering lint. Each cache-cold wake re-warms the whole session context, so
// scattered routine fire-times cost more than clustered ones (§7 PR-8 of the
// 2026-07-09 live-harness audit). Buckets each enabled routine's *shifted* (real
// machine-local) fire-times into 30-min windows and reports when the number of
// distinct windows exceeds maxWindows, naming the "loneliest" fires (a window with a
// single routine) so the operator knows which schedules to move. This is a proxy for
// wake COUNT, not a cache-warmth guarantee — the context cache TTL is far under 30
// min, so same-window fires still wake cold; fewer distinct windows just means fewer
// idle→active transitions. Advisory only: never affects registration.
//
// A routine that fires every hour (`*`, `*/1`, `0-23`) would occupy every window and
// swamp the signal — excluded. Pure: no fs/Date; the shifted schedules are handed in.
const WAKE_WINDOW_MINUTES = 30;

function computeWakeSpread(
  enabledShifted: ShiftedRoutine[],
  maxWindows: number,
): { distinct: number; loneliest: string[] } | null {
  const windows = new Map<number, string[]>(); // window index → ["<id>@HH:MM", ...] firing in it
  for (const { id, schedule } of enabledShifted) {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [minF, hourF] = parts;
    let mins: number[], hours: number[];
    try {
      mins = [...parseCronField(minF, 0, 59)];
      hours = [...parseCronField(hourF, 0, 23)];
    } catch { continue; } // malformed field — skip this routine, never throw
    if (hours.length >= 24) continue; // fires every hour (`*`, `*/1`, `0-23`) — not a clustering signal
    for (const h of hours) {
      for (const m of mins) {
        const idx = Math.floor((h * 60 + m) / WAKE_WINDOW_MINUTES);
        const label = `${id}@${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const arr = windows.get(idx);
        if (arr) arr.push(label); else windows.set(idx, [label]);
      }
    }
  }
  const distinct = windows.size;
  if (distinct <= maxWindows) return null;
  const sortedIdx = [...windows.keys()].sort((a, b) => a - b);
  const loneliest: string[] = [];
  let minCount = Infinity;
  for (const idx of sortedIdx) {
    const arr = windows.get(idx)!;
    if (arr.length === 1) loneliest.push(arr[0]);
    minCount = Math.min(minCount, arr.length);
  }
  // No singleton windows (every window shares ≥2 fires) but still over-threshold:
  // name the fires in the least-populated windows so the advisory always points at
  // concrete schedules to move, rather than emitting an empty "consider clustering:".
  if (loneliest.length === 0) {
    for (const idx of sortedIdx) {
      const arr = windows.get(idx)!;
      if (arr.length === minCount) loneliest.push(...arr);
    }
  }
  return { distinct, loneliest };
}

// Rewrites the mirror after the caller has issued the actual CronCreate/CronDelete
// calls for `plan`'s output. `createdIds` is the subset of plan.creates that the
// caller confirms actually succeeded — anything else in creates/deletes is dropped,
// not carried forward, so a failed or skipped CronCreate can never masquerade as KEEP.
function commitCron(
  mirror: Mirror,
  plan: PlanResult,
  createdIds: Set<string>,
  routineById: Map<string, Json>,
  pluginRoot: string,
  bootId: string | null,
  nowMs: number,
): Mirror {
  // Rebuild from the plan's explicit KEEP set rather than inferring "untouched" from
  // set membership. On a boot mismatch (including load --reset) keeps is empty, so no
  // entry from the dead prior process is carried forward — a routine disabled across a
  // restart leaves no ghost that a later boot-match load would misread as a live KEEP.
  const next: Mirror = { boot_id: bootId, routines: {} };
  for (const id of plan.keeps) {
    const entry = mirror.routines[id];
    if (entry) next.routines[id] = entry; // genuine KEEP — no CronCreate happened, age unchanged
  }

  const root = installedRootFor(pluginRoot);
  for (const { id, schedule } of plan.creates) {
    if (!createdIds.has(id)) continue;
    const r = routineById.get(id);
    if (!r) continue;
    next.routines[id] = { prompt_hash: promptHash(r, schedule, root), registered_at: nowMs };
  }

  return next;
}

// Restrict planning/committing to a subset of routines by id csv (used to
// register the heartbeat-restart anchor alone in monitor mode: planCron then plans
// a delete for every previously-tracked routine outside the subset, which is what
// sweeps stale non-anchor CronCreates). null/empty idsCsv → routines unchanged.
function filterRoutinesByIds(routines: Json[], idsCsv: string | null): Json[] {
  if (!idsCsv) return routines;
  const idsSet = new Set(idsCsv.split(',').map(s => s.trim()).filter(Boolean));
  return routines.filter((r: Json) => idsSet.has(r?.id));
}

export { planCron, commitCron, computeWakeSpread, readMirror, readBootId, promptHash, REREGISTER_AGE_MS, filterRoutinesByIds };
export type { Mirror, MirrorEntry, PlanResult, PlanCreate, ShiftedRoutine };
