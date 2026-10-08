// bun test port of tests/test-watchdog.sh — black-box tests of
// scripts/hermitd-watchdog.ts, the single-shot watchdog decision flow.
// The watchdog stays a spawned subprocess (it is a standalone script);
// fake tmux/pgrep live as executable stubs in a temp bin dir prepended to PATH
// in the spawn env, driving each branch without live sessions.
//
// Usage: bun test tests/watchdog.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { runScript, SCRIPTS_DIR } from './helpers/run';
import { heartbeatCommand, heartbeatInterval } from '../scripts/lib/heartbeat/monitor-cmd';
import { routineCommand } from '../scripts/lib/routines/arm';
import { freshDirFactory } from './helpers/workdir';
import { transcriptDirFor } from '../scripts/lib/cc-compat';
import {
  inActiveHours, composeRestartMessage, composeWedgeMessage, composeStallQuestionMessage, composeSessionWedgedMessage, composePauseMessage, hasPendingQuestion, hasLapsedLogin, classifyQueueTail, classifyApiFailureTail, classifyStopFailureStamp, composeCompactSteeringMessage,
  rearmDamperOpen, passesLifecycleGuards, setHygieneEval, stampHygieneEval,
  maybeContextCompact, MONITOR_REARM_DAMPER_SECS, type World,
} from '../scripts/hermitd-watchdog';
import { startHttpStub, type Stub } from './helpers/http-stub';
import { localIdentity } from './helpers/registry-fixture';

// The one line to flip when hermitd-watchdog is ported to TypeScript.
// (Absolute bun path via process.execPath: Bun.spawn resolves the executable
// against the child env PATH, which the no-systemctl cases restrict to the
// fake bin dir.)
const WATCHDOG_CMD = [process.execPath, path.join(SCRIPTS_DIR, 'hermitd-watchdog.ts')];

// ---------- fixture scaffolding ----------

interface Hermit {
  dir: string;
  fakeBin: string;
  cleanup(): void;
}

const state = (h: Hermit, ...p: string[]) => path.join(h.dir, '.hermit', 'state', ...p);
const eventsFile = (h: Hermit) => state(h, 'watchdog-events.jsonl');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

const { freshDir, cleanup } = freshDirFactory('hermit-watchdog-');
afterAll(cleanup);

/** Standard hermit project fixture: in_progress always-on tmux session. */
function setupHermit(): Hermit {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hermit', 'bin'), { recursive: true });

  fs.writeFileSync(path.join(dir, '.hermit', 'state', 'runtime.json'), JSON.stringify({
    version: 1,
    runtime_mode: 'tmux',
    tmux_session: 'hermit-test',
    shutdown_requested_at: null,
    shutdown_completed_at: null,
    last_error: null,
    updated_at: '2026-01-01T00:00:00+0000',
  }, null, 2) + '\n');

  fs.writeFileSync(state({ dir } as Hermit, 'execution.json'), JSON.stringify({
    state: 'idle', cc_session_id: 'resident-boundary', at: new Date(Date.now() - 61000).toISOString(),
  }));
  const initialRuntime = JSON.parse(fs.readFileSync(state({ dir } as Hermit, 'runtime.json'), 'utf8'));
  initialRuntime.cc_session_id = 'resident-boundary';
  fs.writeFileSync(state({ dir } as Hermit, 'runtime.json'), JSON.stringify(initialRuntime));

  // Stub hermitd-start: writes a marker so we can detect invocation
  const start = path.join(dir, '.hermit', 'bin', 'hermitd-start');
  fs.writeFileSync(start, `#!/usr/bin/env bash\necho "$@" > "${dir}/hermit-start-args"\necho "hermitd-start called" > "${dir}/hermit-start-called"\n`);
  fs.chmodSync(start, 0o755);

  // Stub bin dir on PATH for fake tmux + pgrep
  const fakeBin = path.join(dir, 'fake-bin');
  fs.mkdirSync(fakeBin);

  return {
    dir, fakeBin,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function writeConfig(h: Hermit, every = '2h', watchdogExtra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m', ...watchdogExtra },
    heartbeat: {
      enabled: true, every,
      active_hours: { start: '00:00', end: '23:59' },
      stale_threshold: '2h',
    },
  }, null, 2) + '\n');
}

function patchRuntime(h: Hermit, patch: Record<string, unknown>): void {
  const p = state(h, 'runtime.json');
  fs.writeFileSync(p, JSON.stringify({ ...readJson(p), ...patch }) + '\n');
}

/** Fake tmux: sessionAlive 0 = alive, 1 = dead. send-keys/kill-session log to tmux-calls.log.
 *  runtimeSnapshotPath: if set, the stub copies runtime.json to this path when it sees send-keys .../clear,
 *  proving the context_cleared marker was written before the /clear keystroke. */
function writeFakeTmux(h: Hermit, sessionAlive: 0 | 1, paneContent = 'tmux pane content', runtimeSnapshotPath?: string): void {
  const log = path.join(h.dir, 'tmux-calls.log');
  const stub = path.join(h.fakeBin, 'tmux');
  const runtimePath = state(h, 'runtime.json');
  const sendKeysExtra = [
    runtimeSnapshotPath ? `[[ "$*" == *"/clear"* || "$*" == *"/compact"* ]] && cat "${runtimePath}" > "${runtimeSnapshotPath}"` : '',
  ].filter(Boolean).join(' ; ') || 'true';
  fs.writeFileSync(stub, `#!/usr/bin/env bash
case "$1" in
  has-session) exit ${sessionAlive} ;;
  capture-pane) echo "${paneContent}" ;;
  send-keys) echo "send-keys $@" >> "${log}" ; ${sendKeysExtra} ;;
  kill-session) echo "kill-session $@" >> "${log}" ;;
esac
`);
  fs.chmodSync(stub, 0o755);
}

/** Fake pgrep: found 0 = found, 1 = not found. */
function writeFakePgrep(h: Hermit, found: 0 | 1): void {
  const stub = path.join(h.fakeBin, 'pgrep');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\nexit ${found}\n`);
  fs.chmodSync(stub, 0o755);
}

/** Backdate a file's mtime by `seconds` (creating it empty if absent). */
function touchAgo(p: string, seconds: number): void {
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(p, t, t);
}

const isoAgo = (hours: number) =>
  new Date(Date.now() - hours * 3600_000).toISOString();
const isoAgoSeconds = (hours: number) =>
  new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Spawn the watchdog. restrictPath limits PATH to the fake bin dir (no systemctl).
 *  preload inserts a `--preload <path>` module ahead of the script, used to force
 *  process.platform for the darwin-gated launchd install branch on Linux CI. */
async function watchdog(h: Hermit, sub: string, opts: { restrictPath?: boolean; env?: Record<string, string>; preload?: string } = {}) {
  const proc = Bun.spawn({
    cmd: opts.preload
      ? [process.execPath, '--preload', opts.preload, ...WATCHDOG_CMD.slice(1), sub]
      : [...WATCHDOG_CMD, sub],
    cwd: h.dir,
    env: {
      ...process.env,
      PATH: opts.restrictPath ? h.fakeBin : `${h.fakeBin}:${process.env.PATH}`,
      ...opts.env,
    },
    stdin: Buffer.from(''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Run a test body against a throwaway hermit fixture, always cleaning up. */
function withHermit(fn: (h: Hermit) => Promise<void> | void) {
  return async () => {
    const h = setupHermit();
    try { await fn(h); } finally { h.cleanup(); }
  };
}

/**
 * doRestart spawns hermitd-start `detached` and `unref`s it, so the marker the stub
 * writes lands only after a fork, an exec of bash, and a write — none of which the
 * watchdog process waits for before exiting. A bare existsSync right after the await
 * is racing that chain and wins only while the runner is idle; it loses on a loaded
 * one (macOS CI, 2026-08-30). Poll instead. Only the positive assertion can use this:
 * waiting for an absence is just a sleep, so the no-spawn paths keep asserting the
 * `restart-aborted` event, which is written synchronously.
 *
 * 20s matches the deadline `harness-command-delivery`, `proc-survivor` and
 * `hermitd-stop` already converged on for this same shape, and callers pair it with a
 * 45s per-test timeout because Bun's `--timeout` does not extend an in-test
 * `Date.now()` deadline — without the override the poll is unreachable under the 5s
 * default a local `bun test` uses.
 */
async function waitForStartMarker(h: Hermit, timeoutMs = 20_000): Promise<boolean> {
  const marker = path.join(h.dir, 'hermit-start-called');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) return true;
    await Bun.sleep(25);
  }
  return fs.existsSync(marker);
}

// -------------------------------------------------------
// 1. Config gate: watchdog.enabled false → no-op
// -------------------------------------------------------

test('watchdog disabled → exit 0, no events', withHermit(async (h) => {
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'),
    '{"watchdog": {"enabled": false}}\n');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 2. Resting resident with no due recovery
// -------------------------------------------------------

test('idle session → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 3. Shutdown gate: shutdown_completed_at set → no-op
// -------------------------------------------------------

test('shutdown_completed_at set → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { shutdown_completed_at: '2026-06-10T04:00:00Z' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 4. Interactive mode → skip
// -------------------------------------------------------

test('interactive mode → exit 0, no events', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { runtime_mode: 'interactive' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h))).toBe(false);
}));

// -------------------------------------------------------
// 5. Dead session → restart
// -------------------------------------------------------

describe('dead session', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    // tmux has-session returns 1 (dead)
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('dead session → restart event written', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
  });

  test('dead session → restart reason dead-process', () => {
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('dead-process');
  });

  test('dead session → runtime.json last_error set', () => {
    const d = readJson(state(h, 'runtime.json'));
    expect(d.last_error).toBe('unclean_shutdown');
    expect(d.watchdog_restart_reason).toBe('dead-process');
  });
});

// -------------------------------------------------------
// 5d. Dead session + FRESH shared liveness → orphan, abort restart
// -------------------------------------------------------

// -------------------------------------------------------
// 5c-bis. Committing a staged claude.ai sign-in inside the restart boundary
// -------------------------------------------------------

describe('staged credential commit', () => {
  /** A staging dir holding a sign-in, plus the pointer the mint leaves behind. */
  function stage(h: Hermit, accessToken: string, stagedAt = new Date().toISOString()): { configDir: string; stagedDir: string } {
    const configDir = path.join(h.dir, 'claude-config');
    const stagedDir = path.join(configDir, '.hermit-login-staging');
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'old-one', refreshToken: 'r' } }),
    );
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'old@x' } }));
    fs.writeFileSync(
      path.join(stagedDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'r2', refreshTokenExpiresAt: 42 } }),
    );
    fs.writeFileSync(path.join(stagedDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'new@x' } }));
    fs.writeFileSync(
      state(h, 'pending-credential.json'),
      JSON.stringify({ staged_dir: stagedDir, staged_at: stagedAt }),
    );
    return { configDir, stagedDir };
  }

  test('a usable staged sign-in replaces the live credential and parks the old one', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1); // dead session → restart path
    writeFakePgrep(h, 1);
    const { configDir, stagedDir } = stage(h, 'sk-ant-oat01-freshfreshfresh');
    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' } });
    expect(r.exitCode).toBe(0);

    const live = readJson(path.join(configDir, '.credentials.json'));
    expect(live.claudeAiOauth.accessToken).toBe('sk-ant-oat01-freshfreshfresh');
    // Parked, not destroyed — a deliberate rollback has something to go back to.
    expect(readJson(path.join(configDir, '.credentials.json.pre-login.bak')).claudeAiOauth.accessToken).toBe('old-one');
    // `claude auth status` reads the identity from .claude.json, not the credential
    // file, so a commit that moved only the credential would report the old account.
    expect(readJson(path.join(configDir, '.claude.json')).oauthAccount.emailAddress).toBe('new@x');
    expect(fs.existsSync(stagedDir)).toBe(false);
    expect(fs.existsSync(state(h, 'pending-credential.json'))).toBe(false);
    expect(readJson(path.join(h.dir, '.hermit', 'config.json')).auth_mode).toBe('login');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('credential-committed');
  }));

  test('a staged sign-in commits oauthAccount to ~/.claude.json when CLAUDE_CONFIG_DIR is unset', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    const { configDir } = stage(h, 'sk-ant-oat01-freshfreshfresh');
    const home = path.join(h.dir, 'home');
    fs.mkdirSync(home);
    fs.renameSync(configDir, path.join(home, '.claude'));
    const stagedDir = path.join(home, '.claude/.hermit-login-staging');
    fs.writeFileSync(state(h, 'pending-credential.json'), JSON.stringify({ staged_dir: stagedDir, staged_at: new Date().toISOString() }));
    const liveState = path.join(home, '.claude.json');
    fs.writeFileSync(liveState, JSON.stringify({ projects: {}, oauthAccount: { emailAddress: 'old@x' } }));
    const nestedState = path.join(home, '.claude/.claude.json');
    const before = fs.readFileSync(nestedState, 'utf8');
    const r = await watchdog(h, 'run', { env: { HOME: home, CLAUDE_CONFIG_DIR: '', CLAUDE_CODE_OAUTH_TOKEN: '' } });
    expect(r.exitCode).toBe(0);
    expect(readJson(liveState)).toEqual({ projects: {}, oauthAccount: { emailAddress: 'new@x' } });
    expect(fs.readFileSync(nestedState, 'utf8')).toBe(before);
    expect(readJson(path.join(home, '.claude/.credentials.json')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-freshfreshfresh');
    expect(fs.readFileSync(eventsFile(h), 'utf8')).toContain('credential-committed');
  }));

  test('a staged file that lapsed while waiting is dropped, live untouched', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    const { configDir, stagedDir } = stage(h, ''); // the lapse stub
    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' } });
    expect(r.exitCode).toBe(0);

    expect(readJson(path.join(configDir, '.credentials.json')).claudeAiOauth.accessToken).toBe('old-one');
    expect(fs.existsSync(path.join(configDir, '.credentials.json.pre-login.bak'))).toBe(false);
    expect(fs.existsSync(stagedDir)).toBe(false);
    expect(fs.existsSync(state(h, 'pending-credential.json'))).toBe(false);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('credential-commit-skipped');
    expect(events).not.toContain('credential-committed');
  }));

  // `usable` only says the file carries a token, so an abandoned staging still reads
  // usable weeks later. Committing one on some unrelated restart would park a working
  // credential in favour of a sign-in that expired while nobody was looking.
  test('a staging whose restart never came is dropped, not committed later', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    const stale = new Date(Date.now() - 5 * 3600_000).toISOString();
    const { configDir, stagedDir } = stage(h, 'sk-ant-oat01-freshfreshfresh', stale);
    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' } });
    expect(r.exitCode).toBe(0);

    expect(readJson(path.join(configDir, '.credentials.json')).claudeAiOauth.accessToken).toBe('old-one');
    expect(fs.existsSync(path.join(configDir, '.credentials.json.pre-login.bak'))).toBe(false);
    // Cleared, so the mint's "one staged sign-in at a time" guard stops refusing.
    expect(fs.existsSync(stagedDir)).toBe(false);
    expect(fs.existsSync(state(h, 'pending-credential.json'))).toBe(false);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('credential-commit-skipped');
    expect(events).not.toContain('credential-committed');
  }));

  // The commit sits after the survivors check for a reason: an aborted restart means
  // the old session is still running and still refreshing the file we would overwrite.
  test('an aborted restart commits nothing', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    fs.writeFileSync(state(h, 'routine-monitor-liveness.json'), '{}'); // orphan guard trips
    const { configDir, stagedDir } = stage(h, 'sk-ant-oat01-freshfreshfresh');
    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' } });
    expect(r.exitCode).toBe(0);

    expect(readJson(path.join(configDir, '.credentials.json')).claudeAiOauth.accessToken).toBe('old-one');
    expect(fs.existsSync(stagedDir)).toBe(true);
    expect(fs.existsSync(state(h, 'pending-credential.json'))).toBe(true);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).not.toContain('credential-commit');
  }));
});

describe('dead session with fresh liveness (orphan guard)', () => {
  test('fresh liveness + no tmux → restart aborted, no hermitd-start spawned', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1); // dead
    writeFakePgrep(h, 1);
    // A fresh monitor-liveness file = an instance is still writing state.
    fs.writeFileSync(state(h, 'routine-monitor-liveness.json'), '{}');
    const { exitCode } = await watchdog(h, 'run');
    expect(exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('restart-aborted');
    expect(events).toContain('liveness-fresh-no-tmux');
    // No replacement spawned, and the restart reason is never stamped.
    expect(fs.existsSync(path.join(h.dir, 'hermit-start-called'))).toBe(false);
    expect(readJson(state(h, 'runtime.json')).watchdog_restart_reason ?? null).toBeNull();
    expect(readJson(state(h, 'watchdog-state.json')).orphan_notified).toBe(true);
  }));

  test('stale liveness + no tmux → normal restart (stale proves nothing)', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    touchAgo(state(h, 'routine-monitor-liveness.json'), 3600); // 1h old ≫ 600s
    const { exitCode } = await watchdog(h, 'run');
    expect(exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('dead-process');
    expect(events).not.toContain('restart-aborted');
    expect(await waitForStartMarker(h)).toBe(true);
  }), 45000);
});

// -------------------------------------------------------
// 5a. Re-auth relay (setup-token expiry)
// -------------------------------------------------------

/** Put the fixture in setup-token mode with a record expiring `days` from now. */
function writeSetupToken(h: Hermit, days: number, opts: { installFile?: boolean } = {}): string {
  const configDir = path.join(h.dir, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  if (opts.installFile !== false) {
    fs.writeFileSync(path.join(configDir, '.hermit-setup-token'), 'sk-ant-oat01-testtesttesttesttest\n', { mode: 0o600 });
  }
  fs.writeFileSync(state(h, 'setup-token.json'), JSON.stringify({
    minted_at: isoAgo(24),
    expires_at: new Date(Date.now() + days * 86400_000).toISOString(),
  }));
  return configDir;
}

const relayMarker = (h: Hermit) => state(h, 'reauth-relay.json');

describe('re-auth relay', () => {
  test('expired setup-token → relay spawned, wedge tiers suppressed', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, -1);
    // Heartbeat old enough that a nudge would normally fire — proving the relay
    // suppresses it rather than merely running before it.
    touchAgo(state(h, '.heartbeat'), 6 * 3600);

    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('reauth-relay');
    expect(events).not.toContain('nudge');
  }));

  test('valid setup-token → no relay', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, 200);
    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('reauth-relay');
  }));

  // A leftover record on a hermit that no longer uses token auth must not
  // trigger a renewal for a credential it isn't using.
  test('expired record but no token installed → no relay', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, -1, { installFile: false });
    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('reauth-relay');
  }));

  // The operator can legitimately take hours to reach a browser, so an in-flight
  // relay is identified by a live PID, not by marker age.
  test('live relay marker → no second relay spawned', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, -1);
    fs.writeFileSync(relayMarker(h), JSON.stringify({
      pid: process.pid, mode: 'relay', stage: 'awaiting-ack',
      started_at: isoAgo(5), updated_at: isoAgo(5),
    }));

    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('relay spawned');
    expect(fs.existsSync(relayMarker(h))).toBe(true);
  }));

  // A crashed relay must not permanently disable recovery.
  test('dead relay marker → cleared and a fresh relay spawned', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeSetupToken(h, -1);
    // PID 2^22 is above the default pid_max — reliably not a running process.
    fs.writeFileSync(relayMarker(h), JSON.stringify({
      pid: 4194304, mode: 'relay', stage: 'awaiting-ack',
      started_at: isoAgo(1), updated_at: isoAgo(1),
    }));

    const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('cleared stale marker');
    expect(events).toContain('relay spawned');
  }));
});

// -------------------------------------------------------
// 5c. restart subcommand — the shared post-renewal bounce
// -------------------------------------------------------

describe('restart subcommand', () => {
  test('restart <reason> → doRestart path runs with that reason', withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'restart', { env: {} });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('restart');
    expect(await waitForStartMarker(h)).toBe(true);
  }), 45000);
});

// -------------------------------------------------------
// 5b. Dead session + channel configured → restart push actually reaches it
//     (deterministic channel voice: the watchdog reaches channel-send via
//     spawnSync with no cwd override, so this also proves HERMIT_ROOT — a
//     relative path — resolves correctly through that child process boundary)
// -------------------------------------------------------

function configureChannel(h: Hermit): void {
  const p = path.join(h.dir, '.hermit', 'config.json');
  const cfg = readJson(p);
  cfg.timezone = 'UTC';
  cfg.channels = { telegram: { enabled: true, dm_channel_id: '12345', state_dir: '.claude.local/channels/telegram' } };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  const stateDir = path.join(h.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
}

function configureMaintainerChannel(h: Hermit): void {
  configureChannel(h);
  const p = path.join(h.dir, '.hermit', 'config.json');
  const cfg = readJson(p);
  cfg.channels.telegram.maintainer_channel_id = '99999';
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

describe('watchdog state-write failure', () => {
  for (const lastStartError of [null, 'resident-missing']) {
    test(`notifies each tick and recovers after permissions return (${lastStartError})`, withHermit(async (h) => {
      writeConfig(h);
      configureChannel(h);
      patchRuntime(h, { last_start_error: lastStartError });
      writeFakeTmux(h, 1);
      writeFakePgrep(h, 1);
      const runtimeBefore = fs.readFileSync(state(h, 'runtime.json'), 'utf8');
      const stub = startHttpStub();
      const env = { HERMIT_TELEGRAM_API_URL: stub.url };
      fs.chmodSync(state(h), 0o500);
      try {
        // Prove permissions actually deny writes for the executing user.
        expect(() => fs.writeFileSync(state(h, 'write-probe'), '')).toThrow();
        for (let tick = 1; tick <= 2; tick++) {
          const r = await watchdog(h, 'run', { env });
          expect(r.exitCode).toBe(0);
          expect(r.stderr).toContain('[watchdog] fatal:');
          expect(r.stderr).toContain('EACCES');
          expect(stub.requests.length).toBe(tick);
          expect(stub.requests[tick - 1].body.text).toContain('Watchdog failed');
          expect(stub.requests[tick - 1].body.text).toContain('EACCES');
          expect(fs.readFileSync(state(h, 'runtime.json'), 'utf8')).toBe(runtimeBefore);
          expect(fs.existsSync(path.join(h.dir, 'hermit-start-called'))).toBe(false);
        }
        fs.chmodSync(state(h), 0o700);
        fs.writeFileSync(path.join(h.dir, '.hermit', 'RESIDENT.md'), '# Resident');
        const recovered = await watchdog(h, 'run', { env });
        expect(recovered.exitCode).toBe(0);
        expect(recovered.stderr).not.toContain('[watchdog] fatal:');
        expect(await waitForStartMarker(h)).toBe(true);
        expect(stub.requests.length).toBe(3);
        expect(stub.requests[2].body.text).not.toContain('Watchdog failed');
      } finally {
        fs.chmodSync(state(h), 0o700);
        stub.stop();
      }
    }), 45000);
  }

  test('notification failure still exits zero', withHermit(async (h) => {
    writeConfig(h);
    configureChannel(h);
    const stub = startHttpStub();
    stub.setStatus(403);
    fs.chmodSync(state(h), 0o500);
    try {
      expect(() => fs.writeFileSync(state(h, 'write-probe'), '')).toThrow();
      const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('[watchdog] fatal:');
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.text).toContain('Watchdog failed');
    } finally {
      fs.chmodSync(state(h), 0o700);
      stub.stop();
    }
  }));

  test('successful initial write preserves fields and updates both timestamps', withHermit(async (h) => {
    writeConfig(h, '2h', { enabled: false });
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    const oldStamp = '2026-01-01T00:00:00Z';
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      last_run: oldStamp, last_check_at: oldStamp, consecutive_stale: 2,
    }));
    expect((await watchdog(h, 'run')).exitCode).toBe(0);
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.consecutive_stale).toBe(2);
    expect(Date.parse(ws.last_run)).toBeGreaterThan(Date.parse(oldStamp));
    expect(Date.parse(ws.last_check_at)).toBeGreaterThan(Date.parse(oldStamp));
  }));
});

describe('dead session with channel configured', () => {
  let h: Hermit;
  let stub: Stub;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    configureChannel(h);
    writeFakeTmux(h, 1);
    writeFakePgrep(h, 1);
    stub = startHttpStub();
    ({ exitCode } = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } }));
  });

  afterAll(() => { stub.stop(); h.cleanup(); });

  test('restart still fires', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
  });

  test('the restart push reaches the configured channel', () => {
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain("wasn't running");
  });
});

// -------------------------------------------------------
// 5c. Stall-question detection (un-redirectable, PROP-024) — catches the
//     remainder ask-gate.ts's PreToolUse deny can't reach: native permission
//     dialogs, harness-rendered prompts. Fixtures from a real capture
//     (compiled/spike-ask-gate-probe-2026-07-05.md): a pointer-marked
//     numbered option plus an "Esc to cancel" footer.
// -------------------------------------------------------

const PENDING_QUESTION_PANE =
  ' Which color do you prefer?\n\n❯ 1. Red\n  2. Green\n  3. Blue\n\nEnter to select · Esc to cancel';

// CC 2.1.257's held-peer-message dialog, captured verbatim from a live probe: a
// bypassPermissions guest messaging a prompting session. It carries neither footer
// spelling — the pane ends on the dialog's own last option.
const HELD_PEER_MESSAGE_PANE = [
  ' Held message from another session',
  '  Another Claude session sent a message: from uds:/run/user/1000/cc-socks/2387465.sock',
  '  The sending session\'s permission mode class doesn\'t match this session\'s, so it wasn\'t delivered automatically.',
  '  Message body (this is what will be delivered):',
  '  «Probe ping X1 from a bypass guest: no action needed, do not reply.»',
  '  ❯ Deny — drop it and tell the sender it was declined',
  '    Deliver this message to Claude',
].join('\n');

// CC 2.1.233's first-run wizard, captured verbatim. The selector is "❯ Continue" — no digit,
// which is precisely what the old numbered-option regex could not see.
const AUTO_MODE_WIZARD_PANE = [
  '   Set up auto mode for your environment?',
  '',
  '   Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other repositories.',
  '',
  '     How you use Claude here    ◀ Mixed ▶',
  '     Also scan shell history    [✔]',
  '     Also scan your other repos [ ]',
  '',
  '   ❯ Continue',
  '',
  '   ←/→ to change usage · Enter to continue · Esc to cancel',
].join('\n');

describe('hasPendingQuestion tail-scan (#8 false-positive guard)', () => {
  test('a genuine modal at the bottom of the pane matches', () => {
    expect(hasPendingQuestion(PENDING_QUESTION_PANE)).toBe(true);
  });

  test('the CC 2.1.233 auto-mode setup wizard matches (live wedge regression)', () => {
    expect(hasPendingQuestion(AUTO_MODE_WIZARD_PANE)).toBe(true);
  });

  test('the wizard still matches with blank terminal rows below it', () => {
    expect(hasPendingQuestion(`${AUTO_MODE_WIZARD_PANE}${'\n'.repeat(20)}`)).toBe(true);
  });

  test('a dialog whose only footer is "Enter to continue" matches', () => {
    // A wizard step that cannot be cancelled omits the Esc affordance entirely.
    expect(hasPendingQuestion('   Set up something?\n\n   ❯ Continue\n\n   Enter to continue')).toBe(true);
  });

  test('an idle composer prompt does NOT match', () => {
    // The pointer glyph also opens the composer; the status bar, not a dialog footer,
    // terminates the pane there.
    const idle = 'Boot summary\n  - Session: idle\n\n❯ Try "how does <filepath> work?"\n\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
    expect(hasPendingQuestion(idle)).toBe(false);
  });

  test('a held peer message is a pending question', () => {
    expect(hasPendingQuestion(HELD_PEER_MESSAGE_PANE)).toBe(true);
  });

  test('a held peer message still matches with blank terminal rows below it', () => {
    expect(hasPendingQuestion(`${HELD_PEER_MESSAGE_PANE}\n${'\n'.repeat(20)}`)).toBe(true);
  });

  test('a genuine modal still matches with blank terminal rows below it', () => {
    // Claude 2.1.220 leaves the unused rows of a 50-line pane blank below a
    // short native permission dialog. capture-pane includes those rows.
    expect(hasPendingQuestion(`${PENDING_QUESTION_PANE}\n${'\n'.repeat(20)}`)).toBe(true);
  });

  test('the same tokens in scrollback, followed by clean output, do NOT match', () => {
    // A menu / quoted output that scrolled up, then 20 lines of ordinary activity.
    const scrollback = '❯ 1. Red\nEsc to cancel\n' + Array.from({ length: 20 }, (_, i) => `running step ${i}...`).join('\n');
    expect(hasPendingQuestion(scrollback)).toBe(false);
  });

  test('stale modal followed by short progress and blank terminal rows does NOT match', () => {
    const progress = Array.from({ length: 6 }, (_, i) => `running step ${i}...`).join('\n');
    expect(hasPendingQuestion(`${PENDING_QUESTION_PANE}\n${progress}${'\n'.repeat(20)}`)).toBe(false);
  });

  test('ordinary output that merely quotes one token does not match', () => {
    expect(hasPendingQuestion('the docs say to press Esc to cancel a running task\nall done')).toBe(false);
  });
});

// -------------------------------------------------------
// 3c. Queue-liveness wedge detection — the shape-independent net behind 3b.
//     Fixture shape is the live 2026-08-17 incident: monitor notifications
//     enqueued and never dequeued while the session sat behind a dialog.
// -------------------------------------------------------

const NOW = Date.parse('2026-08-17T14:00:00Z');
const queueRec = (operation: string, iso: string) =>
  JSON.stringify({ type: 'queue-operation', operation, timestamp: iso, sessionId: 'sess-1' });

describe('classifyQueueTail', () => {
  test('enqueue older than the threshold with no dequeue → wedged', () => {
    const tail = [
      queueRec('enqueue', '2026-08-17T07:30:00Z'),
      queueRec('enqueue', '2026-08-17T08:00:00Z'),
    ].join('\n');
    expect(classifyQueueTail(tail, NOW)).toBe('wedged');
  });

  test('a dequeue after the last enqueue → draining', () => {
    const tail = [
      queueRec('enqueue', '2026-08-17T07:30:00Z'),
      queueRec('dequeue', '2026-08-17T07:30:01Z'),
    ].join('\n');
    expect(classifyQueueTail(tail, NOW)).toBe('draining');
  });

  test('a recent enqueue still within the threshold → draining (not yet a wedge)', () => {
    expect(classifyQueueTail(queueRec('enqueue', '2026-08-17T13:50:00Z'), NOW)).toBe('draining');
  });

  test('a transcript with no queue records → unknown (fail-open)', () => {
    const tail = '{"type":"assistant","timestamp":"2026-08-17T13:00:00Z"}\n{"type":"mode","mode":"normal"}';
    expect(classifyQueueTail(tail, NOW)).toBe('unknown');
  });

  test('a truncated leading line (byte-offset tail read) is skipped, not fatal', () => {
    const tail = `p":"2026-08-17T06:00:00Z"}\n${queueRec('enqueue', '2026-08-17T08:00:00Z')}`;
    expect(classifyQueueTail(tail, NOW)).toBe('wedged');
  });
});

