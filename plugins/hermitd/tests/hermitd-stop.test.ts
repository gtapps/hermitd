import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SCRIPTS_DIR } from './helpers/run';
import { claim, finalize } from '../scripts/lib/harness-mod';

// Black-box contract tests for the hermitd-stop lifecycle script. Written
// against the Python implementation first, then flipped to the TS port in the
// same commit — STOP_CMD is the single line that changes.
const STOP_IMPL = fs.existsSync(path.join(SCRIPTS_DIR, 'hermitd-stop.ts'))
  ? path.join(SCRIPTS_DIR, 'hermitd-stop.ts')
  : path.join(SCRIPTS_DIR, 'hermitd-stop.py');
const STOP_CMD = STOP_IMPL.endsWith('.ts') ? ['bun', STOP_IMPL] : ['python3', STOP_IMPL];
const IS_TS = STOP_IMPL.endsWith('.ts');

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-stop-'));
  fs.mkdirSync(path.join(dir, '.hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hermit', 'sessions'), { recursive: true });
  return dir;
}

function writeConfig(dir: string, extra: Record<string, any> = {}) {
  fs.writeFileSync(
    path.join(dir, '.hermit', 'config.json'),
    JSON.stringify({ agent_name: 't', always_on: true, tmux_session_name: 'hermit-test', ...extra }, null, 2)
  );
}

function writeRuntime(dir: string, data: Record<string, any>) {
  fs.writeFileSync(path.join(dir, '.hermit', 'state', 'runtime.json'), JSON.stringify(data));
}

function readJson(dir: string, rel: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf-8'));
}

// Stateful fake tmux: `has-session` consults a marker file so tests can make
// the session "exit" mid-run; every invocation is logged for assertions.
function installFakeTmux(
  dir: string,
  opts: { hasSession?: boolean; panePid?: number } = {}
) {
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'tmux.log');
  const aliveMarker = path.join(dir, 'session-alive');
  if (opts.hasSession) fs.writeFileSync(aliveMarker, '1');
  // list-panes drives the survivor check: echo the injected pane pid so the
  // stop script captures a real process tree to verify.
  const listPanes = opts.panePid
    ? `list-panes) echo ${opts.panePid}; exit 0 ;;`
    : '';
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1" in
  has-session) [ -f '${aliveMarker}' ] && exit 0 || exit 1 ;;
  kill-session) rm -f '${aliveMarker}'; exit 0 ;;
  ${listPanes}
  *) exit 0 ;;
