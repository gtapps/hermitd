// Tests for 'ha error-log', 'ha logbook', and 'ha system-log' — Phase 3
// (logs & observability) reads. error-log exercises getText() (HA serves
// the raw log file, not JSON).

import { afterEach, expect, test } from 'bun:test';

import { main } from '../src/cli';
import { HomeAssistantError } from '../src/ha-api';
import { AppConfig } from '../src/config';
import { clearPolicyCaches } from '../src/policy';
import { captureOutput, cleanupTmp, fakeClient, makeMockConfig, tmpPath, type FakeClient } from './helpers';

afterEach(() => {
  cleanupTmp();
  clearPolicyCaches();
});

function runCli(argv: string[], client: FakeClient) {
  const cfg = makeMockConfig();
  return captureOutput(() =>
    main(argv, { loadConfig: () => cfg, createClient: async () => client }),
  );
}

test('error-log prints the raw log text under log', async () => {
  const client = fakeClient({ getText: () => '2026-07-01 12:00:00 ERROR (MainThread) [x] boom\n' });
  const { code, out } = await runCli(['ha', 'error-log'], client);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ log: '2026-07-01 12:00:00 ERROR (MainThread) [x] boom\n' });
  expect(client.calls.get).toEqual(['/api/error_log']);
});

test('error-log surfaces a 404 when logging is not registered', async () => {
  const client = fakeClient({
    getText: () => {
      throw new HomeAssistantError('Home Assistant endpoint not found.', 404);
    },
  });
  const { code, out } = await runCli(['ha', 'error-log'], client);
  expect(code).toBe(1);
  expect(JSON.parse(out).error).toStartWith('ha_http_404:');
});

test('logbook defaults to a 1-day window with no entity filter', async () => {
  const client = fakeClient({ get: () => [{ entity_id: 'sun.sun', state: 'above_horizon' }] });
  const { code, out } = await runCli(['ha', 'logbook'], client);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ entries: [{ entity_id: 'sun.sun', state: 'above_horizon' }] });
  expect(client.calls.get.length).toBe(1);
  expect(client.calls.get[0]).toMatch(/^\/api\/logbook\//);
  expect(client.calls.get[0]).not.toContain('entity=');
});

test('logbook --entity adds the entity query param', async () => {
  const client = fakeClient({ get: () => [] });
  const { code } = await runCli(['ha', 'logbook', '--entity', 'sun.sun'], client);
  expect(code).toBe(0);
  expect(client.calls.get[0]).toContain('entity=sun.sun');
});

test('logbook --window-days changes the requested start timestamp', async () => {
  const client7d = fakeClient({ get: () => [] });
  await runCli(['ha', 'logbook', '--window-days', '7'], client7d);

  const client1d = fakeClient({ get: () => [] });
  await runCli(['ha', 'logbook', '--window-days', '1'], client1d);

  expect(client7d.calls.get[0]).not.toBe(client1d.calls.get[0]);
});

test('system-log reads via WS', async () => {
  const cfg = makeMockConfig();
  const wsCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = {
    async command(type: string, payload: Record<string, unknown> = {}) {
      wsCalls.push({ type, payload });
      return [{ name: 'x', level: 'ERROR', message: ['boom'] }];
    },
    close() {},
  };
  const { code, out } = await captureOutput(() =>
    main(['ha', 'system-log'], { loadConfig: () => cfg, createWsClient: async () => ws }),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ data: [{ name: 'x', level: 'ERROR', message: ['boom'] }] });
  expect(wsCalls).toEqual([{ type: 'system_log/list', payload: {} }]);
});
