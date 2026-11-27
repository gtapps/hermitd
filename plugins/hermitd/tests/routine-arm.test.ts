import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptHash, REREGISTER_AGE_MS } from '../scripts/lib/routines/registry';
import { runScript } from './helpers/run';

const pluginRoot = path.resolve(import.meta.dir, '..');
const tmpdirs: string[] = [];
const now = Date.now();
const iso = (ms = now) => new Date(ms).toISOString();

afterAll(() => {
  for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true });
});

const anchorRoutine = {
  id: 'hermitd:heartbeat-restart', schedule: '0 4 * * *',
  skill: 'hermitd:hermit-routines load', enabled: true,
};
const reflectRoutine = { id: 'reflect', schedule: '0 9 * * *', skill: 'hermitd:reflect', enabled: true };

function fixture(options: { scheduled?: boolean; heartbeat?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routine-arm-')));
  tmpdirs.push(root);
  const hermit = path.join(root, '.hermit');
  const state = path.join(hermit, 'state');
  fs.mkdirSync(state, { recursive: true });
  const routines = options.scheduled === false ? [] : [reflectRoutine];
  const config = {
    timezone: null,
    routines,
    heartbeat: { enabled: options.heartbeat !== false, every: '30m' },
  };
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(state, '.boot-id'), 'boot-a\n');
  fs.writeFileSync(path.join(state, 'cron-registry.json'), JSON.stringify({
    boot_id: 'boot-a',
    routines: {},
  }));
  const routineCommand = `bash "${pluginRoot}"/scripts/monitor-supervisor.sh routines "${hermit}"`;
  const heartbeatCommand = `bash "${pluginRoot}"/scripts/monitor-supervisor.sh heartbeat "${hermit}"`;
  if (options.scheduled !== false) {
    fs.writeFileSync(path.join(state, 'routine-monitor.runtime.json'), JSON.stringify({
      description: 'routine-monitor', launch: 'native', command: routineCommand,
      interval: 60, started_at: iso(now - 60_000), mode: 'monitor', boot_id: 'boot-a',
    }));
    fs.writeFileSync(path.join(state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  } else {
    fs.writeFileSync(path.join(state, 'routine-monitor.runtime.json'), JSON.stringify({
      description: 'routine-monitor', command: routineCommand, interval: 60,
      started_at: iso(now - 60_000), mode: 'monitor', boot_id: 'boot-a', routines: 0,
    }));
  }
  if (options.heartbeat !== false) {
    fs.writeFileSync(path.join(state, 'heartbeat-monitor.runtime.json'), JSON.stringify({
      command: heartbeatCommand, launch: 'native', interval: 1800, started_at: iso(now - 60_000), boot_id: 'boot-a',
    }));
    fs.writeFileSync(path.join(state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  }
  return { root, hermit, state };
}

async function arm(hermit: string, args: string[], env: Record<string, string> = {}) {
  const [subverb, ...flags] = args;
  return runScript('routines.ts', { args: ['arm', subverb, hermit, pluginRoot, ...flags], env });
}

const out = (result: { stdout: string }) => JSON.parse(result.stdout);

test('native commit accepts a live supervisor with a stale tick', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ pid: process.pid, last_peek_at: iso(0) }));
  expect(out(await arm(f.hermit, ['commit', 'native'])).status).toBe('armed');
  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'routine-monitor.runtime.json'), 'utf8'));
  expect(runtime.launch).toBe('native');
  expect(runtime.task_id).toBeUndefined();
});

test('native commit with a dead supervisor and no tick falls back', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ pid: 2147483647 }));
  expect(out(await arm(f.hermit, ['commit', 'native']))).toEqual({ status: 'fallback', reason: 'liveness_absent' });
}, 20_000);

test('begin preserves native liveness', async () => {
  const f = fixture();
  const file = path.join(f.state, 'routine-monitor-liveness.json');
  const before = fs.readFileSync(file, 'utf8');
  await arm(f.hermit, ['begin', '--reset']);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});

function driftRoutineLeg(f: ReturnType<typeof fixture>, pid: number) {
  const file = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
  runtime.command = 'bash /old/plugin/scripts/monitor-supervisor.sh';
  fs.writeFileSync(file, JSON.stringify(runtime));
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ pid }));
}

