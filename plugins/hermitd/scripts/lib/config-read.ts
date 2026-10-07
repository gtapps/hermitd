// Settled config read path — the one tolerant reader for `.hermit/config.json`.
//
// Every read-only consumer goes through readSettledConfig() so a malformed field
// has ONE answer everywhere (previously: timezone "" was "" to the watchdog,
// 'UTC' to the cost ledger, and null to routines). Settling is by declared
// SHAPE only, never vocabulary:
//
//   - missing file / unreadable / malformed JSON / non-object  -> all defaults
//   - nullable scalar (template value null): malformed or ""    -> null
//   - non-nullable scalar: malformed                            -> template default
//   - enum-ish strings (escalation, ...): any non-empty string
//     passes through — membership stays advisory in validate-config.ts, so
//     custom operator modes are never erased
//   - nested blocks: wrong-typed block -> default block; well-typed block is
//     spread first, then known sub-keys settled — operator-added keys survive
//     at every nesting level (never allowlist-project)
//   - containers (routines, channels, monitors, env, ...): malformed -> EMPTY,
//     never the template's seed values (settling a broken `routines` to the
//     template's seeded routines would resurrect routines the operator deleted);
//     item contents are not normalized here
//
// This module never writes, never throws, and never rejects unknown keys.
// Writer paths (settings-edit, hatch-config, evolve-finalize) deliberately do
// NOT use it — an existing-but-malformed file must abort there, never fall
// through to defaults (see settings-edit.ts). Schema *validation* stays in
// validate-config.ts (advisory PostToolUse hook); defaults live here. The
// defaults table below mirrors state-templates/config.json.template —
// tests/config-read.test.ts enforces top-level key parity.

import fs from 'node:fs';
import path from 'node:path';
import { ESCALATION, OPERATOR_PROFILE, AUTH_MODE, QUALITY_GATE_TIER, BUDGET_ACTION, VOICE_STYLE, EFFORT } from './settings/enums';

type Json = any;

// Deliberately Json, not a 40-key interface: consumers use untyped dotted
// access throughout the codebase; the reader's contract is behavioral.
export type SettledConfig = Json;

export type Spec =
  | { kind: 'string'; def: string | null; enum?: readonly string[]; pattern?: 'duration' | 'time'; nullable?: boolean }
  | { kind: 'boolean'; def: boolean | null }
  | { kind: 'number'; def: number | null; range?: [number, number]; nullable?: boolean }
  | { kind: 'array' }
  | { kind: 'map' }
  | { kind: 'shape'; sub: Record<string, Spec> };

const str = (def: string | null, facts: Omit<Extract<Spec, { kind: 'string' }>, 'kind' | 'def'> = {}): Spec => ({ kind: 'string', def, nullable: def === null, ...facts });
const bool = (def: boolean | null): Spec => ({ kind: 'boolean', def });
const num = (def: number | null, facts: Omit<Extract<Spec, { kind: 'number' }>, 'kind' | 'def'> = {}): Spec => ({ kind: 'number', def, nullable: def === null, ...facts });
const arr: Spec = { kind: 'array' };
const map: Spec = { kind: 'map' };
const shape = (sub: Record<string, Spec>): Spec => ({ kind: 'shape', sub });

// One row per top-level template key. Adding a key to the template without a
// row here fails the template-parity test.
export const TABLE: Record<string, Spec> = {
  _hermit_versions: map,
  agent_name: str(null),
  language: str(null),
  timezone: str(null),
  escalation: str('balanced', { enum: ESCALATION }),
  operator_profile: str('technical', { enum: OPERATOR_PROFILE }),
  voice: shape({ style: str(null, { enum: VOICE_STYLE }), prose: str(null) }),
  channels: map,
  remote: bool(true),
  auth_mode: str(null, { enum: AUTH_MODE }),
  model: str('sonnet', { nullable: true }),
  effort: str(null),
  permission_mode: str('auto'),
  tmux_session_name: str('hermit-{project_name}'),
  auto_session: bool(true),
  always_on: bool(false),
  chrome: bool(false),
  push_notifications: bool(true),
  ask_gate: bool(true),
  routine_max_lateness_minutes: num(60),
  routines: arr,
  monitors: arr,
  env: map,
  boot_skill: str(null),
  shutdown_skill: str(null),
  scheduled_checks: arr, // Session-triggered checks; preserve operator-authored entry fields.
  docker: shape({ packages: arr, recommended_plugins: arr, fleet_mesh: bool(false) }),
  tasks: shape({ handle_in_dm: bool(false), duties_open_records: bool(true), queue_nudge_minutes: num(60, { range: [1, Infinity] }) }),
  heartbeat: shape({
    enabled: bool(true),
    every: str('30m', { pattern: 'duration' }),
    active_hours: shape({ start: str('08:00', { pattern: 'time' }), end: str('23:00', { pattern: 'time' }) }),
    stale_threshold: str('2h', { pattern: 'duration' }),
    waiting_timeout: str(null, { pattern: 'duration' }),
    clean_recheck_cooldown: str('6h', { pattern: 'duration', nullable: true }),
    model: str('haiku'),
    effort: str('high', { enum: EFFORT }),
  }),
  quality_gate: shape({ tier: str('budget', { enum: QUALITY_GATE_TIER }) }),
  knowledge: shape({
    raw_retention_days: num(14),
    compiled_budget_chars: num(2500),
    working_set_warn: num(20),
    usage_stale_days: num(30),
    usage_auto_archive: bool(true),
    archive_retention_days: num(null),
    channel_log_enabled: bool(true),
    channel_log_retention_days: num(90),
  }),
  watchdog: shape({
    enabled: bool(false),
    scheduler_enabled: bool(true),
    stale_factor: num(2),
    wedge_floor: str('4h', { pattern: 'duration' }),
    escalate_after: num(3),
    operator_grace: str('15m', { pattern: 'duration' }),
  }),
  budget: shape({
    daily_usd: num(null),
    weekly_usd: num(null),
    monthly_usd: num(null),
    action: str('alert', { enum: BUDGET_ACTION }),
  }),
  telemetry_export: shape({
    enabled: bool(false),
    destination: shape({ type: str('webhook'), url: str(null), bearer_env: str('HERMIT_TELEMETRY_TOKEN') }),
    interval_hours: num(24),
    redact_operator_text: bool(true),
  }),
  backup: shape({
    enabled: bool(false),
    mode: str('workspace'),
    schedule: str('0 3 * * *'),
    remote: str(null),
    push: bool(true),
    include: arr,
  }),
  artifacts: shape({
    dashboard: bool(true),
    proposals: bool(true),
    weekly_review: bool(false),
    publish_authorized: bool(null),
    backend: str('claude'),
  }),
  context_hygiene: shape({
    clear: shape({ enabled: bool(true), quiet: str('1h'), max_age: str('24h'), min_tokens: num(20000) }),
    compact: shape({ enabled: bool(true), min_context_tokens: num(100000), min_interval: str('4h') }),
  }),
  reflection: shape({ graduation_min_sessions: num(1) }),
  routine_wake_lint: shape({ max_windows: num(6, { range: [1, 48] }) }),
  doctor: shape({ routine_cost_floor_usd: num(2, { range: [0, Infinity] }) }),
  storage_drift: shape({ ignore: arr }),
};

