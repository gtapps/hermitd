// WP7 tier 2: tests for src/integration-health.ts — 1:1 port of the 7 module
// cases in tests/test_integration_health.py. The remaining 5 cases
// (`test_cli_integration_health_*`) exercise the CLI handler and live in
// tests/cli-integration-health.test.ts (tier 3).
//
// pytest fixture mapping: tmp_path -> mkdtempSync.

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeContext } from '../src/cli';
import {
  computeDegradedDomains,
  formatIntegrationHealthStdout,
  writeDegradedDomainsArtifact,
} from '../src/integration-health';

const tmpDirs: string[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-integration-health-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function normalized(
  entityIndex: Record<string, any>,
  unavailable: string[] | null = null,
): Record<string, any> {
  return { entity_index: entityIndex, unavailable_entities: unavailable || [] };
}

function makeEntities(domain: string, n: number, unavail: number): [Record<string, any>, string[]] {
  const idx: Record<string, any> = {};
  for (let i = 0; i < n; i++) {
    idx[`${domain}.e${i}`] = {
      entity_id: `${domain}.e${i}`,
      state: i < unavail ? 'unavailable' : 'ok',
    };
  }
  const unavailList = Array.from({ length: unavail }, (_, i) => `${domain}.e${i}`);
  return [idx, unavailList];
}

test('degraded domains flags domain over thresholds', () => {
  const [idx, unavail] = makeEntities('sensor', 6, 5);
  const result = computeDegradedDomains(normalized(idx, unavail));
  const domains = result.degraded_entity_domains.map((d: Record<string, any>) => d.domain);
  expect(domains).toContain('sensor');
  const entry = result.degraded_entity_domains[0];
  expect(entry.total).toBe(6);
  expect(entry.unavailable).toBe(5);
  expect(entry.ratio).toBe(Math.round((5 / 6) * 10_000) / 10_000);
});

test('unknown entities from a snapshot do not degrade their domain', () => {
  const states = Array.from({ length: 5 }, (_, i) => ({ entity_id: `button.b${i}`, state: 'unknown' }));
  const result = computeDegradedDomains(normalizeContext(states, [], []));
  expect(result.degraded_entity_domains).toEqual([]);
});

test('degraded domains ignores small domains under min_total', () => {
  const [idx, unavail] = makeEntities('lock', 2, 2);
  const result = computeDegradedDomains(normalized(idx, unavail));
  expect(result.degraded_entity_domains).toEqual([]);
});

test('degraded domains ignores healthy domains under min_ratio', () => {
  const [idx, unavail] = makeEntities('light', 10, 1);
  const result = computeDegradedDomains(normalized(idx, unavail));
  expect(result.degraded_entity_domains).toEqual([]);
});

test('degraded domains payload deterministic sort', () => {
  const [idxA, ua] = makeEntities('sensor', 4, 4);
  const [idxB, ub] = makeEntities('binary_sensor', 4, 4);
  const norm = normalized({ ...idxA, ...idxB }, [...ua, ...ub]);
  const result1 = computeDegradedDomains(norm);
  const result2 = computeDegradedDomains(norm);
  expect(result1.degraded_entity_domains).toEqual(result2.degraded_entity_domains);
  expect(result1.degraded_entity_domains[0].domain).toBe('binary_sensor');
  expect(result1.degraded_entity_domains[1].domain).toBe('sensor');
});

test('degraded domains artifact written to state path', () => {
  const tmp = tmpPath();
  const [idx, unavail] = makeEntities('sensor', 4, 3);
  const payload = computeDegradedDomains(normalized(idx, unavail));
  const path = writeDegradedDomainsArtifact(tmp, payload);
  expect(path).toBe(
    join(tmp, '.hermit', 'state', 'integration-health-degraded-domains.json'),
  );
  expect(existsSync(path)).toBe(true);
  const loaded = JSON.parse(readFileSync(path, 'utf8'));
  expect(Object.keys(loaded)).toContain('degraded_entity_domains');
  expect(Object.keys(loaded)).toContain('computed_at');
});

test('format stdout with degraded', () => {
  const payload = {
    degraded_entity_domains: [{ domain: 'sensor', total: 15, unavailable: 12, ratio: 0.8 }],
    scanned_domains: 8,
  };
  const out = formatIntegrationHealthStdout(payload, '2026-05-14');
  expect(out.startsWith('ha-integration-health findings — 2026-05-14')).toBe(true);
  expect(out).toContain('Degraded domains: 1');
  expect(out).toContain('sensor: 12/15');
  expect(out).toContain('80.0%');
});

test('format stdout no degraded', () => {
  const payload = { degraded_entity_domains: [], scanned_domains: 5 };
  const out = formatIntegrationHealthStdout(payload, '2026-05-14');
  expect(out).toContain('No actionable findings.');
  expect(out).toContain('5 domains scanned');
});
