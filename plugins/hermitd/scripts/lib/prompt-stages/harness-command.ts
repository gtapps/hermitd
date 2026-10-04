// Prompt admission for native mod commands and the remaining Stop-hook command.

import { safeForLLM } from '../sanitize';
import { senderLabel } from '../channel-envelope';
import { isTrustedController, channelBotIdentity } from '../channel-auth';
import { parseHarnessCommand, writePendingCommand, renderCommand, permissionModeRefusal } from '../harness-command';
import { resolveSlashCommand } from '../channel-slash-address';
import type { StageContext, StageResult } from './types';

export function resolveCommand(ctx: StageContext) {
  const env = ctx.envelope;
  if (!env?.body) return null;
  const addressed = resolveSlashCommand(env.body, channelBotIdentity(ctx.config(), env.source));
  return addressed ? parseHarnessCommand(`${addressed.command}${addressed.rest}`) : null;
}

export function run(ctx: StageContext): StageResult | void {
  const env = ctx.envelope;
  const parsed = resolveCommand(ctx);
  if (!env || !parsed) return;
  const dir = ctx.dir;
  const config = ctx.config();

  const authorized = isTrustedController(config, env.source, env.userId, env.chatId);
  if (!authorized) return; // unauthorized — silent no-op

  if (ctx.harnessMode) {
    const reply_to = { source: env.sourceKey, chat_id: env.chatId };
    // A recovery restart or reset is mid-flight; a command now would race it.
    if (ctx.runtime()?.transition) {
      return { harness: { decision: 'refuse', reason: 'A restart or context reset is in progress. Resend the command once it finishes.', reply_to } };
    }
    return { harness: {
      decision: 'run', commands: [parsed], dir, reply_to,
      by: safeForLLM(senderLabel(env).slice(0, 64)),
    } };
  }

  if (parsed.command !== '/permission-mode') return;

  // Interactive sessions store tmux_session: null (hermitd-start.ts), so there is no pane
  // to deliver into. Refuse HERE rather than recording a marker the drain could never
  // consume — otherwise the operator gets an acknowledgement for a command that silently
  // never happens.
  const runtime = ctx.runtime();
  if (!runtime || runtime.runtime_mode === 'interactive' || !runtime.tmux_session) return;

  // Refuse an unsettable permission mode HERE, for the same reason the interactive check
  // above refuses: recording a marker the drain will not act on would acknowledge a switch
  // that never happens. Unlike an unauthorized sender this is not silent — the request was
  // legitimate, so the operator gets told why it is being declined.
  if (parsed.command === '/permission-mode' && parsed.arg) {
    const refusal = permissionModeRefusal(parsed.arg);
    if (refusal) {
      return {
        context: `[harness-command] refused "${renderCommand(parsed)}": ${refusal}\n`,
      };
    }
  }

  const by = safeForLLM(senderLabel(env).slice(0, 64));
  const ok = writePendingCommand(dir, {
    command: parsed.command,
    arg: parsed.arg,
    by,
    requested_at: new Date().toISOString(),
  });
  if (!ok) return;

  ctx.suppressResponderInvoke = true;
  const rendered = renderCommand(parsed);
  return {
    context: `[harness-command] "${rendered}" requested by ${by} — will be applied to this session when the current turn ends. End the turn with no tool call and no reply.\n`,
  };
}
