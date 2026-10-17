// Structural HA management over WebSocket — the supporting structure REST cannot
// reach: helpers, areas, entity/device registries. Wraps a WS command client and
// writes an audit report for each mutation (mirroring apply.ts's remove report).
//
// The safety gate (ha_safety_mode) is applied by the CLI *before* a connection is
// opened, so this module assumes the gate has already passed — it only validates
// inputs and executes. Read functions return WsReadResult; mutations return
// WsMutationResult. Validation problems (unknown helper type, bad JSON) come back
// as ok:false results carrying an `error` token; only transport/HA failures throw
// HomeAssistantError, which the CLI's per-command catch already handles.

import { currentSessionId, slugify, standardMetadata, writeMarkdownArtifact } from './artifacts';
import { HomeAssistantError, haErrorToken } from './ha-api';

/** Minimal WS surface (HomeAssistantWsClient satisfies it; tests inject a fake). */
export interface WsCommandClient {
  command(type: string, payload?: Record<string, unknown>): Promise<any>;
  close(): void;
}

export const HELPER_TYPES = [
  'input_boolean',
  'input_number',
  'input_text',
  'input_select',
  'input_datetime',
  'timer',
  'counter',
  'schedule',
] as const;
export type HelperType = (typeof HELPER_TYPES)[number];

/** A failed result always carries its `{"error"}` token. */
type WsOutcome = { ok: true } | { ok: false; error: string };

export type WsReadResult = WsOutcome & {
  data: unknown;
  message: string;
  /** Helper types whose list command failed; the others still came back. */
  unavailable?: string[];
};

export type WsMutationResult = WsOutcome & {
  data: unknown;
  message: string;
  reportPath: string | null;
};

function isHelperType(value: string): value is HelperType {
  return (HELPER_TYPES as readonly string[]).includes(value);
}

/**
 * Execute a (pre-gated) mutation and write its audit report. HA failures are
 * caught and reported (ok: false) so a report lands for them too, like
 * removeConfig; a report-write failure degrades to reportPath: null rather
 * than escaping.
 */
async function runMutation(
  root: string,
  client: WsCommandClient,
  label: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<WsMutationResult> {
  let data: unknown = null;
  let message = 'ok';
  let error: string | undefined;
  try {
    data = await client.command(type, payload);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    message = exc.message;
    error = haErrorToken(exc, 'ha_command_failed');
  }
  const ok = error === undefined;

  // Never let a report-write failure (disk full, permissions) escape as a
  // non-HomeAssistantError and crash the CLI past its per-command catch — the
  // mutation already landed; report a null path instead.
  let reportPath: string | null = null;
  try {
    reportPath = writeMutationReport(root, label, type, payload, ok, message);
  } catch {
    // intentionally empty: mutation already landed, reportPath stays null
  }
  return error === undefined
    ? { ok: true, data, message, reportPath }
    : { ok: false, error, data, message, reportPath };
}

function writeMutationReport(
  root: string,
  label: string,
  type: string,
  payload: Record<string, unknown>,
  ok: boolean,
  message: string,
): string {
  const metadata = standardMetadata('ws-mutation', `WS Mutation Report — ${label}`, {
    session: currentSessionId(root),
    tags: ['ha-ws', `ha-${label}`],
    extra: { ws_type: type, payload, ok, message },
  });
  const body = [
    `# WS Mutation Report for \`${label}\``,
    '',
    `- ok: ${ok}`,
    `- ws_type: ${type}`,
    `- payload: ${JSON.stringify(payload)}`,
    '',
    `Message: ${message}`,
  ].join('\n');
  return writeMarkdownArtifact(
    root,
    '.hermit/raw',
    `audit-ha-ws-${slugify(label)}`,
    metadata,
    body,
    'audit-ha-ws-latest.md',
  );
}

// --- Helpers -------------------------------------------------------------

export async function listHelpers(client: WsCommandClient, type?: string): Promise<WsReadResult> {
  if (type !== undefined && !isHelperType(type)) {
    const message = unknownHelperType(type);
    return { ok: false, error: `usage:${message}`, data: null, message };
  }
  const types = type ? [type as HelperType] : [...HELPER_TYPES];
  // Fan out concurrently — the WS client correlates responses by id, so all
  // list commands can be in flight at once (≈1×RTT instead of 8×). allSettled
  // so one unavailable integration (e.g. `schedule` on a host without
  // default_config) doesn't discard the other helper lists.
  const settled = await Promise.allSettled(types.map((t) => client.command(`${t}/list`)));
  const data = Object.fromEntries(
    settled.flatMap((s, i) => (s.status === 'fulfilled' ? [[types[i]!, s.value]] : [])),
  );
  const unavailable = settled.flatMap((s, i) => (s.status === 'rejected' ? [types[i]!] : []));
  const message = unavailable.length ? `ok; unavailable: ${unavailable.join(', ')}` : 'ok';
  return { ok: true, data, message, ...(unavailable.length ? { unavailable } : {}) };
}

export async function createHelper(
  root: string,
  client: WsCommandClient,
  type: string,
  json: string,
): Promise<WsMutationResult> {
  if (!isHelperType(type)) return invalidPayload(unknownHelperType(type));
  const parsed = parseJsonObjectPayload('helper', json);
  if (!parsed.ok) return parsed.error;
  return runMutation(root, client, `create-${type}`, `${type}/create`, parsed.payload);
}

export async function deleteHelper(
  root: string,
  client: WsCommandClient,
  type: string,
  id: string,
): Promise<WsMutationResult> {
  if (!isHelperType(type)) return invalidPayload(unknownHelperType(type));
  return runMutation(root, client, `delete-${type}`, `${type}/delete`, { [`${type}_id`]: id });
}

// --- Areas ---------------------------------------------------------------

export async function listAreas(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('config/area_registry/list'), message: 'ok' };
}