test('command drift with a live supervisor requires restart', async () => {
  const f = fixture();
  driftRoutineLeg(f, process.pid);
  expect(out(await arm(f.hermit, ['begin']))).toEqual({ status: 'restart_required', reason: 'command_drift' });
});

test('anchor skips instead of arming when a restart is required', async () => {
  const f = fixture();
  driftRoutineLeg(f, process.pid);
  expect(out(await arm(f.hermit, ['anchor']))).toEqual({ status: 'restart_required', legs: ['routines'] });
});

test('anchor names every leg that needs a restart', async () => {
  const f = fixture();
  driftRoutineLeg(f, process.pid);
  const file = path.join(f.state, 'heartbeat-monitor.runtime.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), command: 'old-command' }));
  fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ pid: process.pid }));
  expect(out(await arm(f.hermit, ['check']))).toEqual({ status: 'restart_required', legs: ['routines', 'heartbeat'] });
});

test('command drift with a dead supervisor still arms', async () => {
  const f = fixture();
  driftRoutineLeg(f, 2147483647);
  expect(out(await arm(f.hermit, ['check']))).toEqual({ status: 'arm', legs: ['routines'], reasons: ['routines:command_drift'] });
});

test('both legs registered from the sha-suffixed sibling cache dir check healthy', async () => {
  const f = fixture();
  for (const name of ['routine-monitor.runtime.json', 'heartbeat-monitor.runtime.json']) {
    const file = path.join(f.state, name);
    const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
    runtime.command = runtime.command.replace('"/scripts/', '-5954e0f6849a"/scripts/');
    fs.writeFileSync(file, JSON.stringify(runtime));
  }
  const result = out(await arm(f.hermit, ['check']));
  expect(result).toMatchObject({ status: 'healthy', heartbeat: 'ok' });
});

test('guest begin only reports the guest verdict', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, '.guest-test-guest'), iso());
  expect((await arm(f.hermit, ['begin', '--session-id', 'test-guest'])).stdout)
    .toBe('{"status":"guest","reason":"native_monitors_resident_only"}\n');
});

test('anchor HEALTHY stamps started and fired', async () => {
  const f = fixture();
  const result = await arm(f.hermit, ['anchor']);
  expect(result.exitCode).toBe(0);
  expect(out(result)).toEqual({ status: 'healthy', routines: { mode: 'monitor', scheduled: 1 }, heartbeat: 'ok' });
  const events = fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line).event);
  expect(events).toEqual(['started', 'fired']);
});

test('anchor arms only the stale leg and stamps started without fired', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.started_at = iso(now - 1_000_000);
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso(now - 700_000) }));
  const result = await arm(f.hermit, ['anchor']);
  expect(out(result)).toEqual({ status: 'arm', legs: ['routines'], reasons: ['routines:liveness_stale'] });
  const events = fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line).event);
  expect(events).toEqual(['started']);
});

// The routine monitor dies with its session too, and its last 60s tick is far
// fresher than the 10-minute staleness threshold. Without the boot marker a
// restart inside that window reads as a live monitor and nothing re-arms.
test('anchor re-arms a routine monitor registered by a previous boot', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.boot_id = 'boot-old';
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const result = await arm(f.hermit, ['anchor']);
  expect(out(result).reasons).toContain('routines:boot_mismatch');
});

test('anchor pause short-circuits and stamps skipped-paused', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'operator-pause.json'), JSON.stringify({
    paused: true, paused_until: null, reason: 'operator', by: 'test', ts: iso(),
  }));
  const result = await arm(f.hermit, ['anchor']);
  expect(out(result)).toEqual({ status: 'skip', reason: 'paused' });
  expect(fs.readFileSync(path.join(f.state, 'routine-metrics.jsonl'), 'utf8')).toContain('skipped-paused');
});

test('begin reset removes the cursor and plans no CronCreate', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'routine-schedule.json'), '{}');
  const result = await arm(f.hermit, ['begin', '--reset']);
  const plan = out(result);
  expect(plan).toMatchObject({ status: 'arm', legs: ['routines', 'heartbeat'], mode: 'reset', activate: '/hermitd:monitor-activate' });
  expect(result.stdout).not.toContain('OLD_TASK:');
  expect(plan.create).toEqual([]);
  expect(plan.anchor_prompt).toBeUndefined();
  expect(fs.existsSync(path.join(f.state, 'routine-schedule.json'))).toBe(false);
});

