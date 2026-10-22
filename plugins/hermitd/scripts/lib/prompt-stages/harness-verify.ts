// UserPromptSubmit stage — report a delivered harness switch back to the session, from
// the transcript for /model and /effort, and from the pane for /permission-mode.
//
// The gap this closes: the native command applied successfully, but the model's sense of WHICH model it is running is
// fixed at session start and does not follow the switch. Asked "did it work?", the
// session answered from that stale self-perception and reported a working switch as a
// silent failure — twice, on two hermits, one of which then filed an upstream bug for
// a bug that did not exist.
//
// So the answer comes from the transcript instead, where the serving model is stamped
// on every assistant entry. This stage states the fact and nothing more; how it reaches
// the operator is the model's business.
//
// The timestamp gate is the whole correctness argument: on the prompt immediately after
// delivery the newest assistant entry is still the PRE-switch one, so reporting it would
// reproduce exactly the stale answer this exists to prevent. Until an entry newer than
// the delivery exists, the marker is held and the session is told only that its
// self-perception may be stale.

import { readSwitchVerify, clearSwitchVerify, renderCommand } from '../harness-command';
import { lastAssistantModel } from '../cc-compat';
import { capturePane, paneModeLine } from '../tmux';
import type { StageContext, StageResult } from './types';

const SESSION_SCOPED = 'This lasts for the current session only — a restart, including one the watchdog performs, puts the session back on the configured permission mode.';

/**
 * Report the mode the session is actually in now.
 *
 * The pane is authoritative and current, so unlike the model report below this needs no
 * grace window — but it can be unreadable (a dialog covering the status bar, a session
 * that has since gone away), and saying so is the honest answer. Claiming a switch that
 * may not have happened is the one outcome worth avoiding: the operator asked for this to
 * control what the hermit may do unattended.
 */
function permissionModeReport(ctx: StageContext, requested: string | null): string {
  const sessionName = ctx.runtime()?.tmux_session ?? '';
  const pane = sessionName ? capturePane(sessionName) : null;
  const landed = pane === null ? null : paneModeLine(pane);

  if (!landed) {
    return `[harness-command] "/permission-mode ${requested}" was delivered, but the session's permission mode could not be read back from the pane — report it as delivered, not confirmed, and suggest checking the terminal.\n`;
  }
  if (requested && landed !== requested) {
    return `[harness-command] "/permission-mode ${requested}" did not land — the session is in ${landed} mode. Report the failure and the mode it is actually in; do not claim the requested one.\n`;
  }
  return `[harness-command] the session is now in ${landed} permission mode, as requested. ${SESSION_SCOPED}\n`;
}

export function run(ctx: StageContext): StageResult | void {
  const pending = readSwitchVerify(ctx.dir);
  if (!pending) return;

  const rendered = renderCommand(pending);

  // Permission mode is answered from the pane, not the transcript, so it must be routed
  // before the transcript gate below — that gate exists to stop a stale MODEL being
  // reported and would otherwise hold this marker (and describe it in model terms) while
  // waiting for an assistant entry that has no bearing on it.
  if (pending.command === '/permission-mode') {
    clearSwitchVerify(ctx.dir);
    return { context: permissionModeReport(ctx, pending.arg) };
  }

  if (pending.command === '/effort') {
    clearSwitchVerify(ctx.dir);
    if (pending.arg === 'auto') return { context: `[harness-command] "${rendered}" cleared the chat effort override at ${pending.delivered_at}: requests use the launch level again.\n` };
    return { context: `[harness-command] "${rendered}" was applied at ${pending.delivered_at}: the core mod sends that effort with every main-thread request from now on. The status line and your own effort reading still show the launch level, so report the requested level as active.\n` };
  }

  const observed = ctx.transcriptPath ? lastAssistantModel(ctx.transcriptPath) : null;

  // No transcript to read, or nothing served since the switch could have applied: hold
  // the marker and warn rather than answer from a pre-switch entry.
  if (!observed || Date.parse(observed.timestamp) <= Date.parse(pending.delivered_at)) {
    return {
      context: `[harness-command] "${rendered}" was delivered to this session at ${pending.delivered_at} and is not yet observable in the transcript. Your own sense of which model you run is fixed at session start and does not follow a switch — do not report it as the active one.\n`,
    };
  }

  clearSwitchVerify(ctx.dir);

  return {
    context: `[harness-command] "${rendered}" delivered at ${pending.delivered_at} — the transcript now reports model ${observed.model}. That is the session's serving model; prefer it over your own sense of which model you run.\n`,
  };
}