// Fixture texts are the six real shapes CC emits, captured from live isApiErrorMessage
// records under ~/.claude/projects. Structural fields (isApiErrorMessage, message.model)
// match the real record shape verbatim.
const apiErrorRec = (text: string, ts = '2026-08-17T13:59:00Z') => JSON.stringify({
  type: 'assistant', timestamp: ts, isApiErrorMessage: true,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
});
const healthyRec = (text: string, ts = '2026-08-17T13:59:30Z') => JSON.stringify({
  type: 'assistant', timestamp: ts,
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
});

describe('classifyApiFailureTail', () => {
  test('usage limit, real text → usage-limit with parsed reset time', () => {
    const tail = apiErrorRec("You've hit your session limit · resets 2:30am (Europe/Lisbon)");
    expect(classifyApiFailureTail(tail)).toEqual({ kind: 'usage-limit', resetAt: '2:30am' });
  });

  test('login expired, real text → null (owned by the lapsed-login tier)', () => {
    const tail = apiErrorRec('Login expired · Please run /login');
    expect(classifyApiFailureTail(tail)).toBeNull();
  });

  test('529 overload, real text → api-unavailable', () => {
    const tail = apiErrorRec('API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.');
    expect(classifyApiFailureTail(tail)).toEqual({ kind: 'api-unavailable' });
  });

  test('500 internal, real text → api-unavailable', () => {
    const tail = apiErrorRec('API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.');
    expect(classifyApiFailureTail(tail)).toEqual({ kind: 'api-unavailable' });
  });

  test('401 invalid key, real text → null (owned by the env-auth tier)', () => {
    const tail = apiErrorRec('Please run /login · API Error: 401 Invalid API key.');
    expect(classifyApiFailureTail(tail)).toBeNull();
  });

  test('mid-response server error, real text → api-unavailable', () => {
    const tail = apiErrorRec('API Error: Server error mid-response. The response above may be incomplete.');
    expect(classifyApiFailureTail(tail)).toEqual({ kind: 'api-unavailable' });
  });

  test('a normal assistant message quoting the full 529 sentence verbatim → null', () => {
    // The case a pane regex could not have passed: real model id, isApiErrorMessage absent.
    const tail = healthyRec('The proposal quotes: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com."');
    expect(classifyApiFailureTail(tail)).toBeNull();
  });

  test('a healthy record newer than the failure → null', () => {
    const tail = [
      apiErrorRec('API Error: 529 Overloaded.', '2026-08-17T13:58:00Z'),
      healthyRec('Back to normal work.', '2026-08-17T13:59:00Z'),
    ].join('\n');
    expect(classifyApiFailureTail(tail)).toBeNull();
  });

  test('usage limit whose text carries no parseable reset clause → resetAt null', () => {
    const tail = apiErrorRec("You've hit your session limit for now.");
    expect(classifyApiFailureTail(tail)).toEqual({ kind: 'usage-limit', resetAt: null });
  });

  test('no assistant records at all → null', () => {
    expect(classifyApiFailureTail('{"type":"mode","mode":"normal"}')).toBeNull();
  });

  // CC's limit line is `You've hit your ${label}…` over a fixed label vocabulary
  // (session / weekly / Opus / Sonnet / Fable / individual usage / individual spend /
  // usage credit / monthly spend). A label-specific match left the weekly lockout —
  // the multi-day one — silent.
  test.each([
    'weekly limit', 'Opus limit', 'Sonnet limit', 'Fable limit',
    'individual usage limit', 'usage credit limit', 'monthly spend limit',
  ])('non-session limit label (%s) → usage-limit', (label) => {
    const tail = apiErrorRec(`You've hit your ${label} · resets 2:30am (Europe/Lisbon)`);
    expect(classifyApiFailureTail(tail)).toEqual({ kind: 'usage-limit', resetAt: '2:30am' });
  });

  test('reset capture stops at the subline instead of swallowing it', () => {
    const tail = apiErrorRec("You've hit your session limit · resets 2:30am, or switch models to keep working.");
    expect(classifyApiFailureTail(tail)).toEqual({ kind: 'usage-limit', resetAt: '2:30am' });
  });
});

// The same verdict from CC's own typed category instead of rendered error text.
// Shapes match what stop-failure-stamp.ts writes from a StopFailure payload.
describe('classifyStopFailureStamp', () => {
  const stamp = (error: unknown, last_assistant_message = '') =>
    ({ error, session_id: 'x', at: '2026-08-17T13:59:00+0000', last_assistant_message });

  test('rate_limit whose message carries the limit line → usage-limit with parsed reset', () => {
    expect(classifyStopFailureStamp(stamp('rate_limit', "You've hit your session limit · resets 2:30am (Europe/Lisbon)")))
      .toEqual({ kind: 'usage-limit', resetAt: '2:30am' });
  });

  test('rate_limit limit line without a reset clause → resetAt null', () => {
    expect(classifyStopFailureStamp(stamp('rate_limit', "You've hit your session limit for now.")))
      .toEqual({ kind: 'usage-limit', resetAt: null });
  });

  // Upstream throttling shares the category with a usage lockout, so the message
  // is what separates "you are out of budget" from "the API is busy".
  test('rate_limit without the limit line → api-unavailable', () => {
    expect(classifyStopFailureStamp(stamp('rate_limit', 'API Error: 429 Too Many Requests')))
      .toEqual({ kind: 'api-unavailable' });
  });

  test('overloaded → api-unavailable', () => {
    expect(classifyStopFailureStamp(stamp('overloaded'))).toEqual({ kind: 'api-unavailable' });
  });

  test('server_error → api-unavailable', () => {
    expect(classifyStopFailureStamp(stamp('server_error'))).toEqual({ kind: 'api-unavailable' });
  });

  test('a category this tier does not own → null', () => {
    expect(classifyStopFailureStamp(stamp('model_not_found', 'It may not exist.'))).toBeNull();
  });

  // The docs spell the key `error_type`; the live payload uses `error`. A stamp
  // carrying only the documented spelling classifies as null, which leaves the
  // transcript tail to answer rather than inventing a category.
  test('the documented error_type spelling alone → null', () => {
    expect(classifyStopFailureStamp({ error_type: 'overloaded', at: '2026-08-17T13:59:00+0000' })).toBeNull();
  });

  test('a missing error key → null', () => {
    expect(classifyStopFailureStamp({ at: '2026-08-17T13:59:00+0000' })).toBeNull();
  });
});

/** Seed a transcript for CC transcript id `transcriptId` under a sandboxed HOME, and point
 *  runtime.json's `cc_session_id` at it, matching the `<uuid>.jsonl` file CC writes.
 *
 *  `configDir` seeds the file under a config dir other than the sandboxed HOME's ~/.claude;
 *  the caller is then responsible for stamping runtime.json's `config_dir`, since the
 *  returned env deliberately leaves CLAUDE_CONFIG_DIR blank (the host-install shape).
 *  Blanking matters beyond realism: runScript merges process.env, so a maintainer running
 *  the suite with their own config dir set would send the reader off the fixture entirely. */
