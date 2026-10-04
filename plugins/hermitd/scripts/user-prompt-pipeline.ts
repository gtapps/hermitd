// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// UserPromptSubmit hook — the single process for the whole prompt path.
//
// Records the operator action, injects time + the channel reply reminder, then
// applies pause / harness-command / shutdown / status in explicit precedence.
//
// Replaces seven separately-registered hooks. Each of those re-read stdin,
// re-parsed the channel envelope, and re-read config; the operator paid all
// seven process launches on every message they sent. This reads stdin once,
// parses once, and runs the stages in an order that is now explicit in code
// rather than implied by their order in hooks.json.
//
// Two behaviors that the multi-process shape could not express:
//
//   1. Shutdown is terminal. While a shutdown is pending, the audit/context
//      stages still run, then the shutdown stage answers and the pipeline
//      ends — whether or not its send succeeded. Previously a failed shutdown
//      send fell through, and an exact `/status` message could then send and
//      block on its own, discarding the shutdown-relay instruction the model
//      was supposed to act on. Pause/resume and harness commands are skipped
//      for the same reason: mutating session state mid-shutdown answers a
//      message the shutdown reply has already answered.
//
//   2. One disposition per prompt. Output is buffered and emitted once at the
//      end: a confirmed block prints the decision JSON *alone*, because mixed
//      plain text and JSON on stdout does not parse as a decision and the
//      block would be silently lost.
//
// Contract preserved from the scripts this replaces: always exit 0, never
// block on a failed send, and per-stage errors are isolated — a throwing stage
// is logged to stderr and the rest still run (the stop-pipeline.ts pattern).

import path from 'node:path';
import fs from 'node:fs';
import { resolveCommand } from './lib/prompt-stages/harness-command';
import { isTrustedController } from './lib/channel-auth';
import type { HarnessDecision } from './lib/harness-mod';
import { observeExecution } from './lib/tasks';
import { classifySource } from './lib/trigger-source';

import { hermitDir, transcriptPath as ccTranscriptPath, sessionId as ccSessionId } from './lib/cc-compat';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { readConfigRaw } from './lib/config-read';
import { readRuntimeJson } from './lib/runtime';
import { ownsResidentIdentity } from './lib/session-registry';
import { isGuest } from './lib/guest-marker';
import type { StageContext, StageResult } from './lib/prompt-stages/types';

import { openTurnMarker, run as recordOperatorAction } from './record-operator-action';
import { run as conversation } from './lib/prompt-stages/conversation';
import { run as promptContext } from './lib/prompt-stages/prompt-context';
import { run as channelReplyReminder, invokeResponder } from './lib/prompt-stages/channel-reply-reminder';
import { run as pauseKeyword } from './lib/prompt-stages/pause-keyword';
import { run as harnessCommand } from './lib/prompt-stages/harness-command';
import { run as skillRelay } from './lib/prompt-stages/skill-relay';
import { run as harnessVerify } from './lib/prompt-stages/harness-verify';
import { run as shutdownGate } from './lib/prompt-stages/shutdown-gate';
import { run as channelStatusResponder } from './lib/prompt-stages/channel-status-responder';

// Matches stop-pipeline.ts — a prompt payload far past this is not something a
// stage can act on, and reading it unbounded is the only way this hook can hang.
const MAX_STDIN_BYTES = 1024 * 1024;

