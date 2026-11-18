/**
 * Shared runtime.json state helpers for the lifecycle scripts
 * (hermitd-start, hermitd-stop, hermitd-watchdog). Paths are CWD-relative —
 * callers run from the project root, like the Python originals did.
 */

import fs from 'node:fs';
import path from 'node:path';
import { localISOStamp } from './time';
import { resolveProjection } from './cc-compat';

type Json = any;

const STATE_DIR = '.hermit/state';
const RUNTIME_JSON = path.join(STATE_DIR, 'runtime.json');
const LIFECYCLE_LOCK = path.join(STATE_DIR, '.lifecycle.lock');

/**
 * Temp path for an atomic runtime.json write, unique per process.
 *
 * Four unsynchronized processes write runtime.json: the watchdog daemon, the Stop hook
 * (cost-tracker and stop-pipeline) and the PreCompact hook. A single shared temp name
 * lets two of them hold the SAME file open with O_TRUNC — one can then rename a
 * zero-length temp over runtime.json, and a reader landing on that instant sees a
 * corrupt record (hermitd-start refuses a duplicate boot on one). A per-process temp
 * keeps the rename genuinely atomic, so readers only ever see a complete old or
 * complete new file. Concurrent writers can still lose each other's FIELDS — that
 * needs a lock, not a temp name.
 */
function runtimeTmpPath(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, `.runtime.json.${process.pid}.tmp`);
}

const RUNTIME_TMP = runtimeTmpPath();

/** Atomic write to state/runtime.json; stamps updated_at. Pass an absolute stateDir to
 *  write to an anchored location instead of the cwd-relative default. */
function writeRuntimeJson(data: Json, stateDir?: string): void {
  const dir = stateDir ?? STATE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  data.updated_at = localISOStamp();
  const tmp = runtimeTmpPath(dir);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, path.join(dir, 'runtime.json'));
}

/** Read state/runtime.json; null when missing or invalid. Pass an absolute
 *  stateDir to read from an anchored location instead of the cwd-relative default. */
function readRuntimeJson(stateDir?: string): Json | null {
  const p = stateDir ? path.join(stateDir, 'runtime.json') : RUNTIME_JSON;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Outcome of a runtime.json read, keeping "absent" distinct from "unusable".
 *
 * readRuntimeJson() collapses both into null, which is fine for callers that
 * only branch on "do I have state?" — but a caller deciding whether it may
 * WRITE lifecycle state must not treat a corrupt or unreadable record as an
 * empty slot: overwriting it destroys the only copy of transition/last_error
 * markers that SessionStart recovery reads.
 */
type RuntimeRead =
  | { kind: 'ok'; data: Json }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

/** Read state/runtime.json as a tri-state. See RuntimeRead. */
function readRuntimeState(stateDir?: string): RuntimeRead {
  const p = stateDir ? path.join(stateDir, 'runtime.json') : RUNTIME_JSON;
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    // Only a genuine absence is 'missing'. EACCES/EISDIR/EIO mean the file may
    // well hold live state we simply cannot see — that is 'invalid', not empty.
    if (err?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', reason: err?.code ? `unreadable (${err.code})` : 'unreadable' };
  }
  let data: Json;
  try {
    data = JSON.parse(raw);
  } catch (err: any) {
    return { kind: 'invalid', reason: `malformed JSON (${err?.message ?? 'parse error'})` };
  }
  // `null`, arrays and scalars parse cleanly but carry no record. readRuntimeJson()
  // hands the same bytes back as a bare null, so calling them 'ok' here would make
  // the two readers disagree — and 'ok' promises `data` is dereferenceable.
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'invalid', reason: 'not a JSON object' };
  }
  return { kind: 'ok', data };
}

/** Read-modify-write runtime.json with atomic write. */
function updateRuntimeField(updates: Json): void {
  const runtime = readRuntimeJson() || {};
  Object.assign(runtime, updates);
  writeRuntimeJson(runtime);
}

/**
 * Refuse a lifecycle script run from a checkout whose `.hermit/` projects a real
 * root above it. STATE_DIR is cwd-relative, so any state write here would create
 * `state/` inside the projection and turn it into a root of its own.
 */
function refuseProjectionRoot(script: string): void {
  const here = path.resolve('.hermit');
  const root = resolveProjection(here);
  if (root === here) return;
  console.log(`[hermit] ${process.cwd()} is a checkout inside the agent project at ${path.dirname(root)}.`);
  console.log(`[hermit] Run ${script} from that folder.`);
  process.exit(1);
}

export { writeRuntimeJson, readRuntimeJson, readRuntimeState, updateRuntimeField, refuseProjectionRoot, runtimeTmpPath, STATE_DIR, RUNTIME_JSON, RUNTIME_TMP, LIFECYCLE_LOCK };
export type { RuntimeRead };
