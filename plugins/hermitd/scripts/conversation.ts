import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine } from './lib/append-jsonl';
// `is-trusted` prints `OK` for a trusted sender and `{"status":"untrusted"}` otherwise, both at
// exit 0: a caller must read stdout, never the exit code alone, to decide trust.
import { conversationKey, checkKey } from './lib/conversation-key';
import { isTrustedController, allowedUserIds } from './lib/channel-auth';
import { pinStateDirOrExit } from './lib/cc-compat';
import { createThread, isGuildChannelType, lookupChat } from './lib/channel-chats';
import { conversationHistory } from './lib/channel-log';
import { readSettledConfig } from './lib/config-read';
import { emit, emitJson, exitError, failJson, printJson } from './lib/cli';

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    // Normalize before the duplicate check, not after: `--session-name` lands under
    // `session_name`, so testing the raw spelling never sees the key it just wrote.
    const key = name?.startsWith('--') ? name.slice(2).replaceAll('-', '_') : null;
    if (!key || value === undefined || Object.hasOwn(result, key)) throw new Error('invalid_options');
    result[key] = value;
  }
  return result;
}

async function main(): Promise<void> {
  const [argvDir, verb, key, ...args] = process.argv.slice(2);
  if (!argvDir || !verb) exitError();
  // The sealed grant covers every argument, so pin the state dir before any verb.
  // thread-open reads the bot token from that dir.
  // See cc-compat.ts for the shared project pin.
  const dir = pinStateDirOrExit(argvDir);
  // Thin wrappers for the channel library calls channel-responder makes around a
  // task thread. A CLI verb rides the script's allow-list grant; the
  // `bun -e` import the skill used to name draws a classifier denial and matches
  // no prefix rule (apply-settings.ts), so on a live hermit the call never ran.
  if (!['history', 'thread-open', 'is-trusted'].includes(verb)) exitError('unknown_verb');
  const opts = options(key ? [key, ...args] : args);
  const require = (names: string[], optional: string[] = []) => {
    if (Object.keys(opts).some(k => !names.includes(k) && !optional.includes(k))) throw new Error('invalid_options');
    for (const name of names) if (!opts[name]) throw new Error(`missing_${name}`);
  };
  const config = readSettledConfig(dir);
  switch (verb) {
    case 'history': {
      require(['source', 'chat_id'], ['limit']);
      const limit = opts.limit === undefined ? 100 : Number(opts.limit);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('invalid_limit');
      printJson({ rows: conversationHistory(dir, opts.source, opts.chat_id, { limit, senderIds: allowedUserIds(config, opts.source) }) });
      return;
    }
    case 'thread-open': {
      // One routing decision for every channel, printed as JSON: `key` is the task
      // thread's conversation key, `chat_id` the reply destination, and `reply` the
      // parameter every reply in the thread carries.
      require(['source', 'chat_id', 'message_id', 'name'], ['thread_id']);
      let chatId = opts.chat_id;
      let thread: string | undefined;
      let reply: Record<string, string> | undefined;
      if (opts.source === 'discord') {
        // Server text and announcement channels get a native thread, which is a chat
        // of its own; DMs and existing threads are their own thread.
        const chat = await lookupChat(dir, config, opts.chat_id, true);
        if (!chat) throw new Error('lookup_failed');
        if (isGuildChannelType(chat)) {
          const id = await createThread(dir, config, opts.chat_id, opts.message_id, opts.name);
          if (!id) throw new Error('thread_failed');
          chatId = id;
        }
      } else {
        const attribute = config.channels?.[opts.source]?.attributes?.thread_id;
        // A message already inside a thread keeps that thread, or later replies there miss the record.
        if (attribute) {
          thread = opts.thread_id || opts.message_id;
          reply = { [attribute]: thread };
        }
      }
      const key = conversationKey(opts.source, chatId, thread);
      checkKey(key);
      // Best-effort: the thread already exists, so a failed ack must not report thread-open as failed.
      try {
        fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
        appendJsonlLine(path.join(dir, 'state', 'intake-acks.jsonl'), JSON.stringify({
          at: new Date().toISOString(),
          channel: opts.source,
          chat_id: chatId,
          session_id: null,
        }));
      } catch { /* fail-open */ }
      console.log(JSON.stringify({ key, chat_id: chatId, reply }));
      return;
    }
    case 'is-trusted': {
      require(['source', 'user_id', 'chat_id']);
      // An untrusted sender is an expected answer, not a failure: callers branch on stdout.
      if (isTrustedController(config, opts.source, opts.user_id, opts.chat_id)) emit('OK');
      emitJson({ status: 'untrusted' });
    }
  }
}

if (import.meta.main) {
  main().catch(error => failJson(error));
}
