// Tests for 'ha reload-entry' — the one REST-based gated write in this CLI,
// applying gateStructuralMutation directly (not via runWsMutation, which is
// WS-client-specific) before a plain client.post() call.

// Whole file runs serial: afterEach drains the shared tmpDirs array and clears
// the global policy cache — per-test global state that cannot isolate under
// `bun test --concurrent`.
import { afterEach, expect, test as bunTest } from 'bun:test';
const test = bunTest.serial;

import { main } from '../src/cli';
import { AppConfig } from '../src/config';
import { HomeAssistantError } from '../src/ha-api';
import { clearPolicyCaches } from '../src/policy';
import { captureOutput, cleanupTmp, fakeClient, makeHaConfig, tmpPath, type FakeClient } from './helpers';

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

test('reload-entry blocked under strict, no REST call sent', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(['ha', 'reload-entry', 'entry1'], client, cfg('strict'));
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.status).toBe('blocked');
  expect(parsed.reason).toBe('strict_mode');
  expect(client.calls.post.length).toBe(0);
});


test('reload-entry under ask posts the reload endpoint and writes a report', async () => {
  const client = fakeClient({ post: () => ({ require_restart: false }) });
  const { code, out } = await runCli(['ha', 'reload-entry', 'entry1'], client, cfg('ask'));
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed).toHaveProperty('data');
  expect(parsed.data).toEqual({ require_restart: false });
  expect(parsed.report_path).toBeTruthy();
  expect(client.calls.post).toEqual([['/api/config/config_entries/entry/entry1/reload', null]]);
});

test('reload-entry surfaces HA error verbatim', async () => {
  const client = fakeClient({
    post: () => {
      throw new HomeAssistantError('Entry not found.', 404);
    },
  });
  const { code, out } = await runCli(['ha', 'reload-entry', 'entry1'], client, cfg('ask'));
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed).toEqual({ error: 'ha_http_404:Entry not found. (status=404)' });
});
