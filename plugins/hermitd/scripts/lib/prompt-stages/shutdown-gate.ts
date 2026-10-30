// UserPromptSubmit stage — deterministic shutdown gate.
//
// While a shutdown is pending (runtime.json has shutdown_requested_at set and
// shutdown_completed_at null), a <channel> message from an allowed sender gets a
// deterministic "shutting down" reply and is blocked from reaching the model, so
// the hermit stops accepting new work the instant a stop is in flight (the
// incident: the model kept taking channel tasks after acknowledging shutdown).
//
// Send-then-block, mirroring channel-status-responder: only emit
// {"decision":"block"} after a confirmed successful send, so a failed send never
// silently swallows the operator's message — it falls through with a narrow relay
// instruction instead. Non-channel prompts (operator terminal input, the internal
// configured shutdown skill hermitd-stop injects) are never a channel envelope and
// pass through untouched.

import { isAllowedSender } from '../channel-auth';
import { sendToChannel } from '../channel-send';
import { loadMessages } from '../messages';
import type { StageContext, StageResult } from './types';

export async function run(ctx: StageContext): Promise<StageResult | void> {
  const envelope = ctx.envelope;
  if (!envelope) return; // not a channel message — operator/internal input passes

  const dir = ctx.dir;

  // Only gate a shutdown that is genuinely pending — check this before loading
  // config, since "no shutdown in flight" is the common case on every channel
  // message and this avoids a wasted config.json read for it.
  const runtime = ctx.runtime();
  const pending = !!runtime && !!runtime.shutdown_requested_at && !runtime.shutdown_completed_at;
  if (!pending) return;

  const config = ctx.config();
  if (!config) return;

  // Same allowed_users gating as the status responder — a sender the channel
  // wouldn't act on anyway needs no reply or block.
  if (!isAllowedSender(config, envelope.source, envelope.userId)) return;

  const reply = loadMessages(dir, config?.language).t('shutdown_in_progress');
  const thread = envelope.thread === null ? {} : { thread: envelope.thread };
  if (ctx.harnessMode) return { harness: {
    decision: 'refuse', reason: reply,
    reply_to: { source: envelope.sourceKey, chat_id: envelope.chatId, ...thread },
  } };
  const result = await sendToChannel(dir, reply, {
    target: { id: envelope.sourceKey, chat_id: envelope.chatId, ...thread },
    timeoutMs: 6000,
    config, // already loaded by the pipeline — don't make the sender re-read it
  });
  if (result.ok) {
    return { block: 'shutdown pending — deterministic reply sent' };
  }

  // Deterministic delivery failed — don't block into silence. Inject a narrow
  // instruction so the model relays the shutdown state and starts no new work.
  return {
    context:
      `[shutdown] A shutdown is in progress for this hermit. Reply to the operator (on the chat this ` +
      `message arrived on) that you're shutting down and will be back after the restart, then stop — ` +
      `start no new work.\n`,
  };
}
