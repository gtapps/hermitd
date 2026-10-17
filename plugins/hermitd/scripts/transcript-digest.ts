process.stdout.on('error', () => {});

// transcript-digest.ts — behavioral counters over recent CC session transcripts.
//
// Usage: bun transcript-digest.ts <state-dir> [--days D] [--sessions N] [--dir <transcript-dir>]
// Output: ONE stdout JSON object (verdict-sized) — see mergeDigests. Exit 0 always
// except on unusable arguments (`{"error":"usage"}`, exit 1).
//
// WHY THIS EXISTS: the hermit's self-knowledge loop (reflect) establishes
// cross-session patterns from self-authored reports — the model summarizing its
// own behavior, which systematically under-records friction (tool failures,
// denials, defer-loop wakes). This script mines the ground-truth CC transcripts
// (already trusted by cost-tracker.ts for spend) for a small set of behavioral
// counters reflect can cite as measured evidence.
//
// TRANSCRIPT ROTATION MODEL (live-probed CC 2.1.214): CC writes one
// <sessionUuid>.jsonl per session id. A new file appears on session boot,
// restart, plugin update, and /clear (incl. the watchdog's standalone clear) —
// the old file simply stops with no terminal marker. Compaction does NOT rotate
// (compact_boundary is an inline entry). An always-on hermit is therefore ONE
// long-lived session that rotates irregularly, so the window is TIME-based
// (--days), not file-count-based; --sessions is only a safety cap on how many
// files a single run reads.
//
// BOUNDED READ: per transcript we read only a TAIL_BYTES tail (via cc-compat's
// shared readTailLines helper), never the whole corpus. A
// truncated tail is reported via window.truncated; because the tail may not
// reach back a full D days, an entry-level timestamp cutoff in digestLines keeps
// the counters honest (window.from tells you how far coverage actually reached).
//
// NO LOAD-TIME SIDE EFFECTS: pure functions + main() gated on import.meta.main,
// so tests import the pure functions directly. (Importing classifySource pulls
// cost-tracker's module top-level, which only computes read-only paths.)

import fs from 'node:fs';
import path from 'node:path';
import {
  entryText,
  isTurnBoundary,
  isCompactBoundary,
  toolUseNames,
  classifyToolResults,
  transcriptDirFor,
  hermitDir as resolveHermitRoot,
  pinStateDirOrExit,
  readTailLines,
} from './lib/cc-compat';
import { classifySource } from './lib/trigger-source';
import { exitError } from './lib/cli';
import { resolveHermitNowMs } from './lib/time';
import { appendObservation, resolveSessionId } from './lib/observations';

type Json = any;

const TAIL_BYTES = 2 * 1024 * 1024; // 2 MiB — covers ≥90% of real sessions end-to-end
const DEFAULT_DAYS = 7;
const DEFAULT_SESSIONS = 10;
const DAY_MS = 86_400_000;

// v1 excludes Bash from productive-wake detection deliberately: every heartbeat
// wake runs `heartbeat.ts precheck` via Bash by construction, so counting any Bash
// call would peg productive_wakes/wakes at 100% and kill the defer-loop signal.
// Undercount (a wake that only mutates state through a hermit script reads as
// unproductive) is accepted for v1; a hermit-script allowlist is a v1.1 option.
const PRODUCTIVE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function isProductiveTool(name: string): boolean {
  return PRODUCTIVE_TOOLS.has(name) || /^mcp__.+__reply$/.test(name);
}

// classifySource returns 'heartbeat' | 'routine:<id>' | 'routine:multi' |
// 'channel:<kind>' | 'peer' | 'other'. A wake is a non-operator scheduler prompt:
// heartbeat or routine. channel:* (inbound operator DM), peer (another local
// session's post) and other are not wakes.
function isWakeSource(source: string): boolean {
  return source === 'heartbeat' || source.startsWith('routine:');
}

interface FileDigest {
  failures: Record<string, number>;
  rejections: Record<string, number>;
  wakes: number;
  productiveWakes: number;
  compactions: number;
  dispatches: number;
  partial: boolean;
  from: string | null;
  to: string | null;
}

// Select main-session transcripts: top-level *.jsonl in `dir` with mtime within
// `days`, newest first, capped at `n`. The .jsonl + isFile() filter skips the
// <sessionUuid>/ subagent subdirectories and the memory/ sidecar dir — subagent
// tool activity lives only in those subdirs and never in the main transcript, so
// there is no double-counting.
function pickTranscripts(dir: string, days: number, n: number, now: number): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); }
  catch { return []; }
  const cutoff = now - days * DAY_MS;
  const files: Array<{ p: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const p = path.join(dir, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(p); }
    catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoff) continue;
    files.push({ p, mtime: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, n).map(f => f.p);
}

