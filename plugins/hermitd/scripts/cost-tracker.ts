import { resolveTaskAttribution, consumeTaskBinding } from './lib/tasks';
// Adapted from Everything Claude Code (https://github.com/affaan-m/everything-claude-code)
// Original: scripts/hooks/cost-tracker.js — MIT License
// Tracks usage and cost with Hermit attribution.

import fs from 'node:fs';
import path from 'node:path';

import { calculateCost, resolvePricing, type CostByType } from './lib/pricing';
import { kStr } from './lib/format';
import { sessionId as ccSessionId, transcriptPath as ccTranscriptPath, readTailLines, entryText, isToolResult, isTurnBoundary, extractUsage, foldUsageByRequest, isCompactBoundary, turnPromptText, toolUseNames, costLogPath, hermitDir } from './lib/cc-compat';
import { costIndexPath, updateCostIndex, buildMainCostRow, buildSubagentCostRow, appendCostRows } from './lib/cost-log';
import { todayYMD, thisWeekKey, thisMonthYYYYMM, friendlyBoundary } from './lib/time';
import { mutateOwnedAlerts, budgetAlertsPath } from './lib/alert-state';
import { readSettledConfig } from './lib/config-read';
import { setPause, isPaused } from './lib/pause';
import { evaluateBudget, pauseBoundary } from './lib/budget';
import { sendOperatorNotice } from './lib/channel-send';
import { BUDGET, resolveLocale, type Locale } from './lib/messages';
import { classifySource } from './lib/trigger-source';
import { runtimeTmpPath } from './lib/runtime';
import { readContextSurface, writeContextSurface } from './lib/context-surface';
import { MAX_PLAUSIBLE_PROMPT_TOKENS } from './lib/context-signal';
import { isGuest } from './lib/guest-marker';
import { ownsResidentIdentity } from './lib/session-registry';
import { emit, exitError } from './lib/cli';

type Json = any;

const MAX_STDIN = 1024 * 1024; // 1MB safety limit
const HERMIT_DIR = hermitDir();
const COST_LOG = costLogPath(HERMIT_DIR);
const COST_INDEX = costIndexPath(HERMIT_DIR);
const RUNTIME_JSON = path.join(HERMIT_DIR, 'state', 'runtime.json');
const RUNTIME_JSON_TMP = runtimeTmpPath(path.join(HERMIT_DIR, 'state'));
const HEARTBEAT_FILE = path.join(HERMIT_DIR, 'state', '.heartbeat');
const BUDGET_ALERTS = budgetAlertsPath(HERMIT_DIR);

let _runtimeCache: Json;
function readRuntimeJsonCached(): Json {
  if (_runtimeCache !== undefined) return _runtimeCache;
  try {
    _runtimeCache = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8'));
  } catch {
    _runtimeCache = {};
  }
  return _runtimeCache;
}

