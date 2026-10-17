// Tests for 'ha call-service' — the per-entity/service policy gate
// (gateServiceCall), distinct from gateStructuralMutation: non-sensitive
// calls proceed in both modes; sensitive ones follow strict/ask like every
// other gate.

// Whole file runs serial: afterEach drains the shared tmpDirs array and clears
// the global policy cache — per-test global state that cannot isolate under
// `bun test --concurrent`.
import { afterEach, expect, test as bunTest } from 'bun:test';
const test = bunTest.serial;

import { main } from '../src/cli';
import { HomeAssistantError } from '../src/ha-api';
import { clearPolicyCaches } from '../src/policy';
import {
  captureOutput,
  cleanupTmp,
  fakeClient,
  makeHaConfig,
  makeHaConfigWith,
  tmpPath,
  type FakeClient,
} from './helpers';
import { AppConfig } from '../src/config';

afterEach(() => {
  cleanupTmp();
  clearPolicyCaches();
});

function cfg(mode?: string): AppConfig {
  const root = mode ? makeHaConfig(mode) : tmpPath();
  return new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
}

function runCli(argv: string[], client: FakeClient, config: AppConfig) {
  return captureOutput(() =>
    main(argv, { loadConfig: () => config, createClient: async () => client }),
  );
}

test('rejects a target with no dot', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(['ha', 'call-service', 'reload_all'], client, cfg());
  expect(code).toBe(1);
  expect(JSON.parse(out).error).toStartWith("usage:domain.service must contain a '.'");
});

test('rejects invalid --data JSON', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'automation.reload', '--data', 'not-json'],
    client,
    cfg(),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).error).toBe('usage:--data is not valid JSON');
});

test('non-sensitive service call proceeds under strict', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(['ha', 'call-service', 'automation.reload'], client, cfg('strict'));
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed).toHaveProperty('data');
  expect(parsed.report_path).toBeTruthy();
  expect(client.calls.post).toEqual([['/api/services/automation/reload', {}]]);
});

test('sensitive domain via --data entity_id blocked under strict', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'lock.unlock', '--data', '{"entity_id":"lock.front_door"}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.status).toBe('blocked');
  expect(parsed.reason).toBe('strict_mode');
  expect(client.calls.post.length).toBe(0);
});


test('sensitive domain under ask runs', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'lock.unlock', '--data', '{"entity_id":"lock.front_door"}'],
    client,
    cfg('ask'),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed).toHaveProperty('data');
  expect(client.calls.post).toEqual([
    ['/api/services/lock/unlock', { entity_id: 'lock.front_door' }],
  ]);
});

test('target as an array (not an object) fails closed instead of silently extracting nothing', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'light.turn_off', '--data', '{"target":["lock.front_door"]}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.status).toBe('blocked');
  expect(parsed.detail).toContain('malformed targeting field');
  expect(client.calls.post.length).toBe(0);
});

test('non-string entity_id fails closed instead of silently extracting nothing', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'light.turn_off', '--data', '{"entity_id":123}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out).detail).toContain('malformed targeting field');
  expect(client.calls.post.length).toBe(0);
});

test('mixed-type entity_id array fails closed', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'light.turn_off', '--data', '{"entity_id":["light.x", 42]}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out).detail).toContain('malformed targeting field');
});

test('unresolvable area_id target fails closed in both modes', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'light.turn_off', '--data', '{"target":{"area_id":"living_room"}}'],
    client,
    cfg('ask'),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.status).toBe('blocked');
  expect(parsed.detail).toContain('no resolvable entity IDs');
  expect(client.calls.post.length).toBe(0);
});

test('HA error surfaces verbatim', async () => {
  const client = fakeClient({
    post: () => {
      throw new HomeAssistantError('Service not found.', 400);
    },
  });
  const { code, out } = await runCli(['ha', 'call-service', 'automation.reload'], client, cfg());
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed).toEqual({ error: 'ha_http_400:Service not found. (status=400)' });
});

test('sensitive entity hidden in scene.apply entities map is blocked under strict', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'scene.apply', '--data', '{"entities":{"lock.front_door":"unlocked"}}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.status).toBe('blocked');
  expect(client.calls.post.length).toBe(0);
});

test('sensitive entity in scene.apply entities map executes under ask after native approval', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'scene.apply', '--data', '{"entities":{"lock.front_door":"unlocked"}}'],
    client,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(client.calls.post.length).toBe(1);
});

test('non-sensitive entities in scene.apply map still proceed under strict', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'scene.apply', '--data', '{"entities":{"light.living_room":"on"}}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out)).toHaveProperty('data');
  expect(client.calls.post).toEqual([
    ['/api/services/scene/apply', { entities: { 'light.living_room': 'on' } }],
  ]);
});

// The update-domain carve-out in gateServiceCall: independent of ha_safety_mode,
// gated solely by ha_update_auto_apply; native approval belongs to the harness. See policy.ts's dedicated
// branch above the ALLOW passthrough.

function cfgWithFlag(mode: string, updateAutoApply: boolean): AppConfig {
  const root = makeHaConfigWith(mode, { ha_update_auto_apply: updateAutoApply });
  return new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
}

test('update.install blocked under strict when ha_update_auto_apply is unset', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(
    ['ha', 'call-service', 'update.install', '--data', '{"entity_id":"update.home_assistant_core_update"}'],
    client,
    cfg('strict'),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.status).toBe('blocked');
  expect(parsed.reason).toBe('update_auto_apply_disabled');
  expect(client.calls.post.length).toBe(0);
});

test('update.install blocked under ask when ha_update_auto_apply is unset, even', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    [
      'ha',
      'call-service',
      'update.install',
      '--data',
      '{"entity_id":"update.home_assistant_core_update"}',
    ],
    client,
    cfg('ask'),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out).status).toBe('blocked');
  expect(client.calls.post.length).toBe(0);
});


test('update.install with ha_update_auto_apply on runs under strict', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    [
      'ha',
      'call-service',
      'update.install',
      '--data',
      '{"entity_id":"update.home_assistant_core_update","backup":true}',
    ],
    client,
    cfgWithFlag('strict', true),
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed).toHaveProperty('data');
  expect(client.calls.post).toEqual([
    [
      '/api/services/update/install',
      { entity_id: 'update.home_assistant_core_update', backup: true },
    ],
  ]);
});

test('update.install with ha_update_auto_apply on runs under ask (mode-independent)', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    ['ha', 'call-service', 'update.install', '--data', '{"entity_id":"update.home_assistant_core_update"}'],
    client,
    cfgWithFlag('ask', true),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out)).toHaveProperty('data');
});

test('update.install carrying a lock entity still hard-blocks under strict even with the flag on', async () => {
  const client = fakeClient({ post: () => ({ status: 'ok' }) });
  const { code, out } = await runCli(
    [
      'ha',
      'call-service',
      'update.install',
      '--data',
      '{"entity_id":["update.home_assistant_core_update","lock.front_door"]}',
    ],
    client,
    cfgWithFlag('strict', true),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out).status).toBe('blocked');
  expect(client.calls.post.length).toBe(0);
});
