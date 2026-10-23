// Deterministic owner of routine/heartbeat arming decisions and durable mirrors.
// Tool ownership stays in the skill: this module plans Monitor, TaskStop and Cron*
// calls, but never attempts to perform them itself.

import fs from 'node:fs';
import path from 'node:path';
import { failJson, printJson, readJson, snakeToken } from '../cli';
import { readConfigRaw } from '../config-read';
import { isGuest } from '../guest-marker';
import { pidAlive } from '../lockfile';
import { commandDriftReason, heartbeatHealth, PLUGIN_ROOT, livenessReason, sameMonitorCommand, STARTUP_GRACE_SECS, type LegHealth } from '../heartbeat/monitor-cmd';
import { COMMAND_DRIFT_VERDICT, commitHeartbeatArm, GUEST_VERDICT, MONITOR_ACTIVATE, prepareHeartbeatArm, type HeartbeatCommit } from '../heartbeat/start';
import { bootMismatch, monitorFreshness, waitForFirstTick } from '../monitor-health';
import { isPaused } from '../pause';
import { resolveHermitNowMs } from '../time';
import { logRoutineEvent } from './event';
import { lastRoutineFire } from './history';
import {
  commitCron,
  computeWakeSpread,
  filterRoutinesByIds,
  planCron,
  readBootId,
  readMirror,
  type Mirror,
  type PlanResult,
} from './registry';

type Json = any;

const ANCHOR_ID = 'hermitd:heartbeat-restart';
const MONITOR_INTERVAL_SECS = 60;
const ANCHOR_MAX_AGE_MS = 26 * 60 * 60 * 1000;

type Context = {
  hermitDir: string;
  pluginRoot: string;
  config: Json;
  routines: Json[];
  scheduled: Json[];
  mirrorPath: string;
  mirror: Mirror;
  bootId: string | null;
  nowMs: number;
};

