// The one graceful-shutdown sequence shared by host stop, Docker down and the container
// entrypoint: wait for the running turn, queue the configured shutdown skill for the core
// mod, and wait for the turn that skill started to settle.
import path from 'node:path';
import { readJson } from './cli';
import { readSettledConfig } from './config-read';
import { enqueue, failedLeg, legReason, parseSkill, readOutcome, type LegStatus } from './harness-mod';
import { writeFileAtomic } from './md-write';
import { readRuntimeJson, writeRuntimeJson } from './runtime';
import { readExecution } from './tasks';
import { localISOStamp } from './time';

export type ShutdownResult = {
  status: 'settled' | 'timeout';
  skill: LegStatus | 'none';
  reason?: string;
  text?: string;
};
type Options = { timeoutSecs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };

const OPERATION_FILE = 'shutdown-operation.json';

/** Execution has settled, and (when given) settled after `after`. */
export function shutdownReady(execution: any, after: number | null): boolean {
  return typeof execution?.state === 'string' && execution.state !== 'in_flight'
    && (after === null || Date.parse(execution.at) > after);
}

export async function gracefulShutdown(dir: string, options: Options = {}): Promise<ShutdownResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const poll = options.pollMs ?? 1000;
  const deadline = now() + (options.timeoutSecs ?? 60) * 1000;
  const stateDir = path.join(dir, 'state');
  const execution = () => readExecution(dir);
  const waitFor = async (done: () => boolean) => {
    while (!done()) {
      if (now() >= deadline) return false;
      await sleep(Math.min(poll, Math.max(0, deadline - now())));
    }
    return true;
  };

  const runtime = readRuntimeJson(stateDir) ?? {};
  if (!runtime.shutdown_requested_at) writeRuntimeJson({ ...runtime, shutdown_requested_at: localISOStamp() }, stateDir);

  // One operation per resident session: a second caller (SIGTERM after a Docker down)
  // waits on the first one's request instead of running the skill again.
  const operationFile = path.join(stateDir, OPERATION_FILE);
  const previous = readJson(operationFile);
  let id: string | null = previous && previous.session_id === runtime.cc_session_id && typeof previous.id === 'string' ? previous.id : null;

  if (!id) {
    if (!(await waitFor(() => shutdownReady(execution(), null)))) return { status: 'timeout', skill: 'none', reason: 'execution_not_settled' };
    const skill = readSettledConfig(dir).shutdown_skill;
    if (typeof skill !== 'string' || !skill.trim()) return { status: 'settled', skill: 'none' };
    let queued;
    try {
      queued = enqueue(dir, { source: 'stop', purpose: 'stop', commands: [parseSkill(skill)] });
    } catch {
      return { status: 'settled', skill: 'failed', reason: 'invalid_shutdown_skill' };
    }
    // A skipped or failed skill counts as done: shutdown still proceeds.
    if (queued.status !== 'queued') return { status: 'settled', skill: 'skipped', reason: queued.reason };
    id = queued.id;
    writeFileAtomic(operationFile, JSON.stringify({ session_id: runtime.cc_session_id ?? null, id }) + '\n');
  }

  const requestId = id;
  if (!(await waitFor(() => readOutcome(dir, requestId) !== null))) return { status: 'timeout', skill: 'unknown', reason: 'skill_not_run' };
  const outcome = readOutcome(dir, requestId)!;
  const failed = failedLeg(outcome);
  if (failed) return { status: 'settled', skill: failed.status, reason: legReason(failed), ...(failed.text ? { text: failed.text } : {}) };
  // Only the turn the skill started counts: an unrelated turn that settled before it ran does not.
  const submitted = Date.parse(outcome.legs.at(-1)?.submitted_at ?? '');
  const after = Number.isFinite(submitted) ? submitted : null;
  if (!(await waitFor(() => shutdownReady(execution(), after)))) return { status: 'timeout', skill: 'ok', reason: 'skill_turn_not_settled' };
  return { status: 'settled', skill: 'ok' };
}
