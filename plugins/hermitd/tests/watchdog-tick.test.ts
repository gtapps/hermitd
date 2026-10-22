import { expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tick } from '../scripts/hermitd-watchdog';
import { watchdogWorld } from './helpers/watchdog-world';

test('orphan across two ticks sends one notice and never restarts', async () => {
  const f = watchdogWorld();
  try {
    f.signals.alive = false;
    f.signals.age = 10;
    await tick(f.world);
    await tick(f.world);
    expect(f.notices).toHaveLength(1);
    expect(f.restarts).toEqual([]);
  } finally { f.cleanup(); }
});

test('dead session requests one restart', async () => {
  const f = watchdogWorld();
  try {
    f.signals.alive = false;
    await tick(f.world);
    expect(f.restarts).toEqual(['dead-process']);
  } finally { f.cleanup(); }
});

function staleHeartbeat(f: ReturnType<typeof watchdogWorld>) {
  const heartbeat = path.join(f.world.paths.stateDir, '.heartbeat');
  fs.writeFileSync(heartbeat, '');
  const old = new Date(f.now - 24 * 3600000);
  fs.utimesSync(heartbeat, old, old);
  f.put('state/heartbeat-monitor.runtime.json', { started_at: old.toISOString() });
  f.put('state/watchdog-state.json', {
    last_pane_hash: crypto.createHash('sha256').update(f.signals.pane).digest('hex'),
  });
}

test('heartbeat escalation stops the tick after the restart', async () => {
  const f = watchdogWorld();
  try {
    staleHeartbeat(f);
    await tick(f.world);
    expect(f.restarts).toEqual(['pane-frozen']);
    expect(f.signals.checks).toEqual([true]);
    expect(f.keys).toEqual([]);
  } finally { f.cleanup(); }
});

function authStamp(f: ReturnType<typeof watchdogWorld>, message: string, sessionId = 'resident') {
  f.put('state/stop-failure.json', {
    error: 'authentication_failed', session_id: sessionId, at: new Date(f.now).toISOString(), last_assistant_message: message,
  });
}

test('env-auth failure stops before heartbeat escalation', async () => {
  const f = watchdogWorld();
  try {
    f.put('state/runtime.json', { runtime_mode: 'tmux', tmux_session: 'resident', cc_session_id: 'resident', env_auth: true });
    authStamp(f, 'Invalid API key · Fix external API key');
    staleHeartbeat(f);
    await tick(f.world);
    expect(f.notices).toHaveLength(1);
    expect(f.restarts).toEqual([]);
    expect(f.keys).toEqual([]);
  } finally { f.cleanup(); }
});

for (const waitingFor of ['permission prompt', 'input needed', 'dialog open']) {
  test(`registry waiting (${waitingFor}) suppresses heartbeat and monitor requests and names the dialog`, async () => {
    const f = watchdogWorld();
    try {
      // The pane itself is never read for this: an ordinary pane, a waiting session.
      f.world.registry.resident = () => ({
        pid: 1, kind: 'interactive', status: 'waiting', waitingFor, statusUpdatedAt: f.now - 60_000,
        cwd: '/', name: 'hermit', messagingSocketPath: '', procStart: '', pidDomain: '',
      });
      staleHeartbeat(f);
      f.put('state/heartbeat-monitor.runtime.json', { started_at: new Date(f.now - 24 * 3600000).toISOString() });
      await tick(f.world);
      expect(f.notices).toHaveLength(1);
      expect(f.notices[0]).toContain(waitingFor);
      expect(f.restarts).toEqual([]);
      expect(f.keys).toEqual([]);
    } finally { f.cleanup(); }
  });
}

for (const message of [
  'Please run /login · API Error: 401 OAuth access token is invalid.',
  'Login expired · Please run /login',
  'Invalid API key · Fix external API key',
]) {
  test(`an auth stamp for this session is a lapsed login: ${message}`, async () => {
    const f = watchdogWorld();
    try {
      const lapsed: boolean[] = [];
      f.world.actions.reauth = (_config, authLapsed) => { lapsed.push(authLapsed === true); return 'unreachable'; };
      authStamp(f, message);
      staleHeartbeat(f);
      await tick(f.world);
      expect(lapsed).toEqual([true]);
      expect(f.notices).toHaveLength(1);
      expect(f.restarts).toEqual([]);
      expect(f.keys).toEqual([]);
    } finally { f.cleanup(); }
  });
}

test('an auth stamp from another session is not a lapsed login', async () => {
  const f = watchdogWorld();
  try {
    const lapsed: boolean[] = [];
    f.world.actions.reauth = (_config, authLapsed) => { lapsed.push(authLapsed === true); return 'idle'; };
    authStamp(f, 'Login expired · Please run /login', 'earlier-session');
    f.signals.pane = 'Login expired · Please run /login';
    await tick(f.world);
    expect(lapsed).toEqual([false]);
    expect(f.notices).toEqual([]);
  } finally { f.cleanup(); }
});

test('a live session with stale monitor liveness re-arms at the safe boundary', async () => {
  const f = watchdogWorld();
  try {
    staleHeartbeat(f);
    const heartbeat = path.join(f.world.paths.stateDir, '.heartbeat');
    const now = new Date(f.now);
    fs.utimesSync(heartbeat, now, now);
    await tick(f.world);
    expect(f.restarts).toEqual([]);
    expect(f.keys).toEqual(['/hermitd:heartbeat start']);
  } finally { f.cleanup(); }
});

test('a skipped pause abort retries on the next tick without a second notice', async () => {
  const f = watchdogWorld();
  try {
    f.put('state/pause.json', { paused: true, paused_until: null, reason: 'operator', by: 'test', ts: '2026-02-02T00:00:00.000Z' });
    f.put('state/execution.json', { state: 'in_flight', cc_session_id: 'resident', at: new Date(f.now).toISOString() });
    const queued = f.world.harness.enqueue;
    let skip = true;
    f.world.harness.enqueue = request => request.source === 'pause' && skip ? { status: 'skipped', reason: 'mod_not_loaded' } : queued(request);
    await tick(f.world);
    expect(f.keys).not.toContain('pause');
    const notices = f.notices.length;
    expect(notices).toBeGreaterThan(0);
    skip = false;
    await tick(f.world);
    expect(f.keys.filter(k => k === 'pause')).toHaveLength(1);
    await tick(f.world);
    expect(f.keys.filter(k => k === 'pause')).toHaveLength(1);
    expect(f.notices).toHaveLength(notices);
  } finally { f.cleanup(); }
});
