import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startBrowserViewer } from '../scripts/browser-viewer';
import { browserLease } from '../scripts/lib/browser-lease';
import { mutateTask, readTasks } from '../scripts/lib/tasks';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('browser-viewer-');
afterAll(cleanup);

function fixture() {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ browser: { admins: [{ login: 'admin' }, { login: 'other' }] } }));
  const novncRoot = path.join(dir, 'novnc');
  fs.mkdirSync(path.join(novncRoot, 'core'), { recursive: true });
  fs.mkdirSync(path.join(novncRoot, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(novncRoot, 'core/rfb.js'), 'export default class RFB {}');
  fs.writeFileSync(path.join(novncRoot, 'vendor/pako.js'), 'vendor');
  fs.writeFileSync(path.join(dir, 'secret'), 'secret');
  fs.symlinkSync(path.join(dir, 'secret'), path.join(novncRoot, 'core/escape.js'));
  const vncSocket = path.join(dir, 'vnc.sock');
  const vnc = Bun.listen({ unix: vncSocket, socket: { data(socket, data) { socket.write(data); } } });
  let alive = true;
  const viewer = startBrowserViewer({ dir, port: 0, hostname: '127.0.0.1', novncRoot, vncSocket, chromeAlive: () => alive, container: () => true });
  const base = viewer.server.url.origin;
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  config.browser.host = '127.0.0.1'; config.browser.port = viewer.server.port;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const headers = { 'Tailscale-User-Login': 'admin', Origin: base };
  const request = (route: string, init: RequestInit = {}) => fetch(base + route, { ...init, headers: { ...headers, ...init.headers } });
  return { dir, base, headers, request, viewer, vnc, vncSocket, novncRoot, loseBrowser() { alive = false; }, stop() { viewer.stop(); vnc.stop(true); } };
}

