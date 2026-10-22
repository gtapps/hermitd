/**
 * Shared tmux helpers for the lifecycle scripts
 * (hermitd-start, hermitd-stop, hermitd-watchdog) and the harness-command drain.
 *
 * Two transports, one implementation. `docker` prefixes the same tmux argv with
 * `docker compose … exec -T <service>`; nothing else differs, because tmux
 * send-keys talks to the tmux server socket rather than the exec's TTY, so
 * `-T` (no TTY allocation) is irrelevant to delivery. Every call builds an argv
 * array — never a shell string — so a session name or message body can't be
 * read as shell syntax.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PERMISSION_MODE } from './settings/enums';

type Json = any;

export type Transport =
  | { kind: 'host' }
  | { kind: 'docker'; composeFile: string; service: string };

export const HOST: Transport = { kind: 'host' };

/** Build the full argv for a tmux invocation under the given transport. */
export function tmuxArgv(transport: Transport, args: string[]): { cmd: string; argv: string[] } {
  if (transport.kind === 'host') return { cmd: 'tmux', argv: args };
  return {
    cmd: 'docker',
    argv: ['compose', '-f', transport.composeFile, 'exec', '-T', transport.service, 'tmux', ...args],
  };
}

function runTmux(transport: Transport, args: string[]): { status: number | null; error: unknown } {
  const { cmd, argv } = tmuxArgv(transport, args);
  const r = spawnSync(cmd, argv, { stdio: 'ignore' });
  return { status: r.status, error: r.error };
}

/** Return true when the named tmux session exists. `=` forces an exact match: a bare
 *  target also matches a session whose name merely starts with `name`. */
export function tmuxSessionAlive(name: string, transport: Transport = HOST): boolean {
  return runTmux(transport, ['has-session', '-t', `=${name}`]).status === 0;
}

/** Capture the visible pane as text, or null when tmux cannot read it. */
export function capturePane(name: string, transport: Transport = HOST): string | null {
  if (!name) return null;
  const { cmd, argv } = tmuxArgv(transport, ['capture-pane', '-p', '-t', name]);
  try {
    const r = spawnSync(cmd, argv, { encoding: 'utf-8', timeout: 5000 });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/**
 * Send one named key (tmux key-name form, e.g. `BTab`) with no trailing Enter.
 *
 * Callers here are driving the TUI's own keybindings rather than typing a prompt.
 *
 * The letters-only shape check is the barrier, not a key allow-list: it keeps the value
 * from carrying an escape sequence or literal text into the pane, and callers are trusted
 * internal code (channel-supplied values never reach this).
 */
export function sendKey(sessionName: string, keyName: string, transport: Transport = HOST): boolean {
  if (!sessionName || !/^[A-Za-z]+$/.test(keyName)) return false;
  const sent = runTmux(transport, ['send-keys', '-t', sessionName, keyName]);
  return !sent.error && sent.status === 0;
}

/**
 * Claude Code's status-bar phrase for each permission mode, keyed by config value.
 *
 * All six probed live on CC 2.1.238 — the phrase is stable but what surrounds it is not:
 * the suffix varies with session state (`(shift+tab to cycle)` is absent on manual mode,
 * and trailing segments like `· 2 monitors · ← for agents` appear on a busy hermit), so
 * only the phrase itself may be matched. The apostrophe in `don't ask on` is ASCII
 * U+0027, not the typographic U+2019 — verified by hexdump of the rendered pane, because
 * a curly one here would fail closed for exactly the most permissive sessions.
 */
const MODE_PHRASES: Record<(typeof PERMISSION_MODE)[number], string> = {
  auto: 'auto mode on',
  default: 'manual mode on',
  acceptEdits: 'accept edits on',
  plan: 'plan mode on',
  bypassPermissions: 'bypass permissions on',
  dontAsk: "don't ask on",
};

const MODE_SCAN_LINES = 4;

/**
 * Read the session's active permission mode out of a captured pane, or null.
 *
 * Scans the last few nonblank rows rather than the final one: on a production hermit an
 * artifact-links footer renders BELOW the status bar (probed on the fleet), so a
 * last-line-only match reports nothing there. Null on no match and on a contradictory
 * one — a caller acting on a misread mode would cycle the session somewhere the operator
 * did not ask for, which is strictly worse than reporting that the pane was unreadable.
 *
 * Null is also the guard against acting while a dialog is up: a dialog terminates the
 * visible content, so the status bar falls outside the scan window and no mode is
 * returned.
 */
/** The pane's last `maxLines` non-blank rows, rejoined. */
export function nonBlankTail(paneContent: string, maxLines: number): string {
  return paneContent
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-maxLines)
    .join('\n');
}

export function paneModeLine(paneContent: string): string | null {
  const tail = nonBlankTail(paneContent, MODE_SCAN_LINES).toLowerCase();

  const matched = Object.entries(MODE_PHRASES)
    .filter(([, phrase]) => tail.includes(phrase))
    .map(([mode]) => mode);

  return matched.length === 1 ? matched[0] : null;
}

/**
 * Expand the configured session-name template against an explicit project dir.
 *
 * Callers that know the project directory (rather than assuming it is the CWD)
 * must use this — the doctor, for one, is routinely run from elsewhere.
 */
export function expandSessionName(config: Json, projectDir: string): string {
  const name = config.tmux_session_name ?? 'hermit-{project_name}';
  return String(name).replaceAll('{project_name}', path.basename(projectDir));
}

/** Derive the tmux session name from config (CWD-relative project name). */
export function getSessionName(config: Json): string {
  return expandSessionName(config, process.cwd());
}
