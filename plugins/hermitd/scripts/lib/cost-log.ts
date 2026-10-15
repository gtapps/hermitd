import type { TaskAttribution } from './tasks';
// Hermit-owned cost-log index: incremental byte-offset tracking + corrupt-line counting.
// cc-compat.js owns the cost-log PATH only; this module owns the record shape and the index.
//
// Index schema (state/cost-index.json):
//   version               — schema version (bump on breaking changes)
//   byte_offset           — position in cost-log.jsonl after last processed line
//   total_cost_usd        — all-time cumulative cost
//   total_tokens          — all-time cumulative tokens
//   total_sessions        — running count of distinct sessions (incremented when session_id changes)
//   last_session_id       — most recent session_id seen (drives total_sessions; bounded, O(1))
//   by_source             — {[source]: {cost, tokens}} buckets
//   by_date               — {[YYYY-MM-DD]: {cost, tokens, session_ids[]}} per-day aggregates,
//                            pruned to the trailing BY_DATE_RETENTION_DAYS window
//   by_week                — {[YYYY-Www]: {cost, tokens}} per-ISO-week aggregates (PROP-016
//                            budget enforcement), pruned to BY_WEEK_RETENTION_WEEKS
//   by_month               — {[YYYY-MM]: {cost, tokens}} per-month aggregates (PROP-016 budget
//                            enforcement), pruned to BY_MONTH_RETENTION_MONTHS
//   skipped_corrupt_lines — count of JSONL lines that failed JSON.parse (Known Limitation #3)
//   updated_at            — ISO timestamp of last index write
//
// by_date/by_week/by_month keys are all derived in the caller-supplied `timezone` (default
// 'UTC') so a budget cap's "daily"/"weekly"/"monthly" window matches the operator's local
// calendar, not the log's UTC timestamps. version 3 (PROP-016) added by_week/by_month and
// tz-aware bucketing — bumped so a v2 index (UTC-only by_date) rebuilds cleanly rather than
// mixing UTC and tz-local keys.
//
// Writers: cost-tracker.ts (Stop hook) and subagent-cost.ts (SubagentStop hook) — each calls
// updateCostIndex right after its own log append, so an async subagent row does not sit
// outside the index until the next Stop turn. Both writes are offset-based folds promoted
// via a pid-suffixed tmp + rename, so a race between them is last-writer-wins over a
// self-consistent {byte_offset, totals} pair, never a torn file or a double count.
// Readers: cost-tracker.ts (getCumulativeCost fallback), doctor-check.ts.

import fs from 'node:fs';
import path from 'node:path';
import { todayYMD, thisWeekKey, thisMonthYYYYMM } from './time';

type Json = any;

const INDEX_VERSION = 4;

// Stamped on every cost row cost-tracker.ts and subagent-cost.ts write. Rows written before
// the prompt-only attribution fix carry no such field, and consumers that need trustworthy
// per-source numbers (doctor's routine-cost) count only v2 rows — an explicit epoch rather
// than a date cutoff, which would drift with each hermit's upgrade time. Lives here with the
// log's other schema versions; the writers import it so the stamp and the filter can't drift.
//
// The v2 epoch is the same commit as the prompt-only turnPromptText fix, so a v2 row is by
// construction classified from a boundary prompt, never a tool_result — which is why the
// routine:<word> buckets minted by the old prose fallback can only be pre-v2. Anchoring
// classifySource on the delivered sentinel line did NOT need a v3: its mis-attributions
// land in the `heartbeat` bucket and in unconfigured routine:<word> keys, and
// checkRoutineCost reads neither (it keys routine:<id> for configured routines only).
const SOURCE_ATTRIBUTION_VERSION = 2;

// Doctor's last-7-day scans read today + the trailing 7 days; keep one extra day of buffer.
const BY_DATE_RETENTION_DAYS = 8;
export const BY_TASK_RETENTION_DAYS = 90;
const BY_WEEK_RETENTION_WEEKS = 14;
const BY_MONTH_RETENTION_MONTHS = 13;

