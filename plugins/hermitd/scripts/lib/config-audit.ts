// Settings audit ledger — one row per changed config leaf, appended after the
// owning writer's own successful write.
//
// This is deliberately NOT a shared config-write chokepoint. The scripts that
// write config.json each have a different, intentional failure contract
// (settings-edit aborts on a malformed file, hatch-config validates then dies,
// evolve-finalize returns a structured error and re-reads to verify,
// channel-bot-id degrades to a skip verdict, channel-hook is silently fail-open).
// A shared writer would flatten all five. Instead each writer keeps its own
// write and calls auditConfigChange() afterwards; the diff happens here, so a
// writer cannot forget to report a change or report one that did not happen.
//
// Every failure mode is swallowed: an audit row is never worth breaking a
// settings write that already succeeded.

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine, pruneJsonlIfHeadStale } from './append-jsonl';
import { readJson } from './cli';
import { readRuntimeJson } from './runtime';
import { utcISOStamp } from './time';

type Json = any;

export type AuditTarget = 'config.json' | '.claude/settings.json' | '.claude/settings.local.json' | `${string}/access.json` | 'HEARTBEAT.md';

export interface AuditRow {
  ts: string;
  session_id: string;
  actor: string;
  target: AuditTarget;
  path: string;
  old?: Json;
  new?: Json;
  /** Ids and field names only, never values. Present on id-keyed array edits. */
  diff?: { added: string[]; removed: string[]; changed: Record<string, string[]> };
}

const RETENTION_DAYS = 90;
const VALUE_CAP = 120;

/** Filename under `state/` for the pre-migration config snapshot evolve-finalize writes. */
export const SNAPSHOT_FILE = 'evolve-config-snapshot.json';

/** A snapshot older than this is not a live upgrade; do not prefix the actor. */
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Path segments whose values never enter the ledger — only presence markers. */
const SECRET_SEGMENT = /^(.*token|.*secret|.*password|.*bearer)$/i;

export function ledgerPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'settings-audit.jsonl');
}

/** True when the leaf at `dotted` carries a credential, so its value must never be stored. */
export function isSecretPath(dotted: string): boolean {
  const segments = dotted.split('.');
  if (segments[0] === 'env') return true;
  return segments.some((s) => SECRET_SEGMENT.test(s));
}

/** Presence marker for a redacted leaf: what it became, never what it was. */
function presence(value: Json): string {
  return value === undefined || value === null || value === '' ? '[cleared]' : '[set]';
}

/** Serialize a value for the ledger, capped so a tail-read stays bounded. */
function capValue(value: Json): Json {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    return value.length > VALUE_CAP ? value.slice(0, VALUE_CAP) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const encoded = JSON.stringify(value) ?? '';
  return encoded.length > VALUE_CAP ? encoded.slice(0, VALUE_CAP) + '…' : encoded;
}

function isPlainObject(v: Json): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIdKeyedArray(v: Json): v is Json[] {
  return Array.isArray(v) && v.every((m) => isPlainObject(m) && typeof m.id === 'string');
}

/**
 * Structural diff for arrays of `{ id: string, ... }` objects. Ids and field
 * names only: values stay out so a `token` field cannot leak into the ledger
 * via this path. `old`/`new` on the row remain independently capped.
 */
function idKeyedArrayDiff(
  before: Json,
  after: Json,
): { added: string[]; removed: string[]; changed: Record<string, string[]> } | undefined {
  if (!isIdKeyedArray(before) || !isIdKeyedArray(after)) return undefined;
  const oldMap = new Map<string, Json>();
  const newMap = new Map<string, Json>();
  for (const m of before) oldMap.set(m.id, m);
  for (const m of after) newMap.set(m.id, m);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Record<string, string[]> = {};
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) removed.push(id);
  }
  for (const id of newMap.keys()) {
    if (!oldMap.has(id)) added.push(id);
  }
  for (const [id, next] of newMap) {
    const prev = oldMap.get(id);
    if (prev === undefined) continue;
    const fields: string[] = [];
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const key of keys) {
      if (JSON.stringify(prev[key]) === JSON.stringify(next[key])) continue;
      fields.push(key);
    }
    if (fields.length > 0) changed[id] = fields;
  }
  return { added, removed, changed };
}