function seedTranscript(
  h: Hermit, transcriptId: string, lines: string[], configDir?: string,
): Record<string, string> {
  const home = path.join(h.dir, 'fake-home');
  const dir = transcriptDirFor(h.dir, configDir ?? path.join(home, '.claude'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${transcriptId}.jsonl`), lines.join('\n') + '\n');
  const runtimePath = state(h, 'runtime.json');
  fs.writeFileSync(runtimePath, JSON.stringify(
    { ...readJson(runtimePath), cc_session_id: transcriptId }, null, 2) + '\n');
  const executionPath = state(h, 'execution.json');
  fs.writeFileSync(executionPath, JSON.stringify({ ...readJson(executionPath), cc_session_id: transcriptId }));
  return { HOME: home, CLAUDE_CONFIG_DIR: '' };
}

describe('session-wedged detection (queued notifications not draining)', () => {
  let h: Hermit;
  let stub: Stub;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    configureChannel(h);
    writeFakeTmux(h, 0, 'ordinary pane output\nno dialog here');
    writeFakePgrep(h, 1);
    stub = startHttpStub();
    const env = seedTranscript(h, 'sess-wedged', [
      queueRec('enqueue', isoAgoSeconds(50)),
      queueRec('enqueue', isoAgoSeconds(2)),
    ]);
    ({ exitCode } = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } }));
  });

  afterAll(() => { stub.stop(); h.cleanup(); });

  test('stale enqueue tail → session-wedged event', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('session-wedged');
  });

  test('stale enqueue tail → watchdog-state flags session_wedged_notified', () => {
    expect(readJson(state(h, 'watchdog-state.json')).session_wedged_notified).toBe(true);
  });

  test('stale enqueue tail → exactly one operator push', () => {
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain('scheduled work');
  });

  test('alert-only: no keystrokes and no kill were sent to the pane', () => {
    const calls = fs.existsSync(path.join(h.dir, 'tmux-calls.log'))
      ? fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')
      : '';
    expect(calls).not.toContain('send-keys');
    expect(calls).not.toContain('kill-session');
  });
});

// Composition test for the two halves of the session-environment fix: the SessionStart
// stamp records where the session's transcripts actually live, and transcriptDirFor()
// resolves through that config dir instead of hardcoding ~/.claude. Either half alone
// leaves the watchdog reading an empty directory, where a wedged session is
// indistinguishable from a healthy one and no operator ever hears about it.
test('wedge detection reads the transcript under the stamped config dir', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output\nno dialog here');
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const configDir = path.join(h.dir, 'session-config');
    const env = seedTranscript(h, 'sess-wedged-cfg', [
      queueRec('enqueue', isoAgoSeconds(50)),
      queueRec('enqueue', isoAgoSeconds(2)),
    ], configDir);
    patchRuntime(h, { config_dir: configDir });

    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('session-wedged');
  } finally {
    stub.stop();
  }
}));

test('draining transcript → no wedge event, sticky flag clears', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({ session_wedged_notified: true }) + '\n');
  const stub = startHttpStub();
  try {
    const env = seedTranscript(h, 'sess-ok', [
      queueRec('enqueue', isoAgoSeconds(50)),
      queueRec('dequeue', isoAgoSeconds(49)),
    ]);
    await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(readJson(state(h, 'watchdog-state.json')).session_wedged_notified).toBe(false);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('session-wedged');
  } finally { stub.stop(); }
}));

test('unknown verdict (fresh transcript after restart) re-arms the sticky flag', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({ session_wedged_notified: true }) + '\n');
  const stub = startHttpStub();
  try {
    // A brand-new session's transcript carries no queue records yet → 'unknown'.
    // Holding the flag through that would mute the NEXT real wedge.
    const env = seedTranscript(h, 'sess-fresh', ['{"type":"mode","mode":"normal"}']);
    await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(readJson(state(h, 'watchdog-state.json')).session_wedged_notified).toBe(false);
  } finally { stub.stop(); }
}));

test('missing transcript → no wedge event (fail-open)', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    await watchdog(h, 'run', { env: { HOME: path.join(h.dir, 'empty-home'), HERMIT_TELEGRAM_API_URL: stub.url } });
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('session-wedged');
  } finally { stub.stop(); }
}));

describe('stall-question detection', () => {
  let h: Hermit;
  let stub: Stub;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    configureChannel(h);
    writeFakeTmux(h, 0, PENDING_QUESTION_PANE);
    writeFakePgrep(h, 1);
    stub = startHttpStub();
    ({ exitCode } = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } }));
  });

  afterAll(() => { stub.stop(); h.cleanup(); });

  test('pending dialog on pane → stall-question-detected event', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('stall-question-detected');
  });

  test('pending dialog → watchdog-state.json flags stall_question_notified', () => {
    expect(readJson(state(h, 'watchdog-state.json')).stall_question_notified).toBe(true);
  });

  test('pending dialog → operator push reaches the configured channel', () => {
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain("can't ask over chat");
  });
});

test('pending dialog, second tick → deduped, no second push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, PENDING_QUESTION_PANE);
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({ stall_question_notified: true }) + '\n');
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('stall-question-detected');
  } finally {
    stub.stop();
  }
}));

test('pane clears after a flagged episode → re-arms (flag cleared, no new event)', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, 'tmux pane content');
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({ stall_question_notified: true }) + '\n');
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(readJson(state(h, 'watchdog-state.json')).stall_question_notified).toBe(false);
  const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
  expect(events).not.toContain('stall-question-detected');
}));

test('ordinary busy pane content → no false-positive match', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, 'tmux pane content');
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
  expect(events).not.toContain('stall-question-detected');
}));

// -------------------------------------------------------
// 5c. Lapsed-login detection
//
// Both fixtures are verbatim captures (CC 2.1.251, `tmux capture-pane -p`, the same
// call the watchdog makes): an isolated config dir holding an expired, unrefreshable
// .credentials.json, and one holding a bogus CLAUDE_CODE_OAUTH_TOKEN. Neither session
// died — the REPL stayed up answering every prompt with the error below, which is why
// a pane scan is the instrument and dead-session detection never fires here.
// -------------------------------------------------------

const LAPSED_LOGIN_PANE = [
  ' ▐▛███▛█   Claude Code v2.1.251',
  '❯ reply with the single word ok',
  '● Login expired · Please run /login',
  '✻ Churned for 0s · done 21:09',
].join('\n');

const DEAD_TOKEN_PANE = [
  ' ▐▛███▛█   Claude Code v2.1.251',
  '❯ reply with the single word ok',
  '● Please run /login · API Error: 401 OAuth access token is invalid.',
  '✻ Baked for 2s · done 21:09',
].join('\n');

/** A /login hermit: no token file, no token env var, and a usable stored credential. */
function writeStoredLogin(h: Hermit, accessToken = 'sk-ant-oat01-storedstoredstored'): string {
  const configDir = path.join(h.dir, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'r', expiresAt: 0 } }),
    { mode: 0o600 },
  );
  return configDir;
}

describe('hasLapsedLogin pane scan', () => {
  test('the captured expired-/login pane matches', () => {
    expect(hasLapsedLogin(LAPSED_LOGIN_PANE)).toBe(true);
  });

  test('the captured dead-setup-token pane matches', () => {
    expect(hasLapsedLogin(DEAD_TOKEN_PANE)).toBe(true);
  });

  test('ordinary pane content does not match', () => {
    expect(hasLapsedLogin('tmux pane content\n❯ Try "fix typecheck errors"')).toBe(false);
  });

  // A match suppresses the nudge and restart tiers, so a phrase short enough for a
  // session to echo while merely TALKING about auth would disarm the watchdog. The
  // captured pane carrying "Login expired" also carries "Please run /login", so
  // dropping the bare phrase costs no detection.
  test('a bare "Login expired" in ordinary output does not match', () => {
    expect(hasLapsedLogin('❯ why did it say Login expired yesterday?')).toBe(false);
  });

  // Same tail discipline as hasPendingQuestion: an error quoted far up in scrollback
  // is history, not the session's current state.
  test('the error scrolled out of the tail does not match', () => {
    const scrolled = ['● Login expired · Please run /login', ...Array(20).fill('busy work')].join('\n');
    expect(hasLapsedLogin(scrolled)).toBe(false);
  });
});

// A lapsed /login on a hermit that HAS a channel is now recoverable without box
// access: the relay sends the sign-in link out over that channel. The one-notice
// tier below is reserved for the case where that send is impossible.
test('lapsed /login with a channel → relay spawned, nudge and restart suppressed', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, LAPSED_LOGIN_PANE);
  writeFakePgrep(h, 1);
  // Stale enough that a nudge would normally fire — proving the tier suppresses it.
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const configDir = writeStoredLogin(h);
  const r = await watchdog(h, 'run', {
    env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' },
  });
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('reauth-relay');
  expect(events).not.toContain('lapsed-login-detected');
  expect(events).not.toContain('nudge');
  expect(events).not.toContain('restart');
}));

// The other half: the relay already tried and could not reach anybody. Without this
// stamp the watchdog respawns that same doomed relay on every tick, forever.
test('lapsed /login + a fresh unreachable stamp → one notice, no relay', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, LAPSED_LOGIN_PANE);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const configDir = writeStoredLogin(h);
  fs.writeFileSync(state(h, 'relay-unreachable.json'), JSON.stringify({ at: isoAgo(1) }));
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', {
      env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '', HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('lapsed-login-detected');
    expect(events).not.toContain('reauth-relay');
    expect(events).not.toContain('nudge');
    expect(events).not.toContain('restart');
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain('login has expired');
    expect(readJson(state(h, 'watchdog-state.json')).lapsed_login_notified_at).toBeTruthy();
  } finally {
    stub.stop();
  }
}));

// The stamp is a suppression, not a verdict: after a day the hermit tries again,
// because "unreachable" is usually a channel outage, not a permanent condition.
test('lapsed /login + a stamp older than 24h → relay retried', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, LAPSED_LOGIN_PANE);
  writeFakePgrep(h, 1);
  const configDir = writeStoredLogin(h);
  fs.writeFileSync(state(h, 'relay-unreachable.json'), JSON.stringify({ at: isoAgo(25 * 3600) }));
  const r = await watchdog(h, 'run', {
    env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' },
  });
  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('reauth-relay');
}));

// A hermit whose login is fine has nothing to renew — the relay must not fire on a
// healthy credential just because login mode is now a thing.
test('login mode with a healthy credential and a clean pane → nothing fires', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'all quiet');
  writeFakePgrep(h, 1);
  const configDir = path.join(h.dir, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-live', refreshToken: 'r',
        refreshTokenExpiresAt: Date.now() + 20 * 24 * 3600_000,
      },
    }),
  );
  const r = await watchdog(h, 'run', {
    env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' },
  });
  expect(r.exitCode).toBe(0);
  const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
  expect(events).not.toContain('reauth-relay');
  expect(events).not.toContain('lapsed-login-detected');
}));

// A credential the mint already staged IS a renewal in flight. Spawning another
// relay would reset the staging dir out from under it.
test('a pending staged credential counts as a relay already in flight', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, LAPSED_LOGIN_PANE);
  writeFakePgrep(h, 1);
  const configDir = writeStoredLogin(h);
  fs.writeFileSync(
    state(h, 'pending-credential.json'),
    JSON.stringify({ staged_dir: path.join(configDir, '.hermit-login-staging'), staged_at: new Date().toISOString() }),
  );
  const r = await watchdog(h, 'run', {
    env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' },
  });
  expect(r.exitCode).toBe(0);
  const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
  expect(events).not.toContain('relay spawned');
}));

test('lapsed /login, second tick within the day → deduped, no second push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, LAPSED_LOGIN_PANE);
  writeFakePgrep(h, 1);
  const configDir = writeStoredLogin(h);
  // Exercise the notification branch. Without this stamp the watchdog starts
  // a detached relay, whose first request races the assertion below.
  fs.writeFileSync(state(h, 'relay-unreachable.json'), JSON.stringify({ at: isoAgo(1) }));
  const notifiedAt = isoAgo(2);
  fs.writeFileSync(
    state(h, 'watchdog-state.json'),
    JSON.stringify({ lapsed_login_notified_at: notifiedAt }) + '\n',
  );
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', {
      env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '', HERMIT_TELEGRAM_API_URL: stub.url },
    });
    expect(r.exitCode).toBe(0);
    expect(stub.requests).toEqual([]);
    expect(readJson(state(h, 'watchdog-state.json')).lapsed_login_notified_at).toBe(notifiedAt);
  } finally {
    stub.stop();
  }
}));

// The pane clearing proves nothing: a failed refresh rewrites .credentials.json into an
// empty stub (observed live), so the file exists and its mtime moved while the hermit
// is exactly as dead. Only a usable token coming back re-arms.
test('pane clears but the stored login is still an empty stub → record kept', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, 'tmux pane content');
  writeFakePgrep(h, 1);
  const configDir = writeStoredLogin(h, ''); // the stub CC leaves behind
  fs.writeFileSync(
    state(h, 'watchdog-state.json'),
    JSON.stringify({ lapsed_login_notified_at: isoAgo(2) }) + '\n',
  );
  const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' } });
  expect(r.exitCode).toBe(0);
  expect(readJson(state(h, 'watchdog-state.json')).lapsed_login_notified_at).toBeTruthy();
}));

test('usable stored login returns → record cleared', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, 'tmux pane content');
  writeFakePgrep(h, 1);
  const configDir = writeStoredLogin(h);
  fs.writeFileSync(
    state(h, 'watchdog-state.json'),
    JSON.stringify({ lapsed_login_notified_at: isoAgo(2) }) + '\n',
  );
  const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' } });
  expect(r.exitCode).toBe(0);
  expect(readJson(state(h, 'watchdog-state.json')).lapsed_login_notified_at).toBeUndefined();
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('lapsed-login-recovered');
}));

// An API-key hermit sees the same 401 for a cause no sign-in fixes.
test('API-key hermit on a 401 pane → no lapsed-login notice', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1);
  const configDir = writeStoredLogin(h, '');
  const r = await watchdog(h, 'run', {
    env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: 'sk-ant-api-key' },
  });
  expect(r.exitCode).toBe(0);
  const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
  expect(events).not.toContain('lapsed-login-detected');
}));

// A token can die before the record says it should (revoked, rotated, restored from a
// stale backup). The record reads healthy; the pane is the only witness.
test('token dead before its recorded expiry → relay spawned, no nudge', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const configDir = writeSetupToken(h, 200); // record says ~200 days left
  const r = await watchdog(h, 'run', { env: { CLAUDE_CONFIG_DIR: configDir } });
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('reauth-relay');
  expect(events).toContain('auth failure on pane');
  expect(events).not.toContain('nudge');
}));

// --- The session's launch stamp vs. the watchdog's own environment -------
// On a host install the watchdog runs from a systemd unit / launchd job / cron
// entry whose only injected variable is PATH, so `process.env` here describes the
// watchdog and never the session. These fixtures reproduce that: CLAUDE_CONFIG_DIR
// and every var envAuthPresent() reads are blanked in the subprocess env, and HOME
// is redirected so the ~/.claude fallback cannot accidentally resolve to a real
// install. The whole auth list, not just ANTHROPIC_API_KEY — the runner inherits
// process.env, so a developer shell carrying ANTHROPIC_AUTH_TOKEN or a
// cloud-provider flag would suppress the lapsed-login tiers these assert on.
const UNIT_ENV = (h: Hermit) => ({
  HOME: h.dir,
  CLAUDE_CONFIG_DIR: '',
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '',
  CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
});

test('token hermit, config dir known only to the session → relay spawned, no notice', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1);
  // Record still reads healthy — only the pane witnesses the dead token, and only
  // the stamp says where the token lives. Without it the watchdog reads ~/.claude,
  // fails tokenModeActive(), and tells the operator to go run /login by hand.
  const configDir = writeSetupToken(h, 200);
  patchRuntime(h, { config_dir: configDir });
  const r = await watchdog(h, 'run', { env: UNIT_ENV(h) });
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('reauth-relay');
  expect(events).not.toContain('lapsed-login-detected');
}));

// Precedence, not merely gap-filling: the session's dir wins over a value the
// watchdog process happens to carry.
test('stamped config dir overrides the watchdog process env', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1);
  // A token dir the watchdog's own env points at, distinct from the /login dir
  // the session actually reads. Built inline because writeSetupToken() and
  // writeStoredLogin() share one fixture dir by design.
  const tokenDir = path.join(h.dir, 'watchdog-config');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, '.hermit-setup-token'), 'sk-ant-oat01-testtesttesttesttest\n', { mode: 0o600 });
  const sessionDir = writeStoredLogin(h, '');
  patchRuntime(h, { config_dir: sessionDir });
  const r = await watchdog(h, 'run', {
    env: { ...UNIT_ENV(h), CLAUDE_CONFIG_DIR: tokenDir },
  });
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  // Both dirs would spawn a relay, so the discriminator is the RECORDED REASON.
  // The session dir holds a spent /login (empty accessToken → a spent credential),
  // which reports as expired; the watchdog's own token dir has no expiry record at
  // all and would have been logged as a bare pane failure instead.
  expect(events).toContain('claude.ai login expired');
  expect(events).not.toContain('auth failure on pane');
}));

// An API-key hermit's 401 is not a login lapse. The key lives in the operator's
// shell, so the watchdog never sees it — only the boolean the session stamped. It gets
// its own tier rather than falling through: see the restart-loop test below.
test('env_auth stamp → 401 pane is not read as a lapsed login', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const configDir = writeStoredLogin(h, '');
  patchRuntime(h, { config_dir: configDir, env_auth: true });
  const r = await watchdog(h, 'run', { env: UNIT_ENV(h) });
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).not.toContain('lapsed-login-detected');
  expect(events).toContain('env-auth-failure-detected');
}));

// The regression this tier exists for — the restart-loop rationale lives on the
// envAuthFailing block in hermitd-watchdog.ts.
test('env_auth 401 → one notice, and no nudge or restart to strip the key', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1); // monitor dead
  touchAgo(state(h, '.heartbeat'), 6 * 3600); // stale heartbeat: the nudge tier is otherwise due
  const configDir = writeStoredLogin(h, '');
  patchRuntime(h, { config_dir: configDir, env_auth: true });
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { ...UNIT_ENV(h), HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('env-auth-failure-detected');
    expect(events).not.toContain('nudge');
    expect(events).not.toContain('restart');
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].body.text).toContain('API credential');
    expect(stub.requests[0].body.text).not.toContain('sign in again'); // not the /login copy
    expect(readJson(state(h, 'watchdog-state.json')).env_auth_failure_notified_at).toBeTruthy();
  } finally { stub.stop(); }
}));

test('env_auth 401 already notified within 24h → still suppressed, but silent', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const configDir = writeStoredLogin(h, '');
  patchRuntime(h, { config_dir: configDir, env_auth: true });
  fs.writeFileSync(state(h, 'watchdog-state.json'),
    JSON.stringify({ env_auth_failure_notified_at: isoAgo(2) }, null, 2) + '\n');
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { ...UNIT_ENV(h), HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests.length).toBe(0);
    // A silent tick writes no events at all — the file may legitimately not exist.
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('nudge'); // the exit is the suppression, not the notice
    expect(events).not.toContain('restart');
    const calls = fs.existsSync(path.join(h.dir, 'tmux-calls.log'))
      ? fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')
      : '';
    expect(calls).not.toContain('send-keys');
    expect(calls).not.toContain('kill-session');
  } finally { stub.stop(); }
}));

test('env_auth credential works again → stamp cleared', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, 'ordinary pane output\nno auth error here');
  writeFakePgrep(h, 0);
  const configDir = writeStoredLogin(h, '');
  patchRuntime(h, { config_dir: configDir, env_auth: true });
  fs.writeFileSync(state(h, 'watchdog-state.json'),
    JSON.stringify({ env_auth_failure_notified_at: isoAgo(2) }, null, 2) + '\n');
  const r = await watchdog(h, 'run', { env: UNIT_ENV(h) });
  expect(r.exitCode).toBe(0);
  expect(readJson(state(h, 'watchdog-state.json')).env_auth_failure_notified_at).toBeUndefined();
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('env-auth-failure-recovered');
}));

// The two tiers must stay mutually exclusive: a /login hermit is unaffected by the above.
test('no env_auth stamp → the /login tier still owns the 401, not the env-auth tier', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, LAPSED_LOGIN_PANE);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const configDir = writeStoredLogin(h);
  patchRuntime(h, { config_dir: configDir, env_auth: false });
  const r = await watchdog(h, 'run', { env: UNIT_ENV(h) });
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('reauth-relay'); // the /login tier, which now recovers
  expect(events).not.toContain('env-auth-failure-detected');
}));

// Same fixture without the stamp: the wrong story the issue describes. Pins the
// fallback so a pre-upgrade session is provably unchanged, not silently migrated.
test('no stamp → falls back to the watchdog process env', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1);
  const configDir = writeStoredLogin(h, '');
  const r = await watchdog(h, 'run', { env: { ...UNIT_ENV(h), CLAUDE_CONFIG_DIR: configDir } });
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('reauth-relay');
  expect(events).not.toContain('env-auth-failure-detected');
}));

// The stamp is authoritative in BOTH directions. A unit or crontab that happens to
// carry a key while the session runs on /login must not suppress the notice — that
// is the silent outage the stamp exists to end, arriving from the other side.
test('stamped env_auth=false beats a key in the watchdog process env', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0, DEAD_TOKEN_PANE);
  writeFakePgrep(h, 1);
  const configDir = writeStoredLogin(h, '');
  patchRuntime(h, { config_dir: configDir, env_auth: false });
  const r = await watchdog(h, 'run', {
    env: { ...UNIT_ENV(h), ANTHROPIC_API_KEY: 'sk-ant-api03-watchdog-unit-only' },
  });
  expect(r.exitCode).toBe(0);
  // Honouring the process env would resolve `external`, and external is exactly the
  // mode that spawns nothing — so the relay firing is what proves the stamp won.
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('reauth-relay');
}));

// Regression: a pending pane whose in-session heartbeat has ALSO gone stale must
// NOT be nudged or restarted. Wedge detection (step 4) and the monitor re-arm
// (step 5) both send keystrokes into the pane; on a focused prompt that would
// auto-answer the operator's pending decision. The stall detector notifies and
// stops — never keystrokes.
test('pending dialog + stale heartbeat + operator silent → notify only, no send-keys, no restart', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, PENDING_QUESTION_PANE);
  writeFakePgrep(h, 1);              // monitor down — the escalation/restart signal
  touchAgo(state(h, '.heartbeat'), 6 * 3600); // stale (threshold 2h*2 = 4h)
  // No last-operator-action.json → operator silent (recency guard would not save it)
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('stall-question-detected'); // fail-loud fired
    expect(events).not.toContain('nudge');
    expect(events).not.toContain('restart');
    const tmuxCalls = fs.existsSync(path.join(h.dir, 'tmux-calls.log'))
      ? fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')
      : '';
    expect(tmuxCalls).not.toContain('send-keys');   // never keystroke the pane
    expect(tmuxCalls).not.toContain('kill-session'); // never restart into it
  } finally {
    stub.stop();
  }
}));

test('stale dialog scrollback + stale heartbeat → normal nudge recovery continues', withHermit(async (h) => {
  writeConfig(h);
  const progress = Array.from({ length: 6 }, (_, i) => `running step ${i}...`).join('\n');
  writeFakeTmux(h, 0, `${PENDING_QUESTION_PANE}\n${progress}${'\n'.repeat(20)}`);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).not.toContain('stall-question-detected');
  expect(events).toContain('nudge');
  expect(fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')).toContain('send-keys');
}));

// -------------------------------------------------------
// 4b. Wedge threshold floor (watchdog.wedge_floor / WEDGE_FLOOR_DEFAULT)
// -------------------------------------------------------

test('floor: every 30m + 1h-stale heartbeat → no nudge (threshold floored to 4h)', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 3600); // 1h — past 30m*2, inside the 4h floor

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '').not.toContain('nudge');
}));

test('floor: every 30m + 3h59m-stale heartbeat → no nudge (just inside the floor)', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 4 * 3600 - 60);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '').not.toContain('nudge');
}));

test('floor: every 30m + 5h-stale heartbeat → nudge (past the 4h floor)', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
}));

// Floor is a lower bound, not a replacement: a long interval still widens the threshold.
test('floor inactive: every 4h + 5h-stale heartbeat → no nudge (8h product wins)', withHermit(async (h) => {
  writeConfig(h, '4h');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '').not.toContain('nudge');
}));

// The floor is operator policy, not a constant: an install that tightened heartbeat.every
// can tighten the wedge threshold back down with it. Without wedge_floor this config waits 4h.
test('wedge_floor override: every 15m + 1h-stale heartbeat → nudge (floor lowered to 30m)', withHermit(async (h) => {
  writeConfig(h, '15m', { wedge_floor: '30m' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
}));

// "0s" is the documented no-floor value (a bare 0 is a number, which config-read
// discards back to the default). Same config as the first floor test above, which
// suppresses the nudge at 1h — here the floor is off, so the 1h product decides.
test('wedge_floor "0s": every 30m + 90m-stale heartbeat → nudge (floor disabled)', withHermit(async (h) => {
  writeConfig(h, '30m', { wedge_floor: '0s' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5400);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
}));

// -------------------------------------------------------
// 5a. Wedge nudge transport: inbox socket first, typing as the fallback
//
// The socket cannot report whether the model actually read the message
// (`crossSessionInbound: refuse` drops it silently, a bypassPermissions receiver
// holds it behind an expiring dialog, a model may decline), so the fallback is
// keyed on the effect: a second due nudge with the heartbeat still stale means
// the post did not work, and that one types. Fixtures below assert the wire, the
// alternation, and that the typed path is untouched when there is no socket.
// -------------------------------------------------------

/** A Unix socket server standing in for the resident's inbox, recording frames.
 *  Created and closed inside each test — bunfig sets concurrentTestGlob, so a
 *  shared fixture reaped by afterEach is torn down under sibling tests. */
async function fakeInbox(h: Hermit): Promise<{ path: string; lines: string[]; close: () => void }> {
  const socketPath = path.join(h.dir, 'inbox.sock');
  const lines: string[] = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { path: socketPath, lines, close: () => server.close() };
}

test('inbox socket present → wedge nudge posts the bare token, types nothing', withHermit(async (h) => {
  const inbox = await fakeInbox(h);
  try {
    writeConfig(h, '30m');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    patchRuntime(h, { inbox_socket: inbox.path });
    touchAgo(state(h, '.heartbeat'), 5 * 3600);

    const r = await watchdog(h, 'run');

    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge-socket');
    expect(readJson(state(h, 'watchdog-state.json')).last_nudge_transport).toBe('socket');
    // The pane is never touched for this wake.
    expect(tmuxCalls(h)).not.toContain('heartbeat run');

    const deadline = Date.now() + 2000;
    while (inbox.lines.length < 1 && Date.now() < deadline) await Bun.sleep(10);
    // Exactly the token heartbeat-monitor.sh emits — no framing, no wording.
    expect(JSON.parse(inbox.lines[0])).toEqual({
      type: 'user',
      message: { role: 'user', content: 'HEARTBEAT_EVALUATE' },
    });
  } finally {
    inbox.close();
  }
}));

test('previous nudge went over the socket and the heartbeat is still stale → this one types', withHermit(async (h) => {
  const inbox = await fakeInbox(h);
  try {
    writeConfig(h, '30m');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    patchRuntime(h, { inbox_socket: inbox.path });
    touchAgo(state(h, '.heartbeat'), 5 * 3600);
    // A socket nudge from the previous episode window, old enough to be due again.
    fs.writeFileSync(
      state(h, 'watchdog-state.json'),
      JSON.stringify({ last_nudge_transport: 'socket', last_nudge_at: isoAgoSeconds(24) }) + '\n',
    );

    const r = await watchdog(h, 'run');

    expect(r.exitCode).toBe(0);
    expect(tmuxCalls(h)).toContain('/hermitd:heartbeat run');
    expect(readJson(state(h, 'watchdog-state.json')).last_nudge_transport).toBe('typed');
    expect(inbox.lines).toHaveLength(0); // no second post
  } finally {
    inbox.close();
  }
}));

test('no inbox socket in runtime.json → wedge nudge types, exactly as before', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(tmuxCalls(h)).toContain('/hermitd:heartbeat run');
  expect(readJson(state(h, 'watchdog-state.json')).last_nudge_transport).toBe('typed');
}));

test('first run pushes nothing', withHermit(async (h) => {
  writeConfig(h);
  configureMaintainerChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests).toHaveLength(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
  } finally { stub.stop(); }
}));

test('second stale run with consecutive_stale 1 due pushes unresponsive once', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 1,
    last_nudge_at: isoAgo(5),
  }) + '\n');
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].body.text).toContain("hasn't responded");
    expect(readJson(state(h, 'watchdog-state.json')).wedge_escalated).toBe(true);
  } finally { stub.stop(); }
}));

test('due nudge after an operator-guard reset still escalates when a prior nudge failed', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 0,
    last_nudge_at: isoAgo(5),
  }) + '\n');
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].body.text).toContain("hasn't responded");
  } finally { stub.stop(); }
}));

test('stale then fresh heartbeat pushes nothing', withHermit(async (h) => {
  writeConfig(h);
  configureMaintainerChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);
  const stub = startHttpStub();
  try {
    const r1 = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r1.exitCode).toBe(0);

    touchAgo(state(h, '.heartbeat'), 60);
    const r2 = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r2.exitCode).toBe(0);
    expect(stub.requests).toHaveLength(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('wedge-recovered');
  } finally { stub.stop(); }
}));

test('wedge-recovered with no maintainer channel sends nothing', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);
  const stub = startHttpStub();
  try {
    const r1 = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r1.exitCode).toBe(0);
    touchAgo(state(h, '.heartbeat'), 60);
    const r2 = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r2.exitCode).toBe(0);
    expect(stub.requests).toHaveLength(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('wedge-recovered');
  } finally { stub.stop(); }
}));

test('wedge-recovered with a maintainer channel sends there', withHermit(async (h) => {
  writeConfig(h);
  configureMaintainerChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 60);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    last_nudge_at: isoAgo(5),
    wedge_escalated: true,
  }) + '\n');
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const recovered = stub.requests.filter((req) => String(req.body?.text ?? '').includes('responding again'));
    expect(recovered.length).toBe(1);
    expect(recovered[0].body.chat_id).toBe('99999');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('wedge-recovered');
  } finally { stub.stop(); }
}));

test('wedge-recovered without escalation pushes nothing', withHermit(async (h) => {
  writeConfig(h);
  configureMaintainerChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 60);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    last_nudge_at: isoAgo(5),
  }) + '\n');
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests).toHaveLength(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('wedge-recovered');
  } finally { stub.stop(); }
}));

test('fresh heartbeat with no prior episode pushes nothing', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 60);
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests).toHaveLength(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('wedge-recovered');
  } finally { stub.stop(); }
}));

test('third stale run after escalation pushes nothing', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 5 * 3600);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 2,
    wedge_escalated: true,
    last_nudge_at: isoAgo(5),
  }) + '\n');
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(stub.requests).toHaveLength(0);
  } finally { stub.stop(); }
}));

// A stamped path whose session died takes the socket file with it. Reading the
// stale value as usable would post into nothing and skip the typed recovery.
test('stamped socket path no longer exists → falls through to typing', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  patchRuntime(h, { inbox_socket: path.join(h.dir, 'gone.sock') });
  touchAgo(state(h, '.heartbeat'), 5 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(tmuxCalls(h)).toContain('/hermitd:heartbeat run');
  expect(readJson(state(h, 'watchdog-state.json')).last_nudge_transport).toBe('typed');
}));

// -------------------------------------------------------
// 5a-bis. Registry-backed liveness
//
// Claude Code publishes each session's own state at <config dir>/sessions/<pid>.json.
// The watchdog reads the resident's entry (keyed on runtime.session_pid, the session's
// own stamp) for two decisions the pane cannot answer: whether a dialog is blocking it
// (status `waiting`, whatever the modal looks like), and whether a socket wake ever
// started a turn (`idle` since before the post was written).
//
// The fixture uses the TEST RUNNER's pid, because the entry must survive the lib's
// validation — pid alive, procStart matching /proc, pidDomain matching this host — and
// the runner is the one process guaranteed to be alive while the watchdog subprocess
// reads it.
// -------------------------------------------------------

/** A registry entry for this process, valid on this host, under a throwaway config dir. */
function writeRegistryEntry(h: Hermit, patch: Record<string, unknown> = {}): string {
  const configDir = path.join(h.dir, 'config-dir');
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      ...localIdentity(),
      kind: 'interactive',
      status: 'idle',
      statusUpdatedAt: Date.now(),
      cwd: h.dir,
      name: 'hermit',
      messagingSocketPath: path.join(h.dir, 'inbox.sock'),
      ...patch,
    }),
  );
  return configDir;
}

const MCP_AUTH_PANE = [
  'Plugin:cloudflare:cloudflare-api MCP Server',
  'Authentication timeout',
  '❯ 1. Authenticate',
  '  2. Disable',
  '↑/↓ to navigate · Enter to select · Esc to back',
].join('\n');

test('registry waiting stall notice quotes the pane tail', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, MCP_AUTH_PANE);
  writeFakePgrep(h, 1);
  const configDir = writeRegistryEntry(h, { status: 'waiting' });
  patchRuntime(h, { config_dir: configDir, session_pid: process.pid });
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('stall-question-detected');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].body.text).toContain('Authentication timeout');
  } finally { stub.stop(); }
}));

test('registry says the resident is waiting on a dialog → alert, no nudge', withHermit(async (h) => {
  writeConfig(h, '30m');
  // A pane the scanner does NOT recognise as a dialog — the registry is the only signal.
  writeFakeTmux(h, 0, 'some modal the pane scanner does not know');
  writeFakePgrep(h, 1);
  const configDir = writeRegistryEntry(h, { status: 'waiting' });
  patchRuntime(h, { config_dir: configDir, session_pid: process.pid });
  touchAgo(state(h, '.heartbeat'), 5 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('stall-question-detected');
  expect(events).toContain('via registry');
  // Step 4 never runs behind a pending dialog.
  expect(tmuxCalls(h)).not.toContain('heartbeat run');
}));

test('registry says the resident is busy → 3b stays quiet, nudge proceeds', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const configDir = writeRegistryEntry(h, { status: 'busy' });
  patchRuntime(h, { config_dir: configDir, session_pid: process.pid });
  touchAgo(state(h, '.heartbeat'), 5 * 3600);

  const r = await watchdog(h, 'run');

  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).not.toContain('stall-question-detected');
  expect(tmuxCalls(h)).toContain('/hermitd:heartbeat run');
}));

test('socket nudge never started a turn (idle since before the post) → types now, throttle bypassed', withHermit(async (h) => {
  const inbox = await fakeInbox(h);
  try {
    writeConfig(h, '30m');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    // Idle since two minutes ago; the socket nudge went out one minute ago, so it
    // cannot have been read — the session never left the idle it was already in.
    const configDir = writeRegistryEntry(h, { status: 'idle', statusUpdatedAt: Date.now() - 120_000 });
    patchRuntime(h, { config_dir: configDir, session_pid: process.pid, inbox_socket: inbox.path });
    touchAgo(state(h, '.heartbeat'), 5 * 3600);
    fs.writeFileSync(
      state(h, 'watchdog-state.json'),
      JSON.stringify({ last_nudge_transport: 'socket', last_nudge_at: isoAgoSeconds(1 / 60) }) + '\n',
    );

    const r = await watchdog(h, 'run');

    expect(r.exitCode).toBe(0);
    expect(tmuxCalls(h)).toContain('/hermitd:heartbeat run');
    expect(readJson(state(h, 'watchdog-state.json')).last_nudge_transport).toBe('typed');
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('socket undelivered');
    expect(events).not.toContain('nudge-throttled');
    expect(inbox.lines).toHaveLength(0); // no second post
  } finally {
    inbox.close();
  }
}));

test('socket nudge landed (resident busy since the post) → throttled, no retype', withHermit(async (h) => {
  const inbox = await fakeInbox(h);
  try {
    writeConfig(h, '30m');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    const configDir = writeRegistryEntry(h, { status: 'busy', statusUpdatedAt: Date.now() });
    patchRuntime(h, { config_dir: configDir, session_pid: process.pid, inbox_socket: inbox.path });
    touchAgo(state(h, '.heartbeat'), 5 * 3600);
    fs.writeFileSync(
      state(h, 'watchdog-state.json'),
      JSON.stringify({ last_nudge_transport: 'socket', last_nudge_at: isoAgoSeconds(1 / 60) }) + '\n',
    );

    const r = await watchdog(h, 'run');

    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge-throttled');
    expect(tmuxCalls(h)).not.toContain('heartbeat run');
  } finally {
    inbox.close();
  }
}));

// -------------------------------------------------------
// 5b. Supervision on an idle session arc
//
// The contract under test is about the GATE, not about any one dialog: whatever holds
// stdin — a permission prompt, an AskUserQuestion modal, a first-run wizard, a shape no
// released Claude Code has shown yet — an idle session arc must still raise exactly one
// alert. The tests below therefore cover a generic modal, a real captured wizard, and a
// dialog the pane scanner deliberately does NOT recognise (caught by the queue-liveness
// net instead). Nothing here keys off the wizard that exposed the bug.
//
// The failure this pins: both detectors return the correct verdict, but the step-2 shutdown
// gate used to exit before either could run, so a blocked session
// stayed blocked indefinitely with no alert.
//
// `idle` is not a stop signal: 'in_progress' is written only by the model-driven
// Older lifecycle state left every hermit resting
// there between arcs. Worse, the state is self-sealing — leaving `idle` needs the model to
// take a turn, which is exactly what a blocking dialog prevents.
//
// Every pre-existing test above runs at setupHermit's hardcoded 'in_progress', which no
// wedged hermit is ever in. That is why this shipped green. These tests pin the real state.
// -------------------------------------------------------

/** A wizard step whose pointer rests on a CHECKBOX row while "Continue" sits unmarked below
 *  it — unlike AUTO_MODE_WIZARD_PANE, where the pointer is on "❯ Continue" itself. The
 *  detector must match a pointer on any row, not only on the confirming one. */
const CHECKBOX_ROW_WIZARD_PANE = [
  '  Ran 1 shell command',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Set up auto mode for your environment?',
  '',
  '   Claude Code reads this project, your recent Claude sessions, and',
  '   optionally your shell history and other repositories.',
  '',
  '     How you use Claude here    ◀ Mixed ▶',
  '   ❯ Also scan shell history    [✔]',
  '     Also scan your other repos [ ]',
  '',
  '     Continue',
  '',
  '   ←/→ to change usage · Enter to continue · Esc to cancel',
].join('\n');

test('wizard pane with the pointer on a checkbox row matches', () => {
  expect(hasPendingQuestion(CHECKBOX_ROW_WIZARD_PANE)).toBe(true);
});

/** The CC 2.1.282 auto-mode offer block, captured live on 2026-09-25 in a session with
 *  no `autoMode.environment` entries, rendered below the composer (see PENDING_FOOTERS).
 *  Only the six-line block was recorded, re-indented to match the sibling fixtures. */
const AUTO_MODE_OFFER_PANE = [
  '   Teach auto mode about your environment?',
  '   Auto mode works better when it knows your environment. Takes about a minute.',
  '   ❯ 1. Yes',
  '     2. Not now',
  "     3. Don't show again",
  '   Enter to confirm · Esc to cancel',
].join('\n');

test('the CC 2.1.282 auto-mode offer matches, with or without blank rows below it', () => {
  expect(hasPendingQuestion(AUTO_MODE_OFFER_PANE)).toBe(true);
  expect(hasPendingQuestion(`${AUTO_MODE_OFFER_PANE}${'\n'.repeat(20)}`)).toBe(true);
});

test('idle arc + pending dialog → stall-question-detected and one push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, CHECKBOX_ROW_WIZARD_PANE);
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('stall-question-detected');
    expect(stub.requests.length).toBe(1);
  } finally { stub.stop(); }
}));

// Not wizard-specific: a plain AskUserQuestion/permission-shaped modal on an idle arc
// must alert identically. The gate never inspected the dialog, and neither does the fix.
test('idle arc + generic modal (not the wizard) → stall-question-detected and one push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, PENDING_QUESTION_PANE);
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('stall-question-detected');
    expect(stub.requests.length).toBe(1);
  } finally { stub.stop(); }
}));

// The generic net, and the reason 3c exists at all: a blocker the pane scanner cannot
// recognise (no pointer glyph, no dialog footer) still gets caught, because a blocked
// session stops draining its notification queue whatever is holding stdin. This is the
// case that must keep working for dialog shapes no released Claude Code has shipped yet.
test('idle arc + UNRECOGNISED blocker shape → still alerts via queue liveness', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  const novelBlocker = 'Some future modal\n\n  [ Accept ]   [ Decline ]\n\npress a key';
  expect(hasPendingQuestion(novelBlocker)).toBe(false);   // 3b is blind to it, by design
  writeFakeTmux(h, 0, novelBlocker);
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const env = seedTranscript(h, 'sess-novel', [
      queueRec('dequeue', isoAgoSeconds(9)),
      queueRec('enqueue', isoAgoSeconds(8)),
    ]);
    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('session-wedged');
    expect(stub.requests.length).toBe(1);
  } finally { stub.stop(); }
}));

test('idle arc + stale enqueue tail → session-wedged and one push', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output\nno dialog here');
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    // The captured production shape: a drain that stopped, then enqueues that never drained.
    const env = seedTranscript(h, 'sess-idle-wedged', [
      queueRec('dequeue', isoAgoSeconds(14)),
      queueRec('enqueue', isoAgoSeconds(13)),
      queueRec('enqueue', isoAgoSeconds(1.3)),
    ]);
    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('session-wedged');
    expect(stub.requests.length).toBe(1);
  } finally { stub.stop(); }
}));

test('idle arc + clean pane + draining queue → still no events', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const env = seedTranscript(h, 'sess-idle-ok', [
      queueRec('enqueue', isoAgoSeconds(2)),
      queueRec('dequeue', isoAgoSeconds(1.9)),
    ]);
    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('session-wedged');
    expect(events).not.toContain('stall-question-detected');
    expect(stub.requests.length).toBe(0);
  } finally { stub.stop(); }
}));

// Guard 3c's contract is "while tmux is alive": a dead session takes the restart path in
// step 3, so a stale enqueue tail in its transcript never raises a wedge alert.
test('DEAD tmux + stale enqueue tail → no wedge event', withHermit(async (h) => {
  writeConfig(h);
  configureChannel(h);
  writeFakeTmux(h, 1, 'irrelevant');   // 1 = session gone
  writeFakePgrep(h, 1);
  const stub = startHttpStub();
  try {
    const env = seedTranscript(h, 'sess-stopped', [
      queueRec('enqueue', isoAgoSeconds(30)),
    ]);
    const r = await watchdog(h, 'run', { env: { ...env, HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('session-wedged');
  } finally { stub.stop(); }
}));

// An explicit clean shutdown keeps recovery suppressed.
test('stopped resident + stale heartbeat + monitor down → no nudge, no restart, no keystrokes', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { shutdown_completed_at: isoAgo(1) });
  configureChannel(h);
  writeFakeTmux(h, 0, 'ordinary pane output');
  writeFakePgrep(h, 1);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const stub = startHttpStub();
  try {
    const r = await watchdog(h, 'run', { env: { HERMIT_TELEGRAM_API_URL: stub.url } });
    expect(r.exitCode).toBe(0);
    const events = fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '';
    expect(events).not.toContain('nudge');
    expect(events).not.toContain('restart');
    const tmuxCalls = fs.existsSync(path.join(h.dir, 'tmux-calls.log'))
      ? fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')
      : '';
    expect(tmuxCalls).not.toContain('send-keys');
    expect(tmuxCalls).not.toContain('kill-session');
  } finally { stub.stop(); }
}));

// -------------------------------------------------------
// 6. Alive + operator recent → back off (no events)
// -------------------------------------------------------

describe('alive + operator recent', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    // .heartbeat mtime 6h ago (stale — threshold is 2h*2=4h)
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // operator action 5 minutes ago (within 15m grace)
    fs.writeFileSync(state(h, 'last-operator-action.json'),
      JSON.stringify({ at: isoAgo(5 / 60) }) + '\n');
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('stale + operator recent → no events', () => {
    expect(exitCode).toBe(0);
    expect(fs.existsSync(eventsFile(h))).toBe(false);
  });

  test('stale + operator recent → consecutive reset to 0', () => {
    expect(readJson(state(h, 'watchdog-state.json')).consecutive_stale).toBe(0);
  });
});

// -------------------------------------------------------
// 7. Alive + stale + operator silent → nudge on cycle 1
// -------------------------------------------------------

describe('alive + stale + operator silent', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // No last-operator-action.json (operator silent)
    writeFakeTmux(h, 0, 'some pane content');
    // pgrep returns 1 = monitor not running (wedge signal)
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('stale + operator silent → nudge event written', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
  });

  test('nudge cycle 1 → consecutive_stale = 1', () => {
    expect(readJson(state(h, 'watchdog-state.json')).consecutive_stale).toBe(1);
  });

  test('nudge cycle 1 → send-keys called', () => {
    expect(fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')).toContain('send-keys');
  });
});

// -------------------------------------------------------
// 8. Escalation after escalate_after cycles (pane frozen + monitor dead)
// -------------------------------------------------------

describe('escalation', () => {
  let h: Hermit;
  let exitCode: number;

  beforeAll(async () => {
    h = setupHermit();
    writeConfig(h);
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    // Fake tmux pane content — the stub's echo adds a trailing newline, so the
    // stored hash must include it for the pane to read as frozen.
    const paneContent = 'frozen pane';
    const frozenHash = crypto.createHash('sha256').update(`${paneContent}\n`).digest('hex');
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      consecutive_stale: 2, last_pane_hash: frozenHash, last_nudge_at: '2026-01-01T00:00:00Z',
    }) + '\n');
    // Fake tmux: session alive, pane returns same content → same hash
    writeFakeTmux(h, 0, paneContent);
    // pgrep returns 1 = monitor not running
    writeFakePgrep(h, 1);
    ({ exitCode } = await watchdog(h, 'run'));
  });

  afterAll(() => h.cleanup());

  test('escalation at cycle 3 (pane frozen + monitor dead) → restart', () => {
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
  });

  test('escalation reason is pane-frozen', () => {
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('pane-frozen');
  });
});

// -------------------------------------------------------
// 9. Alive + pane changed → nudge (not restart), even at escalate_after cycles
// -------------------------------------------------------

test('pane changed at cycle 3 → nudge (not restart)', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  // State shows 2 prior stale cycles with old hash
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 2, last_pane_hash: 'old-hash-abc', last_nudge_at: '2026-01-01T00:00:00Z',
  }) + '\n');
  // Fake tmux returns DIFFERENT pane content → different hash
  writeFakeTmux(h, 0, 'new pane content different from old');
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('nudge');
  expect(events).not.toContain('restart');
}));

// -------------------------------------------------------
// 9b. Nudge throttle: one paid probe per staleness window
// -------------------------------------------------------

test('stale + nudged 60s ago → throttled, no keystroke', withHermit(async (h) => {
  writeConfig(h); // 2h × 2 vs 4h floor → 4h window
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 0, last_pane_hash: null,
    last_nudge_at: new Date(Date.now() - 60 * 1000).toISOString(),
  }) + '\n');
  writeFakeTmux(h, 0, 'some pane content');
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge-throttled');
  const tmuxLog = path.join(h.dir, 'tmux-calls.log');
  const calls = fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf-8') : '';
  expect(calls).not.toContain('heartbeat run');
}));

test('throttled tick still counts toward escalation', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 1, last_pane_hash: null,
    last_nudge_at: new Date(Date.now() - 60 * 1000).toISOString(),
  }) + '\n');
  writeFakeTmux(h, 0, 'some pane content');
  writeFakePgrep(h, 1);
  await watchdog(h, 'run');
  expect(readJson(state(h, 'watchdog-state.json')).consecutive_stale).toBe(2);
}));

test('stale + last nudge older than the window → nudge fires and re-stamps', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const stale = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 0, last_pane_hash: null, last_nudge_at: stale,
  }) + '\n');
  writeFakeTmux(h, 0, 'some pane content');
  writeFakePgrep(h, 1);
  await watchdog(h, 'run');
  expect(fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8')).toContain('heartbeat run');
  expect(readJson(state(h, 'watchdog-state.json')).last_nudge_at).not.toBe(stale);
}));

test('heartbeat recovered → nudge throttle re-armed', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 60); // fresh → recovery branch
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 2, last_pane_hash: null,
    last_nudge_at: new Date(Date.now() - 60 * 1000).toISOString(),
  }) + '\n');
  writeFakeTmux(h, 0, 'some pane content');
  writeFakePgrep(h, 1);
  await watchdog(h, 'run');
  expect(readJson(state(h, 'watchdog-state.json')).last_nudge_at).toBeNull();
}));

test('escalation takes precedence — the throttle is never consulted', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  const paneContent = 'frozen pane';
  const frozenHash = crypto.createHash('sha256').update(`${paneContent}\n`).digest('hex');
  fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
    consecutive_stale: 2, last_pane_hash: frozenHash,
    last_nudge_at: new Date(Date.now() - 60 * 1000).toISOString(),
  }) + '\n');
  writeFakeTmux(h, 0, paneContent);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const events = fs.readFileSync(eventsFile(h), 'utf-8');
  expect(events).toContain('restart');
  expect(events).not.toContain('nudge');
}));

// -------------------------------------------------------
// 11c. Monitor-liveness re-arm (step 5): recover a Monitor that died mid-session,
//      detected via its stale liveness file. No .heartbeat file → wedge (step 4)
//      skipped, so only step 5 is under test here.
// -------------------------------------------------------

const tmuxCalls = (h: Hermit) => {
  const p = path.join(h.dir, 'tmux-calls.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
};
const events = (h: Hermit) => (fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '');
const writeState = (h: Hermit, name: string, obj: unknown) => {
  const hermitDir = path.join(h.dir, '.hermit');
  if (name === 'heartbeat-monitor.runtime.json') {
    const config = readJson(path.join(hermitDir, 'config.json'));
    obj = { interval: heartbeatInterval(config), command: heartbeatCommand(hermitDir, config), launch: 'native', ...obj as object };
  } else if (name === 'routine-monitor.runtime.json') {
    obj = { command: routineCommand(hermitDir), launch: 'native', ...obj as object };
  }
  fs.writeFileSync(state(h, name), JSON.stringify(obj) + '\n');
};
const writeRoutineMonitorConfig = (h: Hermit) =>
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m' },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
    routines: [{ id: 'scheduled-checks', enabled: true, schedule: '*/30 * * * *' }],
  }, null, 2) + '\n');

for (const execution of ['idle', 'in_flight', 'unknown']) {
  test(`monitor-dead supervisor with execution ${execution}`, withHermit(async (h) => {
    writeConfig(h);
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    fs.writeFileSync(state(h, '.boot-id'), 'native-boot\n');
    writeState(h, 'heartbeat-monitor.runtime.json', { launch: 'native', boot_id: 'native-boot', started_at: isoAgo(1) });
    writeState(h, 'heartbeat-liveness.json', { pid: 2147483647, last_peek_at: isoAgo(0) });
    writeState(h, 'execution.json', { state: execution, cc_session_id: 'resident-boundary', at: new Date(Date.now() - 61000).toISOString() });
    const result = await watchdog(h, 'run');
    expect(result.exitCode).toBe(0);
    if (execution === 'idle') {
      expect(events(h)).toContain('monitor-restart');
      expect(readJson(state(h, 'runtime.json')).watchdog_restart_reason).toBe('monitor-dead');
      expect(tmuxCalls(h)).toContain('kill-session');
    } else {
      expect(events(h)).toContain('monitor-dead-deferred');
      expect(events(h)).toContain('execution-not-idle');
      expect(tmuxCalls(h)).not.toContain('kill-session');
    }
  }));
}

test('monitor-dead from a previous boot does not restart', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, '.boot-id'), 'new-boot\n');
  writeState(h, 'heartbeat-monitor.runtime.json', { launch: 'native', boot_id: 'old-boot', started_at: isoAgo(1) });
  writeState(h, 'heartbeat-liveness.json', { pid: 2147483647, last_peek_at: isoAgo(0) });
  writeState(h, 'execution.json', { state: 'idle', cc_session_id: 'resident-boundary', at: new Date(Date.now() - 61000).toISOString() });
  await watchdog(h, 'run');
  expect(events(h)).not.toContain('monitor-restart');
  expect(tmuxCalls(h)).not.toContain('kill-session');
}));

test('monitor-rearm still handles stale liveness with a live supervisor', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, '.boot-id'), 'native-boot\n');
  writeState(h, 'heartbeat-monitor.runtime.json', { launch: 'native', boot_id: 'native-boot', started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { pid: process.pid, last_peek_at: isoAgo(8) });
  writeState(h, 'execution.json', { state: 'idle', cc_session_id: 'resident-boundary', at: new Date(Date.now() - 61000).toISOString() });
  await watchdog(h, 'run');
  expect(events(h)).not.toContain('monitor-restart');
  expect(events(h)).toContain('monitor-rearm');
}));

test('command drift with a live supervisor is not re-armed', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  fs.writeFileSync(state(h, '.boot-id'), 'native-boot\n');
  writeState(h, 'heartbeat-monitor.runtime.json', { command: 'bash /old/plugin/scripts/monitor-supervisor.sh', boot_id: 'native-boot', started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { pid: process.pid, last_peek_at: isoAgo(8) });
  writeState(h, 'execution.json', { state: 'idle', cc_session_id: 'resident-boundary', at: new Date(Date.now() - 61000).toISOString() });
  await watchdog(h, 'run');
  expect(events(h)).not.toContain('monitor-rearm');
  expect(tmuxCalls(h)).not.toContain('/hermitd:heartbeat start');
}));

for (const leg of ['heartbeat', 'routine'] as const) {
  for (const scenario of ['idle', 'evolve-pending', 'in_flight', 'paused'] as const) {
    test(`upgrade monitor ${leg} with ${scenario}`, withHermit(async (h) => {
      writeConfig(h);
      const configPath = path.join(h.dir, '.hermit', 'config.json');
      const config = readJson(configPath);
      const pluginVersion = readJson(path.join(SCRIPTS_DIR, '..', '.claude-plugin', 'plugin.json')).version;
      config._hermit_versions = { hermitd: scenario === 'evolve-pending' ? 'old-version' : pluginVersion };
      config.routines = [{ id: 'scheduled-checks', enabled: true, schedule: '*/30 * * * *' }];
      fs.writeFileSync(configPath, JSON.stringify(config));
      writeFakeTmux(h, 0);
      writeFakePgrep(h, 1);
      fs.writeFileSync(state(h, '.boot-id'), 'native-boot\n');
      writeState(h, `${leg}-monitor.runtime.json`, {
        launch: 'native', mode: 'monitor', boot_id: 'native-boot', interval: leg === 'heartbeat' ? 7200 : 60,
        command: 'bash /old/plugin/scripts/monitor-supervisor.sh', started_at: isoAgo(1),
      });
      writeState(h, leg === 'heartbeat' ? 'heartbeat-liveness.json' : 'routine-monitor-liveness.json', {
        pid: process.pid, last_peek_at: isoAgo(0),
      });
      writeState(h, 'execution.json', {
        state: scenario === 'in_flight' ? 'in_flight' : 'idle', cc_session_id: 'resident-boundary',
        at: new Date(Date.now() - 61000).toISOString(),
      });
      if (scenario === 'paused') {
        writeState(h, 'operator-pause.json', { paused: true, paused_until: null, reason: 'operator' });
      }
      const result = await watchdog(h, 'run');
      expect(result.exitCode).toBe(0);
      if (scenario === 'idle') {
        expect(events(h)).toContain('upgrade-restart');
        expect(events(h)).toContain(`${leg}-monitor.runtime.json`);
        expect(readJson(state(h, 'runtime.json')).watchdog_restart_reason).toBe('upgrade');
        expect(tmuxCalls(h)).toContain('kill-session');
      } else {
        expect(events(h)).toContain('upgrade-restart-deferred');
        expect(events(h)).toContain(scenario === 'in_flight' ? 'execution-not-idle' : scenario);
        expect(tmuxCalls(h)).not.toContain('kill-session');
      }
      expect(tmuxCalls(h)).not.toContain('/hermitd:heartbeat start');
      expect(tmuxCalls(h)).not.toContain('/hermitd:hermit-routines load');
    }));
  }
}

for (const leg of ['heartbeat', 'routine'] as const) {
  test(`upgrade drift from a previous boot for ${leg} does not restart`, withHermit(async (h) => {
    writeConfig(h);
    const configPath = path.join(h.dir, '.hermit', 'config.json');
    const config = readJson(configPath);
    config._hermit_versions = { hermitd: readJson(path.join(SCRIPTS_DIR, '..', '.claude-plugin', 'plugin.json')).version };
    config.routines = [{ id: 'scheduled-checks', enabled: true, schedule: '*/30 * * * *' }];
    fs.writeFileSync(configPath, JSON.stringify(config));
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    fs.writeFileSync(state(h, '.boot-id'), 'new-boot\n');
    writeState(h, `${leg}-monitor.runtime.json`, {
      launch: 'native', mode: 'monitor', boot_id: 'old-boot', interval: leg === 'heartbeat' ? 7200 : 60,
      command: 'bash /old/plugin/scripts/monitor-supervisor.sh', started_at: isoAgo(1),
    });
    writeState(h, leg === 'heartbeat' ? 'heartbeat-liveness.json' : 'routine-monitor-liveness.json', {
      pid: process.pid, last_peek_at: isoAgo(0),
    });
    const result = await watchdog(h, 'run');
    expect(result.exitCode).toBe(0);
    expect(events(h)).not.toContain('upgrade-restart');
    expect(events(h)).not.toContain('upgrade-restart-deferred');
    expect(tmuxCalls(h)).not.toContain('kill-session');
  }));
}

test('stale heartbeat liveness → monitor-rearm event, only heartbeat start injected', withHermit(async (h) => {
  writeConfig(h); // heartbeat every 2h → threshold 6h; no routines
  // Trusted but stale: last tick 8h ago, monitor registered 9h ago.
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
  expect(events(h)).toContain('heartbeat');
  const calls = tmuxCalls(h);
  expect(calls).toContain('/hermitd:heartbeat start');
  expect(calls).not.toContain('hermit-routines load');
  // Damper stamp persisted for the heartbeat monitor.
  expect(typeof readWatchdogStateFile(h).last_monitor_rearm?.heartbeat).toBe('string');
}));

test('fresh heartbeat liveness → no monitor-rearm', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(5 / 60) }); // 5 min ago
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(1 / 60) });       // 1 min ago
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('stale liveness but within damper window → no second re-arm', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  // Already re-armed 1h ago — inside the 6h per-monitor damper.
  writeState(h, 'watchdog-state.json', { last_monitor_rearm: { heartbeat: isoAgo(1) } });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('stale liveness but dead session → restart path owns it, no monitor-rearm', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeFakeTmux(h, 1); // dead
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('restart');
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('stale liveness but operator active < grace → no re-arm', withHermit(async (h) => {
  writeConfig(h); // operator_grace 15m
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeState(h, 'last-operator-action.json', { at: isoAgo(2 / 60) }); // 2 min ago
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

// The split that keeps the predates-grace honest: a subprocess that never wrote a tick
// is not waiting on a poll, so it keeps the 2-min spawn grace rather than riding out a
// whole interval. 10 min in, well short of the 121-min predates-grace, it re-arms.
test('no tick at all → re-arm on the 2m spawn grace', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(10 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
}));

// Keep config and registration aligned so drift does not pre-empt freshness.
// A 30m registration's predates grace expires at 31 minutes.
test('predates-grace expires after the registered 30m interval', withHermit(async (h) => {
  writeConfig(h, '30m');
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(45 / 60), interval: 1800 });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(55 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
}));

test('liveness tick predating started_at + past startup grace → re-arm', withHermit(async (h) => {
  writeConfig(h);
  // Monitor registered 130 min ago; only tick is 140 min ago, which predates started_at
  // → untrusted → falls to the grace branch. A predating tick rides out one poll
  // interval (writeConfig's default every=2h, so 7260s = 121 min), not the 2-min spawn
  // grace, so the registration has to be older than that before it counts as stale.
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(130 / 60) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(140 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
}));

test('stale liveness but hermit paused → no re-arm', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeState(h, 'operator-pause.json', { paused: true, paused_until: null, reason: 'operator' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('stale routine-monitor liveness → monitor-rearm, only hermit-routines load injected', withHermit(async (h) => {
  // Routine monitor enabled (a non-anchor routine), interval 60s → threshold 10m.
  writeRoutineMonitorConfig(h);
  writeState(h, 'routine-monitor.runtime.json', { started_at: isoAgo(25 / 60), interval: 60, mode: 'monitor' });
  writeState(h, 'routine-monitor-liveness.json', { last_peek_at: isoAgo(20 / 60) }); // 20 min ago > 10m
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
  expect(events(h)).toContain('routine-monitor');
  const calls = tmuxCalls(h);
  expect(calls).toContain('/hermitd:hermit-routines load');
  expect(calls).not.toContain('heartbeat start');
}));

// `hermit-routines load` arms both monitors, so a both-stale pass is one injection.
// Sending `heartbeat start` behind it would load a second skill body only to be told
// the leg it re-registers is already FRESH.
test('both monitors stale → one hermit-routines load, no heartbeat start, both dampers stamped', withHermit(async (h) => {
  writeRoutineMonitorConfig(h);
  writeState(h, 'routine-monitor.runtime.json', { started_at: isoAgo(25 / 60), interval: 60, mode: 'monitor' });
  writeState(h, 'routine-monitor-liveness.json', { last_peek_at: isoAgo(20 / 60) });
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const calls = tmuxCalls(h);
  expect(calls.split('/hermitd:hermit-routines load').length - 1).toBe(1);
  expect(calls).not.toContain('/hermitd:heartbeat start');
  // Both legs were re-armed by that one injection, so both dampers close.
  const stamps = readWatchdogStateFile(h).last_monitor_rearm;
  expect(typeof stamps?.routines).toBe('string');
  expect(typeof stamps?.heartbeat).toBe('string');
}));

test('routine monitor in croncreate-fallback mode → no re-arm', withHermit(async (h) => {
  writeRoutineMonitorConfig(h);
  writeState(h, 'routine-monitor.runtime.json', { started_at: isoAgo(25 / 60), interval: 60, mode: 'croncreate-fallback' });
  writeState(h, 'routine-monitor-liveness.json', { last_peek_at: isoAgo(20 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

// A monitor that died with its session keeps a fresh-looking liveness file for the rest
// of its window, so only the boot marker can expose it. Marker age gates the check: the
// bootstrap turn re-registers after hermitd-start stamps the marker.
const writeBootMarker = (h: Hermit, id: string, ageMins: number) => {
  const p = state(h, '.boot-id');
  fs.writeFileSync(p, id + '\n');
  const t = new Date(Date.now() - ageMins * 60_000);
  fs.utimesSync(p, t, t);
};

test('heartbeat monitor from a previous boot → re-arm despite fresh liveness', withHermit(async (h) => {
  writeConfig(h);
  writeBootMarker(h, 'boot-B', 30); // booted 30 min ago, past the 10-min grace
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(5 / 60), boot_id: 'boot-A' });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(1 / 60) }); // would read fresh
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
  expect(tmuxCalls(h)).toContain('/hermitd:heartbeat start');
}));

test('previous-boot mismatch inside the boot grace → no re-arm', withHermit(async (h) => {
  writeConfig(h);
  writeBootMarker(h, 'boot-B', 2); // bootstrap still in flight — it owns the re-arm
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(5 / 60), boot_id: 'boot-A' });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(1 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('registration predating the boot_id field → falls through to freshness', withHermit(async (h) => {
  writeConfig(h);
  writeBootMarker(h, 'boot-B', 30);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(5 / 60) }); // no boot_id
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(1 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).not.toContain('monitor-rearm');
}));

test('croncreate-fallback from a previous boot → re-arm', withHermit(async (h) => {
  // Fallback writes no liveness file, so the boot id is the only evidence its
  // durable:false crons died with the previous process.
  writeRoutineMonitorConfig(h);
  writeBootMarker(h, 'boot-B', 30);
  writeState(h, 'routine-monitor.runtime.json', { started_at: isoAgo(5 / 60), interval: 60, mode: 'croncreate-fallback', boot_id: 'boot-A' });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
  expect(tmuxCalls(h)).toContain('/hermitd:hermit-routines load');
}));

// 11f. The same re-arms on an IDLE session arc.
//
// A hermit rests at 'idle' between arcs, so that is where a Monitor that died has to be
// recovered from. Before this, the supervision-only cut exited above step 5, and the
// only recovery left was the daily heartbeat-restart anchor — a CronCreate that dies with the
// process it was registered in, i.e. in the same event that kills the monitors. A restart
// catching the hermit at 'idle' therefore silenced heartbeat and routines until an operator
// noticed. Idle still suppresses step 4 (the nudge and the pane-frozen restart); that half of
// the contract is pinned in section 5b.
// -------------------------------------------------------

test('idle arc + stale heartbeat liveness → monitor-rearm, heartbeat start injected', withHermit(async (h) => {
  writeConfig(h);
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
  const calls = tmuxCalls(h);
  expect(calls).toContain('/hermitd:heartbeat start');
  expect(calls).not.toContain('hermit-routines load');
}));

test('idle arc + stale routine-monitor liveness → monitor-rearm, hermit-routines load injected', withHermit(async (h) => {
  writeRoutineMonitorConfig(h);
  writeState(h, 'routine-monitor.runtime.json', { started_at: isoAgo(25 / 60), interval: 60, mode: 'monitor' });
  writeState(h, 'routine-monitor-liveness.json', { last_peek_at: isoAgo(20 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toContain('monitor-rearm');
  const calls = tmuxCalls(h);
  expect(calls).toContain('/hermitd:hermit-routines load');
  expect(calls).not.toContain('heartbeat start');
}));

// The anchor's `fired` age is no longer a re-arm signal: it only advances at the
// routine's next real fire, so a non-daily anchor (or a fire whose model turn stopped
// before `finish`) looked "missed" for most of every cycle and re-injected both
// bootstrap prompts every damper window. Live monitors are the only signal now.
test('stale heartbeat-restart fired age + live monitors → no re-arm', withHermit(async (h) => {
  writeRoutineMonitorConfig(h);
  fs.writeFileSync(state(h, 'routine-metrics.jsonl'), JSON.stringify({
    ts: isoAgoSeconds(28), routine_id: 'heartbeat-restart', event: 'fired', delivery: 'cron-create',
  }) + '\n');
  touchAgo(state(h, '.heartbeat'), 1800); // fresh — wedge detection stays out of the way
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgoSeconds(1 / 60) });
  writeState(h, 'routine-monitor.runtime.json', { started_at: isoAgo(9), interval: 60, mode: 'monitor' });
  writeState(h, 'routine-monitor-liveness.json', { last_peek_at: isoAgoSeconds(1 / 60) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 0);
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(events(h)).toBe('');
  expect(tmuxCalls(h)).not.toContain('hermit-routines load');
  expect(tmuxCalls(h)).not.toContain('heartbeat start');
}));

// 11g. The re-arm tiers must not reuse a pre-restart aliveness verdict.
//
// Step 4's pane-frozen escalation falls through to step 5 (doRestart returns, it
// does not exit). It guards on `sessionAlive`, which step 3c caches — so the verdict has
// to be refreshed after the restart killed the pane, or the tick injects slash commands
// into a session that no longer exists and stamps the 6h per-monitor damper on a send
// that never landed.
test('pane-frozen restart → no monitor re-arm into the killed session', withHermit(async (h) => {
  writeConfig(h);
  touchAgo(state(h, '.heartbeat'), 6 * 3600);
  // Stale heartbeat-monitor liveness: step 5 would fire if it trusted the cached verdict.
  writeState(h, 'heartbeat-monitor.runtime.json', { started_at: isoAgo(9) });
  writeState(h, 'heartbeat-liveness.json', { last_peek_at: isoAgo(8) });

  const paneContent = 'frozen pane';
  const frozenHash = crypto.createHash('sha256').update(`${paneContent}\n`).digest('hex');
  writeState(h, 'watchdog-state.json', {
    consecutive_stale: 2, last_pane_hash: frozenHash, last_nudge_at: '2026-01-01T00:00:00Z',
  });

  // tmux stub that actually dies on kill-session, unlike the always-alive writeFakeTmux.
  const log = path.join(h.dir, 'tmux-calls.log');
  const deadMarker = path.join(h.dir, 'tmux-dead');
  const stub = path.join(h.fakeBin, 'tmux');
  fs.writeFileSync(stub, `#!/usr/bin/env bash
case "$1" in
  has-session) [[ -f "${deadMarker}" ]] && exit 1 ; exit 0 ;;
  capture-pane) echo "${paneContent}" ;;
  send-keys) echo "send-keys $@" >> "${log}" ;;
  kill-session) echo "kill-session $@" >> "${log}" ; touch "${deadMarker}" ;;
