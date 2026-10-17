// The heartbeat monitor's registration identity, in one place.
//
// Two callers judge whether the live heartbeat monitor is the one the config
// currently describes: `routines.ts arm anchor` (deciding whether the daily
// re-arm has anything to do) and `heartbeat.ts start-check` (deciding whether to
// re-register at all). The plugin root is module-owned so they agree
// byte-for-byte: a caller-supplied root is a second definition of "healthy",
// and the two drift the first time a path is a symlink.

import path from 'node:path';
import { readJson } from '../cli';
import { pidAlive } from '../lockfile';
import { bootMismatch, heartbeatPredatesGraceSecs, monitorFreshness, STARTUP_GRACE_SECS } from '../monitor-health';
import { readBootId } from '../routines/registry';
import { parseDuration } from '../time';

type Json = any;

// Re-exported so `routines.ts arm` keeps importing the grace from the heartbeat leg it
// judges; the constant lives in monitor-health.ts because the predates-grace helper
// there needs it, and this module already imports from that one.
export { STARTUP_GRACE_SECS };

export type LegHealth = { healthy: boolean; reason: string };

/**
 * Has this registration confirmed a first tick? `stop` clears the runtime file to
 * `{}`, which is not a registration. `heartbeatHealth` (`runtime-missing`) and
 * `start-check` (`first_start`) must agree on this.
 */
export function hasStartedRegistration(runtime: Json): boolean {
  return !!runtime && typeof runtime.started_at === 'string';
}

/**
 * Namespace a freshness reason to its monitor leg. Some of the predicate's own
 * reasons (`liveness-absent`, `liveness-predates-start`) already carry the prefix;
 * adding a second one produced `liveness-liveness-absent`.
 */
export function livenessReason(reason: string): string {
  return reason.startsWith('liveness-') ? reason : `liveness-${reason}`;
}

/**
 * Command drift under a live supervisor cannot be re-armed: the arming verbs answer
 * restart_required, so every consumer reads `restart-required` instead of re-checking.
 */
export function commandDriftReason(hermitDir: string, livenessFile: string): string {
  const live = readJson(path.join(hermitDir, 'state', livenessFile));
  return typeof live?.pid === 'number' && pidAlive(live.pid) ? 'restart-required' : 'command-drift';
}

/** Poll interval in whole seconds, floored at 1 so a `0m` config can't spin. */
export function heartbeatInterval(config: Json): number {
  return Math.max(1, Math.round(parseDuration(config?.heartbeat?.every, 30 * 60_000) / 1000));
}

export const PLUGIN_ROOT = path.resolve(import.meta.dir, '../../..');

export function heartbeatCommand(hermitDir: string, config: Json): string {
  return `bash "${PLUGIN_ROOT}"/scripts/monitor-supervisor.sh heartbeat "${hermitDir}"`;
}

/**
 * Does a registered monitor command match the one this checkout would register?
 * Claude Code can cache one release as both `<ver>` and `<ver>-<sha12>`, and a
 * session may run skills from either copy, so the root's hash suffix is ignored
 * when only one side carries it. Two different suffixes are two different builds.
 */
const SHA_SUFFIX = /-[0-9a-f]{12}(?="\/scripts\/)/;
export function sameMonitorCommand(registered: unknown, expected: string): boolean {
  if (typeof registered !== 'string') return false;
  if (registered === expected) return true;
  return SHA_SUFFIX.test(registered) !== SHA_SUFFIX.test(expected)
    && registered.replace(SHA_SUFFIX, '') === expected.replace(SHA_SUFFIX, '');
}

/**
 * Is the registered heartbeat monitor current and ticking? `disabled` is reported
 * healthy so the daily anchor leaves a deliberately-off heartbeat alone; `start`
 * is an explicit operator act and treats that reason as a re-arm instead.
 */
export function heartbeatHealth(hermitDir: string, config: Json, nowMs: number): LegHealth {
  if (config?.heartbeat?.enabled === false) return { healthy: true, reason: 'disabled' };
  const runtime = readJson(path.join(hermitDir, 'state', 'heartbeat-monitor.runtime.json'));
  if (!hasStartedRegistration(runtime)) return { healthy: false, reason: 'runtime-missing' };
  if (bootMismatch(runtime.boot_id, readBootId(hermitDir))) {
    return { healthy: false, reason: 'boot-mismatch' };
  }
  const interval = heartbeatInterval(config);
  if (runtime.interval !== interval) return { healthy: false, reason: 'interval-drift' };
  if (!sameMonitorCommand(runtime.command, heartbeatCommand(hermitDir, config)) || runtime.launch !== 'native') {
    return { healthy: false, reason: commandDriftReason(hermitDir, 'heartbeat-liveness.json') };
  }
  const live = readJson(path.join(hermitDir, 'state', 'heartbeat-liveness.json'));
  const freshness = monitorFreshness(
    typeof runtime.started_at === 'string' ? runtime.started_at : null,
    typeof live?.last_peek_at === 'string' ? live.last_peek_at : null,
    3 * interval,
    STARTUP_GRACE_SECS,
    nowMs,
    // The live monitor's cadence, not config's: `every` can be edited without re-running
    // `start`, and judging the running loop against the new value is the drift this
    // grace exists to ride out.
    heartbeatPredatesGraceSecs(
      typeof runtime.interval === 'number' && runtime.interval > 0 ? runtime.interval : interval,
    ),
  );
  // `unregistered` means no started_at to trust the tick against — fresh by the
  // predicate's lights, but not evidence THIS registration is alive.
  if (freshness.fresh && freshness.reason !== 'unregistered') {
    return { healthy: true, reason: freshness.reason };
  }
  return { healthy: false, reason: livenessReason(freshness.reason) };
}
