// `hermitd connector` host command: the host-only store, its refusals, and the
// admin handshake with the trusted server.
//
// Usage: bun test tests/connector.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { run } from '../scripts/connector';
import { connectorSession, socketPath, startConnector, stopConnector, storeDir, writeConfig } from '../scripts/lib/connector';
import { startGateway } from '../scripts/connector-gateway';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const roots: string[] = [];
afterAll(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(docker?: object, probe: (port: number) => boolean = () => true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'connector-cmd-')));
  roots.push(root);
  const project = path.join(root, 'project');
  const config = path.join(root, 'home/.claude');
  fs.mkdirSync(path.join(project, '.hermit'), { recursive: true });
  fs.writeFileSync(path.join(project, '.hermit/config.json'), JSON.stringify(docker ? { docker } : {}));
  if (docker) fs.writeFileSync(path.join(project, 'docker-compose.hermit.yml'), 'services: {}\n');
  const cmd = (...argv: string[]) => run([argv[0], project, ...argv.slice(1)], () => false, config, probe);
  return { root, project, config, cmd, store: storeDir(project, config) };
}

const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);
const ENABLE = ['enable', '--port', '8790', '--public-url', 'https://agent.example.com/'];

function claimSibling(store: string, port: number, public_url = 'https://other.example.com') {
  writeConfig(path.join(path.dirname(store), 'other-agent'), { port, public_url, wait_seconds: 25, rate_per_hour: 60 });
}

