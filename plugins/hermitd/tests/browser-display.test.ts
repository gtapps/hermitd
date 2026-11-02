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
