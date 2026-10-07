import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadEnvFile } from './config';

export const SENSITIVE_DOMAINS = new Set(['lock', 'alarm_control_panel']);

export const SAFE_RELOAD_DOMAINS = new Set(['automation', 'script', 'scene']);

// Read-only MCP tools on the `homeassistant` server. The safety gate matches the
// whole `mcp__homeassistant__.*` namespace (default-deny chokepoint), so these
// query tools — which carry no entity_id and would otherwise hit the fail-closed
// branch and be blocked — must be short-circuited to allow. Explicit names, NOT a
// `*Get*` pattern: a permissive regex could silently grant a future mutating tool
// whose name happens to contain "Get". Extend this set against the live server's
// tool inventory if it exposes more read-only tools. HA 2026.9+ prefixes each
// tool with its integration's domain; the bare names cover older HA.
export const READ_ONLY_TOOLS = new Set([
  'GetLiveContext',
  'GetDateTime',
  'homeassistant__GetLiveContext',
  'llm__GetDateTime',
]);

const MCP_TOOL_PREFIX = 'mcp__homeassistant__';

// `Hass*` intent tools, bare (older HA) or with ONE domain prefix on HA 2026.9+
// (`intent__`, `light__`, `media_player__`, ...). A stacked prefix such as the
// multi-API `assist__intent__` is not matched, so it stays an opaque tool.
const HASS_INTENT_TOOL = /^mcp__homeassistant__(?:[a-z0-9]+(?:_[a-z0-9]+)*__)?Hass/;

/** True if `toolName` is a known read-only tool on the homeassistant MCP server. */
export function isReadOnlyTool(toolName: string): boolean {
  const bare = toolName.startsWith(MCP_TOOL_PREFIX)
    ? toolName.slice(MCP_TOOL_PREFIX.length)
    : toolName;
  return READ_ONLY_TOOLS.has(bare);
}

/** True if `toolName` is a `Hass*` intent tool on the homeassistant MCP server. */
export function isHassIntentTool(toolName: string): boolean {
  return HASS_INTENT_TOOL.test(toolName);
}

export const PermissionDecision = {
  DENY: 'deny',
  ASK: 'ask',
  ALLOW: 'allow', // sentinel for non-sensitive entities; no ha_safety_mode maps to it
} as const;
export type PermissionDecision = (typeof PermissionDecision)[keyof typeof PermissionDecision];

const MODE_TO_DECISION: Record<string, PermissionDecision> = {
  strict: PermissionDecision.DENY,
  ask: PermissionDecision.ASK,
};

const DECISION_ORDER: Record<PermissionDecision, number> = {
  [PermissionDecision.ALLOW]: 0,
  [PermissionDecision.ASK]: 1,
  [PermissionDecision.DENY]: 2,
};

interface PolicyOverrides {
  safeEntities: Set<string>;
  extraDomains: Set<string>;
}

const overridesCache = new Map<string, PolicyOverrides>();
const configCache = new Map<string, Record<string, unknown>>();

/** Test hook — replaces Python's `_load_policy_overrides.cache_clear()` etc. */
export function clearPolicyCaches(): void {
  overridesCache.clear();
  configCache.clear();
}

