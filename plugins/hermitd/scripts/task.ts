import { pinStateDirOrExit } from './lib/cc-compat';
import { lookupChat, isGuildChannelType } from './lib/channel-chats';
import { readSettledConfig } from './lib/config-read';
import { exitError } from './lib/cli';
import { listTasks, mutateTask, reportTaskError, taskStandup, TASK_ID, type TaskFlags } from './lib/tasks';
import { resolveProposalOnCheckClose } from './lib/proposals/linked';

async function main(): Promise<void> {
  const [verb, dirArg, ...args] = process.argv.slice(2);
  if (!dirArg) exitError();
  const dir = pinStateDirOrExit(dirArg);
  const allowed: Record<string, string[]> = {
    open: ['note-stdin', 'title', 'requester', 'done', 'requester-name', 'origin-message-id', 'due', 'conversation', 'card', 'owner', 'muted', 'approver', 'dedupe-key', 'claim', 'check'],
    note: ['actor', 'due', 'card', 'decision', 'approval', 'done', 'clear-waiting', 'check', 'owner', 'muted'],
    learn: ['disposition'],
    lesson: ['actor'], 'check-snapshot': [],
    block: ['waiting-on', 'result-stdin', 'status-line', 'next'],
    close: ['by', 'actor', 'result-rev', 'reason-stdin', 'claim'], cancel: ['actor', 'reason-stdin'],
    list: ['open', 'all', 'conversation', 'requester', 'handle', 'id', 'dedupe-key', 'json', 'owner', 'with-check', 'limit', 'skill-review'], standup: ['json', 'days'],
  };
  if (!allowed[verb]) throw new Error('invalid_verb');
  const requiresId = ['note', 'block', 'close', 'cancel', 'lesson', 'check-snapshot', 'learn'].includes(verb);
  const id = requiresId ? args.shift() : undefined;
  if (requiresId && (!id || !TASK_ID.test(id))) throw new Error('invalid_id');
  const booleans = new Set(['note-stdin', 'decision', 'clear-waiting', 'result-stdin', 'reason-stdin', 'open', 'all', 'json', 'with-check']);
  const flags: TaskFlags = {};
  while (args.length) {
    const token = args.shift()!;
    const name = token.slice(2);
    if (!token.startsWith('--') || !allowed[verb].includes(name)) throw new Error('invalid_flag');
    if (booleans.has(name)) { flags[name] = true; continue; }
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`missing_${name.replaceAll('-', '_')}`);
    if (name === 'claim') {
      flags.claim ??= [];
      (flags.claim as string[]).push(value);
    }
    else if (name in flags) throw new Error('duplicate_flag');
    else flags[name] = value;
  }
  if (flags.id && !TASK_ID.test(String(flags.id))) throw new Error('invalid_id');
  let result: unknown;
  if (verb === 'list') result = listTasks(dir, flags);
  else if (verb === 'standup') {
    const days = flags.days === undefined ? 7 : Number(flags.days);
    if (!Number.isFinite(days) || days <= 0) throw new Error('invalid_days');
    result = taskStandup(dir, days);
  } else {
    const input = verb === 'note' || verb === 'lesson' || flags['note-stdin'] || flags['result-stdin'] || flags['reason-stdin'] ? await Bun.stdin.text() : '';
    if (verb === 'open' && typeof flags.conversation === 'string' && !flags.conversation.includes('~')) {
      const config = readSettledConfig(dir);
      const [source, chatId] = flags.conversation.split(':');
      const needsThread = source === 'discord'
        ? isGuildChannelType(await lookupChat(dir, config, chatId))
        : Boolean(config.channels?.[source]?.attributes?.thread_id);
      if (needsThread) throw new Error('thread_required');
    }
    result = mutateTask(dir, verb, id, flags, input);
    if (verb === 'close') resolveProposalOnCheckClose(dir, id!, result as Record<string, unknown>);
  }
  console.log(JSON.stringify(result));
}
main().catch(reportTaskError);
