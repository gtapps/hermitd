import { withUnfinished } from './lib/routines/unfinished';
import { clearConversations } from './lib/channel-recovery';
import { conversationKey, isKey } from './lib/conversation-key';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { readSettledConfig } from './lib/config-read';
import { readTurn, transcriptPath } from './lib/cc-compat';
import { observeExecution } from './lib/tasks';
// stop-pipeline.ts — unified Stop hook
// Reads stdin once, runs all stop stages in sequence, touches heartbeat.
// Stages, in order: cost tracking, harness commands, heartbeat.
// Stage output goes to stderr. A channel checkpoint (intake or reply) may emit a Stop block on stdout.

import { run as costTracker } from './cost-tracker';
import { sessionCrons, backgroundTasks, ccVersion, hermitDir, sessionId } from './lib/cc-compat';
import { drainHarnessCommand } from './lib/harness-drain';
import { isGuest } from './lib/guest-marker';
import { intakeBlockReason } from './lib/intake-checkpoint';
import { replyBlockReason } from './lib/reply-checkpoint';
import { resolveHermitNowMs } from './lib/time';
import { recordOperatorTurnEnd } from './record-operator-action';
import fs from 'node:fs';
import path from 'node:path';

type Json = any;

const HERMIT_DIR = hermitDir();
const STATE_DIR = path.join(HERMIT_DIR, 'state');
const HEARTBEAT_FILE = path.join(STATE_DIR, '.heartbeat');
const SNAPSHOT_FILE = path.join(STATE_DIR, 'cc-stop-snapshot.json');
const TURN_FILE = path.join(STATE_DIR, 'operator-turn-open.json');
const STOP_FAILURE_FILE = path.join(STATE_DIR, 'stop-failure.json');

