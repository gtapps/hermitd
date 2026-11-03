#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import type { ServerWebSocket, Socket } from 'bun';
import { hermitDir } from './lib/cc-compat';
import { browserLease, humanGeneration, persistentChromeAlive } from './lib/browser-lease';
import { isContainer } from './lib/container';
import { browserSocketDir, browserViewerPaths } from './lib/browser-runtime';
import { readSettledConfig } from './lib/config-read';

interface ViewerSocket { generation: number; login: string; bridge?: Socket; closed: boolean }
interface ViewerOptions {
  dir?: string; port?: number; hostname?: string; novncRoot?: string; vncSocket?: string;
  chromeAlive?: () => boolean;
  container?: () => boolean;
}

export function startBrowserViewer(options: ViewerOptions = {}) {
  const dir = options.dir ?? hermitDir();
  const bind = process.env.HERMIT_BROWSER_VIEWER_BIND;
  if (!(options.container ?? isContainer)() && !bind) throw new Error('browser_viewer_bind_required');
  const chromeAlive = options.chromeAlive ?? (() => persistentChromeAlive(dir));
  const novncRoot = options.novncRoot ?? '/opt/novnc';
  const clients = new Set<ServerWebSocket<ViewerSocket>>();
  const lease = (action: Parameters<typeof browserLease>[0], task?: string, extra = {}) =>
    browserLease(action, task, dir, Date.now(), { chromeAlive, ...extra });
  lease('restart');
  const admins = (): string[] => readSettledConfig(dir).browser.admins.map((admin: { login: string } | null) => admin?.login);
  const isAdmin = (login: string | null): login is string => !!login && admins().includes(login);
  const closeStale = () => {
    const current = lease('inspect');
    for (const ws of clients) if (current.human?.generation !== ws.data.generation || !isAdmin(ws.data.login)) ws.close(1000, 'Control changed');
    return current;
  };
  const server = Bun.serve<ViewerSocket>({
    port: options.port ?? (bind ? Number(bind.split(':')[1]) : 6080), hostname: options.hostname ?? bind?.split(':')[0] ?? '0.0.0.0',
    async fetch(req, server) {
      const login = req.headers.get('Tailscale-User-Login');
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
      if (!isAdmin(login)) return reply({ error: 'browser_identity_refused' }, 403);
      const browser = readSettledConfig(dir).browser;
      if (!browser.host || req.headers.get('host') !== `${browser.host}:${browser.port}`) return reply({ error: 'browser_host_refused' }, 403);
      const url = new URL(req.url);
      const upgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (req.method === 'POST' || upgrade) {
        let origin: URL;
        try { origin = new URL(req.headers.get('origin') ?? ''); } catch { return reply({ error: 'origin_refused' }, 403); }
        if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== req.headers.get('host')) return reply({ error: 'origin_refused' }, 403);
      }
      if (upgrade && url.pathname === '/socket') {
        const current = closeStale();
        const generation = Number(url.searchParams.get('generation'));
        if (!current.human || current.human.login !== login || current.human.generation !== generation) return reply({ error: 'stale_generation' }, 409);
        if (!req.headers.get('sec-websocket-protocol')?.split(',').map(value => value.trim()).includes('binary')) return reply({ error: 'binary_required' }, 400);
        if (server.upgrade(req, { data: { generation, login, closed: false }, headers: { ...headers, 'Sec-WebSocket-Protocol': 'binary' } })) return;
        return reply({ error: 'upgrade_failed' }, 400);
      }
      if (req.method === 'POST' && url.pathname === '/takeover') {
        const task = url.searchParams.get('task') ?? undefined;
        if (!chromeAlive()) {
          // The refused attempt records the loss, so a task waiting on this link still wakes.
          if (task) lease('takeover', task, { login, admins: admins() });
          closeStale();
          return reply({ status: 'recovery', error: 'browser_lost' }, 409);
        }
        const result = lease('takeover', task, { login, admins: admins() });
        // A lost HTTP response must also start the no-viewer expiry clock.
        lease('disconnect', undefined, { generation: result.epoch });
        closeStale();
        return reply(result);
      }
      if (req.method === 'POST' && url.pathname === '/hand-back') {
        const current = lease('inspect');
        const generation = Number(url.searchParams.get('generation'));
        if (!current.human || current.human.login !== login || current.human.generation !== generation) return reply({ error: 'stale_generation' }, 409);
        const result = lease('hand-back', undefined, { generation });
        closeStale();
        return reply(result);
      }
      if (req.method !== 'GET') return reply({ error: 'not_found' }, 404);
      if (url.pathname === '/status') return reply(closeStale());
      if (url.pathname === '/') return new Response(Bun.file(path.join(import.meta.dir, 'browser-viewer.html')), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      // Decode before resolving; both the resolved path and its real target stay in one allowed tree.
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { return reply({ error: 'not_found' }, 404); }
      for (const tree of ['core', 'vendor']) {
        const root = path.resolve(novncRoot, tree);
        const target = path.resolve(novncRoot, '.' + pathname);
        if (!target.startsWith(root + path.sep)) continue;
        try {
          if (!fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(target).isFile()) continue;
          return new Response(Bun.file(target), { headers });
        } catch {}
      }
      return reply({ error: 'not_found' }, 404);
    },
    websocket: {
      async open(ws) {
        clients.add(ws);
        if (closeStale().human?.generation !== ws.data.generation) return;
        lease('connect', undefined, { generation: ws.data.generation });
        try {
          const bridge = await Bun.connect({
            unix: options.vncSocket ?? path.join(browserSocketDir(dir), 'vnc.sock'),
            socket: {
              data(_socket, data) { if (!ws.data.closed) ws.sendBinary(data); },
              close() { ws.close(1000, 'Display disconnected'); },
              error() { ws.close(1011, 'Display connection failed'); },
            },
          });
          if (ws.data.closed || closeStale().human?.generation !== ws.data.generation) { bridge.end(); return; }
          ws.data.bridge = bridge;
        } catch { ws.close(1011, 'Display connection failed'); }
      },
      message(ws, message) {
        // Runs on every input frame; the timer below owns expiry, browser loss and revoked admins.
        if (humanGeneration(dir) !== ws.data.generation || typeof message === 'string') { ws.close(1008, 'Control refused'); return; }
        ws.data.bridge?.write(message);
      },
      close(ws) {
        ws.data.closed = true;
        ws.data.bridge?.end();
        clients.delete(ws);
        if (![...clients].some(client => client.data.generation === ws.data.generation)) lease('disconnect', undefined, { generation: ws.data.generation });
      },
    },
  });
  // A contended lock retries on the next tick; an uncaught throw would drop every socket.
  const timer = setInterval(() => { try { closeStale(); } catch {} }, 2000);
  return { server, stop() { clearInterval(timer); for (const client of clients) client.close(); server.stop(true); } };
}

if (import.meta.main) {
  const bind = process.env.HERMIT_BROWSER_VIEWER_BIND;
  const viewer = startBrowserViewer({ ...browserViewerPaths(), ...(bind ? { hostname: bind.split(':')[0], port: Number(bind.split(':')[1]) } : {}) });
  console.log(JSON.stringify({ status: 'viewer_ready' }));
  const stop = () => { viewer.stop(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
