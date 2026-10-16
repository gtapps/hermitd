// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// PreToolUse hook (matcher "*", every tool) — the binding pause/stop/resume
// gate (PROP-015). Probe-verified (compiled/spike-channel-stop-probe-2026-07-03.md):
// a PreToolUse exit-2 deny is binding within one tool call with zero model
// cooperation. While state/pause.json says paused, every tool call is denied
// except the two shapes a paused hermit still needs to report its own status
// from a phone: any channel plugin's `reply` tool, and PushNotification. Pause
// stops actions, not communication.
//
// Fail-open: any error here (bad stdin, missing/corrupt flag) resolves to
// exit 0 (allow) — a hook must never block Claude Code, and a pause gate that
// fails closed would brick the hermit with no recovery but manual file surgery.

import { hermitDir } from './lib/cc-compat';
import { replyToolChannel } from './lib/channel-config';
import { readConfigRaw } from './lib/config-read';
import { isPaused } from './lib/pause';
import { runHook } from './lib/hook-input';

// Emit the deny message for a paused hermit and exit 2, or return to allow.
function denyIfPaused(): void {
  const status = isPaused(hermitDir());
  if (!status.paused) return; // allow
  const untilPhrase = status.until ? `until ${status.until}` : 'until resumed by operator';
  process.stderr.write(`Hermit is paused (${status.reason ?? 'operator'}, ${untilPhrase})\n`);
  process.exit(2);
}

function isExempt(toolName: string): boolean {
  return toolName === 'PushNotification' || replyToolChannel(toolName, readConfigRaw(hermitDir())) !== null;
}

function main(payload: any): void {
  const toolName = payload && typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!toolName || isExempt(toolName)) return; // allow
  denyIfPaused();
}

// Oversize stdin can't be parsed for tool_name, but the exempt tools (reply /
// PushNotification) are never ~1MB — so a paused hermit fails closed here
// rather than letting a large payload slip an action past the pause. Unpaused,
// denyIfPaused() returns and we fall through to allow.
runHook(main, denyIfPaused);
