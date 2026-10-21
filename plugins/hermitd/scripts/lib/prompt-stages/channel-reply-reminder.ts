// UserPromptSubmit stage — when the inbound prompt starts with a <channel>
// envelope, injects an additionalContext reminder naming the exact reply tool
// and chat_id. Operators on Discord/Telegram read the channel, not the
// transcript; this reminder fires right before the model's next turn.
//
// Also captures the inbound message into the episodic channel log (PROP-010)
// — see scripts/lib/channel-log.ts. Capture is best-effort and strictly
// secondary to the reminder: it runs after the reminder is composed, in its
// own try/catch, and a logging failure never affects the reminder.

import { safeForLLM, safeForLLMMultiline } from '../sanitize';
import { logMessage, isLoggingEnabled, unaddressedSince, conversationHistory } from '../channel-log';
import path from 'node:path';
import { readJson } from '../cli';
import { isPaused } from '../pause';
import { isAllowedSender, allowedUserIds, channelBotIdentity, chatInstructions, isPassiveChat, isSelfMentioned } from '../channel-auth';
import { escapeRegExp } from '../md-write';
import type { ChannelEnvelope, StageContext, StageResult } from './types';

// Known channel sources → exact MCP reply tool name.
// Unknown sources fall back to a generic phrase so future channel plugins
// still benefit from the reminder without a code change.
const REPLY_TOOLS: Record<string, string> = {
  discord: 'mcp__plugin_discord_discord__reply',
  telegram: 'mcp__plugin_telegram_telegram__reply',
  imessage: 'mcp__plugin_imessage_imessage__reply',
};

const MAX_SOURCE_LEN = 32;
const MAX_CHAT_ID_LEN = 128;
const MAX_BOT_REF_LEN = 64;
// Last-reply alone would drag in days-old rows when the hermit has been quiet
// in that chat; this cap is a constant, not a config key.
const UNADDRESSED_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const UNADDRESSED_TEXT_CAP = 1000;

// Self-mention identity — captured at pairing by scripts/channel-bot-id.ts.
// A mention-gated channel guarantees the inbound message mentions the bot, but
// the envelope names only the *sender*, so a hermit reading `<@its-own-id>` can
// conclude the request is addressed to somebody else and drop it silently.
//
// The clause renders only when the body actually carries the id (Discord) or
// `@username` (Telegram, whose mentions never use the numeric id): on every
// other message the reminder stays byte-identical to its pre-identity form, so
// an always-on hermit pays nothing per message for a capability it needs only
// when it is mentioned.
// Wording only; passive wake decisions use isSelfMentioned in channel-auth.ts.
function selfMentionClause(ctx: StageContext, envelope: ChannelEnvelope): string {
  const { userId: id, username } = channelBotIdentity(ctx.config(), envelope.source);

  let matched: string | null = null;
  // Digit-delimited, not a bare substring: a platform id is a long digit run, so
  // an unanchored `includes` also fires on any longer number that happens to
  // contain it (a 13-digit epoch ms, an order number), which would tell the
  // model a third party's message is addressed to it.
  if (id && new RegExp(`(?<!\\d)${escapeRegExp(id)}(?!\\d)`).test(envelope.body)) matched = id;
  else if (username && envelope.body.toLowerCase().includes(`@${username.toLowerCase()}`)) {
    matched = `@${username}`;
  }
  if (!matched) return '';

  const ref = safeForLLM(matched.slice(0, MAX_BOT_REF_LEN));
  return ` This message mentions \`${ref}\` — that is your own account on this channel,` +
    ` so the mention is addressed to you, not to a third party.`;
}

// Episodic capture — best-effort, never affects the reminder. Its guards are
// early returns from this helper, so none of them can swallow the reminder the
// caller is about to return.
export function capture(ctx: StageContext, envelope: ChannelEnvelope, passive: boolean): void {
  if (!envelope.body) return;

  const dir = ctx.dir;
  const config = ctx.config();
  if (!isLoggingEnabled(config, envelope.source)) return;

  // Raw source (not sourceKey): channelEntry normalizes it internally, and
  // pause-keyword.ts and channel-status-responder.ts feed the same raw source
  // into this gate — one convention across every caller.
  if (!passive && !isAllowedSender(config, envelope.source, envelope.userId)) return;

  const result = logMessage(dir, {
    source: envelope.sourceKey,
    chat_id: envelope.chatId,
    direction: 'in',
    sender: envelope.userName ?? envelope.userId,
    sender_id: envelope.userId,
    message_id: envelope.messageId,
    text: envelope.body,
    ts: envelope.ts ?? undefined,
  });
  if (!result.ok) {
    process.stderr.write(`[channel-log] inbound capture failed: ${result.error}\n`);
  }
}