export function specAt(dotted: string): Spec | undefined {
  let rows = TABLE;
  const parts = dotted.split('.');
  for (const [index, part] of parts.entries()) {
    const spec = rows[part];
    if (!spec || index === parts.length - 1) return spec;
    if (spec.kind !== 'shape') return undefined;
    rows = spec.sub;
  }
  return undefined;
}

// For the template-parity test.
export const SETTLED_KEYS = Object.keys(TABLE);

function isPlainObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function settleValue(spec: Spec, raw: Json): Json {
  // Explicit null on a scalar is a deliberate operator value (disable
  // semantics, e.g. heartbeat.clean_recheck_cooldown: null turns the damper
  // off) — preserve it; only wrong types and "" settle to the default.
  if (raw === null && spec.kind !== 'shape' && spec.kind !== 'map' && spec.kind !== 'array') return null;
  switch (spec.kind) {
    case 'string':
      return typeof raw === 'string' && raw !== '' ? raw : spec.def;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : spec.def;
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : spec.def;
    case 'array':
      return Array.isArray(raw) ? raw : [];
    case 'map':
      return isPlainObject(raw) ? raw : {};
    case 'shape': {
      const base: Record<string, Json> = isPlainObject(raw) ? { ...raw } : {};
      for (const [k, sub] of Object.entries(spec.sub)) base[k] = settleValue(sub, base[k]);
      return base;
    }
  }
}

/** Pure and total: any input settles to a full config (unknown keys preserved). */
export function settleConfig(raw: unknown): SettledConfig {
  const settled: Record<string, Json> = isPlainObject(raw) ? { ...raw } : {};
  for (const [key, spec] of Object.entries(TABLE)) settled[key] = settleValue(spec, settled[key]);
  return settled;
}

/** True when `<dir>/config.json` exists — for callers whose absence-gate is behavioral. */
export function configExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'config.json'));
}

/** The hermit's own name, or 'Hermit'. Lives here, not with its first caller
 *  (lib/dashboard.ts): channel-send needs it on the per-prompt/per-Stop hook
 *  path, and importing the dashboard renderer for one field would drag its whole
 *  artifact graph into every one of those hook processes. */
export function agentNameFromConfig(config: Json): string {
  return typeof config?.agent_name === 'string' && config.agent_name.trim() ? config.agent_name : 'Hermit';
}

/** The configured artifact backend when it is NOT the default claude.ai path,
 *  else null. Unset, non-string, whitespace-only and the literal `"claude"` all
 *  mean the default. Lives here, not with a caller, because two independent
 *  paths decide on it — hermitd-start's boot-time Artifact grant and the
 *  PreToolUse publish guard — and a drift between them would either pre-approve
 *  or fail to block exactly the publish the backend exists to prevent. */
export function foreignArtifactBackend(config: Json): string | null {
  const raw = config?.artifacts?.backend;
  const backend = typeof raw === 'string' ? raw.trim() : '';
  return backend === '' || backend === 'claude' ? null : backend;
}

/** Never throws: unreadable or malformed config settles to full defaults. */
export function readSettledConfig(dir: string): SettledConfig {
  const raw = readConfigRaw(dir);
  return settleConfig(raw ?? undefined);
}

// Escape hatch for the few consumers whose semantics deliberately distinguish
// "config unreadable" from "config empty" (routines run-record tri-state, the
// prompt pipeline's disclosure gates, channel-send's config_read_failed error).
// Everything else uses readSettledConfig — do not reach for this to skip
// settling.
export function readConfigRaw(dir: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}
