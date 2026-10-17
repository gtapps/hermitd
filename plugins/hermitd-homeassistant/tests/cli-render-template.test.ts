// Tests for 'ha render-template' and 'ha check-config' — thin REST wrappers.
// render-template exercises postText() (HA returns plain text, not JSON).

import { afterAll, expect, test } from 'bun:test';

import { main } from '../src/cli';
import { HomeAssistantError } from '../src/ha-api';
import { cleanupTmp, captureOutput, fakeClient, makeMockConfig, tmpPath, writeArtifact, type FakeClient } from './helpers';

afterAll(cleanupTmp);

function runCli(argv: string[], client: FakeClient) {
  const cfg = makeMockConfig();
  return captureOutput(() =>
    main(argv, { loadConfig: () => cfg, createClient: async () => client }),
  );
}

test('render-template reads a file and posts its contents', async () => {
  const path = writeArtifact(tmpPath(), '{{ 1 + 1 }}', 'template.jinja');
  const client = fakeClient({ postText: () => '2' });

  const { code, out } = await runCli(['ha', 'render-template', path], client);

  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ rendered: '2' });
  expect(client.calls.post).toEqual([['/api/template', { template: '{{ 1 + 1 }}' }]]);
});

test('render-template reports a missing file cleanly (no uncaught throw)', async () => {
  const client = fakeClient();
  const { code, out } = await runCli(['ha', 'render-template', '/no/such/template.jinja'], client);
  expect(code).toBe(1);
  expect(JSON.parse(out)).toEqual({ error: 'template_not_found:/no/such/template.jinja' });
  expect(client.calls.post.length).toBe(0);
});

test('render-template surfaces HA error', async () => {
  const path = writeArtifact(tmpPath(), '{{ bad', 'template.jinja');
  const client = fakeClient({
    postText: () => {
      throw new HomeAssistantError('Error rendering template: bad syntax', 400);
    },
  });

  const { code, out } = await runCli(['ha', 'render-template', path], client);

  expect(code).toBe(1);
  expect(JSON.parse(out).error).toStartWith('ha_http_400:Error rendering template');
});

test('check-config reports valid', async () => {
  const client = fakeClient({ post: () => ({ result: 'valid', errors: null, warnings: null }) });

  const { code, out } = await runCli(['ha', 'check-config'], client);

  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ result: 'valid', errors: null, warnings: null });
});

test('check-config reports invalid as an answer, exit 0', async () => {
  const client = fakeClient({
    post: () => ({ result: 'invalid', errors: 'some error', warnings: null }),
  });

  const { code, out } = await runCli(['ha', 'check-config'], client);

  expect(code).toBe(0);
  expect(JSON.parse(out).result).toBe('invalid');
});
