import { threadRecords } from '../tasks';
import { resolveSlashCommand } from '../channel-slash-address';
import { channelBotIdentity, isAllowedSender, isSelfMentioned } from '../channel-auth';
import { cachedChat } from '../channel-chats';
import { safeForLLM } from '../sanitize';
import { capture } from './channel-reply-reminder';
import type { StageContext, StageResult } from './types';

// An assignment on a Discord guild channel (type 0 or 5) gets its own thread, and the
// record's conversation key is that thread. A message in the parent channel therefore
// belongs to no task thread, whatever record the channel's key might match.
const inThreadChat = (ctx: StageContext, sourceKey: string, chatId: string) =>
  sourceKey !== 'discord' || ![0, 5].includes(cachedChat(ctx.dir, chatId)?.type ?? -1);

export async function run(ctx: StageContext): Promise<StageResult | void> {
  const env = ctx.envelope;
  if (!env || !isAllowedSender(ctx.config(), env.source, env.userId)) return;
  const key = `${env.sourceKey}:${env.chatId}`;
  const addressed = resolveSlashCommand(env.body, channelBotIdentity(ctx.config(), env.source));
  const name = addressed?.command.slice(1);
  const args = addressed?.rest.trim() ?? '';
  const conversationCommand = !!name && ['help', 'mute', 'unmute', 'restart'].includes(name) && !args;
  // Harness commands sent into a worker-owned thread belong to the thread, not the
  // session: `!clear` restarts the worker and the rest are refused here, before the
  // harness-command stage could record them for the resident. A resident-owned thread
  // takes them as ordinary session commands, like any other chat.
  const harnessCommand = !!name && ['clear', 'compact', 'model', 'effort', 'advisor', 'permission-mode'].includes(name);
  const record = inThreadChat(ctx, env.sourceKey, env.chatId)
    ? threadRecords(ctx.dir).find(task => task.conversation === key)
    : undefined;
  if (!record) {
    // `!help` is answerable anywhere, so it gets its annotation rather than the
    // "needs a thread" refusal — without one the model has nothing to act on.
    if (conversationCommand) {
      return { context: name === 'help' ? '[conversation command: help]' : '[conversation command outside a task thread]' };
    }
    return;
  }
  ctx.conversation = { key, task_id: record.id, owner: record.owner };
  const owner = record.owner === 'resident' ? 'resident' : record.owner.startsWith('helper:') ? 'helper' : 'worker';
  let context = `[task thread ${safeForLLM(key)}: owner=${owner}, muted=${record.muted}, waiting=${record.waiting_on !== null}]`;
  if (owner !== 'worker' && record.waiting_on !== null) {
    // `note --done` clears result/result_at without clearing waiting_on, so a
    // record can be waiting with neither a stall nor a result to quote.
    const latestIsStall = record.stall_at !== null && (!record.result_at || Date.parse(record.stall_at) > Date.parse(record.result_at));
    const reason = latestIsStall
      ? `${safeForLLM(record.stall_status).slice(0, 160)}; next: ${safeForLLM(record.stall_next).slice(0, 160)}`
      : record.result
        ? `awaiting confirmation of result_rev=${record.result_rev}: ${safeForLLM(record.result).slice(0, 160)}`
        : `waiting on ${safeForLLM(record.waiting_on).slice(0, 160)}`;
    const taskCommand = '.hermit/bin/hermitd-run task';
    const target = `.hermit ${record.id}`;
    // An envelope carrying more than one user_id resolves to a null userId, and an
    // install with no allowed_users still admits it, leaving no identity to close under.
    const actor = env.userId === null ? null : safeForLLM(`${env.sourceKey}:${env.userId}`).slice(0, 160);
    const confirmed = actor ? `; operator confirmed: ${taskCommand} close ${target} --by confirmed --actor ${actor} --result-rev ${record.result_rev} --reason-stdin` : '';
    context += `\n[waiting task ${record.id}: ${reason}; finished outcome: ${taskCommand} block ${target} --result-stdin; wait answered: ${taskCommand} note ${target} --clear-waiting${confirmed}; nothing is owed when this message does not change the task]`;
  }
  if (harnessCommand && owner !== 'resident') {
    ctx.skipHarnessCommand = true;
    if (name === 'clear') return { context: `${context}\n[conversation command: restart]` };
    const reason = name === 'model' || name === 'effort' ? 'per-conversation model/effort not supported' : `!${name} does not reach the resident from a task thread`;
    return { context: `${context}\n[conversation command refused: ${reason}]` };
  }
  if (conversationCommand) return { context: `${context}\n[conversation command: ${name}]` };
  // Mute silences ordinary steering, not an addressed command: pause/resume/snooze
  // and status are documented as always reachable from chat, and blocking here
  // settles the disposition before their stages ever run.
  if (record.muted && !addressed && !await isSelfMentioned(ctx.dir, ctx.config(), env.sourceKey, env.chatId, env.body)) {
    capture(ctx, env, true);
    return { block: 'muted conversation: recorded' };
  }
  return { context };
}
