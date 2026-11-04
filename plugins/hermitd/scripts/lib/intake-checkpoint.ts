// Channel-intake Stop checkpoint. After thread-open succeeds, the next resident
// Stop holds once if its destination chat has no task record. Fail-open: any
// error returns null.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './cli';
import { classifyChat } from './channel-chats';
import { readConfigRaw } from './config-read';
import { readTasks } from './tasks';

export async function intakeBlockReason(dir: string, sessionId: string | null): Promise<string | null> {
  try {
    const ackPath = path.join(dir, 'state', 'intake-acks.jsonl');
    let raw = '';
    try { raw = fs.readFileSync(ackPath, 'utf8'); } catch {}
    try { fs.unlinkSync(ackPath); } catch {}
    if (!raw) return null;

    const turn = readJson(path.join(dir, 'state', 'operator-turn-open.json'));
    if (!turn || typeof turn.at !== 'string') return null;
    const turnAt = Date.parse(turn.at);
    if (!Number.isFinite(turnAt)) return null;

    const acks = raw.split('\n').flatMap(line => {
      try {
        const ack = JSON.parse(line);
        if (typeof ack?.key !== 'string') return [];
        const ackSession = typeof ack?.session_id === 'string' ? ack.session_id : null;
        if (ackSession && sessionId && ackSession !== sessionId) return [];
        const ackAt = typeof ack.at === 'string' ? Date.parse(ack.at) : NaN;
        return Number.isFinite(ackAt) && ackAt >= turnAt ? [ack] : [];
      } catch { return []; }
    });
    if (acks.length === 0) return null;

    const tasks = readTasks(dir);
    const openedThisTurn = (task: { opened_at: string }) => Date.parse(task.opened_at) >= turnAt;
    // A record resumed this turn without a conversation (e.g. opened from a
    // peer request) backs one unmatched chat: its file was rewritten this turn.
    const resumedConversationless = tasks.some(task => {
      // Closed records are immutable, so only open ones or ones closed this turn can qualify.
      if (task.conversation !== null || (task.status === 'closed' && !(Date.parse(task.closed_at ?? '') >= turnAt))) return false;
      try { return fs.statSync(path.join(dir, 'tasks', `${task.id}.md`)).mtimeMs >= turnAt; } catch { return false; }
    });
    const chats = new Map<string, { chatId: string; count: number }>();
    for (const ack of acks) {
      const previous = chats.get(ack.key);
      chats.set(ack.key, { chatId: String(ack.chat_id), count: (previous?.count ?? 0) + 1 });
    }
    const config = readConfigRaw(dir);
    const missing: string[] = [];
    for (const [key, { chatId, count }] of chats) {
      const [sourceKey, destination] = key.split(':');
      const thread = destination?.split('~')[1];
      const chatClass = await classifyChat(dir, config, sourceKey, chatId, thread);
      if (chatClass === 'shared') {
        if (tasks.filter(task => task.conversation === key && openedThisTurn(task)).length < count) missing.push(key);
      } else {
        // A thread-attribute thread's card sits in its parent chat, so only a whole-chat key can match by card.
        if (!tasks.some(task => (task.conversation === key || (!key.includes('~') && task.card_chat_id === chatId))
          && (task.status === 'open' || openedThisTurn(task)))) missing.push(key);
      }
    }
    if (missing.length > (resumedConversationless ? 1 : 0)) {
      return `task skill intake is still open. Run task.ts open now for the work you just acknowledged in ${missing.join(', ')}.`;
    }

    return null;
  } catch {
    return null;
  }
}
