/**
 * settings-edit.ts — read-modify-write helper for .hermit/config.json scalar/enum edits.
 *
 * Usage: bun settings-edit.ts <config-file> <op> [args...]
 *
 * Operations:
 *   get [dotted.path]        Print {"value":...} at path (whole config if path omitted)
 *   set <dotted.path> <val>  Set a nested leaf, creating parent objects as needed
 *   unset <dotted.path>      Delete a nested leaf (parents are left in place)
 *   toggle <dotted.path>     Boolean flip (absent → true; errors if current isn't boolean)
 *   show                     Print the settings summary data from live values
 *   apply-known <arg> <val>  Write one registry-backed setting, validated by kind/enum
 *   history [path] [--limit N]  Print recent audited changes, newest last
 *   record-file HEARTBEAT.md    Record the checklist fingerprint in the audit ledger
 *
 * Output: a write prints `OK`, or `{"warnings":[...]}` when validation warned;
 * `get`, `show`, `apply-known`, `history` and `record-file` print one JSON
 * object; a failure prints `{"error":"<token>[:detail]"}` with exit 1.
 *
 * Value parsing for `set`: 'none'/'clear' → null; otherwise JSON.parse first
 * (so true, 42, "x", {...} work), falling back to the raw string on parse failure.
 *
 * Rules:
 * - Changes only the target leaf; all sibling keys are preserved (read-modify-write).
 * - Refuses to overwrite an existing-but-malformed config.json (never falls through to {}).
 * - Safe under AGENT_HOOK_PROFILE=strict: writes via fs, not the Edit/Write tools.
 * - Every successful mutation is recorded in state/settings-audit.jsonl.
 * - Zero runtime deps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, READ_ONLY, byArg, type Setting } from './lib/settings/registry';
import { auditConfigChange, readHistory } from './lib/config-audit';
import { sha256 } from './lib/hash';
import { persistConfig, canonicalTimezone } from './lib/config-write';
import { validate, ROUTINE_ID_RE } from './validate-config';
import { flagValue, flagEq, emit, emitJson, exitError, failJson } from './lib/cli';
import { safeForLLM } from './lib/sanitize';
import { resolveGate, projectRootOf } from './lib/routines/gate';
import { renameCursors } from './lib/routines/schedule';

type Json = any;

// Versioned migrations preserve unrelated operator settings. The normal persist
// path validates the complete result and records only the changed leaves.
// A migration declares whether it takes arguments and any effect after persist.
type Report = Record<string, unknown>;
type Migration = {
  run: (config: Json, ctx: { args: string[]; hermitDir: string }) => Report | void;
  takesArgs?: boolean;
  afterPersist?: (hermitDir: string, report: Report) => void;
};
const noArgs = (run: (config: Json) => Report | void): Migration => ({ run });
const PLUGIN_ID = '[a-z0-9][a-z0-9-]*';
const PLUGIN_ID_RE = new RegExp(`^${PLUGIN_ID}$`);
const SIBLING_SKILL_RE = new RegExp(`^/${PLUGIN_ID}:[^\\s:]+$`);
type Rename = { from: string; to: string };

const migrations: Record<string, Migration> = {
  'plugin-routine-ids': {
    takesArgs: true,
    run: (config, ctx) => {
      const plugin = flagValue(ctx.args, '--plugin');
      const ids = flagValue(ctx.args, '--ids')?.split(',');
      if (ctx.args.length !== 4 || ctx.args[0] !== '--plugin' || ctx.args[2] !== '--ids'
        || !plugin || !PLUGIN_ID_RE.test(plugin) || !ids
        || ids.some(id => !ROUTINE_ID_RE.test(id) || id.includes(':'))) {
        throw new Error('expected --plugin <id> --ids <csv>');
      }
      const seeded = new Set(ids);
      const renamed: Rename[] = [];
      const scriptGated: string[] = [];
      for (const routine of Array.isArray(config.routines) ? config.routines : []) {
        if (!seeded.has(routine?.id) || typeof routine?.skill !== 'string') continue;
        const tokens = routine.skill.trim().split(/\s+/);
        let invoked = tokens[0].replace(/^\//, '');
        if (invoked === 'hermitd:reflect') invoked = flagValue(tokens.slice(1), '--check')?.replace(/^\//, '') ?? invoked;
        if (!invoked.startsWith(`${plugin}:`)) continue;
        const target = `${plugin}:${routine.id}`;
        if (!ROUTINE_ID_RE.test(target)) throw new Error(`invalid_target_id:${target}`);
        renamed.push({ from: routine.id, to: target });
        routine.id = target;
        // A script gate sees the routine's last fire by id, and that history stays under the old id.
        if (routine.precheck !== undefined
          && resolveGate(routine.precheck, projectRootOf(ctx.hermitDir)).kind === 'script') scriptGated.push(target);
      }
      if (!renamed.length) return;
      if (!scriptGated.length) return { renamed };
      return {
        renamed,
        note: `${scriptGated.join(', ')} may run once early because run history stays under the old id. `
          + 'References to the old ids in operator files still move to the new ones.',
      };
    },
    afterPersist: (hermitDir, report) => {
      if (report.renamed) renameCursors(hermitDir, report.renamed as Rename[]);
    },
  },
  'clear-sibling-boot-skill': {
    takesArgs: true,
    run: (config, ctx) => {
      const skill = flagValue(ctx.args, '--skill');
      if (ctx.args.length !== 2 || ctx.args[0] !== '--skill' || !skill
        || !SIBLING_SKILL_RE.test(skill)) {
        throw new Error('expected --skill /<plugin>:<name>');
      }
      if (config.boot_skill === skill) {
        config.boot_skill = null;
        return { cleared: skill };
      }
    },
  },
  'channel-home': noArgs((config) => {
    for (const [name, channel] of Object.entries(config.channels ?? {}) as [string, Json][]) {
      if (name === 'primary' || !channel || typeof channel !== 'object') continue;
      if ((channel.default_chat_id == null || channel.default_chat_id === '')
        && typeof channel.dm_channel_id === 'string' && channel.dm_channel_id !== ''
        && channel.dm_channel_id !== channel.maintainer_channel_id) {
        channel.default_chat_id = channel.dm_channel_id;
      }
      delete channel.dm_channel_id;
    }
  }),
  '1.4.0': noArgs((config) => {
    unsetPath(config, 'post_close_clear');
    if (getPath(config, 'context_hygiene.clear') === undefined) {
      setPath(config, 'context_hygiene.clear', {
        enabled: true, quiet: '1h', max_age: '24h', min_tokens: 20000,
      });
    }
    if (Array.isArray(config.routines)) {
      config.routines = config.routines.filter((routine: Json) => routine?.id !== 'daily-auto-close');
      for (const routine of config.routines) {
        if (routine && typeof routine === 'object') delete routine.run_during_waiting;
      }
    }
    if (['/hermitd:session', '/hermitd:session-start'].includes(config.boot_skill)) { // resident-start migration aliases
      config.boot_skill = '/hermitd:resident-start';
    }
  }),
};

// Strict read: an existing-but-malformed file must abort, never fall through to {},
// otherwise the write below would clobber the operator's config with our subset.
function readTargetJson(filePath: string): Json {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return exitError('invalid_json');
  }
}

function parseValue(raw: string): Json {
  if (raw === 'none' || raw === 'clear') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// --- Pure path helpers (exported for unit tests) ---

export function getPath(obj: Json, dotted?: string): Json {
  if (!dotted) return obj;
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * A dotted segment read as an array index: whole, non-negative, canonically spelled.
 * Leading zeros are rejected rather than normalized — `routines.01` is a typo, and
 * silently splicing index 1 for it is worse than refusing.
 */
