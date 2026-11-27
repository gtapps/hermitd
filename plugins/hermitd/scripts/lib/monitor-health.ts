import { readJson } from './cli';

export type MonitorFreshnessReason =
  | 'fresh'
  | 'stale'
  | 'warming-up'
  | 'liveness-absent'
  | 'liveness-predates-start'
  | 'unregistered';

export type MonitorFreshness = {
  fresh: boolean;
  reason: MonitorFreshnessReason;
};

/** The spawn grace both monitor legs allow before an absent first tick is a fault. */
export const STARTUP_GRACE_SECS = 120;

/**
 * How long a tick that predates `started_at` stays tolerable, for a leg whose poll
 * interval outruns the spawn grace. A monitor writes its first tick before the commit
 * that records `started_at`, so that tick reads untrusted until the next one lands —
 * which for the heartbeat leg is a whole interval away. Waiting it out is what keeps a
 * healthy monitor from reading dead (#909); the spawn grace is untouched, so a monitor
 * that never ticked at all is still caught in 2 minutes.
 */
export function heartbeatPredatesGraceSecs(intervalSecs: number): number {
  return Math.max(STARTUP_GRACE_SECS, intervalSecs + 60);
}

/**
 * Evaluate monitor liveness from caller-supplied values only.
 *
 * A tick is trusted when it belongs to the current registration. A registered
 * monitor without a trusted tick remains fresh only during its startup grace.
 * An unregistered monitor is not stale: registration belongs to the arming flow.
 *
 * The two untrusted cases get separate graces because they mean different things: no
 * tick at all is a subprocess that never spawned, while a tick older than `started_at`
 * is a monitor that ticked before the commit recorded it. `predatesGraceSecs` defaults
 * to `graceSecs`, so a caller that does not distinguish them behaves as before.
 */
export function monitorFreshness(
  startedAt: string | null,
  lastPeekAt: string | null,
  thresholdSecs: number,
  graceSecs: number,
  nowMs: number,
  predatesGraceSecs: number = graceSecs,
): MonitorFreshness {
  const startedAtMs = startedAt === null ? NaN : Date.parse(startedAt);
  const lastPeekAtMs = lastPeekAt === null ? NaN : Date.parse(lastPeekAt);
  const hasStart = Number.isFinite(startedAtMs);
  const hasPeek = Number.isFinite(lastPeekAtMs);
  const trusted = hasPeek && (!hasStart || lastPeekAtMs >= startedAtMs);

  if (trusted) {
    return nowMs - lastPeekAtMs > thresholdSecs * 1000
      ? { fresh: false, reason: 'stale' }
      : { fresh: true, reason: 'fresh' };
  }

  if (!hasStart) return { fresh: true, reason: 'unregistered' };
  if (nowMs - startedAtMs < (hasPeek ? predatesGraceSecs : graceSecs) * 1000) {
    return { fresh: true, reason: 'warming-up' };
  }
  return {
    fresh: false,
    reason: hasPeek ? 'liveness-predates-start' : 'liveness-absent',
  };
}

/**
 * Wait up to 10s (HERMIT_FIRST_TICK_WAIT_MS overrides) for a just-registered monitor to write its first liveness tick.
 * Both arming legs (`routines.ts arm commit`, `heartbeat.ts start-commit`) ask the
 * same question — did the subprocess actually spawn? — and both delete the previous
 * record first, so any file that appears here belongs to the registration under test.
 * A healthy monitor writes liveness on its first loop iteration, before any sleep.
 */
export async function waitForFirstTick(livenessFile: string): Promise<boolean> {
  const deadline = Date.now() + (Number(process.env.HERMIT_FIRST_TICK_WAIT_MS) || 10_000);
  while (Date.now() <= deadline) {
    if (typeof readJson(livenessFile)?.last_peek_at === 'string') return true;
    await Bun.sleep(100);
  }
  return false;
}

/**
 * Does a runtime registration belong to a previous boot? A Monitor dies with the
 * session that registered it, and its last liveness tick is at most one interval
 * (heartbeat) or one 60s poll (routines) old when that happens — well inside either
 * leg's freshness window. So liveness alone reads a just-dead registration as "alive"
 * until that window expires. The boot marker is the only thing that proves a
 * registration belongs to THIS process. Both ids must be present to conclude
 * anything: a record written before this field existed, or a hermit with no
 * `.boot-id`, falls through to the plain freshness check instead.
 */
export function bootMismatch(runtimeBootId: unknown, currentBootId: string | null): boolean {
  return typeof runtimeBootId === 'string' && typeof currentBootId === 'string' && runtimeBootId !== currentBootId;
}
