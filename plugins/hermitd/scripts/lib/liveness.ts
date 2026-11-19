/**
 * Shared cross-runtime liveness signal.
 *
 * The monitor subprocesses (routine-monitor.sh, heartbeat-monitor.sh) and the
 * resident write these files under the project state dir — which is
 * bind-mounted into the Docker container at the same path — and they die with
 * the claude process that spawned them. So a fresh mtime on any of them proves
 * *some* instance of this project is alive right now, readable identically from
 * the host or from inside the container, with no shared PID namespace required.
 * Files older than the current boot are ignored: no process survives a reboot.
 * Files older than this agent's last launch (`state/.boot-id`, stamped by
 * hermitd-start) are ignored too: a live instance keeps writing after a launch,
 * so only a dead session's leftovers fall below it.
 *
 * Asymmetry that matters: fresh proves alive; stale proves nothing. The routine
 * monitor writes every 60s, but heartbeat-liveness tracks `heartbeat.every`
 * (can be hours), so with routines
 * disabled or the Monitor tool unavailable an idle-but-alive instance reads
 * stale within minutes. Callers must treat a stale/absent signal as "unknown",
 * never "dead" — every guard keyed off this fails toward today's behavior.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A liveness signal older than this reads as "unknown", never "alive". */
export const LIVENESS_FRESH_SECS = 600;

const LIVENESS_FILES = [
  'state/routine-monitor-liveness.json',
  'state/heartbeat-liveness.json',
  'state/.heartbeat',
];

/** The later of the kernel boot and this agent's last launch. */
function launchFloorMs(hermitRoot: string): number {
  let launchMs = 0;
  try { launchMs = fs.statSync(path.join(hermitRoot, 'state/.boot-id')).mtimeMs; } catch {}
  return Math.max(Date.now() - os.uptime() * 1000, launchMs);
}

/** Age in seconds of the freshest liveness file written since the boot and launch floor, or null when none. */
export function sharedLivenessAgeSecs(
  hermitRoot = '.hermit',
  floorMs = launchFloorMs(hermitRoot),
): number | null {
  let best: number | null = null;
  for (const rel of LIVENESS_FILES) {
    try {
      const mtimeMs = fs.statSync(path.join(hermitRoot, rel)).mtimeMs;
      if (mtimeMs < floorMs) continue;
      const age = (Date.now() - mtimeMs) / 1000;
      if (best === null || age < best) best = age;
    } catch {}
  }
  return best;
}
