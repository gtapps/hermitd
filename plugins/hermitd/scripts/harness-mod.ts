// JSON-only bridge between the Claude Code mod and core's resident-owned state.
import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readJson } from './lib/cli';
import { readRuntimeJson } from './lib/runtime';
import { clearSkillRelay, renderCommand, writeSkillRelay, writeSwitchVerify } from './lib/harness-command';
import { sendToChannel } from './lib/channel-send';
import {
  claim, enqueue, finalize, MOD_LOADED_FILE, QUEUE_PROTOCOL, readInflight, recordLegs, recover, writeModState,
  type Leg, type QueueEntry, type ReplyTarget, type Unanswered,
} from './lib/harness-mod';

// The version of the plugin copy this bridge runs from: the mod that called it lives
// in the same copy, so a reload that replaced the mod also replaced this file.
function ownVersion(): string {
  return readJson(path.join(import.meta.dir, '..', '.claude-plugin', 'plugin.json'))?.version ?? 'unknown';
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
  const runtime = readRuntimeJson(path.join(dir, 'state'));
  if (!fs.existsSync(dir) || !sessionId || runtime?.cc_session_id !== sessionId) return { decision: 'pass' };
  switch (verb) {
    case 'intake': {
      // Loaded only here: the other verbs need none of the stages.
      const { runPromptPipeline } = await import('./user-prompt-pipeline');
      const decision = await runPromptPipeline(JSON.stringify({ prompt: payload, session_id: sessionId }), true);
      if (decision.decision !== 'run') return decision;
      const queued = enqueue(dir, { source: 'chat', by: decision.by, commands: decision.commands, reply_to: decision.reply_to });
      return queued.status === 'queued'
        ? { decision: 'queued', id: queued.id }
        : { decision: 'refuse', reason: REFUSALS[queued.reason] ?? queued.reason, reply_to: decision.reply_to };
    }
    case 'loaded':
      writeModState(dir, MOD_LOADED_FILE, { session_id: sessionId, queue: QUEUE_PROTOCOL });
      return { decision: 'ok', state: path.join(dir, 'state'), session_id: sessionId };
    case 'claim': {
      const unanswered: Unanswered[] = [];
      const entry = claim(dir, sessionId, ownVersion(), { pauseOnly: payload === 'pause', unanswered });
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
      if (!input.id) return input.reply_to && input.reason ? reply(dir, input.reason, input.reply_to) : { decision: 'ok' };
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
