// `routines.ts health [hermit-dir] [--days N]` — the bounded routine-health digest.
//
// Exists because the derivations it owns used to live as prose in
// skills/reflect/reference.md, which had the model `tail` two unbounded JSONL
// ledgers and hand-count them. That broke both plugin rules at once: a skill must
// not read an unbounded surface directly, and the plugin's highest-stakes numeric
// logic had no test that did not involve an LLM. It also drifted — the prose summed
// a `cost` field filtered on `ts`, neither of which exists on a cost row.
//
// The skill keeps its intent-led half: this prints facts, the model decides whether
// they justify a disable/retime proposal.

import path from 'node:path';
import { hermitDir as resolveHermitDir, costLogPath } from '../cc-compat';
import { scanRoutineCostWindow } from '../cost-log';
import { emptyEntry, readRoutineHistory, type RoutineHistoryEntry } from './history';
import { exitError } from '../cli';

const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;

export type RoutineHealthRow = RoutineHistoryEntry & { cost_usd: number };

export type RoutineHealthReport = {
  window_days: number;
  since: string;
  as_of: string;
  /** Whether routine-metrics.jsonl could be read — an empty report is not "healthy". */
  source: 'ok' | 'missing' | 'unreadable';
  malformed_rows: number;
  routines: RoutineHealthRow[];
  /** Co-fire spend (`routine:multi`): real, but not attributable to one routine. */
  unattributable_multi_cost_usd: number;
};

export function buildRoutineHealth(
  hermit: string,
  days: number = DEFAULT_DAYS,
  asOf: Date = new Date(),
): RoutineHealthReport {
  const asOfMs = asOf.getTime();
  const sinceMs = asOfMs - days * 86400000;

  const history = readRoutineHistory(
    path.join(hermit, 'state', 'routine-metrics.jsonl'),
    days,
    asOf,
  );
  const { perRoutine, multi } = scanRoutineCostWindow(costLogPath(hermit), sinceMs, asOfMs);

  // Union of both sources: a routine billing cost with no ledger event in the
  // window is itself worth surfacing, not silently dropping.
  const ids = new Set<string>([...history.routines.map((r) => r.id), ...perRoutine.keys()]);
  const byId = new Map(history.routines.map((r) => [r.id, r]));
  const routines: RoutineHealthRow[] = [...ids].sort((a, b) => a.localeCompare(b)).map((id) => {
    const entry = byId.get(id) || emptyEntry(id);
    return { ...entry, cost_usd: round4(perRoutine.get(id) || 0) };
  });

  return {
    window_days: days,
    since: new Date(sinceMs).toISOString(),
    as_of: asOf.toISOString(),
    source: history.source,
    malformed_rows: history.malformed_rows,
    routines,
    unattributable_multi_cost_usd: round4(multi),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function run(args: string[]): void {
  let days = DEFAULT_DAYS;
  let dir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--days') {
      const parsed = Number(args[++i]);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DAYS) exitError('invalid_days');
      days = parsed;
    } else if (arg.startsWith('--')) {
      exitError();
    } else if (dir === null) {
      dir = arg;
    }
  }

  // A relative argv is NOT resolved against the process cwd: both documented
  // callers pass the relative `.hermit`, and a `cd` earlier in the
  // session would silently point that at a nonexistent ledger — `source:
  // missing`, which the skills read as "nothing to report". Same treatment as
  // weekly-review.ts's hermit arg.
  let hermit: string;
  try {
    hermit = dir && path.isAbsolute(dir) ? dir : resolveHermitDir();
  } catch {
    exitError('no_hermit_dir');
  }

  process.stdout.write(JSON.stringify(buildRoutineHealth(hermit, days), null, 2) + '\n');
}
