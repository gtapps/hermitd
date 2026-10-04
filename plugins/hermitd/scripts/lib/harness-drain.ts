// Drain a pending channel-requested permission-mode switch into the tmux pane.
// Split out of stop-pipeline.ts so the guard cascade is unit-testable without
// spawning the whole Stop hook.

import { readRuntimeJson } from './runtime';
import { capturePane, paneModeLine, tmuxSessionAlive } from './tmux';
import { CHANNEL_SETTABLE_MODES, clearPendingCommand, normalizePermissionMode, readPendingCommand, renderCommand } from './harness-command';
import type { PendingCommand } from './harness-command';
import path from 'node:path';

/**
 * Hand a permission-mode switch to the detached cycler.
 *
 * The preconditions checked here are the ones that are cheaper to answer before spawning:
 * the pane must be readable and must currently show a mode. A null read also covers the
 * case that matters most — while any dialog is open the status bar is off-screen, so an
 * unreadable mode is exactly the state in which nothing should be typed at all.
 *
 * The pending marker is deliberately left in place: the cycler clears it once its first
 * keystroke lands, so a helper that dies before touching the pane leaves the request for
 * the next turn to retry.
 */
function deliverPermissionMode(hermitRoot: string, sessionName: string, pending: PendingCommand): void {
  const target = pending.arg ? normalizePermissionMode(pending.arg) : null;
  // The prompt stage refuses an unsettable mode before a marker is ever written; the
  // actuator re-checks anyway, because a marker reaching here from anywhere else (a
  // hand-edited or model-written state file) must not be able to steer the session into
  // `plan` — the one refused mode that IS in the cycle, and the one that can leave the
  // session unable to receive the command undoing it. Dropped rather than kept: no later
  // turn can make it deliverable, so retrying it until the TTL only respawns this path.
  if (!target || !CHANNEL_SETTABLE_MODES.has(target)) {
    clearPendingCommand(hermitRoot);
    const why = target ? 'is not settable from a channel' : 'does not name a permission mode';
    console.error(`[stop-pipeline] harness-command: "${renderCommand(pending)}" ${why} — dropped`);
    return;
  }

  const pane = capturePane(sessionName);
  const current = pane === null ? null : paneModeLine(pane);
  if (!current) {
    console.error('[stop-pipeline] harness-command: cannot read the permission mode from the pane — marker kept for retry');
    return;
  }

  const helper = path.join(import.meta.dir, '..', 'cycle-permission-mode.ts');
  const child = Bun.spawn([process.execPath, helper, sessionName, target, hermitRoot], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env: process.env,
  });
  child.unref();
  console.error(`[stop-pipeline] harness-command: cycling ${current} → ${target} (requested by ${pending.by})`);
}

/** Deliver a pending permission-mode request after the Stop hook. */
export function drainHarnessCommand(hermitRoot: string): void {
  const pending = readPendingCommand(hermitRoot);
  if (!pending) return;

  const runtime = readRuntimeJson(path.join(hermitRoot, 'state'));
  if (!runtime || runtime.runtime_mode === 'interactive') return;
  if (runtime.transition || runtime.shutdown_requested_at || runtime.shutdown_completed_at) return;

  const sessionName: string = runtime.tmux_session ?? '';
  if (!sessionName || !tmuxSessionAlive(sessionName)) return;

  deliverPermissionMode(hermitRoot, sessionName, pending);
}
