import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  writePendingCommand,
} from '../scripts/lib/harness-command';
import { paneModeLine } from '../scripts/lib/tmux';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

const MODEL_SWITCH_PANE = `
Switch model?
Your next response will be slower and use more tokens

This conversation is cached for the current model. Switching to Opus 5 means the full history gets
re-read on your next message.

❯ 1. Yes, switch to Opus 5
  2. No, go back
`;

const hermit = (dir: string, ...parts: string[]) =>
  path.join(dir, '.hermit', ...parts);

// Error-path bound for the readiness polls below, not an assertion about speed:
// these tests wait on detached subprocesses, so under `bun test --parallel` on a
// contended runner a 4-5s window fails a run that is merely slow. Bun's
// `--timeout` does not extend an in-test `Date.now()` deadline, so the bound has
// to be raised here too.
const POLL_DEADLINE_MS = 20_000;

const switchVerifyMarker = (dir: string) => hermit(dir, 'state', 'harness-switch-verify.json');
const pendingMarker = (dir: string) => hermit(dir, 'state', 'pending-harness-command.json');

/** Wait for the detached cycler to record the mode the session actually landed in. */
async function waitForVerify(dir: string, arg: string, timeoutMs = POLL_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(switchVerifyMarker(dir))) {
      const verify = JSON.parse(fs.readFileSync(switchVerifyMarker(dir), 'utf-8'));
      if (verify.arg === arg) return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`no switch-verify marker recording ${arg}`);
}

function seedPendingSwitch(dir: string, command: string, arg: string | null): void {
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
  fs.writeFileSync(hermit(dir, 'state', 'runtime.json'), JSON.stringify({
    version: 1,
    runtime_mode: 'headless',
    tmux_session: 'hermit-test',
    shutdown_requested_at: null,
    shutdown_completed_at: null,
  }));
  writePendingCommand(hermit(dir), {
    command,
    arg,
    by: 'operator',
    requested_at: new Date().toISOString(),
  });
}

function installFakeTmux(
  dir: string,
  pane: string,
  opts: {
    paneAfterEnter?: string;
    swapAfterCaptures?: number;
    failLiteral?: boolean;
    failSecondEnter?: boolean;
    revealAfterCapture?: number;
    deadSession?: boolean;
  } = {},
): { bin: string; log: string; helperPid: string } {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'tmux-calls.log');
  const paneFile = path.join(dir, 'pane.txt');
  const enterCount = path.join(dir, 'enter-count');
  const captureCount = path.join(dir, 'capture-count');
  const swapDelay = path.join(dir, 'swap-delay');
  const helperPid = path.join(dir, 'helper-pid');
  fs.mkdirSync(bin);
  fs.writeFileSync(paneFile, pane);
  const nextPaneFile = path.join(dir, 'next-pane.txt');
  fs.writeFileSync(nextPaneFile, opts.paneAfterEnter ?? pane);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  has-session) exit ${opts.deadSession ? 1 : 0} ;;
  capture-pane)
    printf '%s' "$PPID" > "${helperPid}"
    if [[ -f "${swapDelay}" ]]; then
      left=$(cat "${swapDelay}")
      left=$((left - 1))
      if (( left <= 0 )); then cp "${nextPaneFile}" "${paneFile}"; rm -f "${swapDelay}"; else printf '%s' "$left" > "${swapDelay}"; fi
    fi
    count=0
    [[ -f "${captureCount}" ]] && count=$(cat "${captureCount}")
    count=$((count + 1))
    printf '%s' "$count" > "${captureCount}"
    if (( count < ${opts.revealAfterCapture ?? 1} )); then printf 'Claude ready\\n'; else cat "${paneFile}"; fi
    exit 0
    ;;
  send-keys)
    if [[ "${opts.failLiteral ? '1' : '0'}" == "1" && "$*" == *" -l -- "* ]]; then exit 1; fi
    if [[ "$*" == *" Enter" ]]; then
      count=0
      [[ -f "${enterCount}" ]] && count=$(cat "${enterCount}")
      count=$((count + 1))
      printf '%s' "$count" > "${enterCount}"
      if [[ "$count" == "2" ]]; then
        if (( ${opts.swapAfterCaptures ?? 0} > 0 )); then printf '%s' "${opts.swapAfterCaptures ?? 0}" > "${swapDelay}";
        else cp "${nextPaneFile}" "${paneFile}"; fi
      fi
      if [[ "${opts.failSecondEnter ? '1' : '0'}" == "1" && "$count" == "2" ]]; then exit 1; fi
    fi
    exit 0
    ;;
