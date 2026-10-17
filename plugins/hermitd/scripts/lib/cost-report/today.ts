// `cost-report.ts today` — prints today's spend as
// {"cost_usd":<n>,"tokens":<n>,"sessions":<n>}.
// Log resolved against the anchored hermit root (survives cwd drift), not cwd.
// Unreadable log -> {"status":"unavailable","reason":"cost_log_unreadable"} (not a
// misleading zero); a readable log with no rows today -> honest zeros.

import fs from 'node:fs';
import { printJson } from '../cli';
import { round4 } from '../format';
import { costLogPath, hermitDir } from '../cc-compat';

const UNAVAILABLE = { status: 'unavailable', reason: 'cost_log_unreadable' };

function summarize(costLog: string): object {
  let raw: string;
  try {
    raw = fs.readFileSync(costLog, 'utf8');
  } catch {
    return UNAVAILABLE;
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    let cost = 0;
    let tokens = 0;
    const sessions = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.timestamp && e.timestamp.startsWith(today)) {
          cost += e.estimated_cost_usd || 0;
          tokens += e.total_tokens || 0;
          if (e.session_id || e.cc_session_id) sessions.add(e.session_id || e.cc_session_id);
        }
      } catch {}
    }
    return { cost_usd: round4(cost), tokens, sessions: sessions.size };
  } catch {
    return UNAVAILABLE;
  }
}

// Resolved here rather than at module scope — see the note in session.ts: every
// verb module is imported unconditionally, so a module-scope hermitDir() walk
// would run even for the verbs that never read it.
export function run(): void {
  printJson(summarize(costLogPath(hermitDir())));
}
