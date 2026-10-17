// WP7 tier 3: tests for the 'ha fetch-history' CLI subcommand — 1:1 port of
// tests/test_cli_fetch_history.py (5 cases).

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfig } from '../src/config';
import { main } from '../src/cli';
import { captureOutput, cleanupTmp, fakeClient, makeMockConfig, type FakeClient } from './helpers';

afterAll(cleanupTmp);

function makeNormalized(root: string, entities: Record<string, any> | null = null): string {
  const raw = join(root, '.hermit', 'raw');
  mkdirSync(raw, { recursive: true });
  const payload = {
    entity_index: entities || { 'light.kitchen': { state: 'on', attributes: {} } },
  };
  const path = join(raw, 'snapshot-ha-normalized-latest.json');
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
}

function mockClient(historyData: Record<string, Array<Record<string, any>>>): FakeClient {
  return fakeClient({ getHistory: () => historyData });
}

function runCli(argv: string[], cfg: AppConfig, client: FakeClient) {
  return captureOutput(() =>
    main(argv, { loadConfig: () => cfg, createClient: async () => client }),
  );
}

test('fetch-history writes per-window artifact with correct filename', async () => {
  const cfg = makeMockConfig();
  makeNormalized(cfg.root);

  const { code, out } = await runCli(
    ['ha', 'fetch-history', '--window-days', '7'],
    cfg,
    mockClient({}),
  );

  expect(code).toBe(0);
  expect(
    existsSync(join(cfg.root, '.hermit', 'raw', 'snapshot-ha-history-7d-latest.json')),
  ).toBe(true);
  const parsed = JSON.parse(out);
  expect(parsed.status).toBeUndefined();
  expect(parsed.window_days).toBe(7);
});

test('fetch-history does not clobber other window artifact', async () => {
  const cfg = makeMockConfig();
  makeNormalized(cfg.root);

  await runCli(['ha', 'fetch-history', '--window-days', '7'], cfg, mockClient({}));
  await runCli(['ha', 'fetch-history', '--window-days', '1'], cfg, mockClient({}));

  const raw = join(cfg.root, '.hermit', 'raw');
  expect(existsSync(join(raw, 'snapshot-ha-history-7d-latest.json'))).toBe(true);
  expect(existsSync(join(raw, 'snapshot-ha-history-1d-latest.json'))).toBe(true);
  // Verify the two artifacts carry different window_days metadata
  const d7 = JSON.parse(readFileSync(join(raw, 'snapshot-ha-history-7d-latest.json'), 'utf8'));
  const d1 = JSON.parse(readFileSync(join(raw, 'snapshot-ha-history-1d-latest.json'), 'utf8'));
  // Both should exist and differ in their window spans
  expect(d7.window_start).not.toBe(d1.window_start);
});

test('fetch-history --include-transitions writes transitions field', async () => {
  const cfg = makeMockConfig();
  makeNormalized(cfg.root, { 'person.alice': { state: 'home', attributes: {} } });
  const historyData = {
    'person.alice': [
      { state: 'home', last_changed: '2026-05-01T06:00:00+00:00' },
      { state: 'away', last_changed: '2026-05-01T18:00:00+00:00' },
    ],
  };

  const { code } = await runCli(
    ['ha', 'fetch-history', '--entities', 'person.*', '--include-transitions'],
    cfg,
    mockClient(historyData),
  );

  expect(code).toBe(0);
  const artifact = join(cfg.root, '.hermit', 'raw', 'snapshot-ha-history-7d-latest.json');
  const data = JSON.parse(readFileSync(artifact, 'utf8'));
  const agg = data.entity_aggregates['person.alice'];
  expect(Object.keys(agg)).toContain('transitions');
  const states = agg.transitions.map((t: any) => t.state);
  expect(states).toEqual(['home', 'away']);
});

test('fetch-history without flag omits transitions field', async () => {
  const cfg = makeMockConfig();
  makeNormalized(cfg.root, { 'person.alice': { state: 'home', attributes: {} } });
  const historyData = {
    'person.alice': [{ state: 'home', last_changed: '2026-05-01T06:00:00+00:00' }],
  };

  await runCli(['ha', 'fetch-history', '--entities', 'person.*'], cfg, mockClient(historyData));

  const artifact = join(cfg.root, '.hermit', 'raw', 'snapshot-ha-history-7d-latest.json');
  const data = JSON.parse(readFileSync(artifact, 'utf8'));
  expect(Object.keys(data.entity_aggregates['person.alice'])).not.toContain('transitions');
});

test('fetch-history glob entities expand against snapshot', async () => {
  const cfg = makeMockConfig();
  makeNormalized(cfg.root, {
    'person.alice': { state: 'home', attributes: {} },
    'person.bob': { state: 'away', attributes: {} },
    'light.kitchen': { state: 'on', attributes: {} },
  });

  const { code } = await runCli(['ha', 'fetch-history', '--entities', 'person.*'], cfg, mockClient({}));

  expect(code).toBe(0);
  const artifact = join(cfg.root, '.hermit', 'raw', 'snapshot-ha-history-7d-latest.json');
  const data = JSON.parse(readFileSync(artifact, 'utf8'));
  const requested = data.requested_entities;
  expect(requested).toContain('person.alice');
  expect(requested).toContain('person.bob');
  expect(requested).not.toContain('light.kitchen');
});
