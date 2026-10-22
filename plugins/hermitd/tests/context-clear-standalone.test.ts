import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { maybeStandaloneClear, readHarnessOutcomes, type World } from '../scripts/hermitd-watchdog';
import { contextPolicyHash } from '../scripts/lib/context-policy';
import { costLogPath } from '../scripts/lib/cc-compat';
import { procStartOf, localPidDomain } from './helpers/registry-fixture';
import { runScript } from './helpers/run';
import type { QueueOutcome } from '../scripts/lib/harness-mod';

function fixture() {
  const f = taskFixture();
  const now = Date.now();
  const requests: any[] = [];
  const outcomes = new Map<string, QueueOutcome>();
  const mod = { loaded: true };
  const runtime = { cc_session_id: 'resident', tmux_session: 'resident', runtime_mode: 'tmux', last_context_reset_at: new Date(now - 2 * 3600000).toISOString() };
  f.put('state/runtime.json', runtime);
  f.put('state/execution.json', { state: 'idle', cc_session_id: 'resident', at: new Date(now - 61000).toISOString() });
  f.put('state/last-operator-action.json', { at: new Date(now - 2 * 3600000).toISOString() });
  const log = costLogPath(f.dir);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, JSON.stringify({ cc_session_id: 'resident', max_prompt_tokens: 100000 }) + '\n');
  const world: World = {
    liveness: { ageSecs: () => null },
    registry: { resident: () => null },
    notify: { operator: () => {}, maintainer: () => {} },
    actions: { restart: async () => {}, nudge: async () => {}, reauth: () => 'idle' },
    proc: { heartbeatMonitorDead: () => true },
    clock: { nowMs: () => now },
    tmux: { alive: () => true, capture: () => 'pane' },
    harness: {
      enqueue: request => {
        if (!mod.loaded) return { status: 'skipped', reason: 'mod_not_loaded' };
        const id = `r${requests.length}`;
        requests.push({ ...request, id });
        return { status: 'queued', id };
      },
      outcome: id => outcomes.get(id) ?? null,
    },
    files: {
      readJson: file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
      readText: file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
      writeJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
      rm: file => { if (fs.existsSync(file)) fs.unlinkSync(file); },
    },
    paths: { stateDir: path.join(f.dir, 'state'), hermitRoot: f.dir, costLog: log }, memo: {},
  };
  const read = (file: string) => world.files.readJson(path.join(f.dir, file));
  const sent = () => requests.map(r => r.commands[0].command);
  // The mod reports the clear, and the resident's SessionStart records it as it does live.
  const finish = (status: 'ok' | 'failed' = 'ok', at = now) => {
    const request = requests.at(-1);
    outcomes.set(request.id, { id: request.id, source: 'watchdog', purpose: 'watchdog-clear', commands: request.commands, legs: [{ command: '/clear', status, text: status === 'ok' ? '' : 'stopped' }], finished_at: new Date(at).toISOString() });
    if (status === 'ok') {
      const resetAt = new Date(at).toISOString();
      f.put('state/runtime.json', { ...read('state/runtime.json'), context_cleared: true, last_context_reset_at: resetAt });
      const record = read('state/context-clear.json');
      f.put('state/context-clear.json', { ...record, policy_hash: contextPolicyHash(f.dir), last_trigger: { ...record.last_trigger, reset_at: resetAt } });
    }
    readHarnessOutcomes(world);
  };
  return { ...f, runtime, world, requests, sent, now, mod, read, finish };
}
const events = (dir: string) => fs.readFileSync(path.join(dir, 'state/watchdog-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('a policy edit before the first clear survives an ineligible tick and clears once', async () => {
  const f = fixture();
  try {
    f.put('state/last-operator-action.json', { at: new Date(f.now - 1200000).toISOString() });
    const env = { AGENT_DIR: f.dir, HERMIT_RESIDENT: '1', HERMIT_MANAGED: '', CLAUDE_CONFIG_DIR: path.join(f.dir, 'registry') };
    const started = await runScript('startup-context.ts', {
      cwd: path.dirname(f.dir), env, stdin: JSON.stringify({ source: 'startup', session_id: 'resident' }),
    });
    expect(started.exitCode).toBe(0);
    const baseline = f.read('state/context-clear.json');
    expect(baseline.policy_hash).toBe(contextPolicyHash(f.dir));
    expect(baseline.last_trigger).toBeUndefined();
    expect(maybeStandaloneClear({}, f.world)).toBe('execution-not-idle');

    fs.writeFileSync(path.join(f.dir, 'TASKS.md'), 'Confirm posted results explicitly.');
    expect(maybeStandaloneClear({}, f.world)).toBe('execution-not-idle');
    f.put('state/execution.json', { state: 'idle', cc_session_id: 'resident', at: new Date(f.now - 61000).toISOString() });
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:policy');
    expect(f.read('state/context-clear.json').last_trigger).toEqual({ reason: 'policy' });
    expect(maybeStandaloneClear({}, f.world)).toBe('request-pending');
    // The real SessionStart of the cleared resident records the reset and the new policy.
    f.world.harness.outcome = id => ({ id, source: 'watchdog', purpose: 'watchdog-clear', commands: [], legs: [{ command: '/clear', status: 'ok', text: '' }], finished_at: new Date().toISOString() });
    const cleared = await runScript('startup-context.ts', {
      cwd: path.dirname(f.dir), env, stdin: JSON.stringify({ source: 'clear', session_id: 'resident' }),
    });
    expect(cleared.exitCode).toBe(0);
    readHarnessOutcomes(f.world);
    expect(f.read('state/context-clear.json').last_trigger.reset_at).toBe(f.read('state/runtime.json').last_context_reset_at);
    f.put('state/execution.json', { state: 'idle', cc_session_id: 'resident', at: new Date(f.now - 61000).toISOString() });
    expect(maybeStandaloneClear({}, f.world)).toBeNull();
    expect(f.sent()).toEqual(['/clear']);
  } finally { f.cleanup(); }
});