esac
exit 1
`);
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  return { bin, log, helperPid };
}

// Status bars captured verbatim from live sessions (CC 2.1.238): a local probe and a
// production hermit. The differences are the point — `manual mode on` carries no
// "(shift+tab to cycle)" hint, the trailing segments vary with session state, and on the
// production hermit an artifact-links row renders BELOW the status bar.
const MODE_STATUS_BARS: Record<string, string> = {
  auto: '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent',
  default: '  ⏸ manual mode on · ← 1 agent',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent',
  plan: '  ⏸ plan mode on (shift+tab to cycle) · ← 1 agent',
};

const FLEET_PANE = `❯ Try "how does <filepath> work?"
────────────────────────────────────────
  ⏵⏵ auto mode on · 2 monitors · ← for agents · ↓ to manage
  ⧉  proposals-page · dashboard`;

const MODE_CYCLE = ['auto', 'default', 'acceptEdits', 'plan'];

/**
 * A tmux that cycles like Claude Code does: BTab advances the mode, capture-pane renders
 * that mode's status bar. `dialogPane` replaces the pane entirely, standing in for a
 * dialog covering the status bar.
 */
function installCyclingTmux(
  dir: string,
  startMode: string,
  opts: { dialogPane?: string; refuseKeys?: boolean } = {},
): { bin: string; log: string; modeFile: string } {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'tmux-calls.log');
  const modeFile = path.join(dir, 'mode');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(modeFile, startMode);

  const cases = MODE_CYCLE.map((mode, i) =>
    `    ${mode}) next=${MODE_CYCLE[(i + 1) % MODE_CYCLE.length]} ;;`).join('\n');
  const bars = MODE_CYCLE.map((mode) =>
    `    ${mode}) printf '%s\\n' "${MODE_STATUS_BARS[mode]}" ;;`).join('\n');

  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  has-session) exit 0 ;;
  capture-pane)
${opts.dialogPane ? `    printf '%s\\n' ${JSON.stringify(opts.dialogPane)}; exit 0 ;;` : `    printf '%s\\n' "❯ "
    case "$(cat "${modeFile}")" in
${bars}
    esac
    exit 0
    ;;`}
  send-keys)
    if [[ "${opts.refuseKeys ? '1' : '0'}" == "1" ]]; then exit 1; fi
    if [[ "$*" == *BTab* ]]; then
      case "$(cat "${modeFile}")" in
${cases}
      esac
      printf '%s' "$next" > "${modeFile}"
    fi
    exit 0
    ;;
esac
exit 1
`);
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  return { bin, log, modeFile };
}

async function waitForMode(modeFile: string, want: string, timeoutMs = POLL_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.readFileSync(modeFile, 'utf-8') === want) return;
    await Bun.sleep(25);
  }
  throw new Error(`pane never reached ${want} (stuck at ${fs.readFileSync(modeFile, 'utf-8')})`);
}

async function drain(dir: string, bin: string) {
  return runScript('stop-pipeline.ts', {
    stdin: '{}', cwd: dir,
    env: { AGENT_HOOK_PROFILE: 'minimal', PATH: `${bin}:${process.env.PATH}` },
  });
}

