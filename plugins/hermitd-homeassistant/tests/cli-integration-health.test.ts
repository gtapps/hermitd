// WP7 tier 3: tests for cli.ts handleIntegrationHealth — 1:1 port of the 5
// `test_cli_integration_health_*` cases in tests/test_integration_health.py
// (deferred from tier 2; the 7 module cases live in integration-health.test.ts).
//
// pytest fixture mapping: monkeypatch.setattr(cli, refresh_context /
// HomeAssistantClient) -> handleIntegrationHealth(root, config, overrides).
// The "stat raises OSError" case uses an ENOTDIR parent (a regular file where
// raw/ should be) instead of patching Path.stat — same non-ENOENT branch.

import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AppConfig } from '../src/config';
import { handleIntegrationHealth } from '../src/cli';
import { HomeAssistantError } from '../src/ha-api';
import { captureOutput, cleanupTmp, fakeClient, tmpPath } from './helpers';

afterAll(cleanupTmp);

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

const dummyConfig = {} as AppConfig;

/** _setup_refresh_monkeypatch: a refresh that writes a fresh snapshot. */
function refreshOverrides(snapshotPath: string) {
  const [idx, unavail] = makeEntities('sensor', 6, 4);
  const fresh = { entity_index: idx, unavailable_entities: unavail };
  return {
    createClient: async () => fakeClient(),
    refreshContext: async () => {
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, JSON.stringify(fresh), 'utf8');
      return fresh;
    },
  };
}

test('cli integration-health emits the findings JSON', async () => {
  const tmp = tmpPath();
  const raw = join(tmp, '.hermit', 'raw');
  mkdirSync(raw, { recursive: true });
  const [idx, unavail] = makeEntities('sensor', 6, 4);
  const snapshot = { entity_index: idx, unavailable_entities: unavail };
  writeFileSync(join(raw, 'snapshot-ha-normalized-latest.json'), JSON.stringify(snapshot), 'utf8');

  const { code, out } = await captureOutput(() => handleIntegrationHealth(tmp, dummyConfig));
  expect(code).toBe(0);
  const json = JSON.parse(out);
  expect(json.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(json.scanned_domains).toBe(1);
  expect(JSON.parse(out).degraded).toEqual([{ domain: 'sensor', unavailable: 4, total: 6, percent: 66.7 }]);
});

test('cli integration-health reports an empty degraded list when nothing is flagged', async () => {
  const tmp = tmpPath();
  const raw = join(tmp, '.hermit', 'raw');
  mkdirSync(raw, { recursive: true });
  const [idx, unavail] = makeEntities('sensor', 6, 1);
  writeFileSync(
    join(raw, 'snapshot-ha-normalized-latest.json'),
    JSON.stringify({ entity_index: idx, unavailable_entities: unavail }),
    'utf8',
  );

  const { code, out } = await captureOutput(() => handleIntegrationHealth(tmp, dummyConfig));
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ scanned_domains: 1, degraded: [] });
});

test('cli integration-health refreshes and proceeds when snapshot missing', async () => {
  const tmp = tmpPath();
  const snapshotPath = join(tmp, '.hermit', 'raw', 'snapshot-ha-normalized-latest.json');

  const { code, out } = await captureOutput(() =>
    handleIntegrationHealth(tmp, dummyConfig, refreshOverrides(snapshotPath)),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out).status).toBeUndefined();
  expect(JSON.parse(out).degraded).toEqual([{ domain: 'sensor', unavailable: 4, total: 6, percent: 66.7 }]);
});

test('cli integration-health refreshes and proceeds when snapshot stale', async () => {
  const tmp = tmpPath();
  const raw = join(tmp, '.hermit', 'raw');
  mkdirSync(raw, { recursive: true });
  const snapshotPath = join(raw, 'snapshot-ha-normalized-latest.json');
  writeFileSync(snapshotPath, '{}', 'utf8');
  const staleTime = new Date(Date.now() - 25 * 3600 * 1000);
  utimesSync(snapshotPath, staleTime, staleTime);

  const { code, out } = await captureOutput(() =>
    handleIntegrationHealth(tmp, dummyConfig, refreshOverrides(snapshotPath)),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out).status).toBeUndefined();
  expect(JSON.parse(out).degraded).toEqual([{ domain: 'sensor', unavailable: 4, total: 6, percent: 66.7 }]);
});

test('cli integration-health skips cleanly when refresh fails', async () => {
  const tmp = tmpPath();

  const { code, out } = await captureOutput(() =>
    handleIntegrationHealth(tmp, dummyConfig, {
      createClient: async () => fakeClient(),
      refreshContext: async () => {
        throw new HomeAssistantError('HA unreachable');
      },
    }),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'skipped', reason: 'refresh_failed', detail: 'HA unreachable' });
});

test('cli integration-health refreshes when stat raises non-ENOENT', async () => {
  const tmp = tmpPath();
  // A regular file where the raw/ directory should be: statSync on the
  // snapshot path raises ENOTDIR (the Python case patched Path.stat to raise
  // PermissionError) — must be treated as stale, not crash.
  const hermitDir = join(tmp, '.hermit');
  mkdirSync(hermitDir, { recursive: true });
  const rawAsFile = join(hermitDir, 'raw');
  writeFileSync(rawAsFile, 'not a directory', 'utf8');
  const snapshotPath = join(rawAsFile, 'snapshot-ha-normalized-latest.json');

  const overrides = refreshOverrides(snapshotPath);
  const { code, out } = await captureOutput(() =>
    handleIntegrationHealth(tmp, dummyConfig, {
      ...overrides,
      refreshContext: async (root, client) => {
        rmSync(rawAsFile); // clear the blocker, then write the fresh snapshot
        return overrides.refreshContext();
      },
    }),
  );
  expect(code).toBe(0);
  expect(JSON.parse(out).status).toBeUndefined();
  expect(JSON.parse(out).degraded).toEqual([{ domain: 'sensor', unavailable: 4, total: 6, percent: 66.7 }]);
});