esac
`);
  fs.chmodSync(stub, 0o755);
  writeFakePgrep(h, 1);

  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  expect(tmuxCalls(h)).toContain('kill-session');
  expect(tmuxCalls(h)).not.toContain('/hermitd:heartbeat start');
  expect(events(h)).not.toContain('monitor-rearm');
}));

// -------------------------------------------------------
// 12. checkWatchdog in doctor-check.ts: disabled → ok
// -------------------------------------------------------

const DOCTOR_BASE = {
  agent_name: null, language: null, timezone: null, escalation: 'balanced',
  channels: {}, env: {}, heartbeat: { enabled: true, every: '2h' },
  routines: [], quality_gate: { tier: 'budget' },
};

async function doctorWatchdogCheck(h: Hermit) {
  const r = await runScript('doctor-check.ts', { cwd: h.dir });
  const checks = JSON.parse(r.stdout).checks.filter((c: any) => c.id === 'watchdog');
  expect(checks.length).toBeGreaterThan(0); // watchdog check missing otherwise
  return checks[0];
}

const readWatchdogStateFile = (h: Hermit) => readJson(state(h, 'watchdog-state.json'));

/** Seed watchdog-state.json with a given last_run (null ⇒ omit the field). */
function setLastRun(h: Hermit, iso: string | null): void {
  const p = state(h, 'watchdog-state.json');
  const cur = fs.existsSync(p) ? readJson(p) : { consecutive_stale: 0 };
  if (iso === null) delete cur.last_run; else cur.last_run = iso;
  fs.writeFileSync(p, JSON.stringify(cur) + '\n');
}

function writeDoctorConfig(h: Hermit, enabled = true): void {
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'),
    JSON.stringify({
      watchdog: enabled
        ? { enabled: true, stale_factor: 2, escalate_after: 3, operator_grace: '15m' }
        : { enabled: false },
      ...DOCTOR_BASE,
    }, null, 2) + '\n');
}

test('doctor checkWatchdog: disabled → ok', withHermit(async (h) => {
  // context_hygiene is explicitly off: absent keys now
  // settle to template defaults (on), which would mean the tick is needed.
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'),
    JSON.stringify({
      watchdog: { enabled: false },
      context_hygiene: { clear: { enabled: false }, compact: { enabled: false } }, ...DOCTOR_BASE,
    }, null, 2) + '\n');
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('ok');
  expect(w.detail).toContain('disabled');
}));

// -------------------------------------------------------
// 13. checkWatchdog: enabled + recent restart → warn
// -------------------------------------------------------

test('doctor checkWatchdog: restart in last 7d → warn', withHermit(async (h) => {
  writeDoctorConfig(h);
  fs.writeFileSync(eventsFile(h), JSON.stringify({
    ts: isoAgoSeconds(0), action: 'restart', reason: 'dead-process',
  }) + '\n');
  setLastRun(h, new Date().toISOString()); // fresh liveness → exercise the restart-summary path, not the liveness warn
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('restarts: 1');
}));

// -------------------------------------------------------
// liveness: last_run stamp (script) + doctor liveness branches
// -------------------------------------------------------

test('run stamps last_run before the enabled gate (enabled:false)', withHermit(async (h) => {
  // Hygiene tiers explicitly off: absent keys now settle to template defaults
  // (on), which would send this minimal fixture down tmux-dependent paths.
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'),
    '{"watchdog": {"enabled": false}, "context_hygiene": {"compact": {"enabled": false}}}\n');
  const r = await watchdog(h, 'run');
  expect(r.exitCode).toBe(0);
  const ws = readWatchdogStateFile(h);
  expect(typeof ws.last_run).toBe('string');
  expect(Date.now() - Date.parse(ws.last_run)).toBeLessThan(60_000);
}));

test('doctor checkWatchdog: enabled + fresh last_run + quiet → ok, shows last tick', withHermit(async (h) => {
  writeDoctorConfig(h);
  setLastRun(h, new Date().toISOString());
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('ok');
  expect(w.detail).toContain('last tick');
}));

test('doctor checkWatchdog: enabled + stale last_run + tmux → warn, install hint', withHermit(async (h) => {
  writeDoctorConfig(h);          // setupHermit runtime_mode = tmux
  setLastRun(h, isoAgo(1));      // 1h ago → stale
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).toContain('hermitd watchdog install');
}));

test('doctor checkWatchdog: enabled + missing last_run + docker → warn, recreate hint', withHermit(async (h) => {
  writeDoctorConfig(h);
  patchRuntime(h, { runtime_mode: 'docker' });
  // no watchdog-state.json → last_run missing
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).toContain('force-recreate');
}));

test('doctor checkWatchdog: enabled + stale last_run + unknown runtime → warn, both hints', withHermit(async (h) => {
  writeDoctorConfig(h);
  fs.rmSync(state(h, 'runtime.json')); // runtime_mode unknown
  setLastRun(h, isoAgo(1));
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('hermitd watchdog install');
  expect(w.detail).toContain('force-recreate');
}));

test('doctor checkWatchdog: stale last_run + recent restart → not-firing wins, summary suppressed', withHermit(async (h) => {
  writeDoctorConfig(h);
  fs.writeFileSync(eventsFile(h), JSON.stringify({
    ts: isoAgoSeconds(0), action: 'restart', reason: 'dead-process',
  }) + '\n');
  setLastRun(h, isoAgo(1)); // stale → liveness takes precedence
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('warn');
  expect(w.detail).toContain('not firing');
  expect(w.detail).not.toContain('restarts:');
}));

test('doctor checkWatchdog: restart tier disabled but standalone clear active → liveness still checked',
  withHermit(async (h) => {
    fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'),
      JSON.stringify({ watchdog: { enabled: false }, context_hygiene: { clear: { enabled: true } }, ...DOCTOR_BASE }, null, 2) + '\n');
    setLastRun(h, isoAgo(1)); // stale — the hygiene tier still needs a live scheduler tick
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('warn');
    expect(w.detail).toContain("scheduler isn't firing");
    expect(w.detail).not.toContain('enabled but not firing');
  }));

test('doctor checkWatchdog: scheduler_enabled false → ok, opted out, no install remedy',
  withHermit(async (h) => {
    fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'),
      JSON.stringify({
        watchdog: { enabled: true, scheduler_enabled: false },
        context_hygiene: { clear: { enabled: true } },
        ...DOCTOR_BASE,
      }, null, 2) + '\n');
    setLastRun(h, isoAgo(1));
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('ok');
    expect(w.detail).toContain('scheduler opted out');
    expect(w.detail).not.toContain('hermitd watchdog install');
  }));

// scheduler_enabled only gates hermitd-start's OS-timer install. Docker's tick comes
// from the entrypoint loop, which the flag cannot disable — so a stale flag carried
// over from a host uninstall must not silence a genuinely dead container loop.
test('doctor checkWatchdog: scheduler_enabled false + docker → still warns on a dead tick',
  withHermit(async (h) => {
    fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'),
      JSON.stringify({
        watchdog: { enabled: true, scheduler_enabled: false },
        ...DOCTOR_BASE,
      }, null, 2) + '\n');
    patchRuntime(h, { runtime_mode: 'docker' });
    setLastRun(h, isoAgo(1));
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('warn');
    expect(w.detail).toContain('not firing');
    expect(w.detail).toContain('force-recreate');
  }));

test('doctor checkWatchdog: restart tier disabled + hygiene active + fresh tick → ok, labels the tier split',
  withHermit(async (h) => {
    fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'),
      JSON.stringify({
        watchdog: { enabled: false },
        context_hygiene: { compact: { enabled: true, min_context_tokens: 150000, min_interval: '4h' } },
        ...DOCTOR_BASE,
      }, null, 2) + '\n');
    setLastRun(h, new Date().toISOString());
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('ok');
    expect(w.detail).toContain('restart tier disabled, hygiene tier active');
  }));

test('doctor checkWatchdog: last_hygiene_eval surfaces in the ok detail', withHermit(async (h) => {
  writeDoctorConfig(h);
  const p = state(h, 'watchdog-state.json');
  fs.writeFileSync(p, JSON.stringify({
    last_run: new Date().toISOString(),
    last_hygiene_eval: { compact: { ts: new Date().toISOString(), outcome: 'fired', prompt_tokens: 250000 } },
  }) + '\n');
  const w = await doctorWatchdogCheck(h);
  expect(w.status).toBe('ok');
  expect(w.detail).toContain('compact/fired');
}));

test('doctor checkWatchdog: a leftover clear-tier eval never surfaces, only compact',
  withHermit(async (h) => {
    writeDoctorConfig(h);
    const older = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const newer = new Date().toISOString();
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      last_run: new Date().toISOString(),
      last_hygiene_eval: {
        clear: { ts: newer, outcome: 'skip:under-threshold', prompt_tokens: 300000 },
        compact: { ts: older, outcome: 'fired', prompt_tokens: 300000 },
      },
      hygiene_eval_counts: { since: older, clear: { 'skip:under-threshold': 3 }, compact: { fired: 1 } },
    }) + '\n');
    const w = await doctorWatchdogCheck(h);
    expect(w.detail).toContain('compact/fired');
    expect(w.detail).not.toContain('clear/');
    expect(w.detail).not.toContain('clear first-blockers');
  }));

test('doctor checkWatchdog: stale scheduler + stuck shutdown stamp → not-firing wins',
  withHermit(async (h) => {
    writeDoctorConfig(h);
    patchRuntime(h, { shutdown_completed_at: isoAgo(72) });
    setLastRun(h, isoAgo(1)); // scheduler dead — the higher-severity signal
    const w = await doctorWatchdogCheck(h);
    expect(w.status).toBe('warn');
    expect(w.detail).toContain('not firing'); // liveness remediation, not the stamp warning
  }));

test('doctor checkWatchdog: fresh shutdown stamp on an alive session → no false positive',
  withHermit(async (h) => {
    writeDoctorConfig(h);
    // A real in-flight hermitd-stop stamps shutdown_requested_at seconds before
    // A fresh shutdown request protects the graceful-stop window.
    patchRuntime(h, { shutdown_requested_at: new Date().toISOString() });
    setLastRun(h, new Date().toISOString());
    const w = await doctorWatchdogCheck(h);
    expect(w.detail).not.toContain('shutdown stamp');
  }));

// -------------------------------------------------------
// install / uninstall without systemctl (Linux-only path)
// -------------------------------------------------------

const isLinux = process.platform === 'linux';

test.if(isLinux)('install without systemctl → exit 0, prints crontab, no traceback', withHermit(async (h) => {
  writeConfig(h);
  // fake-bin has tmux/pgrep stubs but no systemctl — simulates systemd-less host
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'install', { restrictPath: true });
  const out = r.stdout + r.stderr;
  expect(r.exitCode).toBe(0);
  expect(out).toContain('crontab'); // expected crontab guidance
  expect(out).not.toContain('Traceback');
}));

test.if(isLinux)('uninstall without systemctl → exit 0, no traceback', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'uninstall', { restrictPath: true });
  expect(r.exitCode).toBe(0);
  expect(r.stdout + r.stderr).not.toContain('Traceback');
}));

// -------------------------------------------------------
// install/uninstall flip watchdog.enabled — issue #895. Only where a timer was
// actually registered (systemd/launchd); the cron fallback prints guidance instead
// of claiming an activation that never happened.
// -------------------------------------------------------

const configPath = (h: Hermit) => path.join(h.dir, '.hermit', 'config.json');

/** Install writes units under $HOME — never the maintainer's real one. */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-fakehome-')));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test.if(isLinux)('install with systemd → flips watchdog.enabled true, preserves siblings', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: false, scheduler_enabled: false });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  writeFakeSystemctl(h);
  await withFakeHome(async (fakeHome) => {
    const r = await watchdog(h, 'install', { env: { HOME: fakeHome } });
    expect(r.exitCode).toBe(0);
    const config = readJson(configPath(h));
    expect(config.watchdog.enabled).toBe(true);
    expect(config.watchdog.scheduler_enabled).toBe(true);
    expect(config.watchdog.stale_factor).toBe(2);
    expect(config.watchdog.escalate_after).toBe(3);
    expect(config.watchdog.operator_grace).toBe('15m');
  });
}));

test.if(isLinux)('uninstall with systemd → flips watchdog.enabled and scheduler_enabled false', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: true, scheduler_enabled: true });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  writeFakeSystemctl(h);
  await withFakeHome(async (fakeHome) => {
    const r = await watchdog(h, 'uninstall', { env: { HOME: fakeHome } });
    expect(r.exitCode).toBe(0);
    const config = readJson(configPath(h));
    expect(config.watchdog.enabled).toBe(false);
    expect(config.watchdog.scheduler_enabled).toBe(false);
  });
}));

// Re-running install is the doctor's own remedy for a stale tick or an unbaked unit
// PATH, and hygiene-only (timer installed, restarts off) is a state it reports as ok.
test.if(isLinux)('re-install over an existing timer → leaves a deliberate false alone', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: false });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  writeFakeSystemctl(h);
  await withFakeHome(async (fakeHome) => {
    await watchdog(h, 'install', { env: { HOME: fakeHome } });
    writeConfig(h, '2h', { enabled: false });
    const unitDir = path.join(fakeHome, '.config', 'systemd', 'user');
    const serviceFile = fs.readdirSync(unitDir).find((f) => f.endsWith('.service'))!;
    const servicePath = path.join(unitDir, serviceFile);
    fs.writeFileSync(servicePath, fs.readFileSync(servicePath, 'utf-8').replace(/^KillMode=process\n/m, ''));
    const r = await watchdog(h, 'install', { env: { HOME: fakeHome } });
    expect(fs.readFileSync(servicePath, 'utf-8')).toMatch(/^KillMode=process$/m);
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toContain('Restarts stay off until watchdog.enabled is true');
    const config = readJson(configPath(h));
    expect(config.watchdog.enabled).toBe(false);
    expect(config.watchdog.scheduler_enabled).toBe(true);
  });
}));

test.if(isLinux)('systemctl enable failure → exit 1, watchdog.enabled untouched', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: false });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  writeFakeSystemctl(h, 1);
  await withFakeHome(async (fakeHome) => {
    const r = await watchdog(h, 'install', { env: { HOME: fakeHome } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain('Failed to install systemd user timer');
    const config = readJson(configPath(h));
    expect(config.watchdog.enabled).toBe(false);
    expect(config.watchdog.scheduler_enabled).toBeUndefined();
  });
}));

test.if(isLinux)('install without systemctl → leaves watchdog.enabled false, prints enable guidance', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: false });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const r = await watchdog(h, 'install', { restrictPath: true });
  expect(r.exitCode).toBe(0);
  expect(r.stdout + r.stderr).toContain('Restarts stay off until watchdog.enabled is true');
  const config = readJson(configPath(h));
  expect(config.watchdog.enabled).toBe(false);
  expect(config.watchdog.scheduler_enabled).toBeUndefined();
}));

test.if(isLinux)('install with no config.json → exit 0, creates no config', withHermit(async (h) => {
  // setupHermit() does not write config.json; writeConfig() is what creates it,
  // and this test deliberately skips that call.
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  writeFakeSystemctl(h);
  await withFakeHome(async (fakeHome) => {
    const r = await watchdog(h, 'install', { env: { HOME: fakeHome } });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(configPath(h))).toBe(false);
  });
}));

// -------------------------------------------------------
// Unit PATH baking. A generated unit runs without ~/.bun/bin on PATH, so the
// shim's bare `bun` exits 127 on every tick — silently, forever. These assert on
// the PATH the unit actually ends up running with, not on the text of the line
// that sets it: a substring match on `PATH=` passes happily for a cron line whose
// assignment never reaches the command.
// -------------------------------------------------------

/** Fake systemctl: succeeds at everything, so install can render real units. */
function writeFakeSystemctl(h: Hermit, exitCode = 0): void {
  const stub = path.join(h.fakeBin, 'systemctl');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  fs.chmodSync(stub, 0o755);
}

// The five-minute schedule line install prints for the cron fallback.
function cronLineFrom(output: string): string | undefined {
  return output.split('\n').map((s) => s.trim()).find((s) => s.startsWith('*/5 * * * *'));
}

test.if(isLinux)('cron fallback line applies its PATH to the watchdog, not just to cd', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  // Stand in for the binary cron would invoke; it reports the PATH it received.
  // Absolute interpreter on purpose: the baked PATH under restrictPath holds only
  // bun's dir and the fake bin, so a `/usr/bin/env bash` shebang could not resolve.
  const wd = path.join(h.dir, '.hermit', 'bin', 'hermitd-watchdog');
  fs.writeFileSync(wd, '#!/bin/sh\necho "$PATH"\n');
  fs.chmodSync(wd, 0o755);

  const r = await watchdog(h, 'install', { restrictPath: true });
  expect(r.exitCode).toBe(0);
  const line = cronLineFrom(r.stdout + r.stderr);
  expect(line).toBeDefined();

  // Run exactly what cron hands to /bin/sh: the line minus its five schedule
  // fields. The ambient PATH deliberately lacks bun's dir, so anything the
  // command sees must have come from the baked assignment.
  const command = line!.split(/\s+/).slice(5).join(' ');
  const proc = Bun.spawn({
    cmd: ['sh', '-c', command],
    cwd: h.dir,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const seenPath = await new Response(proc.stdout).text();
  await proc.exited;
  expect(seenPath.trim().split(':')).toContain(path.dirname(process.execPath));
}));

test.if(isLinux)('systemd unit keeps every inherited PATH entry and adds bun\'s dir', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  writeFakeSystemctl(h);
  const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-fakehome-')));
  try {
    const r = await watchdog(h, 'install', { env: { HOME: fakeHome } });
    expect(r.exitCode).toBe(0);

    const unitDir = path.join(fakeHome, '.config', 'systemd', 'user');
    const serviceFile = fs.readdirSync(unitDir).find((f) => f.endsWith('.service'));
    expect(serviceFile).toBeDefined();
    const unit = fs.readFileSync(path.join(unitDir, serviceFile!), 'utf-8');
    expect(unit).toMatch(/^KillMode=process$/m);

    const baked = unit.match(/^Environment="PATH=(.*)"$/m)?.[1];
    expect(baked).toBeDefined();
    expect(unit).not.toContain('{{UNIT_PATH}}');

    // bun resolves — the 127 this fixes.
    expect(baked!.split(':')).toContain(path.dirname(process.execPath));
    // And nothing already working was dropped: Environment= replaces the unit's
    // PATH rather than extending it, and the restart path needs claude and tmux,
    // which live on the inherited PATH and not in any hardcodable list.
    // Relative entries are dropped on purpose — they would resolve against the
    // unit's WorkingDirectory rather than against the installer's shell.
    for (const entry of `${h.fakeBin}:${process.env.PATH}`.split(':').filter((e) => e && path.isAbsolute(e))) {
      expect(baked!.split(':')).toContain(entry);
    }
    // systemd applies Environment= to the ExecStart that follows it.
    expect(unit.indexOf('Environment=')).toBeLessThan(unit.indexOf('ExecStart='));
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}));

test.if(isLinux)('a PATH entry with % survives per-target escaping', withHermit(async (h) => {
  writeConfig(h);
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  const oddEntry = '/opt/we%ird dir';

  // cron: an unescaped % ends the command and sends the rest to stdin (crontab(5)).
  const cron = await watchdog(h, 'install', { env: { PATH: `${oddEntry}:${h.fakeBin}` } });
  expect(cronLineFrom(cron.stdout + cron.stderr)).toContain('/opt/we\\%ird dir');

  // systemd: % introduces a specifier, so a literal one is %% (systemd.unit(5)).
  writeFakeSystemctl(h);
  const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-fakehome-')));
  try {
    await watchdog(h, 'install', { env: { PATH: `${oddEntry}:${h.fakeBin}`, HOME: fakeHome } });
    const unitDir = path.join(fakeHome, '.config', 'systemd', 'user');
    const serviceFile = fs.readdirSync(unitDir).find((f) => f.endsWith('.service'))!;
    const unit = fs.readFileSync(path.join(unitDir, serviceFile), 'utf-8');
    expect(unit).toContain('/opt/we%%ird dir');
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}));

// A source-level assertion, not a behavioral one. The launchd tests below drive the
// real branch through the fake-darwin preload; this one pins the ordering directly
// (load is a no-op on an already-loaded label, so re-running install would silently
// keep the stale plist).
test('cmdInstall unloads the launchd label before loading it', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'hermitd-watchdog-install.ts'), 'utf-8');
  const install = src.slice(src.indexOf('function cmdInstall'), src.indexOf('function cmdUninstall'));
  const unloadIdx = install.indexOf("'unload'");
  const loadIdx = install.indexOf("'load'");
  expect(unloadIdx).toBeGreaterThan(-1);
  expect(loadIdx).toBeGreaterThan(-1);
  expect(unloadIdx).toBeLessThan(loadIdx);
});

// ---- launchd install (darwin branch, reached on Linux via the platform preload) ----

const FAKE_DARWIN = path.join(import.meta.dir, 'helpers', 'fake-darwin.ts');

/** Record every launchctl invocation and track whether the label is loaded, so
 *  `list` answers the way the real one does: exit 0 loaded, non-zero not. */
function writeFakeLaunchctl(h: Hermit): { log: string; loadedMarker: string } {
  const log = path.join(h.dir, 'launchctl-calls.log');
  const loadedMarker = path.join(h.dir, 'launchctl-loaded');
  const stub = path.join(h.fakeBin, 'launchctl');
  fs.writeFileSync(stub, `#!/usr/bin/env bash
