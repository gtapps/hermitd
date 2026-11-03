import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserDisplaySession, reserveDisplay, maybeStartBrowserDisplay, stopBrowserDisplay } from '../scripts/browser-display';
import { browserSocketDir } from '../scripts/lib/browser-runtime';
import { freshDirFactory } from './helpers/workdir';
import { PLUGIN_ROOT } from './helpers/run';
const { freshDir, cleanup } = freshDirFactory('browser-display-');
afterAll(cleanup);
test('hermits reserve distinct displays and reclaim only dead reservations', () => {
  const data = freshDir();
  const first = reserveDisplay(data, () => false);
  const second = reserveDisplay(data, () => false);
  expect(first.display).toBe(':10'); expect(second.display).toBe(':11');
  fs.writeFileSync(first.reservation, '{"pid":99999999}');
  expect(reserveDisplay(data, () => false).display).toBe(':10');
  expect(reserveDisplay(data, number => number === 12).display).toBe(':13');
  expect(browserDisplaySession('hermit-demo').startsWith('hermit-demo')).toBe(false);
});
test('interactive, disabled, and missing-package boots do not start a sidecar', () => {
  const dir = freshDir(); let spawns = 0;
  const spawn = (() => { spawns++; }) as any;
  maybeStartBrowserDisplay('interactive', dir, spawn, true);
  maybeStartBrowserDisplay('tmux', dir, spawn, false);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"browser":{"enabled":false}}');
  maybeStartBrowserDisplay('tmux', dir, spawn, true);
  expect(spawns).toBe(0);
});


test('shutdown takes teardown without waking a waiter and bounds the close subprocess', async () => {
  const dir = freshDir();
  const { browserLease } = await import('../scripts/lib/browser-lease');
  browserLease('claim', 'old', dir); browserLease('claim', 'queued', dir);
  browserLease('takeover', undefined, dir, Date.now(), { login: 'admin' });
  const calls: string[] = [];
  const spawn = ((command: string, args: string[], options: any) => {
    if (args.some(arg => arg.endsWith('/browser-agent.ts'))) {
      expect(browserLease('inspect', undefined, dir)).toMatchObject({ holder: 'shutdown', human: null });
      expect(options.timeout).toBe(5000); expect(options.killSignal).toBe('SIGKILL');
      calls.push('close');
    } else {
      expect(browserLease('inspect', undefined, dir).holder).toBeNull();
      expect(args[0]).toBe('kill-session'); calls.push('kill');
    }
    return { status: 0 };
  }) as any;
  stopBrowserDisplay(dir, spawn, () => true);
  expect(calls).toEqual(['close', 'kill']);
  expect(browserLease('inspect', undefined, dir).waiters).toHaveLength(1);
});

test('a wedged lease still ends the display and never throws into hermitd-stop', () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state/browser-lease.json'), '{"holder":7}');
  const calls: string[][] = [];
  const spawn = ((command: string, args: string[]) => { calls.push([command, ...args]); return { status: 0 }; }) as any;
  const error = console.error; console.error = () => {};
  try { stopBrowserDisplay(dir, spawn, () => true); } finally { console.error = error; }
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(0, 2)).toEqual(['tmux', 'kill-session']);
});

test('the tmux display is bound to its own hermit, not the tmux server environment', () => {
  const dir = freshDir(); let args: string[] = [];
  const spawn = ((_: string, argv: string[]) => { args = argv; return { status: 0 }; }) as any;
  const { browserHostPlatform } = require('../scripts/lib/browser-runtime');
  maybeStartBrowserDisplay('tmux', dir, spawn, true, () => false);
  if (browserHostPlatform() === 'linux') expect(args).toContain(`AGENT_DIR=${dir}`);
});

