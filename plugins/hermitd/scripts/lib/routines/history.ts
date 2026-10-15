// state/routine-metrics.jsonl → an ordered per-routine attempt projection.
//
// The ledger records seven event kinds: `dispatched` (due.ts, at emit),
// `started` (precheck, at fire time),
// `fired` / `failed-<reason>` (finish — exactly one terminal per attempt),
// `skipped-*` (due.ts gates, which open no attempt at all), and `precheck-error`
// (a declared wake gate that could not answer, so the fire woke anyway — the one
// non-terminal row that means the opposite of a skip), and `chat-undelivered`
// (channel-send could not reach a routine's owning chat; only counted). Counting
// those independently — the `errored = started − fired` arithmetic this replaces — is
// wrong in three ways the fold below fixes:
//
//   - `finish` writes a terminal row with no preceding `started` when precheck
//     never stamped one (finish.ts's no-run-record branch), so a subtraction can
//     run negative and mask a real gap elsewhere.
//   - an attempt still open at the window edge is indistinguishable from a
//     crashed one under subtraction. Here it stays `open_attempt`, uncounted,
//     until a later event resolves it.
//   - an attempt straddling the window start belongs to its own attempt, not to
//     the window's counters.
//
// The fold is ordered per routine and carries attempt state across the window
// boundary; only in-window events increment counters.

import fs from 'node:fs';

export type RoutineHistoryEntry = {
  id: string;
  /** `fired` terminals in-window — what "how often did this run" means. */
  fires: number;
  /** `failed-<reason>` terminals in-window, keyed by bare reason. */
  failures: Record<string, number>;
  failure_total: number;
  /** Attempts provably abandoned: a `started` superseded by another `started`. */
  incomplete: number;
  /** Terminals that arrived with no attempt open — never invents a start. */
  orphan_terminals: number;
  /**
   * An attempt that opened *inside* the window was still open at its end (may
   * still be running). A `started` left dangling from before the window is not
   * reported: it is not evidence about this window, and surfacing it would put a
   * routine whose last activity predates the window by months into the digest.
   */
  open_attempt: boolean;
  /** `started` rows in-window: one per wake, whatever it went on to do. */
  starts: number;
  /** `skipped-*` rows: the routine was due but gated, so no attempt was made. */
  skips: number;
  /**
   * The `skipped-precheck` subset of `skips` — the only row that proves the wake
   * gate answered. Counted apart because the other `skipped-*` reasons (paused,
   * waiting) say nothing about whether the gate works.
   */
  precheck_skips: number;
  /**
   * `precheck-error` rows: the routine's declared wake gate could not answer, so
   * the fire woke the session anyway. Counted apart from `skips` because it is the
   * inverse signal — the operator declared a gate and is paying the wakes regardless.
   */
  precheck_errors: number;
  /** The most recent `precheck-error` detail in-window (timeout | exit:<n> | …). */
  last_precheck_error: { ts: string; detail: string } | null;
  /** `chat-undelivered` rows: a notice could not reach the routine's owning chat. */
  chat_undelivered: number;
  /** The most recent `chat-undelivered` detail in-window (`<chat>: <error>`). */
  last_chat_undelivered: { ts: string; detail: string } | null;
  last_fire: string | null;
  /** `dispatched` rows in-window: one per monitor emit, wrapper or not. */
  dispatches: number;
  /**
   * Dispatches superseded by another `dispatched` without a closer. Closers are
   * `started`, `fired`, `failed-*`, `skipped-waiting`, `skipped-paused`.
   * `skipped-precheck` and `precheck-error` do not close.
   */
  unhandled: number;
  /**
   * A dispatch that opened *inside* the window was still open at its end (the
   * session may still pick it up). A `dispatched` left dangling from before the
   * window is not reported: same tail rule as `open_attempt`.
   */
  unhandled_open: boolean;
};

export type RoutineHistory = {
  routines: RoutineHistoryEntry[];
  /** Rows that failed JSON.parse or lacked a usable ts/routine_id/event. */
  malformed_rows: number;
  source: 'ok' | 'missing' | 'unreadable';
};

type ParsedRow = { ts: number; tsRaw: string; id: string; event: string; seq: number; detail?: string };

