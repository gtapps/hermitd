import { conversationKey, checkKey } from './lib/conversation-key';
import { isTrustedController } from './lib/channel-auth';
import { pinStateDirOrExit } from './lib/cc-compat';
import { createThread, isGuildChannelType, isThreadType, lookupChat } from './lib/channel-chats';
import { conversationHistory } from './lib/channel-log';
import { readSettledConfig } from './lib/config-read';

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    // Normalize before the duplicate check, not after: `--session-name` lands under
    // `session_name`, so testing the raw spelling never sees the key it just wrote.
    const key = name?.startsWith('--') ? name.slice(2).replaceAll('-', '_') : null;
    if (!key || value === undefined || Object.hasOwn(result, key)) throw new Error('invalid-options');
    result[key] = value;
  }
  return result;
}

async function main(): Promise<void> {
  const [argvDir, verb, key, ...args] = process.argv.slice(2);
  if (!argvDir || !verb) throw new Error('usage');
  // The sealed grant covers every argument, so pin the state dir before any verb.
  // thread-open and thread-create read the bot token from that dir.
  // See cc-compat.ts for the shared project pin.
  const dir = pinStateDirOrExit(argvDir, 'conversation.ts');
  // Thin wrappers for the channel library calls channel-responder makes around a
  // task thread. A CLI verb rides the script's allow-list grant; the
  // `bun -e` import the skill used to name draws a classifier denial and matches
  // no prefix rule (apply-settings.ts), so on a live hermit the call never ran.
  if (!['history', 'chat-lookup', 'thread-create', 'thread-open', 'is-trusted'].includes(verb)) throw new Error('unknown-verb');
  const opts = options(key ? [key, ...args] : args);
  const require = (names: string[], optional: string[] = []) => {
    if (Object.keys(opts).some(k => !names.includes(k) && !optional.includes(k))) throw new Error('invalid-options');
    for (const name of names) if (!opts[name]) throw new Error(`missing-${name.replaceAll('_', '-')}`);
  };
  const config = readSettledConfig(dir);
  switch (verb) {
    case 'history': {
      require(['source', 'chat_id'], ['limit']);
      const limit = opts.limit === undefined ? 100 : Number(opts.limit);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('invalid-limit');
      console.log(JSON.stringify(conversationHistory(dir, opts.source, opts.chat_id, { limit })));
      return;
    }
    case 'chat-lookup': {
      require(['chat_id']);
      const chat = await lookupChat(dir, config, opts.chat_id);
      if (!chat) throw new Error('not-found');
      console.log(JSON.stringify({ ...chat, thread: isThreadType(chat) }));
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
        const chat = await lookupChat(dir, config, opts.chat_id);
        if (!chat) throw new Error('lookup-failed');
        if (isGuildChannelType(chat)) {
          const id = await createThread(dir, config, opts.chat_id, opts.message_id, opts.name);
          if (!id) throw new Error('thread-failed');
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
      console.log(JSON.stringify({ key, chat_id: chatId, reply }));
      return;
    }
    case 'thread-create': {
      require(['chat_id', 'message_id', 'name']);
      const id = await createThread(dir, config, opts.chat_id, opts.message_id, opts.name);
      if (!id) throw new Error('thread-failed');
      console.log(`OK|${id}`);
      return;
    }
    case 'is-trusted': {
      require(['source', 'user_id', 'chat_id']);
      // Asserts, not answers: a denial is ERROR|untrusted so a caller reading
      // only the exit code fails closed, like every other verb here.
      if (!isTrustedController(config, opts.source, opts.user_id, opts.chat_id)) throw new Error('untrusted');
      console.log('OK|trusted');
      return;
    }
  }
}

if (import.meta.main) {
  main().catch(error => {
    const token = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'operation-failed';
    // thread-open is the one JSON-only verb, so its errors are JSON too.
    const jsonVerb = process.argv[3] === 'thread-open';
    console.log(jsonVerb ? JSON.stringify({ error: token }) : `ERROR|${token}`);
    process.exitCode = 1;
  });
}