/**
 * Prefix config.json writes made while an upgrade snapshot is live. Never
 * throws and never deletes the snapshot: readSnapshot() owns discard.
 */
function actorFor(stateDir: string, actor: string, target: AuditTarget): string {
  if (target !== 'config.json') return actor;
  if (actor === 'hermit-evolve' || actor === 'evolve-finalize') return actor;
  const snap = readJson(path.join(stateDir, 'state', SNAPSHOT_FILE));
  const taken = new Date(snap?.ts).getTime();
  if (Number.isNaN(taken) || Date.now() - taken > SNAPSHOT_MAX_AGE_MS) return actor;
  return `upgrade:${actor}`;
}

/**
 * Leaf-level diff. Arrays are atomic: a routines[] edit is one row, not one row
 * per index — index-level rows churn on reorder and read as noise.
 */
export function diffLeaves(before: Json, after: Json, prefix = ''): Array<{ path: string; old: Json; new: Json }> {
  const changes: Array<{ path: string; old: Json; new: Json }> = [];
  const keys = new Set([
    ...(isPlainObject(before) ? Object.keys(before) : []),
    ...(isPlainObject(after) ? Object.keys(after) : []),
  ]);
  for (const key of keys) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    const b = isPlainObject(before) ? before[key] : undefined;
    const a = isPlainObject(after) ? after[key] : undefined;
    if (isPlainObject(b) && isPlainObject(a)) {
      changes.push(...diffLeaves(b, a, dotted));
      continue;
    }
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    changes.push({ path: dotted, old: b, new: a });
  }
  return changes;
}

/**
 * Append one row per changed leaf. `before === undefined` means the file did not
 * exist (hatch), which records a single "config created" row rather than one row
 * per default the template ships.
 *
 * Call this AFTER the caller's own write has succeeded — auditing first would
 * record changes that a failed write never made. Never throws.
 */
export function auditConfigChange(
  stateDir: string,
  before: Json,
  after: Json,
  actor: string,
  target: AuditTarget = 'config.json',
): void {
  try {
    // The ledger belongs to an existing hermit. Never bring the state dir into
    // being here: a caller that resolved the wrong directory would otherwise
    // scatter .hermit/ dirs outside any project (and a stray one
    // captures hermitDir()'s walk-up for every later script run).
    if (!fs.existsSync(stateDir)) return;

    const ts = utcISOStamp();
    const runtime = readRuntimeJson(path.join(stateDir, 'state'));
    const session_id = runtime?.session_id ?? 'unknown';
    const attributed = actorFor(stateDir, actor, target);

    const rows: AuditRow[] =
      before === undefined
        ? [{ ts, session_id, actor: attributed, target, path: '*', new: 'config created' }]
        : diffLeaves(before, after).map(({ path: dotted, old, new: next }) => {
            if (isSecretPath(dotted)) {
              return { ts, session_id, actor: attributed, target, path: dotted, old: presence(old), new: presence(next) };
            }
            const row: AuditRow = {
              ts, session_id, actor: attributed, target, path: dotted,
              old: capValue(old), new: capValue(next),
            };
            const diff = idKeyedArrayDiff(old, next);
            if (diff) row.diff = diff;
            return row;
          });
    if (rows.length === 0) return;

    const file = ledgerPath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    pruneJsonlIfHeadStale(file, RETENTION_DAYS * 86_400_000, new Date());
    for (const row of rows) appendJsonlLine(file, JSON.stringify(row));
  } catch {
    // Fail open: the config write already landed, and a missing audit row must
    // never turn a successful settings change into an error for the operator.
  }
}

/** Newest-last rows, optionally filtered by dotted-path prefix. Bounded by `limit`. */
export function readHistory(stateDir: string, dotted?: string, limit = 20): AuditRow[] {
  const file = ledgerPath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const rows: AuditRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as AuditRow;
      // Match in both directions: a query for `channels` must find the
      // `channels.discord` row, and a query for `channels.discord.enabled` must
      // find the row a whole-object `set channels.discord '{…}'` recorded.
      if (
        dotted &&
        row.path !== dotted &&
        !row.path.startsWith(`${dotted}.`) &&
        !dotted.startsWith(`${row.path}.`)
      ) continue;
      rows.push(row);
    } catch {
      continue;
    }
  }
  return rows.slice(-limit);
}