/** A routine with no events yet. Also used by health.ts for a cost-only routine. */
export function emptyEntry(id: string): RoutineHistoryEntry {
  return {
    id,
    fires: 0,
    failures: {},
    failure_total: 0,
    incomplete: 0,
    orphan_terminals: 0,
    open_attempt: false,
    starts: 0,
    skips: 0,
    precheck_skips: 0,
    precheck_errors: 0,
    last_precheck_error: null,
    chat_undelivered: 0,
    last_chat_undelivered: null,
    last_fire: null,
    dispatches: 0,
    unhandled: 0,
    unhandled_open: false,
  };
}

/**
 * Parses ledger lines into time-ordered rows, counting anything unusable.
 *
 * Ties are common and load-bearing: `utcISOStamp()` truncates to whole seconds,
 * so a `started` and its `fired` routinely share a timestamp. Sorting on ts
 * alone would be free to swap them and turn a normal attempt into an orphan
 * terminal, so the original line order breaks every tie (Array#sort is stable,
 * and `seq` makes that explicit rather than implied).
 */
function parseRows(lines: string[]): { rows: ParsedRow[]; malformed: number } {
  const rows: ParsedRow[] = [];
  let malformed = 0;
  let seq = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    seq += 1;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!e || typeof e.routine_id !== 'string' || !e.routine_id
        || typeof e.event !== 'string' || !e.event || typeof e.ts !== 'string') {
      malformed += 1;
      continue;
    }
    const ts = Date.parse(e.ts);
    if (isNaN(ts)) {
      malformed += 1;
      continue;
    }
    rows.push({
      ts, tsRaw: e.ts, id: e.routine_id, event: e.event, seq,
      detail: typeof e.detail === 'string' ? e.detail : undefined,
    });
  }
  rows.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return { rows, malformed };
}