function writeJson(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function context(hermitDirArg: string, pluginRootArg: string): Context {
  const hermitDir = path.resolve(hermitDirArg);
  const pluginRoot = path.resolve(pluginRootArg);
  const config = readConfigRaw(hermitDir);
  if (config === null) throw new Error('config.json unreadable');
  const routines = Array.isArray(config.routines) ? config.routines : [];
  const scheduled = routines.filter((r: Json) => r?.enabled === true && r.id !== ANCHOR_ID);
  const mirrorPath = path.join(hermitDir, 'state', 'cron-registry.json');
  return {
    hermitDir,
    pluginRoot,
    config,
    routines,
    scheduled,
    mirrorPath,
    mirror: readMirror(mirrorPath),
    bootId: readBootId(hermitDir),
    nowMs: resolveHermitNowMs(),
  };
}

export function routineCommand(hermitDir: string): string {
  return `bash "${PLUGIN_ROOT}"/scripts/monitor-supervisor.sh routines "${hermitDir}"`;
}

function plan(ctx: Context, fallback: boolean, reset: boolean): { plan: PlanResult; routines: Json[] } {
  const routines = fallback ? ctx.routines : filterRoutinesByIds(ctx.routines, ANCHOR_ID);
  let machineTz: string | null = null;
  try { machineTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  return {
    routines,
    plan: planCron(
      routines,
      ctx.mirror,
      ctx.bootId,
      ctx.pluginRoot,
      typeof ctx.config.timezone === 'string' ? ctx.config.timezone : null,
      machineTz,
      ctx.nowMs,
      reset,
    ),
  };
}

function planEmpty(result: PlanResult): boolean {
  return result.deletes.length === 0 && result.creates.length === 0;
}

export function routineHealth(hermitDir: string, nowMs: number): LegHealth {
  return monitorHealth({ ...context(hermitDir, PLUGIN_ROOT), nowMs });
}

function monitorHealth(ctx: Context): LegHealth {
  const runtime = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'));
  if (runtime?.mode === 'croncreate-fallback') {
    const fullPlan = plan(ctx, true, false).plan;
    return planEmpty(fullPlan)
      ? { healthy: true, reason: 'fallback-current' }
      : { healthy: false, reason: 'fallback-drift' };
  }
  if (runtime?.mode !== 'monitor') return { healthy: false, reason: 'runtime-missing' };
  // Same check as the heartbeat leg (lib/heartbeat/monitor-cmd.ts) — see bootMismatch
  // for why. The anchor plan catches this too whenever the anchor is enabled; this
  // covers the config that disables it.
  if (bootMismatch(runtime.boot_id, ctx.bootId)) {
    return { healthy: false, reason: 'boot-mismatch' };
  }
  if (!sameMonitorCommand(runtime.command, routineCommand(ctx.hermitDir)) && ctx.scheduled.length > 0) {
    return { healthy: false, reason: commandDriftReason(ctx.hermitDir, 'routine-monitor-liveness.json') };
  }
  if (ctx.scheduled.length > 0 && runtime.launch !== 'native') {
    return { healthy: false, reason: 'launch-drift' };
  }
  if (ctx.scheduled.length > 0) {
    const live = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor-liveness.json'));
    const interval = typeof runtime.interval === 'number' && runtime.interval > 0 ? runtime.interval : MONITOR_INTERVAL_SECS;
    const freshness = monitorFreshness(
      typeof runtime.started_at === 'string' ? runtime.started_at : null,
      typeof live?.last_peek_at === 'string' ? live.last_peek_at : null,
      Math.max(10 * interval, 600),
      STARTUP_GRACE_SECS,
      ctx.nowMs,
    );
    if (!freshness.fresh || freshness.reason === 'unregistered') {
      return { healthy: false, reason: livenessReason(freshness.reason) };
    }
  }
  const anchorPlan = plan(ctx, false, false).plan;
  if (!planEmpty(anchorPlan)) {
    return { healthy: false, reason: 'anchor-drift' };
  }

  const anchorEnabled = ctx.routines.some((r: Json) => r?.id === ANCHOR_ID && r.enabled === true);
  if (anchorEnabled) {
    const fired = lastRoutineFire(path.join(ctx.hermitDir, 'state', 'routine-metrics.jsonl'), ANCHOR_ID);
    const firedMs = fired === null ? NaN : Date.parse(fired);
    const registered = ctx.mirror.routines[ANCHOR_ID]?.registered_at;
    const fireFresh = Number.isFinite(firedMs) && ctx.nowMs - firedMs <= ANCHOR_MAX_AGE_MS;
    const registrationFresh = Number.isFinite(registered) && ctx.nowMs - registered <= ANCHOR_MAX_AGE_MS;
    if (!fireFresh && !registrationFresh) return { healthy: false, reason: 'anchor-old' };
  }
  return { healthy: true, reason: runtime.mode };
}

function anchorAgeDays(ctx: Context): number {
  const fired = lastRoutineFire(path.join(ctx.hermitDir, 'state', 'routine-metrics.jsonl'), ANCHOR_ID);
  const ages = [
    fired === null ? NaN : ctx.nowMs - Date.parse(fired),
    Number.isFinite(ctx.mirror.routines[ANCHOR_ID]?.registered_at)
      ? ctx.nowMs - ctx.mirror.routines[ANCHOR_ID].registered_at
      : NaN,
  ].filter(Number.isFinite) as number[];
  return Number((ages.length ? Math.max(0, Math.min(...ages)) / 86400000 : 0).toFixed(1));
}

function healthyVerdict(ctx: Context, heartbeat: LegHealth): Json {
  const runtime = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'));
  return {
    status: 'healthy',
    routines: { mode: runtime?.mode === 'croncreate-fallback' ? 'fallback' : 'monitor', scheduled: ctx.scheduled.length },
    anchor_age_days: anchorAgeDays(ctx),
    heartbeat: heartbeat.reason === 'disabled' ? 'disabled' : 'ok',
  };
}

function stamp(ctx: Context, event: string): void {
  logRoutineEvent(ANCHOR_ID, event, ctx.hermitDir, 'cron-create');
}

function renderAnchorPrompt(ctx: Context): string {
  const cli = `bun ${path.join(ctx.pluginRoot, 'scripts', 'routines.ts')}`;
  return [
    `[hermit-routine:${ANCHOR_ID}]`,
    `Run: ${cli} arm anchor ${ctx.hermitDir} ${ctx.pluginRoot}`,
    'It prints one JSON object. Status "restart_required": report that the resident must be restarted to pick up the new plugin path, and stop.',
    'Status "skip", reason "paused": report that the resident is paused and stop.',
    'An "error" key: stop and report it. The check could not read state, so there is nothing safe to re-arm.',
    'Status "healthy": reply with one short healthy line and stop without TaskStop, Monitor, Cron, or file writes.',
    'Status "arm" with "routines" in legs: invoke /hermitd:hermit-routines load. It arms the heartbeat leg too, so do not also invoke /hermitd:heartbeat start.',
    'Status "arm" with only "heartbeat" in legs: invoke /hermitd:heartbeat start.',
    `Then run: ${cli} finish ${ANCHOR_ID} cron-create`,
  ].join('\n');
}

/** The registration plan fields of an `arm begin` object. */
function planFields(ctx: Context, result: PlanResult): Json {
  const fields: Json = {
    delete: result.deletes,
    create: result.creates.map(item => ({ id: item.id, schedule: item.schedule })),
    keep: result.keepCount,
  };
  try {
    const configured = ctx.config?.routine_wake_lint?.max_windows;
    const maxWindows = Number.isFinite(configured) && configured > 0 ? configured : 6;
    const spread = computeWakeSpread(result.enabledShifted, maxWindows);
    if (spread) fields.wake_spread = { distinct: spread.distinct, max_windows: maxWindows, loneliest: spread.loneliest };
  } catch {}
  return fields;
}

/** The verdict both `anchor` and `check` report, computed without writing anything. */
function armVerdict(ctx: Context): { body: Json; healthy: boolean; paused: boolean } {
  if (isPaused(ctx.hermitDir).paused) return { body: { status: 'skip', reason: 'paused' }, healthy: false, paused: true };
  const routines = monitorHealth(ctx);
  const heartbeat = heartbeatHealth(ctx.hermitDir, ctx.config, ctx.nowMs);
  if (routines.healthy && heartbeat.healthy) {
    return { body: healthyVerdict(ctx, heartbeat), healthy: true, paused: false };
  }
  // A restart-required leg makes `load` answer restart_required for both legs, so an arm here only wakes a futile load.
  const restart = [routines.reason === 'restart-required' ? 'routines' : null, heartbeat.reason === 'restart-required' ? 'heartbeat' : null].filter(Boolean);
  if (restart.length > 0) return { body: { status: 'restart_required', legs: restart }, healthy: false, paused: false };
  const legs = [!routines.healthy ? 'routines' : null, !heartbeat.healthy ? 'heartbeat' : null].filter(Boolean);
  const reasons = [!routines.healthy ? `routines:${snakeToken(routines.reason)}` : null, !heartbeat.healthy ? `heartbeat:${snakeToken(heartbeat.reason)}` : null].filter(Boolean);
  return { body: { status: 'arm', legs, reasons }, healthy: false, paused: false };
}

function cmdAnchor(ctx: Context): void {
  const verdict = armVerdict(ctx);
  // The anchor's ledger rows are what keep `monitorHealth` from reading a live anchor
  // as `anchor-old`, so its fire IS the state change — `check` exists for callers that
  // want the same verdict without claiming a fire happened.
  if (verdict.paused) stamp(ctx, 'skipped-paused');
  else if (verdict.healthy) { stamp(ctx, 'started'); stamp(ctx, 'fired'); }
  else stamp(ctx, 'started');
  printJson(verdict.body);
}

/** Read-only twin of `anchor`: same verdict, no ledger row, no file touched. */
function cmdCheck(ctx: Context): void {
  printJson(armVerdict(ctx).body);
}

function cmdBegin(ctx: Context, flags: string[]): void {
  const sessionIndex = flags.indexOf('--session-id');
  if (isGuest(path.join(ctx.hermitDir, 'state'), sessionIndex < 0 ? null : flags[sessionIndex + 1])) {
    printJson(GUEST_VERDICT);
    return;
  }
  const reset = flags.includes('--reset');
  const fallback = flags.includes('--fallback');
  // Read once for both the healthy short-circuit and the heartbeat plan below: heartbeatHealth
  // re-reads two state files plus `.boot-id`, and both sites see identical inputs. Null
  // on `--fallback`, the one path that never plans the heartbeat leg.
  const heartbeat = fallback ? null : heartbeatHealth(ctx.hermitDir, ctx.config, ctx.nowMs);
  const routines = monitorHealth(ctx);
  if (heartbeat?.reason === 'restart-required' || (!fallback && routines.reason === 'restart-required')) {
    printJson(COMMAND_DRIFT_VERDICT);
    return;
  }
  if (heartbeat && !reset && heartbeat.healthy && routines.healthy) {
    printJson(healthyVerdict(ctx, heartbeat));
    return;
  }

  const runtime = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'));
  const firstTransition = runtime?.mode !== 'monitor';
  const out: Json = {
    status: 'arm',
    legs: fallback ? ['routines'] : ['routines', 'heartbeat'],
    mode: fallback ? 'fallback' : reset ? 'reset' : 'reconcile',
  };
  // The heartbeat leg rides along so one `load` arms both monitors. `--fallback` is
  // the second pass of a load whose first pass already committed the heartbeat, and
  // a `disabled` verdict is healthy: neither emits a plan. A planned heartbeat leg
  // always needs activation.
  let activate = false;
  if (heartbeat && !heartbeat.healthy) {
    out.heartbeat = prepareHeartbeatArm(ctx.hermitDir, ctx.config);
    activate = true;
  }
  // Only ever a transition INTO monitor mode. The flag tells the skill to CronDelete
  // every non-anchor `[hermit-routine:*]` entry, which is right when those crons are
  // being replaced by a monitor — and wrong in fallback mode, where they ARE the
  // routines and only the ids in `create` would come back.
  if (firstTransition && !fallback) out.first_transition = true;
  if (reset || firstTransition) {
    try { fs.rmSync(path.join(ctx.hermitDir, 'state', 'routine-schedule.json'), { force: true }); } catch {}
  }
  // The outgoing monitor's last tick must not be mistaken for the incoming one's
  // first: `arm commit` waits for a liveness file to appear, and a leftover one
  // would let a subprocess that never spawned read as alive.
  if (runtime?.launch !== 'native' || bootMismatch(runtime.boot_id, ctx.bootId)) {
    try { fs.rmSync(path.join(ctx.hermitDir, 'state', 'routine-monitor-liveness.json'), { force: true }); } catch {}
  }
  if (!fallback) {
    if (ctx.scheduled.length === 0) out.monitor_skip = 'zero_scheduled';
    else activate = true;
  }
  if (activate) out.activate = MONITOR_ACTIVATE;
  const result = plan(ctx, fallback, reset).plan;
  const warnings = [
    ...(fallback && ctx.scheduled.length > 0
      ? [{ id: 'routines', message: 'routine_max_lateness_minutes is not enforced in CronCreate fallback; Monitor scheduling is required' }]
      : []),
    ...result.creates.filter(item => item.warn).map(item => ({ id: item.id, message: item.warn })),
  ];
  const fields: Json = { ...out, ...planFields(ctx, result), warnings };
  if (result.creates.some(item => item.id === ANCHOR_ID)) fields.anchor_prompt = renderAnchorPrompt(ctx);
  printJson(fields);
}

function commitMirror(ctx: Context, fallback: boolean, reset: boolean, created: Set<string>): void {
  const planned = plan(ctx, fallback, reset);
  const byId = new Map(planned.routines.map((r: Json) => [r.id, r]));
  const next = commitCron(ctx.mirror, planned.plan, created, byId, ctx.pluginRoot, ctx.bootId, ctx.nowMs);
  writeJson(ctx.mirrorPath, next);
}

/**
 * Starts recording the heartbeat Monitor the skill registered from this run's
 * `heartbeat` plan, or returns null when no heartbeat task was passed. Independent of
 * the routine leg's outcome: `lib/heartbeat/start.ts` owns the write, and a routine
 * fallback says nothing about whether the heartbeat subprocess ticked.
 */
function startHeartbeatLeg(ctx: Context, flags: string[]): Promise<HeartbeatCommit> | null {
  const index = flags.indexOf('--heartbeat');
  const taskId = index === -1 ? '' : (flags[index + 1] ?? '').trim();
  if (!taskId || taskId === 'none') return null;
  const pending = commitHeartbeatArm(ctx.hermitDir, ctx.config, taskId);
  // Both monitors are already spawned by the time `commit` runs, so this leg's
  // first-tick wait overlaps the routine leg's instead of following it — up to 10s off
  // every boot that arms both. The awaits below still surface any rejection; this
  // handler only stops it counting as unhandled during the overlap window.
  pending.catch(() => {});
  return pending;
}

async function cmdCommit(ctx: Context, taskId: string, flags: string[]): Promise<void> {
  const fallback = taskId === 'fallback';
  const reset = flags.includes('--reset');
  const createdIndex = flags.indexOf('--created');
  const created = new Set(
    (createdIndex === -1 ? '' : flags[createdIndex + 1] ?? '')
      .split(',').map(value => value.trim()).filter(Boolean),
  );
  const heartbeatLeg = startHeartbeatLeg(ctx, flags);
  commitMirror(ctx, fallback, reset, created);

  if (fallback) {
    writeJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'), {
      mode: 'croncreate-fallback',
      started_at: new Date(ctx.nowMs).toISOString(),
      boot_id: ctx.bootId,
    });
    printJson(await withHeartbeat(armed(ctx, created), heartbeatLeg));
    return;
  }

  const noMonitor = taskId === 'none';
  const liveness = readJson(path.join(ctx.hermitDir, 'state', 'routine-monitor-liveness.json'));
  const live = noMonitor || (typeof liveness?.pid === 'number' && pidAlive(liveness.pid))
    || await waitForFirstTick(path.join(ctx.hermitDir, 'state', 'routine-monitor-liveness.json'));
  const runtime: Json = {
    description: 'routine-monitor',
    command: routineCommand(ctx.hermitDir),
    interval: MONITOR_INTERVAL_SECS,
    started_at: new Date(ctx.nowMs).toISOString(),
    mode: live ? 'monitor' : 'croncreate-fallback',
    launch: 'native',
    boot_id: ctx.bootId,
  };
  if (noMonitor) runtime.routines = 0;
  writeJson(path.join(ctx.hermitDir, 'state', 'routine-monitor.runtime.json'), runtime);
  printJson(await withHeartbeat(live ? armed(ctx, created) : { status: 'fallback', reason: 'liveness_absent' }, heartbeatLeg));
}