export async function createArea(
  root: string,
  client: WsCommandClient,
  name: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'create-area', 'config/area_registry/create', { name });
}

export async function deleteArea(
  root: string,
  client: WsCommandClient,
  areaId: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'delete-area', 'config/area_registry/delete', { area_id: areaId });
}

/** Generic area_registry/update: rename, set icon, assign a floor, or set labels. */
export async function updateArea(
  root: string,
  client: WsCommandClient,
  areaId: string,
  fields: Record<string, unknown>,
  label: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, label, 'config/area_registry/update', {
    area_id: areaId,
    ...fields,
  });
}

// --- Entity registry -----------------------------------------------------

export async function listEntities(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('config/entity_registry/list'), message: 'ok' };
}

/** Generic entity_registry/update: rename, set area, enable/disable, icon, hidden, labels, categories, or aliases. */
export async function updateEntity(
  root: string,
  client: WsCommandClient,
  entityId: string,
  fields: Record<string, unknown>,
  label: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, label, 'config/entity_registry/update', {
    entity_id: entityId,
    ...fields,
  });
}

// --- Device registry -----------------------------------------------------

export async function listDevices(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('config/device_registry/list'), message: 'ok' };
}

export async function updateDevice(
  root: string,
  client: WsCommandClient,
  deviceId: string,
  fields: Record<string, unknown>,
  label: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, label, 'config/device_registry/update', {
    device_id: deviceId,
    ...fields,
  });
}

// --- Dashboards (Lovelace) ------------------------------------------------

export async function listDashboards(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('lovelace/dashboards/list'), message: 'ok' };
}

/** Read a dashboard config. urlPath null reads the default (auto-generated) dashboard. */
export async function getDashboard(
  client: WsCommandClient,
  urlPath: string | null,
): Promise<WsReadResult> {
  return {
    ok: true,
    data: await client.command('lovelace/config', { url_path: urlPath }),
    message: 'ok',
  };
}

/** Save/replace a dashboard's view/card config. urlPath null targets the default dashboard. */
export async function saveDashboard(
  root: string,
  client: WsCommandClient,
  urlPath: string | null,
  config: unknown,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'apply-dashboard', 'lovelace/config/save', {
    url_path: urlPath,
    config,
  });
}

export async function createDashboard(
  root: string,
  client: WsCommandClient,
  json: string,
): Promise<WsMutationResult> {
  const parsed = parseJsonObjectPayload('dashboard', json);
  if (!parsed.ok) return parsed.error;
  return runMutation(root, client, 'create-dashboard', 'lovelace/dashboards/create', parsed.payload);
}

export async function deleteDashboard(
  root: string,
  client: WsCommandClient,
  dashboardId: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'delete-dashboard', 'lovelace/dashboards/delete', {
    dashboard_id: dashboardId,
  });
}

// --- Core config -----------------------------------------------------------

/** Partial update of HA's core config (location, unit system, currency, timezone, country). */
export async function setCoreConfig(
  root: string,
  client: WsCommandClient,
  fields: Record<string, unknown>,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'set-core-config', 'config/core/update', fields);
}

// --- Floors ----------------------------------------------------------------

export async function listFloors(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('config/floor_registry/list'), message: 'ok' };
}

export async function createFloor(
  root: string,
  client: WsCommandClient,
  name: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'create-floor', 'config/floor_registry/create', { name });
}

export async function deleteFloor(
  root: string,
  client: WsCommandClient,
  floorId: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'delete-floor', 'config/floor_registry/delete', {
    floor_id: floorId,
  });
}