for (const reason of ['quiet', 'max-age', 'policy']) test(`standalone clear ${reason} queues once and records only a reported clear`, () => {
  const f = fixture();
  try {
    if (reason !== 'quiet') f.put('state/last-operator-action.json', { at: new Date(f.now - 1200000).toISOString() });
    if (reason === 'max-age') f.put('state/runtime.json', { ...f.runtime, last_context_reset_at: new Date(f.now - 25 * 3600000).toISOString() });
    if (reason === 'policy') f.put('state/context-clear.json', { policy_hash: 'old', last_trigger: null });
    const before = f.read('state/runtime.json');
    expect(maybeStandaloneClear({}, f.world)).toBe(`clear:${reason}`);
    expect(f.requests).toEqual([expect.objectContaining({ source: 'watchdog', purpose: 'watchdog-clear', trigger: `clear:${reason}`, commands: [{ command: '/clear', arg: null }] })]);
    // Nothing is stamped at enqueue: only the cleared session's SessionStart records the reset.
    expect(f.read('state/runtime.json')).toEqual(before);
    expect(maybeStandaloneClear({}, f.world)).toBe('request-pending');
    f.finish();
    expect(maybeStandaloneClear({}, f.world)).toBe(reason === 'quiet' ? 'already-triggered' : null);
    expect(f.sent()).toEqual(['/clear']);
    expect(events(f.dir)).toEqual([
      expect.objectContaining({ action: 'context-clear', reason: `clear:${reason}` }),
      expect.objectContaining({ action: 'context-clear-result', reason: 'ok' }),
    ]);
    expect(fs.existsSync(path.join(f.dir, 'state/.lifecycle.lock'))).toBe(false);
  } finally { f.cleanup(); }
});

test('a failed clear stamps nothing and stays due', () => {
  const f = fixture();
  try {
    const before = f.read('state/runtime.json');
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:quiet');
    f.finish('failed');
    expect(f.read('state/runtime.json')).toEqual(before);
    expect(events(f.dir).at(-1)).toMatchObject({ action: 'context-clear-result', reason: 'failed: stopped' });
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:quiet');
    expect(f.sent()).toEqual(['/clear', '/clear']);
  } finally { f.cleanup(); }
});

test('a hermit whose mod has not loaded skips the clear and writes nothing', () => {
  const f = fixture();
  try {
    f.mod.loaded = false;
    expect(maybeStandaloneClear({}, f.world)).toBe('mod-not-loaded');
    expect(f.read('state/context-clear.json')).toBeNull();
    expect(fs.existsSync(path.join(f.dir, 'state/watchdog-events.jsonl'))).toBe(false);
  } finally { f.cleanup(); }
});

test('max-age clears again once the context it left behind reaches max age', () => {
  const f = fixture();
  try {
    f.put('state/last-operator-action.json', { at: new Date(f.now - 1200000).toISOString() });
    f.put('state/runtime.json', { ...f.runtime, last_context_reset_at: new Date(f.now - 25 * 3600000).toISOString() });
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:max-age');
    f.finish();
    const resetAt = f.read('state/runtime.json').last_context_reset_at;
    f.world.clock = { nowMs: () => Date.parse(resetAt) + 25 * 3600000 };
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:max-age');
    expect(f.sent()).toEqual(['/clear', '/clear']);
  } finally { f.cleanup(); }
});

