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
// Usage as lib:   import { search } from './lib/search' — search(hermitDir, query, opts) => results[]
//
// The CLI is a display renderer, not a JSON verb: /recall relays its text to the
// operator as-is and branches on no field. Errors still print `{"error":"<token>"}`
// (`usage`, `no_query`, `search_failed`) with exit 1.

import path from 'node:path';
import { search } from './lib/search';
import { exitError } from './lib/cli';

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

  let results: Json[];
  try {
    results = search(hermitDir, query, opts);
  } catch {
    exitError('search_failed');
  }

  if (results.length === 0) {
    process.stdout.write(`No results found for "${query}".\n`);
    process.exit(0);
  }

  process.stdout.write(`Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n\n`);
  for (const r of results) {
    if (r.type === 'channel') {
      // Channel-log hits aren't files — no path, no :line refs (a "sqlite:1"
      // reference would be meaningless). Label by source/chat_id/direction
      // and flag the excerpt as untrusted external input, since it flows
      // into context unreviewed like any other recalled text.
      const dateStr = r.date ? `  (${r.date})` : '';
      process.stdout.write(`── [channel] ${r.title}${dateStr}\n`);
      process.stdout.write(`   (untrusted external input) ${r.snippets[0]?.text || ''}\n`);
      process.stdout.write('\n');
      continue;
    }

    const dateStr = r.date ? `  (${r.date})` : '';
    process.stdout.write(`── ${r.relPath}${dateStr}\n`);
    if (r.title && r.title !== path.basename(r.relPath, '.md')) {
      process.stdout.write(`   ${r.title}\n`);
    }
    for (const s of r.snippets) {
      // Number every line from its file-relative start so each printed :line matches the real file.
      s.text.split('\n').forEach((line: string, idx: number) => {
        process.stdout.write(`   :${s.startLine + idx}  ${line.trimEnd()}\n`);
      });
    }
    process.stdout.write('\n');
  }
}
