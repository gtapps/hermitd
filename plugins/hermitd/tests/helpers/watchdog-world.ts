import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { World } from '../../scripts/hermitd-watchdog';

/** A disk-backed world with explicit process and notification effects. */
export function watchdogWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-tick-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const signals = { alive: true, age: null as number | null, pane: 'stable pane', checks: [] as boolean[] };
  const notices: string[] = [];
  const restarts: string[] = [];
  const keys: string[] = [];
  const now = Date.now();
  const world: World = {
    clock: { nowMs: () => now },
    tmux: {
      alive: () => { signals.checks.push(signals.alive); return signals.alive; },
      capture: () => signals.pane,
    },
    harness: {
      enqueue: request => {
        keys.push(request.source === 'pause' ? 'pause' : request.commands.map(c => c.arg ? `${c.command} ${c.arg}` : c.command).join(' + '));
        return { status: 'queued', id: `q${keys.length}` };
      },
      outcome: () => null,
    },
    liveness: { ageSecs: () => signals.age },
    registry: { resident: () => null },
    notify: { operator: text => { notices.push(text); }, maintainer: text => { notices.push(text); } },
    actions: {
      restart: async (_, reason) => { restarts.push(reason); signals.alive = false; },
      nudge: async () => { keys.push('nudge'); },
      reauth: () => 'idle',
    },
    proc: { heartbeatMonitorDead: () => true },
    files: {
      readJson: file => { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; } },
      readText: file => { try { return fs.readFileSync(file, 'utf-8'); } catch { return null; } },
      writeJson: (file, value) => { fs.writeFileSync(file, JSON.stringify(value)); },
      rm: file => { try { fs.unlinkSync(file); } catch {} },
    },
    paths: { stateDir, hermitRoot: root, costLog: path.join(root, 'cost-log.jsonl') },
    memo: {},
  };
  const put = (file: string, value: unknown) => world.files.writeJson(path.join(root, file), value);
  put('config.json', {
    watchdog: { enabled: true, escalate_after: 1, wedge_floor: '1m' },
    heartbeat: { enabled: true, every: '1m', active_hours: { start: '00:00', end: '23:59' } },
    context_hygiene: { clear: { enabled: false }, compact: { enabled: false } },
    backup: { enabled: false },
  });
  put('state/runtime.json', { runtime_mode: 'tmux', tmux_session: 'resident', cc_session_id: 'resident', env_auth: false });
  put('state/execution.json', { state: 'idle', cc_session_id: 'resident', at: new Date(now - 120000).toISOString() });
  return { world, signals, notices, restarts, keys, put, now,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