echo "$@" >> "${log}"
case "$1" in
  load) touch "${loadedMarker}" ;;
  unload) rm -f "${loadedMarker}" ;;
  list) [[ -e "${loadedMarker}" ]] || exit 113 ;;
esac
exit 0
`);
  fs.chmodSync(stub, 0o755);
  return { log, loadedMarker };
}

/** Run `install` with process.platform forced to darwin and HOME sandboxed. */
function darwinInstall(h: Hermit, home: string) {
  return watchdog(h, 'install', { preload: FAKE_DARWIN, env: { HOME: home } });
}

const readLog = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
const plistIn = (home: string) =>
  fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')).map((f) => path.join(home, 'Library', 'LaunchAgents', f));

test('launchd first install → writes the plist, unloads then loads', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: false, scheduler_enabled: false });
  const { log } = writeFakeLaunchctl(h);
  await withFakeHome(async (home) => {
    const r = await darwinInstall(h, home);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Installed LaunchAgent');
    const plists = plistIn(home);
    expect(plists).toHaveLength(1);
    expect(fs.readFileSync(plists[0], 'utf-8')).toContain('com.hermit.watchdog.');
    const calls = readLog(log).trim().split('\n');
    expect(calls[0]).toContain('unload');
    expect(calls[1]).toContain('load');
    const config = readJson(configPath(h));
    expect(config.watchdog.scheduler_enabled).toBe(true);
    expect(config.watchdog.enabled).toBe(true);
  });
}));

// The restart the watchdog orders spawns a boot that re-runs install seconds later.
// An unconditional reload there unloads the LaunchAgent running that very tick.
test('launchd re-install with an unchanged plist → no launchctl call', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: false, scheduler_enabled: false });
  const { log } = writeFakeLaunchctl(h);
  await withFakeHome(async (home) => {
    await darwinInstall(h, home);
    const afterFirst = readLog(log).trim().split('\n').length;
    const before = fs.readFileSync(plistIn(home)[0], 'utf-8');

    const r = await darwinInstall(h, home);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('LaunchAgent unchanged');
    expect(r.stdout).not.toContain('Installed LaunchAgent');
    // The liveness probe is allowed; re-registering the running job is not.
    const probes = readLog(log).trim().split('\n').slice(afterFirst);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toStartWith('list ');
    expect(fs.readFileSync(plistIn(home)[0], 'utf-8')).toBe(before);
    expect(readJson(configPath(h)).watchdog.scheduler_enabled).toBe(true);
  });
}));

// An identical plist does not prove the label is registered: the write lands before
// the load, so a failed load or an operator's own unload leaves the file intact with
// nothing running. Re-running install is the documented repair for exactly that.
test('launchd re-install with the label unloaded → reloads despite the identical plist', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: false, scheduler_enabled: false });
  const { log, loadedMarker } = writeFakeLaunchctl(h);
  await withFakeHome(async (home) => {
    await darwinInstall(h, home);
    fs.rmSync(loadedMarker);
    const afterFirst = readLog(log).trim().split('\n').length;

    const r = await darwinInstall(h, home);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Installed LaunchAgent');
    expect(r.stdout).not.toContain('LaunchAgent unchanged');
    const calls = readLog(log).trim().split('\n').slice(afterFirst);
    expect(calls.some((c) => c.startsWith('load '))).toBe(true);
    expect(fs.existsSync(loadedMarker)).toBe(true);
  });
}));

test('launchd re-install after the plist drifts → rewrites and reloads', withHermit(async (h) => {
  writeConfig(h, '2h', { enabled: false, scheduler_enabled: false });
  const { log } = writeFakeLaunchctl(h);
  await withFakeHome(async (home) => {
    await darwinInstall(h, home);
    const plistPath = plistIn(home)[0];
    const rendered = fs.readFileSync(plistPath, 'utf-8');
    fs.writeFileSync(plistPath, rendered + '<!-- drifted -->\n');
    const afterFirst = readLog(log).trim().split('\n').length;

    const r = await darwinInstall(h, home);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Installed LaunchAgent');
    expect(fs.readFileSync(plistPath, 'utf-8')).toBe(rendered);
    const calls = readLog(log).trim().split('\n').slice(afterFirst);
    expect(calls[0]).toContain('unload');
    expect(calls[1]).toContain('load');
  });
}));

// -------------------------------------------------------
// post-close clear tests
// -------------------------------------------------------

function writeClearMarker(h: Hermit): void {
  fs.writeFileSync(state(h, 'clear-requested.json'),
    JSON.stringify({ requested_at: new Date().toISOString(), reason: 'daily-auto-close' }) + '\n');
}

// watchdog.enabled: false verifies clear fires independently of the watchdog restart path
function writePostCloseClearConfig(h: Hermit): void {
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
    post_close_clear: true,
    watchdog: { enabled: false },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
  }, null, 2) + '\n');
}

test('retired post-close marker does not dispatch a clear', withHermit(async (h) => {
  writePostCloseClearConfig(h);
  writeClearMarker(h);
  writeState(h, 'last-operator-action.json', { at: isoAgo(0.5) });
  writeFakeTmux(h, 0);
  writeFakePgrep(h, 1);
  expect((await watchdog(h, 'run')).exitCode).toBe(0);
  expect(tmuxCalls(h)).not.toContain('/clear');
  expect(fs.existsSync(state(h, 'clear-requested.json'))).toBe(true);
}));

test('standalone clear: frozen status cache cannot trigger a spurious compact',
  withHermit(async (h) => {
    fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
      watchdog: { enabled: false },
      context_hygiene: { compact: { enabled: true, min_context_tokens: 150000, min_interval: '4h' } },
      heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
    }, null, 2) + '\n');
    // The retired status cache is frozen and ignored by context hygiene.
    patchRuntime(h, { session_id: CC_SESSION_ID, cc_session_id: CC_SESSION_ID });
    writeState(h, 'execution.json', { state: 'idle', cc_session_id: CC_SESSION_ID, at: isoAgo(1) });
    fs.mkdirSync(path.join(h.dir, '.hermit', 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(h.dir, '.hermit', 'sessions', '.status.json'),
      JSON.stringify({ session_id: SESSION_ID }) + '\n',
    );
    // Bloated pre-clear entry — the dead context's final turn.
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(2) }) + '\n');
    // Pre-prime the compact tracker's pane hash so quiescence is already satisfied —
    // absent the fix, tick 2 alone would be enough for the compactor to misfire.
    primeCompactHash(h, STATIC_HASH);
    const primed = readWatchdogStateFile(h);
    primed.last_pane_hash_standalone = STATIC_HASH;
    writeState(h, 'watchdog-state.json', primed);
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    // Tick 1: standalone /clear fires and leaves the frozen status cache intact.
    const r1 = await watchdog(h, 'run');
    expect(r1.exitCode).toBe(0);
    const tmuxLog1 = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog1).toContain('/clear');
    expect(readJson(state(h, 'context-clear.json')).last_trigger.reason).toBe('quiet');
    expect(fs.existsSync(path.join(h.dir, '.hermit', 'sessions', '.status.json'))).toBe(true);

    // Tick 2: no harness identity is available, so the frozen cache cannot supply one.
    patchRuntime(h, { session_id: null, cc_session_id: null });
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const tmuxLog2 = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog2).not.toContain('/compact');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).not.toContain('context-compact');
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact?.outcome).toBe('skip:no-session-id');
  }));

// -------------------------------------------------------
// context-clear tests
// -------------------------------------------------------

const SESSION_ID = 'S-001';
/** The resident's Claude Code session id — the identity the hygiene tiers key on. */
const CC_SESSION_ID = 'cc-resident-001';

/** Write a cost-log entry under <hermit.dir>/.claude/cost-log.jsonl. */
function writeCostLog(h: Hermit, entries: {
  session_id: string; input_tokens: number; cache_write_tokens: number; cache_read_tokens: number;
  timestamp?: string; api_calls?: number; max_prompt_tokens?: number; subagent?: boolean;
  observed_at?: string; last_call_prompt_tokens?: number;
  /** Defaults to CC_SESSION_ID — the resident. Pass another id (or `guest`) to model a
   *  row written by a different session in the same folder. */
  cc_session_id?: string; guest?: boolean;
}[]): void {
  const dir = path.join(h.dir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map(e => JSON.stringify({
    timestamp: e.timestamp ?? new Date().toISOString(),
    session_id: e.session_id,
    cc_session_id: e.cc_session_id ?? CC_SESSION_ID,
    ...(e.guest ? { guest: true } : {}),
    input_tokens: e.input_tokens,
    cache_write_tokens: e.cache_write_tokens,
    cache_read_tokens: e.cache_read_tokens,
    output_tokens: 500,
    total_tokens: e.input_tokens + e.cache_write_tokens + e.cache_read_tokens + 500,
    estimated_cost_usd: 1.0,
    ...(e.api_calls !== undefined ? { api_calls: e.api_calls } : {}),
    ...(e.max_prompt_tokens !== undefined ? { max_prompt_tokens: e.max_prompt_tokens } : {}),
    ...(e.observed_at !== undefined ? { observed_at: e.observed_at } : {}),
    ...(e.last_call_prompt_tokens !== undefined ? { last_call_prompt_tokens: e.last_call_prompt_tokens } : {}),
    ...(e.subagent !== undefined ? { subagent: e.subagent } : {}),
  })).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'cost-log.jsonl'), lines);
}

/** Write runtime.json for an always-on hermit.
 *  `cc_session_id` is what the hygiene tiers resolve on (startup-context.ts stamps it
 *  under HERMIT_MANAGED); `session_id` is the S-NNN arc label, kept because other
 *  watchdog paths still read it. */
function writeAlwaysOnRuntime(h: Hermit): void {
  patchRuntime(h, { runtime_mode: 'tmux', session_id: SESSION_ID, cc_session_id: CC_SESSION_ID });
}

// -------------------------------------------------------
// context-compact tests (PROP-011 commit 3: maybeContextCompact)
// -------------------------------------------------------

/** Write config with context_hygiene.compact enabled and watchdog.enabled: false (pre-enabled gate). */
function writeContextCompactConfig(h: Hermit, opts: {
  minContextTokens?: number; minInterval?: string;
  routines?: unknown[]; timezone?: string;
} = {}): void {
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: false },
    context_hygiene: {
      compact: {
        enabled: true,
        min_context_tokens: opts.minContextTokens ?? 150000,
        min_interval: opts.minInterval ?? '4h',
      },
    },
    heartbeat: { enabled: true, every: '2h', active_hours: { start: '00:00', end: '23:59' } },
    routines: opts.routines ?? [],
    timezone: opts.timezone ?? 'UTC',
  }, null, 2) + '\n');
}

function writeCompactMarker(h: Hermit, ageSeconds = 0): void {
  fs.writeFileSync(state(h, 'compact-requested.json'), JSON.stringify({
    requested_at: new Date(Date.now() - ageSeconds * 1000).toISOString(), reason: 'test',
  }) + '\n');
}

/** Write watchdog-state with a specific last_pane_hash_compact (simulates second tick for the compact tracker). */
function primeCompactHash(h: Hermit, hash: string): void {
  const p = state(h, 'watchdog-state.json');
  const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  fs.writeFileSync(p, JSON.stringify({ ...existing, last_pane_hash_compact: hash }) + '\n');
}

const STATIC_HASH = crypto.createHash('sha256').update('static pane content\n').digest('hex');

test('context_compact: bloated idle + quiescent + operator silent → /compact sent on 2nd tick, context_cleared never set',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h);
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    const snapshotPath = path.join(h.dir, 'runtime-at-compact.json');
    writeFakeTmux(h, 0, 'static pane content', snapshotPath);
    writeFakePgrep(h, 1);

    const r1 = await watchdog(h, 'run'); // tick 1: hash recorded, no compact yet
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);

    const r2 = await watchdog(h, 'run'); // tick 2: same hash → /compact fires
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain(composeCompactSteeringMessage());
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-compact');
    // context_cleared is context_clear's marker only — compact must never touch it.
    const runtimeAtCompact = readJson(snapshotPath);
    expect(runtimeAtCompact.context_cleared).not.toBe(true);
  }));

test('context_compact: boundary marker waives min_interval but not the 60k floor',
  withHermit(async (h) => {
    // Threshold low enough that 40K tokens clears it, but the absolute 60K floor still blocks.
    writeContextCompactConfig(h, { minContextTokens: 10000 });
    writeAlwaysOnRuntime(h);
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 20000, cache_write_tokens: 0, cache_read_tokens: 20000 }]); // 40K total
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);
    primeCompactHash(h, STATIC_HASH);
    writeCompactMarker(h); // fresh marker — would waive min_interval, but floor is absolute

    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    // A fresh marker is preserved (not wasted) when the floor blocks the compact —
    // it keeps its interval-cooldown waiver until the compact it enables actually
    // fires or it goes stale. Consuming it here would drop the waiver a tick early.
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(true);
  }));

test('context_compact: fresh boundary marker waives min_interval and fires again',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 150000, minInterval: '4h' });
    writeAlwaysOnRuntime(h);
    const ts1 = new Date(Date.now() - 3600_000).toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts1 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: prime hash
    await watchdog(h, 'run'); // tick 2: fires — sets last_compacted_at to now

    const ts2 = new Date().toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 100000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts2 }]);
    await watchdog(h, 'run'); // tick 3: re-primes hash after reset

    writeCompactMarker(h); // fresh boundary marker — waives the still-open min_interval
    await watchdog(h, 'run'); // tick 4: hash matches, marker waives interval → fires again

    const events = fs.readFileSync(eventsFile(h), 'utf-8').split('\n').filter(l => l.includes('context-compact'));
    expect(events.length).toBe(2);
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(false); // consumed
  }));

test('context_compact: fresh boundary marker survives the two-tick quiescence wait under an active interval cooldown',
  withHermit(async (h) => {
    // Regression: the marker used to be consumed on read (tick 1), a full tick before
    // the quiescence gate confirms the pane is stable (tick 2) — so under an active
    // interval cooldown the waiver was gone by the time the compact could fire, and
    // the compact the boundary requested never happened. The hash is deliberately NOT
    // pre-primed here, mirroring a real boundary where work just churned the pane.
    writeContextCompactConfig(h, { minContextTokens: 150000, minInterval: '4h' });
    writeAlwaysOnRuntime(h);
    // Interval cooldown active: compacted 1h ago, on a *different* cost entry so
    // idempotence isn't the blocker — this isolates min_interval as the thing the
    // marker must waive.
    fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
      last_compacted_at: new Date(Date.now() - 3600_000).toISOString(),
      last_compacted_cost_ts: 'earlier-entry',
    }) + '\n');
    const ts = new Date().toISOString();
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000, timestamp: ts }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);
    writeCompactMarker(h); // fresh marker, hash not pre-primed

    const r1 = await watchdog(h, 'run'); // tick 1: records hash, not yet stable → no compact, marker preserved
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(true); // waiver survives to the next tick

    const r2 = await watchdog(h, 'run'); // tick 2: pane stable, marker still waives the cooldown → fires
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
    expect(fs.existsSync(state(h, 'compact-requested.json'))).toBe(false); // consumed on fire
  }));

// -------------------------------------------------------
// context-hygiene starvation fixes: subagent-tail skip, idle session-id
// fallback, real-context metric, negative telemetry (last_hygiene_eval)
// -------------------------------------------------------

test('context_compact: subagent tail entry is ignored — bloated main line still triggers',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h);
    writeCostLog(h, [
      { session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }, // main turn line, 250k
      { session_id: SESSION_ID, input_tokens: 500, cache_write_tokens: 0, cache_read_tokens: 500, subagent: true }, // dispatched-subagent tail, tiny
    ]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: hash recorded
    const r2 = await watchdog(h, 'run'); // tick 2: same hash → fires
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
  }));

test('context_compact: idle-phase compaction keys on cc_session_id, with no S-NNN arc open',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    // No open S-NNN arc — runtime.session_id is null, as it is for most of an
    // always-on hermit's life between sessions. cc_session_id does not follow the arc,
    // so the resident stays identifiable and the tier still fires.
    patchRuntime(h, { runtime_mode: 'tmux', session_id: null, cc_session_id: CC_SESSION_ID });
    writeCostLog(h, [{ session_id: 'S-001', input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain(`cc_session_id ${CC_SESSION_ID}`);
  }));

test('context_compact: another session in the folder cannot drive the resident\'s compaction',
  withHermit(async (h) => {
    // Issue #916, the measured defect: a worktree/guest session's bloated turn used to be
    // read as the resident's own context (via the shared S-NNN label or .status.json) and
    // typed /compact into the resident's pane while it sat well under threshold.
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h);
    fs.mkdirSync(path.join(h.dir, '.hermit', 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(h.dir, '.hermit', 'sessions', '.status.json'),
      JSON.stringify({ session_id: 'cc-other-session' }) + '\n',
    );
    writeCostLog(h, [
      // Resident's own turn: ~90k, comfortably under the 100k compactible threshold.
      { session_id: SESSION_ID, cc_session_id: CC_SESSION_ID, input_tokens: 40000, cache_write_tokens: 0, cache_read_tokens: 100000 },
      // A guest's turn afterwards, same arc label, 250k — the newest row in the log.
      { session_id: SESSION_ID, cc_session_id: 'cc-other-session', guest: true, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 },
    ]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    // The tier bails on the token gate before any pane work, so tmux is never invoked
    // and the log may not exist at all — either way, nothing was typed.
    const tmuxLogPath = path.join(h.dir, 'tmux-calls.log');
    const tmuxLog = fs.existsSync(tmuxLogPath) ? fs.readFileSync(tmuxLogPath, 'utf-8') : '';
    expect(tmuxLog).not.toContain('/compact');
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact?.outcome).toBe('skip:under-threshold');
    expect(ws.last_hygiene_eval?.compact?.cc_session_id).toBe(CC_SESSION_ID);
  }));

test('context_compact: legacy multi-call entry averages down and stays compact-eligible',
  withHermit(async (h) => {
    // Old semantics summed every API call in the turn: a 5-call turn at a real ~300k
    // context logged 1.5M "prompt tokens". The average (still the pre-max_prompt_tokens
    // fallback, since this entry predates that field) lands above the 150k compact
    // threshold.
    writeContextCompactConfig(h, { minContextTokens: 150000 });
    writeAlwaysOnRuntime(h);
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 1500000, cache_write_tokens: 0, cache_read_tokens: 0, api_calls: 5 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: tracker primes its hash
    const r2 = await watchdog(h, 'run'); // tick 2
    expect(r2.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('/compact');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-compact');
  }));

test('context_compact: last_hygiene_eval records the fire outcome and prompt token count',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h);
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact).toMatchObject({ outcome: 'fired', prompt_tokens: 250000 });
  }));

// -------------------------------------------------------
// poisoned cost-entry guards (both hygiene tiers)
//
// The proxy both tiers act on ("last cost entry for this session") lies in two ways:
// the entry was observed before the context was reset, or the number is impossible.
// Measured live: a re-billed pre-compaction entry drove a compaction of a context 47k
// UNDER the threshold.
// -------------------------------------------------------

test('context_compact: entry observed after the last context reset still fires',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h);
    patchRuntime(h, { last_context_reset_at: isoAgo(2) });
    writeCostLog(h, [{
      session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000,
      observed_at: isoAgo(1),
    }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact?.outcome).toBe('fired');
  }));

test('context_compact: last_call_prompt_tokens wins over the turn-peak max_prompt_tokens',
  withHermit(async (h) => {
    writeContextCompactConfig(h);
    writeAlwaysOnRuntime(h);
    // A turn that compacted mid-flight: peak 250k (dead), newest call 30k (real) — under
    // the 60k floor, so the tier must skip rather than compact a freshly-compacted context.
    writeCostLog(h, [{
      session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000,
      max_prompt_tokens: 250000, last_call_prompt_tokens: 30000,
    }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    const ws = readJson(state(h, 'watchdog-state.json'));
    expect(ws.last_hygiene_eval?.compact).toMatchObject({ outcome: 'skip:below-floor', prompt_tokens: 30000 });
  }));

// -------------------------------------------------------
// pause enforcement tests (PROP-015)
// -------------------------------------------------------

function writePauseFlag(h: Hermit, opts: { until?: string | null; ts?: string } = {}): void {
  fs.writeFileSync(state(h, 'pause.json'), JSON.stringify({
    paused: true,
    paused_until: opts.until ?? null,
    reason: 'operator',
    by: 'test',
    ts: opts.ts ?? '2026-01-01T00:00:00.000Z',
  }) + '\n');
}

describe('pause enforcement', () => {
  test('dead session still restarts while paused (channel plugin lives inside the session)',
    withHermit(async (h) => {
      writeConfig(h);
      writeFakeTmux(h, 1); // dead
      writeFakePgrep(h, 1);
      writePauseFlag(h);
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('restart');
    }));

  test('nudge suppressed while paused (Escape enforcement supersedes it on the same tick)',
    withHermit(async (h) => {
      writeConfig(h);
      writeState(h, 'execution.json', { state: 'in_flight', cc_session_id: 'resident-boundary', at: new Date().toISOString() });
      touchAgo(state(h, '.heartbeat'), 6 * 3600);
      writeFakeTmux(h, 0, 'some pane content');
      writeFakePgrep(h, 1);
      writePauseFlag(h);
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      const events = fs.readFileSync(eventsFile(h), 'utf-8');
      expect(events).not.toContain('nudge');
      expect(events).toContain('pause-enforced');
      const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
      expect(tmuxLog).not.toContain('heartbeat run');
    }));

  test('Escape sent once when paused mid-turn (execution in flight, live tmux)', withHermit(async (h) => {
    writeConfig(h);
    writeState(h, 'execution.json', { state: 'in_flight', cc_session_id: 'resident-boundary', at: new Date().toISOString() });
    writeFakeTmux(h, 0, 'busy pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h, { ts: '2026-02-02T00:00:00.000Z' });
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    expect(tmuxLog).toContain('Escape');
    expect(readJson(state(h, 'watchdog-state.json')).last_escaped_pause_ts).toBe('2026-02-02T00:00:00.000Z');
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('pause-enforced');
  }));

  test('Escape still fires exactly once for a ts-less flag (sentinel dedup)', withHermit(async (h) => {
    writeConfig(h);
    writeState(h, 'execution.json', { state: 'in_flight', cc_session_id: 'resident-boundary', at: new Date().toISOString() });
    writeFakeTmux(h, 0, 'busy pane');
    writeFakePgrep(h, 1);
    // Hand-crafted/partial flag with no `ts` — a bare `=== status.ts` compare
    // would read undefined === undefined and skip the interrupt entirely.
    fs.writeFileSync(state(h, 'pause.json'),
      JSON.stringify({ paused: true, paused_until: null, reason: 'operator', by: 'test' }) + '\n');
    await watchdog(h, 'run');
    await watchdog(h, 'run');
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    const escapeCount = tmuxLog.split('\n').filter(l => l.includes('Escape')).length;
    expect(escapeCount).toBe(1);
    expect(readJson(state(h, 'watchdog-state.json')).last_escaped_pause_ts).toBe('no-ts');
  }));

  test('Escape not repeated on a second tick (same pause episode)', withHermit(async (h) => {
    writeConfig(h);
    writeState(h, 'execution.json', { state: 'in_flight', cc_session_id: 'resident-boundary', at: new Date().toISOString() });
    writeFakeTmux(h, 0, 'busy pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h, { ts: '2026-02-02T00:00:00.000Z' });
    await watchdog(h, 'run');
    await watchdog(h, 'run');
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    const escapeCount = tmuxLog.split('\n').filter(l => l.includes('Escape')).length;
    expect(escapeCount).toBe(1);
  }));

  test('Escape sent again for a new pause episode (fresh ts) after a resume', withHermit(async (h) => {
    writeConfig(h);
    writeState(h, 'execution.json', { state: 'in_flight', cc_session_id: 'resident-boundary', at: new Date().toISOString() });
    writeFakeTmux(h, 0, 'busy pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h, { ts: '2026-02-02T00:00:00.000Z' });
    await watchdog(h, 'run');
    fs.rmSync(state(h, 'pause.json')); // resume
    writePauseFlag(h, { ts: '2026-03-03T00:00:00.000Z' }); // new episode
    await watchdog(h, 'run');
    const tmuxLog = fs.readFileSync(path.join(h.dir, 'tmux-calls.log'), 'utf-8');
    const escapeCount = tmuxLog.split('\n').filter(l => l.includes('Escape')).length;
    expect(escapeCount).toBe(2);
  }));

  test('Escape not sent when execution is idle (nothing in flight)', withHermit(async (h) => {
    writeConfig(h);
    writeState(h, 'execution.json', { state: 'idle', cc_session_id: CC_SESSION_ID, at: isoAgo(1) });
    writeFakeTmux(h, 0, 'idle pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

  test('Escape not sent for an interactive session (never auto-managed)', withHermit(async (h) => {
    writeConfig(h);
    patchRuntime(h, { runtime_mode: 'interactive' });
    writeFakeTmux(h, 0, 'interactive pane');
    writeFakePgrep(h, 1);
    writePauseFlag(h);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
  }));

  test('no pause.json — normal nudge flow unaffected', withHermit(async (h) => {
    writeConfig(h);
    touchAgo(state(h, '.heartbeat'), 6 * 3600);
    writeFakeTmux(h, 0, 'some pane content');
    writeFakePgrep(h, 1);
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('nudge');
  }));
});

// ---------- inActiveHours unit tests ----------
// 2026-06-11T03:00:00Z → 12:00 Asia/Tokyo (inside 09:00-17:00), 23:00 America/New_York (outside)
const ACTIVE_WINDOW = { start: '09:00', end: '17:00' };
const REF = new Date('2026-06-11T03:00:00Z');

describe('inActiveHours (timezone)', () => {
  test('honours config.timezone, not the machine clock', () => {
    expect(inActiveHours(ACTIVE_WINDOW, 'Asia/Tokyo', REF)).toBe(true);
    expect(inActiveHours(ACTIVE_WINDOW, 'America/New_York', REF)).toBe(false);
  });

  test('end boundary is exclusive, matching heartbeat-precheck', () => {
    // Pacific/Honolulu reads exactly 17:00 at REF (the window end).
    expect(inActiveHours(ACTIVE_WINDOW, 'Pacific/Honolulu', REF)).toBe(false);
  });

  test('fail-open on unparseable timezone', () => {
    expect(inActiveHours(ACTIVE_WINDOW, 'Not/AZone', REF)).toBe(true);
  });
});

// ---------- deterministic channel voice: operator-language message composers ----------

describe('composeRestartMessage / composeWedgeMessage / composePauseMessage', () => {
  test('upgrade restart message names finishing the upgrade in both locales', () => {
    expect(composeRestartMessage('upgrade', true, 'UTC', 'en')).toContain('finish an upgrade');
    expect(composeRestartMessage('upgrade', true, 'UTC', 'pt-PT')).toContain('concluir uma atualização');
  });

  test('restart message distinguishes dead-process from pane-frozen', () => {
    expect(composeRestartMessage('dead-process', true, 'UTC')).toContain("wasn't running");
    expect(composeRestartMessage('pane-frozen', true, 'UTC')).toContain('had frozen');
  });

  test('wedge message names the check-in time', () => {
    expect(composeWedgeMessage('UTC')).toContain('checking on it now');
  });

  test('pause message: indefinite pause has no boundary time', () => {
    expect(composePauseMessage('operator', null, 'UTC')).toBe('Your agent is paused (your request) until you resume it.');
  });

  test('pause message: budget/watchdog reasons render in operator language', () => {
    expect(composePauseMessage('budget', null, 'UTC')).toContain('a budget cap');
    expect(composePauseMessage('watchdog', null, 'UTC')).toContain('the watchdog');
  });

  test('pause message: a future boundary is rendered dated (YYYY-MM-DD HH:MM), not bare HH:MM', () => {
    // A monthly/weekly auto-resume can be days or weeks out; bare HH:MM would read
    // as minutes away, so the message carries the date.
    const until = new Date(Date.now() + 3600_000).toISOString();
    const msg = composePauseMessage('budget', until, 'UTC');
    expect(msg).toMatch(/until \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
  });
});

// -------------------------------------------------------
// telemetry export (step 0d: independent of watchdog.enabled, like 0a-0c)
// -------------------------------------------------------

/** Minimal config: watchdog disabled (so the process exits right after step 0d) plus an
 *  enabled telemetry_export block pointed at a mock webhook. Steps 0a-0c still shell out
 *  to tmux before the gate, so these tests stub it like every other one. An unstubbed
 *  tmux resolves to the host's, and a snap-packaged tmux costs ~3s per call, which alone
 *  pushes the test past bun's 5s default timeout. */
function writeTelemetryConfig(h: Hermit, url: string): void {
  fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
    watchdog: { enabled: false },
    telemetry_export: {
      enabled: true,
      destination: { type: 'webhook', url },
      interval_hours: 24,
      redact_operator_text: true,
    },
  }, null, 2) + '\n');
}

describe('telemetry export (step 0d)', () => {
  test('fires with watchdog.enabled: false — one POST, state stamped, event logged', withHermit(async (h) => {
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response('ok', { status: 200 }); } });
    try {
      writeTelemetryConfig(h, `http://127.0.0.1:${server.port}`);
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      expect(calls).toBe(1);
      const exportState = readJson(state(h, 'telemetry', 'last-export.json'));
      expect(typeof exportState.last_success_at).toBe('string');
      expect(exportState.consecutive_failures).toBe(0);
      expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('telemetry-export');
    } finally {
      server.stop(true);
    }
  }));

  test('interval not yet due → no POST', withHermit(async (h) => {
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response('ok', { status: 200 }); } });
    try {
      writeTelemetryConfig(h, `http://127.0.0.1:${server.port}`);
      fs.mkdirSync(state(h, 'telemetry'), { recursive: true });
      fs.writeFileSync(state(h, 'telemetry', 'last-export.json'), JSON.stringify({
        version: 1,
        last_success_at: new Date().toISOString(),
        last_attempt_at: new Date().toISOString(),
        consecutive_failures: 0,
      }));
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      expect(calls).toBe(0);
    } finally {
      server.stop(true);
    }
  }));

  test('no telemetry_export block → nothing leaves the box', withHermit(async (h) => {
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response('ok', { status: 200 }); } });
    try {
      fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
        watchdog: { enabled: false },
      }, null, 2) + '\n');
      const r = await watchdog(h, 'run');
      expect(r.exitCode).toBe(0);
      expect(calls).toBe(0);
      expect(fs.existsSync(state(h, 'telemetry'))).toBe(false);
    } finally {
      server.stop(true);
    }
  }));
});

