import fs from 'node:fs';
import path from 'node:path';
import type { StageContext, StageResult } from './types';

export function run(ctx: StageContext): StageResult | void {
  const marker = path.join(ctx.dir, 'state', 'first-chat-pending.json');
  if (!fs.existsSync(marker)) return;
  // Only the always-on resident claims it: the hatch session that wrote the marker is no guest.
  if (!ctx.sessionId || ctx.runtime()?.cc_session_id !== ctx.sessionId) return;
  try {
    const text = (ctx.envelope?.body ?? ctx.prompt).trim();
    if (!text || text.startsWith('/') || text.startsWith('!')) return;
    if (ctx.envelope) {
      const pending = JSON.parse(fs.readFileSync(marker, 'utf8'));
      const env = ctx.envelope;
      if (!Array.isArray(pending.private_chats) || !pending.private_chats.some((chat: any) =>
        chat.channel === env.sourceKey && chat.chat_id === env.chatId && chat.sender_id === env.userId)) return;
    }
    const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '../../..');
    const context = fs.readFileSync(path.join(root, 'prompts', 'first-chat.md'), 'utf8');
    // Synchronous unlink is the claim: only one competing caller can emit.
    fs.unlinkSync(marker);
    return { context };
  } catch {
    // Missing prompt, malformed evidence, or a lost claim leaves this turn alone.
  }
}
