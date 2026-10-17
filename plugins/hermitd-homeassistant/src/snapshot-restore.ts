// ha-snapshot-restore (issue #472, skill A): capture an entity set's state to a
// named artifact and restore it later via scene.apply.
//
// This is the plugin's first direct device-actuation path. Capture is read-only.
// Restore actuates, so it is gated by the EXISTING policy engine
// (evaluateReferences + ha_safety_mode): sensitive entities (locks, alarms,
// security covers/switches) block under strict and request native approval under ask;
// lights/climate always pass. No new gate is introduced.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  currentSessionId,
  slugify,
  standardMetadata,
  utcTimestamp,
  writeJsonArtifact,
  writeMarkdownArtifact,
} from './artifacts';
import { PermissionDecision, evaluateReferences, isSensitiveEntity } from './policy';

/** The client slice this module needs (HomeAssistantClient / fakeClient satisfy it). */
export interface SnapshotClient {
  getStates(): Promise<Array<Record<string, any>>>;
  post(path: string, payload?: Record<string, unknown> | null): Promise<any>;
}

export const DEFAULT_DOMAINS = ['light', 'cover', 'climate', 'switch'];

// Restore-relevant attributes per domain. scene.apply replays state + these;
// read-only attributes (friendly_name, supported_features) are deliberately
// excluded. Refine per-domain only if a live test shows a gap (see SKILL.md).
const RESTORE_ATTRS: Record<string, string[]> = {
  light: ['brightness', 'color_temp', 'color_temp_kelvin', 'rgb_color', 'hs_color', 'xy_color', 'effect'],
  cover: ['current_position', 'current_tilt_position'],
  climate: ['temperature', 'target_temp_high', 'target_temp_low', 'fan_mode', 'humidity'],
  switch: [],
};

export interface CapturedEntity {
  state: string | null;
  attributes: Record<string, unknown>;
}

// `type` (not `interface`) so it carries an implicit index signature and stays
// assignable to writeJsonArtifact's `Record<string, unknown>` payload param.
export type StateSnapshot = {
  name: string;
  generated: string;
  entities: Record<string, CapturedEntity>;
};

export interface CaptureResult {
  ok: boolean;
  name: string;
  captured: number;
  entities: string[];
  reportPath: string;
  message: string;
}

function domainOf(entityId: string): string {
  return entityId.split('.', 1)[0]!;
}

function pickAttributes(entityId: string, attrs: Record<string, unknown>): Record<string, unknown> {
  const allowed = RESTORE_ATTRS[domainOf(entityId)] ?? [];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (attrs[key] !== undefined && attrs[key] !== null) out[key] = attrs[key];
  }
  return out;
}

/** Capture (read-only): snapshot states for the chosen domains / entities. */
export async function captureStates(
  root: string,
  client: SnapshotClient,
  options: { name: string; domains?: string[]; entities?: string[] },
): Promise<CaptureResult> {
  const wantDomains = new Set(options.domains ?? DEFAULT_DOMAINS);
  const wantEntities = options.entities ? new Set(options.entities) : null;
  const states = await client.getStates();

  const entities: Record<string, CapturedEntity> = {};
  for (const s of states) {
    if (!(s && typeof s === 'object')) continue;
    const entityId = String(s.entity_id ?? '');
    if (!entityId) continue;
    const include = wantEntities ? wantEntities.has(entityId) : wantDomains.has(domainOf(entityId));
    if (!include) continue;
    entities[entityId] = {
      state: s.state ?? null,
      attributes: pickAttributes(entityId, s.attributes || {}),
    };
  }

  const snapshot: StateSnapshot = { name: options.name, generated: utcTimestamp(), entities };
  const kind = `snapshot-ha-states-${slugify(options.name)}`;
  const reportPath = writeJsonArtifact(
    root,
    '.hermit/raw',
    kind,
    snapshot,
    `${kind}-latest.json`,
  );
  const ids = Object.keys(entities).sort();
  return {
    ok: true,
    name: options.name,
    captured: ids.length,
    entities: ids,
    reportPath,
    message: ids.length > 0 ? 'ok' : 'no matching entities captured',
  };
}

export interface RestoreResult {
  ok: boolean;
  blocked: boolean;
  applied: number;
  entities: string[];
  sensitive: string[];
  reason: string;
  /** The snapshot captured no entities, so nothing was restored. */
  empty?: boolean;
  reportPath?: string;
  message: string;
}

export function loadSnapshot(artifactPath: string): StateSnapshot {
  const raw = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || typeof raw.entities !== 'object') {
    throw new Error('artifact is not a state snapshot');
  }
  return raw as StateSnapshot;
}

/** Restore (actuation): apply a captured snapshot via scene.apply, gated by policy. */
export async function restoreStates(
  root: string,
  client: SnapshotClient,
  options: { artifactPath: string },
): Promise<RestoreResult> {
  let snapshot: StateSnapshot;
  try {
    snapshot = loadSnapshot(options.artifactPath);
  } catch (exc: any) {
    return {
      ok: false, blocked: false, applied: 0, entities: [], sensitive: [],
      reason: `Could not read snapshot: ${exc?.message ?? exc}`, message: 'error',
    };
  }

  const entityIds = Object.keys(snapshot.entities).sort();
  if (entityIds.length === 0) {
    return {
      ok: false, blocked: false, empty: true, applied: 0, entities: [], sensitive: [],
      reason: 'snapshot has no entities to restore', message: 'error',
    };
  }

  const decision = evaluateReferences(entityIds, ['scene.apply'], root);
  const sensitive = entityIds.filter((id) => isSensitiveEntity(id, root));

  if (decision.decision === PermissionDecision.DENY) {
    return {
      ok: false, blocked: true, applied: 0, entities: entityIds, sensitive,
      reason: `Restore blocked under strict mode: ${sensitive.length} sensitive entit${sensitive.length === 1 ? 'y' : 'ies'}.`,
      message: 'blocked',
    };
  }
  // scene.apply replays each entity's state + captured attributes in one call.
  const sceneEntities: Record<string, Record<string, unknown>> = {};
  for (const id of entityIds) {
    const cap = snapshot.entities[id]!;
    sceneEntities[id] = { state: cap.state, ...cap.attributes };
  }
  await client.post('/api/services/scene/apply', { entities: sceneEntities });

  const reportPath = writeRestoreReport(root, options.artifactPath, entityIds, sensitive);
  return {
    ok: true, blocked: false, applied: entityIds.length, entities: entityIds,
    sensitive, reason: 'ok', reportPath, message: 'ok',
  };
}

function writeRestoreReport(
  root: string,
  artifactPath: string,
  entities: string[],
  sensitive: string[],
): string {
  return writeMarkdownArtifact(
    root,
    '.hermit/raw',
    'audit-ha-restore',
    standardMetadata('apply', `Restore Report — ${basename(artifactPath)}`, {
      session: currentSessionId(root),
      tags: ['ha-restore', 'actuation'],
      extra: {
        artifact: basename(artifactPath),
        entity_count: entities.length,
        sensitive_count: sensitive.length,
        service: 'scene.apply',
      },
    }),
    [
      `# Restore Report for \`${basename(artifactPath)}\``,
      '',
      `- entities restored: ${entities.length}`,
      `- via: scene.apply`,
      sensitive.length > 0 ? `- sensitive: ${sensitive.join(', ')}` : '- sensitive: none',
    ].join('\n'),
    'audit-ha-restore-latest.md',
  );
}
