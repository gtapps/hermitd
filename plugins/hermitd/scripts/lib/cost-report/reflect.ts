// `cost-report.ts reflect [<stateDir>] [<days>] [--plain]` — the "why is my bill
// like this" report. The default mode prints the per-type/per-model/per-source
// breakdown as one JSON object; --plain is the channel-safe prose answer. Any throw
// prints {"error":"report_failed"} at exit 1.

import fs from 'node:fs';
import path from 'node:path';

import { readSettledConfig } from '../config-read';
import { money, resolveTimezone, budgetLine } from '../spend-status';
import { todayYMD } from '../time';
import { costLogPath, hermitDir } from '../cc-compat';
import { failJson, printJson } from '../cli';
import { round4 } from '../format';

type Json = any;

// Cold-start heuristic: a turn where the context was NOT warm.
// These turns drive cache_write cost without benefiting from a warm cache.
// Condition: cache was written (non-trivial turn), no prior cache was read,
// and output is small (i.e. this was a context-warm-up rather than real work).
const COLD_START_OUTPUT_MAX = 1000; // tokens

const MAX_TOP_SESSIONS = 3;
const MAX_TOP_SOURCES = 5;

// --plain mode: a channel-safe, no-jargon spend statement (audit's "plain spend
// statement" PR). A cutoff of today−7 days spans today plus the 7 prior calendar
// days — the trailing-7-day baseline compareToTypical averages (today excluded).
const PLAIN_LOOKBACK_DAYS = 7;

// Buckets the raw `source` values (heartbeat / routine:<id> / channel:<kind> / peer / other)
// into the plain-language groupings a non-dev operator recognizes — never the raw
// source string itself.
function labelSource(src: string): string {
  if (src === 'heartbeat') return 'background check-ins';
  if (src.startsWith('routine:')) return 'scheduled routines';
  if (src.startsWith('channel:')) return 'your messages';
  if (src === 'peer') return 'other sessions on this machine';
  return 'our conversations';
}

function parseLogEntries(costLog: string): Json[] {
  try {
    const content = fs.readFileSync(costLog, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').reduce((acc: Json[], line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
  } catch {
    return [];
  }
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

function storedCost(e: Json): number {
  return typeof e.estimated_cost_usd === 'number' ? e.estimated_cost_usd : 0;
}

function storedByType(e: Json): { input: number; cacheWrite: number; cacheRead: number; output: number } | null {
  const c = e.cost_by_type;
  if (!c || typeof c !== 'object') return null;
  return {
    input: c.input || 0,
    cacheWrite: c.cache_write || 0,
    cacheRead: c.cache_read || 0,
    output: c.output || 0,
  };
}

// Total-vs-typical framing for the plain statement. `typical` is the trailing
// 7-day daily average (today excluded, so a still-running day isn't self-compared).
function compareToTypical(today: number, typical: number): string {
  if (typical <= 0) return '';
  const ratio = today / typical;
  if (ratio >= 1.3) return ` — higher than a typical day (~${money(typical)}/day)`;
  if (ratio <= 0.7) return ` — lower than a typical day (~${money(typical)}/day)`;
  return ` — about a typical day (~${money(typical)}/day)`;
}

// Top 2-3 plain-language drivers by cost. Multiple raw sources collapsing into the
// same label (e.g. several routine:<id> buckets) are summed under that one label.
function buildDriverLine(bySource: Record<string, number>): string | null {
  const merged: Record<string, number> = {};
  for (const [src, cost] of Object.entries(bySource)) {
    const label = labelSource(src);
    merged[label] = (merged[label] || 0) + cost;
  }
  const top = Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length === 0) return null;
  return `Mostly from ${top.map(([label, cost]) => `${label} (${money(cost)})`).join(', ')}.`;
}

function buildPlainStatement(stateDir: string, costLog: string): string {
  const config = readSettledConfig(stateDir);
  const timezone = resolveTimezone(config);

  // Timezone-aware calendar-day key, matching how lib/cost-log.ts buckets the same
  // log for budgetLine's cap check below — a raw UTC slice here would let "Today"'s
  // total and the cap line disagree near a non-UTC operator's day boundary.
  const entryDate = (e: Json): string => {
    const ts = e.timestamp ? new Date(e.timestamp) : null;
    return ts && !isNaN(ts.getTime()) ? todayYMD(timezone, ts) : '';
  };

  const entries = parseLogEntries(costLog);
  const cutoffDate = todayYMD(timezone, new Date(Date.now() - PLAIN_LOOKBACK_DAYS * 86400000));
  const recent = entries.filter(e => {
    const d = entryDate(e);
    return d && d >= cutoffDate;
  });

  if (recent.length === 0) {
    return 'No spend recorded yet.\n';
  }

  const today = todayYMD(timezone);
  const byDate: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const e of recent) {
    const cost = storedCost(e);
    const date = entryDate(e);
    if (date) byDate[date] = (byDate[date] || 0) + cost;
    bySource[e.source || 'other'] = (bySource[e.source || 'other'] || 0) + cost;
  }

  const lines: string[] = [];

  const todaySpend = byDate[today] || 0;
  const priorDates = Object.keys(byDate).filter(d => d !== today);
  const typical = priorDates.length > 0
    ? priorDates.reduce((sum, d) => sum + byDate[d], 0) / priorDates.length
    : 0;
  lines.push(`Today: ${money(todaySpend)}${compareToTypical(todaySpend, typical)}.`);

  const driverLine = buildDriverLine(bySource);
  if (driverLine) lines.push(driverLine);

  const cap = budgetLine(stateDir, config, timezone);
  if (cap) lines.push(cap);

  lines.push('These dollar figures are an estimate for tracking spend, not a literal bill.');

  return lines.join('\n') + '\n';
}

