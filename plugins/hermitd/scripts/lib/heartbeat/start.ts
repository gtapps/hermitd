// Deterministic heartbeat activation, registration, interval and stop commands.
// The skill invokes the native activation skill between start-check and start-commit.

import fs from 'node:fs';
import path from 'node:path';
import { emitJson, printJson, readJson, snakeToken } from '../cli';
import { readConfigRaw } from '../config-read';
import { isGuest } from '../guest-marker';
import { pidAlive } from '../lockfile';
import { bootMismatch, waitForFirstTick } from '../monitor-health';
import { readBootId } from '../routines/registry';
import { resolveHermitNowMs } from '../time';
import { hasStartedRegistration, heartbeatCommand, heartbeatHealth, heartbeatInterval } from './monitor-cmd';

type Json = any;

function writeJson(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const runtimePath = (hermitDir: string) =>
  path.join(hermitDir, 'state', 'heartbeat-monitor.runtime.json');
const livenessPath = (hermitDir: string) =>
  path.join(hermitDir, 'state', 'heartbeat-liveness.json');

/** The native skill that activates a planned Monitor registration. */
export const MONITOR_ACTIVATE = '/hermitd:monitor-activate';

/** Verdicts shared by `heartbeat start-check` and `routines arm begin`. */
export const GUEST_VERDICT = Object.freeze({ status: 'guest', reason: 'native_monitors_resident_only' });
export const COMMAND_DRIFT_VERDICT = Object.freeze({ status: 'restart_required', reason: 'command_drift' });

/** The heartbeat leg's registration plan. Every planned arm also needs activation. */
export type HeartbeatArmPlan = { first_start?: true; interval: number };

/**
 * Side effects and plan for one heartbeat re-arm. Shared by `start-check` and by
 * `routines.ts arm begin`, which nests it under `heartbeat`: so the two callers can
 * never drift into planning different registrations.
 */
export function prepareHeartbeatArm(hermitDir: string, config: Json): HeartbeatArmPlan {
  const bootId = readBootId(hermitDir);
  writeJson(path.join(hermitDir, 'state', 'heartbeat-monitor.control.json'), config?.heartbeat?.enabled === false
    ? { mode: 'forced', boot_id: bootId }
    : { mode: 'auto' });
  const runtime = readJson(runtimePath(hermitDir));
  // Same reason as the routine leg: the commit waits for a liveness file to
  // appear, so the outgoing monitor's last tick has to go before the new one spawns
  // — otherwise a monitor blocked by seccomp reads as alive, and the doctor flags
  // stale data from the prior session during the startup window.
  if (runtime?.launch !== 'native' || bootMismatch(runtime.boot_id, bootId)) {
    try { fs.rmSync(livenessPath(hermitDir), { force: true }); } catch {}
  }

  const interval = heartbeatInterval(config);
  return hasStartedRegistration(runtime) ? { interval } : { first_start: true, interval };
}

export type HeartbeatCommit =
  | { status: 'registered'; interval: number }
  | { status: 'dead'; reason: 'liveness_absent' };

/**
 * Records a heartbeat Monitor registration: waits for the first liveness tick,
 * writes `state/heartbeat-monitor.runtime.json` and returns the result for the caller to print. This module stays the
 * sole writer of that runtime file — `arm commit --heartbeat` calls in here rather
 * than writing it itself.
 */
export async function commitHeartbeatArm(
  hermitDir: string,
  config: Json,
  taskId: string,
): Promise<HeartbeatCommit> {
  const interval = heartbeatInterval(config);
  const nowMs = resolveHermitNowMs();
  const liveness = readJson(livenessPath(hermitDir));
  const live = (typeof liveness?.pid === 'number' && pidAlive(liveness.pid))
    || await waitForFirstTick(livenessPath(hermitDir));

  // The monitor's first tick lands before this commit, so started_at postdates it and
  // readers see it untrusted. That is what the predates-grace in monitorFreshness rides
  // out — adopting the tick instead cannot work, because no timestamp proves which
  // process wrote it, and the outgoing monitor is still alive when the arm is planned.
  // Written even on the dead path below: without a started_at the readers report
  // `unregistered`, which counts as fresh, and doctor would call a spawn-blocked
  // monitor "warming up" forever.
  writeJson(runtimePath(hermitDir), {
    description: 'heartbeat-monitor',
    launch: 'native',
    command: heartbeatCommand(hermitDir, config),
    interval,
    started_at: new Date(nowMs).toISOString(),
    boot_id: readBootId(hermitDir),
  });

  if (!live) return { status: 'dead', reason: 'liveness_absent' };
  return { status: 'registered', interval };
}

function cmdCheck(hermitDir: string, config: Json): void {
  const health = heartbeatHealth(hermitDir, config, resolveHermitNowMs());
  if (health.reason === 'restart-required') {
    printJson(COMMAND_DRIFT_VERDICT);
    return;
  }
  // `disabled` is healthy to the daily anchor, which must leave a deliberately-off
  // heartbeat alone. Reaching `start` at all is an explicit act, so re-arm instead.
  if (health.healthy && health.reason !== 'disabled') {
    printJson({ status: 'fresh', interval: heartbeatInterval(config) });
    return;
  }
  const plan = prepareHeartbeatArm(hermitDir, config);
  printJson({ status: 'rearm', reason: snakeToken(health.reason), ...plan, activate: MONITOR_ACTIVATE });
}

async function cmdCommit(hermitDir: string, config: Json, taskId: string): Promise<void> {
  printJson(await commitHeartbeatArm(hermitDir, config, taskId));
}

export async function run(verb: string, args: string[]): Promise<void> {
  const hermitDir = args[0] ? path.resolve(args[0]) : null;
  if (!hermitDir) {
    // heartbeat-monitor.sh always passes its dir and falls back to 1800 on any
    // non-integer `interval` output, so a usage error here is a real failure.
    emitJson({ error: 'usage' });
  }
  const config = readConfigRaw(hermitDir) ?? {};
  const sessionIndex = args.indexOf('--session-id');
  if (verb === 'start-check' && isGuest(path.join(hermitDir, 'state'), sessionIndex < 0 ? null : args[sessionIndex + 1])) {
    printJson(GUEST_VERDICT);
    return;
  }
  if (verb === 'interval') process.stdout.write(`${heartbeatInterval(config)}\n`);
  else if (verb === 'stop') {
    writeJson(path.join(hermitDir, 'state', 'heartbeat-monitor.control.json'), { mode: 'stopped' });
    writeJson(runtimePath(hermitDir), {});
    fs.rmSync(livenessPath(hermitDir), { force: true });
  }
  else if (verb === 'start-check') cmdCheck(hermitDir, config);
  else await cmdCommit(hermitDir, config, args[1] ?? '');
}
