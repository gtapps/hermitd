import { afterAll, expect, test } from 'bun:test';

import type { AppConfig } from '../src/config';
import { handleUpdates } from '../src/cli';
import { HomeAssistantError } from '../src/ha-api';
import { captureOutput, cleanupTmp, fakeClient } from './helpers';

afterAll(cleanupTmp);

const dummyConfig = {} as AppConfig;

const CORE = {
  entity_id: 'update.home_assistant_core_update',
  state: 'on',
  attributes: {
    title: 'Home Assistant Core',
    installed_version: '2026.6.3',
    latest_version: '2026.7.1',
    release_url: 'https://example.com/core',
  },
};

const CORE_JSON = {
  tier: 'core',
  title: 'Home Assistant Core',
  installed_version: '2026.6.3',
  latest_version: '2026.7.1',
  release_url: 'https://example.com/core',
};

const withStates = (states: unknown[]) => ({ createClient: async () => fakeClient({ getStates: () => states as any }) });
const unreachable = {
  createClient: async () => {
    throw new HomeAssistantError('HA unreachable');
  },
};

test('cli updates lists a pending update as JSON', async () => {
  const { code, out } = await captureOutput(() => handleUpdates(dummyConfig, withStates([CORE])));
  expect(code).toBe(0);
  const json = JSON.parse(out);
  expect(json.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(json).toMatchObject({ total: 1, updates: [CORE_JSON], hacs_pending: 0 });
  expect(json.more).toBeUndefined();
});

test('cli updates reports an empty list when nothing is pending', async () => {
  const { code, out } = await captureOutput(() => handleUpdates(dummyConfig, withStates([])));
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ total: 0, updates: [], hacs_pending: 0 });
});

test('cli updates skips cleanly when HA is unreachable', async () => {
  const { code, out } = await captureOutput(() => handleUpdates(dummyConfig, unreachable));
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'skipped', reason: 'ha_unreachable', detail: 'HA unreachable' });
});

// The --digest wiring must never change the default output read by
// ha-update-check's scheduled check.
test('cli updates default output is identical with and without the digest flag defaulting off', async () => {
  const withoutFlag = await captureOutput(() => handleUpdates(dummyConfig, withStates([CORE])));
  const withFlagFalse = await captureOutput(() => handleUpdates(dummyConfig, withStates([CORE]), false));
  expect(withFlagFalse.out).toBe(withoutFlag.out);
});

test('cli updates --digest lists tier-sorted top updates and counts the rest', async () => {
  const states = [
    { entity_id: 'update.mosquitto_broker', state: 'on', attributes: { installed_version: '6.4', latest_version: '6.5', supported_features: 29 } },
    { entity_id: 'update.home_assistant_supervisor_update', state: 'on', attributes: { installed_version: '2026.7.0', latest_version: '2026.7.1' } },
    CORE,
    { entity_id: 'update.home_assistant_operating_system_update', state: 'on', attributes: { installed_version: '13.0', latest_version: '13.1' } },
    { entity_id: 'update.frigate', state: 'on', attributes: { installed_version: '1.0', latest_version: '1.1' } },
  ];
  const { code, out } = await captureOutput(() => handleUpdates(dummyConfig, withStates(states), true));
  expect(code).toBe(0);
  const json = JSON.parse(out);
  expect(json.updates.map((u: { tier: string }) => u.tier)).toEqual(['core', 'os', 'supervisor']);
  expect(json).toMatchObject({ total: 5, more: 1, hacs_pending: 1 });
});

test('cli updates --digest with zero updates reports an empty list', async () => {
  const { code, out } = await captureOutput(() => handleUpdates(dummyConfig, withStates([]), true));
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ total: 0, updates: [], more: 0, hacs_pending: 0 });
});

test('cli updates --digest on fetch failure skips like the default', async () => {
  const { code, out } = await captureOutput(() => handleUpdates(dummyConfig, unreachable, true));
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'skipped', reason: 'ha_unreachable' });
});
