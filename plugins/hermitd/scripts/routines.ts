// routines.ts — single CLI for the routine mechanics, over lib/routines/.
//
// Usage:
//   bun routines.ts due <hermit-state-dir>
//     The monitor's poll. Owns all gating/state/liveness writes and prints a
//     `ROUTINE_DUE [hermit-routine:<id>] …` line only when routines are due.
//     That line is load-bearing: record-operator-action.ts's isRoutinePrompt()
//     matches it, and tests/heartbeat-monitor-emissions.test.ts guards it against drift.
//
//   bun routines.ts precheck <id> [delivery]
//     Per-routine gate at fire time. Prints a proceed or skip JSON verdict.
//
//   bun routines.ts tz-shift "<cron-expr>" "<from-tz>"
//     Rewrites a cron expression into the machine's local timezone.
//
//   bun routines.ts finish <routine-id> [delivery] [--outcome-stdin]
//     Terminal gate for a fire. Verifies any declared `expect_artifact` contract
//     against the baseline `precheck` froze, writes the one terminal ledger row,
//     and prints a `fired` or `failed` JSON verdict. With --outcome-stdin the
//     dispatcher drains outcome text; finish does not write a journal.
//
//   bun routines.ts log-event <routine-id> <event> [delivery]
//     Appends one line to state/routine-metrics.jsonl.
//
//   bun routines.ts health [hermit-dir] [--days N]
//     Bounded per-routine health digest (JSON): fires, typed failures, abandoned
//     attempts, skips, and windowed cost. The fronting script for reflect and
//     hermit-evolution, which used to tail and hand-parse the ledgers themselves.
//
// `due` keeps its ROUTINE_DUE line grammar, an exception to the helper-output
// convention: the monitor relays it as the wake notification.
//
// Verb dispatch is lazy, and for the first two the verb is spliced out of
// process.argv so each module keeps the argv indices it used as a standalone
// script: scheduling and cron matching stay byte-for-byte unchanged rather
// than being rethreaded through a parameter. `due` runs on every monitor
// interval, so it has no business loading the registry or tz-shift graphs to
// do it.

import { exitError } from './lib/cli'; // fs only; every verb module stays dynamic

const verb = process.argv[2];
const rest = process.argv.slice(3);

switch (verb) {
  // argv-index-preserving verbs: drop the verb, then let the module run.
  case 'due':
    process.argv.splice(2, 1);
    await import('./lib/routines/due');
    break;
  case 'precheck':
    process.argv.splice(2, 1);
    await import('./lib/routines/precheck');
    break;

  // Already parameterized — pass the tail directly.
  case 'tz-shift': {
    const { run } = await import('./lib/routines/tz-shift');
    run(rest);
    break;
  }
  case 'finish': {
    const { readStdinIfFlagged } = await import('./lib/cli');
    const outcome = await readStdinIfFlagged(rest, '--outcome-stdin');
    const { run } = await import('./lib/routines/finish');
    run(rest, outcome);
    break;
  }
  case 'log-event': {
    const { run } = await import('./lib/routines/event');
    run(rest);
    break;
  }
  case 'health': {
    const { run } = await import('./lib/routines/health');
    run(rest);
    break;
  }
  case 'arm': {
    const { run } = await import('./lib/routines/arm');
    await run(rest);
    break;
  }

  default:
    exitError();
}
