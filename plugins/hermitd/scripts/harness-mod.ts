// JSON-only bridge between the Claude Code mod and core's resident-owned state.
import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readRuntimeJson } from './lib/runtime';
import { applyContextReset } from './lib/context-reset';
import { clearSkillRelay, renderCommand, writeSkillRelay, writeSwitchVerify } from './lib/harness-command';
import { sendToChannel } from './lib/channel-send';
import {
  ackDeferredSwitch, MOD_LOADED_FILE, readDeferredSwitch, writeModState,
  type HarnessOutcome, type HarnessRequest, type ReplyTarget,
} from './lib/harness-mod';

export async function run(verb: string, sessionId: string, payload = ''): Promise<unknown> {
  const dir = hermitDir();
  const runtime = readRuntimeJson(path.join(dir, 'state'));
  if (!fs.existsSync(dir) || !sessionId || runtime?.cc_session_id !== sessionId) return { decision: 'pass' };
  switch (verb) {
    case 'intake': {
      // Loaded only here: claim runs after every main turn and needs none of the stages.
      const { runPromptPipeline } = await import('./user-prompt-pipeline');
      return runPromptPipeline(JSON.stringify({ prompt: payload, session_id: sessionId }), true);
    }
    case 'loaded':
      writeModState(dir, MOD_LOADED_FILE, { session_id: sessionId });
      return { decision: 'ok' };
    case 'claim': {
      if (runtime.transition || runtime.shutdown_requested_at || runtime.shutdown_completed_at) return { decision: 'pass' };
      const request = readDeferredSwitch(dir);
      return request ? { ...request, decision: 'run' } : { decision: 'pass' };
    }
    case 'ack':
      ackDeferredSwitch(dir, payload);
      return { decision: 'ok' };
    case 'relay': {
      const input = JSON.parse(payload) as HarnessRequest;
      const command = input.commands?.[0];
      if (!command || !input.reply_to || !writeSkillRelay(dir, {
        command: command.command, arg: command.arg, by: input.by, reply_to: input.reply_to, delivered_at: new Date().toISOString(),
      })) throw new Error('Skill relay marker not written');
      return { decision: 'ok' };
    }
    case 'finalize': {
      const input = JSON.parse(payload) as {
        outcomes?: HarnessOutcome[]; reason?: string; by?: string; reply_to?: ReplyTarget;
      };
      const outcomes = input.outcomes ?? [];
      // A relayed /doctor that never started must not hand its reply target to a later turn.
      if (outcomes.some(outcome => outcome.status !== 'ok' && outcome.command === '/doctor')) clearSkillRelay(dir);
      for (const outcome of outcomes) {
        if (outcome.status !== 'ok') continue;
        if (outcome.command === '/model' || outcome.command === '/effort') {
          writeSwitchVerify(dir, {
            command: outcome.command, arg: outcome.arg, by: input.by ?? 'terminal',
            delivered_at: new Date().toISOString(),
          });
        } else if (outcome.command === '/clear') {
          applyContextReset(dir, runtime, { kind: 'cleared', trigger: 'chat harness command', hhmm: new Date().toISOString().slice(11, 16) });
        }
      }
      const text = input.reason ?? outcomes.map(outcome =>
        `${renderCommand(outcome)}: ${outcome.status === 'unknown' ? 'outcome unknown (deadline reached)' : outcome.status}${outcome.text ? ` (${outcome.text})` : ''}`
      ).join('\n');
      if (!input.reply_to) return { decision: 'ok' };
      const sent = await sendToChannel(dir, text, {
        target: { id: input.reply_to.source, chat_id: input.reply_to.chat_id }, timeoutMs: 6000,
      });
      return sent.ok ? { decision: 'ok' } : { decision: 'send_failed', text, reply_to: input.reply_to };
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
