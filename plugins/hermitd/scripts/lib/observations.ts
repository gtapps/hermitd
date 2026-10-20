// Source-owned constructors for `state/observations.jsonl`.
//
// Every row is { ts, pattern, session_id, source } plus source-specific extras.
// `ts` is stamped here and `session_id` resolved here, so nothing — script or
// skill prose — hand-assembles either. Sources split two ways:
//
//   CLI_SOURCES            model-authored labels, written through observations.ts
//   DETERMINISTIC_SOURCES  computed facts, written by the script that computes them
//
// The split is enforced rather than documented: observations.ts rejects a
// deterministic source, so a computed row cannot be forged from prose, and the
// script that owns a fact is the only thing that can record it.

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine } from './append-jsonl';
import { readJson } from './cli';
import { readSettledConfig } from './config-read';
import { utcISOStamp, todayYMD } from './time';

type Origin = 'own-work' | 'external-content';

const CLI_SOURCES = ['quick-deferral', 'reflect-noticed', 'skill-correction', 'procedure-noticed', 'skill-preference', 'skill-preference-applied'] as const;
const DETERMINISTIC_SOURCES = ['cost-spike', 'behavior-digest', 'startup-drift'] as const;

type CliSource = (typeof CLI_SOURCES)[number];
type Source = CliSource | (typeof DETERMINISTIC_SOURCES)[number];

// Sources whose rows carry an `origin`. The rest omit the key entirely — readers
// treat a missing origin as own-work (skills/reflect/SKILL.md § observations).
const ORIGIN_SOURCES = new Set<string>(['reflect-noticed', 'skill-correction', 'procedure-noticed', 'skill-preference', 'skill-preference-applied', 'startup-drift']);

const ORIGINS: string[] = ['own-work', 'external-content'];

// `pattern` is the grouping key reflect matches on by exact string equality, so a
// runaway label would never group with anything and would bloat every read of the
// ledger. Bounded at the boundary where model text enters.
const MAX_PATTERN = 200;

function observationsPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'observations.jsonl');
}

