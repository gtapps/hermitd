// `routines.ts log-event <routine-id> <event> [delivery]` — appends one line to
// state/routine-metrics.jsonl and prints `OK`. Events: dispatched | fired | skipped-waiting |
// skipped-paused | skipped-late | skipped-precheck | precheck-error | started. delivery:
// cron-create (default) | monitor. The monitor stamps `dispatched` at emit; the
// session still owns `started` and `fired`. `precheck-error` rows carry a
// `detail` field naming how the gate failed (timeout | exit:<code> | bad-verdict
// | spawn | a config reason) — see lib/routines/gate.ts; every other event
// omits the key.
//
// Ported from log-routine-event.sh, and still emitting the same four keys with
// the same UTC second-precision stamp. The row shape is pinned (tests assert it,
// and run-record.ts exists because of it), but only the shape — no consumer reads
// the serialized byte order any more. Cost attribution moved to the cost log's
// v2 rows, and the doctor's routine-cost check went with it.

import fs from 'node:fs';
import path from 'node:path';
import { utcISOStamp } from '../time';
import { appendJsonlLine } from '../append-jsonl';
import { lastRoutineEvent } from './history';
import { findHermitDir } from '../cc-compat';
import { emit, exitError } from '../cli';

// Only the CLI verb walks: a CronCreate prompt fires with cwd set to the
// session's primary working directory, which may be a subdirectory of the hermit
// project root. Two passes, both capped at 8 levels. In-process callers never
// reach here — they pass the hermit dir they already resolved.
//
// A hatched project (config.json) wins, so the walk goes PAST a config-less
// `.hermit/`. That does NOT single out a git worktree's partial copy:
// the copy carries config.json so skills can Read it at the relative path they
// expect. Discriminating the worktree
// case needs a sentinel the copy does not carry, and belongs in hermitDir()
// rather than here.
//
// A bare `.hermit/` still counts on the second pass, because
// config-less is a shipped state, not only a decoy: hatch scaffolds the tree
// (Step 2) before the wizard writes config.json (Step 5), and an aborted hatch
// can leave it that way indefinitely. Refusing there would drop the row silently
// — every caller discards the error string below — and a short ledger still reads
// `source: 'ok'` to routines/health.ts, turning a lost row into a false zero the
// model may act on. Falling back also keeps this consistent with hermitDir(),
// which fail-opens to the same dir when no config is found.
function nearestHermitDir(from: string): string | null {
  // Resolve once, up front: a relative `from` would give findHermitDir() a walk
  // that dies after one check (`path.dirname('.') === '.'`), silently demoting
  // the hatched-project preference to the second pass's nearest-dir behavior.
  const start = path.resolve(from);
  const hatched = findHermitDir(start);
  if (hatched) return hatched;
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.hermit');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Appends one routine event. Returns null on success, or an error message.
 *
 * `hermitRoot` is the resolved `.hermit/` directory, not a project
 * root to search from. The in-process callers (due.ts, precheck.ts, finish.ts)
 * each already hold one — from hermitDir() or, for the monitor, from argv — and
 * used to hand over its parent so this function could walk back down. That round
 * trip could only lose information: once the walk gained a config.json sentinel
 * the two resolvers could disagree and land in a different project, and in
 * finish.ts it split the run record and the ledger row across two roots.
 */
export function logRoutineEvent(
  id: string,
  event: string,
  hermitRoot: string,
  delivery = 'cron-create',
  detail?: string,
): string | null {
  const metrics = path.join(hermitRoot, 'state', 'routine-metrics.jsonl');

  // Dedup guard (issue #464): heartbeat-restart re-invokes `hermit-routines
  // load` at its own prompt tail, which can re-trigger the cron and emit a
  // second `fired` with no intervening `started`. The prompt always logs
  // `started` immediately before `fired`, so a `fired` whose latest same-routine
  // event is already `fired` can only be the spurious re-trigger.
  // A missing or unreadable ledger reads as "no prior event", so nothing is
  // suppressed — same fail-open behavior as the inline scan this replaced.
  if (event === 'fired' && lastRoutineEvent(metrics, id) === 'fired') return null;

  // appendFileSync throws when the resolved dir has no state/ (a scaffolded-but-
  // unfinished hatch, a worktree's partial copy). Return that as the documented
  // error string rather than letting it escape — `run()` below does not catch,
  // so a throw here surfaces as a stack trace instead of one error object.
  try {
    return appendJsonlLine(
      metrics,
      // `detail` is omitted rather than nulled when absent: every existing reader
      // parses whole rows, and an extra always-present key would churn the shape
      // for the events that have nothing to say.
      JSON.stringify(
        detail === undefined
          ? { ts: utcISOStamp(), routine_id: id, event, delivery }
          : { ts: utcISOStamp(), routine_id: id, event, delivery, detail },
      ),
    );
  } catch (err: any) {
    return `could not append to ${metrics}: ${err?.message ?? err}`;
  }
}

export function run(args: string[]): void {
  const [id, event, delivery] = args;
  if (!id || !event) exitError();
  const hermit = nearestHermitDir(process.cwd());
  if (!hermit) exitError('no_hermit_dir');
  if (logRoutineEvent(id, event, hermit, delivery || 'cron-create')) exitError('append_failed');
  emit('OK');
}
