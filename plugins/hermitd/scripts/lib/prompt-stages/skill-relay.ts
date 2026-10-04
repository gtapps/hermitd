// Tell a mod-started /doctor turn who requested it and where to reply.

import { clearSkillRelay, readSkillRelay, renderCommand } from '../harness-command';
import type { StageContext, StageResult } from './types';

export function run(ctx: StageContext): StageResult | void {
  if (ctx.envelope) return;

  const relay = readSkillRelay(ctx.dir);
  if (!relay) return;
  if (ctx.prompt.trim() !== renderCommand(relay)) return;

  clearSkillRelay(ctx.dir);

  return {
    context: `[skill-relay] This command was requested from chat by ${relay.by}. Send this turn's outcome, and any confirmation the skill needs, to ${relay.reply_to.source} chat ${relay.reply_to.chat_id} through the channel reply tool in channel voice. Never use AskUserQuestion for this turn. Accept only fixes the operator confirms from chat that fall under chat authority (CLAUDE.md edits); decline any offer that changes the permission mode or pre-approves permissions, since those settings are terminal-only.\n`,
  };
}