// -------------------------------------------------------
// state backup (step 0e: independent of watchdog.enabled, like 0a-0d)
// -------------------------------------------------------

describe('state backup (step 0e)', () => {
  /** Backup enabled, watchdog recovery off — the tick must still evaluate the cron. */
  function writeBackupConfig(h: Hermit, backup: Record<string, unknown>): void {
    fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
      watchdog: { enabled: false },
      timezone: 'UTC',
      backup: { enabled: true, mode: 'workspace', schedule: '* * * * *', remote: null, push: false, include: [], ...backup },
    }, null, 2) + '\n');
  }

  const scheduleFile = (h: Hermit) => state(h, 'backup-schedule.json');
  const backupEvents = (h: Hermit) =>
    (fs.existsSync(eventsFile(h)) ? fs.readFileSync(eventsFile(h), 'utf-8') : '')
      .split('\n').filter(l => l.includes('"backup"'));

  test('first tick seeds the cursor and fires nothing', withHermit(async (h) => {
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    writeBackupConfig(h, {});

    const r = await watchdog(h, 'run', { env: { HERMIT_BACKUP_SCRIPT: '/nonexistent/backup.ts' } });

    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(scheduleFile(h))).toBe(true);
    expect(backupEvents(h)).toEqual([]);
  }));

  test('a due window spawns the backup and records the event', withHermit(async (h) => {
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    writeBackupConfig(h, {});
    // Cursor two minutes back: an every-minute schedule has matched since.
    fs.writeFileSync(scheduleFile(h), JSON.stringify({
      version: 1,
      last_consumed_mark: new Date(Date.now() - 120_000).toISOString(),
    }));

    // Spawning a missing script also proves the async 'error' event is handled:
    // an unhandled one would throw out of the tick and lose steps 1-6.
    const r = await watchdog(h, 'run', { env: { HERMIT_BACKUP_SCRIPT: '/nonexistent/backup.ts' } });

    expect(r.exitCode).toBe(0);
    expect(backupEvents(h).length).toBe(1);
    expect(backupEvents(h)[0]).toContain('scheduled run spawned');
  }));

  test('no backup block → no schedule file, no event', withHermit(async (h) => {
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    fs.writeFileSync(path.join(h.dir, '.hermit', 'config.json'), JSON.stringify({
      watchdog: { enabled: false },
    }, null, 2) + '\n');

    const r = await watchdog(h, 'run');

    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(scheduleFile(h))).toBe(false);
    expect(backupEvents(h)).toEqual([]);
  }));

  test('backup.enabled false → inert', withHermit(async (h) => {
    writeFakeTmux(h, 0);
    writeFakePgrep(h, 1);
    writeBackupConfig(h, { enabled: false });

    const r = await watchdog(h, 'run');

    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(scheduleFile(h))).toBe(false);
  }));
});