function arrayIndex(key: string): number | null {
  return /^(0|[1-9]\d*)$/.test(key) ? Number(key) : null;
}

/** The range error both the leaf and the traversal raise, so they read the same. */
function indexRangeError(dotted: string, key: string, len: number, appendable: boolean): Error {
  const max = appendable ? len : len - 1;
  if (max < 0) return new Error(`index_out_of_range:${dotted}: "${key}" indexes an empty array`);
  return new Error(
    `index_out_of_range:${dotted}: index out of range — valid indices are 0..${max}` +
      (appendable ? `, where ${len} appends a new entry` : ''),
  );
}

/**
 * Write one value at a dotted path.
 *
 * An index past the end of an array is refused rather than written: JS would grow the
 * array with holes, and a `null` entry fails validation from then on. `=== length` is
 * the append every add goes through, so it is allowed at the LEAF only — an interior
 * segment (`routines.<n>.enabled`) is editing an entry that has to already exist, so
 * there `length` is out of range like anything past it.
 */
export function setPath(obj: Json, dotted: string, value: Json): Json {
  const keys = dotted.split('.');
  const leaf = keys.pop()!;
  let cur = obj;
  for (const key of keys) {
    if (Array.isArray(cur)) {
      const i = arrayIndex(key);
      if (i === null || i >= cur.length) throw indexRangeError(dotted, key, cur.length, false);
    }
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  if (Array.isArray(cur)) {
    const i = arrayIndex(leaf);
    if (i === null || i > cur.length) throw indexRangeError(dotted, leaf, cur.length, true);
  }
  cur[leaf] = value;
  return obj;
}

/**
 * Delete a leaf. Parent objects stay — an empty `channels` is still a valid config.
 *
 * An array index splices instead: `delete arr[1]` leaves a hole that serializes as
 * `null`, and every later write then fails validation on an entry with no `id`. The
 * whole point of `unset routines.<n>` is removing one routine without rewriting the
 * array, so it has to leave the array dense.
 */
export function unsetPath(obj: Json, dotted: string): boolean {
  const keys = dotted.split('.');
  const leaf = keys.pop()!;
  let cur = obj;
  for (const key of keys) {
    if (typeof cur[key] !== 'object' || cur[key] === null) return false;
    cur = cur[key];
  }
  if (Array.isArray(cur)) {
    const i = arrayIndex(leaf);
    if (i === null || i >= cur.length) return false;
    cur.splice(i, 1);
    return true;
  }
  if (!(leaf in cur)) return false;
  delete cur[leaf];
  return true;
}

export function togglePath(obj: Json, dotted: string): Json {
  const current = getPath(obj, dotted);
  if (current !== undefined && typeof current !== 'boolean') {
    throw new Error(`not_boolean:${dotted}`);
  }
  return setPath(obj, dotted, current === undefined ? true : !current);
}

// --- show: the settings summary data from live values ---
//
// This replaces a hand-written *example* dump in hermit-settings/SKILL.md, a
// ~45-line block of invented values whose field list drifted every release and
// which showed the operator someone else's configuration. Reading the real file
// is both accurate and strictly more useful.

/** Rows for the stateful sections `show` summarizes but the registry doesn't own. */
function statefulRows(config: Json): Json[] {
  const channels = config.channels ?? {};
  const channelNames = Object.keys(channels).filter(k => k !== 'primary');
  const enabled = channelNames.filter(n => channels[n]?.enabled);
  const routines = Array.isArray(config.routines) ? config.routines : [];
  const checks = Array.isArray(config.scheduled_checks) ? config.scheduled_checks.filter((c: Json) => c?.trigger === 'session') : [];
  const envKeys = Object.keys(config.env ?? {});
  const packages = config.docker?.packages ?? [];
  const hb = config.heartbeat ?? {};
  const wd = config.watchdog ?? {};
  // The brief lives per-channel (`channels.<name>.morning_brief`), so it has no
  // registry row — but `/hermit-settings brief` is a real argument and the view
  // it replaced showed the brief's state, so it belongs here.
  const briefOn = channelNames.filter(n => channels[n]?.morning_brief?.enabled);
  const count = (rows: Json[]) => ({ enabled: rows.filter((r: Json) => r?.enabled).length, total: rows.length });

  return [
    { arg: 'channels', label: 'Channels', configured: channelNames, enabled },
    { arg: 'brief', label: 'Morning brief', enabled: briefOn.map(n => ({ channel: n, time: channels[n].morning_brief.time ?? null })) },
    { arg: 'heartbeat', label: 'Heartbeat', enabled: !!hb.enabled, every: hb.every ?? null },
    { arg: 'watchdog', label: 'Watchdog', scheduler: wd.scheduler_enabled !== false, recovery: !!wd.enabled },
    { arg: 'routines', label: 'Routines', ...count(routines) },
    { arg: 'scheduled-checks', label: 'Session checks', ...count(checks) },
    { arg: 'env', label: 'Environment', keys: envKeys },
    { arg: 'docker', label: 'Docker packages', packages: Array.isArray(packages) ? packages : [] },
  ];
}

/**
 * Live values grouped by area, each with the argument that changes it and when the
 * change applies. An absent `value` means the key is unset: not set on a `nullable` row,
 * otherwise its default applies.
 */
export function showData(config: Json, configPath: string): Json {
  const out: Json = { config_path: configPath };
  for (const group of ['Identity', 'Operational', 'Artifacts'] as const) {
    const rows: Json[] = SETTINGS.filter(s => s.group === group).map(s => ({
      arg: s.arg, label: s.label, value: getPath(config, s.path),
      ...(s.nullable ? { nullable: true } : {}), ...(s.applies ? { applies: s.applies } : {}),
    }));
    for (const r of READ_ONLY.filter(r => r.group === group)) {
      rows.push({ arg: null, label: r.label, value: getPath(config, r.path) });
    }
    if (rows.length) out[group.toLowerCase()] = rows;
  }
  // Each stateful section has its own wizard under its argument.
  out.stateful = statefulRows(config);
  return out;
}

// --- apply-known: write one registry-backed setting, validated ---
//
// `set` takes any dotted path and any JSON value, which is right for the
// stateful branches that compose their own writes. For the table-driven
// arguments it is too loose: this script writes through `fs`, so the
// `validate-config.ts` PostToolUse hook never sees the write, and a typo'd enum
// or a mistyped path would land silently. `apply-known` takes the *argument
// name* the operator typed, so neither the path nor the value can be invented.

export interface ApplyResult {
  ok: boolean;
  /** Refusal token, and the human-readable detail behind it. */
  reason?: 'unknown_setting' | 'invalid_value';
  detail?: string;
  path?: string;
  value?: Json;
  applies?: string;
}

export function coerce(setting: Setting, raw: string): { ok: true; value: Json } | { ok: false; message: string } {
  if ((raw === 'none' || raw === 'clear')) {
    if (!setting.nullable) return { ok: false, message: `${setting.arg} cannot be cleared` };
    return { ok: true, value: null };
  }
  // On a nullable row, "default" means "inherit Claude Code's default", not a
  // value: storing the literal string would send `--model default` on the next
  // `hermitd-start`. Only nullable rows — `permission_mode` has a real `default`.
  // An enum that lists `default` among its own values is the other exception:
  // `voice` persists the lowercase literal Claude Code's picker writes, so
  // swallowing it here would leave the style unset and the last rendered
  // `outputStyle` in place forever.
  const enumHasDefault = setting.kind === 'enum' && (setting.values ?? []).includes('default');
  if (setting.nullable && raw === 'default' && !enumHasDefault) return { ok: true, value: null };
  switch (setting.kind) {
    case 'timezone': {
      const zone = canonicalTimezone(raw);
      return zone ? { ok: true, value: zone } : { ok: false, message: 'timezone expects an IANA timezone name (for example Europe/Lisbon)' };
    }
    case 'boolean': {
      const truthy = ['true', 'yes', 'on', 'enable', 'enabled'];
      const falsy = ['false', 'no', 'off', 'disable', 'disabled'];
      const v = raw.toLowerCase();
      if (truthy.includes(v)) return { ok: true, value: true };
      if (falsy.includes(v)) return { ok: true, value: false };
      return { ok: false, message: `${setting.arg} expects on/off (got "${raw}")` };
    }
    case 'enum': {
      const values = setting.values ?? [];
      if (!values.includes(raw)) {
        return { ok: false, message: `${setting.arg}: "${raw}" not in [${values.join(', ')}]` };
      }
      return { ok: true, value: raw };
    }
    case 'int': {
      if (!/^\d+$/.test(raw)) return { ok: false, message: `${setting.arg} expects a positive integer (got "${raw}")` };
      const n = parseInt(raw, 10);
      if (n < 1) return { ok: false, message: `${setting.arg} expects a positive integer (got "${raw}")` };
      return { ok: true, value: n };
    }
    default:
      // Free-text rows store the operator's value verbatim, so refuse an empty one
      // here — this is the point of the write. Clearing goes through none/clear above
      // (nullable rows only); an empty string is not a value any string row wants.
      if (raw.trim() === '') return { ok: false, message: `${setting.arg} expects a non-empty value` };
      return { ok: true, value: raw };
  }
}

export function applyKnown(config: Json, arg: string, raw: string): ApplyResult {
  const setting = byArg(arg);
  if (!setting) {
    return { ok: false, reason: 'unknown_setting', detail: `unknown setting "${arg}" — see the argument table in /hermit-settings` };
  }
  const coerced = coerce(setting, raw);
  if (!coerced.ok) return { ok: false, reason: 'invalid_value', detail: coerced.message };
  setPath(config, setting.path, coerced.value);
  return { ok: true, path: setting.path, value: coerced.value, applies: setting.applies ?? 'immediately' };
}

// --- CLI dispatch ---

if (import.meta.main) {
  const [, , targetFile, op, ...rest] = process.argv;

  if (!targetFile || !op) exitError();

  // The state dir is the config's own directory (.hermit/), where the
  // audit ledger lives under state/.
  const stateDir = path.dirname(path.resolve(targetFile));

  // `history` reads the ledger, never the config — and it runs BEFORE the strict
  // read below on purpose. A config someone corrupted is exactly when the operator
  // needs to ask who last touched it, and readTargetJson would exit(1) first.
  if (op === 'history') {
    const limitArg = flagValue(rest, '--limit') ?? flagEq(rest, 'limit');
    const limit = limitArg !== undefined ? Number(limitArg) || 20 : 20;
    // Positional arg excludes every `--flag` and, for the two-token `--limit N`
    // form, the value token right after it — otherwise the limit's number reads
    // as the dotted path.
    const dotted = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--limit');
    // An absent `old` is a key that was unset before; an absent `new`, one removed.
    // Id-keyed array edits carry `diff` (ids and field names) instead of values.
    const rows = readHistory(stateDir, dotted, limit)
      .map(({ ts, path: p, actor, old, new: next, diff }) => (diff ? { ts, path: p, actor, diff } : { ts, path: p, actor, old, new: next }));
    emitJson({ rows });
  }

  // Same reason as history: a malformed config.json must not block this.
  if (op === 'record-file') {
    const name = rest[0];
    if (name !== 'HEARTBEAT.md') exitError('unsupported_file');
    const filePath = path.join(stateDir, name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      exitError('not_found');
    }
    const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
    const lineCount = trimmed.split('\n').length;
    const current = `${sha256(content).slice(0, 12)} (${lineCount} lines)`;
    const previous = readHistory(stateDir, 'HEARTBEAT.md', 1).at(-1)?.new;
    auditConfigChange(
      stateDir,
      { 'HEARTBEAT.md': previous },
      { 'HEARTBEAT.md': current },
      'heartbeat-edit',
      'HEARTBEAT.md',
    );
    emitJson({ status: previous === current ? 'unchanged' : 'recorded', fingerprint: current });
  }

  const config = readTargetJson(targetFile);
  // Snapshot before any mutation — setPath and friends mutate in place, so a
  // reference would diff against itself and report nothing.
  const before: Json = structuredClone(config);
  // A file that doesn't exist yet reads as {}; tell the audit ledger so it records
  // one "config created" row instead of a row per template default.
  const existedBefore = fs.existsSync(targetFile);

  /**
   * Persist a mutation: refuse it if it would introduce NEW validation errors,
   * then write and audit. Pre-existing errors in the operator's config are not
   * this command's business — blocking on them would lock the operator out of
   * the very edits that fix them. Rerouting the hermit-settings array branches
   * through this path removes the validate-config PostToolUse hook (fs writes
   * never trip it), which is why the check lives here.
   */
  const persist = (actor = 'settings-edit'): string[] => {
    const { newErrors, newWarnings } = persistConfig({
      hermitDir: stateDir, before: existedBefore ? before : undefined, after: config, actor,
      // A new file forgives what an empty config already fails (missing required keys).
      priorErrors: existedBefore ? undefined : validate({}).errors,
    });
    if (newErrors.length > 0) emitJson({ error: 'invalid_config', errors: newErrors });
    // Warnings don't block, but they must still be seen: the branches rerouted
    // through this path used to write via Edit/Write, where the validate-config
    // PostToolUse hook surfaced them. Dropping them silently would be a regression.
    return newWarnings.map((w) => safeForLLM(w));
  };
  /** A write's receipt: `OK`, or its validation warnings. */
  const done = (warnings: string[]): never => (warnings.length ? emitJson({ warnings }) : emit('OK'));

  switch (op) {
    case 'migrate': {
      const migration = Object.hasOwn(migrations, rest[0]) ? migrations[rest[0]] : undefined;
      if (!migration || (!migration.takesArgs && rest.length !== 1)) exitError('unsupported_migration');
      let report: Report | void;
      try {
        report = migration.run(config, { args: rest.slice(1), hermitDir: stateDir });
      } catch (err) {
        exitError(`migration_conflict:${(err as Error).message}`);
      }
      const warnings = JSON.stringify(before) !== JSON.stringify(config) ? persist(`settings-migrate:${rest[0]}`) : [];
      if (report) migration.afterPersist?.(stateDir, report);
      if (report && Object.keys(report).length) emitJson({ ...report, ...(warnings.length ? { warnings } : {}) });
      done(warnings);
      break;
    }

    case 'get': {
      const value = getPath(config, rest[0]);
      emitJson(value === undefined ? { status: 'none', reason: 'not_set' } : { value });
      break;
    }

    case 'show': {
      emitJson(showData(config, targetFile));
      break;
    }

    case 'apply-known': {
      const [arg, value] = rest;
      if (!arg || value === undefined) exitError();
      const result = applyKnown(config, arg, value);
      if (!result.ok) emitJson({ status: 'refused', reason: result.reason, detail: result.detail });
      const warnings = persist();
      emitJson({ path: result.path, value: result.value, applies: result.applies, ...(warnings.length ? { warnings } : {}) });
      break;
    }

    case 'set': {
      const dotted = rest[0];
      if (!dotted || rest.length < 2) exitError();
      try {
        setPath(config, dotted, parseValue(rest[1]));
      } catch (err) {
        failJson(err);
        process.exit();
      }
      done(persist());
      break;
    }

    case 'unset': {
      const dotted = rest[0];
      if (!dotted) exitError();
      if (!unsetPath(config, dotted)) emitJson({ status: 'none', reason: 'not_set' });
      done(persist());
      break;
    }

    case 'toggle': {
      const dotted = rest[0];
      if (!dotted) exitError();
      try {
        togglePath(config, dotted);
      } catch (err) {
        failJson(err);
        process.exit();
      }
      done(persist());
      break;
    }

    default:
      exitError(`unknown_op:${op}`);
  }
}
