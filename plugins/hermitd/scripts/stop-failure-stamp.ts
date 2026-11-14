import { stampInterrupted } from './lib/routines/unfinished';
import { observeExecution } from './lib/tasks';
// stop-failure-stamp.ts — StopFailure hook
//
// Claude Code fires StopFailure when a turn ends in an upstream failure instead
// of an assistant reply. The payload carries a typed `error` (the live key; the
// docs spell it `error_type`), so this is the one place the failure category is
// known rather than inferred from rendered error text.
//
// The hook only records. It writes state/stop-failure.json and stops there: the
// watchdog owns the notification, and stop-pipeline.ts deletes the stamp on the
// next healthy Stop. Guest sessions and subagents write nothing, the same residency
// gate every other state-writing hook applies — one hermit folder, one resident writer.
//
// Fail-open and side-effect-only: every path exits 0 with empty stdout.

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir, sessionId } from './lib/cc-compat';
import { isGuest } from './lib/guest-marker';
import { runHook } from './lib/hook-input';
import { localISOStamp } from './lib/time';

type Json = any;

// The message is a diagnostic aid for the classifier's usage-limit text match,
// not a transcript; CC's limit lines are far shorter than this.
const MESSAGE_MAX_LEN = 300;

function main(payload: Json): void {
  // Only a genuine StopFailure payload stamps, the same gate precompact-stamp.ts
  // applies: these scripts are reachable through the wildcarded `bun */scripts/*.ts*`
  // grant, and a hand-fed `{"error":"rate_limit"}` would otherwise push the watchdog
  // into notifying the operator about an outage that never happened.
  if (payload.hook_event_name !== 'StopFailure') return;
  // A subagent's StopFailure carries the parent's session_id plus its own agent_id
  // (probed on CC 2.1.323). It is neither the resident's turn ending nor its failure.
  if (typeof payload.agent_id === 'string' && payload.agent_id) return;

  const stateDir = path.join(hermitDir(), 'state');
  if (isGuest(stateDir, sessionId(payload))) return;
  observeExecution(hermitDir(), 'idle', sessionId(payload), null, 'stop-failure');

  const stamp = {
    error: payload.error,
    session_id: sessionId(payload),
    at: localISOStamp(),
    last_assistant_message: typeof payload.last_assistant_message === 'string'
      ? payload.last_assistant_message.slice(0, MESSAGE_MAX_LEN)
      : null,
  };

  // tmp+rename so the watchdog never reads a half-written stamp. No mkdir: an
  // absent state/ is a worktree projection or a folder that was never hatched,
  // and creating it there is what lib/cc-compat.ts's projection check forbids.
  const file = path.join(stateDir, 'stop-failure.json');
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stamp) + '\n', 'utf-8');
    fs.renameSync(tmp, file);
    stampInterrupted(hermitDir(), 'api', sessionId(payload) ?? undefined);
  } catch { /* fail-open */ }
}

runHook(main);
