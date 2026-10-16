import { readTaskReports } from './lib/task-report';
// reflect-precheck.ts — determines which reflect phases are due before invoking LLM.
// Usage: bun reflect-precheck.ts <hermit-state-dir> <plugin-root> [--quick [--force]]
// Output (stdout, one JSON line):
//   {"status":"empty"}
//   {"status":"run","phases":{<phase>:true,...},"phase":"<age bucket>"}
//   {"status":"run","hash":"<sha256>"}   (--quick)
// `phases` carries one boolean per due phase; `phase` is the install's age bucket
// (newborn/juvenile/adult) that the skill binds to $PHASE.
//
// On empty this script updates reflection-state counters before exiting.
//
// --quick gates the event-driven `reflect --quick` chain (reflect_after routines) against
// a hash of recent record lessons and waiting dependencies, isolated from the scheduled
// cadence state above (never touches last_run_at/counters). --force (only meaningful with
// --quick) skips the empty decision entirely and always returns a run hash: used by manual
// `/reflect --quick` invocations, which need a deterministic hash to commit after processing,
// not a gating decision (the skill is already loaded by the time this runs).
//
// Exit 0 always, EXCEPT a foreign state-dir argv (see the pin below) — that is
// a mis-invocation, not a runtime condition, so it exits 1 on stderr instead.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { todayYMD, yesterdayYMD } from './lib/time';
import { observationLine, readLedgerRows, resolveSessionId } from './lib/observations';
import { findStorageDrift, findSchemaDrift } from './lib/drift';
import { sha256 } from './lib/hash';
import { pinStateDirOrExit, hermitDir as resolveHermitRoot } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { costIndexPath, readCostIndex } from './lib/cost-log';
import { ensureLedgerFile } from './lib/append-jsonl';
import { emitJson } from './lib/cli';

type Json = any;

const stateDirArg = process.argv[2];
const pluginRoot = process.argv[3];
const flags = process.argv.slice(4);
const quickMode = flags.includes('--quick');
const forceMode = flags.includes('--force');

// Missing is fail-open (existing behaviour); foreign is not — see header.
if (!stateDirArg) emitJson({ status: 'run', phases: {} });

// The state dir is not caller-chosen. Reachable through a pre-approved
// `Bash(bun */scripts/reflect-precheck.ts*)` grant that covers every argument,
// and forwards it to archive-raw.ts and update-reflection-state.ts, so an
// unvalidated root would have reached both. Deliberately a usage error (stderr, exit 1), not a stdout verdict —
// callers branch on the stdout status.
const stateDir = pinStateDirOrExit(stateDirArg, 'reflect-precheck.ts');

const readJSON = (p: string): Json => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
};

function runQuickPrecheck(stateDir: string, force: boolean): never {
  const records = readTaskReports(stateDir).filter(record => record.outcome !== 'open').slice(-3);
  const findings = records.flatMap(record => record.lessons).join('\n');
  const blockers = records.filter(record => record.waiting_on).map(record => `${record.title}: ${record.waiting_on}`).join('\n');
  const hash = sha256(`${findings}\n---\n${blockers}`);

  if (force) emitJson({ status: 'run', hash });

  if (!findings && !blockers) {
    emitJson({ status: 'empty' });
  }

  const reflectionState = readJSON(path.join(stateDir, 'state', 'reflection-state.json')) ?? {};
  const storedHash = reflectionState.last_quick_hash;

  // No prior cursor (storedHash undefined) never equals a hex hash, so first-run
  // correctly falls through to RUN below without a separate branch.
  if (storedHash === hash) {
    emitJson({ status: 'empty' });
  }

  emitJson({ status: 'run', hash });
}

if (quickMode) runQuickPrecheck(stateDir, forceMode);

function computePhase(since: string | null) {
  if (!since) return 'adult';
  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) return 'adult';
  const ageDays = Math.floor((Date.now() - sinceDate.getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays < 3) return 'newborn';
  if (ageDays < 14) return 'juvenile';
  return 'adult';
}

