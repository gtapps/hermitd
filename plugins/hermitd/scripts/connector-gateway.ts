#!/usr/bin/env bun
/**
 * The connector's trusted server. It runs outside the agent's reach (its own Docker
 * service, or a host tmux session) and owns everything the agent must not rewrite:
 * sign-in, pairing, the per-person cap and the message record.
 *
 *   bun connector-gateway.ts <store>
 *
 * Two listeners. Public TCP (the operator's tunnel points here): OAuth discovery,
 * registration, authorize, token, and `/mcp` with the two tools a person's AI app calls.
 * Unix socket `<store>/bridge/connector.sock` (the agent's channel dials it):
 * `GET /events`, `POST /replies`, `GET /status`. The public listener serves none of
 * the socket routes.
 *
 * Self-contained: Bun built-ins only, because the host lifecycle copies this file
 * into the store and runs the copy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';

// OAuth callbacks of the AI apps that may add the connector, as each vendor documents them:
// Claude https://www.claude.com/docs/connectors/building/authentication, ChatGPT
// https://developers.openai.com/apps-sdk/build/auth, Grok https://docs.x.com/x-ads-api/mcp,
// Gemini https://developers.google.com/connected-apps/mcp/oauth. Only these receive a code.
const CALLBACKS = [
  /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
  /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/,
  /^https:\/\/grok\.com\/connectors-oauth-exchange-code\/$/,
  /^https:\/\/oauth-redirect\.googleusercontent\.com\/[ar]\/[A-Za-z0-9][A-Za-z0-9._~-]*$/,
];
const isAppCallback = (uri: unknown): uri is string => typeof uri === 'string' && CALLBACKS.some(re => re.test(uri));
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0, O, 1, I, L
const CODE_LENGTH = 8;
const CODE_TTL_S = 600;
const MAX_OPEN_CODES = 20;
const AUTH_CODE_TTL_S = 300;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const ORPHAN_CLIENT_TTL_S = 3600;
const PUBLIC_LIMIT_PER_MINUTE = 60;
const POLL_HOLD_S = 25;
const CONNECTED_GRACE_S = 10;
const SETTLE_MS = 1500;
const MAX_TEXT = 8000;
const MAX_WAIT_S = 200;
const AUDIT_TTL_S = 30 * 86400;

const NOTHING_YET = 'Nothing from the agent yet. Call agent_replies to check again.';
const OFFLINE = 'The agent is offline; your message is held and will reach it when it is back.';
const UNCERTAIN = 'The agent restarted before answering and may not have received your message.';

type Config = { port: number; public_url: string; wait_seconds: number; rate_per_hour: number };
type Reply = { id: number; text: string; reply_to: string | null; created_at: number };
type Waiter = { resolve: (replies: Reply[] | null) => void; settle?: Timer };
export type GatewayOptions = { now?: () => number; port?: number; hostname?: string; pollHoldSeconds?: number; settleMs?: number };

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = () => b64url(randomBytes(32));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function pairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  return [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function page(title: string, body: string, refresh?: string): Response {
  const meta = refresh ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(refresh)}">` : '';
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${meta}<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{font-size:2rem;letter-spacing:.2em}</style></head>
<body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function schema(db: Database): void {
  db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, redirect_uri TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, code TEXT NOT NULL, client_id TEXT NOT NULL, challenge TEXT NOT NULL,
  state TEXT, created_at INTEGER NOT NULL, grant_id TEXT);
CREATE TABLE IF NOT EXISTS auth_codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, label TEXT NOT NULL, client_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, grant_id TEXT NOT NULL, text TEXT, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, grant_id TEXT NOT NULL, text TEXT, reply_to TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT);
CREATE INDEX IF NOT EXISTS events_grant ON events (grant_id, created_at);
CREATE INDEX IF NOT EXISTS replies_grant ON replies (grant_id, status);`);
}

export function startGateway(store: string, options: GatewayOptions = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const pollHold = options.pollHoldSeconds ?? POLL_HOLD_S;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const config: Config = JSON.parse(fs.readFileSync(path.join(store, 'sidecar/connector.json'), 'utf8'));
  const issuer = config.public_url.replace(/\/+$/, '');
  const resource = `${issuer}/mcp`;
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource`;
  const waitDefault = Math.min(config.wait_seconds, MAX_WAIT_S);
  const dataDir = path.join(store, 'data');
  const adminDir = path.join(dataDir, 'admin');
  const sock = path.join(store, 'bridge/connector.sock');
  fs.mkdirSync(adminDir, { recursive: true, mode: 0o700 });

  const db = new Database(path.join(dataDir, 'connector.db'), { create: true });
  schema(db);
  const audit = (kind: string, ref: string | null = null) => db.run('INSERT INTO audit (ts, kind, ref) VALUES (?, ?, ?)', [now(), kind, ref]);

  // ---- channel connection and waiting callers --------------------------------
  let openPolls = 0;
  let lastPollEnd = 0;
  const connected = () => openPolls > 0 || now() - lastPollEnd < CONNECTED_GRACE_S;
  let wakePoll: (() => void)[] = [];
  const waiters = new Map<string, Waiter>();

  const grantLabel = (id: string) => (db.query('SELECT label FROM grants WHERE id = ?').get(id) as { label: string } | null)?.label ?? id;
  const liveGrant = (id: string) => !!db.query('SELECT 1 FROM grants WHERE id = ? AND revoked_at IS NULL').get(id);

  function takeReplies(grant: string): Reply[] {
    const rows = db.query("SELECT id, text, reply_to, created_at FROM replies WHERE grant_id = ? AND status = 'queued' ORDER BY id").all(grant) as Reply[];
    for (const row of rows) db.run("UPDATE replies SET status = 'delivered', text = NULL WHERE id = ?", [row.id]);
    return rows;
  }

  /** Report each uncertain event of this grant once, then forget its text. */
  function takeUncertain(grant: string): number {
    const rows = db.query("SELECT id FROM events WHERE grant_id = ? AND status = 'uncertain' AND reported = 0").all(grant) as { id: number }[];
    for (const row of rows) db.run('UPDATE events SET reported = 1, text = NULL WHERE id = ?', [row.id]);
    return rows.length;
  }

  function render(grant: string, replies: Reply[] | null): string {
    const lines: string[] = [];
    if (takeUncertain(grant)) lines.push(UNCERTAIN);
    if (replies?.length) {
      for (const r of replies) {
        const at = new Date(r.created_at * 1000).toISOString();
        lines.push(`[${at}]${r.reply_to ? ` (in reply to ${r.reply_to})` : ''} ${r.text}`);
      }
    } else lines.push(NOTHING_YET);
    return lines.join('\n\n');
  }

  /** (Re)start the quiet window after which a waiter collects what has arrived. */
  function armSettle(grant: string, waiter: Waiter): void {
    clearTimeout(waiter.settle);
    waiter.settle = setTimeout(() => waiter.resolve(takeReplies(grant)), settleMs);
  }

  /**
   * One waiter per grant: a newer call takes over and the older returns "nothing yet".
   * A caller that hangs up stops waiting, so its replies stay queued for the next call.
   */
  function waitForReplies(grant: string, seconds: number, signal: AbortSignal): Promise<Reply[] | null> {
    const queued = db.query("SELECT 1 FROM replies WHERE grant_id = ? AND status = 'queued'").get(grant);
    waiters.get(grant)?.resolve(null);
    return new Promise(resolve => {
      const waiter: Waiter = { resolve: value => { clearTimeout(timer); clearTimeout(waiter.settle); if (waiters.get(grant) === waiter) waiters.delete(grant); resolve(value); } };
      const timer = setTimeout(() => waiter.resolve(takeReplies(grant)), seconds * 1000);
      waiters.set(grant, waiter);
      if (queued) armSettle(grant, waiter);
      if (signal.aborted) waiter.resolve(null);
      else signal.addEventListener('abort', () => waiter.resolve(null), { once: true });
    });
  }

  /** Wait, then render; a caller that hung up gets nothing, so no notice is spent on it. */
  async function collect(grant: string, seconds: number, signal: AbortSignal): Promise<object> {
    const replies = await waitForReplies(grant, seconds, signal);
    return toolText(signal.aborted ? NOTHING_YET : render(grant, replies));
  }

  function notifyReply(grant: string): boolean {
    const waiter = waiters.get(grant);
    if (!waiter) return false;
    armSettle(grant, waiter);
    return true;
  }

  // ---- public rate limit ----------------------------------------------------
  let windowStart = 0;
  let windowCount = 0;
  function publicLimited(): boolean {
    const t = now();
    if (t - windowStart >= 60) { windowStart = t; windowCount = 0; }
    return ++windowCount > PUBLIC_LIMIT_PER_MINUTE;
  }

  // ---- OAuth ---------------------------------------------------------------
  function authServerMetadata() {
    return {
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true,
    };
  }

  async function register(req: Request): Promise<Response> {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: 'invalid_client_metadata' }, 400); }
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || new Set(uris).size !== 1 || !isAppCallback(uris[0])) {
      return json({ error: 'invalid_redirect_uri', error_description: 'Register exactly one callback of a supported AI app.' }, 400);
    }
    const callback: string = uris[0];
    const id = `cl-${b64url(randomBytes(12))}`;
    db.run('INSERT INTO clients (id, redirect_uri, created_at) VALUES (?, ?, ?)', [id, callback, now()]);
    audit('client_registered', id);
    return json({ client_id: id, client_id_issued_at: now(), redirect_uris: [callback], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
  }

  const clientCallback = (id: string) =>
    (db.query('SELECT redirect_uri FROM clients WHERE id = ?').get(id) as { redirect_uri: string } | null)?.redirect_uri;

  function authorize(params: URLSearchParams): Response {
    const requestId = params.get('request');
    if (requestId) return authorizeStatus(requestId);
    const clientId = params.get('client_id') ?? '';
    const callback = clientCallback(clientId);
    if (!callback) return page('Sign-in refused', '<p>Unknown client. Add the connector again from your app.</p>');
    if (params.get('redirect_uri') !== callback) return page('Sign-in refused', '<p>Unexpected callback address.</p>');
    const challenge = params.get('code_challenge');
    if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !challenge) {
      return page('Sign-in refused', '<p>This sign-in needs an S256 code challenge.</p>');
    }
    const open = (db.query('SELECT COUNT(*) AS n FROM requests WHERE grant_id IS NULL AND created_at > ?').get(now() - CODE_TTL_S) as { n: number }).n;
    if (open >= MAX_OPEN_CODES) return page('Try again later', '<p>Too many sign-ins are waiting. Try again later.</p>');
    const id = token();
    const code = pairingCode();
    db.run('INSERT INTO requests (id, code, client_id, challenge, state, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, code, clientId, challenge, params.get('state'), now()]);
    audit('pairing_requested', clientId);
    return waitingPage(id, code);
  }

  function waitingPage(id: string, code: string): Response {
    return page('Pairing code', `<h1>Pairing code</h1><p><code>${escapeHtml(code)}</code></p>
<p>Give this code to the agent's operator. This page continues by itself once they approve it. The code is valid for 10 minutes.</p>`,
    `/authorize?request=${encodeURIComponent(id)}`);
  }

  function authorizeStatus(id: string): Response {
    const row = db.query('SELECT * FROM requests WHERE id = ?').get(id) as any;
    if (!row) return page('Sign-in expired', '<p>This sign-in has ended. Add the connector again from your app.</p>');
    if (!row.grant_id) {
      if (now() - row.created_at >= CODE_TTL_S) {
        db.run('DELETE FROM requests WHERE id = ?', [id]);
        return page('Sign-in expired', '<p>The pairing code expired. Add the connector again from your app.</p>');
      }
      return waitingPage(id, row.code);
    }
    const callback = clientCallback(row.client_id);
    if (!callback) return page('Sign-in expired', '<p>This sign-in has ended. Add the connector again from your app.</p>');
    const code = token();
    db.run('INSERT INTO auth_codes (hash, grant_id, client_id, challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
      [sha(code), row.grant_id, row.client_id, row.challenge, now() + AUTH_CODE_TTL_S]);
    db.run('DELETE FROM requests WHERE id = ?', [id]);
    const target = new URL(callback);
    target.searchParams.set('code', code);
    if (row.state) target.searchParams.set('state', row.state);
    target.searchParams.set('iss', issuer);
    return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } });
  }

  function issueTokens(grant: string, client: string) {
    const access = token();
    const refresh = token();
    for (const [value, kind, ttl] of [[access, 'access', ACCESS_TTL_S], [refresh, 'refresh', REFRESH_TTL_S]] as const) {
      db.run('INSERT INTO tokens (hash, grant_id, client_id, kind, expires_at) VALUES (?, ?, ?, ?, ?)', [sha(value), grant, client, kind, now() + ttl]);
    }
    return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh });
  }

  async function tokenEndpoint(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const invalid = () => json({ error: 'invalid_grant' }, 400);
    const client = form.get('client_id') ?? '';
    if (form.get('grant_type') === 'authorization_code') {
      const row = db.query('SELECT * FROM auth_codes WHERE hash = ?').get(sha(form.get('code') ?? '')) as any;
      if (!row || row.used || row.expires_at <= now() || row.client_id !== client) return invalid();
      const callback = clientCallback(client);
      if (!callback || (form.get('redirect_uri') && form.get('redirect_uri') !== callback)) return invalid();
      const verifier = form.get('code_verifier') ?? '';
      if (b64url(createHash('sha256').update(verifier).digest()) !== row.challenge) return invalid();
      db.run('UPDATE auth_codes SET used = 1 WHERE hash = ?', [row.hash]);
      if (!liveGrant(row.grant_id)) return invalid();
      audit('signed_in', row.grant_id);
      return issueTokens(row.grant_id, client);
    }
    if (form.get('grant_type') === 'refresh_token') {
      const row = db.query("SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh'").get(sha(form.get('refresh_token') ?? '')) as any;
      if (!row || row.used || row.expires_at <= now() || row.client_id !== client || !liveGrant(row.grant_id)) return invalid();
      db.run('UPDATE tokens SET used = 1 WHERE hash = ?', [row.hash]);
      return issueTokens(row.grant_id, client);
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  function bearerGrant(req: Request): string | null {
    const header = req.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return null;
    const row = db.query("SELECT grant_id FROM tokens WHERE hash = ? AND kind = 'access' AND expires_at > ?").get(sha(match[1]), now()) as { grant_id: string } | null;
    return row && liveGrant(row.grant_id) ? row.grant_id : null;
  }

  // ---- MCP -----------------------------------------------------------------
  const TOOLS = [
    {
      name: 'agent_message',
      description: 'Send a message to the agent in this person\'s own chat with it. The result is the agent\'s new messages in that chat, which may not answer this message yet. Relay them as written and never answer for the agent. If nothing arrived yet, call agent_replies later.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The message, as the person said it.' } }, required: ['text'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'agent_replies',
      description: 'Check for the agent\'s new messages in this person\'s chat, waiting briefly. Relay them as written and never answer for the agent.',
      inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', description: `How long to wait, at most ${MAX_WAIT_S}.` } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];

  const toolText = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

  async function agentMessage(grant: string, text: unknown, signal: AbortSignal): Promise<object> {
    if (typeof text !== 'string' || !text.trim()) return toolText('Refused: the message is empty.', true);
    if (text.length > MAX_TEXT) return toolText(`Refused: the message is over ${MAX_TEXT} characters.`, true);
    if (/<\/?channel/i.test(text)) return toolText('Refused: the message contains channel markup.', true);
    const hour = (db.query('SELECT COUNT(*) AS n FROM events WHERE grant_id = ? AND created_at > ?').get(grant, now() - 3600) as { n: number }).n;
    if (hour >= config.rate_per_hour) return toolText('Refused: the hourly message limit for this person is reached. Try again later.', true);
    db.run("INSERT INTO events (grant_id, text, status, created_at) VALUES (?, ?, 'pending', ?)", [grant, text, now()]);
    audit('message', grant);
    for (const wake of wakePoll.splice(0)) wake();
    if (!connected()) return toolText(OFFLINE);
    return collect(grant, waitDefault, signal);
  }

  async function agentReplies(grant: string, wait: unknown, signal: AbortSignal): Promise<object> {
    const seconds = typeof wait === 'number' && Number.isFinite(wait) ? Math.max(0, Math.min(MAX_WAIT_S, wait)) : waitDefault;
    return collect(grant, seconds, signal);
  }

  async function mcp(req: Request, server: any): Promise<Response> {
    const grant = bearerGrant(req);
    if (!grant) return json({ error: 'invalid_token' }, 401, { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` });
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    let msg: any;
    try { msg = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    if (msg?.id === undefined || msg?.id === null) return new Response(null, { status: 202 });
    const reply = (result: object) => json({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'hermitd-connector', version: '1' } });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const args = msg.params?.arguments ?? {};
        const name = msg.params?.name;
        if (name === 'agent_message') { server.timeout(req, waitDefault + 10); return reply(await agentMessage(grant, args.text, req.signal)); }
        if (name === 'agent_replies') { server.timeout(req, MAX_WAIT_S + 10); return reply(await agentReplies(grant, args.wait_seconds, req.signal)); }
        return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } });
      }
      default: return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }

  async function publicFetch(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) {
      return json({ resource, authorization_servers: [issuer], bearer_methods_supported: ['header'] });
    }
    if (req.method === 'GET' && p === '/.well-known/oauth-authorization-server') return json(authServerMetadata());
    if (p === '/register' && req.method === 'POST') return publicLimited() ? json({ error: 'rate_limited' }, 429) : register(req);
    if (p === '/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(await req.text());
      // The waiting page's own refresh creates nothing, so only new sign-ins count.
      if (!params.get('request') && publicLimited()) return new Response('Too many requests. Try again later.', { status: 429 });
      return authorize(params);
    }
    if (p === '/token' && req.method === 'POST') return tokenEndpoint(req);
    if (p === '/mcp') return mcp(req, server);
    return new Response('Not found', { status: 404 });
  }

  // ---- agent socket ---------------------------------------------------------
  function markInstance(instance: string): void {
    const last = (db.query("SELECT value FROM meta WHERE key = 'instance'").get() as { value: string } | null)?.value;
    if (last === instance) return;
    if (last !== undefined) db.run("UPDATE events SET status = 'uncertain' WHERE status = 'sent'");
    db.run("INSERT INTO meta (key, value) VALUES ('instance', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [instance]);
  }

  function pending(after: number) {
    return db.query("SELECT id, grant_id, text, created_at FROM events WHERE status = 'pending' AND id > ? ORDER BY id").all(after) as any[];
  }

  async function events(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const after = Number(url.searchParams.get('after') ?? 0) || 0;
    const instance = url.searchParams.get('instance');
    if (!instance) return json({ error: 'instance_required' }, 400);
    markInstance(instance);
    openPolls++;
    try {
      let rows = pending(after);
      if (!rows.length) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, pollHold * 1000);
          function done() { clearTimeout(timer); wakePoll = wakePoll.filter(w => w !== done); resolve(); }
          wakePoll.push(done);
          req.signal.addEventListener('abort', done);
        });
        if (req.signal.aborted) return new Response(null, { status: 499 });
        rows = pending(after);
      }
      const out = db.transaction(() => rows.map(row => {
        db.run("UPDATE events SET status = 'sent' WHERE id = ?", [row.id]);
        return { id: row.id, chat_id: `c-${row.grant_id}`, message_id: `e-${row.id}`, user_id: row.grant_id,
          user: grantLabel(row.grant_id), ts: new Date(row.created_at * 1000).toISOString(), via: 'claude_app', text: row.text };
      }))();
      return json({ events: out });
    } finally { openPolls--; lastPollEnd = now(); }
  }

  async function replies(req: Request): Promise<Response> {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: 'invalid_body' }, 400); }
    const chat = typeof body?.chat_id === 'string' ? body.chat_id : '';
    const grant = chat.startsWith('c-') ? chat.slice(2) : '';
    if (!grant || !liveGrant(grant)) return json({ error: 'unknown_chat' }, 404);
    if (typeof body.text !== 'string' || !body.text) return json({ error: 'empty_text' }, 400);
    db.run("INSERT INTO replies (grant_id, text, reply_to, status, created_at) VALUES (?, ?, ?, 'queued', ?)",
      [grant, body.text, typeof body.reply_to === 'string' ? body.reply_to : null, now()]);
    db.run("UPDATE events SET status = 'answered', text = NULL WHERE grant_id = ? AND status = 'sent'", [grant]);
    audit('reply', grant);
    return json({ status: notifyReply(grant) ? 'sent' : 'queued' });
  }

  function status(): Response {
    const grants = (db.query('SELECT COUNT(*) AS n FROM grants WHERE revoked_at IS NULL').get() as { n: number }).n;
    return json({ ok: true, channel_connected: connected(), grants });
  }

  function socketFetch(req: Request): Promise<Response> | Response {
    const p = new URL(req.url).pathname;
    if (req.method === 'GET' && p === '/events') return events(req);
    if (req.method === 'POST' && p === '/replies') return replies(req);
    if (req.method === 'GET' && p === '/status') return status();
    return new Response('Not found', { status: 404 });
  }

  // ---- admin handshake and housekeeping --------------------------------------
  function applyAdmin(request: any): object {
    if (request?.kind === 'pair') {
      const code = String(request.code ?? '').toUpperCase();
      const row = db.query('SELECT * FROM requests WHERE code = ? AND grant_id IS NULL AND created_at > ?').get(code, now() - CODE_TTL_S) as any;
      if (!row) return { status: 'refused', reason: 'unknown_code' };
      const count = (db.query('SELECT COUNT(*) AS n FROM grants').get() as { n: number }).n;
      const id = `g${b64url(randomBytes(6)).replace(/[-_]/g, 'x')}`;
      const label = typeof request.name === 'string' && request.name.trim() ? request.name.trim().slice(0, 64) : `person-${count + 1}`;
      db.run('INSERT INTO grants (id, label, client_id, created_at) VALUES (?, ?, ?, ?)', [id, label, row.client_id, now()]);
      db.run('UPDATE requests SET grant_id = ? WHERE id = ?', [id, row.id]);
      audit('paired', id);
      return { status: 'paired', id, label, requested_seconds_ago: now() - row.created_at };
    }
    if (request?.kind === 'list') {
      return { grants: db.query('SELECT id, label, created_at FROM grants WHERE revoked_at IS NULL ORDER BY created_at').all() };
    }
    if (request?.kind === 'revoke') {
      const id = String(request.id ?? '');
      if (!liveGrant(id)) return { status: 'refused', reason: 'unknown_grant' };
      db.run('UPDATE grants SET revoked_at = ? WHERE id = ?', [now(), id]);
      db.run('DELETE FROM tokens WHERE grant_id = ?', [id]);
      waiters.get(id)?.resolve(null);
      audit('revoked', id);
      return { status: 'revoked', id };
    }
    return { status: 'refused', reason: 'unknown_request' };
  }

  function drainAdmin(): void {
    let names: string[];
    try { names = fs.readdirSync(adminDir).filter(n => n.endsWith('.request.json')); } catch { return; }
    for (const name of names) {
      const file = path.join(adminDir, name);
      let result: object;
      try { result = applyAdmin(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { result = { status: 'refused', reason: 'unreadable_request' }; }
      const out = path.join(adminDir, name.replace('.request.json', '.result.json'));
      fs.writeFileSync(`${out}.tmp`, JSON.stringify(result), { mode: 0o600 });
      fs.renameSync(`${out}.tmp`, out);
      fs.rmSync(file, { force: true });
    }
  }

  function sweep(): void {
    const t = now();
    db.run('DELETE FROM clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM grants) AND id NOT IN (SELECT client_id FROM requests)', [t - ORPHAN_CLIENT_TTL_S]);
    // An approved request whose page never came back to collect its code is gone after twice the TTL.
    db.run('DELETE FROM requests WHERE created_at < ? AND (grant_id IS NULL OR created_at < ?)', [t - CODE_TTL_S, t - 2 * CODE_TTL_S]);
    db.run('DELETE FROM auth_codes WHERE expires_at < ?', [t]);
    db.run('DELETE FROM tokens WHERE expires_at < ? OR used = 1', [t]);
    db.run('DELETE FROM audit WHERE ts < ?', [t - AUDIT_TTL_S]);
    db.run('DELETE FROM events WHERE text IS NULL AND created_at < ?', [t - AUDIT_TTL_S]);
    db.run("DELETE FROM replies WHERE status = 'delivered' AND created_at < ?", [t - AUDIT_TTL_S]);
    try {
      for (const name of fs.readdirSync(adminDir)) {
        const file = path.join(adminDir, name);
        if (name.endsWith('.result.json') && fs.statSync(file).mtimeMs < Date.now() - 3600_000) fs.rmSync(file, { force: true });
      }
    } catch {}
  }

  fs.rmSync(sock, { force: true });
  const publicServer = Bun.serve({ hostname: options.hostname ?? '127.0.0.1', port: options.port ?? config.port, fetch: publicFetch });
  // The agent socket is private, so its idle timeout covers the long poll server-wide: on Bun
  // 1.4.2 a per-request `server.timeout` (even 0) did not hold a 25 s request on a Unix socket
  // listener, while `idleTimeout` did. Bun's types omit `idleTimeout` for `unix`, hence the cast.
  const socketServer = Bun.serve({ unix: sock, idleTimeout: pollHold + 10, fetch: socketFetch } as unknown as Parameters<typeof Bun.serve>[0]);
  const adminTimer = setInterval(drainAdmin, 500);
  const sweepTimer = setInterval(sweep, 60_000);
  drainAdmin();

  return {
    port: publicServer.port,
    socket: sock,
    sweep,
    drainAdmin,
    stop() {
      clearInterval(adminTimer);
      clearInterval(sweepTimer);
      for (const waiter of [...waiters.values()]) waiter.resolve(null);
      for (const wake of wakePoll.splice(0)) wake();
      publicServer.stop(true);
      socketServer.stop(true);
      // Released callers still render their answer; close the database after they have.
      setTimeout(() => db.close(), 0);
    },
  };
}

if (import.meta.main) {
  const store = process.argv[2];
  if (!store) { console.error('usage: connector-gateway.ts <store>'); process.exit(1); }
  const gateway = startGateway(path.resolve(store), { hostname: process.env.CONNECTOR_HOSTNAME || undefined });
  console.error(`[connector] listening on port ${gateway.port}, socket ${gateway.socket}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { gateway.stop(); process.exit(0); });
}
