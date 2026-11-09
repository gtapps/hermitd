#!/usr/bin/env bun
// channel-log.ts: age retention over the episodic channel-message log.
// Usage: bun channel-log.ts <hermit-state-dir> prune <days>
// Prints {"deleted":N}; absent DB is a successful no-op.

import { prune } from './lib/channel-log';
import { pinStateDirOrExit } from './lib/cc-compat';
import { emitJson, exitError } from './lib/cli';

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) exitError();

  // The state dir is not caller-chosen. Reachable through a pre-approved
  // `Bash(bun */scripts/channel-log.ts*)` grant that covers every argument, and
  // prune mutates: an unvalidated root let one such call
  // delete rows in another project's channel log. See cc-compat.ts.
  const hermitDir = pinStateDirOrExit(args[0]);
  const subcommand = args[1];
  const rest = args.slice(2);

  if (subcommand === 'prune') {
    const days = parseInt(rest[0], 10);
    if (isNaN(days)) exitError();
    const result = prune(hermitDir, days);
    if (!result.ok) exitError(`prune_failed:${result.error}`);
    emitJson({ deleted: result.deleted });
  }

  exitError();
}