// Native commands have no Stop-hook actuator, including stale on-disk requests.
for (const command of ['/model', '/effort', '/compact', '/clear', '/advisor']) {
  test(`${command} is never typed by Stop`, withDir(async dir => {
    seedPendingSwitch(dir, command, null);
    const { bin, log } = installFakeTmux(dir, 'Claude ready');
    const before = fs.readFileSync(hermit(dir, 'state/runtime.json'), 'utf8');
    expect((await drain(dir, bin)).exitCode).toBe(0);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readFileSync(hermit(dir, 'state/runtime.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(switchVerifyMarker(dir))).toBe(false);
  }));
}

describe('permission-mode status-bar parsing', () => {
  test('reads every mode off its live status bar', () => {
    for (const [mode, bar] of Object.entries(MODE_STATUS_BARS)) {
      expect(paneModeLine(`❯ \n${bar}`)).toBe(mode);
    }
  });

  // A production hermit renders artifact links under the status bar, so the mode is not
  // on the final row — the reason this scans a window instead of the last line.
  test('reads the mode on a hermit that renders rows below the status bar', () => {
    expect(paneModeLine(FLEET_PANE)).toBe('auto');
  });

  // Null is the guard the cycler depends on: no mode read, no keystrokes.
  test('reports nothing rather than guessing when the status bar is absent', () => {
    expect(paneModeLine(MODEL_SWITCH_PANE)).toBeNull();
    expect(paneModeLine('')).toBeNull();
    expect(paneModeLine('❯ some prompt text\nno status bar here')).toBeNull();
  });

  test('reports nothing when the window contradicts itself', () => {
    expect(paneModeLine(`${MODE_STATUS_BARS.auto}\n${MODE_STATUS_BARS.plan}`)).toBeNull();
  });

  // Scrollback above the window must not be mistaken for the current mode.
  test('ignores a stale status bar scrolled out of the window', () => {
    const stale = [MODE_STATUS_BARS.plan, 'a', 'b', 'c', 'd', 'e'].join('\n');
    expect(paneModeLine(stale)).toBeNull();
  });
});

describe('Stop hook permission-mode delivery', () => {
  test('cycles the pane to the requested mode and records where it landed', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'acceptEdits');
    const { bin, log, modeFile } = installCyclingTmux(dir, 'auto');

    await drain(dir, bin);
    await waitForMode(modeFile, 'acceptEdits');

    // Typed text would reach Claude as a prompt — this command is keystrokes only.
    expect(fs.readFileSync(log, 'utf-8')).not.toContain('-l --');
    expect(fs.readFileSync(log, 'utf-8')).toContain('BTab');

    await waitForVerify(dir, 'acceptEdits');
    expect(fs.existsSync(pendingMarker(dir))).toBe(false);
  }));

  test('presses nothing when the session is already in the requested mode', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'auto');
    const { bin, log } = installCyclingTmux(dir, 'auto');

    await drain(dir, bin);
    await waitForVerify(dir, 'auto');

    expect(fs.readFileSync(log, 'utf-8')).not.toContain('BTab');
    // A satisfied request is consumed even though no key was pressed — otherwise every
    // later Stop hook re-delivers it and re-announces the switch until the TTL expires.
    expect(fs.existsSync(pendingMarker(dir))).toBe(false);
  }));

  // The prompt stage refuses these, so a marker naming one can only come from somewhere
  // else. `plan` is in the cycle, so the actuator has to refuse it too.
  test('drops a marker naming a mode no channel may set, without pressing', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'plan');
    const { bin, log } = installCyclingTmux(dir, 'auto');

    const result = await drain(dir, bin);
    await Bun.sleep(300);

    expect(result.stderr).toContain('not settable from a channel');
    expect(fs.readFileSync(log, 'utf-8')).not.toContain('BTab');
    expect(fs.existsSync(pendingMarker(dir))).toBe(false);
    expect(fs.existsSync(switchVerifyMarker(dir))).toBe(false);
  }));

  // While a dialog is up the status bar is off-screen. Pressing blind from there could
  // land anywhere, including somewhere more permissive than the operator asked for.
  test('refuses to press while a dialog covers the status bar, and keeps the request', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'default');
    const { bin, log } = installCyclingTmux(dir, 'auto', { dialogPane: MODEL_SWITCH_PANE });

    await drain(dir, bin);

    expect(fs.readFileSync(log, 'utf-8')).not.toContain('BTab');
    expect(fs.existsSync(pendingMarker(dir))).toBe(true);
    expect(fs.existsSync(switchVerifyMarker(dir))).toBe(false);
  }));

  // The marker records what was ASKED for, never where the pane ended up. Recording the
  // landed mode would make the prompt path compare that mode against itself and report
  // every stuck switch as a success — the one failure this feature must never produce.
  test('records the requested mode, so a stuck cycle cannot report itself as success', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'default');
    // A pane whose mode never changes, however many times BTab is pressed.
    const { bin } = installCyclingTmux(dir, 'auto');
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  capture-pane) printf '%s\\n' "❯ " "${MODE_STATUS_BARS.auto}"; exit 0 ;;
  send-keys) exit 0 ;;
esac
exit 1
`);
    fs.chmodSync(path.join(bin, 'tmux'), 0o755);

    await drain(dir, bin);
    await waitForVerify(dir, 'default');

    const verify = JSON.parse(fs.readFileSync(switchVerifyMarker(dir), 'utf-8'));
    expect(verify.arg).toBe('default');
    expect(verify.arg).not.toBe('auto');
  }));

  // Dying before the first keystroke lands must leave the request retryable, the same
  // contract a refused sendKeys gives the typed commands.
  test('keeps the request when tmux refuses the first keystroke', withDir(async (dir) => {
    seedPendingSwitch(dir, '/permission-mode', 'default');
    const { bin } = installCyclingTmux(dir, 'auto', { refuseKeys: true });

    await drain(dir, bin);
    await Bun.sleep(600);

    expect(fs.existsSync(pendingMarker(dir))).toBe(true);
  }));
});