// Every parsed row in the ledger. Missing file, empty file, and unparseable line all
// fold to the same outcome (row dropped) so callers get one fail-open read instead of
// each hand-rolling readFileSync + split + JSON.parse with its own catch.
function readLedgerRows(ledgerPath: string): Record<string, unknown>[] {
  try {
    return fs.readFileSync(ledgerPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter((row): row is Record<string, unknown> => row !== null);
  } catch {
    return [];
  }
}

interface ObservationPattern {
  pattern: string;
  source: string;
  rows: number;
  last_seen: string;
}

// Only the labels reflect writes itself, so computed per-date labels never fill the
// cap or get reused for a model-written row. Source describes the most recent row.
const PATTERN_SOURCES = new Set<string>(['quick-deferral', 'reflect-noticed']);

function observationPatterns(stateDir: string): ObservationPattern[] {
  const groups = new Map<string, ObservationPattern>();
  for (const row of readLedgerRows(observationsPath(stateDir))) {
    const { pattern, source, ts } = row;
    if (typeof pattern !== 'string' || !pattern || typeof source !== 'string' || !PATTERN_SOURCES.has(source)
      || typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) continue;
    const group = groups.get(pattern);
    if (!group) groups.set(pattern, { pattern, source, rows: 1, last_seen: ts });
    else {
      group.rows++;
      if (Date.parse(ts) > Date.parse(group.last_seen)) {
        group.last_seen = ts;
        group.source = source;
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen) || a.pattern.localeCompare(b.pattern))
    .slice(0, 50);
}

function resolveSessionId(stateDir: string): string {
  return todayYMD(readSettledConfig(stateDir).timezone ?? 'UTC');
}

type RowInput = {
  source: Source;
  pattern: string;
  sessionId: string;
  origin?: Origin;
  extra?: Record<string, unknown>;
};

// Returns the row or an error token. Field insertion order matches the rows this
// ledger has always carried — JSON.stringify preserves it, so historical and new
// rows are indistinguishable to every reader.
function observationRow(input: RowInput): { row: Record<string, unknown> } | { error: string } {
  const pattern = input.pattern.trim();
  if (!pattern) return { error: 'empty_pattern' };
  if (pattern.includes('\n')) return { error: 'multiline_pattern' };
  if (pattern.length > MAX_PATTERN) return { error: `pattern_too_long:${pattern.length}` };

  if (input.origin !== undefined) {
    if (!ORIGIN_SOURCES.has(input.source)) return { error: `origin_not_allowed:${input.source}` };
    if (!ORIGINS.includes(input.origin)) return { error: `invalid_origin:${input.origin}` };
  }

  const row: Record<string, unknown> = {
    ts: utcISOStamp(),
    pattern,
    session_id: input.sessionId,
    source: input.source,
  };
  if (input.origin !== undefined) row.origin = input.origin;
  // `extra` may only widen a row, never rewrite its identity — an extra key named
  // `source` or `session_id` would otherwise silently forge the very fields this
  // module exists to own.
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    if (k in row) return { error: `reserved_extra_key:${k}` };
    row[k] = v;
  }
  return { row };
}

// Serializes one row without writing — for callers that batch several appends into
// a single write (reflect-precheck collects its drift rows this way).
function observationLine(input: RowInput): { line: string } | { error: string } {
  const built = observationRow(input);
  return 'error' in built ? built : { line: JSON.stringify(built.row) };
}

// Returns the `{error}` to report, or null when the row landed.
function appendObservation(stateDir: string, input: RowInput): { error: string } | null {
  const built = observationRow(input);
  if ('error' in built) return built;
  const err = appendJsonlLine(observationsPath(stateDir), JSON.stringify(built.row));
  return err ? { error: `ledger_append_failed:${err}` } : null;
}

interface GraduationCandidate {
  pattern: string;
  sessions: string[];
  origin: Origin;
  rows: number;
}

/**
 * The recurring patterns reflect promotes to candidates this run.
 *
 * Three rules, all mechanical: a pattern needs at least `graduation_min_sessions`
 * distinct sessions behind it (the `"unknown"` sentinel is a shared placeholder,
 * not a session, and never counts), at least one row newer than the graduation
 * cursor (so a pattern already promoted stays quiet until something new arrives),
 * and it inherits `external-content` from any single row that carries it.
 *
 * `skill-preference-applied` rows are telemetry of a settlement already folded into
 * a skill — they neither promote their pattern nor count toward its sessions, so
 * they are dropped before any of the above.
 *
 * A missing, empty or unreadable ledger yields no candidates; an unparseable line
 * is skipped. Ordered by pattern so two runs over the same ledger agree.
 */
function graduateObservations(stateDir: string, cursorArg?: string): GraduationCandidate[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of readLedgerRows(observationsPath(stateDir))) {
    const pattern = row.pattern;
    if (typeof pattern !== 'string' || !pattern) continue;
    if (pattern.startsWith('skill-preference:') && row.source === 'skill-preference-applied') continue;
    const group = groups.get(pattern);
    if (group) group.push(row); else groups.set(pattern, [row]);
  }
  if (groups.size === 0) return [];

  const minSessions = readSettledConfig(stateDir).reflection.graduation_min_sessions;
  const cursor = cursorArg
    ?? readJson(path.join(stateDir, 'state', 'reflection-state.json'))?.counters?.last_graduation_at;
  const cursorMs = typeof cursor === 'string' ? Date.parse(cursor) : NaN;

  const out: GraduationCandidate[] = [];
  for (const [pattern, rows] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sessions = [...new Set(rows
      .map(r => r.session_id)
      .filter((id): id is string => typeof id === 'string' && id !== 'unknown'))];
    if (sessions.length === 0 || sessions.length < minSessions) continue;
    const fresh = !Number.isFinite(cursorMs) || rows.some(r => Date.parse(String(r.ts)) > cursorMs);
    if (!fresh) continue;
    out.push({
      pattern,
      sessions,
      origin: rows.some(r => r.origin === 'external-content') ? 'external-content' : 'own-work',
      rows: rows.length,
    });
  }
  return out;
}

export {
  CLI_SOURCES,
  DETERMINISTIC_SOURCES,
  MAX_PATTERN,
  observationsPath,
  readLedgerRows,
  resolveSessionId,
  observationRow,
  observationLine,
  appendObservation,
  graduateObservations,
  observationPatterns,
};
export type { Origin, Source, CliSource, RowInput, GraduationCandidate, ObservationPattern };