function costIndexPath(hermitRoot: string): string {
  return path.join(path.resolve(hermitRoot), 'state', 'cost-index.json');
}

function readCostIndex(indexPath: string): Json | null {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    if (data && data.version === INDEX_VERSION) return data;
    return null;
  } catch {
    return null;
  }
}

function _emptyIndex(): Json {
  return {
    version: INDEX_VERSION,
    byte_offset: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    total_sessions: 0,
    last_session_id: null,
    by_source: {},
    by_date: {},
    by_task: {},
    by_week: {},
    by_month: {},
    skipped_corrupt_lines: 0,
    updated_at: new Date().toISOString(),
  };
}

function _writeIndex(indexPath: string, index: Json): Json {
  // pid-suffixed tmp so two overlapping writers (e.g. a manual cost-tracker run
  // racing the live session's Stop hook) can't torn-promote each other's
  // half-written tmp — matches lib/pause.ts and lib/alert-state.ts.
  const tmp = `${indexPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, indexPath);
  return index;
}

// Months-ago reference date, via UTC calendar-month subtraction (not ms subtraction —
// months have variable length, so `Date.UTC` normalization is the correct way to land
// on "the same day N months back" for a monthly retention cutoff).
function _monthsAgo(n: number, now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, now.getUTCDate()));
}

// Drop by_date/by_week/by_month buckets older than their retention windows. Keeps the
// index bounded regardless of how long the hermit runs; total_* counters are unaffected.
// `asOf` is the reference "now" for the retention cutoffs (default real clock); tests pin
// it so fixed-date fixtures don't age out of the window as wall-clock time advances.
function _pruneBuckets(index: Json, timezone: string, asOf: Date = new Date()): void {
  const nowMs = asOf.getTime();
  const taskCutoff = todayYMD(timezone, new Date(nowMs - BY_TASK_RETENTION_DAYS * 86400000));
  for (const [id, dates] of Object.entries(index.by_task) as [string, Record<string, unknown>][]) {
    for (const date of Object.keys(dates)) {
      if (date < taskCutoff) delete dates[date];
    }
    if (!Object.keys(dates).length) delete index.by_task[id];
  }
  const dateCutoff = todayYMD(timezone, new Date(nowMs - BY_DATE_RETENTION_DAYS * 86400000));
  for (const date of Object.keys(index.by_date)) {
    if (date < dateCutoff) delete index.by_date[date];
  }
  const weekCutoff = thisWeekKey(timezone, new Date(nowMs - BY_WEEK_RETENTION_WEEKS * 7 * 86400000));
  for (const week of Object.keys(index.by_week)) {
    if (week < weekCutoff) delete index.by_week[week];
  }
  const monthCutoff = thisMonthYYYYMM(timezone, _monthsAgo(BY_MONTH_RETENTION_MONTHS, asOf));
  for (const month of Object.keys(index.by_month)) {
    if (month < monthCutoff) delete index.by_month[month];
  }
}

// Process one log line into the index in-place. `timezone` determines which calendar
// day/week/month the line's timestamp buckets into.
export function allocateTaskShares(row: Json): { task_id: string; cost: number; tokens: number }[] {
  if (row.bucket !== 'tasks') return [];
  const ids: string[] = row.task_ids?.length ? row.task_ids : row.task_id ? [row.task_id] : [];
  return ids.map(task_id => ({
    task_id,
    cost: (row.estimated_cost_usd || 0) / ids.length,
    tokens: (row.total_tokens || 0) / ids.length,
  }));
}

function _processLine(index: Json, line: string, timezone: string): void {
  try {
    const entry = JSON.parse(line);
    const cost = entry.estimated_cost_usd || 0;
    const tokens = entry.total_tokens || 0;
    const sid = entry.cc_session_id || null;
    const source = entry.source || 'other';
    const ts = entry.timestamp ? new Date(entry.timestamp) : null;
    const validTs = ts && !isNaN(ts.getTime()) ? ts : null;
    const date = validTs ? todayYMD(timezone, validTs) : '';
    const week = validTs ? thisWeekKey(timezone, validTs) : '';
    const month = validTs ? thisMonthYYYYMM(timezone, validTs) : '';

    index.total_cost_usd += cost;
    index.total_tokens += tokens;

    // Count a new session each time the session_id changes. Cost-log lines for one
    // session are contiguous (one always-on hermit runs a single session at a time),
    // so tracking only the last id keeps the counter bounded and O(1).
    if (sid && sid !== index.last_session_id) {
      index.total_sessions += 1;
      index.last_session_id = sid;
    }

    if (!index.by_source[source]) index.by_source[source] = { cost: 0, tokens: 0 };
    index.by_source[source].cost += cost;
    index.by_source[source].tokens += tokens;

    if (date) {
      for (const share of allocateTaskShares(entry)) {
        const dates = index.by_task[share.task_id] ??= {};
        const bucket = dates[date] ??= { cost: 0, tokens: 0 };
        bucket.cost += share.cost;
        bucket.tokens += share.tokens;
      }
      if (!index.by_date[date]) index.by_date[date] = { cost: 0, tokens: 0, session_ids: [] };
      index.by_date[date].cost += cost;
      index.by_date[date].tokens += tokens;
      if (sid && !index.by_date[date].session_ids.includes(sid)) {
        index.by_date[date].session_ids.push(sid);
      }
    }
    if (week) {
      if (!index.by_week[week]) index.by_week[week] = { cost: 0, tokens: 0 };
      index.by_week[week].cost += cost;
      index.by_week[week].tokens += tokens;
    }
    if (month) {
      if (!index.by_month[month]) index.by_month[month] = { cost: 0, tokens: 0 };
      index.by_month[month].cost += cost;
      index.by_month[month].tokens += tokens;
    }
  } catch {
    index.skipped_corrupt_lines++;
  }
}

// Read `logPath` and fold every line into `index` in-place, catching read errors
// so a missing/partial log yields partial/empty totals rather than throwing.
// Shared by rebuildCostIndex (writes the result) and computeIndex (read-only) so
// the two loops can't drift apart.
function _foldLogInto(index: Json, logPath: string, timezone: string): void {
  try {
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    if (content) {
      for (const line of content.split('\n')) {
        if (line.trim()) _processLine(index, line, timezone);
      }
    }
  } catch {
    // Non-fatal — partial/absent log gives partial/empty totals
  }
}

// Full O(n) rebuild from scratch. Only called: first run, version mismatch, or log truncation.
function rebuildCostIndex(logPath: string, indexPath: string, timezone: string = 'UTC', asOf: Date = new Date()): Json {
  const index = _emptyIndex();
  index.timezone = timezone; // stamp so a later tz change can be detected and re-bucketed

  let fileSize = 0;
  try {
    fileSize = fs.statSync(logPath).size;
  } catch {
    return _writeIndex(indexPath, index);
  }

  _foldLogInto(index, logPath, timezone);

  index.byte_offset = fileSize;
  _pruneBuckets(index, timezone, asOf);
  index.updated_at = new Date().toISOString();
  return _writeIndex(indexPath, index);
}

// Read-only, in-memory index build from the whole log — same bucketing as
// rebuildCostIndex but WITHOUT writing. For readers (the channel status line) that
// need a correct current-period spend when the on-disk index is stale/version-
// mismatched/absent, but must not write it (cost-tracker is the sole index writer,
// and a paused hermit runs no Stop turn to rebuild it). O(n) in the log size — only
// used on the fallback path, so the steady state stays on the O(1) incremental read.
function computeIndex(logPath: string, timezone: string = 'UTC', asOf: Date = new Date()): Json {
  const index = _emptyIndex();
  index.timezone = timezone;
  _foldLogInto(index, logPath, timezone);
  _pruneBuckets(index, timezone, asOf);
  return index;
}

// Incremental update: read only bytes appended since last call. O(1) in the common case.
// Falls back to rebuildCostIndex when the index is missing, version-mismatched, or the log
// appears truncated (byte_offset > fileSize). `timezone` (default 'UTC') determines the
// by_date/by_week/by_month bucketing — pass config.timezone so budget windows match the
// operator's local calendar.
function updateCostIndex(logPath: string, indexPath: string, timezone: string = 'UTC', asOf: Date = new Date()): Json {
  let fileSize = 0;
  try {
    fileSize = fs.statSync(logPath).size;
  } catch {
    // Log absent — ensure an empty index exists and return it
    const existing = readCostIndex(indexPath);
    if (existing) return existing;
    return _writeIndex(indexPath, _emptyIndex());
  }

  const index = readCostIndex(indexPath);

  // Rebuild triggers: missing/version-stale index, truncated log, OR a timezone
  // change — the by_date/by_week/by_month keys are tz-derived, so after a
  // config.timezone edit the historical buckets are keyed under the old calendar
  // and current-period spend would under-read (a cap could be silently under-enforced)
  // until they refill. Re-bucket the whole log under the new tz, like a version bump.
  if (!index || index.byte_offset > fileSize || index.timezone !== timezone) {
    return rebuildCostIndex(logPath, indexPath, timezone, asOf);
  }

  // No new bytes
  if (index.byte_offset === fileSize) {
    _pruneBuckets(index, timezone, asOf);
    return _writeIndex(indexPath, index);
  }

  // Read only the new bytes
  const newByteCount = fileSize - index.byte_offset;
  let text = '';
  try {
    const buf = Buffer.alloc(newByteCount);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buf, 0, newByteCount, index.byte_offset);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString('utf-8');
  } catch {
    // Non-fatal — skip this increment, try again next call
    return index;
  }

  for (const line of text.split('\n')) {
    if (line.trim()) _processLine(index, line, timezone);
  }

  index.byte_offset = fileSize;
  _pruneBuckets(index, timezone, asOf);
  index.updated_at = new Date().toISOString();
  return _writeIndex(indexPath, index);
}

// Per-source cost AND run count from the cost log alone, used by doctor-check.ts's
// routine-cost check.
//
// Both quantities come from one population — rows stamped
// `source_attribution_version: 2`, i.e. written after the prompt-only attribution fix.
// Earlier rows are skipped entirely: their `source` could be captured by any tool output
// that merely named a routine id, so a lifetime numerator built from them is not a
// measurement of anything. That replaces the previous two-mechanism join (transcript-
// classified cost over shell-stamped fire counts from routine-metrics.jsonl), whose two
// sides could cover different windows and inflate $/run into false warns (#573).
//
//   cost — every v2 row for the source, subagent rows included. Async subagent rows are
//          stamped at SubagentStop and can land hours after the launch turn while
//          inheriting its source; they are real cost of that source, so no time window
//          is applied.
//   runs — v2 rows where `subagent !== true` AND `source_inherited !== true`: exactly one
//          per invocation of the source. A CronCreate-delivered skip still woke the model
//          and so counts; a routine-monitor skip never woke it and writes no row, so it
//          cannot dilute $/run. `source_inherited` rows are subagent-completion ingestion
//          turns that cost-tracker's dispatch hop attributed back to the dispatching
//          source — real cost of that source, but a second billed turn for the SAME fire,
//          so counting them would halve the reported $/run of any delegating routine.
function scanRoutineLedger(costLogFile: string): Map<string, { cost: number; runs: number }> {
  const totals = new Map<string, { cost: number; runs: number }>();
  if (!fs.existsSync(costLogFile)) return totals;
  for (const line of fs.readFileSync(costLogFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.source_attribution_version !== SOURCE_ATTRIBUTION_VERSION) continue;
      const src = e.source;
      if (typeof src !== 'string') continue;
      const acc = totals.get(src) || { cost: 0, runs: 0 };
      acc.cost += e.estimated_cost_usd || 0;
      if (e.subagent !== true && e.source_inherited !== true) acc.runs += 1;
      totals.set(src, acc);
    } catch { /* skip corrupt lines — checkCost already surfaces corruption */ }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Row construction. The two shapes below are the record schema this module's
// header claims to own; they used to be object literals at the three append
// sites, and the subagent shape was spelled out twice (cost-tracker's sync path
// and subagent-cost's async hook) with no test tying the copies together.
//
// Optional keys are spread, never set to a falsy default: consumers distinguish
// "field absent" (a row written before the field existed, or a turn it does not
// apply to) from "field present and zero". `observed_at`, `source_inherited`,
// `model_unpriced` and `max_prompt_tokens` all carry that distinction — see
// cost-tracker's duplicate guard and the hygiene readers.
// ---------------------------------------------------------------------------

type MainCostObservation = {
  taskAttribution?: TaskAttribution;
  timestamp?: string;
  ccSessionId: string;
  /** Only stamped when the writing session is marked a guest, never as `false`. */
  guest?: boolean;
  source: string;
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  apiCalls: number;
  maxPromptTokens: number;
  /** Absent on rows written before the field existed — never defaulted. */
  observedAt?: string | null;
  lastCallPromptTokens: number;
  contextUsage: Json;
  estimatedCostUsd: number;
  modelUnpriced: boolean;
  /** Only stamped when the source came from a dispatch hop, never as `false`. */
  sourceInherited?: boolean;
  /** Write-time breakdown; absent on rows built without it. */
  costByType?: { input: number; cache_write: number; cache_read: number; output: number };
};

type SubagentCostObservation = {
  taskAttribution?: TaskAttribution;
  timestamp?: string;
  source: string;
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  agentType: string;
  /** false → the transcript carried no model; `model` is a sonnet-default guess. */
  modelResolved: boolean;
  estimatedCostUsd: number;
  /** Write-time breakdown; absent on rows built without it. */
  costByType?: { input: number; cache_write: number; cache_read: number; output: number };
};

function buildMainCostRow(o: MainCostObservation): Json {
  return {
    task_id: o.taskAttribution?.task_id ?? null,
    bucket: o.taskAttribution?.bucket ?? (o.source === 'heartbeat' || o.source.startsWith('routine:') ? 'duties' : 'conversation'),
    attribution: o.taskAttribution?.attribution ?? 'source',
    ...(o.taskAttribution?.task_ids ? { task_ids: o.taskAttribution.task_ids } : {}),
    timestamp: o.timestamp ?? new Date().toISOString(),
    cc_session_id: o.ccSessionId,
    ...(o.guest ? { guest: true } : {}),
    source: o.source,
    model: o.model,
    input_tokens: o.inputTokens,
    cache_write_tokens: o.cacheWriteTokens,
    cache_read_tokens: o.cacheReadTokens,
    output_tokens: o.outputTokens,
    total_tokens: o.totalTokens,
    api_calls: o.apiCalls,
    max_prompt_tokens: o.maxPromptTokens,
    ...(o.observedAt ? { observed_at: o.observedAt } : {}),
    last_call_prompt_tokens: o.lastCallPromptTokens,
    context_usage: o.contextUsage,
    estimated_cost_usd: o.estimatedCostUsd,
    model_unpriced: o.modelUnpriced,
    source_attribution_version: SOURCE_ATTRIBUTION_VERSION,
    ...(o.sourceInherited ? { source_inherited: true } : {}),
    ...(o.costByType ? { cost_by_type: o.costByType } : {}),
  };
}

function buildSubagentCostRow(o: SubagentCostObservation): Json {
  return {
    task_id: o.taskAttribution?.task_id ?? null,
    bucket: o.taskAttribution?.bucket ?? (o.source === 'heartbeat' || o.source.startsWith('routine:') ? 'duties' : 'conversation'),
    attribution: o.taskAttribution?.attribution ?? 'source',
    ...(o.taskAttribution?.task_ids ? { task_ids: o.taskAttribution.task_ids } : {}),
    timestamp: o.timestamp ?? new Date().toISOString(),
    source: o.source,
    model: o.model,
    input_tokens: o.inputTokens,
    cache_write_tokens: o.cacheWriteTokens,
    cache_read_tokens: o.cacheReadTokens,
    output_tokens: o.outputTokens,
    total_tokens: o.totalTokens,
    api_calls: 0,
    subagent: true,
    agent_type: o.agentType,
    model_resolved: o.modelResolved,
    context_usage: null,
    estimated_cost_usd: o.estimatedCostUsd,
    source_attribution_version: SOURCE_ATTRIBUTION_VERSION,
    ...(o.costByType ? { cost_by_type: o.costByType } : {}),
  };
}

/**
 * Appends rows in one write. Order matters: a turn's main row precedes the
 * subagent rows it dispatched, which is what the watchdog's newest-main-row
 * lookup and cost-tracker's duplicate guard both assume.
 */
function appendCostRows(costLogFile: string, rows: Json[]): void {
  if (!rows.length) return;

  const serializedRows = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const fd = fs.openSync(costLogFile, 'a+');
  try {
    let needsSeparator = false;
    const size = fs.fstatSync(fd).size;
    if (size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      needsSeparator = fs.readSync(fd, lastByte, 0, 1, size - 1) === 1
        && lastByte[0] !== 0x0a;
    }

    fs.appendFileSync(fd, (needsSeparator ? '\n' : '') + serializedRows, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

// Per-routine cost inside a time window, for the routine-health digest.
//
// Distinct from scanRoutineLedger, which is lifetime-scoped and covers every source
// for the doctor's $/run check. This one is windowed, routine-only, and keeps the
// co-fire bucket separate: `routine:multi` is what trigger-source.ts writes when one
// wake serves two or more routines, so that spend is real but unattributable to any
// single routine — folding it into a per-routine total would invent an attribution
// the ledger deliberately refused to make.
//
// Same v2-only population as scanRoutineLedger: earlier rows' `source` could be set
// by any tool output that merely named a routine id.
function scanRoutineCostWindow(costLogFile: string, sinceMs: number, asOfMs: number): {
  perRoutine: Map<string, number>;
  multi: number;
} {
  const perRoutine = new Map<string, number>();
  let multi = 0;
  if (!fs.existsSync(costLogFile)) return { perRoutine, multi };
  let lines: string[];
  try {
    lines = fs.readFileSync(costLogFile, 'utf8').split('\n');
  } catch {
    return { perRoutine, multi };
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.source_attribution_version !== SOURCE_ATTRIBUTION_VERSION) continue;
      const src = e.source;
      if (typeof src !== 'string' || !src.startsWith('routine:')) continue;
      const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
      if (isNaN(ts) || ts < sinceMs || ts > asOfMs) continue;
      const cost = e.estimated_cost_usd || 0;
      if (src === 'routine:multi') { multi += cost; continue; }
      const id = src.slice('routine:'.length);
      perRoutine.set(id, (perRoutine.get(id) || 0) + cost);
    } catch { /* skip corrupt lines — checkCost already surfaces corruption */ }
  }
  return { perRoutine, multi };
}

// Counts JSONL lines flagged model_unpriced:true (cost-tracker.ts marks a turn this way
// when resolvePricing(raw).exact is false; still priced via resolvePricing's fallback, but flagged
// so the drift is auditable).
function scanUnpricedModels(costLogFile: string, sinceDateInclusive: string, timezone: string = 'UTC'): { count: number; cost: number } {
  let count = 0;
  let cost = 0;
  if (!fs.existsSync(costLogFile)) return { count, cost };
  for (const line of fs.readFileSync(costLogFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.model_unpriced) continue;
      const ts = e.timestamp ? new Date(e.timestamp) : null;
      const date = ts && !isNaN(ts.getTime()) ? todayYMD(timezone, ts) : '';
      if (date >= sinceDateInclusive) {
        count += 1;
        cost += e.estimated_cost_usd || 0;
      }
    } catch { /* skip corrupt lines */ }
  }
  return { count, cost };
}

export { costIndexPath, readCostIndex, computeIndex, updateCostIndex, rebuildCostIndex, scanUnpricedModels, scanRoutineLedger, scanRoutineCostWindow, buildMainCostRow, buildSubagentCostRow, appendCostRows, SOURCE_ATTRIBUTION_VERSION };
export type { MainCostObservation, SubagentCostObservation };