test('HTTP identity, cross-origin POST, no-cache page and contained module files', async () => {
  const f = fixture(); try {
    for (const headers of [{}, { 'Tailscale-User-Login': 'stranger' }] as Record<string, string>[]) expect((await fetch(f.base, { headers })).status).toBe(403);
    expect((await f.request('/takeover', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await f.request('/takeover', { method: 'POST', headers: { Origin: '' } })).status).toBe(403);
    const page = await f.request('/');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain("import RFB from './core/rfb.js'");
    for (const phrase of ['long-press to paste', 'aria-pressed', 'keyboard.blur()']) expect(html).toContain(phrase);
    expect((await f.request('/core/rfb.js')).status).toBe(200);
    expect((await f.request('/vendor/pako.js')).status).toBe(200);
    for (const route of ['/secret', '/core/escape.js', '/core/%2e%2e%2f%2e%2e%2fsecret', '/vnc.html']) expect((await f.request(route)).status).toBe(404);
  } finally { f.stop(); }
});

function openSocket(f: ReturnType<typeof fixture>, generation: number, headers = f.headers) {
  const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/socket?generation=${generation}`, { protocols: ['binary'], headers });
  return ws;
}
const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket refused')); });
const closed = (ws: WebSocket) => new Promise<void>(resolve => { ws.onclose = () => resolve(); });

test('only the current generation connects and bridges binary; takeover closes older input', async () => {
  const f = fixture(); try {
    const task = mutateTask(f.dir, 'open', undefined, { title: 'Login', requester: 'discord:user', done: 'signed in' }, '') as { id: string };
    mutateTask(f.dir, 'block', task.id, { 'waiting-on': 'admin', 'status-line': 'Login', next: 'Hand back' }, '');
    const before = readTasks(f.dir)[0].waiting_since;
    const take: any = await (await f.request(`/takeover?task=${task.id}`, { method: 'POST' })).json();
    expect(take.human).toMatchObject({ task: task.id, waiting_since: before });
    for (const headers of [{ ...f.headers, Origin: 'https://evil.example' }, { ...f.headers, 'Tailscale-User-Login': 'stranger' }]) {
      const bad = openSocket(f, take.epoch, headers);
      await expect(opened(bad)).rejects.toThrow('socket refused');
    }
    const ws = openSocket(f, take.epoch);
    await opened(ws);
    expect(ws.protocol).toBe('binary');
    const echoed = new Promise<string>(resolve => { ws.onmessage = async event => resolve(await new Response(event.data).text()); });
    // The fake display speaks first, like RFB, so wait for the bridge's readiness via its greeting.
    // A GET status does not drive the page or change the generation.
    await f.request('/status');
    ws.send(new TextEncoder().encode('binary input'));
    expect(await echoed).toBe('binary input');
    const wasClosed = closed(ws);
    const next: any = await (await f.request('/takeover', { method: 'POST', headers: { 'Tailscale-User-Login': 'other' } })).json();
    await wasClosed;
    expect(next.epoch).toBeGreaterThan(take.epoch);
    expect((await f.request(`/hand-back?generation=${take.epoch}`, { method: 'POST' })).status).toBe(409);
    const bad = openSocket(f, take.epoch);
    await expect(opened(bad)).rejects.toThrow('socket refused');
    expect((await f.request(`/hand-back?generation=${next.epoch}`, { method: 'POST', headers: { 'Tailscale-User-Login': 'other' } })).status).toBe(200);
    expect(readTasks(f.dir)[0].waiting_since).toBe(before);
    const state = browserLease('inspect', undefined, f.dir);
    expect(state.pending![0]).toMatchObject({ reason: 'hand_back', task: task.id, waiting_since: before });
    expect(fs.existsSync(path.join(f.dir, 'vnc.sock'))).toBe(true);
  } finally { f.stop(); }
});

test('removing an admin closes their open socket', async () => {
  const f = fixture(); try {
    const take: any = await (await f.request('/takeover', { method: 'POST' })).json();
    const ws = openSocket(f, take.epoch); await opened(ws);
    const done = closed(ws);
    fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ browser: { admins: [{ login: 'other' }] } }));
    await done;
  } finally { f.stop(); }
});

test('only a sign-in wait is woken, and a stale link falls through to the holder', async () => {
  const f = fixture(); try {
    const open = (title: string, waitingOn: string) => {
      const { id } = mutateTask(f.dir, 'open', undefined, { title, requester: 'discord:user', done: 'signed in' }, '') as { id: string };
      mutateTask(f.dir, 'block', id, { 'waiting-on': waitingOn, 'status-line': 'Login', next: 'Hand back' }, '');
      return readTasks(f.dir).find(record => record.id === id)!;
    };
    const confirm = open('confirmation', 'operator');
    expect(((await (await f.request(`/takeover?task=${confirm.id}`, { method: 'POST' })).json()) as any).human.task).toBeNull();
    const signIn = open('sign-in', 'admin');
    browserLease('hand-back', undefined, f.dir, Date.now(), { generation: 1, chromeAlive: () => true });
    browserLease('claim', signIn.id, f.dir);
    const take: any = await (await f.request(`/takeover?task=${confirm.id}`, { method: 'POST' })).json();
    expect(take.human).toMatchObject({ task: signIn.id, waiting_since: signIn.waiting_since });
    expect(readTasks(f.dir).find(record => record.id === confirm.id)!.waiting_since).toBe(confirm.waiting_since);
  } finally { f.stop(); }
});

test('dropped socket keeps the lease, browser loss reports recovery', async () => {
  const f = fixture(); try {
    const take: any = await (await f.request('/takeover?task=missing', { method: 'POST' })).json();
    expect(take.human.task).toBeNull();
    const ws = openSocket(f, take.epoch); await opened(ws);
    const done = closed(ws); ws.close(); await done;
    const status: any = await (await f.request('/status')).json();
    expect(status.human.disconnected_at).toBeNumber();
    f.loseBrowser();
    const lost: any = await (await f.request('/status')).json();
    expect(lost.status).toBe('recovery');
    expect(lost.pending[0].reason).toBe('browser_lost');
  } finally { f.stop(); }
});

test('browser loss refuses a new takeover as recovery rather than sign-in success', async () => {
  const f = fixture(); try {
    f.loseBrowser();
    const result = await f.request('/takeover', { method: 'POST' });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ status: 'recovery', error: 'browser_lost' });
    expect(browserLease('inspect', undefined, f.dir, Date.now(), { chromeAlive: () => false }).pending).toEqual([]);
  } finally { f.stop(); }
});

test('browser loss at a task link still wakes the waiting task', async () => {
  const f = fixture(); try {
    const task = mutateTask(f.dir, 'open', undefined, { title: 'Login', requester: 'discord:user', done: 'signed in' }, '') as { id: string };
    mutateTask(f.dir, 'block', task.id, { 'waiting-on': 'admin', 'status-line': 'Login', next: 'Hand back' }, '');
    f.loseBrowser();
    expect((await f.request(`/takeover?task=${task.id}`, { method: 'POST' })).status).toBe(409);
    const state = browserLease('inspect', undefined, f.dir, Date.now(), { chromeAlive: () => false });
    expect(state.human).toBeNull();
    expect(state.pending![0]).toMatchObject({ reason: 'browser_lost', task: task.id, waiting_since: readTasks(f.dir)[0].waiting_since });
  } finally { f.stop(); }
});

test('Hand back after a viewer restart preserves the display and records one durable return event', async () => {
  const f = fixture();
  let restarted: ReturnType<typeof startBrowserViewer> | undefined;
  try {
    const take: any = await (await f.request('/takeover', { method: 'POST' })).json();
    const ws = openSocket(f, take.epoch); await opened(ws);
    const done = closed(ws);
    // Restart only the viewer, keeping the fake display and its Unix listener alive.
    f.viewer.stop(); await done;
    restarted = startBrowserViewer({ dir: f.dir, port: 0, hostname: '127.0.0.1', novncRoot: f.novncRoot, vncSocket: f.vncSocket, chromeAlive: () => true, container: () => true });
    const base = restarted.server.url.origin;
    const config = JSON.parse(fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8'));
    config.browser.port = restarted.server.port;
    fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify(config));
    const response = await fetch(`${base}/hand-back?generation=${take.epoch}`, { method: 'POST', headers: { ...f.headers, Origin: base } });
    expect(response.status).toBe(200);
    const state = browserLease('inspect', undefined, f.dir);
    expect(state.pending).toHaveLength(1);
    expect(state.pending![0].reason).toBe('hand_back');
    expect(f.vnc.unix).toBe(f.vncSocket);
    expect(fs.existsSync(f.vncSocket)).toBe(true);
  } finally { restarted?.stop(); f.stop(); }
});


test('Host check follows identity refusal and protects HTTP and websocket requests', async () => {
  const f = fixture(); try {
    const noIdentity = await fetch(f.base, { headers: { Host: 'wrong.example:123' } });
    expect(await noIdentity.json()).toEqual({ error: 'browser_identity_refused' });
    for (const headers of [{ Host: 'wrong.example:123' }, { Host: 'wrong.example:123', Upgrade: 'websocket' }] as Record<string, string>[]) {
      expect((await f.request('/status', { headers })).status).toBe(403);
    }
    fs.writeFileSync(path.join(f.dir, 'config.json'), '{"browser":{"admins":[{"login":"admin"}],"host":null}}');
    expect((await f.request('/')).status).toBe(403);
  } finally { f.stop(); }
});
test.serial('host viewer refuses implicit binding', () => {
  const saved = process.env.HERMIT_BROWSER_VIEWER_BIND;
  delete process.env.HERMIT_BROWSER_VIEWER_BIND;
  try { expect(() => startBrowserViewer({ dir: freshDir(), container: () => false, chromeAlive: () => false })).toThrow('browser_viewer_bind_required'); }
  finally { if (saved === undefined) delete process.env.HERMIT_BROWSER_VIEWER_BIND; else process.env.HERMIT_BROWSER_VIEWER_BIND = saved; }
});
