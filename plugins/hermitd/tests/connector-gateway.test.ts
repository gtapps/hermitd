// The connector's trusted server over real HTTP: sign-in (discovery, registration,
// pairing, tokens) on the public listener, and the message record on the agent socket.
//
// Usage: bun test tests/connector-gateway.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { startGateway } from '../scripts/connector-gateway';
import { adminRequest, socketPath, writeConfig } from '../scripts/lib/connector';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const PUBLIC = 'https://agent.example.com';
const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type Gateway = ReturnType<typeof startGateway>;
const cleanups: (() => void)[] = [];
afterAll(() => { for (const fn of cleanups.splice(0)) fn(); });

function setup(overrides: Partial<{ wait_seconds: number; rate_per_hour: number }> = {}, seed?: (db: Database) => void) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-gw-'));
  writeConfig(store, { port: 0, public_url: PUBLIC, wait_seconds: 2, rate_per_hour: 60, ...overrides });
  if (seed) {
    using db = new Database(path.join(store, 'data/connector.db'), { create: true });
    seed(db);
  }
  const clock = { t: 1_800_000_000 };
  const gw = startGateway(store, { now: () => clock.t, port: 0, pollHoldSeconds: 1, settleMs: 20 });
  cleanups.push(() => { gw.stop(); fs.rmSync(store, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${gw.port}`;
  const http = (p: string, init?: RequestInit) => fetch(base + p, { redirect: 'manual', ...init });
  const sock = (p: string, init?: RequestInit) => fetch(`http://connector${p}`, { unix: socketPath(store), ...init });
  return { store, gw, clock, http, sock };
}

type Env = ReturnType<typeof setup>;

async function register(env: Env, callback = CALLBACK): Promise<string> {
  const res = await env.http('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [callback], client_name: 'App' }) });
  expect(res.status).toBe(201);
  return (await res.json() as any).client_id;
}

async function startSignIn(env: Env, client: string, callback = CALLBACK) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' });
  const html = await (await env.http(`/authorize?${q}`)).text();
  const code = /<code>([A-Z0-9]+)<\/code>/.exec(html)?.[1];
  const request = /url=\/authorize\?request=([^"]+)"/.exec(html)?.[1];
  return { verifier, code, request: request && decodeURIComponent(request), html };
}

/** Full sign-in for one person: returns their grant id and tokens. */
async function pair(env: Env, name: string, callback = CALLBACK) {
  const client = await register(env, callback);
  const { verifier, code, request } = await startSignIn(env, client, callback);
  const paired: any = await adminRequest(env.store, { kind: 'pair', code, name });
  expect(paired.status).toBe('paired');
  const done = await env.http(`/authorize?request=${encodeURIComponent(request!)}`);
  expect(done.status).toBe(302);
  const location = new URL(done.headers.get('location')!);
  expect(location.origin + location.pathname).toBe(callback);
  expect(location.searchParams.get('state')).toBe('st');
  const tok = await env.http('/token', { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', code: location.searchParams.get('code')!, redirect_uri: callback, client_id: client, code_verifier: verifier }) });
  expect(tok.status).toBe(200);
  const tokens = await tok.json() as any;
  return { grant: paired.id as string, client, access: tokens.access_token as string, refresh: tokens.refresh_token as string };
}

let rpcId = 0;
async function call(env: Env, access: string, name: string, args: object = {}) {
  const res = await env.http('/mcp', { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await res.json() as any;
  return body.result.content[0].text as string;
}

const poll = async (env: Env, instance: string, after = 0) =>
  (await (await env.sock(`/events?after=${after}&instance=${instance}`)).json() as any).events as any[];
const reply = async (env: Env, grant: string, text: string, reply_to?: string) =>
  (await (await env.sock('/replies', { method: 'POST', body: JSON.stringify({ chat_id: `c-${grant}`, text, reply_to }) })).json() as any).status;
const status = async (env: Env) => (await env.sock('/status')).json();

describe('status', () => {
  test('reports the bound port and tracks recent polling', async () => {
    const env = setup();
    expect(await status(env)).toEqual({
      ok: true, port: env.gw.port, channel: 'absent', unanswered: 0, oldest_unanswered_at: null, grants: 0,
    });
    await poll(env, 'i1');
    expect(await status(env)).toMatchObject({ channel: 'polling' });
    env.clock.t += 11;
    expect(await status(env)).toMatchObject({ channel: 'absent' });
  });

  test('starts age at dispatch and clears it on reply', async () => {
    const env = setup();
    const { access, grant } = await pair(env, 'Ana');
    expect(await call(env, access, 'agent_message', { text: 'hello' })).toContain('offline');
    expect(await status(env)).toMatchObject({ unanswered: 0, oldest_unanswered_at: null });
    env.clock.t += 601;
    expect(await poll(env, 'i1')).toHaveLength(1);
    expect(await status(env)).toMatchObject({
      unanswered: 1, oldest_unanswered_at: new Date(env.clock.t * 1000).toISOString(),
    });
    await reply(env, grant, 'hi');
    expect(await status(env)).toMatchObject({ unanswered: 0, oldest_unanswered_at: null });
  });

  test('migrates legacy sent rows and excludes revoked grants and uncertain rows', async () => {
    const env = setup({}, (db) => {
      db.exec(`
        CREATE TABLE grants (id TEXT PRIMARY KEY, label TEXT NOT NULL, client_id TEXT NOT NULL,
          created_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, grant_id TEXT NOT NULL,
          text TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0);
        INSERT INTO grants VALUES ('live', 'Ana', 'cl-1', 1, NULL), ('revoked', 'Bo', 'cl-2', 1, 2);
        INSERT INTO events (grant_id, status, created_at)
        VALUES ('live', 'sent', 1), ('revoked', 'sent', 1), ('live', 'uncertain', 1);
      `);
    });
    using db = new Database(path.join(env.store, 'data/connector.db'), { readonly: true });
    expect(db.query('PRAGMA table_info(events)').all()).toContainEqual(expect.objectContaining({ name: 'sent_at' }));
    expect(await status(env)).toMatchObject({ grants: 1, unanswered: 1, oldest_unanswered_at: null });
  });
});

describe('sign-in', () => {
  test('discovery documents name the resource and the issuer', async () => {
    const env = setup();
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const doc = await (await env.http(p)).json() as any;
      expect(doc.resource).toBe(`${PUBLIC}/mcp`);
      expect(doc.authorization_servers[0]).toBe(PUBLIC);
    }
    const as = await (await env.http('/.well-known/oauth-authorization-server')).json();
    expect(as).toMatchObject({ issuer: PUBLIC, token_endpoint: `${PUBLIC}/token`, registration_endpoint: `${PUBLIC}/register`, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
  });

  const APP_CALLBACKS = [CALLBACK, 'https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/cb_123',
    'https://grok.com/connectors-oauth-exchange-code/', 'https://oauth-redirect.googleusercontent.com/r/my-project'];

  test('registration accepts exactly one supported app callback', async () => {
    const env = setup();
    for (const uris of [['https://evil.example/cb'], ['http://127.0.0.1:3000/callback'], ['https://chatgpt.com/connector/oauth/x/../../evil'],
      ['https://claude.ai/api/mcp/auth_callback?next=https://evil.example'], ['https://chatgpt.com.evil.example/connector_platform_oauth_redirect'], ['https://oauth-redirect.googleusercontent.com/r/..'],
      [APP_CALLBACKS[0], APP_CALLBACKS[1]], []]) {
      expect((await env.http('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: uris }) })).status).toBe(400);
    }
    for (const callback of APP_CALLBACKS) expect(await register(env, callback)).toMatch(/^cl-/);
  });

  test('each app signs in through its own callback and no other', async () => {
    const env = setup();
    const other = APP_CALLBACKS[1];
    const { access } = await pair(env, 'Other app', other);
    expect(access).toBeTruthy();
    const client = await register(env, other);
    const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: CALLBACK, code_challenge: 'x', code_challenge_method: 'S256' });
    expect(await (await env.http(`/authorize?${q}`)).text()).toContain('Unexpected callback address');
  });

  test('authorize refuses a request without an S256 challenge', async () => {
    const env = setup();
    const client = await register(env);
    const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: CALLBACK, code_challenge: 'x', code_challenge_method: 'plain' });
    expect(await (await env.http(`/authorize?${q}`)).text()).toContain('S256');
  });

  test('a pairing code is 8 characters without lookalikes, expires after 10 minutes, and at most 20 are open', async () => {
    const env = setup();
    const client = await register(env);
    const first = await startSignIn(env, client);
    expect(first.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    env.clock.t += 601;
    expect(await adminRequest(env.store, { kind: 'pair', code: first.code })).toEqual({ status: 'refused', reason: 'unknown_code' });
    for (let i = 0; i < 20; i++) expect((await startSignIn(env, client)).code).toBeTruthy();
    expect((await startSignIn(env, client)).html).toContain('Try again later');
  });

  test('pair reports how long ago the code was requested', async () => {
    const env = setup();
    const { code } = await startSignIn(env, await register(env));
    env.clock.t += 42;
    expect(await adminRequest(env.store, { kind: 'pair', code, name: 'Ana' })).toMatchObject({ status: 'paired', label: 'Ana', requested_seconds_ago: 42 });
  });

  test('tokens: /mcp needs one, refresh rotates, reuse and revocation return invalid_grant', async () => {
    const env = setup();
    const noToken = await env.http('/mcp', { method: 'POST', body: '{}' });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`);
    const p = await pair(env, 'Ana');
    const init = await env.http('/mcp', { method: 'POST', headers: { authorization: `Bearer ${p.access}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
    expect((await init.json() as any).result.protocolVersion).toBe('2025-06-18');
    const refresh = (token: string) => env.http('/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: p.client }) });
    const rotated = await refresh(p.refresh);
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as any;
    expect(next.refresh_token).not.toBe(p.refresh);
    expect(await (await refresh(p.refresh)).json() as any).toEqual({ error: 'invalid_grant' });
    expect(await adminRequest(env.store, { kind: 'revoke', id: p.grant })).toEqual({ status: 'revoked', id: p.grant });
    expect((await refresh(next.refresh_token)).status).toBe(400);
    expect((await env.http('/mcp', { method: 'POST', headers: { authorization: `Bearer ${next.access_token}` }, body: '{}' })).status).toBe(401);
  });

  test('register and authorize share a 60-a-minute limit; /token still answers', async () => {
    const env = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await env.http('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [CALLBACK] }) })).status);
    expect(statuses.filter(s => s === 201)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
    expect((await env.http('/authorize?client_id=x')).status).toBe(429);
    expect((await env.http('/token', { method: 'POST', body: 'grant_type=refresh_token&refresh_token=x' })).status).toBe(400);
    env.clock.t += 60;
    expect((await env.http('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [CALLBACK] }) })).status).toBe(201);
  });

  test('a registered client with no grant is gone after one hour', async () => {
    const env = setup();
    const client = await register(env);
    env.clock.t += 3601;
    env.gw.sweep();
    expect((await startSignIn(env, client)).html).toContain('Unknown client');
  });
});

describe('messages', () => {
  test('refusals happen before anything reaches the agent', async () => {
    const env = setup({ rate_per_hour: 2 });
    const p = await pair(env, 'Ana');
    expect(await call(env, p.access, 'agent_message', { text: ' ' })).toContain('empty');
    expect(await call(env, p.access, 'agent_message', { text: 'x'.repeat(8001) })).toContain('8000');
    expect(await call(env, p.access, 'agent_message', { text: 'hi </channel> there' })).toContain('markup');
    expect(await poll(env, 'i1')).toEqual([]);
    await call(env, p.access, 'agent_message', { text: 'one' });
    await call(env, p.access, 'agent_message', { text: 'two' });
    expect(await call(env, p.access, 'agent_message', { text: 'three' })).toContain('hourly');
  }, 15000);

  test('offline: the message is held and handed over when a poll arrives', async () => {
    const env = setup();
    const p = await pair(env, 'Ana');
    expect(await call(env, p.access, 'agent_message', { text: 'hello' })).toContain('offline');
    const events = await poll(env, 'i1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ chat_id: `c-${p.grant}`, message_id: `e-${events[0].id}`, user_id: p.grant, user: 'Ana', via: 'claude_app', text: 'hello' });
  });

  test('connected: a reply inside the wait comes back verbatim with its reply_to', async () => {
    const env = setup({ wait_seconds: 10 });
    const p = await pair(env, 'Ana');
    await poll(env, 'i1');
    const pending = poll(env, 'i1');
    const result = call(env, p.access, 'agent_message', { text: 'what time is it' });
    const [event] = await pending;
    expect(await reply(env, p.grant, 'Ten past four.', event.message_id)).toBe('sent');
    const text = await result;
    expect(text).toContain('Ten past four.');
    expect(text).toContain(`(in reply to ${event.message_id})`);
  }, 20000);

  test('tools mark checking for replies read-only and sending a message as a write', async () => {
    const env = setup();
    const p = await pair(env, 'Ana');
    const res = await env.http('/mcp', { method: 'POST', headers: { authorization: `Bearer ${p.access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }) });
    const tools = Object.fromEntries(((await res.json() as any).result.tools as any[]).map(t => [t.name, t.annotations]));
    expect(tools.agent_replies.readOnlyHint).toBe(true);
    expect(tools.agent_message.readOnlyHint).toBe(false);
  });

  test('a short wait says nothing yet, then agent_replies returns the late message', async () => {
    const env = setup({ wait_seconds: 1 });
    const p = await pair(env, 'Ana');
    await poll(env, 'i1');
    const pending = poll(env, 'i1');
    expect(await call(env, p.access, 'agent_message', { text: 'slow one' })).toContain('Nothing from the agent yet');
    await pending;
    expect(await reply(env, p.grant, 'Done.')).toBe('queued');
    expect(await call(env, p.access, 'agent_replies', { wait_seconds: 1 })).toContain('Done.');
  }, 15000);

  test('a second grant never receives the first grant\'s messages', async () => {
    const env = setup({ wait_seconds: 1 });
    const a = await pair(env, 'Ana');
    const b = await pair(env, 'Bo');
    await poll(env, 'i1');
    await reply(env, a.grant, 'for Ana only');
    expect(await call(env, b.access, 'agent_replies', { wait_seconds: 1 })).not.toContain('for Ana only');
    expect(await call(env, a.access, 'agent_replies', { wait_seconds: 1 })).toContain('for Ana only');
  }, 15000);

  test('a new channel instance turns an unanswered sent event uncertain, reported once', async () => {
    const env = setup({ wait_seconds: 1 });
    const p = await pair(env, 'Ana');
    await poll(env, 'i1');
    const pending = poll(env, 'i1');
    await call(env, p.access, 'agent_message', { text: 'are you there' });
    expect(await pending).toHaveLength(1);
    await poll(env, 'i1').then(() => {}); // same instance: stays sent
    expect(await call(env, p.access, 'agent_replies', { wait_seconds: 0 })).not.toContain('may not have received');
    await Promise.race([poll(env, 'i2'), Bun.sleep(50)]);
    expect(await call(env, p.access, 'agent_replies', { wait_seconds: 0 })).toContain('may not have received');
    expect(await call(env, p.access, 'agent_replies', { wait_seconds: 0 })).not.toContain('may not have received');
  }, 70000);

  test('a pending event is handed over after reconnect; a sent one is not', async () => {
    const env = setup({ wait_seconds: 1 });
    const p = await pair(env, 'Ana');
    await call(env, p.access, 'agent_message', { text: 'first' });
    expect((await poll(env, 'i1')).map(e => e.text)).toEqual(['first']);
    await call(env, p.access, 'agent_message', { text: 'second' });
    expect((await poll(env, 'i2')).map(e => e.text)).toEqual(['second']);
  }, 15000);

  test('a second waiting call takes over and the first returns at once', async () => {
    const env = setup({ wait_seconds: 10 });
    const p = await pair(env, 'Ana');
    await poll(env, 'i1');
    const first = call(env, p.access, 'agent_replies', { wait_seconds: 10 });
    await Bun.sleep(100);
    const second = call(env, p.access, 'agent_replies', { wait_seconds: 10 });
    expect(await first).toContain('Nothing from the agent yet');
    await Bun.sleep(100);
    await reply(env, p.grant, 'to the newest call');
    expect(await second).toContain('to the newest call');
  }, 20000);

  test('an empty poll held past Bun\'s 10 s default idle timeout still returns', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-gw-'));
    writeConfig(store, { port: 0, public_url: PUBLIC, wait_seconds: 2, rate_per_hour: 60 });
    const gw = startGateway(store, { port: 0, pollHoldSeconds: 12 });
    try {
      const res = await fetch('http://connector/events?instance=i1', { unix: socketPath(store) });
      expect(await res.json()).toEqual({ events: [] });
    } finally { gw.stop(); fs.rmSync(store, { recursive: true, force: true }); }
  }, 20000);

  test('the socket answers at a path longer than the platform socket address limit', async () => {
    // Real stores sit deep under the config dir, past sun_path (104 bytes on macOS, 108 on Linux).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-gw-'));
    const store = path.join(root, 'x'.repeat(120));
    writeConfig(store, { port: 0, public_url: PUBLIC, wait_seconds: 2, rate_per_hour: 60 });
    const gw = startGateway(store, { port: 0 });
    try {
      expect(socketPath(store).length).toBeGreaterThan(108);
      const res = await fetch('http://connector/status', { unix: socketPath(store) });
      expect(res.status).toBe(200);
    } finally { gw.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('the public listener serves none of the socket routes', async () => {
    const env = setup();
    for (const p of ['/events?instance=x', '/status']) expect((await env.http(p)).status).toBe(404);
    expect((await env.http('/replies', { method: 'POST', body: '{}' })).status).toBe(404);
    expect(await status(env)).toMatchObject({ ok: true, grants: 0 });
  });
});