// -------------------------------------------------------
// 14. Compose-function localization (PROP-059): the four watchdog message
//     families compose through WatchdogMessages (frames asserted around the
//     live HH:MM clock);
//     `pt-PT` is exercised with an explicit locale arg.
// -------------------------------------------------------

describe('watchdog message localization', () => {
  test('composeRestartMessage en describes an attempt (both causes)', () => {
    expect(composeRestartMessage('dead-process', true, 'UTC', 'en')).toMatch(
      /^Attempting to restart your agent at \d{2}:\d{2}: it wasn't running\. Its conversation is restored where possible, but work in flight since the last save may not have carried over, so it will re-check its work before continuing\.$/);
    expect(composeRestartMessage('pane-frozen', true, 'UTC', 'en')).toMatch(
      /^Attempting to restart your agent at \d{2}:\d{2}: it had frozen\. Its conversation is restored where possible, but work in flight since the last save may not have carried over, so it will re-check its work before continuing\.$/);
  });

  test('composeRestartMessage never promises a restored conversation on a fresh start', () => {
    expect(composeRestartMessage('dead-process', false, 'UTC', 'en')).toMatch(
      /^Attempting to restart your agent at \d{2}:\d{2}: it wasn't running\. It starts a fresh conversation, so work in flight since the last save is lost and it picks up from its saved work\.$/);
    expect(composeRestartMessage('dead-process', false, 'UTC', 'pt-PT')).toMatch(
      /^A tentar reiniciar o seu agente às \d{2}:\d{2}: não estava a correr\. Começa uma conversa nova, por isso o trabalho em curso desde o último registo perde-se e o agente retoma a partir do trabalho guardado\.$/);
  });

  test('composeRestartMessage pt-PT', () => {
    expect(composeRestartMessage('dead-process', true, 'UTC', 'pt-PT')).toMatch(
      /^A tentar reiniciar o seu agente às \d{2}:\d{2}: não estava a correr\. A conversa é retomada sempre que possível, mas o trabalho em curso desde o último registo pode não ter sido mantido, por isso o agente volta a verificar o seu trabalho antes de continuar\.$/);
    expect(composeRestartMessage('pane-frozen', true, 'UTC', 'pt-PT')).toMatch(
      /^A tentar reiniciar o seu agente às \d{2}:\d{2}: tinha bloqueado\. A conversa é retomada sempre que possível, mas o trabalho em curso desde o último registo pode não ter sido mantido, por isso o agente volta a verificar o seu trabalho antes de continuar\.$/);
  });

  test('composeWedgeMessage en / pt-PT', () => {
    expect(composeWedgeMessage('UTC', 'en')).toMatch(
      /^Your agent hasn't responded in a while — checking on it now \(\d{2}:\d{2}\)\. If it has to be restarted, work in flight may be lost\.$/);
    expect(composeWedgeMessage('UTC', 'pt-PT')).toMatch(
      /^O seu agente não responde há algum tempo — estou a verificá-lo agora \(\d{2}:\d{2}\)\. Se tiver de ser reiniciado, o trabalho em curso pode perder-se\.$/);
  });

  test('composeStallQuestionMessage en / pt-PT', () => {
    expect(composeStallQuestionMessage('UTC', 'en')).toMatch(
      /^Your agent is waiting on a question it can't ask over chat — open the terminal or Claude app to answer \(\d{2}:\d{2}\)\.$/);
    expect(composeStallQuestionMessage('UTC', 'pt-PT')).toMatch(
      /^O seu agente está à espera de uma pergunta que não pode fazer pelo chat — abra o terminal ou a app Claude para responder \(\d{2}:\d{2}\)\.$/);
  });

  test('composeSessionWedgedMessage en / pt-PT', () => {
    expect(composeSessionWedgedMessage('UTC', 'en')).toMatch(
      /^Your agent has stopped picking up its scheduled work — something on screen is holding it\. Open the terminal or Claude app and clear whatever is waiting there \(\d{2}:\d{2}\)\.$/);
    expect(composeSessionWedgedMessage('UTC', 'pt-PT')).toMatch(
      /^O seu agente deixou de executar o trabalho agendado — algo no ecrã está a bloqueá-lo\. Abra o terminal ou a app Claude e resolva o que está à espera \(\d{2}:\d{2}\)\.$/);
  });

  test('composePauseMessage indefinite form is deterministic and localized', () => {
    expect(composePauseMessage('operator', null, 'UTC', 'en')).toBe(
      'Your agent is paused (your request) until you resume it.');
    expect(composePauseMessage('operator', null, 'UTC', 'pt-PT')).toBe(
      'O seu agente está em pausa (o seu pedido) até que a retome.');
    expect(composePauseMessage('budget', null, 'UTC', 'pt-PT')).toBe(
      'O seu agente está em pausa (um limite de orçamento) até que a retome.');
  });

  test('composePauseMessage dated form carries the localized frame and reason label', () => {
    const until = '2026-07-05T12:00:00Z';
    const en = composePauseMessage('budget', until, 'UTC', 'en');
    expect(en).toContain('Your agent is paused (a budget cap) until ');
    const pt = composePauseMessage('watchdog', until, 'UTC', 'pt-PT');
    expect(pt).toContain('O seu agente está em pausa (o watchdog) até ');
  });
});

// -------------------------------------------------------
// conversation gate + hygiene first-blocker counters
// -------------------------------------------------------

function writeSurfaceFile(h: Hermit, tokens: number): void {
  fs.writeFileSync(state(h, 'context-surface.json'), JSON.stringify({
    surface_upper_bound_tokens: tokens, post_tokens: 30000,
    boundary_at: isoAgo(24), observed_at: isoAgo(24), prev: null,
  }) + '\n');
}

function readWdState(h: Hermit): any {
  return JSON.parse(fs.readFileSync(state(h, 'watchdog-state.json'), 'utf-8'));
}

test('context_compact: recorded surface subtracted — under-threshold skip carries compactible_tokens',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h);
    writeSurfaceFile(h, 65000);
    // 160k total − 65k surface = 95k compactible ≤ 100k threshold → skip
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 160000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    const ws = readWdState(h);
    expect(ws.last_hygiene_eval.compact.outcome).toBe('skip:under-threshold');
    expect(ws.last_hygiene_eval.compact.prompt_tokens).toBe(160000);
    expect(ws.last_hygiene_eval.compact.compactible_tokens).toBe(95000);
  }));

test('context_compact: recorded surface subtracted — fires once compactible crosses the threshold',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h);
    writeSurfaceFile(h, 65000);
    // 170k total − 65k surface = 105k compactible > 100k threshold → fires on tick 2
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 170000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run'); // tick 1: quiescence pending
    const r2 = await watchdog(h, 'run'); // tick 2: fires
    expect(r2.exitCode).toBe(0);
    const events = fs.readFileSync(eventsFile(h), 'utf-8');
    expect(events).toContain('prompt tokens 170000 (compactible ~105000) over threshold 100000');
    const ws = readWdState(h);
    expect(ws.last_hygiene_eval.compact.outcome).toBe('fired');
    expect(ws.last_hygiene_eval.compact.compactible_tokens).toBe(105000);
  }));

