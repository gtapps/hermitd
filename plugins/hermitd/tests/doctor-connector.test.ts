// Doctor's `connector` finding: reads only the socket the launcher named.
//
// Usage: bun test tests/doctor-connector.test.ts   (from the plugin root)

import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConnector, resolvePaths } from '../scripts/doctor-check';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-connector-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function standIn(name: string, body: object) {
  const sock = path.join(dir, `${name}.sock`);
  const server = Bun.serve({ unix: sock, fetch: () => Response.json(body) });
  return { sock, stop: () => server.stop(true) };
}

test('unset and no enabled store: ok, not enabled', async () => {
  const saved = process.env.HERMIT_CONNECTOR_SOCKET;
  delete process.env.HERMIT_CONNECTOR_SOCKET;
  try {
    const paths = resolvePaths(path.join(fs.mkdtempSync(path.join(dir, 'p-')), '.hermit'), dir);
    expect(await checkConnector(paths)).toEqual({ id: 'connector', status: 'ok', detail: 'not enabled' });
  } finally { if (saved !== undefined) process.env.HERMIT_CONNECTOR_SOCKET = saved; }
});

test('set but nothing answers: warn', async () => {
  const r = await checkConnector(undefined, path.join(dir, 'missing.sock'));
  expect(r.status).toBe('warn');
  expect(r.detail).toContain('does not answer');
});

test('server answers with an absent channel: warn about registration and restart', async () => {
  const off = standIn('off', { ok: true, channel: 'absent', grants: 1 });
  try {
    const result = await checkConnector(undefined, off.sock);
    expect(result.status).toBe('warn');
    for (const text of ['channel absent', 'plugin', 'marketplace', 'restarted']) expect(result.detail).toContain(text);
  } finally { off.stop(); }
});

test('polling stays healthy through 10 minutes, then warns about unanswered messages', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  const oldest_unanswered_at = new Date(sentAt).toISOString();
  const on = standIn('on', { ok: true, channel: 'polling', grants: 2, unanswered: 1, oldest_unanswered_at });
  try {
    for (const seconds of [599, 600]) {
      expect(await checkConnector(undefined, on.sock, () => sentAt + seconds * 1000)).toEqual({
        id: 'connector', status: 'ok', detail: 'server running, channel polling, 2 paired',
      });
    }
    const result = await checkConnector(undefined, on.sock, () => sentAt + 601_000);
    expect(result.status).toBe('warn');
    for (const text of ['1 unanswered', oldest_unanswered_at, 'allowedChannelPlugins', 'channelsEnabled', 'organization policy', 'stuck agent', 'startup notice']) {
      expect(result.detail).toContain(text);
    }
  } finally { on.stop(); }
});