// `truncated` means the window did not reach the file's start. Returns null on
// any read error (caller counts it as skipped).
function readTailWindow(file: string, tailBytes: number = TAIL_BYTES): { lines: string[]; truncated: boolean } | null {
  try {
    const { lines, readFrom } = readTailLines(file, tailBytes);
    return { lines, truncated: readFrom > 0 };
  } catch {
    return null;
  }
}

// Single forward pass over one transcript's lines. `cutoffMs` is the D-day
// boundary: mtime picked the right FILES, but a long-lived quiet file's tail can
// hold entries older than the window, so an entry-level timestamp gate keeps the
// counters denoting "the last D days". A turn counts as a wake only if its
// trigger is in-window; a window that opens mid-turn (truncated tail) flushes its
// orphan prefix as a non-wake because turn state starts closed, while global
// counters (failures, rejections, compactions, dispatches) still count.
function digestLines(lines: string[], cutoffMs: number): FileDigest {
  const d: FileDigest = {
    failures: {}, rejections: {}, wakes: 0, productiveWakes: 0,
    compactions: 0, dispatches: 0, partial: false, from: null, to: null,
  };
  const idToName = new Map<string, string>();

  let inWindow = false;   // has an in-window timestamp been seen yet
  let turnOpen = false;
  let turnIsWake = false;
  let turnProductive = false;

  const flushTurn = () => {
    if (turnOpen && turnIsWake) {
      d.wakes++;
      if (turnProductive) d.productiveWakes++;
    }
    turnOpen = false;
    turnIsWake = false;
    turnProductive = false;
  };

  for (const line of lines) {
    if (!line) continue;
    let entry: Json;
    try { entry = JSON.parse(line); }
    catch { d.partial = true; continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.isSidechain === true) continue;

    if (typeof entry.timestamp === 'string') {
      const tms = Date.parse(entry.timestamp);
      if (!Number.isNaN(tms)) {
        inWindow = tms >= cutoffMs;
        if (inWindow) {
          if (d.from === null || entry.timestamp < d.from) d.from = entry.timestamp;
          if (d.to === null || entry.timestamp > d.to) d.to = entry.timestamp;
        }
      }
    }
    if (!inWindow) continue;

    if (isCompactBoundary(entry)) { d.compactions++; continue; }

    if (isTurnBoundary(entry)) {
      flushTurn();
      turnOpen = true;
      turnIsWake = isWakeSource(classifySource(entryText(entry)));
      continue;
    }

    if (entry.type === 'assistant') {
      for (const { id, name } of toolUseNames(entry)) {
        if (idToName.has(id)) continue; // first-write-wins: split re-emissions harmless
        idToName.set(id, name);
        if (name === 'Agent') d.dispatches++;
        if (isProductiveTool(name)) turnProductive = true;
      }
      continue;
    }

    // Remaining case: a user tool_result carrier. Denials and genuine failures
    // both carry is_error:true and can co-occur in one parallel batch, so
    // classify per block — a denial never masks a sibling's real failure.
    const { rejections, failureIds } = classifyToolResults(entry);
    for (const kind of rejections) d.rejections[kind] = (d.rejections[kind] ?? 0) + 1;
    for (const id of failureIds) {
      const key = idToName.get(id) ?? 'unknown';
      d.failures[key] = (d.failures[key] ?? 0) + 1;
    }
  }
  flushTurn();
  return d;
}

function mergeDigests(
  perFile: FileDigest[],
  meta: { days: number; files: number; truncated: number; skipped: number },
): Json {
  const failures: Record<string, number> = {};
  const rejections: Record<string, number> = {};
  let wakes = 0, productiveWakes = 0, compactions = 0, dispatches = 0, partial = false;
  let from: string | null = null;
  let to: string | null = null;
  for (const d of perFile) {
    for (const [k, v] of Object.entries(d.failures)) failures[k] = (failures[k] ?? 0) + v;
    for (const [k, v] of Object.entries(d.rejections)) rejections[k] = (rejections[k] ?? 0) + v;
    wakes += d.wakes;
    productiveWakes += d.productiveWakes;
    compactions += d.compactions;
    dispatches += d.dispatches;
    partial = partial || d.partial;
    if (d.from && (from === null || d.from < from)) from = d.from;
    if (d.to && (to === null || d.to > to)) to = d.to;
  }
  return {
    window: { days: meta.days, files: meta.files, from, to, truncated: meta.truncated, skipped: meta.skipped },
    counters: {
      tool_failures: failures,
      tool_rejections: rejections,
      wakes,
      productive_wakes: productiveWakes,
      compaction_events: compactions,
      subagent_dispatches: dispatches,
    },
    partial,
  };
}

