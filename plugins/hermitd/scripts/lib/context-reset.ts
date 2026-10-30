// Shared context-reset bookkeeping.
//
// Destroying a context (/clear) or shrinking it (/compact) is not just a keystroke:
// hermit-owned state has to be updated in the same breath or the hermit's own view
// of the world silently disagrees with reality. Before this lib the sequence lived
// only inside hermitd-watchdog.ts's private context reset tiers, so
// any other caller — notably an operator-initiated reset arriving over a channel —
// would have bypassed it.
//
// What stays OUT of here on purpose: the cost-log idempotence stamps
// (last_compacted_cost_ts / last_pane_hash_compact) and
// setHygieneEval. Those exist to stop a *threshold-triggered* reset re-firing against
// the same cost entry; a reset the operator asked for has no cost entry and no
// threshold, so they are the watchdog's business, not this lib's. Callers also own
// their own keystroke and event-log line, which legitimately differ per trigger.

import fs from 'node:fs';
import path from 'node:path';
import { writeRuntimeJson, readRuntimeJson, runtimeTmpPath } from './runtime';

type Json = any;

/**
 * Record WHEN the context was last reset, machine-readably.
 *
 * The watchdog uses this timestamp to know that a cost-log entry observed before it describes a
 * context that no longer exists. Every reset path records it — manual or native-auto
 * /compact through this function (precompact-stamp.ts), /clear through
 * applyContextReset's own write — because the watchdog's own last_compacted_at only
 * ever sees the resets it caused.
 *
 * Fresh read-modify-write against an absolute path: hooks don't share a cwd, and a
 * cached runtime object would clobber fields another process wrote meanwhile. Fail-open
 * and never fabricates a partial runtime.json (unrelated keys must survive).
 */
export function stampContextReset(hermitRoot: string): void {
  const stateDir = path.join(hermitRoot, 'state');
  const runtime = readRuntimeJson(stateDir);
  if (!runtime) return; // missing/unreadable/malformed — never fabricate a partial record
  runtime.last_context_reset_at = new Date().toISOString();
  try {
    // Not writeRuntimeJson: that stamps updated_at, and this runs from the PreCompact
    // hook, where refreshing the liveness marker would tell checkStaleRuntime the
    // runtime is fresh on the strength of a compaction alone.
    const tmpPath = runtimeTmpPath(stateDir);
    fs.writeFileSync(tmpPath, JSON.stringify(runtime, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, path.join(stateDir, 'runtime.json'));
  } catch { /* fail-open */ }
}

/**
 * Apply the hermit-owned bookkeeping that must accompany a context reset.
 *
 * The resident's SessionStart with source `clear` calls this once Claude Code has
 * cleared the context. PreCompact does not fire for /clear, so this path owns its
 * runtime reset timestamp.
 *
 * Fail-open throughout: a bookkeeping failure must never suppress the reset itself.
 */
export function applyContextReset(hermitRoot: string, runtime: Json): void {
  // Anchored to hermitRoot: writeRuntimeJson() otherwise resolves .hermit/state RELATIVE
  // TO THE CWD and mkdirs it, so a caller running anywhere but the project root would
  // write into a freshly created decoy state dir.
  try {
    runtime.last_context_reset_at = new Date().toISOString();
    writeRuntimeJson(runtime, path.join(hermitRoot, 'state'));
  } catch { /* fail-open */ }
}