test('explicit fallback plans the built-in anchor in the configured timezone', async () => {
  const f = fixture();
  const configPath = path.join(f.hermit, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.timezone = 'Asia/Tokyo';
  config.routine_wake_lint = { max_windows: 1 };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const plan = out(await arm(f.hermit, ['begin', '--fallback'], { TZ: 'UTC' }));
  expect(plan.create).toEqual([
    { id: anchorRoutine.id, schedule: '0 19 * * *' },
    { id: reflectRoutine.id, schedule: '0 0 * * *' },
  ]);
  expect(plan.wake_spread).toBeUndefined();
  expect(plan.anchor_prompt).toStartWith('[hermit-routine:hermitd:heartbeat-restart]\n');
  expect(plan.anchor_prompt).toContain('arm anchor');
  expect(plan.anchor_prompt).toContain('reason "paused": report that the resident is paused');
  expect(plan.anchor_prompt).toContain('finish hermitd:heartbeat-restart cron-create');
});

test('begin never prints an old task from a previous boot', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.boot_id = 'old-boot';
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(result.stdout).not.toContain('OLD_TASK:');
});

// Legacy records without boot_id must not produce task-stop instructions.
test('begin never stops a task from a runtime record without boot_id', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  delete runtime.boot_id;
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(result.stdout).not.toContain('OLD_TASK:');
});

test('commit none writes monitor runtime with an empty mirror', async () => {
  const f = fixture({ scheduled: false, heartbeat: false });
  const result = await arm(f.hermit, ['commit', 'none']);
  expect(out(result)).toEqual({ status: 'armed', scheduled: 0 });
  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'routine-monitor.runtime.json'), 'utf8'));
  expect(runtime).toMatchObject({ mode: 'monitor', routines: 0, boot_id: 'boot-a' });
  const mirror = JSON.parse(fs.readFileSync(path.join(f.state, 'cron-registry.json'), 'utf8'));
  expect(mirror.routines).toEqual({});
});

async function commitFallback(f: { hermit: string }) {
  const result = await arm(f.hermit, ['commit', 'fallback', '--created', `${anchorRoutine.id},${reflectRoutine.id}`], { HERMIT_NOW: iso() });
  expect(result.exitCode).toBe(0);
  expect(out(result).status).toBe('armed');
}

