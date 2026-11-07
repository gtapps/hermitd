import { conversationKey } from '../conversation-key';
import { conversationRecords, agentQuestion, decodeDecision, latestWaitIsStall, readTasks, threadRecords, taskListing, type Task } from '../tasks';
import { resolveSlashCommand } from '../channel-slash-address';
import { channelBotIdentity, isAllowedSender, isPrimaryOperator, isSelfMentioned } from '../channel-auth';
import { classifyChat } from '../channel-chats';
import { safeForLLM } from '../sanitize';
import { capture } from './channel-reply-reminder';
import { EFFORT, HELPER_MODEL } from '../settings/enums';
import type { StageContext, StageResult } from './types';

export async function run(ctx: StageContext): Promise<StageResult | void> {
  const env = ctx.envelope;
  if (!env || !isAllowedSender(ctx.config(), env.source, env.userId)) return;
  const key = conversationKey(env.sourceKey, env.chatId, env.thread);
  const addressed = resolveSlashCommand(env.body, channelBotIdentity(ctx.config(), env.source));
  const name = addressed?.command.slice(1);
  const args = addressed?.rest.trim() ?? '';
  const conversationCommand = !!name && ['help', 'mute', 'unmute', 'restart'].includes(name) && !args;
  // Harness commands sent into a worker-owned thread belong to the thread, not the
  // session: `!clear` restarts the worker and the rest are refused here, before the
  // harness-command stage could record them for the resident. A resident-owned thread
  // takes them as ordinary session commands, like any other chat.
  const harnessCommand = !!name && ['clear', 'compact', 'model', 'effort', 'advisor', 'permission-mode'].includes(name);
  const chatType = await classifyChat(ctx.dir, ctx.config(), env.sourceKey, env.chatId, env.thread);
  const inThread = chatType === 'thread';
  const sharedRestart = chatType === 'shared' && name === 'restart';
  // A command outside a task thread only adds the open-tasks line, so an unreadable
  // task file cannot cost it its annotation.
  let records: Task[] = [];
  try { records = threadRecords(ctx.dir); } catch (error) { if (inThread || (!conversationCommand && !sharedRestart)) throw error; }
  const inThreadRecords = inThread ? records.filter(task => task.conversation === key) : [];
  const work = inThreadRecords.filter(task => !agentQuestion(task));
  const questions = inThreadRecords.filter(agentQuestion);
  if (work.length > 1) return { context: `[task thread ${safeForLLM(key)}: open tasks ${work.map(task => task.handle).join(' ')}; ask which one]` };
  const record = work[0] ?? (questions.length === 1 ? questions[0] : undefined);
  if (!record) {
    // Only a task's own thread stays addressed after it closes; a DM or group chat
    // that carried a record returns to its ordinary rules.
    const closed = inThread
      ? conversationRecords(ctx.dir).filter(task => task.status === 'closed' && task.conversation === key)
        .sort((a, b) => a.closed_at!.localeCompare(b.closed_at!) || a.id.localeCompare(b.id)).at(-1)
      : undefined;
    if (closed) {
      ctx.closedThread = true;
      if (conversationCommand && (name === 'mute' || name === 'unmute')) {
        return { context: `[closed task thread ${safeForLLM(key)}: task=${closed.id}, muted=${closed.muted}]\n[conversation command: ${name}]` };
      }
      if (closed.muted && !addressed && !await isSelfMentioned(ctx.dir, ctx.config(), env.sourceKey, env.chatId, env.body, env)) {
        capture(ctx, env, true);
        return { block: 'muted conversation: recorded' };
      }
    }
    // `!help` is answerable anywhere, so it gets its annotation rather than the
    // "needs a thread" refusal — without one the model has nothing to act on.
    const lines: string[] = [];
    if (!inThread) {
      // Records sort oldest first; list the newest five.
      const inChat = records.filter(task => task.conversation === key).reverse();
      if (sharedRestart && inChat.length) {
        const target = args ? inChat.find(task => task.handle === args.toLowerCase()) : inChat.length === 1 ? inChat[0] : undefined;
        return { context: target
          ? `[conversation command: restart task=${target.id}]`
          : `[conversation command: restart needs a handle: ${inChat.map(task => task.handle).join(' ')}]` };
      }
      const people = inChat.filter(row => row.kind !== 'proposal');
      const proposalCount = inChat.length - people.length;
      const answerHint = `answer with .hermit/bin/hermitd-run task answer .hermit --chat ${safeForLLM(key)} --user ${safeForLLM(env.userId ?? '<user>')} --reply <token>`;
      // A primary sender also decides admin questions with no chat, counted as `!status` counts them.
      if (isPrimaryOperator(ctx.config(), env.source, env.userId, env.chatId)) {
        let admin = 0;
        try {
          admin = readTasks(ctx.dir).filter(task => task.status === 'open' && task.waiting_on !== null && task.decision !== null
            && (task.conversation === key || task.conversation === null) && decodeDecision(task.decision).authority === 'admin').length;
        } catch { /* an unreadable record costs only this count */ }
        if (admin) lines.push(`[admin decisions waiting on you: ${admin}; ${answerHint}]`);
      } else if (proposalCount) lines.push(`[agent proposal waits in this chat: ${proposalCount}; ${answerHint}]`);
      const rows = people.slice(0, 5);
      if (people.length) {
        ctx.openTasksInChat = true;
        lines.push(`[open tasks in this chat: total=${people.length} omitted=${people.length - rows.length}; ${rows.map(row => `${row.handle} ${row.id} ${JSON.stringify(safeForLLM(row.title).slice(0, 80))} owner=${row.owner.split(':')[0]} state=${safeForLLM(taskListing(row, records).join(', '))}`).join('; ')}] a message continuing one of these steers it; new work opens its own task; if unsure which, ask once naming them.`);
        const waiting = rows.filter(row => row.waiting_on !== null);
        if (waiting.length) {
          const actor = env.userId === null ? null : safeForLLM(`${env.sourceKey}:${env.userId}`).slice(0, 160);
          // Only a posted result is confirmed by close; a result-less wait is a question to answer.
          const confirmed = actor && waiting.some(row => row.result)
            ? '; operator confirmed a row with result_rev: .hermit/bin/hermitd-run task close .hermit <id> --by confirmed --actor <actor> --chat <chat> --user <user> --result-rev <result_rev> --reason-stdin' : '';
          lines.push(`[waiting task ${waiting.map(row => `${row.id}${row.result ? ` result_rev=${row.result_rev}` : ''}${row.last_worker ? ` last_worker=${row.last_worker}` : ''}${actor ? ` actor=${actor}` : ''}`).join('; ')}; commands (use the row's id, revision and actor): .hermit/bin/hermitd-run task block .hermit <id> --result-stdin; wait answered: .hermit/bin/hermitd-run task answer .hermit <id> --chat <chat> --user <user> --reply <token>; legacy wait: .hermit/bin/hermitd-run task note .hermit <id> --clear-waiting --chat <chat> --user <user>${confirmed}; nothing is owed when this message does not change the task]`);
        }
      }
    }
    if (conversationCommand || sharedRestart) {
      lines.push(name === 'help' ? '[conversation command: help]' : '[conversation command outside a task thread]');
      return { context: lines.join('\n') };
    }
    // A message outside any task thread may continue work the sender's spawned
    // session already holds, so name those tasks for the responder to route to.
    if (env.userId === null) return lines.length ? { context: lines.join('\n') } : undefined;
    const requester = `${env.sourceKey}:${env.userId}`;
    // Records sort oldest first; keep the newest, the likeliest to be continued.
    const bound = records.filter(task => task.owner.startsWith('helper:') && task.requester === requester).slice(-5);
    if (bound.length) lines.push(`[bound tasks: ${bound.map(task => `${task.id} ${JSON.stringify(safeForLLM(task.title).slice(0, 80))}`).join('; ')}]`);
    return lines.length ? { context: lines.join('\n') } : undefined;
  }
  ctx.conversation = { key, task_id: record.id, owner: record.owner };
  const owner = record.owner === 'resident' ? 'resident' : record.owner.startsWith('helper:') ? 'helper' : 'worker';
  let context = `[task thread ${safeForLLM(key)}: owner=${owner}, muted=${record.muted}, waiting=${record.waiting_on !== null}]`;
  if (work.length && questions.length) context += `\n[agent questions waiting in this thread: ${questions.length}; answer with .hermit/bin/hermitd-run task answer .hermit --chat ${safeForLLM(key)} --user ${safeForLLM(env.userId ?? '<user>')} --reply <token>]`;
  if (record.kind === 'proposal') context += `\n[agent proposal waits: 1; answer with .hermit/bin/hermitd-run task answer .hermit --chat ${safeForLLM(key)} --user ${safeForLLM(env.userId ?? '<user>')} --reply <token>]`;
  if (record.kind !== 'proposal' && owner !== 'worker' && record.waiting_on !== null) {
    // `note --done` clears result/result_at without clearing waiting_on, so a
    // record can be waiting with neither a stall nor a result to quote.
    const latestIsStall = latestWaitIsStall(record);
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
    const confirmed = !actor ? '' : record.result
      ? `; operator confirmed: ${taskCommand} close ${target} --by confirmed --actor ${actor} --chat ${safeForLLM(key)} --user ${safeForLLM(env.userId ?? '<user>')} --result-rev ${record.result_rev} --reason-stdin`
      : `; requester explicitly says the work is done: ${taskCommand} close ${target} --by confirmed --actor ${actor} --chat ${safeForLLM(key)} --user ${safeForLLM(env.userId ?? '<user>')} --reason-stdin`;
    // A named approver confirms in words, so only an approver-free result can finish by a check.
    const finishing = record.result && !latestIsStall && !record.approver && !record.check
      ? `; approved, outcome pending a command can observe: add --check '<command>' [--due <iso>] to the --clear-waiting note`
      : '';
    context += `\n[waiting task ${record.id}: ${reason}${record.last_worker ? '; last_worker=' + record.last_worker : ''}; finished outcome: ${taskCommand} block ${target} --result-stdin; wait answered: ${taskCommand} answer ${target} --chat ${safeForLLM(key)} --user ${safeForLLM(env.userId ?? '<user>')} --reply <token>; legacy wait: ${taskCommand} note ${target} --clear-waiting --chat <chat> --user <user>${confirmed}${finishing}; nothing is owed when this message does not change the task]`;
  }
  if (harnessCommand && owner !== 'resident') {
    ctx.skipHarnessCommand = true;
    if (name === 'clear') return { context: `${context}\n[conversation command: restart]` };
    if (owner === 'helper' && (name === 'model' || name === 'effort')) {
      const values = args.split(/\s+/);
      const valid = values.length === 1 && (name === 'model'
        ? HELPER_MODEL.test(values[0])
        : EFFORT.includes(values[0] as typeof EFFORT[number]));
      return { context: `${context}\n${valid
        ? `[conversation command: helper-switch --${name} ${values[0]}]`
        : `[conversation command refused: !${name} needs one valid value]`}` };
    }
    const reason = name === 'model' || name === 'effort' ? 'per-conversation model/effort not supported' : `!${name} does not reach the resident from a task thread`;
    return { context: `${context}\n[conversation command refused: ${reason}]` };
  }
  if (conversationCommand) return { context: `${context}\n[conversation command: ${name}]` };
  // Mute silences ordinary steering, not an addressed command: pause/resume/snooze
  // and status are documented as always reachable from chat, and blocking here
  // settles the disposition before their stages ever run.
  if (record.muted && !addressed && !await isSelfMentioned(ctx.dir, ctx.config(), env.sourceKey, env.chatId, env.body, env)) {
    capture(ctx, env, true);
    return { block: 'muted conversation: recorded' };
  }
  return { context };
}