function daysSince(isoStr: string | null) {
  if (!isoStr) return Infinity;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

// Reads whole-day totals from state/cost-index.json (maintained by cost-tracker.ts's
// Stop hook and subagent-cost.ts's SubagentStop hook) instead of tailing the raw log —
// a busy install's day is hundreds of entries, so a fixed-line tail spans at most one
// or two dates and can never assemble a real baseline. The index retains today plus 8
// prior days (BY_DATE_RETENTION_DAYS in lib/cost-log.ts): yesterday plus the 7 days
// before it, which is exactly what this measures. Buckets are tz-keyed the same way the
// dates are computed here (the writers pass the same config.timezone and rebuild the
// whole index on a tz change), so the two keys can't disagree across an offset.
//
// The measured day is YESTERDAY, not today. The shipped reflect schedule is 09:00, so
// today's bucket is at most nine hours of spend — usually near zero after an idle night
// — and comparing that partial against a median of full days can only fire when a spike
// happens to be front-loaded before the routine runs. Yesterday is complete by the time
// this reads it, and a spike day is worth one reflect run the morning after.
//
// Returns the two figures rather than a boolean so this script can record the
// observation itself. It previously computed them, discarded them, and set a phase
// flag that asked the skill to re-read the same log and redo the same arithmetic —
// a round trip through prose that, across the live fleet, never once produced a row.

// Below this, a day is too cheap for a "spike" to mean anything: a fresh hatch's first
// days are near zero, so any normal working day is trivially 2x them. Notional USD,
// deliberately not a config key — it is the floor of what a cost problem can look like,
// not a preference.
const SPIKE_MEDIAN_FLOOR_USD = 1;

function checkCostSpike(hermitRoot: string, timezone: string): { dayTotal: number; median: number; date: string } | null {
  try {
    const index = readCostIndex(costIndexPath(hermitRoot));
    if (!index) return null;

    const date = yesterdayYMD(timezone);
    const dayTotal = index.by_date?.[date]?.cost ?? 0;

    // `< date`, not `!== date`: today's partial bucket is excluded by construction, and
    // so is a bucket keyed past today (an old-tz key still sitting in the index between
    // a config.timezone edit and the next cost write) — letting either into the
    // trailing-7 slice would drop a real day and drag the baseline.
    const priorDays = Object.entries(index.by_date ?? {})
      .filter(([d]) => d < date)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(-7)
      .map(([, bucket]) => (bucket as { cost?: number }).cost ?? 0);
    if (priorDays.length < 3) return null;

    const sorted = [...priorDays].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    if (!(median >= SPIKE_MEDIAN_FLOOR_USD && dayTotal > 2 * median)) return null;
    return { dayTotal, median, date };
  } catch {
    return null;
  }
}

// Date-scoped, never value-bearing: the dedup below matches on exact string equality,
// so the check and the writer must build the label the same way or the row is written
// again every tick.
function costSpikeLabel(date: string): string {
  return `cost-spike:${date}`;
}

// True once the day's cost-spike row is in the observations ledger. The row — not the
// measurement — is what gates the phase: the measurement stays true for every tick that
// still reads the same completed day, so reflect's cost_spike step has nothing to read
// or record once the row exists, and flagging it again would buy an LLM run per tick.
function hasCostSpikeRow(existingPatterns: Set<string>, date: string): boolean {
  return existingPatterns.has(costSpikeLabel(date));
}

function hasAcceptedProposals(stateDir: string) {
  try {
    const proposalsDir = path.join(stateDir, 'proposals');
    const files = fs.readdirSync(proposalsDir).filter(f => /^PROP-\d+(?:-.+)?\.md$/.test(f));
    return files.some(f => {
      try {
        const head = fs.readFileSync(path.join(proposalsDir, f), 'utf-8').slice(0, 1000);
        return /^\s*status:\s*accepted\s*$/mi.test(head);
      } catch { return false; }
    });
  } catch {
    return false;
  }
}

// Short-circuits cheaply: in_progress or missing lastRunAt require no I/O.
function hasComputeActivity(stateDir: string, lastRunAt: string | null) {
  if (!lastRunAt) return true;
  const lastRun = Date.parse(lastRunAt);
  if (!Number.isFinite(lastRun)) return true;
  return readTaskReports(stateDir).some(record => record.outcome !== 'open'
    && Date.parse(record.closed_at ?? record.opened_at) > lastRun);
}

const reflectionStatePath = path.join(stateDir, 'state', 'reflection-state.json');
const reflectionState = readJSON(reflectionStatePath) ?? {};
const counters = reflectionState.counters ?? {};
const lastRunAt = counters.last_run_at ?? null;
const since = counters.since ?? null;
const phase = computePhase(since);

const runtime = readJSON(path.join(stateDir, 'state', 'runtime.json')) ?? {};

const config = readSettledConfig(stateDir);
const timezone = config.timezone ?? 'UTC';

const ledgerPath = path.join(stateDir, 'state', 'observations.jsonl');

// Every pattern label in the ledger, read once and shared by the cost-spike row check
// below and the drift-capture dedup further down — both ask the same question of the
// same file, and on a spike day the cost-spike check runs on every tick until midnight.
const existingPatterns = new Set<string>();
for (const row of readLedgerRows(ledgerPath)) {
  if (typeof row.pattern === 'string') existingPatterns.add(row.pattern);
}

const phases: Record<string, boolean> = {};

// Cheaper checks first: compute (short-circuits on in_progress/null lastRunAt),
// then resolution_check (reads proposal files), then cost spike (reads cost log).
if (hasComputeActivity(stateDir, lastRunAt)) phases.compute = true;

const lastResolutionCheck = reflectionState.last_resolution_check ?? null;
if (hasAcceptedProposals(stateDir) && daysSince(lastResolutionCheck) > 7) {
  phases.resolution_check = true;
}

// Anchor cost-index resolution: a relative stateDir (real invocation passes
// `.hermit`) would otherwise resolve against a drifted cwd and
// silently suppress the cost-spike phase. Absolute (as tests pass) is verbatim.
const costHermitRoot = path.isAbsolute(stateDir) ? stateDir : resolveHermitRoot();
const costSpike = checkCostSpike(costHermitRoot, timezone);
// The phase flags the spike for the skill's narrative step on the one run that writes
// the row; the row itself is written below, from these figures, rather than re-derived
// from prose. Gated on the row's absence so a spike day costs exactly one RUN and not
// one per tick.
if (costSpike && !hasCostSpikeRow(existingPatterns, costSpike.date)) phases.cost_spike = true;

// Behavioral-telemetry digest — weekly for every hermit (not age-gated like
// `digest` below): reflect's evidence step reads ground-truth transcript counters
// (defer-loop wakes, tool failures, denial spikes) it can't get from self-report.
if (daysSince(reflectionState.last_behavior_digest_at) > 7) {
  phases.behavior = true;
}

if (phase === 'juvenile' && daysSince(reflectionState.last_digest_at) > 7) {
  phases.digest = true;
}

if (phase === 'newborn') phases.newborn = true;



// Run archive-raw.ts on a 7-day debounce so raw/.archive/ is bounded on every hermit
// regardless of whether weekly-review is configured.
if (pluginRoot && daysSince(runtime.last_raw_archive_at) >= 7) {
  try {
    execFileSync(process.execPath, [
      path.join(pluginRoot, 'scripts', 'archive-raw.ts'),
      stateDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Re-read before writing to preserve concurrent runtime updates.
    const runtimePath = path.join(stateDir, 'state', 'runtime.json');
    const freshRuntime = readJSON(runtimePath) ?? runtime;
    freshRuntime.last_raw_archive_at = new Date().toISOString();
    try {
      fs.writeFileSync(
        runtimePath,
        JSON.stringify(freshRuntime, null, 2) + '\n',
        'utf-8',
      );
    } catch { /* fail-open */ }
  } catch { /* fail-open */ }
}

// --- Drift capture: write storage/schema drift rows to observations ledger ---
// Drift is structural (a dir/type is present or absent), not a recurring behavior, so
// dedup by pattern alone: a standing unresolved drift writes exactly one row and then
// stays silent, instead of writing a fresh row every session (which would flip the
// freshness gate to RUN on every session forever). The row ages out of the ledger after
// prune-observations' 30-day window, so persistent drift re-surfaces ~monthly on the next
// reflect run rather than never. Mechanical drift is always own-work; writing happens
// before the freshness gate so a first-sighting row triggers RUN on the same invocation.
let wroteNewRows = false;
try {
  const sessionId = resolveSessionId(stateDir);

  // `existingPatterns` (loaded once above) dedups the writes below. Drift slugs are
  // namespaced (storage-drift:/schema-drift:), so scanning all patterns can't collide
  // with reflect-noticed/cost-spike rows.
  const newRows: string[] = [];
  // Rows go through the shared constructor so this writer and observations.ts
  // cannot drift apart on field order, timestamp format, or origin rules.
  // `origin` belongs only to startup-drift here — cost-spike is a measurement, not
  // something with a provenance, and the constructor rejects the key on sources that
  // never carried it.
  const capture = (slug: string, source: 'startup-drift' | 'cost-spike' = 'startup-drift', extra?: Record<string, unknown>) => {
    if (existingPatterns.has(slug)) return;
    existingPatterns.add(slug);
    const built = observationLine(
      source === 'startup-drift'
        ? { source, pattern: slug, sessionId, origin: 'own-work' }
        : { source, pattern: slug, sessionId, extra },
    );
    if ('line' in built) newRows.push(built.line);
  };

  // Storage drift — capture the full subpath so raw/foo and raw/bar get distinct slugs
  for (const hit of findStorageDrift(stateDir)) {
    const m = hit.match(/\.hermit\/(.+)\/ \(/);
    if (m) capture(`storage-drift:${m[1]}`);
  }

  // Schema drift
  for (const { type } of findSchemaDrift(stateDir)) {
    capture(`schema-drift:${type}`);
  }

  // Cost spike — the label carries the measured date only. Embedding a figure would
  // defeat the dedup above the moment the index is rebuilt or a late row lands, writing
  // a second row for the same day. The figures ride as fields instead, where a reader
  // can still get at them.
  if (costSpike) {
    capture(costSpikeLabel(costSpike.date), 'cost-spike', {
      day_total: Number(costSpike.dayTotal.toFixed(4)),
      median_7d: Number(costSpike.median.toFixed(4)),
    });
  }

  if (newRows.length > 0) {
    ensureLedgerFile(ledgerPath);
    fs.appendFileSync(ledgerPath, newRows.join('\n') + '\n', 'utf-8');
    wroteNewRows = true;
  }
} catch { /* fail-open */ }

// --- Freshness gate: flip EMPTY→RUN when ledger has rows newer than last_run_at ---
// Only precheck-written rows (startup-drift, cost-spike) self-trigger, because they are
// written above, before this gate runs — each at most once per pattern, so a standing
// drift or a spike day forces exactly one RUN, not one per tick. Rows written *during* a
// run (reflect-noticed, quick-deferral, skill-correction, behavior-digest) have
// ts ≤ last_run_at on the next tick and do NOT self-trigger — they surface opportunistically.
// skill-preference-applied rows are written mid-conversation (settlement telemetry, never a
// candidate), so they're excluded explicitly — a run they trigger would have nothing to do.
// Pending skill-preference rows are NOT excluded: they graduate, so their run is productive.
if (wroteNewRows) {
  // Rows just appended carry ts = now > last_run_at by construction — skip the re-read.
  phases.observations_fresh = true;
} else {
  // Deliberately re-reads rather than reusing the pattern scan at the top of the
  // script: the rows appended above land between the two, and another session sharing
  // this folder can append at any point, so the gate reads the ledger as it stands now.
  // A read error fail-opens to no rows — skip the trigger, don't force RUN.
  // null last_run_at (fresh hermit) → cutoff = 0 → any valid ts triggers
  const cutoff = lastRunAt ? new Date(lastRunAt).getTime() : 0;
  const hasFresh = readLedgerRows(ledgerPath).some(row => {
    const rowTime = new Date(row.ts as string).getTime();
    return !isNaN(rowTime) && rowTime > cutoff && row.source !== 'skill-preference-applied';
  });
  if (hasFresh) phases.observations_fresh = true;
}

if (Object.keys(phases).length > 0) emitJson({ status: 'run', phases, phase });

// Empty path: update reflection-state.json.
if (pluginRoot) {
  const updateScript = path.join(pluginRoot, 'scripts', 'update-reflection-state.ts');
  try {
    execFileSync(process.execPath, [
      updateScript,
      reflectionStatePath,
      JSON.stringify({ ran_with_candidates: false }),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch { /* fail-open */ }
}

emitJson({ status: 'empty' });
