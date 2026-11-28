import { reconcileRoutines } from './lib/routines/recover';
// JSON-only bridge between the Claude Code mod and core's resident-owned state.
import { clearRecoveryPending, reconcileChannels } from './lib/channel-recovery';
import fs from 'node:fs';
import path from 'node:path';
import { readConfigRaw, readSettledConfig } from './lib/config-read';
import { cmpSemver } from './lib/semver';
import { requestRestart } from './lib/request-restart';
import { hermitDir, transcriptDirFor } from './lib/cc-compat';
import { readJson } from './lib/cli';
import { readRuntimeJson } from './lib/runtime';
import { residentPeerName } from './lib/session-registry';
import { readCloudBindings } from './lib/cloud-bindings';
import { readTasks, HELPER_OWNER } from './lib/tasks';
import { clip } from './lib/sanitize';
import { clearSkillRelay, renderCommand, writeSkillRelay, writeSwitchVerify } from './lib/harness-command';
import { sendToChannel } from './lib/channel-send';
import {
  approvalReason, APPROVAL_CHECK_FAILED, APPROVAL_PROMPT_REFUSED, claim, enqueue, finalize, freeText, modLoadedForResident, MOD_LOADED_FILE, pendingPurpose, QUEUE_PROTOCOL, readInflight, recordLegs, recover, writeModState,
  type Leg, type QueueEntry, type ReplyTarget, type Unanswered,
} from './lib/harness-mod';

// The version of the plugin copy this bridge runs from: the mod that called it lives
// in the same copy, so a reload that replaced the mod also replaced this file.
function ownVersion(): string {
  return readJson(path.join(import.meta.dir, '..', '.claude-plugin', 'plugin.json'))?.version ?? 'unknown';
}

/** An always-on agent that starts with a version gap migrates from the queue after its boot
 *  turn, then restarts once when quiet so the next boot runs on the migrated state. */
function queueStartUpgrade(dir: string): void {
  const config = readConfigRaw(dir);
  const version = ownVersion();
  if (config?.always_on !== true || cmpSemver(version, String(config._hermit_versions?.hermitd ?? '0.0.0')) <= 0) return;
  if (pendingPurpose(dir, 'upgrade')) return;
  const queued = enqueue(dir, {
    source: 'update', purpose: 'upgrade', expect_version: version,
    commands: [{ command: '/hermitd:hermit-evolve', arg: 'unattended' }],
  });
  if (queued.status !== 'queued') return;
  requestRestart(dir, 'requested', { expect: { hermitd: version }, boot: readRuntimeJson(path.join(dir, 'state'))?.session_pid });
}

const REFUSALS: Record<string, string> = {
  mod_not_loaded: 'The command executor has not loaded for this session yet. Resend the command in a moment.',
  shutdown: 'This hermit is shutting down. Resend the command once it is back.',
};

async function reply(dir: string, text: string, target: ReplyTarget) {
  const sent = await sendToChannel(dir, text, {
    target: { id: target.source, chat_id: target.chat_id, thread: target.thread }, timeoutMs: 6000,
  });
  return sent.ok ? { decision: 'ok' } : { decision: 'send_failed', text, reply_to: target };
}

function replyText(entry: QueueEntry, legs: Leg[]): string {
  return legs.map((leg, i) => {
    const shown = entry.commands[i] ? renderCommand(entry.commands[i]) : leg.command;
    return `${shown}: ${leg.status === 'unknown' ? 'outcome unknown' : leg.status}${leg.text ? ` (${leg.text})` : ''}`;
  }).join('\n');
}

/** Answers requests the queue finalized without running; sent after the queue lock is released. */
async function answerUnanswered(dir: string, unanswered: Unanswered[]): Promise<{ relays?: { text: string; reply_to: ReplyTarget }[] }> {
  const relays: { text: string; reply_to: ReplyTarget }[] = [];
  for (const { entry, legs } of unanswered) {
    const sent = await reply(dir, replyText(entry, legs), entry.reply_to!);
    if (sent.decision === 'send_failed') relays.push({ text: sent.text!, reply_to: entry.reply_to! });
  }
  return relays.length ? { relays } : {};
}