esac
`
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  return { log, aliveMarker, bin };
}

/** The resident session with the core mod loaded, so the shutdown skill can be queued. */
function residentWithMod(dir: string) {
  writeRuntime(dir, { runtime_mode: 'tmux', cc_session_id: 'resident' });
  fs.writeFileSync(path.join(dir, '.hermit', 'state', 'harness-mod-loaded.json'), JSON.stringify({ session_id: 'resident' }));
}

/** Stand in for the core mod and the session: once the skill is queued, run it and settle its turn. */
async function runQueuedSkill(dir: string) {
  const hermit = path.join(dir, '.hermit');
  const deadline = Date.now() + 20000;
  for (;;) {
    const entry = claim(hermit, 'resident', 'test');
    if (entry) {
      const submitted = Date.now();
      finalize(hermit, entry.id, { legs: [{ command: entry.commands[0].command, status: 'ok', text: 'submitted', submitted_at: new Date(submitted).toISOString() }] });
      fs.writeFileSync(path.join(hermit, 'state', 'execution.json'), JSON.stringify({ state: 'idle', at: new Date(submitted + 1000).toISOString() }));
      return entry;
    }
    if (Date.now() > deadline) throw new Error('shutdown skill never queued');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function runStop(dir: string, args: string[], fakeBin?: string, extraEnv?: Record<string, string>) {
  const env: Record<string, string> = { ...process.env, ...(extraEnv ?? {}) } as any;
  if (fakeBin) env.PATH = `${fakeBin}:${env.PATH}`;
  const proc = Bun.spawn([...STOP_CMD, ...args], {
    cwd: dir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe('hermitd-stop contract', () => {
  test('no config → exit 1 with guidance', async () => {
    const dir = makeDir();
    try {
      const { exitCode, stdout } = await runStop(dir, []);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('No config found');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no session, interactive runtime → guidance, always_on reset, lifecycle untouched', async () => {
    const dir = makeDir();
    try {
      writeConfig(dir);
      writeRuntime(dir, { runtime_mode: 'interactive' });
      const { bin } = installFakeTmux(dir, { hasSession: false });
      const { exitCode, stdout } = await runStop(dir, [], bin);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('running in interactive mode');
      expect(readJson(dir, '.hermit/config.json').always_on).toBe(false);
      // The Stop hook owns the idle transition — stop must not have written it.
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('config.json is never rewritten from the settled read-view', async () => {
    const dir = makeDir();
    try {
      // `routines` is an object, not an array — the settled read-view turns that
      // into [] and a corrupt file into full template defaults. Neither may reach
      // disk: stop patches always_on onto the raw object and writes that.
      writeConfig(dir, { routines: { broken: true }, budget: { daily_usd: '5' } });
      writeRuntime(dir, { runtime_mode: 'tmux' });
      const { bin } = installFakeTmux(dir, { hasSession: false });
      await runStop(dir, [], bin);
      const after = readJson(dir, '.hermit/config.json');
      expect(after.always_on).toBe(false);
      expect(after.routines).toEqual({ broken: true });
      expect(after.budget).toEqual({ daily_usd: '5' });
      expect(after.heartbeat).toBeUndefined(); // no template defaults materialized
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unparseable config.json is left untouched by the stop write-back', async () => {
    const dir = makeDir();
    try {
      const p = path.join(dir, '.hermit', 'config.json');
      fs.writeFileSync(p, '{"agent_name": "t", "always_on": tru');
      writeRuntime(dir, { runtime_mode: 'tmux' });
      const { bin } = installFakeTmux(dir, { hasSession: false });
      await runStop(dir, [], bin);
      expect(fs.readFileSync(p, 'utf-8')).toBe('{"agent_name": "t", "always_on": tru');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no session, non-interactive → shutdown stamped with cleared transition', async () => {
    const dir = makeDir();
    try {
      writeConfig(dir);
      writeRuntime(dir, { runtime_mode: 'tmux', transition: 'stopping' });
      fs.writeFileSync(path.join(dir, '.hermit', 'sessions', 'S-001-REPORT.md'), '# r');
      const { bin } = installFakeTmux(dir, { hasSession: false });
      const { exitCode, stdout } = await runStop(dir, [], bin);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('No running session: hermit-test');
      expect(fs.existsSync(path.join(dir, '.hermit', 'sessions', 'S-001-REPORT.md'))).toBe(true);
      const rt = readJson(dir, '.hermit/state/runtime.json');
      expect(rt.transition).toBeNull();
      expect(rt.transition_target).toBeNull();
      expect(rt.transition_started_at).toBeNull();
      expect(rt.shutdown_completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/);
      expect(rt.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/);
      expect(readJson(dir, '.hermit/config.json').always_on).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--force with live session → kill-session, unclean_shutdown recorded', async () => {
    const dir = makeDir();
    try {
      writeConfig(dir);
      writeRuntime(dir, { runtime_mode: 'tmux' });
      const { bin, log } = installFakeTmux(dir, { hasSession: true });
      const { exitCode, stdout } = await runStop(dir, ['--force'], bin);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Force-killing session: hermit-test');
      expect(stdout).toContain('resident was force-stopped');
      expect(fs.readFileSync(log, 'utf-8')).toContain('kill-session -t hermit-test');
      const rt = readJson(dir, '.hermit/state/runtime.json');
      expect(rt.last_error).toBe('unclean_shutdown');
      expect(rt.shutdown_requested_at).toBeDefined();
      expect(readJson(dir, '.hermit/config.json').always_on).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('graceful: the queued skill runs and its own turn settles before stop', async () => {
    const dir = makeDir();
    try {
      writeConfig(dir, { shutdown_skill: '/custom:shutdown' });
      residentWithMod(dir);
      fs.writeFileSync(path.join(dir, '.hermit/state/execution.json'), JSON.stringify({ state: 'idle', at: '2026-01-01T00:00:00Z' }));
      const { bin, log } = installFakeTmux(dir, { hasSession: true });
      const stopping = runStop(dir, [], bin);
      const entry = await runQueuedSkill(dir);
      const { exitCode } = await stopping;
      expect(exitCode).toBe(0);
      expect(entry).toMatchObject({ source: 'stop', purpose: 'stop', commands: [{ command: '/custom:shutdown', arg: null }] });
      const tmuxLog = fs.readFileSync(log, 'utf-8');
      expect(tmuxLog).not.toContain('send-keys');
      expect(tmuxLog).toContain('kill-session');
      const rt = readJson(dir, '.hermit/state/runtime.json');
      expect(rt.last_error).toBeNull();
      expect(rt.shutdown_requested_at).toBeDefined();
      expect(rt.shutdown_completed_at).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('graceful: a running turn ends before the shutdown skill is queued', async () => {
    const dir = makeDir();
    try {
      writeConfig(dir, { shutdown_skill: '/custom:shutdown' });
      residentWithMod(dir);
      const executionPath = path.join(dir, '.hermit/state/execution.json');
      fs.writeFileSync(executionPath, JSON.stringify({ state: 'in_flight', at: new Date().toISOString() }));
      const { bin } = installFakeTmux(dir, { hasSession: true });
      let queuedMidTurn = true;
      const turnEnds = new Promise<void>(resolve => setTimeout(() => {
        const queue = path.join(dir, '.hermit/state/harness-queue');
        queuedMidTurn = fs.existsSync(queue) && fs.readdirSync(queue).length > 0;
        fs.writeFileSync(executionPath, JSON.stringify({ state: 'idle', at: new Date().toISOString() }));
        resolve();
      }, 2500));
      const stopping = runStop(dir, [], bin);
      await turnEnds;
      await runQueuedSkill(dir);
      const { exitCode } = await stopping;
      expect(queuedMidTurn).toBe(false);
      expect(exitCode).toBe(0);
      expect(readJson(dir, '.hermit/state/runtime.json').last_error).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('graceful: idle execution needs no shutdown skill', async () => {
    const dir = makeDir();
    try {
      writeConfig(dir);
      writeRuntime(dir, { runtime_mode: 'tmux' });
      fs.writeFileSync(path.join(dir, '.hermit/state/execution.json'), JSON.stringify({ state: 'idle', at: '2026-01-01T00:00:00Z' }));
      const { bin, log } = installFakeTmux(dir, { hasSession: true });
      expect((await runStop(dir, [], bin)).exitCode).toBe(0);
      expect(fs.readFileSync(log, 'utf-8')).not.toContain('send-keys');
      expect(fs.existsSync(path.join(dir, '.hermit/state/harness-queue'))).toBe(false);
      expect(readJson(dir, '.hermit/state/runtime.json').last_error).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.if(IS_TS)('lifecycle lock contention → exit 1, no state mutation', async () => {
    const dir = makeDir();
    try {
      writeConfig(dir);
      writeRuntime(dir, { runtime_mode: 'tmux' });
      const lock = path.join(dir, '.hermit', 'state', '.lifecycle.lock');
      // A real, signalable, same-user holder — a foreign-user pid (EPERM) is no
      // longer treated as a hermit holder, so pid 1 would be taken over.
      const holder = Bun.spawn(['sleep', '30']);
      try {
        fs.writeFileSync(lock, String(holder.pid));
        const { bin } = installFakeTmux(dir, { hasSession: false });
        const { exitCode, stdout } = await runStop(dir, [], bin);
        expect(exitCode).toBe(1);
        expect(stdout).toContain('Another lifecycle operation in progress');
        expect(readJson(dir, '.hermit/config.json').always_on).toBe(true);
      } finally {
        holder.kill();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.if(IS_TS)('--force with a surviving process → orphaned_process, no completion, exit 1', async () => {
    const dir = makeDir();
    // A TERM-ignoring fixture whose pid the fake tmux reports as the pane.
    const ready = path.join(dir, 'survivor-ready');
    const child = spawn('sh', ['-c', `trap "" TERM; : > "${ready}"; while :; do sleep 1; done`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    try {
      writeConfig(dir);
      writeRuntime(dir, { runtime_mode: 'tmux' });
      const { bin } = installFakeTmux(dir, { hasSession: true, panePid: child.pid });
      // Error-path bound, not a speed assertion: under `bun test --parallel` the
      // fixture can take seconds to install its TERM trap, and stopping before the
      // marker exists would kill it outright and mis-report as a missing orphan.
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(ready)).toBe(true);
      const { exitCode, stdout } = await runStop(dir, ['--force'], bin, {
        HERMIT_STOP_GRACE_MS: '50',
        HERMIT_TERM_WAIT_MS: '400',
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('survived stop');
      const rt = readJson(dir, '.hermit/state/runtime.json');
      expect(rt.last_error).toBe('orphaned_process');
      expect(rt.shutdown_completed_at ?? null).toBeNull();
      expect(rt.shutdown_requested_at).toBeDefined();
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
      try { process.kill(child.pid!, 'SIGKILL'); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45000);

  test('no session but fresh liveness → probable orphan, no stamp, exit 1', async () => {
    const dir = makeDir();
    try {
      writeConfig(dir);
      writeRuntime(dir, { runtime_mode: 'tmux' });
      // Fresh liveness signal = an instance may still be alive despite no tmux.
      fs.writeFileSync(path.join(dir, '.hermit', 'state', 'routine-monitor-liveness.json'), '{}');
      const { bin } = installFakeTmux(dir, { hasSession: false });
      const { exitCode, stdout } = await runStop(dir, [], bin);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('detached claude may still be running');
      const rt = readJson(dir, '.hermit/state/runtime.json');
      // Lifecycle truth untouched — not marked stopped.
      expect(rt.shutdown_completed_at ?? null).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('cleanly stopped with fresh liveness exits successfully', async () => {
  const dir = makeDir();
  try {
    writeConfig(dir);
    writeRuntime(dir, { runtime_mode: 'tmux', shutdown_completed_at: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, '.hermit', 'state', 'routine-monitor-liveness.json'), '{}');
    const { bin } = installFakeTmux(dir, { hasSession: false });
    const result = await runStop(dir, [], bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No running session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
