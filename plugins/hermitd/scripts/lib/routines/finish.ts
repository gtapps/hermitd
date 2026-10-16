// `routines.ts finish <routine-id> [delivery] [--outcome-stdin]` — the single
// owner of a routine fire's terminal ledger row. Called unconditionally after the
// skill is invoked, replacing the old `log-event <id> fired`.
//
// With --outcome-stdin the dispatcher drains supplied outcome text.
// Finish records only the terminal ledger verdict, without a journal write.
//
// Why a finalizer instead of a verify-then-branch: the old contract asked the
// model to decide which event to log, so a fire's success was recorded from the
// dispatched subagent's self-report. This script decides, so the ledger reflects
// what is on disk. Same idiom as reflect-precheck.ts owning its own audit trail.
//
// Output (stdout, one JSON line):
//   {"status":"fired"}
//   {"status":"failed","reason":"artifact_missing","detail":"<path>"}
//   {"status":"failed","reason":"artifact_unchanged","detail":"<path>"}
//   {"status":"failed","reason":"verification_error","detail":"<detail>"}
//
// The failure reason is encoded in the event string (failed-artifact-missing, …)
// rather than a separate column, because routine-metrics.jsonl's row shape is
// pinned to four keys. lib/routines/history.ts folds these into typed per-reason
// failure counts, so a contract miss reads as its own outcome rather than as an
// unexplained gap.
//
// Fail-closed on declared contracts, fail-open otherwise: a routine with no
// artifact contract keeps the legacy unconditional `fired`, while a routine that
// declared one never records success on a verification error — falling open
// there would recreate the exact false-green this exists to prevent.

import path from 'node:path';
import { hermitDir } from '../cc-compat';
import { emitJson, snakeToken } from '../cli';
import { readConfigRaw } from '../config-read';
import { logRoutineEvent } from './event';
import { readRunRecord, markOutcome, statIdentity, identityChanged } from './run-record';

type Json = any;

const OUTCOME_FLAG = '--outcome-stdin';

/**
 * The single exit path: emits `fired`, or a failure reason (as markOutcome records
 * it) with its detail. A function declaration, not an arrow: TS only uses a `never`
 * return for control-flow narrowing when the callee is a declared name.
 */
function report(outcome: string, detail?: string): never {
  return emitJson(outcome === 'fired' ? { status: 'fired' } : { status: 'failed', reason: snakeToken(outcome), detail });
}

/** true/false when config is readable, null when it is not (caller falls back to the run record). */
function declaresContract(hermit: string, id: string): boolean | null {
  // Raw, not settled: "config unreadable" (null) must stay distinct from
  // "routine declares no contract" (false) — see the caller's comment.
  const config: Json = readConfigRaw(hermit);
  if (!config || !Array.isArray(config.routines)) return null;
  const entry = config.routines.find((r: Json) => r && r.id === id);
  return !!(entry && typeof entry.expect_artifact === 'string' && entry.expect_artifact.trim());
}

export function run(args: string[], outcome = ''): void {
  // The dispatcher already consumed the flag's stdin; strip it here so it can
  // never be taken as the delivery positional (the ledger accepts any string).
  const [id, deliveryArg] = args.filter(arg => arg !== OUTCOME_FLAG);
  const delivery = deliveryArg || 'cron-create';
  if (!id) {
    emitJson({ error: 'usage' });
  }

  let hermit: string;
  try {
    hermit = hermitDir();
  } catch {
    // Nothing to verify against and nowhere to log — never claim success.
    report('verification-error', 'hermit dir unresolvable');
  }

  const stamp = (event: string): void => {
    try {
      logRoutineEvent(id, event, hermit, delivery);
    } catch { /* a stamp failure must not crash the fire path */ }
  };

  /** Writes the terminal row, records the outcome for replay, and emits. */
  const terminal = (outcome: string, detail: string): never => {
    stamp(outcome === 'fired' ? 'fired' : `failed-${outcome}`);
    markOutcome(hermit, id, outcome);
    return report(outcome, detail);
  };

  const declared = declaresContract(hermit, id);

  // Config says this routine has no contract, so any record on disk is a leftover
  // from a fire made under an older config. Ignore it: replaying its `outcome`
  // would suppress this routine's terminal row on every future fire, leaving an
  // unbounded run of `started` rows and re-emitting a stale `failed` verdict the
  // skill escalates to the operator. Config unreadable (`null`) is not proof of
  // absence, so a record still applies there.
  const record = declared === false ? null : readRunRecord(hermit, id);

  // Already finalized — a re-triggered fire (the #464 case documented in
  // event.ts). Report the recorded outcome; write no second terminal row.
  if (record?.outcome) {
    return report(record.outcome, record.resolved_path);
  }

  if (!record) {
    // No run record. If config is readable and this routine declared a contract,
    // precheck failed to write one — that is a verification error, not a success.
    // If config is unreadable we cannot tell, so keep legacy behavior rather than
    // holding every routine hostage to a transient read failure.
    if (declared === true) {
      stamp('failed-verification-error');
      return report('verification-error', 'no run record for a declared contract');
    }
    stamp('fired');
    return report('fired');
  }

  const current = statIdentity(path.join(hermit, record.resolved_path));
  if (!current) return terminal('artifact-missing', record.resolved_path);
  if (!identityChanged(record.baseline, current)) return terminal('artifact-unchanged', record.resolved_path);
  return terminal('fired', record.resolved_path);
}
