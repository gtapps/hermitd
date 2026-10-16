#!/usr/bin/env bun
/**
 * Operator CLI for the binding pause/stop/resume flag (PROP-015).
 * Run from project root: .hermit/bin/hermitd-pause on|off|snooze <dur>|status
 *
 * This is always available regardless of pause state — the PreToolUse gate
 * (pause-gate.ts) only sees the model's tool calls, never the operator's own
 * shell, so `hermitd-pause off` works even while the hermit itself is paused
 * and blocked from resuming via any tool call of its own.
 */

import { setPause, clearPause, isPaused, parseSnoozeDuration } from './lib/pause';
import { hermitDir } from './lib/cc-compat';

// Resolve the hermit root the same way the writer (lib/prompt-stages/pause-keyword.ts) does —
// hermitDir() honors CLAUDE_PROJECT_DIR then walks up for config.json, so the
// CLI targets the real flag even when run from a subdirectory. A hardcoded
// relative '.hermit' would resolve against the caller's cwd; run
// from anywhere but the project root it would miss the flag, and clearPause's
// force-rm would then print a false "resumed" while the hermit stayed paused.
const HERMIT_ROOT = hermitDir();
const BY = 'operator-cli';

function usage(): never {
  console.log('Usage: hermitd-pause on|off|snooze <duration>|status');
  console.log('  on               pause indefinitely');
  console.log('  off              resume');
  console.log('  snooze <dur>     pause for a duration, e.g. 30m, 2h, 1d');
  console.log('  status           print current pause state');
  process.exit(1);
}

function printStatus(): void {
  const status = isPaused(HERMIT_ROOT);
  if (!status.paused) {
    console.log('[hermitd-pause] not paused');
    return;
  }
  const untilPhrase = status.until ? `until ${status.until}` : 'indefinite';
  console.log(`[hermitd-pause] paused (${status.reason ?? 'operator'}) by ${status.by ?? 'unknown'} — ${untilPhrase}`);
}

function main(): void {
  const cmd = process.argv[2];

  if (cmd === 'on') {
    setPause(HERMIT_ROOT, { reason: 'operator', by: BY });
    console.log('[hermitd-pause] paused indefinitely');
  } else if (cmd === 'off') {
    clearPause(HERMIT_ROOT);
    console.log('[hermitd-pause] resumed');
  } else if (cmd === 'snooze') {
    const raw = process.argv[3];
    const ms = raw ? parseSnoozeDuration(raw) : null;
    if (ms === null) {
      console.log(`[hermitd-pause] could not parse duration "${raw ?? ''}" — expected e.g. 30m, 2h, 1d`);
      process.exit(1);
    }
    const until = new Date(Date.now() + ms).toISOString();
    setPause(HERMIT_ROOT, { reason: 'operator', by: BY, until });
    console.log(`[hermitd-pause] paused until ${until}`);
  } else if (cmd === 'status') {
    printStatus();
  } else {
    usage();
  }
}

main();
