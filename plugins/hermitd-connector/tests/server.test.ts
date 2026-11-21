// The in-agent channel as a real stdio process against a stand-in trusted-server socket.
//
// Usage: bun test   (from plugins/hermitd-connector)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER = path.resolve(import.meta.dir, '../server.ts');
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

type Proc = ReturnType<typeof Bun.spawn>;

/**
 * Starts the server under a parent shell whose command line plays the `claude` process: with
 * `asChannel` it names the plugin after a channel flag, as a session launched with it would.
 * The trailing `; :` keeps the shell alive as the parent instead of exec'ing the server.
 */
function channel(env: Record<string, string>, asChannel = true) {
  const flag = asChannel ? ['--channels', 'plugin:hermitd-connector@hermitd'] : ['--model', 'haiku'];
  const proc = Bun.spawn(['sh', '-c', `"${process.execPath}" "${SERVER}"; :`, 'claude', ...flag],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { PATH: process.env.PATH ?? '', ...env } });
  const lines: any[] = [];
  const waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  (async () => {
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk);
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const message = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        lines.push(message);
        for (const w of waiters.splice(0)) { if (w.match(message)) w.resolve(message); else waiters.push(w); }
      }
    }
  })();
  const write = (m: object) => { (proc.stdin as any).write(JSON.stringify(m) + '\n'); (proc.stdin as any).flush(); };
  const next = (match: (m: any) => boolean) => new Promise<any>(resolve => {
    const found = lines.find(match);
    if (found) resolve(found); else waiters.push({ match, resolve });
  });
  let id = 0;
  const request = async (method: string, params: object = {}) => {
    const rid = ++id;
    write({ jsonrpc: '2.0', id: rid, method, params });
    return next(m => m.id === rid);
  };
  const init = async () => {
    const r = await request('initialize', { protocolVersion: '2025-06-18' });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  };
  return { proc: proc as Proc, write, next, request, init };
}

function standIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-chan-'));
  dirs.push(dir);
  const sock = path.join(dir, 'connector.sock');
  const polls: URLSearchParams[] = [];
  const posted: any[] = [];
  let queue: object[] = [{ id: 7, chat_id: 'c-g1', message_id: 'e-7', user_id: 'g1', user: 'Ana', ts: '2026-11-18T10:00:00.000Z', via: 'claude_app', text: 'hello agent' }];
  const server = Bun.serve({
    unix: sock,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/events') {
        polls.push(url.searchParams);
        const events = queue; queue = [];
        if (!events.length) await Bun.sleep(200);
        return Response.json({ events });
      }
      if (url.pathname === '/replies') { posted.push(await req.json()); return Response.json({ status: 'sent' }); }
      return new Response('Not found', { status: 404 });
    },
  });
  return { sock, polls, posted, stop: () => server.stop(true) };
}

describe('channel server', () => {
  test('declares a channel and the reply tool, and answers unknown requests with an error', async () => {
    const c = channel({});
    try {
      const init = await c.request('initialize', { protocolVersion: '2025-06-18' });
      expect(init.result.capabilities).toEqual({ experimental: { 'claude/channel': {} }, tools: {} });
      expect(init.result.capabilities.experimental['claude/channel/permission']).toBeUndefined();
      expect(init.result.instructions).toContain('reply tool');
      expect((await c.request('server/discover')).error.code).toBe(-32601);
      const tools = await c.request('tools/list');
      expect(tools.result.tools.map((t: any) => t.name)).toEqual(['reply']);
    } finally { c.proc.kill(); }
  });

  test('with no socket variable it stays idle and reply returns an error', async () => {
    const c = channel({});
    try {
      await c.init();
      const r = await c.request('tools/call', { name: 'reply', arguments: { chat_id: 'c-g1', text: 'hi' } });
      expect(r.result.isError).toBe(true);
    } finally { c.proc.kill(); }
  });

  test('each event becomes one channel notification with the six meta keys; reply posts and returns the status', async () => {
    const s = standIn();
    const c = channel({ HERMIT_CONNECTOR_SOCKET: s.sock });
    try {
      await c.init();
      const note = await c.next(m => m.method === 'notifications/claude/channel');
      expect(note.params).toEqual({
        content: 'hello agent',
        meta: { chat_id: 'c-g1', message_id: 'e-7', user_id: 'g1', user: 'Ana', ts: '2026-11-18T10:00:00.000Z', via: 'claude_app' },
      });
      const r = await c.request('tools/call', { name: 'reply', arguments: { chat_id: 'c-g1', text: 'Hi Ana.', reply_to: 'e-7' } });
      expect(r.result).toEqual({ content: [{ type: 'text', text: 'sent' }] });
      expect(s.posted).toEqual([{ chat_id: 'c-g1', text: 'Hi Ana.', reply_to: 'e-7' }]);
      const later = s.polls.at(-1)!;
      expect(later.get('after')).toBe('7');
      expect(new Set(s.polls.map(p => p.get('instance'))).size).toBe(1);
    } finally { c.proc.kill(); s.stop(); }
  });

  test('a session that did not enable the channel never polls, so it cannot take a message', async () => {
    const s = standIn();
    const c = channel({ HERMIT_CONNECTOR_SOCKET: s.sock }, false);
    try {
      await c.init();
      await c.request('ping');
      await Bun.sleep(300);
      expect(s.polls).toHaveLength(0);
    } finally { c.proc.kill(); s.stop(); }
  });

  test('a reply with the server down returns an error', async () => {
    const c = channel({ HERMIT_CONNECTOR_SOCKET: path.join(os.tmpdir(), `missing-${process.pid}.sock`) });
    try {
      await c.init();
      const r = await c.request('tools/call', { name: 'reply', arguments: { chat_id: 'c-g1', text: 'hi' } });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain('not running');
    } finally { c.proc.kill(); }
  });
});