function report(rawArgs: string[]) {
  const plainMode = rawArgs.includes('--plain');
  const positional = rawArgs.filter(a => a !== '--plain');
  // An absolute arg (as tests pass) is used verbatim; a relative/absent arg is
  // resolved via the anchored hermitDir() so cost-log and config reads survive
  // cwd drift (the calling shell persists cd across Bash calls).
  const stateArg = positional[0];
  const stateDir = stateArg && path.isAbsolute(stateArg) ? stateArg : hermitDir();
  const days = Math.max(1, parseInt(positional[1], 10) || 7);

  const costLog = costLogPath(stateDir);

  if (plainMode) {
    process.stdout.write(buildPlainStatement(stateDir, costLog));
    return;
  }

  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const entries = parseLogEntries(costLog);

  const window = entries.filter(e => {
    const d = (e.timestamp || '').slice(0, 10);
    return d && d >= cutoffDate;
  });

  if (window.length === 0) {
    printJson({ status: 'empty', reason: 'no_cost_data', window_days: days });
    return;
  }

  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let hasTypeSplit = false;
  let coldStartTurns = 0;
  let coldStartCost = 0;
  const sessionMap: Record<string, Json> = {}; // session_id -> { cost, turns, byType }
  const sourceMap: Record<string, number> = {};
  const modelMap: Record<string, { cost: number; byType: { input: number; cacheWrite: number; cacheRead: number; output: number } }> = {};

  for (const e of window) {
    const model = e.model || 'sonnet';
    const cw   = e.cache_write_tokens  || 0;
    const cr   = e.cache_read_tokens   || 0;
    const out  = e.output_tokens       || 0;

    const entryCost = storedCost(e);
    const types = storedByType(e);
    if (types) {
      hasTypeSplit = true;
      totals.input      += types.input;
      totals.cacheWrite += types.cacheWrite;
      totals.cacheRead  += types.cacheRead;
      totals.output     += types.output;
    }

    // Subagent lines contribute to cost totals but not to turn counts or cold-start detection.
    if (!e.subagent && cw > 0 && cr === 0 && out < COLD_START_OUTPUT_MAX) {
      coldStartTurns++;
      coldStartCost += entryCost;
    }

    // Per-session attribution (by stored dollars, not token volume)
    const sid = e.session_id || e.cc_session_id || '';
    if (sid) {
      if (!sessionMap[sid]) {
        sessionMap[sid] = { cost: 0, turns: 0, byType: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
      }
      const s = sessionMap[sid];
      s.cost += entryCost;
      if (!e.subagent) s.turns++;
      if (types) {
        s.byType.input      += types.input;
        s.byType.cacheWrite += types.cacheWrite;
        s.byType.cacheRead  += types.cacheRead;
        s.byType.output     += types.output;
      }
    }

    // Per-source attribution; legacy entries without 'source' bucket to 'other'
    const src = e.source || 'other';
    sourceMap[src] = (sourceMap[src] || 0) + entryCost;

    // subagent lines included intentionally — they carry a resolved model unlike the cold-start guard above
    if (!modelMap[model]) modelMap[model] = { cost: 0, byType: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
    const mm = modelMap[model];
    mm.cost += entryCost;
    if (types) {
      mm.byType.input      += types.input;
      mm.byType.cacheWrite += types.cacheWrite;
      mm.byType.cacheRead  += types.cacheRead;
      mm.byType.output     += types.output;
    }
  }

  const total = window.reduce((sum, e) => sum + storedCost(e), 0);
  const sessions = Object.keys(sessionMap).length;
  const turns = window.filter(e => !e.subagent).length;

  const topSessions = Object.entries(sessionMap)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, MAX_TOP_SESSIONS)
    .map(([sid, s]) => {
      const typed = Object.entries(s.byType).filter(([, v]) => (v as number) > 0) as [string, number][];
      const dominant = typed.sort((a, b) => b[1] - a[1])[0]?.[0];
      const label = dominant === 'cacheRead' ? 'cache_read' : dominant === 'cacheWrite' ? 'cache_write' : dominant;
      return { id: sid.slice(0, 8), cost_usd: round4(s.cost), turns: s.turns, dominant: label ?? null };
    });

  const allSources = Object.entries(sourceMap).sort((a, b) => b[1] - a[1]);

  // Shares are of the rows that carry a breakdown, not of `total` — rows written
  // before cost_by_type existed contribute dollars to `total` but nothing to
  // `totals`, and dividing by `total` would report cache_read at a few percent on a
  // window that is mostly legacy rows.
  const typedTotal = totals.input + totals.cacheWrite + totals.cacheRead + totals.output;
  const share = (part: number) => ({ cost_usd: round4(part), pct: pct(part, typedTotal) });

  printJson({
    window_days: days,
    total_usd: round4(total),
    turns,
    sessions,
    by_type: hasTypeSplit
      ? {
        typed_total_usd: round4(typedTotal),
        cache_read: share(totals.cacheRead),
        cache_write: share(totals.cacheWrite),
        output: share(totals.output),
        input: share(totals.input),
      }
      : null,
    // A context warm-up: cache-write, no cache-read, small output.
    cold_starts: coldStartTurns > 0
      ? { turns: coldStartTurns, cost_usd: round4(coldStartCost), pct: pct(coldStartCost, total) }
      : null,
    by_source: allSources.slice(0, MAX_TOP_SOURCES)
      .map(([source, cost]) => ({ source, cost_usd: round4(cost), pct: pct(cost, total) })),
    more_sources: Math.max(0, allSources.length - MAX_TOP_SOURCES),
    // A single-model window learns nothing from a per-model split.
    by_model: Object.keys(modelMap).length < 2 ? [] : Object.entries(modelMap).sort((a, b) => b[1].cost - a[1].cost)
      .map(([model, { cost, byType }]) => ({
        model, cost_usd: round4(cost), pct: pct(cost, total),
        cache_read_usd: round4(byType.cacheRead), cache_write_usd: round4(byType.cacheWrite),
        output_usd: round4(byType.output), input_usd: round4(byType.input),
      })),
    top_sessions: topSessions,
  });
}

export function run(args: string[]): void {
  try {
    report(args);
  } catch (err) {
    failJson(err, 'report_failed');
  }
}
