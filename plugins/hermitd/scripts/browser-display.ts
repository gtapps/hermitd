#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hermitDir } from './lib/cc-compat';
import { readJson } from './lib/cli';
import { readSettledConfig } from './lib/config-read';
import { browserDataDir, browserEnabled, browserHostPlatform, browserProfile, browserSocketDir } from './lib/browser-runtime';
import { acquireLockWithWait, releaseLock, pidAlive } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { getSessionName, tmuxSessionAlive } from './lib/tmux';
import { browserLease } from './lib/browser-lease';

export function browserDisplaySession(resident: string): string { return `browser-${resident}`; }
export function maybeStartBrowserDisplay(runtimeMode: string, dir = hermitDir(), spawn = spawnSync, available?: boolean, sessionAlive = tmuxSessionAlive): void {
  if (runtimeMode !== 'tmux' || browserHostPlatform() !== 'linux' || !(available ?? Bun.which('Xvnc')) || !browserEnabled(dir)) return;
  try {
    const session = browserDisplaySession(getSessionName(readSettledConfig(dir)));
    if (sessionAlive(session)) return;
    spawn('tmux', ['new-session', '-d', '-s', session, '-c', path.dirname(dir), process.execPath, path.join(import.meta.dir, 'browser-display.ts'), 'run'], { stdio: 'ignore' });
  } catch (error) { console.error(`[hermit] Browser display: ${error instanceof Error ? error.message : error}`); }
}
export function reserveDisplay(data: string, socketBusy: (number: number) => boolean = number => fs.existsSync(`/tmp/.X11-unix/X${number}`) || fs.existsSync(`/tmp/.X${number}-lock`)): { display: string; reservation: string } {
  fs.mkdirSync(data, { recursive: true });
  const lock = path.join(data, 'display.lock');
  if (!acquireLockWithWait(lock, 2000)) throw new Error('browser_display_lock_unavailable');
  try {
    for (let number = 10; number < 1000; number++) {
      const reservation = path.join(data, `display-${number}.json`);
      const pid = readJson(reservation)?.pid;
      if ((pid && pidAlive(pid)) || socketBusy(number)) continue;
      writeFileAtomic(reservation, JSON.stringify({ pid: process.pid }) + '\n', 0o600);
      return { display: `:${number}`, reservation };
    }
    throw new Error('browser_displays_exhausted');
  } finally { releaseLock(lock); }
}
function profileAlive(profile: string): boolean {
  try {
    const pid = Number(fs.readlinkSync(path.join(profile, 'SingletonLock')).split('-').at(-1));
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch { return false; }
}
export async function runBrowserDisplay(dir = hermitDir()): Promise<void> {
  if (browserHostPlatform() !== 'linux') throw new Error('takeover_unsupported');
  if (!browserEnabled(dir)) return;
  const file = path.join(dir, 'state/browser-display.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + '.lock';
  if (!acquireLockWithWait(lock, 2000)) throw new Error('browser_display_lock_unavailable');
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let owned: ReturnType<typeof reserveDisplay> | undefined;
  let stopping = false;
  let finish: () => void = () => {};
  const stop = () => { stopping = true; finish(); };
  try {
    const old = readJson(file);
    if (old?.pid && pidAlive(old.pid)) return;
    const socketDir = browserSocketDir(dir);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(socketDir, 0o700);
    const vncSocket = path.join(socketDir, 'vnc.sock');
    // Only this hermit's socket and recorded, dead X server may be stale.
    if (old?.vncSocket === vncSocket && !pidAlive(old.xvncPid ?? 0)) fs.rmSync(vncSocket, { force: true });
    const profile = browserProfile(dir, 'host');
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); fs.chmodSync(profile, 0o700);
    if (!profileAlive(profile)) for (const name of fs.readdirSync(profile)) if (name.startsWith('Singleton')) fs.rmSync(path.join(profile, name));
    owned = reserveDisplay(browserDataDir());
    const xvnc = Bun.spawn(['Xvnc', owned.display, '-geometry', '500x1082', '-depth', '24', '-rfbport', '-1', '-rfbunixpath', vncSocket, '-rfbunixmode', '0600', '-SecurityTypes', 'None', '-nolisten', 'tcp', '-SendCutText=0'], { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' });
    children.push(xvnc);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(vncSocket) && xvnc.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    if (!fs.existsSync(vncSocket)) throw new Error('browser_display_start_failed');
    writeFileAtomic(file, JSON.stringify({ pid: process.pid, xvncPid: xvnc.pid, display: owned.display, vncSocket, profile }) + '\n', 0o600);
    const env = { ...process.env, DISPLAY: owned.display, AGENT_DIR: dir };
    children.push(Bun.spawn(['openbox'], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' }));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    const done = new Promise<void>(resolve => { finish = resolve; });
    const viewer = async () => {
      const config = readSettledConfig(dir);
      if (!config.browser.port) return;
      while (!stopping) {
        const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'browser-viewer.ts')], { env: { ...env, HERMIT_BROWSER_VIEWER_BIND: `127.0.0.1:${config.browser.port}` }, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' });
        children.push(child);
        await child.exited;
        children.splice(children.indexOf(child), 1);
        if (!stopping) await Promise.race([Bun.sleep(1000), done]);
      }
    };
    const loop = viewer();
    await Promise.race([done, xvnc.exited]);
    stopping = true;
    for (const child of children) child.kill();
    await loop;
  } finally {
    stopping = true;
    for (const child of children) { try { child.kill(); } catch {} }
    await Promise.all(children.map(child => child.exited));
    if (owned) {
      fs.rmSync(owned.reservation, { force: true });
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(browserSocketDir(dir), 'vnc.sock'), { force: true });
    }
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    releaseLock(lock);
  }
}
export function stopBrowserDisplay(dir = hermitDir(), spawn = spawnSync, sessionAlive = tmuxSessionAlive): void {
  const session = browserDisplaySession(getSessionName(readSettledConfig(dir)));
  if (!sessionAlive(session)) return;
  browserLease('human-release', undefined, dir);
  browserLease('teardown', 'shutdown', dir);
  spawn(process.execPath, [path.join(import.meta.dir, 'browser-agent.ts'), '--task', 'shutdown', 'close'], { env: { ...process.env, AGENT_DIR: dir }, stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' });
  browserLease('teardown', undefined, dir);
  spawn('tmux', ['kill-session', '-t', `=${session}`], { stdio: 'ignore' });
}
if (import.meta.main) {
  if (process.argv[2] === 'run') await runBrowserDisplay();
  else maybeStartBrowserDisplay('tmux');
}
