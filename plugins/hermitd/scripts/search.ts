#!/usr/bin/env bun
// search.ts — full-text search over sessions/, compiled/, and proposals/ in a hermit state dir,
// plus the episodic channel log (state/channel-log.sqlite, PROP-010) when present.
//
// Usage as CLI:   bun search.ts <hermit-state-dir> [options] <query...>
//   Options:
//     --type=<type>          filter by artifact type
//     --since=<YYYY-MM-DD>   exclude files older than this date
//     --chat=<key>:<chat_id> restrict channel log and compiled pages to the asking chat
//     --limit=<n>            max results (default 10)
//
// Usage as lib:   import { search } from './lib/search' — search(hermitDir, query, opts) => hits[]
//
// Output: one JSON object `{"hits":[...]}`, ranked best first; no match is `{"hits":[]}`.
//   File hit:    { source: 'file', path, date?, title?, snippets: [{ line, start_line, text }] }
//                (title only when it differs from the filename; line is the matching
//                file line, start_line the first line of text, which is that line with
//                one line of context either side)
//   Channel hit: { source: 'channel', untrusted: true, title, date?, text }
//                (past chat text, safeForLLM-sanitized; not a file, so no line refs)
// Errors print `{"error":"<token>"}` (`usage`, `no_query`, `search_failed`) with exit 1.

import path from 'node:path';
import { search } from './lib/search';
import { emitJson, exitError } from './lib/cli';
import { lookupChat } from './lib/channel-chats';
import { readConfigRaw } from './lib/config-read';

type Json = any;

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) exitError();

  const hermitDir = path.resolve(args[0]);
  const opts: Json = {};
  const queryParts: string[] = [];

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--type=')) {
      opts.type = arg.slice('--type='.length);
    } else if (arg.startsWith('--since=')) {
      opts.since = arg.slice('--since='.length);
    } else if (arg.startsWith('--chat=')) {
      opts.chat = arg.slice('--chat='.length);
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (!isNaN(n)) opts.limit = n;
    } else {
      queryParts.push(arg);
    }
  }

  const query = queryParts.join(' ').trim();
  if (!query) exitError('no_query');

  let hits: Json[];
  try {
    if (opts.chat?.startsWith('discord:')) {
      const chatId = opts.chat.slice('discord:'.length);
      // lookupChat answers from the cache first, so only a miss reaches Discord.
      if (chatId) await lookupChat(hermitDir, readConfigRaw(hermitDir), chatId);
    }
    hits = search(hermitDir, query, opts);
  } catch {
    exitError('search_failed');
  }
  emitJson({ hits });
}
