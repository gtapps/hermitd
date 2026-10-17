// Stdout shapes of the CLI verbs skills branch on: one JSON object, exit 0 for
// expected outcomes (invalid artifact, policy block, baseline, empty snapshot),
// exit 1 with {"error"} only for a real failure.

import { afterEach, expect, test as bunTest } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '../src/cli';
import { AppConfig } from '../src/config';
import { HomeAssistantError } from '../src/ha-api';
import { clearPolicyCaches } from '../src/policy';
import { captureOutput, cleanupTmp, fakeClient, makeHaConfig, makeHaRoot, writeArtifact, type FakeClient } from './helpers';

// Serial: afterEach drains shared tmp dirs and the global policy cache.
const test = bunTest.serial;

afterEach(() => {
  cleanupTmp();
  clearPolicyCaches();
});

function run(argv: string[], root: string, client: FakeClient = fakeClient()) {
  const config = new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
  return captureOutput(() => main(argv, { loadConfig: () => config, createClient: async () => client }));
}

test('simulate prints OK for a valid artifact', async () => {
  const root = makeHaRoot();
  const artifact = writeArtifact(root, 'action:\n  - service: light.turn_on\n    target:\n      entity_id: light.living_room\n');
  const { code, out } = await run(['ha', 'simulate', artifact], root);
  expect(code).toBe(0);
  expect(out).toBe('OK\n');
});

test('simulate reports an invalid artifact as a status, exit 0', async () => {
  const root = makeHaRoot();
  const artifact = writeArtifact(root, 'action:\n  - service: light.turn_on\n    target:\n      entity_id: light.missing\n');
  const { code, out } = await run(['ha', 'simulate', artifact], root);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'invalid', reason: 'missing_entities', missing_entities: ['light.missing'] });
});

test('validate-apply reports a failed simulation as a status, exit 0', async () => {
  const root = makeHaRoot();
  const artifact = writeArtifact(root, 'action:\n  - service: light.turn_on\n    target:\n      entity_id: light.missing\n');
  const { code, out } = await run(['ha', 'validate-apply', artifact], root);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'invalid', reason: 'simulation_failed' });
});

test('policy-check on a sensitive entity answers exit 0', async () => {
  const root = makeHaRoot();
  const { code, out } = await run(['ha', 'policy-check', 'lock.front_door'], root);
  expect(code).toBe(0);
  expect(JSON.parse(out).sensitive).toBe(true);
});

test('an unreachable HA prints ha_unreachable on stdout', async () => {
  const root = makeHaRoot();
  const client = fakeClient({
    get: () => {
      throw new HomeAssistantError('Failed to reach Home Assistant.');
    },
  });
  const { code, out, err } = await run(['ha', 'list-automations'], root, client);
  expect(code).toBe(1);
  expect(JSON.parse(out)).toEqual({ error: 'ha_unreachable:Failed to reach Home Assistant.' });
  expect(err).toBe('');
});

test('fetch-history reports an unreachable HA on stdout, not stderr', async () => {
  const root = makeHaRoot();
  const config = new AppConfig(root, 'http://ha.local:8123', null, null, 'tok', 5, 0);
  const { code, out, err } = await captureOutput(() =>
    main(['ha', 'fetch-history'], {
      loadConfig: () => config,
      createClient: async () => {
        throw new HomeAssistantError('Failed to reach Home Assistant.');
      },
    }),
  );
  expect(code).toBe(1);
  expect(JSON.parse(out)).toEqual({ error: 'ha_unreachable:Failed to reach Home Assistant.' });
  expect(err).toBe('');
});

test('audit-automations prints the findings as JSON', async () => {
  const root = makeHaRoot();
  const client = fakeClient({
    get: (path) => {
      if (path === '/api/states') return [{ entity_id: 'automation.door', state: 'on', attributes: { id: 'door', friendly_name: 'Door' } }];
      return { id: 'door', alias: 'Unlock door', action: [{ service: 'lock.unlock', target: { entity_id: 'lock.front_door' } }] };
    },
  });
  const { code, out } = await run(['ha', 'audit-automations'], root, client);
  expect(code).toBe(0);
  const json = JSON.parse(out);
  expect(json).toMatchObject({ domain: 'automation', scanned: 1, passed: 0, acknowledged: 0, unmanaged: 0, fetch_failures: 0 });
  expect(json.violations).toHaveLength(1);
  expect(json.violations[0]).toMatchObject({ alias: 'Unlock door', id: 'door' });
});

test('automation-diff reports a baseline first, then the changes', async () => {
  const root = makeHaRoot();
  const configs: Record<string, any> = { morning: { id: 'morning', alias: 'Morning', trigger: [], action: [] } };
  const client = fakeClient({
    get: (path) => {
      if (path === '/api/states') {
        return [{ entity_id: 'automation.morning', state: 'on', attributes: { id: 'morning', friendly_name: 'Morning' } }];
      }
      return configs[path.split('/').pop()!];
    },
  });
  const first = await run(['ha', 'automation-diff'], root, client);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.out)).toEqual({ status: 'baseline', reason: 'no_prior_snapshot', tracked: 1 });

  configs.morning = { ...configs.morning, trigger: [{ platform: 'time' }] };
  const second = await run(['ha', 'automation-diff'], root, client);
  expect(second.code).toBe(0);
  expect(JSON.parse(second.out)).toMatchObject({
    tracked: 1,
    changes: [{ change: 'edited', name: 'Morning', id: 'morning' }],
    untracked: 0,
  });
});

test('restore-states reports a strict-mode block as a status, exit 0', async () => {
  const root = makeHaConfig('strict');
  const artifact = join(root, 'snap.json');
  writeFileSync(artifact, JSON.stringify({ name: 'x', generated: 'y', entities: { 'lock.front_door': { state: 'locked', attributes: {} } } }));
  const client = fakeClient();
  const { code, out } = await run(['ha', 'restore-states', artifact], root, client);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ status: 'blocked', reason: 'strict_mode', sensitive: ['lock.front_door'] });
  expect(client.calls.post).toHaveLength(0);
});

test('restore-states reports an empty snapshot as a status, exit 0', async () => {
  const root = makeHaConfig('ask');
  const artifact = join(root, 'snap.json');
  writeFileSync(artifact, JSON.stringify({ name: 'x', generated: 'y', entities: {} }));
  const { code, out } = await run(['ha', 'restore-states', artifact], root);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ status: 'empty', reason: 'no_entities' });
});