function touchHeartbeat(): void {
  try {
    const now = new Date();
    fs.utimesSync(HEARTBEAT_FILE, now, now);
  } catch {
    try { fs.writeFileSync(HEARTBEAT_FILE, '', 'utf-8'); } catch {}
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function costByTypeField(byType: CostByType): { input: number; cache_write: number; cache_read: number; output: number } {
  return {
    input: round4(byType.input),
    cache_write: round4(byType.cacheWrite),
    cache_read: round4(byType.cacheRead),
    output: round4(byType.output),
  };
}

function priceUsage(model: string, tokens: {
  inputTokens: number; cacheWriteTokens: number; cacheWrite1hTokens?: number;
  cacheReadTokens: number; outputTokens: number; fast?: boolean;
}): { total: number; costByType: { input: number; cache_write: number; cache_read: number; output: number } } {
  // Clamped: the 1h split and the cache-write total are folded per request as
  // independent maxima, so a disagreeing pair could otherwise yield a negative 5m
  // component and a cost below the real figure.
  const cacheWrite1h = Math.min(tokens.cacheWrite1hTokens || 0, tokens.cacheWriteTokens);
  const priced = calculateCost(model, {
    input: tokens.inputTokens,
    cacheWrite5m: tokens.cacheWriteTokens - cacheWrite1h,
    cacheWrite1h,
    cacheRead: tokens.cacheReadTokens,
    output: tokens.outputTokens,
    fast: tokens.fast,
  });
  return { total: round4(priced.total), costByType: costByTypeField(priced.byType) };
}

// A subagent-completion notification: CC opens a turn with this when a dispatched
// agent comes to rest, and that ingestion turn is real cost caused by whatever
// dispatched the agent. The prompt itself carries no routine/heartbeat marker, so
// prompt-only classification would bucket it as 'other' — resolveTurnSource hops
// from these ids back to the dispatching turn instead. Measured on live hermit
// transcripts: every such notification carried a <task-id>, and the dispatch was
// locatable in-transcript for 264 of 265 of them.
const RE_TASK_ID = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/;
const RE_TOOL_USE_ID = /<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>/;

// Classify a turn by its delivered prompt, hopping once through a subagent-completion
// notification to the turn that dispatched it.
//
// The prompt-only rule (turnPromptText) hands classifySource the entry that opened the
// turn, never the tool_results inside it, so the classifier can anchor on the sentinel
// line a wake actually delivered. Scanning the whole turn instead billed any turn whose
// tool output merely named a routine — e.g. heartbeat-restart's re-arm, whose
// CronDelete/CronList output lists concrete routine ids.
//
// `boundaryFound` is false when the walk ran off the start of a truncated tail window;
// the caller downgrades to 'other' rather than trust a prompt that may belong to an
// earlier turn.
//
// `inherited` is true only when the source came from the dispatch hop rather than this
// turn's own prompt. Such a turn is real cost of the dispatching source but it is NOT an
// independent invocation of it — a routine that dispatches an async agent produces two
// billed main turns (the wake and the completion ingestion) for one fire. Consumers that
// divide cost by invocations (doctor's routine-cost $/run) must not count the second, so
// the flag is persisted on the cost row; see lib/cost-log.ts scanRoutineLedger.
function resolveTurnSource(lines: string[], billedIndex: number): { source: string; boundaryFound: boolean; inherited: boolean } {
  const prompt = turnPromptText(lines, billedIndex);
  const direct = classifySource(prompt.text);
  if (direct !== 'other' || !prompt.boundaryFound) {
    return { source: direct, boundaryFound: prompt.boundaryFound, inherited: false };
  }
  // Unclassified: if this turn opened on a subagent-completion notification, attribute it
  // to the dispatching turn. Prefer the tool-use id (present on tool-dispatched agents),
  // falling back to the task id. One hop only — a dispatch turn is itself a real prompt.
  const ids = [RE_TOOL_USE_ID.exec(prompt.text)?.[1], RE_TASK_ID.exec(prompt.text)?.[1]].filter(Boolean) as string[];
  for (const id of ids) {
    for (let j = prompt.index - 1; j >= 0; j--) {
      if (!lines[j].includes(id)) continue;
      let e: Json;
      try { e = JSON.parse(lines[j]); } catch { continue; }
      // Match the dispatch STRUCTURALLY, not on "this line contains the id". An agent's id
      // appears on several earlier lines — CC can notify more than once for one task — and a
      // first-substring-match returns the nearest of those, which is a real user entry, so
      // turnPromptText stops on the notification itself and classifies 'other'.
      if (e.type === 'assistant') {
        // The dispatch site: the entry that emitted the tool_use block carrying this id.
        // Walks from j exclusive; the fallback below passes j+1 because ITS j is a user entry
        // that may itself be the dispatching turn's prompt (the Agent tool_result case).
        if (!toolUseNames(e).some(t => t.id === id)) continue;
        return { source: classifySource(turnPromptText(lines, j).text), boundaryFound: true, inherited: true };
      }
      // A sibling completion notification for the same agent is never the dispatch — keep
      // walking. Narrow on purpose: every other non-classifying match still stops the scan.
      if (RE_TASK_ID.test(entryText(e))) continue;
      return { source: classifySource(turnPromptText(lines, j + 1).text), boundaryFound: true, inherited: true };
    }
  }
  return { source: 'other', boundaryFound: true, inherited: false };
}

// classifySource moved to lib/trigger-source.ts (imported above, re-exported below)
// so transcript-digest.ts can classify wake sources without importing this module
// (whose load-time HERMIT_DIR init would pollute in-process test cwd resolution).

// Collect Agent tool_results from the current turn window.
// Inert on current CC (431 async launches, 0 sync results with `usage`, verified
// 2026-09-05); every subagent row comes from subagent-cost.ts. Left as-is for the
// sync path. Subagent assistant entries live in separate transcript files and never
// appear here; only the Agent tool_result (type:'user' with toolUseResult.usage) does.
// extractUsage skips these because they aren't type:'assistant', so collect them
// explicitly or their tokens vanish from the ledger.
// Limitation: shares sumTurnUsage's TAIL_BYTES window — a turn larger than the 512KB tail
// is scanned from buffer start, so a prior turn's dispatch can bleed in. Same rare
// over-count as the main-turn sum, accepted for the same reason.
function collectSubagentUsage(lines: string[], billedIndex: number): Array<{
  model: string; inputTokens: number; cacheWriteTokens: number;
  cacheReadTokens: number; outputTokens: number; agentType: string;
}> {
  const out: Array<{
    model: string; inputTokens: number; cacheWriteTokens: number;
    cacheReadTokens: number; outputTokens: number; agentType: string;
  }> = [];
  for (let j = billedIndex; j >= 0; j--) {
    try {
      const e = JSON.parse(lines[j]);
      const r = e.toolUseResult;
      if (e.type === 'user' && r && r.agentType && r.usage) {
        const u = r.usage;
        out.push({
          model: r.resolvedModel || '',
          inputTokens: u.input_tokens || 0,
          cacheWriteTokens: u.cache_creation_input_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          agentType: r.agentType,
        });
      }
      // Same turn boundary as sumTurnUsage: the first non-tool_result user entry.
      // Deliberately looser than resolveTurnSource's boundary, which additionally skips
      // structured injections (isSkillInjection). This one decides which tokens are
      // summed, so tightening it would move billed amounts, not just labels — don't
      // "align" the two without re-measuring cost totals.
      if (e.type === 'user' && !isToolResult(e)) break;
    } catch {}
  }
  return out;
}

// Limitation: a turn spanning more than the tail window it was handed is summed from buffer
// start, not the real boundary — token counts still over-count in this case (deliberately:
// discarding real token data would be worse than a bounded over-count). Source attribution no
// longer shares this bleed — see the boundaryFound guard in scanTurnInTail().
function sumTurnUsage(lines: string[], billedIndex: number, billedSince?: string): {
  inputTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number;
  cacheReadTokens: number; outputTokens: number; model: string;
  apiCalls: number; maxPromptTokens: number; fast: boolean;
} {
  const collected: ReturnType<typeof extractUsage>[] = [];
  for (let j = billedIndex; j >= 0; j--) {
    try {
      const entry = JSON.parse(lines[j]);
      if (billedSince !== undefined && entry.timestamp <= billedSince) break;
      const usage = extractUsage(entry);
      if (usage) collected.push(usage);
      // With a previous billed row, sum every newer call across user entries. Otherwise
      // stop at the real opening prompt: mid-turn skill injections used to drop calls.
      if (billedSince === undefined && isTurnBoundary(entry)) break;
    } catch {}
  }

  // The per-turn sum below bills every API request the turn made (streamed chunks of
  // one requestId fold to one), so a multi-tool-call turn logs a multiple of its
  // actual context size. Consumers that care about context size (watchdog's
  // context-hygiene thresholds) need the single largest call instead — that's the
  // real prompt the model was holding at its fullest point in the turn.
  const folded = foldUsageByRequest(collected.filter((u): u is NonNullable<typeof u> => u !== null));
  let inputTokens = 0, cacheWriteTokens = 0, cacheWrite1hTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  let maxPromptTokens = 0;
  let fast = false;
  for (const usage of folded) {
    inputTokens += usage.inputTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    cacheWrite1hTokens += usage.cacheWrite1hTokens;
    cacheReadTokens += usage.cacheReadTokens;
    outputTokens += usage.outputTokens;
    if (usage.fast) fast = true;
    const callPrompt = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
    if (callPrompt > maxPromptTokens) maxPromptTokens = callPrompt;
  }
  // Model is constant within a turn; capture it once from the outermost call
  // (collected newest-first, so folded[0] is the billedIndex entry's request).
  const model = folded.length > 0 ? folded[0].model : 'sonnet';

  return { inputTokens, cacheWriteTokens, cacheWrite1hTokens, cacheReadTokens, outputTokens, model, apiCalls: folded.length, maxPromptTokens, fast };
}

// Peak prompt size (input + cache) over the calls made since the turn's last compaction,
// seeded with the last billed call. The max rather than the newest entry alone, because a
// trailing entry with a degenerate/partial `usage` (cache fields absent → extractUsage
// zeroes them) would otherwise report a near-empty context and blind both hygiene tiers.
// Prompts grow monotonically within a segment, so this equals the newest call in the
// normal case. Boundary checks mirror sumTurnUsage's, for a different purpose: context
// size at a point in time, not the turn's total bill.
function peakPromptTokensSinceCompaction(lines: string[], billedIndex: number, seed: number): number {
  let peak = seed;
  for (let j = billedIndex - 1; j >= 0; j--) {
    let prev: Json;
    try { prev = JSON.parse(lines[j]); } catch { continue; }
    if (isCompactBoundary(prev)) break;                      // older calls describe a dead context
    if (prev.type === 'user' && !isToolResult(prev)) break;  // turn boundary (same as sumTurnUsage)
    const usage = extractUsage(prev);
    if (!usage) continue;
    const prompt = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
    if (prompt > peak) peak = prompt;
  }
  return peak;
}

// One pass over a single tail window: find the last billed entry and resolve the turn it
// belongs to. `boundaryMissed` reports the one condition worth reading again — the window
// was truncated AND the turn's own prompt fell outside it — which forces the source to
// 'other' and starts the token sum mid-turn. Any fs error means "no usable data": null.
function scanTurnInTail(transcriptPath: string, tailBytes: number, billedSince?: string): Json {
  try {
    const { lines, readFrom } = readTailLines(transcriptPath, tailBytes);

    // A half-written trailing record means CC is still flushing this turn. Scanning past
    // it finds an OLDER turn's usage and bills it again under a fresh timestamp — measured
    // live on a production hermit, where a pre-compaction turn was re-billed hours later
    // and its dead 173k context then drove a needless watchdog compaction. Bill nothing;
    // the next Stop sees a complete tail. Unbilled beats double-billed.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try { JSON.parse(lines[i]); } catch { return null; }
      break;
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        // Reaching a compaction boundary before any usage means every remaining entry
        // describes a context CC already destroyed — never bill or measure it.
        if (isCompactBoundary(entry)) return null;
        const usage = extractUsage(entry);
        if (!usage) continue;

        // Found the last billed entry — sum the whole turn.
        const summed = sumTurnUsage(lines, i, billedSince);
        // Context size at the END of the turn, for the hygiene thresholds — not the
        // turn-wide max, which would still report the pre-compaction peak for a turn that
        // compacted mid-flight. Paired with the source-side timestamp so consumers can
        // tell when the context was observed, not when the row was written.
        const lastCallPromptTokens = peakPromptTokensSinceCompaction(
          lines, i, usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens,
        );
        const observedAt = typeof entry.timestamp === 'string' ? entry.timestamp : '';

        const resolved = resolveTurnSource(lines, i);
        // A truncated tail (readFrom > 0) whose turn boundary fell outside the window
        // can't be trusted — the prompt found may belong to an earlier, unrelated turn
        // still in the window. Attribute to 'other' rather than risk misattributing a
        // large turn (e.g. a plugin upgrade run) to an unrelated source. Belt-and-braces
        // as written: resolveTurnSource already returns 'other'/not-inherited whenever
        // boundaryFound is false (turnPromptText hands it an empty text), so `trusted`'s
        // only outcome-changing consumer is the boundaryMissed re-read signal below.
        const trusted = resolved.boundaryFound || readFrom <= 0;
        const source = trusted ? resolved.source : 'other';
        const sourceInherited = trusted && resolved.inherited;
        const subagents = collectSubagentUsage(lines, i);
        return { ...summed, source, sourceInherited, subagents, observedAt, lastCallPromptTokens, tailLines: lines, boundaryMissed: !trusted };
      } catch {}
    }
  } catch {}
  return null;
}