test('fallback plans and commits the built-in anchor even with a customized config entry', async () => {
  const f = fixture();
  const configPath = path.join(f.hermit, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.routines.push({ ...anchorRoutine, schedule: '15 3 * * *', model: 'haiku' });
  fs.writeFileSync(configPath, JSON.stringify(config));

  const first = out(await arm(f.hermit, ['begin', '--fallback']));
  expect(first.create).toContainEqual({ id: anchorRoutine.id, schedule: anchorRoutine.schedule });
  await commitFallback(f);
  const mirrorPath = path.join(f.state, 'cron-registry.json');
  const entry = JSON.parse(fs.readFileSync(mirrorPath, 'utf8')).routines[anchorRoutine.id];
  expect(entry.prompt_hash).toBe(promptHash(anchorRoutine, anchorRoutine.schedule, pluginRoot));

  const second = out(await arm(f.hermit, ['begin', '--fallback']));
  expect(second).toMatchObject({ delete: [], create: [], keep: 2 });
  expect(second.anchor_prompt).toBeUndefined();
  await arm(f.hermit, ['commit', 'fallback']);
  expect(JSON.parse(fs.readFileSync(mirrorPath, 'utf8')).routines[anchorRoutine.id]).toEqual(entry);
});

test('fallback with all routines disabled deletes the tracked anchor without recreating it', async () => {
  const f = fixture();
  await commitFallback(f);
  const configPath = path.join(f.hermit, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.routines[0].enabled = false;
  fs.writeFileSync(configPath, JSON.stringify(config));
  const plan = out(await arm(f.hermit, ['begin', '--fallback']));
  expect(plan).toMatchObject({ delete: [anchorRoutine.id, reflectRoutine.id], create: [] });
  expect(plan.anchor_prompt).toBeUndefined();
});

test('daily healthy fallback verdicts cannot extend cron registrations past 25 days', async () => {
  const f = fixture({ heartbeat: false });
  await commitFallback(f);
  const renewAfter = 25 * 86400000;
  const atThreshold = out(await arm(f.hermit, ['anchor'], { HERMIT_NOW: iso(now + renewAfter) }));
  expect(atThreshold.status).toBe('healthy');
  const aged = out(await arm(f.hermit, ['anchor'], { HERMIT_NOW: iso(now + renewAfter + 1) }));
  expect(aged).toEqual({ status: 'arm', legs: ['routines'], reasons: ['routines:fallback_drift'] });
});

// --- The heartbeat leg riding along on `load` (one boot arms both monitors) ---

/** Drift the registered interval so heartbeatHealth reports `interval-drift`. */
function staleHeartbeat(f: { state: string }) {
  const p = path.join(f.state, 'heartbeat-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(p, 'utf8'));
  runtime.interval = 600;
  fs.writeFileSync(p, JSON.stringify(runtime));
}

test('same-boot fallback renews only the aged cron without activation', async () => {
  const f = fixture();
  await commitFallback(f);
  const mirrorPath = path.join(f.state, 'cron-registry.json');
  const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
  mirror.routines[reflectRoutine.id].registered_at = now - REREGISTER_AGE_MS - 1;
  fs.writeFileSync(mirrorPath, JSON.stringify(mirror));
  const plan = out(await arm(f.hermit, ['begin'], { HERMIT_NOW: iso() }));
  expect(plan).toMatchObject({
    status: 'arm', mode: 'fallback', delete: [reflectRoutine.id],
    create: [{ id: reflectRoutine.id, schedule: reflectRoutine.schedule }], keep: 1,
  });
  expect(plan.first_transition).toBeUndefined();
  expect(plan.monitor_skip).toBeUndefined();
  expect(plan.activate).toBeUndefined();
});

test.each(['boot-old', undefined])('fallback record with boot id %s returns to native planning', async bootId => {
  const f = fixture();
  await commitFallback(f);
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  fs.writeFileSync(runtimePath, JSON.stringify({ mode: 'croncreate-fallback', boot_id: bootId }));
  const plan = out(await arm(f.hermit, ['begin']));
  expect(plan).toMatchObject({ status: 'arm', mode: 'reconcile', first_transition: true, create: [] });
});

test('same-boot fallback reset unparks the routine supervisor for a native retry', async () => {
  const f = fixture();
  await commitFallback(f);
  const plan = out(await arm(f.hermit, ['begin', '--reset']));
  expect(plan).toMatchObject({
    status: 'arm', mode: 'reset', first_transition: true, activate: '/hermitd:monitor-activate', create: [],
  });
  expect(fs.existsSync(path.join(f.state, 'routine-monitor.runtime.json'))).toBe(false);
});

test.each([
  { mode: 'croncreate-fallback', boot_id: 'boot-old' },
  { mode: 'monitor', boot_id: 'boot-a' },
])('reset preserves a $mode record for boot $boot_id', async record => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const original = JSON.stringify(record);
  fs.writeFileSync(runtimePath, original);
  expect(out(await arm(f.hermit, ['begin', '--reset'])).mode).toBe('reset');
  expect(fs.readFileSync(runtimePath, 'utf8')).toBe(original);
});

test('same-boot fallback load plans the unhealthy heartbeat without native routine activation', async () => {
  const f = fixture();
  await commitFallback(f);
  staleHeartbeat(f);
  const plan = out(await arm(f.hermit, ['begin']));
  expect(plan).toMatchObject({
    status: 'arm', mode: 'fallback', legs: ['routines', 'heartbeat'],
    heartbeat: { interval: 1800 }, activate: '/hermitd:monitor-activate', delete: [], create: [],
  });
  expect(plan.first_transition).toBeUndefined();
  expect(plan.monitor_skip).toBeUndefined();
});

test('same-boot fallback load short-circuits when both legs are healthy', async () => {
  const f = fixture();
  await commitFallback(f);
  expect(out(await arm(f.hermit, ['begin']))).toEqual({
    status: 'healthy', routines: { mode: 'fallback', scheduled: 1 }, heartbeat: 'ok',
  });
});

test('begin plans the heartbeat leg with the same plan start-check would print', async () => {
  const f = fixture();
  staleHeartbeat(f);
  const g = fixture();
  staleHeartbeat(g);

  const begun = out(await arm(f.hermit, ['begin']));
  const { status, reason, activate, ...expected } = out(await runScript('heartbeat.ts', { args: ['start-check', g.hermit] }));
  expect({ status, reason, activate }).toEqual({ status: 'rearm', reason: 'interval_drift', activate: '/hermitd:monitor-activate' });
  expect(expected).toEqual({ interval: 1800 });
  expect(begun.heartbeat).toEqual(expected);
  expect(begun.activate).toBe(activate);
  expect(begun.create).toEqual([]);
  expect(begun.anchor_prompt).toBeUndefined();
});

test('begin preserves the first-start marker without carrying old heartbeat tasks', async () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.state, 'heartbeat-monitor.runtime.json'),
    JSON.stringify({ task_id: 'hb-old', interval: 600 }),
  );
  const result = await arm(f.hermit, ['begin']);
  expect(result.stdout).not.toContain('OLD_TASK:');
  expect(out(result).heartbeat.first_start).toBe(true);
});