export async function runPromptPipeline(raw: string, harnessMode = false): Promise<HarnessDecision> {
  let harnessDecision: HarnessDecision = { decision: 'pass' };
  const out: string[] = [];
  let blockReason: string | null = null;
  let operatorActivityKept = false;
  let residentAdmitted = false;
  let admittedSession: string | null = null;
  let admittedSource: string | null = null;

  async function stage(name: string, fn: (ctx: StageContext) => any, ctx: StageContext): Promise<void> {
    if (blockReason) return; // a disposition is already settled
    try {
      const result: StageResult | void = await fn(ctx);
      if (!result) return;
      if (result.harness) harnessDecision = result.harness;
      if (result.context) out.push(result.context);
      if (result.block) blockReason = result.block;
    } catch (e: any) {
      process.stderr.write(`[user-prompt-pipeline] ${name}: ${e?.message || e}\n`);
    }
  }

  async function main(raw: string): Promise<void> {
    // Defensive parse: stages that don't need the payload still run on bad input,
    // exactly as stop-pipeline.ts does.
    let prompt: string | null = null;
    let transcript: string | null = null;
    let sessionId: string | null = null;
    try {
      const payload = JSON.parse(raw);
      prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : null;
      transcript = ccTranscriptPath(payload);
      sessionId = ccSessionId(payload);
    } catch {
      process.stderr.write('[user-prompt-pipeline] malformed stdin — continuing with an empty prompt\n');
      // A parse failure on non-empty stdin means a prompt did arrive and was
      // mangled — MAX_STDIN_BYTES truncation cuts mid-JSON. Carry on with an empty
      // prompt rather than returning: the audit and timestamp stages don't need the
      // text, and every prompt-matching stage below fails closed on ''. Returning
      // here would leave the turn unrecorded and read the operator as silent.
      if (raw.length === 0) return;
      prompt = '';
    }
    if (prompt === null) return; // parsed, but no prompt for the stages to act on

    const dir = hermitDir();

    let configCache: any;
    let configRead = false;
    let runtimeCache: any;
    let runtimeRead = false;

    const ctx: StageContext = {
      dir,
      harnessMode,
      sessionId,
      prompt,
      envelope: parseChannelEnvelope(prompt),
      transcriptPath: transcript,
      config() {
        // Raw, not settled: shutdown-gate and channel-status-responder treat a
        // null config as a disclosure gate (silent no-op); settling would loosen it.
        if (!configRead) { configRead = true; try { configCache = readConfigRaw(dir); } catch { configCache = null; } }
        return configCache;
      },
      runtime() {
        if (!runtimeRead) { runtimeRead = true; try { runtimeCache = readRuntimeJson(path.join(dir, 'state')); } catch { runtimeCache = null; } }
        return runtimeCache;
      },
    };

    if (harnessMode) {
      if (!fs.existsSync(dir) || !sessionId || ctx.runtime()?.cc_session_id !== sessionId) return;
      const env = ctx.envelope;
      const parsed = resolveCommand(ctx);
      if (!env || !parsed || !['/model', '/effort', '/compact', '/clear', '/advisor', '/doctor'].includes(parsed.command)
        || !isTrustedController(ctx.config(), env.source, env.userId, env.chatId)) return;
    }
    const guest = isGuest(path.join(dir, 'state'), sessionId);
    residentAdmitted = !guest;
    admittedSession = sessionId;
    admittedSource = classifySource(prompt);

    await stage('resident-gate', () => {
      if (!ctx.envelope) return;
      if (guest) {
        return { block: 'guest session: channel message left to the resident' };
      }
      if (!harnessMode && !ownsResidentIdentity(ctx.runtime())) {
        return { block: 'channel message left to the resident session' };
      }
    }, ctx);

    // 1-3. Audit and context. These run on every admitted prompt, including during a
    // shutdown — the operator's message is still recorded and the reply reminder
    // still names the chat to answer on.
    await stage('prompt-context', promptContext, ctx);
    await stage('conversation', conversation, ctx);
    if (harnessMode && ctx.skipHarnessCommand) return;
    // The reminder stage runs BEFORE the audit: it resolves passive-chat membership
    // and self-mention over the network and warms lib/channel-chats.ts's cache, which
    // record-operator-action's cache-only gate then reads. Auditing first misclassified
    // the first message in an unseen Discord thread in both directions — stranger
    // chatter froze the operator-silence clock, and a role mention the hermit did
    // answer never advanced it (issue #835's failure). A passive block settles the
    // disposition here too, so stage() skips the audit: chatter the model never sees
    // is not operator activity.
    await stage('channel-reply-reminder', channelReplyReminder, ctx);
    await stage('record-operator-action',
      () => { operatorActivityKept = recordOperatorAction(prompt, { envelope: ctx.envelope, config: ctx.config() }, { openTurn: false, sessionId }); }, ctx);

    // A guest's own prompts still receive context, but cannot control the resident.
    // Its channel messages never get this far: the resident gate above blocks them.
    if (guest) return;

    const rt = ctx.runtime();
    const shutdownPending = !!rt && !!rt.shutdown_requested_at && !rt.shutdown_completed_at;

    if (shutdownPending) {
      // Terminal: answer the shutdown and stop. Nothing below runs — not pause,
      // not a harness command, not status.
      await stage('shutdown-gate', shutdownGate, ctx);
      return;
    }

    // 4-6. State writers and delivered relay context. They land before any network
    // send, so an outer-timeout kill can lose a send but never a state write.
    await stage('pause-keyword', pauseKeyword, ctx);
    if (!ctx.skipHarnessCommand) await stage('harness-command', harnessCommand, ctx);
    if (harnessMode) return;
    await stage('channel-responder-invoke', invokeResponder, ctx);
    await stage('skill-relay', skillRelay, ctx);

    // 7. Deterministic status.
    await stage('channel-status-responder', channelStatusResponder, ctx);

    // 8. Switch verification LAST, and specifically after the status responder:
    // its success path clears the verify marker, and a blocked prompt discards all
    // accumulated context (see emit()). Running it earlier let a blocked `status`
    // turn destroy the marker with the report unread — stage() skips it entirely
    // once a block is settled, so the marker survives for the next real prompt.
    await stage('harness-verify', harnessVerify, ctx);
  }

  function emit(): void {
    // A block must be the only thing on stdout: Claude Code parses stdout as a
    // decision object, and any leading context text makes that parse fail, which
    // would drop the block and deliver the prompt anyway. The accumulated context
    // is moot on a blocked prompt — the model never sees that turn.
    if (blockReason) {
      console.log(JSON.stringify({ decision: 'block', reason: blockReason }));
      return;
    }
    for (const chunk of out) process.stdout.write(chunk.endsWith('\n') ? chunk : `${chunk}\n`);

    // Last, and only here: the disposition is now settled as "the model will take
    // this turn". Written after stdout so a throw on this write can never swallow
    // the decision or the injected context — emit()'s caller catches and exits 0.
    if (operatorActivityKept) openTurnMarker();
    if (residentAdmitted) observeExecution(hermitDir(), 'in_flight', admittedSession, admittedSource, null);
  }

  await main(raw);
  if (!harnessMode) emit();
  else if (blockReason) return { decision: 'refuse', reason: blockReason, silent: true };
  return harnessDecision;
}

if (import.meta.main) try {
  let buf = '';
  let truncated = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (truncated) return;
    buf += chunk;
    if (buf.length > MAX_STDIN_BYTES) { buf = buf.slice(0, MAX_STDIN_BYTES); truncated = true; }
  });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    runPromptPipeline(buf)
      .catch((e: any) => process.stderr.write(`[user-prompt-pipeline] ${e?.message || e}\n`))
      .finally(() => process.exit(0));
  });
} catch {
  process.exit(0);
}