async function main(): Promise<void> {
  // Read stdin once
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize > 1024 * 1024) break;
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  // Defensive: fall back to {} on malformed/truncated input.
  // Stages that don't need the payload still run even on bad input.
  let payload: Json = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch {
      console.error('[stop-pipeline] malformed stdin, falling back to empty payload');
    }
  }

  const guest = isGuest(STATE_DIR, sessionId(payload));
  let blocked = false;

  // Operator-turn marker: whichever turn opened it is over — routines may fire.
  // Cleared before the stages, not after: this hook has a 15s timeout and the
  // stages below can burn it on a large session. A clear stranded behind them
  // would defer every monitor-delivered routine for the marker's full TTL —
  // the starvation class issue #617 fixed, just time-bounded.
  if (!guest) {
    observeExecution(HERMIT_DIR, 'idle', sessionId(payload), null, null);
    try {
      if (payload.stop_hook_active !== true) {
        const reason = await intakeBlockReason(HERMIT_DIR, sessionId(payload)) ?? await replyBlockReason(HERMIT_DIR, payload);
        if (reason) {
          console.log(JSON.stringify({ decision: 'block', reason }));
          blocked = true;
        }
      }
    } catch (e: any) { console.error(`[stop-pipeline] intake-checkpoint: ${e.message}`); }
    let closedOperatorTurn = false;
    if (!blocked) {
      const tasks = backgroundTasks(payload);
      if (tasks.state !== 'unsupported_or_unreachable') {
        const delegated = new Set(['subagent', 'workflow', 'teammate', 'cloud session', 'MCP task']);
        const running = tasks.entries.some(task => task.status === 'running' && delegated.has(task.type));
        withUnfinished(HERMIT_DIR, store => {
          for (const [key, entry] of Object.entries(store)) {
            if (!['started', 'awaiting'].includes(entry.state) || entry.session_id !== sessionId(payload)) continue;
            if (running) entry.state = 'awaiting';
            else delete store[key];
          }
        });
      }
      try {
        const tPath = transcriptPath(payload);
        if (tPath) {
          const { lines, prompt } = readTurn(tPath);
          const keys: string[] = [];
          const config = readSettledConfig(HERMIT_DIR);
          const add = (text: string) => {
            const env = parseChannelEnvelope(text, config);
            if (env) keys.push(conversationKey(env.sourceKey, env.chatId, env.thread));
          };
          if (prompt.boundaryFound) {
            add(prompt.text);
            const opener = JSON.parse(lines[prompt.index]);
            if (opener.type === 'user' && opener.origin?.kind === 'plugin' && opener.origin?.name === 'hermitd'
                && prompt.text.includes('<command-name>/hermitd:channel-responder</command-name>')) {
              const key = prompt.text.match(/<command-args>recover ([^<]+)<\/command-args>/)?.[1];
              if (isKey(key)) keys.push(key);
            }
            for (const line of lines.slice(prompt.index + 1)) {
              let entry: Json;
              try { entry = JSON.parse(line); } catch { continue; }
              const attachment = entry?.attachment;
              if (entry?.type === 'attachment' && attachment?.type === 'queued_command'
                  && attachment.origin?.kind === 'channel' && typeof attachment.prompt === 'string') add(attachment.prompt);
            }
            clearConversations(HERMIT_DIR, keys);
          }
        }
      } catch { /* An unreadable transcript never blocks Stop. */ }
      try { fs.unlinkSync(TURN_FILE); closedOperatorTurn = true; } catch {}
      // Quiet time runs from the operator turn's end.
      if (closedOperatorTurn) recordOperatorTurnEnd(resolveHermitNowMs());
    }
    // A Stop at all means the turn produced an assistant reply, so any stamp
    // stop-failure-stamp.ts left behind describes an episode that is over. Cleared
    // here, ahead of the stages, for the same reason the marker above is: a stage
    // that throws must not strand it and keep the watchdog classifying from it.
    try { fs.unlinkSync(STOP_FAILURE_FILE); } catch {}
  }

  // Stage 1: cost-tracker (always)
  try {
    const out = await costTracker(payload);
    if (out) console.error(out);
  } catch (e: any) { console.error(`[stop-pipeline] cost-tracker: ${e.message}`); }

  // Stage 4: drain a channel-requested harness command (/model, /effort, /compact, /clear).
  // The turn it arrived on has just ended, so the pane is idle and safe to type into —
  // the hook that recorded it deliberately did NOT type, because it runs at turn START.
  // Runs before the heartbeat touch but after the accounting stages, so a /clear can
  // never race cost-tracker still reading the outgoing transcript.
  // A blocked Stop continues the turn, so the pane is not idle yet.
  if (!guest && !blocked) {
    try { drainHarnessCommand(HERMIT_DIR); }
    catch (e: any) { console.error(`[stop-pipeline] harness-command: ${e.message}`); }
  }

  // Guaranteed heartbeat touch — runs even if all stages fail.
  //
  // Except in a guest session: .heartbeat is one of the resident's liveness signals
  // and the watchdog reads its age for wedge detection. A guest refreshing it means a
  // frozen resident never looks stale and is never restarted. The verdict was frozen
  // at the guest's session start, so if the resident dies mid-session the file goes
  // stale and the restart happens — which is the wanted outcome.
  if (!guest) {
    try { fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString() + '\n'); } catch {}
  }

  if (guest) return;

  // Write CC-stop-payload snapshot (tri-state, labeled with captured_at).
  // sole writer for state/cc-stop-snapshot.json. Fail-open.
  try {
    const crons = sessionCrons(payload);
    const tasks = backgroundTasks(payload);
    const snapshot = {
      captured_at: new Date().toISOString(),
      cc_version: ccVersion(payload),
      session_crons:    { state: crons.state, count: crons.count },
      background_tasks: { state: tasks.state, count: tasks.count },
    };
    const tmp = SNAPSHOT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch {}
}

main().catch(e => { console.error(`[stop-pipeline] ${e.message}`); });