function readLastTurnUsage(transcriptPath: string, billedSince?: string): Json {
  const TAIL_BYTES = 524288; // 512KB — covers most multi-step agentic turns
  // A long routine run (evolve, weekly-scan, weekly-review) can write more transcript
  // than that in one turn. Its prompt then sits outside the window, so the turn bills to
  // 'other' with a mid-turn token sum — and those runs are exactly the expensive ones the
  // ledger needs right. Read again at the cap when that happens.
  //
  // ONE retry, not a doubling ladder: each Stop bills exactly one turn, so there is never
  // a second boundary further back to walk to. A single wider read reaches as far as the
  // cap ever will, and a turn still unbounded at 8MB keeps the 'other' downgrade.
  const RETRY_TAIL_BYTES = 8 * 1024 * 1024; // 8MB
  const turn = scanTurnInTail(transcriptPath, TAIL_BYTES, billedSince);
  if (turn && turn.boundaryMissed) {
    const wide = scanTurnInTail(transcriptPath, RETRY_TAIL_BYTES, billedSince);
    // Usage and source come from the wider read; `tailLines` stays narrow. Its one
    // consumer, maybeDeriveSurface, takes the NEWEST compact_boundary in the lines it is
    // handed, so widening can only reach boundaries OLDER than 512KB would ever see —
    // the ones its own comment assumes were recorded on an earlier Stop. Since
    // state/context-surface.json is folder-wide, replaying one rewrites the record (and
    // its prev chain) backwards to a stale boundary.
    return wide ? { ...wide, tailLines: turn.tailLines } : turn;
  }
  return turn;
}