test('a disabled heartbeat is never planned by begin', async () => {
  const f = fixture({ heartbeat: false });
  const configPath = path.join(f.hermit, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.heartbeat = { enabled: false, every: '30m' };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const result = await arm(f.hermit, ['begin', '--reset']);
  expect(out(result).heartbeat).toBeUndefined();
});

// The fallback pass is the second half of a load whose first pass already
// committed the heartbeat; re-planning it there would register a second monitor.
test('the fallback pass never plans the heartbeat leg', async () => {
  const f = fixture();
  staleHeartbeat(f);
  const result = out(await arm(f.hermit, ['begin', '--fallback']));
  expect(result).toMatchObject({ status: 'arm', legs: ['routines'], mode: 'fallback' });
  expect(result.warnings[0].id).toBe('routines');
  expect(result.warnings[0].message).toStartWith('routine_max_lateness_minutes is not enforced in CronCreate fallback');
  expect(result.heartbeat).toBeUndefined();
  expect(result.activate).toBeUndefined();
});

test('commit --heartbeat records the heartbeat monitor after the routine leg', async () => {
  const f = fixture();
  staleHeartbeat(f);
  await arm(f.hermit, ['begin']);
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso(Date.now() + 1000) }));

  const result = out(await arm(f.hermit, ['commit', 'native', '--heartbeat', 'native']));
  expect(result.status).toBe('armed');
  expect(result.heartbeat).toEqual({ status: 'registered', interval: 1800 });
  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'heartbeat-monitor.runtime.json'), 'utf8'));
  expect(runtime).toMatchObject({ launch: 'native', interval: 1800 });
});

test('a symlinked plugin root writes the same heartbeat command as start-commit', async () => {
  const f = fixture();
  const pluginLink = path.join(f.root, 'plugin-link');
  fs.symlinkSync(pluginRoot, pluginLink);
  staleHeartbeat(f);
  await runScript('routines.ts', { args: ['arm', 'begin', f.hermit, pluginLink] });
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso(Date.now() + 1000) }));

  await runScript('routines.ts', { args: ['arm', 'commit', f.hermit, pluginLink, 'native', '--heartbeat', 'native'] });
  const checked = await runScript('heartbeat.ts', { args: ['start-check', f.hermit] });
  expect(out(checked)).toEqual({ status: 'fresh', interval: 1800 });
});

// The two legs are independent: a routine subprocess that never ticked says
// nothing about whether the heartbeat one did.
test('a routine fallback still commits the heartbeat leg', async () => {
  const f = fixture();
  staleHeartbeat(f);
  await arm(f.hermit, ['begin']);
  fs.rmSync(path.join(f.state, 'routine-monitor-liveness.json'), { force: true });
  fs.writeFileSync(path.join(f.state, 'heartbeat-liveness.json'), JSON.stringify({ last_peek_at: iso(Date.now() + 1000) }));

  const result = await arm(f.hermit, ['commit', 'native', '--heartbeat', 'native']);
  expect(out(result)).toEqual({ status: 'fallback', reason: 'liveness_absent', heartbeat: { status: 'registered', interval: 1800 } });
  // The absent routine liveness file costs waitForFirstTick its full poll (HERMIT_FIRST_TICK_WAIT_MS).
}, 30_000);

