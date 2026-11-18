// Doctor's `connector` finding: reads only the socket the launcher named.
//
// Usage: bun test tests/doctor-connector.test.ts   (from the plugin root)

import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConnector } from '../scripts/doctor-check';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-connector-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function standIn(name: string, body: object) {
  const sock = path.join(dir, `${name}.sock`);
  const server = Bun.serve({ unix: sock, fetch: () => Response.json(body) });
  return { sock, stop: () => server.stop(true) };
}

test('unset: ok, not enabled', async () => {
  expect(await checkConnector(undefined, undefined)).toEqual({ id: 'connector', status: 'ok', detail: 'not enabled' });
});

test('set but nothing answers: warn', async () => {
  const r = await checkConnector(undefined, path.join(dir, 'missing.sock'));
  expect(r.status).toBe('warn');
  expect(r.detail).toContain('does not answer');
});

test('server answers without a connected channel: warn; with one: ok', async () => {
  const off = standIn('off', { ok: true, channel_connected: false, grants: 1 });
  const on = standIn('on', { ok: true, channel_connected: true, grants: 2 });
  try {
    expect(await checkConnector(undefined, off.sock)).toMatchObject({ status: 'warn', detail: expect.stringContaining('no channel is connected') });
    expect(await checkConnector(undefined, on.sock)).toEqual({ id: 'connector', status: 'ok', detail: 'server running, channel connected, 2 paired' });
  } finally { off.stop(); on.stop(); }
});
