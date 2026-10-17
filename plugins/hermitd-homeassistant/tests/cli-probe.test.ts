// WP7 tier 3: tests for the 'ha probe' CLI subcommand — 1:1 port of
// tests/test_cli_probe.py (2 cases).

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

test('probe success', async () => {
  const response = { id: '123', alias: 'Test automation', trigger: [] };
  const client = fakeClient({ get: () => response });

  const { code, out } = await runCli(['ha', 'probe', '/api/config/automation/config/123'], client);

  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ data: response });
  expect(client.calls.get).toEqual(['/api/config/automation/config/123']);
});

test('probe 404 exits nonzero', async () => {
  const client = fakeClient({
    get: () => {
      throw new HomeAssistantError('not found', 404, 'Not Found');
    },
  });

  const { code, out } = await runCli(['ha', 'probe', '/api/config/automation/config/999'], client);

  expect(code).toBe(1);
  expect(JSON.parse(out)).toEqual({ error: 'ha_http_404:not found (status=404)' });
});