function armed(ctx: Context, created: Set<string>): Json {
  return { status: 'armed', scheduled: ctx.scheduled.length, anchor: created.has(ANCHOR_ID) ? 'created' : 'kept' };
}

async function withHeartbeat(result: Json, heartbeatLeg: Promise<HeartbeatCommit> | null): Promise<Json> {
  return heartbeatLeg ? { ...result, heartbeat: await heartbeatLeg } : result;
}

export async function run(args: string[]): Promise<void> {
  const [subverb, hermitDir, pluginRoot, ...rest] = args;
  // Every caller stops and reports a check_error, so it is a failure, not a verdict.
  // exitCode rather than exit(): a commit's heartbeat leg may still be settling.
  if (!subverb || !hermitDir || !pluginRoot || !['anchor', 'check', 'begin', 'commit'].includes(subverb)) {
    failJson('check_error:usage');
    return;
  }
  try {
    const ctx = context(hermitDir, pluginRoot);
    if (subverb === 'anchor') cmdAnchor(ctx);
    else if (subverb === 'check') cmdCheck(ctx);
    else if (subverb === 'begin') cmdBegin(ctx, rest);
    else {
      const [taskId, ...flags] = rest;
      await cmdCommit(ctx, taskId || 'none', flags);
    }
  } catch (error: any) {
    const message = String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 200);
    failJson(`check_error:${message}`);
  }
}
