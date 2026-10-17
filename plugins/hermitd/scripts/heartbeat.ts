// heartbeat.ts — single CLI for the heartbeat mechanics, over
// lib/heartbeat/{precheck,alert-update}.ts.
//
// Usage:
//   bun heartbeat.ts precheck [--peek] <hermit-state-dir>
//     The monitor's poll and /heartbeat run's mutating tick. --peek is
//     read-only. Prints one verdict line: OK | EVALUATE | ALERT |
//     SKIP|<reason>. The monitor greps these, so the grammar is load-bearing.
//
//   bun heartbeat.ts tick <hermit-dir>
//     One deterministic tick: the mutating precheck plus the bookkeeping the run
//     handler uses for budget and runnable task notices. Prints one JSON line the skill branches on.
//
//   bun heartbeat.ts ack-queue <hermit-dir> <token>
//     Acknowledge an unchanged runnable record after pickup or notification.
//
//   bun heartbeat.ts start-check <hermit-dir>
//   bun heartbeat.ts start-commit <hermit-dir> <task-id>
//     The two halves of `heartbeat start`: is a re-arm needed, and record the
//     Monitor the skill registered in between. Each prints one JSON object.
//
//   bun heartbeat.ts alert-state <state-file>
//     Applies one alert-state update from stdin.
//
// Exception to the helper-output convention: precheck, interval and control-state
// keep the line grammar heartbeat-monitor.sh parses.
//
// The verb is spliced out of process.argv before the module loads, so each
// module keeps the argv indices it used as a standalone script — 550-odd lines
// of alert derivation and lull arithmetic stay byte-for-byte unchanged rather
// than being rethreaded through a parameter. Loading is lazy for the same
// reason it is in routines.ts: a precheck poll runs every interval and has no
// business parsing the alert-update graph.

import { exitError } from './lib/cli'; // fs only; every verb module stays dynamic

const verb = process.argv[2];
process.argv.splice(2, 1);

switch (verb) {
  case 'precheck': {
    const { main } = await import('./lib/heartbeat/precheck');
    main();
    break;
  }
  case 'tick': {
    const { run } = await import('./lib/heartbeat/tick');
    await run(process.argv.slice(2));
    break;
  }
  case 'ack-queue': {
    const { acknowledgeQueue } = await import('./lib/heartbeat/tick');
    const { pinStateDirOrExit } = await import('./lib/cc-compat');
    const dir = pinStateDirOrExit(process.argv[2]);
    console.log(JSON.stringify(acknowledgeQueue(dir, process.argv[3])));
    break;
  }
  case 'control-state': {
    const { effectiveHeartbeatMode } = await import('./lib/heartbeat/control');
    const { readConfigRaw } = await import('./lib/config-read');
    const dir = process.argv[2];
    if (!dir) exitError();
    const mode = effectiveHeartbeatMode(dir);
    console.log(mode === 'stopped' ? 'stopped' : mode === 'auto' && readConfigRaw(dir)?.heartbeat?.enabled === false ? 'disabled' : 'active');
    break;
  }
  case 'start-check':
  case 'stop':
  case 'interval':
  case 'start-commit': {
    const { run } = await import('./lib/heartbeat/start');
    await run(verb, process.argv.slice(2));
    break;
  }
  case 'alert-state':
    await import('./lib/heartbeat/alert-update');
    break;
  default:
    exitError();
}