function parseArgs(argv: string[]): { stateDir: string; days: number; sessions: number; dir?: string; record: boolean } | null {
  const positionals: string[] = [];
  let days = DEFAULT_DAYS;
  let sessions = DEFAULT_SESSIONS;
  let dir: string | undefined;
  let record = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record-observation') {
      record = true;
    } else if (a === '--days') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return null;
      days = v;
    } else if (a === '--sessions') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0) return null;
      sessions = v;
    } else if (a === '--dir') {
      dir = argv[++i];
      if (!dir) return null;
    } else if (a.startsWith('--')) {
      return null;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) return null;
  return { stateDir: positionals[0], days, sessions, dir, record };
}

// The defer-loop threshold. Lived in reflect's skill prose, which asked the model to
// compare counters this script had already produced and hand-write the resulting row —
// so the rule was unenforceable and the row, across the live fleet, never appeared.
const DEFER_LOOP_MIN_WAKES = 20;
const DEFER_LOOP_MAX_PRODUCTIVE_RATIO = 0.25;

function deferLoopPattern(out: any): string | null {
  const wakes = out?.counters?.wakes ?? 0;
  const productive = out?.counters?.productive_wakes ?? 0;
  if (wakes < DEFER_LOOP_MIN_WAKES) return null;
  if (productive / wakes >= DEFER_LOOP_MAX_PRODUCTIVE_RATIO) return null;
  const from = out?.window?.from ?? 'unknown';
  const to = out?.window?.to ?? 'unknown';
  return `defer-loop: ${productive}/${wakes} productive wakes, ${from}→${to}`;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args) exitError();
  const now = resolveHermitNowMs();
  const cutoffMs = now - args.days * DAY_MS;
  // Derive the transcript dir from the hermit root, not raw path.resolve(stateDir):
  // reflect invokes us with a relative `.hermit`, and a drifted cwd
  // would otherwise key a nonexistent dir and silently return all-zero counters.
  // resolveHermitRoot() anchors on AGENT_DIR/CLAUDE_PROJECT_DIR then walks up to
  // the .hermit/config.json (same guard as reflect-precheck.ts). Only
  // the arg's absolute-ness matters — a relative stateDir's value is intentionally
  // ignored in favor of the resolved root. Resolve lazily: an explicit --dir
  // supersedes this, so don't pay the walk-up when the caller already named the dir.
  // Resolved eagerly when recording, since the ledger lives under it; otherwise
  // lazily, so a caller who named --dir doesn't pay for the walk-up.
  // An absolute stateDir is the one branch where argv chooses the root, and
  // --record appends to `<root>/state/observations.jsonl` — so pin it. A
  // relative value is ignored in favor of resolveHermitRoot() (see above), and
  // pinning it would turn the cwd-drift fallback this comment exists for into a
  // hard refusal, so that branch stays unpinned.
  let hermitRoot: string | null = null;
  const rootOnce = () => (hermitRoot ??= path.isAbsolute(args.stateDir)
    ? pinStateDirOrExit(args.stateDir)
    : resolveHermitRoot());

  let dir = args.dir;
  if (!dir) dir = transcriptDirFor(path.dirname(rootOnce()));

  const perFile: FileDigest[] = [];
  let truncated = 0;
  let skipped = 0;
  for (const file of pickTranscripts(dir, args.days, args.sessions, now)) {
    const win = readTailWindow(file);
    if (!win) { skipped++; continue; }
    if (win.truncated) truncated++;
    perFile.push(digestLines(win.lines, cutoffMs));
  }
  const out = mergeDigests(perFile, { days: args.days, files: perFile.length, truncated, skipped });

  // Opt-in: the digest is a read by default, so an ad-hoc or debugging invocation
  // never leaves rows behind. reflect passes the flag on its scheduled run.
  //
  // Fail-open: the row is telemetry, the digest JSON below is the caller's actual
  // payload. `hermitDir()` fail-opens to a `.hermit` that may not exist,
  // so the append can throw ENOENT — swallowing it keeps a missing state dir from
  // costing reflect the whole anomaly checklist, not just one row.
  if (args.record) {
    try {
      const pattern = deferLoopPattern(out);
      if (pattern) {
        const root = rootOnce();
        appendObservation(root, { source: 'behavior-digest', pattern, sessionId: resolveSessionId(root) });
      }
    } catch { /* fail-open */ }
  }

  process.stdout.write(JSON.stringify(out) + '\n');
  return 0;
}

export { parseArgs, pickTranscripts, readTailWindow, digestLines, mergeDigests, isProductiveTool, isWakeSource };

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
