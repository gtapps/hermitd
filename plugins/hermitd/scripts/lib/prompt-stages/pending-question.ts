// Names the questions pending in the inbound message's chat, so a bare yes or no
// after a restart or /clear reaches its question instead of "nothing open here".
// Interim until pending questions become task waits: the `[waiting task]` line in
// conversation.ts then carries them, and this stage goes.
import path from 'node:path';
import { isAllowedSender } from '../channel-auth';
import { conversationKey } from '../conversation-key';
import { readMicroProposals } from '../micro-proposals-io';
import { pendingInChat } from '../proposals/micro';
import { safeForLLM } from '../sanitize';
import type { StageContext, StageResult } from './types';

type Json = any;

const SHOWN = 3;

/**
 * The pending-question line for `chatKey` (`<sourceKey>:<chat_id>`), or null when none
 * is pending. Shares match's chat filter, so the line never names a question match cannot find.
 */
export function pendingQuestionLine(dir: string, chatKey: string): string | null {
  const read = readMicroProposals(path.join(dir, 'state', 'micro-proposals.json'));
  // Omitting the line on a corrupt file would imply an empty queue (#764).
  if (read.status === 'corrupt') return '[pending question in this chat: unreadable]';
  if (read.status === 'missing') return null;
  const pending = read.data.pending.filter((entry: Json) => pendingInChat(entry, chatKey));
  if (!pending.length) return null;
  const ids = pending.slice(0, SHOWN).map((entry: Json) => safeForLLM(String(entry.id ?? '?')).slice(0, 40));
  const more = pending.length > ids.length ? ` (+${pending.length - ids.length} more)` : '';
  return `[pending question in this chat: ${ids.join(', ')}${more}; a bare reply may answer it: run proposal-micro match first]`;
}

export function run(ctx: StageContext): StageResult | void {
  const env = ctx.envelope;
  if (ctx.harnessMode || !env || !isAllowedSender(ctx.config(), env.source, env.userId)) return;
  const line = pendingQuestionLine(ctx.dir, conversationKey(env.sourceKey, env.chatId));
  return line ? { context: line } : undefined;
}