export async function run(verb: string, sessionId: string, payload = ''): Promise<unknown> {
  const dir = hermitDir();
  // A peer's name is only its claim, so a helper runs only the commands the operator exposed to helpers.
  if (verb === 'peer-name') {
    if (!fs.existsSync(dir)) return { error: 'no_hermit_dir' };
    const listed = readConfigRaw(dir)?.chat_commands;
    const commands = Array.isArray(listed) ? listed.filter(item => item?.session === 'helper' && typeof item.name === 'string').map(item => item.name) : [];
    return { name: residentPeerName(dir), commands };
  }
  if (verb === 'park') {
    try {
      const runtime = readRuntimeJson(path.join(dir, 'state'));
      if (!sessionId || runtime?.cc_session_id !== sessionId) throw new Error('session mismatch');
      const input = JSON.parse(payload);
      if (!['check', 'prompt'].includes(input.event)) throw new Error('invalid event');
      const { approvalTurn, approvalConsole } = await import('./settings-gate');
      const tDir = transcriptDirFor(path.dirname(dir), runtime.config_dir);
      const transcript = path.join(tDir, `${sessionId}.jsonl`);
      if (path.dirname(transcript) !== tDir) throw new Error('invalid session');
      const turn = approvalTurn({ transcript_path: transcript }, dir);
      if (turn.kind === 'typed') return { decision: 'pass' };
      if (turn.kind === 'admin_chat') return input.event === 'check'
        ? { decision: 'pass' } : { decision: 'decline', after_seconds: 60 };
      if (input.event === 'prompt') return { decision: 'deny', reason: APPROVAL_PROMPT_REFUSED };
      const console = approvalConsole(dir, readSettledConfig(dir));
      return { decision: 'deny', reason: approvalReason({
        variant: turn.channel ? turn.conversation === console?.key ? 'console' : 'chat' : 'unattended',
        tool: typeof input.tool === 'string' ? input.tool : 'approval', source: input.source,
        taskCommand: '.hermit/bin/hermitd-run task', console: console?.key ?? null,
      }) };
    } catch {
      return { decision: 'deny', reason: APPROVAL_CHECK_FAILED };
    }
  }
  const runtime = readRuntimeJson(path.join(dir, 'state'));
  if (!fs.existsSync(dir) || !sessionId || runtime?.cc_session_id !== sessionId) return verb === 'loaded' && fs.existsSync(dir)
    ? { decision: 'pass', approvals: readSettledConfig(dir).approvals } : { decision: 'pass' };
  switch (verb) {
    case 'intake': {
      // Loaded only here: the other verbs need none of the stages.
      const { runPromptPipeline } = await import('./user-prompt-pipeline');
      const decision = await runPromptPipeline(JSON.stringify({ prompt: payload, session_id: sessionId }), true);
      if (decision.decision !== 'run') return decision;
      if (decision.chat) {
        const refuse = (reason: string) => ({ decision: 'refuse', reason, reply_to: decision.reply_to });
        if (!modLoadedForResident(dir)) return refuse(REFUSALS.mod_not_loaded);
        if (runtime?.shutdown_requested_at) return refuse(REFUSALS.shutdown);
        const { command, arg } = decision.commands[0];
        if (arg !== null && !freeText(arg)) return refuse('Arguments must be one line, at most 512 characters, with no control characters.');
        const base = { command, args: arg, reply_to: decision.reply_to };
        if (decision.chat.session !== 'helper' || !HELPER_OWNER.test(decision.chat.owner)) return { decision: 'chat', ...base };
        const helper = decision.chat.owner.slice('helper:'.length);
        const task = readTasks(dir).find(record => record.id === decision.chat!.task);
        const binding = readCloudBindings(dir).find(item => item.task === decision.chat!.task);
        const progress = task?.body.match(/^## Progress\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
        const handoff = [...progress.matchAll(/\bHanded to helper ([A-Za-z0-9._-]+) \(([A-Za-z0-9-]{8,})\)/g)].at(-1);
        const to = binding?.helper ?? (handoff && handoff[1] === helper && handoff[2].length > 8 ? { sessionId: handoff[2] } : helper);
        return { decision: 'forward', to, helper, ...base };
      }
      const queued = enqueue(dir, { source: 'chat', by: decision.by, commands: decision.commands, reply_to: decision.reply_to });
      return queued.status === 'queued'
        ? { decision: 'queued', id: queued.id }
        : { decision: 'refuse', reason: REFUSALS[queued.reason] ?? queued.reason, reply_to: decision.reply_to };
    }
    case 'loaded': {
      const { approvals } = readSettledConfig(dir);
      writeModState(dir, MOD_LOADED_FILE, { session_id: sessionId, queue: QUEUE_PROTOCOL, approvals });
      try { queueStartUpgrade(dir); } catch { /* doctor reports a version gap that stays */ }
      return { decision: 'ok', state: path.join(dir, 'state'), session_id: sessionId, approvals };
    }
    case 'reconcile': {
      const options = payload ? JSON.parse(payload) : {};
      const now = Date.now();
      const routines = reconcileRoutines(dir, now, options.lastTurnCompleteAt);
      const channels = await reconcileChannels(dir, now);
      const queued = [...routines.entries, ...channels.entries].map(entry => enqueue(dir, entry));
      const pending = routines.pending || channels.pending;
      if (!pending) clearRecoveryPending(dir);
      return { decision: 'ok', pending, queued };
    }
    case 'claim': {
      const unanswered: Unanswered[] = [];
      const options = payload && payload !== 'pause' ? JSON.parse(payload) : {};
      const entry = claim(dir, sessionId, ownVersion(), { pauseOnly: payload === 'pause', lastTurnCompleteAt: options.lastTurnCompleteAt, unanswered });
      return { ...(entry ? { ...entry, decision: 'run' } : { decision: 'pass' }), ...(await answerUnanswered(dir, unanswered)) };
    }
    case 'recover': {
      const unanswered: Unanswered[] = [];
      const entry = recover(dir, ownVersion(), Date.now(), unanswered);
      return { ...(entry ? { ...entry, decision: 'run' } : { decision: 'pass' }), ...(await answerUnanswered(dir, unanswered)) };
    }
    case 'leg': {
      const input = JSON.parse(payload) as { id: string; legs: Leg[] };
      return { decision: recordLegs(dir, input.id, input.legs) ? 'ok' : 'pass' };
    }
    case 'relay': {
      // The in-flight entry, not the payload, carries the reply target and requester.
      const input = readInflight(dir, (JSON.parse(payload) as { id?: string }).id ?? '');
      const command = input?.commands?.[0];
      if (!input || !command || !input.reply_to || !writeSkillRelay(dir, {
        command: command.command, arg: command.arg, by: input.by ?? 'terminal', reply_to: input.reply_to, delivered_at: new Date().toISOString(),
      })) throw new Error('Skill relay marker not written');
      return { decision: 'ok' };
    }
    case 'finalize': {
      const input = JSON.parse(payload) as { id?: string; legs?: Leg[]; reason?: string; reply_to?: ReplyTarget };
      if (!input.id) return input.reply_to && input.reason ? reply(dir, clip(input.reason, 4000), input.reply_to) : { decision: 'ok' };
      const entry = readInflight(dir, input.id);
      const outcome = finalize(dir, input.id, { legs: input.legs ?? [] });
      if (!entry || !outcome) return { decision: 'ok' };
      const legs = outcome.legs;
      legs.forEach((leg, i) => {
        const command = entry.commands[i];
        // A relayed /doctor that never started must not hand its reply target to a later turn.
        if (leg.status !== 'ok' && leg.command === '/doctor') clearSkillRelay(dir);
        if (leg.status === 'ok' && (leg.command === '/model' || leg.command === '/effort')) {
          writeSwitchVerify(dir, { command: leg.command, arg: command?.arg ?? null, by: entry.by ?? entry.source, delivered_at: new Date().toISOString() });
        }
      });
      // A started /doctor answers the chat from its own turn.
      if (!entry.reply_to || (legs[0]?.command === '/doctor' && legs[0].status === 'ok')) return { decision: 'ok' };
      return reply(dir, replyText(entry, legs), entry.reply_to);
    }
    case 'turn-end': {
      // An interrupted turn fires no Stop or StopFailure; the mod reports its end instead.
      const input = JSON.parse(payload) as { at: number; reason: string };
      // The open operator-turn marker would otherwise hold monitor-delivered routines for its TTL.
      (await import('./lib/turn-state')).turnEnded(dir, { cause: 'interrupt', session: sessionId, at: input.at, reason: input.reason });
      return { decision: 'ok' };
    }
    default:
      return { decision: 'pass' };
  }
}

if (import.meta.main) {
  const [verb, sessionId, payload] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(await run(verb, sessionId, payload)));
  } catch (error) {
    process.stderr.write(`[harness-mod] ${error instanceof Error ? error.message : error}\n`);
    console.log(JSON.stringify({ decision: 'pass' }));
  }
}