// --- Labels ------------------------------------------------------------

export async function listLabels(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('config/label_registry/list'), message: 'ok' };
}

export async function createLabel(
  root: string,
  client: WsCommandClient,
  name: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'create-label', 'config/label_registry/create', { name });
}

export async function deleteLabel(
  root: string,
  client: WsCommandClient,
  labelId: string,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'delete-label', 'config/label_registry/delete', {
    label_id: labelId,
  });
}

// --- System log --------------------------------------------------------

export async function listSystemLog(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('system_log/list'), message: 'ok' };
}

// --- Assist exposure -----------------------------------------------------

export async function listExposedEntities(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('homeassistant/expose_entity/list'), message: 'ok' };
}

/** Set whether entities are exposed to one or more Assist assistants (conversation, cloud.alexa, cloud.google_assistant). */
export async function exposeEntity(
  root: string,
  client: WsCommandClient,
  entityIds: string[],
  assistants: string[],
  shouldExpose: boolean,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'expose-entity', 'homeassistant/expose_entity', {
    entity_ids: entityIds,
    assistants,
    should_expose: shouldExpose,
  });
}

// --- Backups ---------------------------------------------------------------

export async function listBackups(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('backup/info'), message: 'ok' };
}

export async function createBackup(
  root: string,
  client: WsCommandClient,
  fields: Record<string, unknown>,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'create-backup', 'backup/generate', fields);
}

// --- Blueprints --------------------------------------------------------

export async function listBlueprints(client: WsCommandClient, domain: string): Promise<WsReadResult> {
  return { ok: true, data: await client.command('blueprint/list', { domain }), message: 'ok' };
}

/**
 * Import a blueprint from a URL and save it under the given domain. Two WS
 * calls (import, then save), each independently audited via runMutation —
 * mirrors the HA UI's own import-then-save flow. Stops after import if HA
 * reports validation errors, without attempting the save.
 */
export async function importBlueprint(
  root: string,
  client: WsCommandClient,
  domain: string,
  url: string,
): Promise<WsMutationResult> {
  const imported = await runMutation(root, client, 'import-blueprint', 'blueprint/import', { url });
  if (!imported.ok) return imported;

  const data = imported.data as { suggested_filename?: string; raw_data?: string; validation_errors?: unknown };
  if (Array.isArray(data.validation_errors) && data.validation_errors.length > 0) {
    // HA may return structured (non-string) error entries — stringify those as
    // JSON so they don't collapse to '[object Object]'.
    const errors = data.validation_errors
      .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
      .join('; ');
    return {
      ok: false,
      data,
      message: `Blueprint validation failed: ${errors}`,
      error: `blueprint_invalid:${errors}`,
      reportPath: imported.reportPath,
    };
  }

  return runMutation(root, client, 'save-blueprint', 'blueprint/save', {
    domain,
    path: data.suggested_filename,
    yaml: data.raw_data,
    source_url: url,
  });
}

// --- Energy preferences --------------------------------------------------

export async function getEnergyPrefs(client: WsCommandClient): Promise<WsReadResult> {
  return { ok: true, data: await client.command('energy/get_prefs'), message: 'ok' };
}

export async function setEnergyPrefs(
  root: string,
  client: WsCommandClient,
  prefs: Record<string, unknown>,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'set-energy-prefs', 'energy/save_prefs', prefs);
}

// --- Config entries --------------------------------------------------------

export async function disableConfigEntry(
  root: string,
  client: WsCommandClient,
  entryId: string,
  disabled: boolean,
): Promise<WsMutationResult> {
  return runMutation(root, client, 'disable-entry', 'config_entries/disable', {
    entry_id: entryId,
    disabled_by: disabled ? 'user' : null,
  });
}

// --- shared error shapes -------------------------------------------------

function unknownHelperType(type: string): string {
  return `Unknown helper type '${type}'. Choose from: ${HELPER_TYPES.join(', ')}.`;
}

function invalidPayload(message: string): WsMutationResult {
  return { ok: false, data: null, message, error: `usage:${message}`, reportPath: null };
}

/** Parse `json` as a JSON object, or a validation-error fragment (e.g. "is not valid JSON"). */
export function parseJsonObject(
  json: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, message: 'is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'must be a JSON object' };
  }
  return { ok: true, payload: parsed as Record<string, unknown> };
}

/** Parse `json` as a JSON object payload, or an invalidPayload result labeled with `kind`. */
function parseJsonObjectPayload(
  kind: string,
  json: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: WsMutationResult } {
  const result = parseJsonObject(json);
  return result.ok ? result : { ok: false, error: invalidPayload(`${kind} JSON ${result.message}`) };
}
