// Shared read/write/is-paused helpers for the binding pause/stop/resume flag.
//
// Split across two files by authority tier, so an automatic budget pause can
// never overwrite an operator's binding "stop":
//   - operator-pause.json — operator/watchdog pauses (the manual, binding tier)
//   - auto-pause.json      — budget pauses (the automatic tier)
// A budget write touches only auto-pause.json, so it physically cannot downgrade
// an operator stop — no lock needed. isPaused() reads both (plus the legacy
// pause.json, for a pause in force across an upgrade) and resolves precedence
// (operator > watchdog > budget) with reader-side expiry. Dedicated files, NOT
// runtime.json: that file has several concurrent full-object writers and a pause
// write racing its seed write would vanish.
//
// Atomic write mirrors lib/alert-state.ts's tmp+rename. Any read failure
// (missing, unreadable, corrupt) resolves to unpaused — pause-gate.ts is a
// PreToolUse hook and hooks must fail open (never block Claude Code); a
// pause-gate that fails closed on a bad flag file would brick the hermit with
// no way to recover except manual file surgery, which is worse than the gate
// occasionally missing a stale/garbled flag.
//
// Auto-expiry is evaluated by READERS: a `paused_until` in the past reads as
// unpaused, so a snooze needs no unpause writer — see isPaused().

import fs from 'node:fs';
import path from 'node:path';
import { EN_MESSAGES, type Messages } from './messages';

export type PauseReason = 'operator' | 'budget' | 'watchdog';

// Precedence when more than one tier is paused at once: an operator stop outranks
// a watchdog hold, which outranks an automatic budget pause.
const PAUSE_PRIORITY: Record<PauseReason, number> = { operator: 3, watchdog: 2, budget: 1 };

/** Operator-language label for a pause reason — shared by the watchdog's pushes and the status responder. */
export function pauseReasonLabel(reason: PauseReason | string | null | undefined, m: Messages = EN_MESSAGES): string {
  return m.t(reason === 'budget' ? 'pause_reason_budget' : reason === 'watchdog' ? 'pause_reason_watchdog' : 'pause_reason_request');
}

export interface PauseFlag {
  paused: boolean;
  paused_until: string | null; // ISO timestamp, or null = indefinite
  reason: PauseReason;
  by: string;
  ts: string; // ISO timestamp this flag was written
}

export interface PauseStatus {
  paused: boolean;
  reason?: PauseReason;
  until?: string | null;
  by?: string;
  ts?: string; // when this pause episode was written — lets a one-shot consumer (e.g. the watchdog's Escape-to-pane) dedup per episode
}

/** Legacy single-file path — read (not written) so a pause in force across an upgrade survives. */
export function pausePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'pause.json');
}
function operatorPausePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'operator-pause.json');
}
function autoPausePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'auto-pause.json');
}

/** Read a pause file. Returns null on missing/unreadable/corrupt — fail-open. */
function readFlagAt(p: string): PauseFlag | null {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as PauseFlag;
  } catch {
    return null;
  }
}

/** Resolve a flag to an active PauseStatus, applying reader-side expiry, or null if inactive/expired. */
function activeStatus(flag: PauseFlag | null): PauseStatus | null {
  if (!flag || flag.paused !== true) return null;
  if (flag.paused_until) {
    const until = new Date(flag.paused_until).getTime();
    if (!isNaN(until) && until <= Date.now()) return null; // lapsed snooze reads as unpaused
  }
  return { paused: true, reason: flag.reason, until: flag.paused_until, by: flag.by, ts: flag.ts };
}

/**
 * Resolve current pause status across the operator/auto/legacy files, applying
 * reader-side snooze expiry (a `paused_until` in the past reads as unpaused).
 * When more than one tier is active, the highest-priority reason wins.
 */
export function isPaused(stateDir: string): PauseStatus {
  const active: PauseStatus[] = [];
  for (const p of [operatorPausePath(stateDir), autoPausePath(stateDir), pausePath(stateDir)]) {
    const s = activeStatus(readFlagAt(p));
    if (s) active.push(s);
  }
  if (active.length === 0) return { paused: false };
  active.sort((a, b) => (PAUSE_PRIORITY[b.reason as PauseReason] ?? 0) - (PAUSE_PRIORITY[a.reason as PauseReason] ?? 0));
  return active[0];
}

/** Atomic write via tmp + rename (mirrors lib/alert-state.ts). */
function writeFlagAt(p: string, flag: PauseFlag): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(flag, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  } catch { /* fail-open */ }
}

/**
 * Set the pause flag. `until` omitted/null = indefinite pause. The reason picks
 * the target file: budget → auto-pause.json, operator/watchdog → operator-pause.json.
 * A budget write therefore can't touch an operator stop (that's the whole point).
 */
export function setPause(
  stateDir: string,
  opts: { reason: PauseReason; by: string; until?: string | null },
): void {
  const target = opts.reason === 'budget' ? autoPausePath(stateDir) : operatorPausePath(stateDir);
  writeFlagAt(target, {
    paused: true,
    paused_until: opts.until ?? null,
    reason: opts.reason,
    by: opts.by,
    ts: new Date().toISOString(),
  });
}

/** Clear the pause flag (resume). Removes every tier's file + the legacy one — absent means unpaused. */
export function clearPause(stateDir: string): void {
  for (const p of [operatorPausePath(stateDir), autoPausePath(stateDir), pausePath(stateDir)]) {
    try { fs.rmSync(p, { force: true }); } catch { /* fail-open */ }
  }
}

// Upper bound on a snooze (10 years). Well below the max representable Date
// offset (~8.64e15 ms), so `new Date(Date.now() + ms)` can never overflow to an
// Invalid Date whose .toISOString() throws. A snooze is a short hold; use `on`
// for an indefinite pause.
const MS_PER_DAY = 86400000;
const MAX_SNOOZE_MS = 10 * 365 * MS_PER_DAY;

/**
 * Parses a snooze duration ("30m", "2h", "1d") to milliseconds. Returns null on
 * anything unparseable, non-positive, or absurdly large — callers must
 * hard-reject, never silently fall back to a default (a mistyped duration must
 * never turn into an indefinite pause or a no-op). Rejecting zero/negative
 * stops a "0m" snooze from writing a paused_until that reader-side expiry
 * treats as unpaused on the next read (a confirmed-looking pause that never
 * pauses); the upper bound stops a huge duration from overflowing Date.
 */
export function parseSnoozeDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(String(s).trim());
  if (!m) return null;
  const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: MS_PER_DAY };
  const ms = Math.round(parseFloat(m[1]) * mult[m[2].toLowerCase()]);
  if (ms <= 0 || ms > MAX_SNOOZE_MS) return null;
  return ms;
}