test.if(process.platform === 'linux')('a running display starts the viewer once setup saves its port, and SIGHUP cleans up', async () => {
  const root = freshDir(), dir = path.join(root, '.hermit'), bin = path.join(root, 'bin'), cache = path.join(root, 'cache');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.writeFileSync(path.join(bin, 'Xvnc'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.argv[process.argv.indexOf('-rfbunixpath') + 1], '');\nprocess.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'openbox'), '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
  const install = path.join(cache, 'data/hermitd-inline/browser/1-2');
  fs.mkdirSync(path.join(install, 'chrome'), { recursive: true });
  for (const file of ['agent-browser', 'chrome/chrome']) fs.writeFileSync(path.join(install, file), '', { mode: 0o755 });
  fs.writeFileSync(path.join(install, 'config.json'), '{}');
  fs.writeFileSync(path.join(install, 'complete.json'), '{"binary":"agent-browser","chrome":"chrome/chrome"}');
  const socket = browserSocketDir(dir);
  const child = Bun.spawn([process.execPath, path.join(PLUGIN_ROOT, 'scripts/browser-display.ts'), 'run'], {
    cwd: root, env: { ...process.env, AGENT_DIR: dir, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_PLUGIN_CACHE_DIR: cache, HERMIT_PLUGIN_ROOT: PLUGIN_ROOT }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  const until = async (ready: () => boolean | Promise<boolean>) => {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(50)) if (await ready()) return;
    throw new Error('condition not reached');
  };
  try {
    const record = path.join(dir, 'state/browser-display.json');
    await until(() => fs.existsSync(record));
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = listener.port; listener.stop(true);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ browser: { port } }));
    await until(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${port}/`)).json() as any).error === 'browser_identity_refused'; }
      catch { return false; }
    });
    child.kill('SIGHUP');
    await child.exited;
    expect(fs.existsSync(record)).toBe(false);
    expect(fs.existsSync(path.join(socket, 'vnc.sock'))).toBe(false);
    expect(fs.existsSync(`${record}.lock`)).toBe(false);
  } finally { child.kill('SIGKILL'); fs.rmSync(socket, { recursive: true, force: true }); }
}, 30_000);

test('tmux display startup is idempotent with an injected tmux runner', () => {
  const dir = freshDir(); let calls = 0;
  const spawn = (() => { calls++; return { status: 0 }; }) as any;
  maybeStartBrowserDisplay('tmux', dir, spawn, true, () => false);
  // macOS intentionally has no sidecar.
  const { browserHostPlatform } = require('../scripts/lib/browser-runtime');
  expect(calls).toBe(browserHostPlatform() === 'linux' ? 1 : 0);
  maybeStartBrowserDisplay('tmux', dir, spawn, true, () => true);
  expect(calls).toBe(browserHostPlatform() === 'linux' ? 1 : 0);
});

test('container display requires a plugin-owned marker and leaves legacy displays alone', async () => {
  const { ensureDisplay } = await import('../scripts/browser-display');
  const dir = freshDir(), marker = path.join(dir, 'marker');
  let calls = 0;
  const options = { deployment: 'container' as const, platform: 'linux' as const, marker, available: true, spawn: (() => { calls++; return { status: 1 }; }) as any };
  expect(await ensureDisplay(dir, options)).toEqual({ blocker: 'image_missing' });
  fs.writeFileSync(marker, '');
  expect(await ensureDisplay(dir, options)).toEqual({ blocker: 'image_rebuild_pending' });
  expect(calls).toBe(0);
  fs.writeFileSync(marker, 'display=plugin\n');
  expect(await ensureDisplay(dir, { ...options, sessionAlive: () => false })).toEqual({ blocker: 'display_start_failed' });
  expect(calls).toBe(1);
});

test('concurrent display requests share one owner and wait for its socket', async () => {
  const { ensureDisplay } = await import('../scripts/browser-display');
  const dir = freshDir(), marker = path.join(dir, 'marker'), socket = path.join(dir, 'vnc.sock');
  fs.writeFileSync(marker, 'display=plugin\n');
  let calls = 0, running = false;
  const options = {
    deployment: 'container' as const, platform: 'linux' as const, marker, available: true, waitMs: 1000,
    sessionAlive: () => running,
    spawn: (() => {
      calls++; running = true;
      fs.writeFileSync(path.join(dir, 'state/browser-display.json'), JSON.stringify({ pid: process.pid, display: ':13', vncSocket: socket }));
      setTimeout(() => fs.writeFileSync(socket, ''), 50);
      return { status: 0 };
    }) as any,
  };
  const results = await Promise.all([ensureDisplay(dir, options), ensureDisplay(dir, options)]);
  expect(results).toEqual([{ display: ':13', vncSocket: socket }, { display: ':13', vncSocket: socket }]);
  expect(calls).toBe(1);
});

test('status and stop verbs are bounded and report readiness', async () => {
  const { browserDisplayStatus } = await import('../scripts/browser-display');
  const dir = freshDir(), socket = path.join(dir, 'vnc.sock');
  const options = { deployment: 'container' as const, platform: 'linux' as const };
  expect(browserDisplayStatus(dir, options)).toEqual({ display: 'down', viewer: 'off' });
  fs.writeFileSync(path.join(dir, 'config.json'), '{"browser":{"port":6090}}');
  expect(browserDisplayStatus(dir, options)).toEqual({ display: 'down', viewer: 'down' });
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(socket, '');
  fs.writeFileSync(path.join(dir, 'state/browser-display.json'), JSON.stringify({ pid: process.pid, display: ':14', vncSocket: socket, viewer: 'up' }));
  expect(browserDisplayStatus(dir, options)).toEqual({ display: 'up', viewer: 'up' });
  for (const verb of ['status', 'stop']) {
    const child = Bun.spawn([process.execPath, path.join(PLUGIN_ROOT, 'scripts/browser-display.ts'), verb], {
      env: { ...process.env, AGENT_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    if (verb === 'status') expect(JSON.parse(output)).toHaveProperty('viewer');
  }
});

test('display profile, socket, reservations and viewer bind follow deployment', async () => {
  const { browserDisplaySettings } = await import('../scripts/browser-display');
  const root = freshDir(), dir = path.join(root, '.hermit');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"browser":{"port":6090}}');
  const previous = process.env.HERMIT_BROWSER_VIEWER_BIND;
  try {
    delete process.env.HERMIT_BROWSER_VIEWER_BIND;
    const host = browserDisplaySettings(dir, 'host'), container = browserDisplaySettings(dir, 'container');
    expect(host.profile).toBe(path.join(fs.realpathSync(root), '.claude.local/browser/profile'));
    expect(container.profile).toBe('/home/claude/.claude/browser/profile');
    expect(host.vncSocket).toBe(path.join(browserSocketDir(dir), 'vnc.sock'));
    expect(container.vncSocket).toBe(host.vncSocket);
    expect(container.reservations).toBe(browserSocketDir(dir));
    expect(host.viewerBind).toBe('127.0.0.1:6090');
    expect(container.viewerBind).toBeUndefined();
    process.env.HERMIT_BROWSER_VIEWER_BIND = '127.0.0.1:6099';
    expect(browserDisplaySettings(dir, 'container').viewerBind).toBe('127.0.0.1:6099');
  } finally {
    if (previous === undefined) delete process.env.HERMIT_BROWSER_VIEWER_BIND;
    else process.env.HERMIT_BROWSER_VIEWER_BIND = previous;
  }
});
