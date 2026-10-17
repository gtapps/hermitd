// ha-update-check — filter the update.* domain out of an HA states snapshot
// and classify each pending update into a tier for proposal fan-out.

export type UpdateTier = 'core' | 'os' | 'supervisor' | 'addon' | 'hacs';

export interface PendingUpdate {
  entity_id: string;
  title: string;
  installed_version: string | null;
  latest_version: string | null;
  release_summary: string | null;
  release_url: string | null;
  tier: UpdateTier;
}

const CORE_ENTITY_ID = 'update.home_assistant_core_update';
const OS_ID_PATTERN = /home_assistant_operating_system/;
const SUPERVISOR_ID_PATTERN = /home_assistant_supervisor/;

// Home Assistant UpdateEntityFeature.BACKUP — supervisor-managed (add-on) update
// entities advertise it; HACS / custom-integration update entities do not.
const UPDATE_FEATURE_BACKUP = 8;

/**
 * Classify an update.* entity into a tier. Well-known Core/OS/Supervisor
 * entity_ids are the fast path. To tell add-ons apart from HACS/other
 * integrations we key off `hasBackup` — whether the entity advertises HA's
 * native BACKUP update feature (`supported_features & 8`), which supervisor
 * add-on entities carry and HACS/custom-integration ones don't. That signal
 * rides in the `/api/states` payload already, so no registry/WS fetch is
 * needed, and it aligns the tier with the exact capability the apply flow
 * depends on (an `addon` entity can always take `backup:true`). An entity
 * without the BACKUP bit falls back to the aggregated `hacs` bucket — which
 * on apply gets the heavier full backup, a safe degradation.
 */
export function classifyUpdateEntity(entityId: string, hasBackup?: boolean): UpdateTier {
  if (entityId === CORE_ENTITY_ID) return 'core';
  if (OS_ID_PATTERN.test(entityId)) return 'os';
  if (SUPERVISOR_ID_PATTERN.test(entityId)) return 'supervisor';
  if (hasBackup) return 'addon';
  return 'hacs';
}

/**
 * Filter a states snapshot down to pending update.* entities, honoring HA's
 * native skipped_version so operator-dismissed updates in the HA UI stay quiet.
 */
export function collectPendingUpdates(states: Array<Record<string, any>>): PendingUpdate[] {
  const out: PendingUpdate[] = [];
  for (const s of states) {
    const entityId = s?.entity_id;
    if (typeof entityId !== 'string' || !entityId.startsWith('update.')) continue;
    if (s.state !== 'on') continue;
    const attrs = s.attributes ?? {};
    const latest = typeof attrs.latest_version === 'string' ? attrs.latest_version : null;
    const skipped = typeof attrs.skipped_version === 'string' ? attrs.skipped_version : null;
    if (skipped !== null && skipped === latest) continue;
    const sf = typeof attrs.supported_features === 'number' ? attrs.supported_features : 0;
    out.push({
      entity_id: entityId,
      title: attrs.title || attrs.friendly_name || entityId,
      installed_version: typeof attrs.installed_version === 'string' ? attrs.installed_version : null,
      latest_version: latest,
      release_summary: typeof attrs.release_summary === 'string' ? attrs.release_summary : null,
      release_url: typeof attrs.release_url === 'string' ? attrs.release_url : null,
      tier: classifyUpdateEntity(entityId, (sf & UPDATE_FEATURE_BACKUP) === UPDATE_FEATURE_BACKUP),
    });
  }
  out.sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));
  return out;
}

export interface UpdatesView {
  /** Individual (non-HACS) updates to list. */
  updates: PendingUpdate[];
  /** Individual updates left out of `updates`. */
  more: number;
  /** HACS updates, which aggregate into one count. */
  hacs: number;
}

/** Every individual update in entity_id order, HACS aggregated. */
export function listUpdates(updates: PendingUpdate[]): UpdatesView {
  return {
    updates: updates.filter((u) => u.tier !== 'hacs'),
    more: 0,
    hacs: updates.filter((u) => u.tier === 'hacs').length,
  };
}

const TIER_RANK: Record<UpdateTier, number> = { core: 0, os: 1, supervisor: 2, addon: 3, hacs: 4 };
const DIGEST_TOP_N = 3;

/**
 * Brief-ready digest: tier-sorted, top 3 individual updates, remainder counted.
 * The tier ordering the briefs used to state in prose lives here.
 */
export function digestUpdates(updates: PendingUpdate[]): UpdatesView {
  const individual = updates
    .filter((u) => u.tier !== 'hacs')
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  const top = individual.slice(0, DIGEST_TOP_N);
  return {
    updates: top,
    more: individual.length - top.length,
    hacs: updates.filter((u) => u.tier === 'hacs').length,
  };
}
