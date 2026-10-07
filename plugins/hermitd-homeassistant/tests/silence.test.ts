// WP7 tier 2: tests for src/silence.ts — 1:1 port of tests/test_silence.py
// (13 of its 17 cases; the 4 `# --- parse_iso ---` / `# --- days_since ---`
// cases were already ported to tests/time-utils.test.ts in tier 1).
//
// pytest fixture mapping: tmp_path -> mkdtempSync.

import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeContext } from '../src/cli';
import { computeSilenceSummary } from '../src/silence';
import { isoUtc } from '../src/time-utils';

const tmpDirs: string[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ha-silence-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(Date.UTC(2026, 4, 14, 12, 0, 0));

function daysAgo(days: number): string {
  return isoUtc(new Date(NOW.getTime() - days * 86_400_000));
}

function entity(
  entityId: string,
  state = 'on',
  lastChanged: string | null = null,
  attrs: Record<string, any> | null = null,
): Record<string, any> {
  const lc = lastChanged || '2026-05-14T12:00:00+00:00';
  return { [entityId]: { state, last_changed: lc, attributes: attrs || {} } };
}

function normalized(
  entityIndex: Record<string, any>,
  unavailable: string[] | null = null,
): Record<string, any> {
  return { entity_index: entityIndex, unavailable_entities: unavailable || [] };
}

function rootWithArtifact(tmp: string, degradedDomains: string[]): string {
  const state = join(tmp, '.hermit', 'state');
  mkdirSync(state, { recursive: true });
  const artifact = { degraded_entity_domains: degradedDomains.map((d) => ({ domain: d })) };
  writeFileSync(join(state, 'integration-health-degraded-domains.json'), JSON.stringify(artifact), 'utf8');
  return tmp;
}

// --- dead automations ---

test('dead automation when enabled and last_triggered older than threshold', () => {
  const old = daysAgo(45);
  const idx = entity('automation.lights', 'on', old, { last_triggered: old });
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  expect(
    result.dead_automations.some((e: Record<string, any>) => e.entity_id === 'automation.lights'),
  ).toBe(true);
});

test('dead automation when enabled and last_triggered null', () => {
  // Enabled long enough ago that "never fired" is meaningful.
  const old = daysAgo(45);
  const idx = entity('automation.lights', 'on', old, { last_triggered: null });
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  const dead = result.dead_automations;
  expect(dead.length).toBe(1);
  expect(dead[0].never_fired).toBe(true);
  expect(dead[0].days_silent).toBeNull();
});

test('recently enabled automation never fired not dead', () => {
  // A brand-new enabled automation that hasn't fired yet should NOT be flagged
  // as dead — we only know it's "never fired" because it was enabled today.
  const recent = daysAgo(2);
  const idx = entity('automation.new', 'on', recent, { last_triggered: null });
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  expect(result.dead_automations).toEqual([]);
});

test('disabled automation dropped silently not dead', () => {
  const idx = entity('automation.lights', 'off', null, { last_triggered: null });
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  expect(result.dead_automations).toEqual([]);
});

test('recently triggered automation not dead', () => {
  const recent = daysAgo(2);
  const idx = entity('automation.lights', 'on', null, { last_triggered: recent });
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  expect(result.dead_automations).toEqual([]);
});

// --- silent event sensors ---

test('silent event sensor detects motion device_class', () => {
  const old = daysAgo(14);
  const idx = entity('binary_sensor.front_door', 'off', old, { device_class: 'door' });
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  const sensors = result.silent_event_sensors;
  expect(sensors.length).toBe(1);
  expect(sensors[0].device_class).toBe('door');
});

test('silent event sensor ignores battery device_class', () => {
  const old = daysAgo(14);
  const idx = entity('binary_sensor.sensor_battery', 'off', old, { device_class: 'battery' });
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  expect(result.silent_event_sensors).toEqual([]);
});

test('recently changed event sensor not silent', () => {
  const recent = daysAgo(1);
  const idx = entity('binary_sensor.motion', 'off', recent, { device_class: 'motion' });
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  expect(result.silent_event_sensors).toEqual([]);
});

// --- inactive candidates ---

test('inactive candidates routed to per-domain bucket only', () => {
  const old = daysAgo(31);
  const idx = entity('light.guest_room', 'off', old);
  const result = computeSilenceSummary(normalized(idx), tmpPath(), { now: NOW });
  expect(result.silent_event_sensors).toEqual([]);
  expect(result.dead_automations).toEqual([]);
  expect(result.inactive_candidates_by_domain.light.length).toBe(1);
});

// --- long unavailable / suppression ---

test('long unavailable skips domains listed in state artifact', () => {
  const old = daysAgo(9);
  const idx = { 'sensor.outdoor_temp': { state: 'unavailable', last_changed: old, attributes: {} } };
  const root = rootWithArtifact(tmpPath(), ['sensor']);
  const result = computeSilenceSummary(normalized(idx, ['sensor.outdoor_temp']), root, { now: NOW });
  expect(result.long_unavailable).toEqual([]);
  expect(result.suppressed_entity_domains).toContain('sensor');
});

test('long unavailable unfiltered when state artifact missing', () => {
  const old = daysAgo(9);
  const idx = { 'sensor.outdoor_temp': { state: 'unavailable', last_changed: old, attributes: {} } };
  const result = computeSilenceSummary(normalized(idx, ['sensor.outdoor_temp']), tmpPath(), {
    now: NOW,
  });
  expect(result.long_unavailable.length).toBe(1);
  expect(result.suppressed_entity_domains).toEqual([]);
});

test('long unavailable only includes entities past threshold', () => {
  const recent = daysAgo(2);
  const idx = { 'sensor.temp': { state: 'unavailable', last_changed: recent, attributes: {} } };
  const result = computeSilenceSummary(normalized(idx, ['sensor.temp']), tmpPath(), { now: NOW });
  expect(result.long_unavailable).toEqual([]);
});

test('long unavailable excludes unknown entities from a snapshot', () => {
  const old = daysAgo(9);
  const states = [
    { entity_id: 'button.restart', state: 'unknown', last_changed: old, attributes: {} },
    { entity_id: 'sensor.temp', state: 'unavailable', last_changed: old, attributes: {} },
  ];
  const result = computeSilenceSummary(normalizeContext(states, [], []), tmpPath(), { now: NOW });
  expect(result.long_unavailable.map((r: Record<string, any>) => r.entity_id)).toEqual(['sensor.temp']);
});

// --- sort order ---

test('silence summary deterministic sort order', () => {
  const oldA = daysAgo(45);
  const oldB = daysAgo(10);
  const idx = {
    ...entity('automation.b', 'on', oldB, { last_triggered: oldB }),
    ...entity('automation.a', 'on', oldA, { last_triggered: oldA }),
  };
  const root = tmpPath();
  const result1 = computeSilenceSummary(normalized(idx), root, { now: NOW });
  const result2 = computeSilenceSummary(normalized(idx), root, { now: NOW });
  expect(result1.dead_automations).toEqual(result2.dead_automations);
  expect(result1.dead_automations[0].entity_id).toBe('automation.a');
});
