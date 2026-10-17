// WP7 tier 3: tests for cli.ts get-*-config commands — 1:1 port of
// tests/test_cli_get_config.py (3 cases + 1 parametrized pair).

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

test('get automation config ok', async () => {
  const configPayload = { id: 'my_automation', alias: 'My Automation', trigger: [], action: [] };
  const client = fakeClient({ get: () => configPayload });
  const { code, out } = await runCli(['ha', 'get-automation-config', 'my_automation'], client);

  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.domain).toBe('automation');
  expect(parsed.config_id).toBe('my_automation');
  expect(parsed.config).toEqual(configPayload);
  expect(client.calls.get).toEqual(['/api/config/automation/config/my_automation']);
});

test('get script config ok', async () => {
  const configPayload = { id: 'garage_gate', alias: 'Garage Gate', sequence: [{ enabled: true }] };
  const client = fakeClient({ get: () => configPayload });
  const { code, out } = await runCli(['ha', 'get-script-config', 'garage_gate'], client);

  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.domain).toBe('script');
  expect(parsed.config_id).toBe('garage_gate');
  expect(parsed.config).toEqual(configPayload);
  expect(client.calls.get).toEqual(['/api/config/script/config/garage_gate']);
});

test('get scene config ok', async () => {
  const configPayload = { id: 'movie_night', name: 'Movie Night', entities: {} };
  const client = fakeClient({ get: () => configPayload });
  const { code, out } = await runCli(['ha', 'get-scene-config', 'movie_night'], client);

  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.domain).toBe('scene');
  expect(parsed.config_id).toBe('movie_night');
  expect(parsed.config).toEqual(configPayload);
  expect(client.calls.get).toEqual(['/api/config/scene/config/movie_night']);
});

for (const command of ['get-automation-config', 'get-script-config', 'get-scene-config']) {
  test(`${command} not found reports not_found, exit 0`, async () => {
    const client = fakeClient({
      get: () => {
        throw new HomeAssistantError(
          'Home Assistant request failed.',
          400,
          '{"message":"Resource not found"}',
        );
      },
    });
    const { code, out } = await runCli(['ha', command, 'nonexistent'], client);

    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: 'not_found', reason: 'no_config', config_id: 'nonexistent' });
  });
}

test('get automation config yaml mode 403', async () => {
  const client = fakeClient({
    get: () => {
      throw new HomeAssistantError(
        'Forbidden: Home Assistant is in YAML mode (REST config API unavailable).',
        403,
        '',
      );
    },
  });
  const { code, out } = await runCli(['ha', 'get-automation-config', 'my_auto'], client);

  expect(code).toBe(1);
  expect(JSON.parse(out).error).toStartWith('read_failed:Forbidden: Home Assistant is in YAML mode');
});