/** Folds already-read ledger lines. Exported for table tests; `readRoutineHistory` does the IO. */
export function foldRoutineHistory(
  lines: string[],
  sinceMs: number,
  asOfMs: number,
): Omit<RoutineHistory, 'source'> {
  const { rows, malformed } = parseRows(lines);
  const entries = new Map<string, RoutineHistoryEntry>();
  // routine id → ts of the attempt currently open, so the tail below can tell an
  // attempt that opened in-window from a `started` left dangling long before it.
  const open = new Map<string, number>();
  // Same shape as `open`, for a monitor emit the session has not yet picked up.
  const dispatchedOpen = new Map<string, number>();
  const touched = new Set<string>();

  const entryFor = (id: string): RoutineHistoryEntry => {
    let entry = entries.get(id);
    if (!entry) { entry = emptyEntry(id); entries.set(id, entry); }
    return entry;
  };

  for (const row of rows) {
    if (row.ts > asOfMs) continue;              // future rows: outside the window entirely
    const inWindow = row.ts >= sinceMs;
    const entry = entryFor(row.id);
    if (inWindow) touched.add(row.id);

    if (row.event === 'dispatched') {
      // A second `dispatched` with the previous still open means the session
      // never ran the wrapper for the first emit.
      if (dispatchedOpen.has(row.id) && inWindow) entry.unhandled += 1;
      if (inWindow) entry.dispatches += 1;
      dispatchedOpen.set(row.id, row.ts);
      continue;
    }

    if (row.event === 'started') {
      // A second `started` with the previous attempt still open means the first
      // one never reached `finish`. That is the signal the old subtraction was
      // reaching for, measured directly.
      if (open.has(row.id) && inWindow) entry.incomplete += 1;
      if (inWindow) entry.starts += 1;
      open.set(row.id, row.ts);
      dispatchedOpen.delete(row.id);
      continue;
    }

    const isFired = row.event === 'fired';
    const isFailure = row.event.startsWith('failed-');
    if (isFired || isFailure) {
      const wasOpen = open.has(row.id);
      open.delete(row.id);
      dispatchedOpen.delete(row.id);
      if (!inWindow) continue;
      if (!wasOpen) entry.orphan_terminals += 1;
      if (isFired) {
        entry.fires += 1;
        if (!entry.last_fire || row.tsRaw > entry.last_fire) entry.last_fire = row.tsRaw;
      } else {
        const reason = row.event.slice('failed-'.length) || 'unspecified';
        entry.failures[reason] = (entry.failures[reason] || 0) + 1;
        entry.failure_total += 1;
      }
      continue;
    }

    // `skipped-waiting` / `skipped-paused` consume a fire without a wake, so they
    // close a dangling dispatch. `skipped-precheck` and `precheck-error` do not:
    // a skip-precheck never emits, and a gate error is the inverse of a skip.
    if (row.event === 'skipped-waiting' || row.event === 'skipped-paused') {
      dispatchedOpen.delete(row.id);
    }

    // `skipped-*` and `precheck-error` (and any other event string the ledger
    // accepts — event.ts deliberately does not validate) open no attempt and close
    // none. A precheck error is not a skip: the routine woke anyway, which is
    // exactly what makes it worth surfacing.
    if (!inWindow) continue;
    if (row.event.startsWith('skipped-')) {
      entry.skips += 1;
      if (row.event === 'skipped-precheck') entry.precheck_skips += 1;
    } else if (row.event === 'precheck-error') {
      entry.precheck_errors += 1;
      entry.last_precheck_error = { ts: row.tsRaw, detail: row.detail || 'unspecified' };
    } else if (row.event === 'chat-undelivered') {
      entry.chat_undelivered += 1;
      entry.last_chat_undelivered = { ts: row.tsRaw, detail: row.detail || 'unspecified' };
    }
  }

  // Only an attempt that OPENED in-window is reported as open — see
  // RoutineHistoryEntry.open_attempt above for why a pre-window dangling `started`
  // is excluded.
  for (const [id, openedAt] of open) {
    if (openedAt < sinceMs) continue;
    entryFor(id).open_attempt = true;
    touched.add(id);
  }
  for (const [id, openedAt] of dispatchedOpen) {
    if (openedAt < sinceMs) continue;
    entryFor(id).unhandled_open = true;
    touched.add(id);
  }

  const routines = [...entries.values()]
    .filter((e) => touched.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { routines, malformed_rows: malformed };
}

function readLines(metricsPath: string): { lines: string[]; source: RoutineHistory['source'] } {
  if (!fs.existsSync(metricsPath)) return { lines: [], source: 'missing' };
  try {
    return { lines: fs.readFileSync(metricsPath, 'utf-8').split('\n'), source: 'ok' };
  } catch {
    return { lines: [], source: 'unreadable' };
  }
}

/** Reads the ledger and folds it over `[asOf - days, asOf]`. */
export function readRoutineHistory(
  metricsPath: string,
  days: number,
  asOf: Date = new Date(),
): RoutineHistory {
  const { lines, source } = readLines(metricsPath);
  const asOfMs = asOf.getTime();
  const sinceMs = asOfMs - days * 86400000;
  return { ...foldRoutineHistory(lines, sinceMs, asOfMs), source };
}

/**
 * Scans one routine's rows in file order, returning whatever `pick` last
 * yielded. Both lifetime lookups below want the newest row matching a
 * predicate, which is a different question from the windowed fold above — the
 * watchdog and the dedup guard ask "what happened most recently, ever", not
 * "what happened in the last N days".
 */
// `pick` returning undefined means "this row does not answer the question" and
// leaves the previous value standing; returning null clears it.
function lastMatching(
  metricsPath: string,
  routineId: string,
  pick: (e: any) => string | null | undefined,
): string | null {
  const { lines } = readLines(metricsPath);
  let last: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.routine_id === routineId) {
        const value = pick(e);
        if (value !== undefined) last = value;
      }
    } catch { /* skip corrupt lines */ }
  }
  return last;
}

/** Timestamp of the most recent `fired` for one routine, or null. */
export function lastRoutineFire(metricsPath: string, routineId: string): string | null {
  return lastMatching(metricsPath, routineId, (e) =>
    (e.event === 'fired' && typeof e.ts === 'string' ? e.ts : undefined));
}

/**
 * Raw `event` string of the routine's most recent row, or null. Drives
 * event.ts's fired-dedup guard (issue #464), whose invariant is specifically
 * "the latest same-routine event is already `fired`" — so unlike
 * lastRoutineFire this must see every event kind, not just terminals.
 */
export function lastRoutineEvent(metricsPath: string, routineId: string): string | null {
  return lastMatching(metricsPath, routineId, (e) => (typeof e.event === 'string' ? e.event : null));
}

/** Event and timestamp of the routine's most recent row, or null. */
export function lastRoutineEventWithTimestamp(metricsPath: string, routineId: string): string | null {
  return lastMatching(metricsPath, routineId, (e) =>
    (typeof e.event === 'string' ? `${e.event}@${typeof e.ts === 'string' ? e.ts : 'unknown'}` : null));
}
