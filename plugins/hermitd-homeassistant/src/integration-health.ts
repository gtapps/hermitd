// WP7 tier 2 port of src/ha_agent_lab/integration_health.py —
// integration-health domain analysis, degraded entity-domain detection.
//
// Rounding note: Python round() uses banker's rounding; Math.round rounds
// half away from zero. They only diverge on exact .5 ties at the rounding
// digit, which the ratio/percentage values here hit with negligible
// probability.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isoUtc } from './time-utils';

/**
 * Return degraded entity-domain prefixes from the normalized snapshot.
 *
 * A domain is degraded when total >= minTotal AND unavailable/total >= minRatio.
 * Matches the threshold rule documented in skills/ha-integration-health/SKILL.md:31-34.
 */
export function computeDegradedDomains(
  normalized: Record<string, any>,
  options: { minTotal?: number; minRatio?: number } = {},
): Record<string, any> {
  const { minTotal = 3, minRatio = 0.5 } = options;
  const entityIndex: Record<string, any> = normalized.entity_index ?? {};
  const unavailableSet = new Set<string>(normalized.unavailable_entities ?? []);

  const domainTotals: Record<string, number> = {};
  const domainUnavailable: Record<string, number> = {};
  for (const entityId of Object.keys(entityIndex)) {
    const domain = entityId.split('.', 1)[0]!;
    domainTotals[domain] = (domainTotals[domain] ?? 0) + 1;
    if (unavailableSet.has(entityId)) {
      domainUnavailable[domain] = (domainUnavailable[domain] ?? 0) + 1;
    }
  }

  const degraded: Array<Record<string, any>> = [];
  for (const domain of Object.keys(domainTotals).sort()) {
    const total = domainTotals[domain]!;
    const unavail = domainUnavailable[domain] ?? 0;
    if (total < minTotal) continue;
    const ratio = unavail / total;
    if (ratio < minRatio) continue;
    degraded.push({
      domain,
      total,
      unavailable: unavail,
      ratio: Math.round(ratio * 10_000) / 10_000, // round(ratio, 4)
    });
  }

  return {
    computed_at: isoUtc(new Date()),
    thresholds: { min_total: minTotal, min_ratio: minRatio },
    degraded_entity_domains: degraded,
    scanned_domains: Object.keys(domainTotals).length,
  };
}

/** Write the degraded-domains state artifact consumed by silence.ts. */
export function writeDegradedDomainsArtifact(root: string, payload: Record<string, any>): string {
  const stateDir = join(root, '.hermit', 'state');
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, 'integration-health-degraded-domains.json');
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return path;
}