test('context_compact: no surface file → 50k assumed surface gives cold-start parity with the old 150k total default',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    // 150k total − 50k assumed = 100k compactible, NOT > threshold → never fires
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 150000 }]);
    await watchdog(h, 'run');
    await watchdog(h, 'run');
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(readWdState(h).last_hygiene_eval.compact.outcome).toBe('skip:under-threshold');

    // 151k total − 50k assumed = 101k compactible > threshold → fires
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 1000, cache_write_tokens: 0, cache_read_tokens: 150000 }]);
    await watchdog(h, 'run');
    const r = await watchdog(h, 'run');
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-compact');
  }));

test('context_compact: malformed context-surface.json degrades to the assumed-surface fallback, never throws',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h);
    fs.writeFileSync(state(h, 'context-surface.json'), '{ truncated');
    // 250k total − 50k fallback = 200k compactible → fires on tick 2
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 50000, cache_write_tokens: 0, cache_read_tokens: 200000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const r2 = await watchdog(h, 'run');
    expect(r2.exitCode).toBe(0);
    expect(fs.readFileSync(eventsFile(h), 'utf-8')).toContain('context-compact');
  }));

test('context_compact: floor applies to the subtracted value (compactible below 60k floor → skip:below-floor)',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 1000 });
    writeAlwaysOnRuntime(h);
    // No surface file: 100k total − 50k assumed = 50k compactible < 60k floor
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 100000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    await watchdog(h, 'run');
    expect(fs.existsSync(path.join(h.dir, 'tmux-calls.log'))).toBe(false);
    expect(readWdState(h).last_hygiene_eval.compact.outcome).toBe('skip:below-floor');
  }));

test('hygiene_eval_counts: monotonic first-blocker counters keyed per mechanism with a stable since',
  withHermit(async (h) => {
    writeContextCompactConfig(h, { minContextTokens: 100000 });
    writeAlwaysOnRuntime(h);
    writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 30000 }]);
    fs.writeFileSync(state(h, 'last-operator-action.json'), JSON.stringify({ at: isoAgo(1) }) + '\n');
    writeFakeTmux(h, 0, 'static pane content');
    writeFakePgrep(h, 1);

    await watchdog(h, 'run');
    const ws1 = readWdState(h);
    // compactible −20k → below floor is the first blocker on every tick
    expect(ws1.hygiene_eval_counts.compact['skip:below-floor']).toBe(1);
    expect(typeof ws1.hygiene_eval_counts.since).toBe('string');

    await watchdog(h, 'run');
    const ws2 = readWdState(h);
    expect(ws2.hygiene_eval_counts.compact['skip:below-floor']).toBe(2);
    expect(ws2.hygiene_eval_counts.since).toBe(ws1.hygiene_eval_counts.since);
    // only the compact tier records evaluations
    expect(ws2.hygiene_eval_counts.clear).toBeUndefined();
  }));

// ============================================================================
// In-process cascade tests (fake world)
// ============================================================================
//
// The gates above are driven through a spawned subprocess with fake tmux/pgrep on
// PATH — the only way to reach them while they read the clock and shell out
// directly (Bun's spawnSync snapshots PATH at process start, so a stub binary
// only works across a spawn boundary).
//
// These drive the same gates in-process by handing them a World: fake clock, fake
// tmux, real fs against a temp state dir. That buys two things a spawn test can't
// give: the gate's decision is the assertion (the returned HygieneOutcome, not a
// side effect inferred afterwards), and time is a value, so a damper or cooldown
// can be watched flipping as the clock advances.

const NOW_MS = Date.parse('2026-08-14T12:00:00Z');
const agoISO = (secs: number) => new Date(NOW_MS - secs * 1000).toISOString();

interface Cascade {
  dir: string;
  world: World;
  sent: Array<{ session: string; text: string }>;
  setPane(v: string | null): void;
  setAlive(v: boolean): void;
  setNow(ms: number): void;
  runtime(): any;
  wdState(): any;
  cleanup(): void;
}

/** Temp hermit whose World the cascade gates can be handed directly. Defaults to a
 *  live always-on tmux session that passes every lifecycle guard. */
function setupCascade(): Cascade {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cascade-')));
  const hermitRoot = path.join(dir, '.hermit');
  const stateDir = path.join(hermitRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(hermitRoot, 'sessions'), { recursive: true });

  let pane: string | null = 'stable-pane';
  let alive = true;
  let nowMs = NOW_MS;
  const sent: Array<{ session: string; text: string }> = [];

  const world: World = {
    liveness: { ageSecs: () => null },
    registry: { resident: () => null },
    notify: { operator: () => {}, maintainer: () => {} },
    actions: { restart: async () => {}, nudge: async () => {}, reauth: () => 'idle' },
    proc: { heartbeatMonitorDead: () => true },
    clock: { nowMs: () => nowMs },
    tmux: {
      alive: () => alive,
      capture: () => pane,
      send: (session, text) => { sent.push({ session, text }); },
    },
    files: {
      readJson: (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } },
      readText: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
      writeJson: (p, v) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
      },
      rm: (p) => { try { fs.rmSync(p); } catch {} },
    },
    paths: { stateDir, hermitRoot, costLog: path.join(dir, 'cost-log.jsonl') },
    memo: {},
  };

  const runtimePath = path.join(stateDir, 'runtime.json');
  fs.writeFileSync(runtimePath, JSON.stringify({
    version: 1,
    runtime_mode: 'tmux',
    tmux_session: 'hermit-test',
    session_id: 'S-001',
    cc_session_id: CC_SESSION_ID,
    shutdown_requested_at: null,
    shutdown_completed_at: null,
  }, null, 2) + '\n');

  return {
    dir, world, sent,
    setPane: (v) => { pane = v; },
    setAlive: (v) => { alive = v; },
    setNow: (ms) => { nowMs = ms; },
    runtime: () => JSON.parse(fs.readFileSync(runtimePath, 'utf-8')),
    wdState: () => {
      try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'watchdog-state.json'), 'utf-8')); }
      catch { return {}; }
    },
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** Wraps a cascade body so the temp dir is always cleaned up. */
const withCascade = (fn: (c: Cascade) => void) => () => {
  const c = setupCascade();
  try { fn(c); } finally { c.cleanup(); }
};

function patchCascadeRuntime(c: Cascade, patch: Record<string, unknown>): void {
  const p = path.join(c.world.paths.stateDir, 'runtime.json');
  fs.writeFileSync(p, JSON.stringify({ ...c.runtime(), ...patch }) + '\n');
}

/** One cost-log entry for the fixture session. Defaults to a real (non-estimate)
 *  900k reading, well over the compact threshold. */
function writeCostEntry(c: Cascade, over: Record<string, unknown> = {}): void {
  const entry = {
    session_id: 'S-001',
    cc_session_id: CC_SESSION_ID,
    timestamp: agoISO(60),
    observed_at: agoISO(60),
    last_call_prompt_tokens: 900_000,
    max_prompt_tokens: 900_000,
    api_calls: 1,
    ...over,
  };
  fs.writeFileSync(c.world.paths.costLog, JSON.stringify(entry) + '\n');
}

const COMPACT_CONFIG = {
  timezone: 'UTC',
  context_hygiene: { compact: { enabled: true, min_context_tokens: 100_000, min_interval: '4h' } },
};

describe('rearmDamperOpen (in-process, fake clock)', () => {
  test('a missing or non-string stamp opens the damper', withCascade((c) => {
    expect(rearmDamperOpen(undefined, c.world)).toBe(true);
    expect(rearmDamperOpen(null, c.world)).toBe(true);
    expect(rearmDamperOpen(1234, c.world)).toBe(true);
  }));

  test('an unparseable stamp opens the damper', withCascade((c) => {
    expect(rearmDamperOpen('not-a-timestamp', c.world)).toBe(true);
  }));

  test('a stamp inside the window keeps it closed', withCascade((c) => {
    expect(rearmDamperOpen(agoISO(3600), c.world)).toBe(false);
    expect(rearmDamperOpen(agoISO(MONITOR_REARM_DAMPER_SECS - 60), c.world)).toBe(false);
  }));

  test('a stamp at or past the window opens it', withCascade((c) => {
    expect(rearmDamperOpen(agoISO(MONITOR_REARM_DAMPER_SECS), c.world)).toBe(true);
    expect(rearmDamperOpen(agoISO(MONITOR_REARM_DAMPER_SECS + 600), c.world)).toBe(true);
  }));

  // The case the spawn suite cannot express: one stamp, two instants.
  test('the same stamp flips from closed to open as the clock advances', withCascade((c) => {
    const stamp = agoISO(3600);
    expect(rearmDamperOpen(stamp, c.world)).toBe(false);
    c.setNow(NOW_MS + MONITOR_REARM_DAMPER_SECS * 1000);
    expect(rearmDamperOpen(stamp, c.world)).toBe(true);
  }));
});

describe('passesLifecycleGuards (in-process) — every reason reachable', () => {
  test('passes and returns the live session name', withCascade((c) => {
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: true, sessionName: 'hermit-test' });
  }));

  test('paused', withCascade((c) => {
    fs.writeFileSync(path.join(c.world.paths.stateDir, 'pause.json'),
      JSON.stringify({ paused: true, reason: 'operator' }));
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'paused' });
  }));

  test('interactive', withCascade((c) => {
    patchCascadeRuntime(c, { runtime_mode: 'interactive' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'interactive' });
  }));

  test('transition', withCascade((c) => {
    patchCascadeRuntime(c, { transition: 'archiving' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'transition' });
  }));

  test('shutdown-stamp', withCascade((c) => {
    patchCascadeRuntime(c, { shutdown_requested_at: agoISO(30) });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'shutdown-stamp' });
  }));

  test('no-tmux when the session name is empty', withCascade((c) => {
    patchCascadeRuntime(c, { tmux_session: '' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'no-tmux' });
  }));

  test('no-tmux when the named session is dead', withCascade((c) => {
    c.setAlive(false);
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'no-tmux' });
  }));

  test('operator-recent inside the 10-minute backoff, clear once past it', withCascade((c) => {
    fs.writeFileSync(path.join(c.world.paths.stateDir, 'last-operator-action.json'),
      JSON.stringify({ at: agoISO(60) }));
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'operator-recent' });
    c.setNow(NOW_MS + 11 * 60 * 1000);
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: true, sessionName: 'hermit-test' });
  }));

  // Gate ORDER, not just gate membership: a runtime that trips several gates at once
  // must report the first one, since that reason is what lands in last_hygiene_eval.
  test('reports the first blocking gate when several would block', withCascade((c) => {
    fs.writeFileSync(path.join(c.world.paths.stateDir, 'pause.json'),
      JSON.stringify({ paused: true, reason: 'operator' }));
    patchCascadeRuntime(c, { runtime_mode: 'interactive', transition: 'archiving', tmux_session: '' });
    expect(passesLifecycleGuards(c.runtime(), c.world)).toEqual({ ok: false, reason: 'paused' });
  }));
});

describe('hygiene stamping (in-process)', () => {
  test('first stamp initialises both records off the world clock', withCascade((c) => {
    const ws: any = {};
    setHygieneEval(c.world, ws, 'skip:under-threshold', 123);
    expect(ws.last_hygiene_eval.compact).toEqual({
      ts: '2026-08-14T12:00:00Z', outcome: 'skip:under-threshold', prompt_tokens: 123,
    });
    expect(ws.hygiene_eval_counts.since).toBe('2026-08-14T12:00:00Z');
    expect(ws.hygiene_eval_counts.compact).toEqual({ 'skip:under-threshold': 1 });
    expect(ws.hygiene_eval_counts.clear).toBeUndefined();
  }));

  test('repeat outcomes increment rather than overwrite', withCascade((c) => {
    const ws: any = {};
    setHygieneEval(c.world, ws, 'skip:below-floor', 90_000, 40_000);
    setHygieneEval(c.world, ws, 'skip:below-floor', 91_000, 41_000);
    setHygieneEval(c.world, ws, 'fired', 92_000, 42_000);
    expect(ws.hygiene_eval_counts.compact).toEqual({ 'skip:below-floor': 2, fired: 1 });
    // last_hygiene_eval holds only the most recent evaluation for the mechanism
    expect(ws.last_hygiene_eval.compact.outcome).toBe('fired');
    expect(ws.last_hygiene_eval.compact.compactible_tokens).toBe(42_000);
  }));

  test('token fields are omitted when not supplied', withCascade((c) => {
    const ws: any = {};
    setHygieneEval(c.world, ws, 'skip:no-cost-entry');
    expect(ws.last_hygiene_eval.compact).toEqual({ ts: '2026-08-14T12:00:00Z', outcome: 'skip:no-cost-entry' });
  }));

  test('stampHygieneEval round-trips through the state file', withCascade((c) => {
    stampHygieneEval(c.world, 'skip:lock-held', 700);
    stampHygieneEval(c.world, 'skip:lock-held', 701);
    const ws = c.wdState();
    expect(ws.last_hygiene_eval.compact.outcome).toBe('skip:lock-held');
    expect(ws.hygiene_eval_counts.compact['skip:lock-held']).toBe(2);
    expect(ws.last_check_at).toBe('2026-08-14T12:00:00Z');
  }));
});

describe('maybeContextCompact (in-process) — outcome per gate', () => {
  test('no outcome when the tier is disabled or unconfigured', withCascade((c) => {
    expect(maybeContextCompact({}, c.world)).toBeNull();
    expect(maybeContextCompact({ context_hygiene: { compact: { enabled: false, min_context_tokens: 100 } } }, c.world)).toBeNull();
    expect(maybeContextCompact({ context_hygiene: { compact: { enabled: true, min_context_tokens: 0 } } }, c.world)).toBeNull();
  }));

  test('lifecycle reason travels into the outcome', withCascade((c) => {
    c.setAlive(false);
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:lifecycle:no-tmux');
    expect(c.wdState().last_hygiene_eval.compact.outcome).toBe('skip:lifecycle:no-tmux');
  }));

  test('no-session-id: an arc label without cc_session_id resolves nothing', withCascade((c) => {
    // The pre-#916 shape: S-NNN present, no harness id stamped. A bloated row keyed on
    // that label must not be readable, or the drift the fix removes comes straight back.
    const { cc_session_id: _dropped, ...rest } = c.runtime();
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'runtime.json'), { ...rest, session_id: 'S-001' });
    writeCostEntry(c, { cc_session_id: undefined });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:no-session-id');
  }));

  test('no-cost-entry: another session or a guest row carrying the resident id is ignored', withCascade((c) => {
    writeCostEntry(c, { cc_session_id: 'cc-other-session' });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:no-cost-entry');
    writeCostEntry(c, { guest: true });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:no-cost-entry');
  }));

  test('stale-entry when the reading predates the last context reset', withCascade((c) => {
    writeCostEntry(c, { observed_at: agoISO(600) });
    patchCascadeRuntime(c, { last_context_reset_at: agoISO(300) });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:stale-entry');
  }));

  test('aberrant-reading above the plausible ceiling', withCascade((c) => {
    writeCostEntry(c, { last_call_prompt_tokens: 6_500_000, max_prompt_tokens: 6_500_000 });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:aberrant-reading');
  }));

  test('below-floor: a small compactible conversation is never worth summarising', withCascade((c) => {
    // 100k prompt minus the 50k assumed fixed surface = 50k compactible, under the 60k floor
    writeCostEntry(c, { last_call_prompt_tokens: 100_000, max_prompt_tokens: 100_000 });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:below-floor');
    const evalRow = c.wdState().last_hygiene_eval.compact;
    expect(evalRow.prompt_tokens).toBe(100_000);
    expect(evalRow.compactible_tokens).toBe(50_000);
  }));

  test('under-threshold is measured in compactible tokens, not total prompt', withCascade((c) => {
    // 180k total prompt = 130k compactible... but with a recorded 100k surface it is only 80k
    writeCostEntry(c, { last_call_prompt_tokens: 180_000, max_prompt_tokens: 180_000 });
    fs.writeFileSync(path.join(c.world.paths.stateDir, 'context-surface.json'),
      JSON.stringify({ surface_upper_bound_tokens: 100_000 }));
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:under-threshold');
    expect(c.wdState().last_hygiene_eval.compact.compactible_tokens).toBe(80_000);
  }));

  test('interval-cooldown blocks before quiescence has a say', withCascade((c) => {
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_at: agoISO(3600) }); // 1h ago, inside the 4h min_interval
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:interval-cooldown');
  }));

  // The cooldown-blocked tick still banks the pane hash, so when the interval
  // reopens the compact fires immediately instead of spending another tick
  // re-observing a pane that never moved.
  test('the cooldown lapses as the clock advances, and quiescence banked meanwhile still counts', withCascade((c) => {
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_at: agoISO(3600) });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:interval-cooldown');
    expect(c.wdState().last_pane_hash_compact).toBeTruthy();
    c.setNow(NOW_MS + 4 * 3600 * 1000); // stamp is now >4h old
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('fired');
  }));

  test('a fresh boundary marker waives the cooldown but not the floor', withCascade((c) => {
    const markerPath = path.join(c.world.paths.stateDir, 'compact-requested.json');
    fs.writeFileSync(markerPath, JSON.stringify({ requested_at: agoISO(60) }));
    writeCostEntry(c, { last_call_prompt_tokens: 100_000, max_prompt_tokens: 100_000 });
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_at: agoISO(3600) });
    // cooldown waived, floor still refuses — and the fresh marker survives for a later tick
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:below-floor');
    expect(fs.existsSync(markerPath)).toBe(true);
  }));

  test('a stale boundary marker is consumed on read and waives nothing', withCascade((c) => {
    const markerPath = path.join(c.world.paths.stateDir, 'compact-requested.json');
    fs.writeFileSync(markerPath, JSON.stringify({ requested_at: agoISO(2 * 3600) })); // past the 1h TTL
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_at: agoISO(3600) });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:interval-cooldown');
    expect(fs.existsSync(markerPath)).toBe(false);
  }));

  test('already-processed', withCascade((c) => {
    writeCostEntry(c);
    c.world.files.writeJson(path.join(c.world.paths.stateDir, 'watchdog-state.json'),
      { last_compacted_cost_ts: agoISO(60) });
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:already-processed');
    expect(c.sent).toEqual([]);
  }));

  test('lock-held', withCascade((c) => {
    writeCostEntry(c);
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:quiescence-pending');
    // A bare, live, foreign PID — acquireLock treats own-PID or unparseable
    // content as a stale lock it may claim.
    fs.writeFileSync(path.join(c.world.paths.stateDir, '.lifecycle.lock'), String(process.ppid));
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:lock-held');
    expect(c.sent).toEqual([]);
  }));

  test('fires mid-arc on the second stable tick', withCascade((c) => {
    writeCostEntry(c);
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:quiescence-pending');
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('fired');

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].session).toBe('hermit-test');
    expect(c.sent[0].text).toBe(composeCompactSteeringMessage());
    const ws = c.wdState();
    expect(ws.last_hygiene_eval.compact).toEqual({
      ts: '2026-08-14T12:00:00Z', outcome: 'fired', cc_session_id: CC_SESSION_ID,
      prompt_tokens: 900_000, compactible_tokens: 850_000,
    });
    expect(ws.last_compacted_at).toBe('2026-08-14T12:00:00Z');
    expect(ws.last_pane_hash_compact).toBeNull();
  }));

  test('a fresh marker preserves unfinished-work steering and is consumed on fire', withCascade((c) => {
    const markerPath = path.join(c.world.paths.stateDir, 'compact-requested.json');
    writeCostEntry(c);
    fs.writeFileSync(markerPath, JSON.stringify({ requested_at: agoISO(60) }));
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('skip:quiescence-pending');
    expect(maybeContextCompact(COMPACT_CONFIG, c.world)).toBe('fired');
    expect(c.sent[0].text).toBe(composeCompactSteeringMessage());
    expect(fs.existsSync(markerPath)).toBe(false);
  }));
});

describe('restart resume', () => {
  // Watchdog-detected restarts (a dead session on a `run` tick) resume; a restart
  // someone asked for through the `restart` subcommand always starts fresh.
  const scenarios: Record<string, { expected: string; via: 'run' | 'restart' }> = {
    'default': { expected: 'resume', via: 'run' },
    'no-session-id': { expected: 'fresh: no-session-id', via: 'run' },
    'recent-restart': { expected: 'fresh: recent-restart', via: 'run' },
    'compact-off-large-context': { expected: 'resume', via: 'run' },
    'requested': { expected: 'fresh: requested', via: 'restart' },
  };
  for (const [scenario, { expected, via }] of Object.entries(scenarios)) {
    test(scenario, withHermit(async (h) => {
      writeConfig(h);
      if (scenario === 'compact-off-large-context') {
        const configPath = path.join(h.dir, '.hermit', 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.context_hygiene = { compact: { min_context_tokens: 100000, enabled: false } };
        fs.writeFileSync(configPath, JSON.stringify(config));
        writeCostLog(h, [{ session_id: SESSION_ID, input_tokens: 400000, cache_write_tokens: 0, cache_read_tokens: 0 }]);
      }
      patchRuntime(h, { cc_session_id: scenario === 'no-session-id' ? null : CC_SESSION_ID });
      const priorRestart = isoAgo(5 / 60);
      fs.writeFileSync(state(h, 'watchdog-state.json'), JSON.stringify({
        consecutive_stale: 2, last_pane_hash: 'abc',
        ...(scenario === 'recent-restart' ? { last_restart_at: priorRestart } : {}),
      }) + '\n');
      writeFakeTmux(h, via === 'run' ? 1 : 0);
      writeFakePgrep(h, 1);
      expect((await watchdog(h, via)).exitCode).toBe(0);
      expect(await waitForStartMarker(h)).toBe(true);
      const resumes = expected === 'resume';
      expect(fs.readFileSync(path.join(h.dir, 'hermit-start-args'), 'utf8').trim())
        .toBe(resumes ? `--resume ${CC_SESSION_ID}` : '');
      expect(fs.readFileSync(eventsFile(h), 'utf8')).toContain(resumes ? `resume ${CC_SESSION_ID}` : expected);
      // Every restart stamps its time without clobbering what the caller wrote.
      const ws = readJson(state(h, 'watchdog-state.json'));
      expect(Date.parse(ws.last_restart_at)).toBeGreaterThan(Date.parse(priorRestart));
      expect(ws.consecutive_stale).toBe(2);
      expect(ws.last_pane_hash).toBe('abc');
    }), 45000);
  }
});

test('resident missing notifies once and restarts when the file appears', withHermit(async (h) => {
  writeConfig(h);
  patchRuntime(h, { last_start_error: 'resident-missing' });
  writeFakeTmux(h, 1);
  writeFakePgrep(h, 1);
  expect((await watchdog(h, 'run')).exitCode).toBe(0);
  expect((await watchdog(h, 'run')).exitCode).toBe(0);
  expect(fs.existsSync(path.join(h.dir, 'hermit-start-called'))).toBe(false);
  const events = fs.readFileSync(eventsFile(h), 'utf8').split('\n').filter(line => line.includes('operator notified; restart skipped'));
  expect(events.length).toBe(1);
  fs.writeFileSync(path.join(h.dir, '.hermit/RESIDENT.md'), '# Resident');
  expect((await watchdog(h, 'run')).exitCode).toBe(0);
  expect(fs.readFileSync(eventsFile(h), 'utf8')).toContain('tree-verified');
}));
