// Channel-reply Stop checkpoint. A resident Stop on a turn whose opening
// prompt is a <channel> envelope, with no channel tool call this turn, holds
// once so the operator is not left with silence. Fail-open: any error returns null.
import { isAllowedSender } from './channel-auth';
import { conversationKey } from './conversation-key';
import { parseChannelEnvelope } from './channel-envelope';
import { readConfigRaw } from './config-read';
import { threadRecords } from './tasks';
import { readTailLines, toolUseNames, transcriptPath, turnPromptText } from './cc-compat';
import fs from 'node:fs';
import path from 'node:path';

type Json = any;

const TAIL_BYTES = 512 * 1024;
// Channel tools that only read, so calling one sends the operator nothing.
const READ_ONLY_TOOL_RE = /(download_attachment|fetch_messages)$/;

export function replyBlockReason(dir: string, payload: Json): string | null {
  try {
    const tPath = transcriptPath(payload);
    if (!tPath) return null;

    const { lines } = readTailLines(tPath, TAIL_BYTES);
    const prompt = turnPromptText(lines, lines.length);
    if (!prompt.boundaryFound) return null;

    const config = readConfigRaw(dir);
    const env = parseChannelEnvelope(prompt.text, config);
    if (!env) return null;

    if (!isAllowedSender(config, env.source, env.userId)) return null;
    const key = conversationKey(env.sourceKey, env.chatId, env.thread);
    // A worker-owned thread ends its turn on a SendMessage to the worker, so no
    // reply is owed there; a resident-owned thread still owes one like any chat.
    if (threadRecords(dir).some(task => task.conversation === key && task.owner !== 'resident')) return null;

    for (let i = prompt.index + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let entry: Json;
      try { entry = JSON.parse(line); } catch { continue; }
      if (toolUseNames(entry).some(t => t.name.includes(env.sourceKey) && !READ_ONLY_TOOL_RE.test(t.name))) return null;
    }

    // The transcript read can miss a reply already sent; the reply hook's stamp cannot.
    const openedAt = JSON.parse(lines[prompt.index]).timestamp;
    let lastReplyAt: unknown = null;
    try {
      lastReplyAt = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'channel-activity.json'), 'utf8'))?.[env.sourceKey]?.last_reply_at;
    } catch {} // no stamp yet: the transcript verdict stands
    if (typeof openedAt === 'string' && typeof lastReplyAt === 'string' && lastReplyAt >= openedAt) return null;

    return `channel-responder reply is still owed. This turn opened on a ${env.sourceKey} message (chat_id=${env.chatId}) and nothing was sent through the channel reply tool, so the operator has seen nothing. Send the reply now, or end the turn if this message needs none.`;
  } catch {
    return null;
  }
}
