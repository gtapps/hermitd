// WP7 tier 3: tests for cli.ts delete/list commands — 1:1 port of
// tests/test_cli_delete.py (6 cases).
//
// pytest fixture mapping: patch(cli.load_config/HomeAssistantClient) ->
// main(argv, { loadConfig, createClient }) dependency injection.

import { afterAll, expect, test } from 'bun:test';

import { main } from '../src/cli';
import { HomeAssistantError } from '../src/ha-api';
import { captureOutput, cleanupTmp, fakeClient, makeMockConfig, type FakeClient } from './helpers';

afterAll(cleanupTmp);

function runCli(argv: string[], client: FakeClient) {
  const cfg = makeMockConfig();
  return captureOutput(() =>
    main(argv, { loadConfig: () => cfg, createClient: async () => client }),
  );
}

test('delete automation ok', async () => {
  const client = fakeClient({ del: () => ({ result: 'ok' }) });
  const { code, out } = await runCli(['ha', 'delete-automation', 'my_automation'], client);

  expect(code).toBe(0);
  expect(out).toBe('OK\n');
  expect(client.calls.delete).toEqual(['/api/config/automation/config/my_automation']);
});

test('delete script ok', async () => {
  const client = fakeClient({ del: () => ({ result: 'ok' }) });
  const { code, out } = await runCli(['ha', 'delete-script', 'my_script'], client);

  expect(code).toBe(0);
  expect(out).toBe('OK\n');
  expect(client.calls.delete).toEqual(['/api/config/script/config/my_script']);
});

test('delete scene ok', async () => {
  const client = fakeClient({ del: () => ({ result: 'ok' }) });
  const { code, out } = await runCli(['ha', 'delete-scene', 'my_scene'], client);

  expect(code).toBe(0);
  expect(out).toBe('OK\n');
  expect(client.calls.delete).toEqual(['/api/config/scene/config/my_scene']);
});

test('delete automation not found reports not_found, exit 0', async () => {
  const client = fakeClient({
    del: () => {
      throw new HomeAssistantError(
        'Home Assistant request failed.',
        400,
        '{"message":"Resource not found"}',
      );
    },
  });
  const { code, out } = await runCli(['ha', 'delete-automation', 'nonexistent'], client);

  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ status: 'not_found', reason: 'no_config', config_id: 'nonexistent' });
});

test('list automations ok', async () => {
  const states = [
    {
      entity_id: 'automation.lights_on',
      attributes: { id: 'lights_on', friendly_name: 'Lights On' },
      state: 'on',
      last_changed: '2026-05-05T10:00:00Z',
    },
    {
      entity_id: 'light.living_room',
      attributes: {},
      state: 'off',
      last_changed: '2026-05-05T10:00:00Z',
    },
  ];
  const client = fakeClient({ get: () => states });
  const { code, out } = await runCli(['ha', 'list-automations'], client);

  expect(code).toBe(0);
  const items = JSON.parse(out).automations;
  expect(items.length).toBe(1);
  expect(items[0].entity_id).toBe('automation.lights_on');
  expect(items[0].id).toBe('lights_on');
  expect(items[0].friendly_name).toBe('Lights On');
  expect(items[0].deletable).toBe(true);
});

test('list scripts filters correctly', async () => {
  const states = [
    {
      entity_id: 'script.welcome',
      attributes: { id: 'welcome', friendly_name: 'Welcome' },
      state: 'off',
      last_changed: '2026-05-05T10:00:00Z',
    },
    {
      entity_id: 'automation.lights_on',
      attributes: { id: 'lights_on', friendly_name: 'Lights On' },
      state: 'on',
      last_changed: '2026-05-05T10:00:00Z',
    },
  ];
  const client = fakeClient({ get: () => states });
  const { code, out } = await runCli(['ha', 'list-scripts'], client);

  expect(code).toBe(0);
  const items = JSON.parse(out).scripts;
  expect(items.length).toBe(1);
  expect(items[0].entity_id).toBe('script.welcome');
});

test('list scenes filters correctly', async () => {
  const states = [
    {
      entity_id: 'scene.movie_night',
      attributes: { id: 'movie_night', friendly_name: 'Movie Night' },
      state: '2026-05-05T10:00:00Z',
      last_changed: '2026-05-05T10:00:00Z',
    },
    {
      entity_id: 'automation.lights_on',
      attributes: { id: 'lights_on', friendly_name: 'Lights On' },
      state: 'on',
      last_changed: '2026-05-05T10:00:00Z',
    },
  ];
  const client = fakeClient({ get: () => states });
  const { code, out } = await runCli(['ha', 'list-scenes'], client);

  expect(code).toBe(0);
  const items = JSON.parse(out).scenes;
  expect(items.length).toBe(1);
  expect(items[0].entity_id).toBe('scene.movie_night');
});

test('list automations marks yaml-packaged as not deletable', async () => {
  const states = [
    {
      entity_id: 'automation.ui_managed',
      attributes: { id: 'ui_managed', friendly_name: 'UI Managed' },
      state: 'on',
      last_changed: '2026-05-05T10:00:00Z',
    },
    {
      entity_id: 'automation.yaml_packaged',
      attributes: { friendly_name: 'YAML Packaged' },
      state: 'on',
      last_changed: '2026-05-05T10:00:00Z',
    },
  ];
  const client = fakeClient({ get: () => states });
  const { code, out } = await runCli(['ha', 'list-automations'], client);

  expect(code).toBe(0);
  const items = JSON.parse(out).automations;
  expect(items.length).toBe(2);
  const byEntity = Object.fromEntries(items.map((item: any) => [item.entity_id, item]));
  expect(byEntity['automation.ui_managed'].deletable).toBe(true);
  expect(byEntity['automation.yaml_packaged'].deletable).toBe(false);
  expect(byEntity['automation.yaml_packaged'].id).toBeNull();
});

test('list automations returns sorted by entity_id', async () => {
  const states = [
    {
      entity_id: 'automation.zebra',
      attributes: { id: 'zebra', friendly_name: 'Zebra' },
      state: 'on',
      last_changed: '2026-05-05T10:00:00Z',
    },
    {
      entity_id: 'automation.alpha',
      attributes: { id: 'alpha', friendly_name: 'Alpha' },
      state: 'on',
      last_changed: '2026-05-05T10:00:00Z',
    },
  ];
  const client = fakeClient({ get: () => states });
  const { code, out } = await runCli(['ha', 'list-automations'], client);

  expect(code).toBe(0);
  const items = JSON.parse(out).automations;
  expect(items.map((item: any) => item.entity_id)).toEqual([
    'automation.alpha',
    'automation.zebra',
  ]);
});
