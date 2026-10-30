import fs from 'node:fs';
import path from 'node:path';
import { firstChatPath } from '../first-chat';
import { isPaused } from '../pause';
import type { StageContext } from './types';

export function firstChatContext(ctx: StageContext, operatorActivityKept: boolean): string | null {
  // Existing installations pay only this stat and receive no new instructions.
  if (!fs.existsSync(firstChatPath(ctx.dir))) return null;
  if (!operatorActivityKept || isPaused(ctx.dir).paused) return null;
  const env = ctx.envelope;
  if (env) {
    const home = ctx.config()?.channels?.[env.sourceKey]?.default_chat_id;
    if (home && home !== env.chatId) return null;
  }
  const root = path.resolve(import.meta.dir, '../../..');
  return fs.readFileSync(path.join(root, 'prompts/first-chat.md'), 'utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
}