// Fixed-surface derivation (state/context-surface.json): when the tail contains a
// compact_boundary not yet recorded, the earliest assistant call after it minus the
// boundary's compactMetadata.postTokens (the summarized conversation alone) is an
// upper bound on this hermit's fixed surface — the input the watchdog's compact
// gate subtracts. Runs on the tail readLastTurnUsage already read; a boundary
// outside that window was recorded on an earlier Stop. The record is folder-wide, not
// resident-owned: any session in the folder that hits a boundary refreshes it, and that is
// deliberate — the surface is near-identical across sessions in one project, and gating the
// write would starve a resident that rarely compacts back to ASSUMED_SURFACE_TOKENS.
// peakPromptTokensSinceCompaction
// cannot be reused here: it breaks at the turn's user-entry boundary before ever
// reaching the compact_boundary record. postTokens is an uncontracted harness field
// (probe-verified, not documented), so every branch validates and skips rather than
// guesses — a failed derivation keeps the previous record.
function maybeDeriveSurface(lines: string[]): void {
  try {
    // Cheap prefilter: boundaries are rare (one per compaction) but this runs on
    // every Stop, and the backward scan below JSON.parses the whole tail when no
    // boundary exists — the common case. A substring miss is an exact negative
    // (isCompactBoundary can't match without the literal appearing); a false
    // positive just falls through to the precise parse loop.
    if (!lines.some(l => l.includes('compact_boundary'))) return;

    let boundaryIdx = -1;
    let boundary: Json = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: Json;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (isCompactBoundary(e)) { boundaryIdx = i; boundary = e; break; }
    }
    if (boundaryIdx < 0) return;
    const boundaryAt: string = typeof boundary.timestamp === 'string' ? boundary.timestamp : '';
    if (!boundaryAt) return;
    const existing = readContextSurface(HERMIT_DIR);
    if (existing && existing.boundary_at === boundaryAt) return; // already recorded
    const postTokens = boundary.compactMetadata?.postTokens;
    if (typeof postTokens !== 'number' || !Number.isFinite(postTokens) || postTokens <= 0) return;
    // Earliest assistant call after the boundary — extractUsage is assistant-only,
    // so subagent tool_result usage can never be picked up here.
    for (let j = boundaryIdx + 1; j < lines.length; j++) {
      let e: Json;
      try { e = JSON.parse(lines[j]); } catch { continue; }
      const usage = extractUsage(e);
      if (!usage) continue;
      const surface = (usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens) - postTokens;
      // Implausible — never guess from this call, but keep scanning rather than
      // abandoning the boundary. A degenerate/partial `usage` (the shape
      // peakPromptTokensSinceCompaction defends against) on the earliest post-boundary
      // call would otherwise fail this boundary for good: nothing is written, so every
      // later Stop re-selects the same call until the boundary leaves the tail window.
      // A later call only inflates the result, and the record is an upper bound — the
      // compact gate still errs toward firing later, never earlier.
      if (surface <= 0 || surface > MAX_PLAUSIBLE_PROMPT_TOKENS) continue;
      writeContextSurface(HERMIT_DIR, {
        surface_upper_bound_tokens: surface,
        post_tokens: postTokens,
        boundary_at: boundaryAt,
        observed_at: typeof e.timestamp === 'string' ? e.timestamp : '',
        prev: existing
          ? { surface_upper_bound_tokens: existing.surface_upper_bound_tokens, boundary_at: existing.boundary_at }
          : null,
      });
      return;
    }
  } catch {}
}

