import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { doRestart, tick } from '../scripts/hermitd-watchdog';
import { buildResidentPrompt } from '../scripts/lib/resident-prompt';
import { transcriptDirFor } from '../scripts/lib/cc-compat';
import { watchdogWorld } from './helpers/watchdog-world';
import { readJson } from './helpers/workdir';

// The restart action in process: the fake world's restart effects record each step
// and whether the lifecycle lock was held at that moment. The spawned-watchdog suite
// keeps one end-to-end restart and the staged-credential file contract.

type Fixture = ReturnType<typeof watchdogWorld>;

const RESIDENT = 'cc-resident-001';

/** Route the cascade's restart through the real restart action. */
function realRestart(f: Fixture): void {
  f.world.actions.restart = (...args) => doRestart(f.world, ...args);
}

const stateFile = (f: Fixture, name: string) => path.join(f.world.paths.stateDir, name);
const readState = (f: Fixture, name: string) => readJson(stateFile(f, name));
const events = (f: Fixture) => { try { return fs.readFileSync(stateFile(f, 'watchdog-events.jsonl'), 'utf8'); } catch { return ''; } };

async function inFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const f = watchdogWorld();
  try { await fn(f); } finally { f.cleanup(); }
}

test('a dead session restarts in order and commits the credential while the lock is held', () => inFixture(async (f) => {
  realRestart(f);
  f.signals.alive = false;
  await tick(f.world);

  expect(f.steps).toEqual([
    'runtime (locked)', 'capture (locked)', 'kill (locked)', 'verify (locked)', 'commit (locked)', 'start', 'notify',
  ]);
  const runtime = readState(f, 'runtime.json');
  expect(runtime.last_error).toBe('unclean_shutdown');
  expect(runtime.watchdog_restart_reason).toBe('dead-process');
  expect(runtime.planned_restart_at).toBeUndefined();
  expect(events(f)).toContain('dead-process, tree-verified');
  expect(fs.existsSync(stateFile(f, '.lifecycle.lock'))).toBe(false);
}));

test('a survivor after the kill aborts: no credential commit, no start, lock released before the notice', () => inFixture(async (f) => {
  f.effects.survivors = [4242, 4243];
  const runtime = readState(f, 'runtime.json');
  await doRestart(f.world, 'resident', 'upgrade', runtime, 'UTC');

  expect(f.steps).toEqual([
    'runtime (locked)', 'capture (locked)', 'kill (locked)', 'verify (locked)', 'runtime (locked)', 'notify',
  ]);
  expect(f.effects.startArgs).toEqual([]);
  expect(events(f)).toContain('survivors: 4242 4243');
  // The old process lives on, so a later death is not this planned restart.
  expect(readState(f, 'runtime.json').planned_restart_at).toBeUndefined();
  expect(f.notices).toEqual([expect.stringContaining('pgrep -af')]);
  // Same episode as the next tick's orphan verdict: that tick sends no second notice.
  expect(readState(f, 'watchdog-state.json').orphan_notified).toBe(true);
}));

test('a held lifecycle lock backs off before touching anything', () => inFixture(async (f) => {
  // A live, same-user holder other than this process (which would re-take its own lock).
  fs.writeFileSync(stateFile(f, '.lifecycle.lock'), String(process.ppid));
  await doRestart(f.world, 'resident', 'dead-process', readState(f, 'runtime.json'), 'UTC');
  expect(f.steps).toEqual([]);
  expect(events(f)).toBe('');
  expect(readState(f, 'runtime.json').last_error).toBeUndefined();
  expect(fs.readFileSync(stateFile(f, '.lifecycle.lock'), 'utf8')).toBe(String(process.ppid));
}));

test('a missing start binary still records the restart but announces nothing', () => inFixture(async (f) => {
  f.effects.startPresent = false;
  await doRestart(f.world, 'resident', 'dead-process', readState(f, 'runtime.json'), 'UTC');
  expect(f.steps.at(-1)).toBe('start');
  expect(f.notices).toEqual([]);
  expect(events(f)).toContain('dead-process, tree-verified');
}));

// Watchdog-detected restarts (a dead session on a tick) and restarts someone asked
// for (`requested`) both resume; only detected ones obey the loop guard.
const scenarios: Record<string, { expected: string; requested?: boolean }> = {
  'default': { expected: 'resume' },
  'no-session-id': { expected: 'fresh: no-session-id' },
  'no-user-turn': { expected: 'fresh: no-user-turn' },
  'prompt-changed': { expected: 'fresh: prompt-changed' },
  'recent-restart': { expected: 'fresh: recent-restart' },
  'compact-off-large-context': { expected: 'resume' },
  'requested': { expected: 'resume', requested: true },
};

for (const [scenario, { expected, requested }] of Object.entries(scenarios)) {
  test(`restart resume: ${scenario}`, () => inFixture(async (f) => {
    realRestart(f);
    const configDir = path.join(f.dir, 'claude-config');
    const transcripts = transcriptDirFor(f.dir, configDir);
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, `${RESIDENT}.jsonl`), scenario === 'no-user-turn' ? '\n' : '{"type":"user"}\n');
    fs.writeFileSync(stateFile(f, 'resident-system-prompt.md'), scenario === 'prompt-changed' ? 'old prompt' : buildResidentPrompt(f.dir));
    if (scenario === 'compact-off-large-context') {
      f.put('config.json', { ...readJson(path.join(f.world.paths.hermitRoot, 'config.json')), context_hygiene: { compact: { min_context_tokens: 100000, enabled: false } } });
      fs.writeFileSync(f.world.paths.costLog, JSON.stringify({ session_id: 'S-001', cc_session_id: RESIDENT, input_tokens: 400000, cache_write_tokens: 0, cache_read_tokens: 0 }) + '\n');
    }
    const runtime = { ...readState(f, 'runtime.json'), config_dir: configDir, cc_session_id: scenario === 'no-session-id' ? null : RESIDENT };
    f.put('state/runtime.json', runtime);
    const priorRestart = new Date(f.now - 5 * 60_000).toISOString();
    f.put('state/watchdog-state.json', {
      consecutive_stale: 2, last_pane_hash: 'abc',
      ...(scenario === 'recent-restart' ? { last_restart_at: priorRestart } : {}),
    });

    if (requested) {
      await doRestart(f.world, 'resident', 'manual', runtime, 'UTC', true);
    } else {
      f.signals.alive = false;
      await tick(f.world);
    }

    const resumes = expected === 'resume';
    expect(f.effects.startArgs).toEqual([resumes ? ['--resume', RESIDENT] : []]);
    expect(events(f)).toContain(resumes ? `resume ${RESIDENT}` : expected);
    // Every restart stamps its time without clobbering what the caller wrote.
    const ws = readState(f, 'watchdog-state.json');
    expect(Date.parse(ws.last_restart_at)).toBeGreaterThan(Date.parse(priorRestart));
    expect(ws.last_pane_hash).toBe('abc');
  }));
}
