#!/usr/bin/env bun
// channel-log.ts — CLI for the weekly-review consolidation step over the
// episodic channel-message log (see scripts/lib/channel-log.ts).
//
// Usage: bun channel-log.ts <hermit-state-dir> <subcommand> [args...]
//   list-unconsolidated [--before=ISO]   print `{"rows":[...]}`
//   mark-consolidated <id,id,...>        stamp consolidated_at on the given ids, print `OK`
//   prune <days>                         delete consolidated rows older than <days>, print `{"deleted":N}`
//
// Exit codes: 0 on success (including "no DB yet" — nothing to do, not a
// failure). 1 with `{"error":"<token>[:detail]"}` only on a usage error or a
// genuine error against an existing DB, so weekly-review can't mistake a no-op
// for completed work.

import { unconsolidated, markConsolidated, prune } from './lib/channel-log';
import { pinStateDirOrExit } from './lib/cc-compat';
import { channelEntry } from './lib/channel-auth';
import { readConfigRaw } from './lib/config-read';
import { emit, emitJson, exitError } from './lib/cli';

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) exitError();

  // The state dir is not caller-chosen. Reachable through a pre-approved
  // `Bash(bun */scripts/channel-log.ts*)` grant that covers every argument, and
  // mark-consolidated/prune both mutate: an unvalidated root let one such call
  // stamp or delete rows in another project's channel log. See cc-compat.ts.
  const hermitDir = pinStateDirOrExit(args[0]);
  const subcommand = args[1];
  const rest = args.slice(2);

  if (subcommand === 'list-unconsolidated') {
    const beforeArg = rest.find((a) => a.startsWith('--before='));
    const before = beforeArg ? beforeArg.slice('--before='.length) : undefined;
    const result = unconsolidated(hermitDir, before);
    if (!result.ok) exitError(`list_failed:${result.error}`);
    const config = readConfigRaw(hermitDir);
    const rows = result.rows.map((row) => {
      const shared = channelEntry(config, row.source)?.shared_chats;
      // String(): chat ids in config may be numbers (Telegram), while the DB
      // column is TEXT. The channel-log SQL grant and audienceVisible both
      // coerce, so this stamp has to as well or a shared chat reads private.
      const audience = Array.isArray(shared) && shared.map(String).includes(row.chat_id)
        ? 'shared'
        : `${row.source}:${row.chat_id}`;
      return { ...row, audience };
    });
    emitJson({ rows });
  }

  if (subcommand === 'mark-consolidated') {
    const idsArg = rest[0];
    if (!idsArg) exitError();
    const ids = idsArg
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
    const result = markConsolidated(hermitDir, ids);
    if (!result.ok) exitError(`mark_failed:${result.error}`);
    emit('OK');
  }

  if (subcommand === 'prune') {
    const days = parseInt(rest[0], 10);
    if (isNaN(days)) exitError();
    const result = prune(hermitDir, days);
    if (!result.ok) exitError(`prune_failed:${result.error}`);
    emitJson({ deleted: result.deleted });
  }

  exitError();
}