test('a second policy change clears again before any other reset', () => {
  const f = fixture();
  try {
    f.put('state/last-operator-action.json', { at: new Date(f.now - 1200000).toISOString() });
    f.put('state/context-clear.json', { policy_hash: 'old', last_trigger: null });
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:policy');
    f.finish();
    fs.writeFileSync(path.join(f.dir, 'TASKS.md'), 'Second policy edit.');
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:policy');
    expect(f.sent()).toEqual(['/clear', '/clear']);
  } finally { f.cleanup(); }
});

test('a max-age clear during a quiet stretch is not followed by a quiet clear', () => {
  const f = fixture();
  try {
    f.put('state/runtime.json', { ...f.runtime, last_context_reset_at: new Date(f.now - 25 * 3600000).toISOString() });
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:max-age');
    f.finish();
    expect(maybeStandaloneClear({}, f.world)).toBe('already-triggered');
    expect(f.sent()).toEqual(['/clear']);
  } finally { f.cleanup(); }
});

test('quiet clears again after the operator acts and goes quiet once more', () => {
  const f = fixture();
  try {
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:quiet');
    f.finish();
    expect(maybeStandaloneClear({}, f.world)).toBe('already-triggered');
    const resetAt = Date.parse(f.read('state/runtime.json').last_context_reset_at);
    f.put('state/last-operator-action.json', { at: new Date(resetAt + 60000).toISOString() });
    f.world.clock = { nowMs: () => resetAt + 2 * 3600000 };
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:quiet');
    expect(f.sent()).toEqual(['/clear', '/clear']);
  } finally { f.cleanup(); }
});

for (const reason of ['execution-not-idle', 'stale-identity', 'idle-too-fresh', 'worker-running', 'registry-busy', 'under-token-floor']) test(`standalone clear refuses ${reason}`, async () => {
  const f = fixture();
  try {
    if (reason === 'execution-not-idle') f.put('state/execution.json', { state: 'in_flight', cc_session_id: 'resident', at: new Date().toISOString() });
    if (reason === 'stale-identity') f.put('state/runtime.json', { ...f.runtime, cc_session_id: 'other' });
    if (reason === 'idle-too-fresh') f.put('state/execution.json', { state: 'idle', cc_session_id: 'resident', at: new Date().toISOString() });
    if (reason === 'worker-running') await f.open(['--owner', 'worker:a3b2c3d4e5f6a7b8c']);
    if (reason === 'under-token-floor') fs.writeFileSync(f.world.paths.costLog, '');
    if (reason === 'registry-busy') {
      const configDir = path.join(f.dir, 'registry');
      fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
      f.put('state/runtime.json', { ...f.runtime, session_pid: process.pid, config_dir: configDir });
      fs.writeFileSync(path.join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart: procStartOf(process.pid), pidDomain: localPidDomain(), status: 'busy', statusUpdatedAt: Date.now() }));
    }
    expect(maybeStandaloneClear({}, f.world)).toBe(reason);
    expect(f.sent()).toEqual([]);
  } finally { f.cleanup(); }
});

test('policy hash excludes learned channel routing and version stamps but includes policy', () => {
  const f = fixture();
  try {
    const config = { channels: { discord: { enabled: true, default_chat_id: 'two' } }, _hermit_versions: { core: '1' } };
    f.put('config.json', config);
    const before = contextPolicyHash(f.dir);
    config.channels.discord.default_chat_id = 'four';
    config._hermit_versions.core = '2';
    f.put('config.json', config);
    expect(contextPolicyHash(f.dir)).toBe(before);
    fs.writeFileSync(path.join(f.dir, 'TASKS.md'), 'New policy');
    expect(contextPolicyHash(f.dir)).not.toBe(before);
  } finally { f.cleanup(); }
});

test('fresh runtime without a reset stamp clears and records the post-reset stamp', () => {
  const f = fixture();
  try {
    const { last_context_reset_at, ...fresh } = f.runtime;
    f.put('state/runtime.json', fresh);
    expect(maybeStandaloneClear({}, f.world)).toBe('clear:quiet');
    f.finish();
    const saved = f.read('state/context-clear.json');
    expect(typeof saved.last_trigger.reset_at).toBe('string');
    expect(saved.last_trigger.reset_at).toBe(f.read('state/runtime.json').last_context_reset_at);
    expect(maybeStandaloneClear({}, f.world)).toBe('already-triggered');
    expect(f.sent()).toEqual(['/clear']);
  } finally { f.cleanup(); }
});