test('commit without --heartbeat leaves the heartbeat runtime untouched', async () => {
  const f = fixture();
  const before = fs.readFileSync(path.join(f.state, 'heartbeat-monitor.runtime.json'), 'utf8');
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso() }));
  const result = await arm(f.hermit, ['commit', 'native']);
  expect(out(result).heartbeat).toBeUndefined();
  expect(fs.readFileSync(path.join(f.state, 'heartbeat-monitor.runtime.json'), 'utf8')).toBe(before);
});

// The commit's own clock, never a liveness tick. The outgoing monitor is still alive
// while the arm is planned — `begin` only prints OLD_TASK, the skill stops it afterwards
// — so a tick sitting in the file at commit time may be the outgoing monitor's, and no
// timestamp can tell the two apart. The routine leg needs no attribution anyway: its
// 60s poll fits inside the 120s startup grace, so a first tick that predates started_at
// is superseded before the grace expires.
test('commit stamps started_at from its own clock, not the liveness tick', async () => {
  const f = fixture();
  await arm(f.hermit, ['begin', '--reset']);

  const tick = iso(now - 60_000);
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: tick }));
  const before = Date.now();
  await arm(f.hermit, ['commit', 'native', '--reset']);

  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'routine-monitor.runtime.json'), 'utf8'));
  expect(runtime.started_at).not.toBe(tick);
  expect(Date.parse(runtime.started_at)).toBeGreaterThanOrEqual(before);
  expect(runtime.mode).toBe('monitor');
});

// `begin` leaves no provenance key behind for `commit` to read.
test('begin writes no armed_at fence', async () => {
  const f = fixture();
  await arm(f.hermit, ['begin', '--reset']);
  const runtime = JSON.parse(fs.readFileSync(path.join(f.state, 'routine-monitor.runtime.json'), 'utf8'));
  expect(runtime.armed_at).toBeUndefined();
});

// --- `arm check`: the anchor's verdict without the anchor's ledger row ---

test('monitor check stays healthy with a tracked anchor and writes nothing', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'cron-registry.json'), JSON.stringify({
    boot_id: 'boot-a',
    routines: {
      [anchorRoutine.id]: {
        prompt_hash: promptHash(anchorRoutine, anchorRoutine.schedule, pluginRoot),
        registered_at: now,
      },
    },
  }));
  const result = await arm(f.hermit, ['check']);
  expect(out(result)).toEqual({ status: 'healthy', routines: { mode: 'monitor', scheduled: 1 }, heartbeat: 'ok' });
  expect(fs.existsSync(path.join(f.state, 'routine-metrics.jsonl'))).toBe(false);
});

test('check reports a stale leg without stamping a fire', async () => {
  const f = fixture();
  const runtimePath = path.join(f.state, 'routine-monitor.runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  runtime.started_at = iso(now - 1_000_000);
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  fs.writeFileSync(path.join(f.state, 'routine-monitor-liveness.json'), JSON.stringify({ last_peek_at: iso(now - 700_000) }));
  const result = await arm(f.hermit, ['check']);
  expect(out(result)).toEqual({ status: 'arm', legs: ['routines'], reasons: ['routines:liveness_stale'] });
  expect(fs.existsSync(path.join(f.state, 'routine-metrics.jsonl'))).toBe(false);
});

test('check reports pause without consuming the fire', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.state, 'operator-pause.json'), JSON.stringify({
    paused: true, paused_until: null, reason: 'operator', by: 'test', ts: iso(),
  }));
  const result = await arm(f.hermit, ['check']);
  expect(out(result)).toEqual({ status: 'skip', reason: 'paused' });
  expect(fs.existsSync(path.join(f.state, 'routine-metrics.jsonl'))).toBe(false);
});

// Every caller stops and reports a check error, so it is a failure, not a verdict.
test('a usage error or unreadable state is a check_error failure', async () => {
  const usage = await runScript('routines.ts', { args: ['arm', 'check'] });
  expect(usage.exitCode).toBe(1);
  expect(out(usage)).toEqual({ error: 'check_error:usage' });

  const f = fixture();
  fs.writeFileSync(path.join(f.hermit, 'config.json'), '{not json');
  const broken = await arm(f.hermit, ['check']);
  expect(broken.exitCode).toBe(1);
  expect(out(broken).error).toStartWith('check_error:');
});