// Newest main (non-subagent) row THIS session already logged — the duplicate check in
// run() compares against it. Tail-read: the log is append-only and unbounded, so a full
// parse on every turn is exactly the cost this codebase avoids elsewhere (see
// updateCostIndex).
//
// Matching on cc_session_id here rather than at the comparison: the newest main row in a
// hatched folder belongs to whichever session wrote last, so a guest row landing between
// this session's turn and a retry of its Stop hook would leave the newest row unmatchable
// and skip the guard entirely — double-billing the turn and republishing its context size.
// Legacy rows carry no cc_session_id and so never match, which fails open exactly as a
// missing observed_at does.
function lastLoggedMainRow(ccSessionId: string): Json {
  // Wide enough that the subagent rows a fan-out turn appends AFTER its main row can't
  // push that main row out of the window — a turn dispatching ~25 agents writes ~15KB of
  // them, which would silently disable the guard on exactly the heaviest turns. Other
  // sessions' rows consume the same window; overflowing it fails open, never closed.
  const TAIL_BYTES = 131072;
  try {
    const { lines } = readTailLines(COST_LOG, TAIL_BYTES);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const row = JSON.parse(lines[i]);
        if (row && row.subagent !== true && row.cc_session_id === ccSessionId) return row;
      } catch {}
    }
  } catch {}
  return null;
}