export async function run(ctx: StageContext): Promise<StageResult | void> {
  const envelope = ctx.envelope;
  if (!envelope) return;

  const passive = await isPassiveChat(ctx.dir, ctx.config(), envelope.sourceKey, envelope.chatId);
  const sourceKey = envelope.sourceKey;
  const chatIdRaw = envelope.chatId;

  const source = safeForLLM(sourceKey.slice(0, MAX_SOURCE_LEN));
  const chatId = safeForLLM(chatIdRaw.slice(0, MAX_CHAT_ID_LEN));

  const tool = REPLY_TOOLS[source];
  const toolLine = tool
    ? `\`${tool}\` with chat_id="${chatId}"`
    : `the channel's \`reply\` tool with chat_id="${chatId}"`;

  let reminder =
    `[channel reply reminder] Inbound message arrived on the \`${source || 'unknown'}\` channel` +
    ` (chat_id=\`${chatId}\`). Every reply, including a short acknowledgement, must go through ${toolLine}.` +
    ` Transcript/terminal output does not reach the operator.` +
    selfMentionClause(ctx, envelope) + '\n';

  const addressed = passive
    && isAllowedSender(ctx.config(), envelope.source, envelope.userId)
    && await isSelfMentioned(ctx.dir, ctx.config(), sourceKey, chatIdRaw, envelope.body, envelope);

  const admittedConversation = !!(ctx.conversation || ctx.closedThread)
    && isAllowedSender(ctx.config(), envelope.source, envelope.userId);
  const willBlock = passive && !addressed && !admittedConversation;
  if (!willBlock && isAllowedSender(ctx.config(), envelope.source, envelope.userId)) {
    const instructions = await chatInstructions(ctx.dir, ctx.config(), sourceKey, chatIdRaw);
    if (instructions) reminder += `[chat instructions] ${safeForLLMMultiline(instructions.text).slice(0, 2000)}\n`;
  }
  let resetHistory = false;
  if (!willBlock && isAllowedSender(ctx.config(), envelope.source, envelope.userId)
    && isLoggingEnabled(ctx.config(), envelope.source)) {
    // The replayed reply is at most six hours old and predates the reset, so an
    // older reset can never qualify and skips the log query.
    const resetAt = Date.parse(ctx.runtime()?.last_context_reset_at ?? '');
    if (Number.isFinite(resetAt) && resetAt >= Date.now() - UNADDRESSED_MAX_AGE_MS) {
      const rows = conversationHistory(ctx.dir, sourceKey, chatIdRaw, { limit: 8, senderIds: allowedUserIds(ctx.config(), envelope.source) })
        .filter(row => Date.parse(row.ts) >= Date.now() - UNADDRESSED_MAX_AGE_MS);
      const lastReply = rows.findLast(row => row.direction === 'out');
      if (lastReply && Date.parse(lastReply.ts) < resetAt) {
        resetHistory = true;
        reminder += 'Recent messages in this chat (context was reset):\n';
        for (const row of rows) {
          const sender = row.direction === 'out' ? 'you (hermit)' : row.sender ?? '';
          reminder += `${safeForLLM(sender)} ${safeForLLM(row.ts)} ${safeForLLM(row.text).slice(0, UNADDRESSED_TEXT_CAP)}\n`;
        }
      }
    }
  }

  if (!resetHistory && addressed && isLoggingEnabled(ctx.config(), envelope.source)) {
    // inbound ts is the platform's timestamp while outbound ts is the host clock,
    // so a skewed host clock shifts the window by the skew.
    const notBeforeIso = new Date(Date.now() - UNADDRESSED_MAX_AGE_MS).toISOString();
    const rows = unaddressedSince(ctx.dir, envelope.sourceKey, envelope.chatId, {
      notBeforeIso,
      senderIds: allowedUserIds(ctx.config(), envelope.source),
    });
    if (rows.length) {
      reminder += 'Earlier messages in this chat since your last recorded reply:\n';
      for (const row of rows) {
        reminder += `${safeForLLM(row.sender ?? '')} ${row.ts} ${safeForLLM(row.text).slice(0, UNADDRESSED_TEXT_CAP)}\n`;
      }
    }
  }

  try {
    capture(ctx, envelope, passive);
  } catch (e: any) {
    process.stderr.write(`[channel-log] inbound capture failed: ${e?.message || e}\n`);
  }

  if (willBlock) {
    return { block: 'passive chat: recorded, not addressed' };
  }

  return { context: reminder };
}

// Control stages must settle before asking for a Skill tool call.
export function invokeResponder(ctx: StageContext): StageResult | void {
  if (!ctx.envelope || ctx.suppressResponderInvoke) return;
  // pause-gate.ts denies every tool but the channel reply tool, so while the
  // hermit is paused a Skill call can only be refused. A refused call leaves no
  // PostToolUse record, so the request would repeat on every message for the
  // whole pause window.
  if (isPaused(ctx.dir).paused) return;
  const record = readJson(path.join(ctx.dir, 'state', 'channel-responder-invoked.json'));
  const sameSession = typeof ctx.sessionId === 'string' && !!ctx.sessionId
    && record?.session_id === ctx.sessionId;
  const invokedAt = typeof record?.at === 'string' ? Date.parse(record.at) : NaN;
  const runtime = ctx.runtime();
  const resetAt = typeof runtime?.last_context_reset_at === 'string'
    ? Date.parse(runtime.last_context_reset_at) : NaN;
  if (sameSession && Number.isFinite(invokedAt)
    && (!Number.isFinite(resetAt) || invokedAt >= resetAt)) return;
  return { context: 'Handle it with the channel-responder skill: invoke `/hermitd:channel-responder` now; no invocation has been observed in this session since the last context reset.' };
}
