import { pinStateDirOrExit } from './lib/cc-compat';
import { classifyChat, needsThread } from './lib/channel-chats';
import { isKey } from './lib/conversation-key';
import { readSettledConfig } from './lib/config-read';
import { exitError } from './lib/cli';
import { listTasks, mutateTask, reportTaskError, taskStandup, TASK_ID, type TaskFlags } from './lib/tasks';

async function main(): Promise<void> {
  const [verb, dirArg, ...args] = process.argv.slice(2);
  if (!dirArg) exitError();
  const dir = pinStateDirOrExit(dirArg);
  const allowed: Record<string, string[]> = {
    open: ['source', 'category', 'tags', 'waiting-on', 'decision', 'body-stdin', 'kind', 'note-stdin', 'title', 'requester', 'done', 'requester-name', 'origin-message-id', 'due', 'conversation', 'card', 'owner', 'muted', 'approver', 'dedupe-key', 'claim', 'check'],
    answer: ['local', 'chat', 'user', 'reply', 'generation', 'result-rev'],
    note: ['chat', 'user', 'actor', 'due', 'card', 'decision', 'approval', 'done', 'clear-waiting', 'if-waiting-since', 'check', 'owner', 'muted'],
    lesson: ['actor'], 'check-snapshot': [],
    block: ['decision', 'waiting-on', 'result-stdin', 'status-line', 'next'],
    close: ['chat', 'user', 'by', 'actor', 'result-rev', 'reason-stdin', 'claim'], cancel: ['chat', 'user', 'actor', 'reason-stdin'],
    list: ['open', 'all', 'conversation', 'requester', 'handle', 'id', 'dedupe-key', 'json', 'owner', 'with-check', 'limit'], standup: ['json', 'days'],
  };
  if (!allowed[verb]) throw new Error('invalid_verb');
  const requiresId = ['note', 'block', 'close', 'cancel', 'lesson', 'check-snapshot'].includes(verb);
  const id = requiresId || (verb === 'answer' && args[0] !== undefined && !args[0].startsWith('--')) ? args.shift() : undefined;
  if (id !== undefined && !TASK_ID.test(id)) throw new Error('invalid_id');
  if (requiresId && (!id || !TASK_ID.test(id))) throw new Error('invalid_id');
  const booleans = new Set(['local', 'note-stdin', 'body-stdin', 'clear-waiting', 'result-stdin', 'reason-stdin', 'open', 'all', 'json', 'with-check']);
  const flags: TaskFlags = {};
  while (args.length) {
    const token = args.shift()!;
    const name = token.slice(2);
    if (!token.startsWith('--') || !allowed[verb].includes(name)) throw new Error(`invalid_flag:${token} (accepts ${allowed[verb].map(flag => `--${flag}`).join(' ') || 'no flags'})`);
    if (booleans.has(name) || (verb === 'note' && name === 'decision')) { flags[name] = true; continue; }
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`missing_${name.replaceAll('-', '_')}`);
    if (name === 'claim') {
      flags.claim ??= [];
      (flags.claim as string[]).push(value);
    }
    else if (name in flags) throw new Error('duplicate_flag');
    else flags[name] = value;
  }
  if (verb === 'answer' && flags.local && ('chat' in flags || 'user' in flags)) throw new Error('invalid_arguments');
  if (flags.id && !TASK_ID.test(String(flags.id))) throw new Error('invalid_id');
  let result: unknown;
  if (verb === 'list') result = listTasks(dir, flags);
  else if (verb === 'standup') {
    const days = flags.days === undefined ? 7 : Number(flags.days);
    if (!Number.isFinite(days) || days <= 0) throw new Error('invalid_days');
    result = taskStandup(dir, days);
  } else {
    const input = verb === 'note' || verb === 'lesson' || flags['note-stdin'] || flags['body-stdin'] || flags['result-stdin'] || flags['reason-stdin'] ? await Bun.stdin.text() : '';
    let threadConversation = false;
    const routedChat = verb === 'open' ? flags.conversation : verb === 'answer' && !id && !flags.local ? flags.chat : undefined;
    if (isKey(routedChat)) {
      const config = readSettledConfig(dir);
      const [source, destination] = routedChat.split(':');
      const [chatId, thread] = destination.split('~');
      threadConversation = await classifyChat(dir, config, source, chatId, thread) === 'thread';
      if (verb === 'open' && flags.requester !== 'agent' && thread === undefined && await needsThread(dir, config, source, chatId)) throw new Error('thread_required');
    }
    result = mutateTask(dir, verb, id, flags, input, threadConversation);
  }
  console.log(JSON.stringify(result));
}
main().catch(reportTaskError);
