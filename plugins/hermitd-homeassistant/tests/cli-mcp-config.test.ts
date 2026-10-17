// `boot mcp-config` writes the homeassistant MCP entry into .mcp.json from
// config so hatch never holds the token. Its stdout must never carry the token.

import { afterAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '../src/cli';
import { AppConfig } from '../src/config';
import { captureOutput, cleanupTmp, tmpPath } from './helpers';

afterAll(cleanupTmp);

const TOKEN = 'secret-ha-token-value';
const URL = 'http://ha.local:8123';

function config(root: string, url: string | null = URL, token: string | null = TOKEN): AppConfig {
  return new AppConfig(root, url, null, null, token, 5, 0);
}

async function run(cfg: AppConfig) {
  const result = await captureOutput(() => main(['boot', 'mcp-config'], { loadConfig: () => cfg }));
  expect(result.out).not.toContain(TOKEN);
  expect(result.err).not.toContain(TOKEN);
  return { ...result, json: JSON.parse(result.out) };
}

const readMcp = (root: string) => JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));

test('absent .mcp.json: adds the entry with literal values', async () => {
  const root = tmpPath();
  const { code, json } = await run(config(root, `${URL}/`));
  expect(code).toBe(0);
  expect(json).toEqual({ server: 'homeassistant', action: 'added' });
  expect(readMcp(root).mcpServers.homeassistant).toEqual({
    type: 'http',
    url: `${URL}/api/mcp`,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
});

test('placeholder entry: replaced, other servers kept', async () => {
  const root = tmpPath();
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        other: { command: 'x' },
        homeassistant: { type: 'http', url: '${HOMEASSISTANT_URL}/api/mcp', headers: { Authorization: 'Bearer x' } },
      },
    }),
  );
  const { code, json } = await run(config(root));
  expect(code).toBe(0);
  expect(json.action).toBe('replaced');
  const doc = readMcp(root);
  expect(doc.mcpServers.other).toEqual({ command: 'x' });
  expect(doc.mcpServers.homeassistant.headers.Authorization).toBe(`Bearer ${TOKEN}`);
});

test('literal entry matching config: skipped and left untouched', async () => {
  const root = tmpPath();
  const original = JSON.stringify({
    mcpServers: { homeassistant: { type: 'http', url: `${URL}/api/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } } },
  });
  writeFileSync(join(root, '.mcp.json'), original);
  const { code, json } = await run(config(root));
  expect(code).toBe(0);
  expect(json.action).toBe('skipped');
  expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(original);
});

test('literal entry with a stale token: only url and token refreshed', async () => {
  const root = tmpPath();
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        homeassistant: { type: 'http', url: 'http://old/api/mcp', headers: { Authorization: 'Bearer old', 'X-Extra': 'keep' }, timeout: 5 },
      },
    }),
  );
  const { code, json } = await run(config(root));
  expect(code).toBe(0);
  expect(json.action).toBe('updated');
  expect(readMcp(root).mcpServers.homeassistant).toEqual({
    type: 'http',
    url: `${URL}/api/mcp`,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Extra': 'keep' },
    timeout: 5,
  });
});

test('missing token: exit 0 with missing_keys, names the key, writes nothing', async () => {
  const root = tmpPath();
  const { code, json } = await run(config(root, URL, null));
  expect(code).toBe(0);
  expect(json).toEqual({ status: 'missing_keys', missing: ['HOMEASSISTANT_TOKEN'] });
  expect(existsSync(join(root, '.mcp.json'))).toBe(false);
});

test('invalid .mcp.json: exit 1, file left as is', async () => {
  const root = tmpPath();
  writeFileSync(join(root, '.mcp.json'), '{ not json');
  const { code, json } = await run(config(root));
  expect(code).toBe(1);
  expect(json).toEqual({ error: 'invalid_mcp_json' });
  expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe('{ not json');
});

test('non-object .mcp.json or mcpServers: exit 1, file left as is', async () => {
  for (const body of ['null', '[]', '{"mcpServers": []}']) {
    const root = tmpPath();
    writeFileSync(join(root, '.mcp.json'), body);
    const { code, json } = await run(config(root));
    expect(code).toBe(1);
    expect(json).toEqual({ error: 'invalid_mcp_json' });
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(body);
  }
});