function parseLogEntries(): Json[] {
  try {
    const content = fs.readFileSync(COST_LOG, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').reduce((acc: Json[], line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
  } catch {
    return [];
  }
}

// Fresh-reads runtime.json (bypassing the per-run cache, to avoid clobbering a
// field written by another process since the cache was populated), applies a set
// of field updates, and writes back atomically. Skips silently if runtime.json
// can't be read; never fabricates a partial runtime file.
function writeRuntimeFields(fields: Record<string, Json>): void {
  let runtime: Json;
  try {
    runtime = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf-8'));
  } catch {
    return;
  }
  Object.assign(runtime, fields);
  fs.writeFileSync(RUNTIME_JSON_TMP, JSON.stringify(runtime, null, 2) + '\n', 'utf-8');
  fs.renameSync(RUNTIME_JSON_TMP, RUNTIME_JSON);
}

// Bound on the budget push, kept well under the Stop pipeline's 15s hook budget
// so a slow/hung platform API can't starve the pipeline's remaining stages.
const BUDGET_PUSH_TIMEOUT_MS = 6000;

// Operator-language push for the periods that just newly crossed a warn/breach
// threshold this tick (never for periods whose alert already existed — see the
// create-only dedup in applyBudgetCheck). Breached and warned periods are framed
// separately so a warn batched with a breach isn't mislabeled "cap reached".
// This is the maintainer-tier text (full USD/cap/ratio detail). Exported for tests.
function composeBudgetMessage(newPeriods: Json[], action: 'alert' | 'pause', until: string | null, timezone: string, locale: Locale = 'en'): string {
  const B = BUDGET[locale];
  const clause = (p: Json) =>
    B.clause(B.periodPossessive(p.period), p.spend, p.cap, Math.round(p.ratio * 100));
  const breached = newPeriods.filter((p) => p.level === 'breach');
  const warned = newPeriods.filter((p) => p.level === 'warn');
  if (breached.length > 0) {
    let msg = B.capReachedPrefix() + breached.map(clause).join('; ');
    if (warned.length > 0) msg += B.alsoApproaching() + warned.map(clause).join('; ');
    if (action === 'pause' && until) msg += B.pausedUntilSuffix(friendlyBoundary(until, timezone));
    return `${msg}.`;
  }
  return B.headsUpPrefix() + warned.map(clause).join('; ') + '.';
}

// Record `notified: true` on already-persisted budget alert entries via a fresh
// read-modify-write, so the confirmation write reflects current on-disk state
// rather than a snapshot taken before the (awaited) send. Fail-open.
function markAlertNotified(alerts: Json, key: string): void {
  const entry = alerts[key];
  if (entry && !entry.notified) entry.notified = true;
}

function markBudgetNotified(newPeriods: Json[], periodKey: Record<string, string>): void {
  mutateOwnedAlerts(BUDGET_ALERTS, (alerts) => {
    for (const p of newPeriods) {
      markAlertNotified(alerts, `budget-${p.level}:${p.period}:${periodKey[p.period]}`);
    }
  });
}

// PROP-016 budget enforcement: compare this turn's freshly-updated index against
// config.budget's caps and, on a breach/warn, write a deduped alert-state entry
// (one per period per level — `budget-<level>:<period>:<period-key>`, create-only so
// a re-detected breach later the same period never resets `notified` back to false)
// and, for `action:"pause"`, set the PROP-015 pause flag with an auto-resume boundary.
// Newly-created entries also get a direct channel push; `notified` is only
// flipped true on a confirmed send, so a failed send leaves the existing
// `heartbeat.ts precheck` EVALUATE wake as the fallback announcement path.
// Fail-open throughout — never throws, since run()'s caller must never be blocked by
// this check.
async function applyBudgetCheck(costIdx: Json, timezone: string, budgetConfig: Json, locale: Locale = 'en'): Promise<void> {
  try {
    if (!budgetConfig || typeof budgetConfig !== 'object') return;
    const caps = {
      daily_usd: typeof budgetConfig.daily_usd === 'number' ? budgetConfig.daily_usd : null,
      weekly_usd: typeof budgetConfig.weekly_usd === 'number' ? budgetConfig.weekly_usd : null,
      monthly_usd: typeof budgetConfig.monthly_usd === 'number' ? budgetConfig.monthly_usd : null,
    };
    if (caps.daily_usd === null && caps.weekly_usd === null && caps.monthly_usd === null) return; // inert
    const action: 'alert' | 'pause' = budgetConfig.action === 'pause' ? 'pause' : 'alert';

    const periodKey = { daily: todayYMD(timezone), weekly: thisWeekKey(timezone), monthly: thisMonthYYYYMM(timezone) };
    const result = evaluateBudget({
      dailySpend: costIdx?.by_date?.[periodKey.daily]?.cost || 0,
      weeklySpend: costIdx?.by_week?.[periodKey.weekly]?.cost || 0,
      monthlySpend: costIdx?.by_month?.[periodKey.monthly]?.cost || 0,
      caps,
      action,
    });
    if (result.level === 'none') return;

    // Read-modify-write budget-alerts.json — cost-tracker's own file, so a plain
    // atomic write needs no lock (the split from the shared alert-state.json is what
    // removes the cross-process clobber with the watchdog's export-alert writer).
    // mutateOwnedAlerts returns false on an ioerror read (healthy file we couldn't
    // read) — in which case we act on nothing, as before.
    const newPeriods: Json[] = [];
    const applied = mutateOwnedAlerts(BUDGET_ALERTS, (alerts) => {
      for (const p of result.periods) {
        const key = `budget-${p.level}:${p.period}:${periodKey[p.period]}`;
        if (alerts[key]) continue; // dedup: one entry per period+level, create-only
        alerts[key] = {
          kind: 'budget',
          level: p.level,
          period: p.period,
          action: result.action,
          spend: Math.round(p.spend * 10000) / 10000,
          cap: p.cap,
          ratio: Math.round(p.ratio * 100) / 100,
          notified: false,
          ts: new Date().toISOString(),
        };
        newPeriods.push(alerts[key]);
      }
      // Reap budget-* entries from prior periods — created on breach/warn but
      // otherwise never removed, so the file would grow unbounded on a hermit that
      // breaches regularly. A key is `budget-<level>:<period>:<period-key>`; any
      // whose trailing period-key isn't the current one is a past period.
      for (const key of Object.keys(alerts)) {
        const e = alerts[key];
        if (e?.kind !== 'budget') continue;
        const current = periodKey[e.period as keyof typeof periodKey];
        if (current && !key.endsWith(`:${current}`)) delete alerts[key];
      }
    });
    if (!applied) return; // ioerror — never act on a state we couldn't read

    // Decide the pause action. `until` (the auto-resume boundary) is set whenever
    // the hermit is or will be budget-paused, so the operator message can name it.
    // `willPause` gates the actual setPause write and is false when a budget pause
    // is already in force at the same boundary — otherwise re-stamping pause.json's
    // ts every breach tick would defeat the watchdog's once-per-episode Escape/notify
    // dedup — or when a stronger operator/watchdog stop is in force (never downgrade
    // an indefinite stop into an auto-resuming budget pause). isPaused applies
    // reader-side expiry, so an already-lapsed pause counts as unpaused.
    let willPause = false;
    let until: string | null = null;
    if (result.action === 'pause' && result.level === 'breach') {
      const breachedPeriods = result.periods.filter(p => p.level === 'breach').map(p => p.period);
      const boundary = pauseBoundary(breachedPeriods, timezone);
      const existing = isPaused(HERMIT_DIR);
      if (!existing.paused) {
        willPause = true;
        until = boundary;
      } else if (existing.reason === 'budget') {
        until = boundary; // already budget-paused until this boundary
        willPause = existing.until !== boundary; // re-assert only if the boundary moved
      }
    }

    // The alert entries were already persisted inside mutateOwnedAlerts above
    // (create-only dedup), so a failed push below won't re-send next tick. Set the
    // pause synchronously before the awaited send.
    if (willPause) setPause(HERMIT_DIR, { reason: 'budget', by: 'cost-tracker', until });

    // Then push — bounded well under the Stop pipeline's 15s budget — and record
    // `notified` via a fresh read-modify-write. On failure, notified stays false so
    // `heartbeat.ts precheck`'s EVALUATE wake remains the fallback announcement path.
    if (newPeriods.length > 0) {
      // Full USD/cap/ratio detail is maintainer-tier; on a stock install (no
      // maintainer channel, technical profile) it falls back to the primary chat,
      // together with the plain localized "paused until X" client line when
      // a pause is in force.
      const message = composeBudgetMessage(newPeriods, result.action, until, timezone, locale);
      const clientLine = until ? BUDGET[locale].clientPaused(friendlyBoundary(until, timezone)) : undefined;
      const res = await sendOperatorNotice(HERMIT_DIR, {
        client: clientLine,
        maintainer: { text: message, fallback: 'client' },
        timeoutMs: BUDGET_PUSH_TIMEOUT_MS,
      });
      // Mark notified only when the alert actually reached a live counterparty:
      // the maintainer leg was delivered (a chat, or its intended Findings home),
      // OR the client "paused until X" line landed on the primary chat. A degraded
      // Findings fallback (configured maintainer channel unreachable) leaves
      // notified:false so `heartbeat.ts precheck`'s EVALUATE wake re-announces once the
      // channel recovers.
      if (res.maintainer?.delivered || res.client?.ok === true) markBudgetNotified(newPeriods, periodKey);
    }
  } catch (err: any) {
    console.error(`[cost-tracker] budget check error: ${err.message}`);
  }
}

// Exported run() function for use by stop-pipeline.ts.
// Returns the summary string, or null if there is nothing to report.
// process.exit() calls become returns so the pipeline is not killed.
async function run(data: Json): Promise<string | null> {
  try {
    const sessionId = ccSessionId(data) || 'unknown';
    const transcriptPath = ccTranscriptPath(data);

    if (!transcriptPath) {
      return null;
    }

    const lastRow = lastLoggedMainRow(sessionId);
    const turn = readLastTurnUsage(
      transcriptPath, typeof lastRow?.observed_at === 'string' ? lastRow.observed_at : undefined,
    );
    if (!turn) {
      return null;
    }

    // Surface derivation is idempotent (boundary_at-gated) and independent of the
    // billing dedupe below — run it before any early return can skip it.
    maybeDeriveSurface(turn.tailLines);

    const { inputTokens, cacheWriteTokens, cacheWrite1hTokens, cacheReadTokens, outputTokens, model: rawModel, source, sourceInherited, apiCalls, maxPromptTokens, subagents, observedAt, lastCallPromptTokens, fast } = turn;
    const model = rawModel || '';

    const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    if (totalTokens === 0) {
      return null;
    }

    const priced = priceUsage(model, { inputTokens, cacheWriteTokens, cacheWrite1hTokens, cacheReadTokens, outputTokens, fast });
    const roundedCost = priced.total;

    // Duplicate guard: a turn whose newest call is no newer than the last logged row's
    // already went through here. The scan guards above catch the flush race that produced
    // the measured incident; this catches every other way the same transcript entry can be
    // re-found (a manual run racing the Stop hook, a retried hook), which would otherwise
    // double-bill the spend and republish a dead context size. Same session only — a fresh
    // session legitimately starts from older transcript entries — and legacy rows without
    // observed_at never block, so the first post-upgrade turn always bills.
    //
    if (observedAt && lastRow
        && typeof lastRow.observed_at === 'string' && observedAt <= lastRow.observed_at) {
      return null;
    }


    const guest = isGuest(path.join(HERMIT_DIR, 'state'), sessionId);
    // Keep runtime.cc_session_id pointing at the resident's own harness session. The
    // SessionStart hook is the primary writer, but it only fires on start/resume/compact/
    // clear: a resident already running when this version lands stays unstamped — and the
    // watchdog's hygiene tiers skip entirely without it — until one of those happens. This
    // is the resident's own turn, so its session id is authoritative; restamping (rather
    // than filling only when absent) also heals a record left pointing at a session the
    // resident launched before the SessionStart gate existed.
    //
    // Same incumbency rule as stampSessionEnv, or this becomes the hijack path it closes:
    // a nested claude inherits HERMIT_MANAGED and would otherwise repoint the record on
    // every one of its own turns. writeRuntimeFields (not lib/runtime's updateRuntimeField)
    // because this is not a lifecycle event — refreshing updated_at here would hide a
    // wedged session from doctor's liveness check.
    if (!guest && process.env.HERMIT_MANAGED === '1') {
      const runtime = readRuntimeJsonCached();
      // Id comparison first: ownsResidentIdentity scans the session registry (a readdir
      // plus a /proc read per entry) and this runs on every turn, where the steady state
      // is "already stamped, nothing to do".
      if (runtime.cc_session_id !== sessionId && ownsResidentIdentity(runtime)) {
        writeRuntimeFields({ cc_session_id: sessionId });
      }
    }

    // Read config once per turn — timezone drives by_date/by_week/by_month bucketing and
    // budget-window boundaries (PROP-016); budgetConfig drives the breach check below.
    const config: Json = readSettledConfig(HERMIT_DIR);
    const timezone = typeof config.timezone === 'string' && config.timezone ? config.timezone : 'UTC';

    // Unknown model string → still priced via resolvePricing's fallback (refusing would zero the
    // log), but flagged so the drift is auditable instead of a silent mis-bill. A
    // falsy/absent rawModel is a different, unflagged case (no model info at all, not
    // an unrecognized one).
    const modelUnpriced = !!rawModel && !resolvePricing(rawModel).exact;

    // Log to JSONL. The row shape lives in lib/cost-log.ts — `observed_at` is the
    // context size and WHEN it was observed, both from the turn's newest call (the
    // row's own `timestamp` is ingestion time and says nothing about the context it
    // describes), and `source_inherited` marks a source that came from the dispatch
    // hop rather than this turn's own prompt. Both are absent, not false, when they
    // do not apply.
    const taskAttribution = resolveTaskAttribution(HERMIT_DIR, sessionId, source, lastRow?.observed_at ?? null);
    const logEntry = buildMainCostRow({
      taskAttribution,
      ccSessionId: sessionId,
      guest,
      source,
      model,
      inputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      apiCalls,
      maxPromptTokens,
      observedAt,
      lastCallPromptTokens,
      contextUsage: data.context_usage ?? data.contextUsage ?? null,
      estimatedCostUsd: roundedCost,
      modelUnpriced,
      sourceInherited,
      costByType: priced.costByType,
    });

    // Emit one log line per dispatched subagent at its resolved model.
    // Subagent assistant entries live in separate transcript files; only the Agent tool_result
    // (type:'user' with toolUseResult.usage) appears here. collectSubagentUsage captured them;
    // attribute them to the same source so cost-reflect folds them into the dispatching row.
    const subagentRows: any[] = [];
    for (const sa of (subagents || [])) {
      const saTotal = sa.inputTokens + sa.cacheWriteTokens + sa.cacheReadTokens + sa.outputTokens;
      if (saTotal === 0) continue;
      const saModel = sa.model || '';
      const saPriced = priceUsage(saModel, sa);
      const saCost = saPriced.total;
      subagentRows.push(buildSubagentCostRow({
        taskAttribution,
        source,
        model: saModel,
        inputTokens: sa.inputTokens,
        cacheWriteTokens: sa.cacheWriteTokens,
        cacheReadTokens: sa.cacheReadTokens,
        outputTokens: sa.outputTokens,
        totalTokens: saTotal,
        agentType: sa.agentType,
        modelResolved: !!sa.model,
        estimatedCostUsd: saCost,
        costByType: saPriced.costByType,
      }));
    }

    appendCostRows(COST_LOG, [logEntry, ...subagentRows]);
    consumeTaskBinding(HERMIT_DIR, taskAttribution);

    // Update incremental index — O(1) in the common case; O(n) only on first run or log truncation.
    const costIdx = updateCostIndex(COST_LOG, COST_INDEX, timezone);

    // PROP-016: compare the freshly-updated index against config.budget's caps.
    await applyBudgetCheck(costIdx, timezone, config.budget, resolveLocale(config.language));

    // Return brief summary (pipeline writes this to stderr)
    return `[cost-tracker] ${model}: ${kStr(totalTokens)} tokens (${kStr(cacheReadTokens)} cached), $${roundedCost.toFixed(4)}`;
  } catch (err: any) {
    // Non-fatal — never block on cost tracking failure
    console.error(`[cost-tracker] Error: ${err.message}`);
    return null;
  }
}

export { run, classifySource, resolveTurnSource, scanTurnInTail, sumTurnUsage, collectSubagentUsage, composeBudgetMessage };

if (import.meta.main) {
  // Mark-only entrypoint (synchronous, no stdin): the heartbeat SKILL calls this
  // to flip a delivered budget alert's `notified` flag. Keeps cost-tracker the
  // sole writer of budget-alerts.json so the SKILL never races the owned write.
  // Prints `OK`, or {"error":"write_failed"}. The stdin mode below is the Stop
  // hook and keeps the hook contract instead of the helper-output convention.
  const markKey = process.argv[2] === '--mark-budget-notified' ? process.argv[3] : null;
  if (markKey) {
    if (!mutateOwnedAlerts(BUDGET_ALERTS, (alerts) => markAlertNotified(alerts, markKey))) exitError('write_failed');
    emit('OK');
  }
  (async () => {
    try {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of process.stdin) {
        totalSize += chunk.length;
        if (totalSize > MAX_STDIN) {
          console.error('[cost-tracker] Stdin exceeds 1MB limit');
          process.exit(0);
        }
        chunks.push(chunk);
      }

      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        process.exit(0);
      }

      const data = JSON.parse(raw);
      const summary = await run(data);
      if (summary) console.log(summary);
      touchHeartbeat();
    } catch (err: any) {
      console.error(`[cost-tracker] Error: ${err.message}`);
      process.exit(0);
    }
  })();
}
