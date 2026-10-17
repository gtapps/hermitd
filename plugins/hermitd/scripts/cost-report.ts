// cost-report.ts — single CLI for the three cost readouts, over
// lib/cost-report/{today,session,reflect}.ts.
//
// Usage:
//   bun cost-report.ts today
//     {"cost_usd":<n>,"tokens":<n>,"sessions":<n>} for today. An unreadable log prints
//     {"status":"unavailable","reason":"cost_log_unreadable"} rather than a misleading zero.
//
//   bun cost-report.ts session <session_id> [--opened-at <iso>] [--closed-at <iso>]
//     {"cost_usd":<n>,"tokens":<n>} for one logical session's arc window.
//
//   bun cost-report.ts reflect [<stateDir>] [<days>] [--plain]
//     The spend breakdown as one JSON object; --plain is the channel-safe prose
//     form, a display renderer exempt from the helper-output convention.
//
// No data is an expected outcome (exit 0), because the callers are briefs and
// channel replies that must still compose without cost.

import { run as runToday } from './lib/cost-report/today';
import { run as runSession } from './lib/cost-report/session';
import { run as runReflect } from './lib/cost-report/reflect';
import { exitError } from './lib/cli';

const verb = process.argv[2];
const rest = process.argv.slice(3);

switch (verb) {
  case 'today': runToday(); break;
  case 'session': runSession(rest); break;
  case 'reflect': runReflect(rest); break;
  default:
    exitError();
}