// Parse .hermit/config.json once per root. Fail-closed: any read or
// parse error (or a non-object payload) retains strict mode, so every config-derived
// guard below falls back to its own safe default.
function loadHermitConfig(root: string): Record<string, unknown> {
  const cached = configCache.get(root);
  if (cached !== undefined) return cached;
  let cfg: Record<string, unknown> = { ha_safety_mode: 'strict' };
  try {
    const parsed = JSON.parse(readFileSync(join(root, '.hermit', 'config.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) cfg = parsed;
  } catch {}
  configCache.set(root, cfg);
  return cfg;
}

function loadPolicyOverrides(root: string): PolicyOverrides {
  const cached = overridesCache.get(root);
  if (cached) return cached;
  const env = loadEnvFile(root);
  const set = (name: string): Set<string> =>
    new Set(
      (env[name] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );
  const overrides: PolicyOverrides = {
    safeEntities: set('HA_SAFE_ENTITIES'),
    extraDomains: set('HA_EXTRA_SENSITIVE_DOMAINS'),
  };
  overridesCache.set(root, overrides);
  return overrides;
}

function loadSafetyMode(root: string): string {
  const configured = loadHermitConfig(root)['ha_safety_mode'];
  const value = configured === undefined ? 'ask' : configured;
  return typeof value === 'string' && Object.hasOwn(MODE_TO_DECISION, value) ? value : 'strict';
}

/** Read ha_safety_mode from .hermit/config.json. Fail-closed: returns 'strict'. */
export function safetyMode(root?: string | null): string {
  return loadSafetyMode(resolve(root ?? process.cwd()));
}

function loadAssistControl(root: string): boolean {
  return loadHermitConfig(root)['ha_assist_control_enabled'] === true;
}

/** Read ha_assist_control_enabled from .hermit/config.json. Fail-closed: returns false. */
export function assistControl(root?: string | null): boolean {
  return loadAssistControl(resolve(root ?? process.cwd()));
}

function loadUpdateAutoApply(root: string): boolean {
  return loadHermitConfig(root)['ha_update_auto_apply'] === true;
}

/** Read ha_update_auto_apply from .hermit/config.json. Fail-closed: returns false. */
export function updateAutoApply(root?: string | null): boolean {
  return loadUpdateAutoApply(resolve(root ?? process.cwd()));
}

export interface MutationGate {
  decision: PermissionDecision;
  mode: string;
  reason: string;
}

/** Structural writes are denied under strict; Claude Code asks before execution otherwise. */
export function gateStructuralMutation(root?: string | null): MutationGate {
  const mode = safetyMode(root);
  return mode === 'strict'
    ? { decision: PermissionDecision.DENY, mode, reason: 'Blocked under strict ha_safety_mode; surface this as a proposal for the operator to approve.' }
    : { decision: PermissionDecision.ASK, mode, reason: 'Structural mutation requires native approval.' };
}

export interface PolicyDecision {
  decision: PermissionDecision;
  reasons: string[];
}

/** Return [PermissionDecision, reasons] for a single entity. */
export function classifyEntity(entityId: string, root?: string | null): [PermissionDecision, string[]] {
  const resolved = resolve(root ?? process.cwd());
  const overrides = loadPolicyOverrides(resolved);
  if (overrides.safeEntities.has(entityId)) return [PermissionDecision.ALLOW, []];
  // Lowercase to catch calls carrying `LOCK.front_door` (HA ids are lowercase
  // in practice, but a mis-formed call must not slip past the domain check).
  const domain = entityId.split('.', 1)[0]!.toLowerCase();
  if (SENSITIVE_DOMAINS.has(domain) || overrides.extraDomains.has(domain)) {
    return [MODE_TO_DECISION[loadSafetyMode(resolved)]!, [`Domain '${domain}' is always sensitive`]];
  }
  return [PermissionDecision.ALLOW, []];
}

export function isSensitiveEntity(entityId: string, root?: string | null): boolean {
  const [decision] = classifyEntity(entityId, root);
  return decision !== PermissionDecision.ALLOW;
}

export function isSensitiveService(serviceName: string): boolean {
  const [decision] = classifyEntity(serviceName);
  return decision !== PermissionDecision.ALLOW;
}

export function evaluateReferences(
  entityIds: string[],
  services: string[],
  root?: string | null,
): PolicyDecision {
  let decision: PermissionDecision = PermissionDecision.ALLOW;
  const reasons: string[] = [];
  for (const entityId of [...new Set(entityIds)].sort()) {
    const [entityDecision] = classifyEntity(entityId, root);
    if (entityDecision !== PermissionDecision.ALLOW) {
      reasons.push(`Sensitive or ambiguous entity (${entityDecision}): ${entityId}`);
      if (DECISION_ORDER[entityDecision] > DECISION_ORDER[decision]) decision = entityDecision;
    }
  }
  for (const service of [...new Set(services)].sort()) {
    const [serviceDecision] = classifyEntity(service, root);
    if (serviceDecision !== PermissionDecision.ALLOW) {
      reasons.push(`Sensitive or ambiguous service (${serviceDecision}): ${service}`);
      if (DECISION_ORDER[serviceDecision] > DECISION_ORDER[decision]) decision = serviceDecision;
    }
  }
  return { decision, reasons };
}

const TARGET_SHAPE_KEYS = ['entity_id', 'device_id', 'area_id', 'floor_id', 'label_id'];

/**
 * True if `data` carries a known targeting key (top-level or nested under
 * `target`) in a shape extractEntityIds/hasUnresolvableTarget can't see — a
 * value that isn't a string or an array of strings, or a `target` that isn't
 * a plain object. Without this, a payload like `--data
 * '{"target":["lock.front_door"]}'` (target as an array) or `{"entity_id":
 * 123}` extracts zero entity IDs and trips no unresolvable-target check,
 * silently passing as ALLOW when the domain.service itself isn't sensitive.
 * Scoped to gateServiceCall only — the shared hook-facing extractors below
 * stay untouched (pinned by tests/gate-corpus.test.ts / gate-fuzz.test.ts).
 */
function hasMalformedTargetShape(data: Record<string, unknown>): boolean {
  const isStringOrStringArray = (value: unknown): boolean =>
    value === undefined ||
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((v) => typeof v === 'string'));

  if (TARGET_SHAPE_KEYS.some((key) => !isStringOrStringArray(data[key]))) return true;

  const target = data['target'];
  if (target === undefined) return false;
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return true;
  return TARGET_SHAPE_KEYS.some((key) => !isStringOrStringArray((target as Record<string, unknown>)[key]));
}

// Entity ids can ride in service-specific fields the standard extractor never
// looks at: scene.apply keys its `entities` map by entity_id, scene.create
// takes `snapshot_entities`, etc. Deep-scan the whole payload for entity-id-
// shaped strings (as object keys or string values) so gateServiceCall can
// classify them too. Strict shape (domain.object_id) avoids matching prose in
// message/title fields; case-insensitive so a mis-formed `LOCK.x` can't slip.
const ENTITY_ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/i;

function deepEntityRefs(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (ENTITY_ID_RE.test(v)) out.push(v);
    } else if (Array.isArray(v)) {
      for (const el of v) visit(el);
    } else if (v !== null && typeof v === 'object') {
      for (const [key, val] of Object.entries(v)) {
        if (ENTITY_ID_RE.test(key)) out.push(key);
        visit(val);
      }
    }
  };
  visit(value);
  return out;
}

/**
 * Gate for `ha call-service` — classifies the target `domain.service` and any
 * entity references in `data` via the same per-entity policy used for MCP tool
 * calls. References are pulled both from the standard entity_id/device_id/target
 * fields and, via a deep scan, from service-specific fields (e.g. scene.apply's
 * `entities` map keys) so a sensitive entity can't hide in a bespoke field.
 * Unlike gateStructuralMutation, a call with
 * nothing sensitive proceeds in both modes: call-service exists for
 * maintenance (reloads, recorder.purge, notify.*), and gating every call
 * unconditionally would defeat that purpose.
 *
 * Unresolvable targets (a malformed entity_id, a malformed targeting field
 * shape, or an area_id/floor_id/label_id/device_id selector that doesn't
 * resolve to a concrete entity) fail closed regardless of mode;
 * same fail-closed rule as the MCP safety hook, because HA resolves those
 * selectors server-side and we cannot enumerate the entity set they fan out
 * to.
 */
export function gateServiceCall(
  root: string | null | undefined,
  domain: string,
  service: string,
  data: Record<string, unknown>,
): MutationGate {
  const mode = safetyMode(root);
  if (hasMalformedTargetShape(data)) {
    return {
      decision: PermissionDecision.DENY,
      mode,
      reason:
        'Cannot verify target safety: malformed targeting field ' +
        '(expected a string or array of strings). Use a proposal instead.',
    };
  }
  const entityIds = extractEntityIds(data);
  const resolved = entityIds.filter(isWellFormedEntityId);
  if (resolved.length !== entityIds.length || hasUnresolvableTarget(data, new Set(resolved))) {
    return {
      decision: PermissionDecision.DENY,
      mode,
      reason:
        'Cannot verify target safety: no resolvable entity IDs found ' +
        '(area_id/floor_id/label_id/device_id targets are not evaluated). Use a proposal instead.',
    };
  }

  const decision = evaluateReferences(
    [...entityIds, ...deepEntityRefs(data)],
    [`${domain}.${service}`],
    root,
  );

  // Update eligibility is independent of safety mode and never overrides
  // sensitive-target decisions. Every eligible update still needs native approval.
  if (decision.decision === PermissionDecision.ALLOW && domain === 'update') {
    return updateAutoApply(root)
      ? { decision: PermissionDecision.ASK, mode, reason: 'Update installation requires native approval.' }
      : { decision: PermissionDecision.DENY, mode, reason: 'update domain actuation requires ha_update_auto_apply to be enabled; surface this as a proposal for the operator to approve.' };
  }
  return {
    decision: decision.decision,
    mode,
    reason: decision.decision === PermissionDecision.ALLOW ? 'ok' : decision.reasons.join('; '),
  };
}

export function canReloadDomain(domain: string): boolean {
  return SAFE_RELOAD_DOMAINS.has(domain);
}

export interface EntityCheck {
  entity_id: string;
  sensitive: boolean;
  decision: PermissionDecision;
  reasons: string[];
}

/** Return a JSON-friendly policy check for a single entity. */
export function checkEntity(entityId: string): EntityCheck {
  const [decision, reasons] = classifyEntity(entityId);
  return {
    entity_id: entityId,
    sensitive: decision !== PermissionDecision.ALLOW,
    decision,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Entity-reference extraction (shared by the MCP safety hook and `ha
// call-service`) — fail-closed resolution of entity_id/device_id/target
// selectors out of a tool-call or service-call payload.
// ---------------------------------------------------------------------------

/** Pull entity_id values from a tool/service call's parameters. */
export function extractEntityIds(toolInput: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ['entity_id', 'device_id']) {
    const val = toolInput[key];
    if (typeof val === 'string' && val.includes('.')) {
      ids.push(val);
    } else if (Array.isArray(val)) {
      ids.push(...val.filter((v): v is string => typeof v === 'string' && v.includes('.')));
    }
  }
  const target = toolInput['target'];
  if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
    const eid = (target as Record<string, unknown>)['entity_id'];
    if (typeof eid === 'string' && eid.includes('.')) {
      ids.push(eid);
    } else if (Array.isArray(eid)) {
      ids.push(...eid.filter((v): v is string => typeof v === 'string' && v.includes('.')));
    }
  }
  return ids;
}

// Targeting selectors that fan a call out to an entity set we cannot
// enumerate here (HA resolves area/floor/label/device → entities server-side).
// A call carrying any of these with a value that did NOT resolve to an
// extracted, well-formed entity_id is unverifiable → fail closed, even when a
// safe concrete entity_id is also present in the same call.
const TARGETING_KEYS = ['area_id', 'floor_id', 'label_id', 'device_id'];

export function hasUnresolvableTarget(
  toolInput: Record<string, unknown>,
  resolved: Set<string>,
): boolean {
  const scopes: Record<string, unknown>[] = [toolInput];
  const target = toolInput['target'];
  if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
    scopes.push(target as Record<string, unknown>);
  }
  for (const scope of scopes) {
    for (const key of TARGETING_KEYS) {
      const v = scope[key];
      const values =
        typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      // A device_id whose value was extracted as a dotted entity ref is
      // resolvable; every other present targeting value is not.
      if (values.some((val) => !resolved.has(val))) return true;
    }
  }
  return false;
}

/** An entity_id is well-formed only with a non-empty domain segment (rejects `.lock`). */
export function isWellFormedEntityId(id: string): boolean {
  return id.split('.', 1)[0] !== '';
}

export function normalizeEntityIndex(
  states: Array<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const index: Record<string, Record<string, unknown>> = {};
  for (const state of states) {
    const entityId = state['entity_id'];
    if (typeof entityId === 'string') index[entityId] = state;
  }
  return index;
}
