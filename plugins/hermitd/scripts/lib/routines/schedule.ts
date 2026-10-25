// Routine schedule cursors: state/routine-schedule.json, keyed by routine id,
// shaped { "<id>": { "last_consumed_mark": "<ISO minute>", "held_at"?: "<ISO minute>" } }.

import path from 'node:path';
import { readJson } from '../cli';
import { writeFileAtomic } from '../md-write';

/**
 * Move cursors to renamed routine ids so a fire missed during a restart catches up
 * under the new id instead of starting fresh. Best effort: a failure leaves the
 * cursors to the monitor, whose next write may overwrite this mid-tick, which only
 * costs the catch-up.
 */
export function renameCursors(hermitDir: string, renamed: Array<{ from: string; to: string }>): void {
  const file = path.join(hermitDir, 'state', 'routine-schedule.json');
  const schedule = readJson(file);
  if (!schedule || typeof schedule !== 'object') return;
  let changed = false;
  for (const { from, to } of renamed) {
    if (!Object.hasOwn(schedule, from) || Object.hasOwn(schedule, to)) continue;
    schedule[to] = schedule[from];
    delete schedule[from];
    changed = true;
  }
  if (!changed) return;
  try {
    writeFileAtomic(file, JSON.stringify(schedule, null, 2) + '\n');
  } catch {}
}