describe('enable', () => {
  test('creates the store with its folder modes and copies the server; nothing under the project', async () => {
    const f = fixture();
    expect(fs.existsSync(path.dirname(f.store))).toBe(false);
    expect(await f.cmd(...ENABLE)).toMatchObject({ status: 'enabled', port: 8790, public_url: 'https://agent.example.com', wait_seconds: 25, rate_per_hour: 60 });
    expect(f.store.startsWith(path.join(f.config, 'hermitd/connector/'))).toBe(true);
    expect([mode(path.join(f.store, 'sidecar')), mode(path.join(f.store, 'data')), mode(path.join(f.store, 'bridge'))]).toEqual(['700', '700', '755']);
    expect(fs.existsSync(path.join(f.store, 'sidecar/gateway.ts'))).toBe(true);
    expect(fs.readdirSync(f.project)).toEqual(['.hermit']);
    expect(fs.readdirSync(path.join(f.project, '.hermit'))).toEqual(['config.json']);
  });

  test('a second enable updates in place and keeps unspecified settings', async () => {
    const f = fixture();
    await f.cmd(...ENABLE, '--wait-seconds', '40');
    expect(await f.cmd('enable', '--rate-per-hour', '5')).toMatchObject({ status: 'updated', port: 8790, wait_seconds: 40, rate_per_hour: 5 });
  });

  test('picks the first unclaimed port the probe can bind', async () => {
    const f = fixture(undefined, (port) => port !== 8790);
    claimSibling(f.store, 8791);
    expect(await f.cmd('enable', '--public-url', 'https://agent.example.com')).toMatchObject({ status: 'enabled', port: 8792 });
    expect(await f.cmd('enable')).toMatchObject({ status: 'updated', port: 8792 });
  });

  test('refuses explicit and stored port claims from siblings', async () => {
    const f = fixture();
    await f.cmd(...ENABLE);
    claimSibling(f.store, 8790);
    const refusal = { status: 'refused', reason: 'port_used_by_other_agent' };
    expect(await f.cmd(...ENABLE)).toEqual(refusal);
    expect(await f.cmd('enable')).toEqual(refusal);
  });

  test('a bound port is refused unless this store reports that exact listener port', async () => {
    const f = fixture(undefined, () => false);
    const refusal = { status: 'refused', reason: 'port_in_use' };
    expect(await f.cmd(...ENABLE)).toEqual(refusal);
    fs.mkdirSync(path.dirname(socketPath(f.store)), { recursive: true });
    let port = 8791;
    const server = Bun.serve({ unix: socketPath(f.store), fetch: () => Response.json({ port }) });
    try {
      expect(await f.cmd(...ENABLE)).toEqual(refusal);
      port = 8790;
      expect(await f.cmd(...ENABLE)).toMatchObject({ status: 'enabled', port });
    } finally { server.stop(true); }
  });

  test("this store's running server keeps its port: saved when status omits it, reported when re-enabled without one", async () => {
    const f = fixture(undefined, () => false);
    fs.mkdirSync(path.dirname(socketPath(f.store)), { recursive: true });
    let body: object = { port: 8795 };
    const server = Bun.serve({ unix: socketPath(f.store), fetch: () => Response.json(body) });
    try {
      expect(await f.cmd('enable', '--public-url', 'https://agent.example.com')).toMatchObject({ status: 'enabled', port: 8795 });
      body = {};
      expect(await f.cmd('enable', '--rate-per-hour', '5')).toMatchObject({ status: 'updated', port: 8795, rate_per_hour: 5 });
    } finally { server.stop(true); }
  });

  test('reports exhaustion if no port can bind', async () => {
    const f = fixture(undefined, () => false);
    await expect(f.cmd('enable', '--public-url', 'https://agent.example.com')).rejects.toThrow('no_free_port');
  });

  test.each(['https://agent.example.com/path/', 'https://agent.example.com:8443'])('refuses %s before probing', async (url) => {
    const f = fixture(undefined, () => { throw new Error('unexpected_probe'); });
    await expect(f.cmd('enable', '--public-url', url)).rejects.toThrow('invalid_public_url');
  });

  test('refuses a duplicate origin even when the sibling config uses a path', async () => {
    const f = fixture();
    claimSibling(f.store, 8791, 'https://AGENT.example.com:443/old/');
    expect(await f.cmd(...ENABLE)).toEqual({ status: 'refused', reason: 'public_url_used_by_other_agent' });
  });

  test('skips an unreadable sibling config', async () => {
    const f = fixture();
    claimSibling(f.store, 8790);
    fs.writeFileSync(path.join(path.dirname(f.store), 'other-agent', 'sidecar', 'connector.json'), '{');
    expect(await f.cmd(...ENABLE)).toMatchObject({ status: 'enabled', port: 8790 });
  });

  test('concurrent enables in two projects share port claims under one HOME', async () => {
    const first = fixture();
    const second = fixture();
    const script = path.resolve(import.meta.dir, '../scripts/connector.ts');
    const env = { ...process.env, HOME: path.dirname(first.config) };
    const launch = (project: string, host: string) => Bun.spawn({
      cmd: [process.execPath, script, 'enable', project, '--public-url', `https://${host}.example.com`],
      cwd: project,
      env,
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const results = await Promise.all([launch(first.project, 'first'), launch(second.project, 'second')].map(async (child) => {
      const [output, code] = await Promise.all([new Response(child.stdout).json(), child.exited]);
      if (code === 1) {
        expect(output).toEqual({ error: 'connector_store_busy' });
        return null;
      }
      expect(code).toBe(0);
      expect(output).toMatchObject({ status: 'enabled', port: expect.any(Number) });
      return (output as { port: number }).port;
    }));
    expect(results[0]).not.toBe(results[1]);
  });

  test('refusals', async () => {
    const tmux = fixture();
    await expect(run(['enable', tmux.project, ...ENABLE.slice(1)], () => true, tmux.config)).rejects.toThrow('host_only');
    await expect(tmux.cmd('enable', '--port', '8790', '--public-url', 'http://agent.example.com')).rejects.toThrow('invalid_public_url');
    await expect(tmux.cmd('enable', '--port', '0', '--public-url', 'https://agent.example.com')).rejects.toThrow('invalid_port');
    await expect(tmux.cmd('enable', '--port', '8790', '--public-url', 'https://a.example.com', '--wait-seconds', '201')).rejects.toThrow('invalid_wait_seconds');
    const inside = fixture();
    await expect(run(['enable', inside.project, ...ENABLE.slice(1)], () => false, path.join(inside.project, '.claude'))).rejects.toThrow('store_inside_project');
    const host = fixture({ network_mode: 'host' });
    await expect(host.cmd(...ENABLE)).rejects.toThrow('host_network');
    expect(await fixture({ network_mode: 'bridge' }).cmd(...ENABLE)).toMatchObject({ status: 'enabled' });
  });
});

describe('disable, render, status and the admin handshake', () => {
  test('without an enabled store nothing is written', async () => {
    const f = fixture();
    expect(await f.cmd('render')).toEqual({ status: 'skipped', reason: 'not_enabled' });
    expect(await f.cmd('disable')).toEqual({ status: 'skipped', reason: 'not_enabled' });
    expect(await f.cmd('status')).toEqual({ enabled: false });
    expect(await f.cmd('pair', 'ABCD2345')).toEqual({ status: 'refused', reason: 'not_enabled' });
    expect(fs.existsSync(f.store)).toBe(false);
  });

  test('pair with no server running reports it as pending', async () => {
    const f = fixture();
    await f.cmd(...ENABLE);
    expect(await f.cmd('status')).toMatchObject({ enabled: true, server: 'not_running' });
    expect(await f.cmd('pair', 'abcd2345')).toEqual({ status: 'pending', reason: 'server_not_running' });
  }, 10000);

  test('disable then enable keeps grants; list, status and revoke go through the server', async () => {
    const f = fixture();
    await f.cmd(...ENABLE);
    const gw = startGateway(f.store, { port: 0 });
    try {
      const base = `http://127.0.0.1:${gw.port}`;
      const client = (await (await fetch(`${base}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [CALLBACK] }) })).json() as any).client_id;
      const challenge = createHash('sha256').update(randomBytes(32)).digest('base64url');
      const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' });
      const code = /<code>([A-Z0-9]+)<\/code>/.exec(await (await fetch(`${base}/authorize?${q}`)).text())![1];
      const paired: any = await f.cmd('pair', code.toLowerCase(), '--name', 'Ana');
      expect(paired).toMatchObject({ status: 'paired', label: 'Ana' });
      expect(await f.cmd('status')).toMatchObject({
        enabled: true, server: 'running', port: gw.port, grants: 1, channel: 'absent', unanswered: 0, oldest_unanswered_at: null,
      });
      expect(await f.cmd('disable')).toMatchObject({ status: 'disabled' });
      expect(await f.cmd('status')).toEqual({ enabled: false });
      expect(await f.cmd(...ENABLE)).toMatchObject({ status: 'enabled' });
      expect(await f.cmd('list')).toMatchObject({ grants: [{ id: paired.id, label: 'Ana' }] });
      expect(await f.cmd('revoke', paired.id)).toEqual({ status: 'revoked', id: paired.id });
      expect(await f.cmd('revoke', paired.id)).toEqual({ status: 'refused', reason: 'unknown_grant' });
    } finally { gw.stop(); }
  }, 20000);
});

describe('host start and stop', () => {
  type Spawn = (cmd: string, args: string[]) => { status: number };
  const recorder = (calls: string[][], status = 0): Spawn => (cmd, args) => { calls.push([cmd, ...args]); return { status }; };
  const start = (project: string, deps: object) => startConnector(project, 'res', { container: false, sessionAlive: () => false, ...deps } as any);

  test.serial('no store: nothing starts and the variable is unset', () => {
    const f = fixture();
    process.env.HERMIT_CONNECTOR_SOCKET = 'stale';
    const calls: string[][] = [];
    start(f.project, { configRoot: f.config, spawn: recorder(calls) });
    expect(process.env.HERMIT_CONNECTOR_SOCKET).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test.serial('enabled store on a host: the server starts in its own tmux session and the socket is exported', async () => {
    const f = fixture();
    await f.cmd(...ENABLE);
    const calls: string[][] = [];
    start(f.project, { configRoot: f.config, spawn: recorder(calls) });
    expect(process.env.HERMIT_CONNECTOR_SOCKET).toBe(socketPath(f.store));
    expect(calls[0].slice(0, 5)).toEqual(['tmux', 'new-session', '-d', '-s', connectorSession('res')]);
    expect(calls[0].at(-2)).toEndWith('scripts/connector-gateway.ts');
    expect(calls[0].at(-1)).toBe(f.store);
    delete process.env.HERMIT_CONNECTOR_SOCKET;
  });

  test.serial('an install inside the project is refused and nothing starts', async () => {
    const f = fixture();
    await f.cmd(...ENABLE);
    const inner = path.join(f.project, 'plugins/hermitd');
    fs.mkdirSync(path.join(inner, 'scripts'), { recursive: true });
    const calls: string[][] = [];
    const logs: string[] = [];
    const log = console.log;
    console.log = (line: string) => { logs.push(line); };
    try { start(f.project, { configRoot: f.config, installRoot: inner, spawn: recorder(calls) }); }
    finally { console.log = log; delete process.env.HERMIT_CONNECTOR_SOCKET; }
    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain('untrusted_install');
  });

  test.serial('a failed start warns and does not throw', async () => {
    const f = fixture();
    await f.cmd(...ENABLE);
    const logs: string[] = [];
    const log = console.log;
    console.log = (line: string) => { logs.push(line); };
    try { start(f.project, { configRoot: f.config, spawn: recorder([], 1) }); }
    finally { console.log = log; delete process.env.HERMIT_CONNECTOR_SOCKET; }
    expect(logs.join('\n')).toContain('connector server did not start');
  });

  test.serial('in a container no session starts; the variable follows the mounted folder', () => {
    const calls: string[][] = [];
    start('/nonexistent', { container: true, spawn: recorder(calls) });
    expect(calls).toEqual([]);
    expect(process.env.HERMIT_CONNECTOR_SOCKET).toBe(fs.existsSync('/run/hermit-connector') ? '/run/hermit-connector/connector.sock' : undefined);
    delete process.env.HERMIT_CONNECTOR_SOCKET;
  });

  test('stop kills only a live connector session', () => {
    const calls: string[][] = [];
    stopConnector('res', recorder(calls) as any, () => false);
    expect(calls).toEqual([]);
    stopConnector('res', recorder(calls) as any, () => true);
    expect(calls).toEqual([['tmux', 'kill-session', '-t', '=connector-res']]);
  });
});
