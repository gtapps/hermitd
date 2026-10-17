import { afterAll, expect, test } from 'bun:test';

import { main } from '../src/cli';
import { captureOutput, cleanupTmp, fakeClient, makeMockConfig } from './helpers';

afterAll(cleanupTmp);

function makeDeps(postResult: Record<string, unknown> = {}) {
  const client = fakeClient({ post: () => postResult });
  return {
    calls: client.calls,
    deps: { createClient: async () => client, loadConfig: () => makeMockConfig() },
  };
}

test('trigger-automation: success', async () => {
  const { calls, deps } = makeDeps({ result: 'ok' });

  const { code, out } = await captureOutput(() =>
    main(['ha', 'trigger-automation', 'automation.morning_routine'], deps),
  );

  expect(code).toBe(0);
  expect(out).toBe('OK\n');
  expect(calls.post[0]![0]).toBe('/api/services/automation/trigger');
  expect(calls.post[0]![1]).toMatchObject({ entity_id: 'automation.morning_routine' });
});

test('trigger-automation: rejects non-automation entity_id', async () => {
  const { deps } = makeDeps();

  const { code, out } = await captureOutput(() =>
    main(['ha', 'trigger-automation', 'light.kitchen'], deps),
  );

  expect(code).toBe(1);
  expect(JSON.parse(out).error).toStartWith("usage:automation_id must start with 'automation.'");
});

test('trigger-automation: HA error → error token, exit 1', async () => {
  const { HomeAssistantError } = await import('../src/ha-api');
  const errClient = fakeClient({
    post: () => {
      throw new HomeAssistantError('Entity not found', 404);
    },
  });
  const deps = {
    createClient: async () => errClient,
    loadConfig: () => makeMockConfig(),
  };

  const { code, out } = await captureOutput(() =>
    main(['ha', 'trigger-automation', 'automation.missing'], deps),
  );

  expect(code).toBe(1);
  expect(JSON.parse(out)).toEqual({ error: 'ha_http_404:Entity not found (status=404)' });
});

test('trigger-automation: missing arg prints a usage error, exit 1', async () => {
  const { code, out, err } = await captureOutput(() => main(['ha', 'trigger-automation'], {}));
  expect(code).toBe(1);
  expect(err).toBe('');
  expect(JSON.parse(out).error).toStartWith('usage:ha_agent_lab ha trigger-automation: ');
});
