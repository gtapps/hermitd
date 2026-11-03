#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hermitDir } from './lib/cc-compat';
import { printJson, readJson } from './lib/cli';
import { readSettledConfig } from './lib/config-read';
import { browserDataDir, browserDeployment, browserRuntimeMode, browserEnabled, browserHostPlatform, browserProfile, browserSocketDir, type BrowserDeployment } from './lib/browser-runtime';
import { acquireLock, acquireLockWithWait, releaseLock, pidAlive } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { getSessionName, tmuxSessionAlive } from './lib/tmux';
import { browserLease } from './lib/browser-lease';

export function browserDisplaySession(resident: string): string { return `browser-${resident}`; }
export function maybeStartBrowserDisplay(runtimeMode: string, dir = hermitDir(), spawn = spawnSync, available?: boolean, sessionAlive = tmuxSessionAlive): void {
  if (runtimeMode !== 'tmux' || browserHostPlatform() !== 'linux' || !(available ?? Bun.which('Xvnc')) || !browserEnabled(dir)) return;
  try {
    const session = browserDisplaySession(getSessionName(readSettledConfig(dir)));
    if (sessionAlive(session)) return;
    // A tmux server keeps the environment of whoever started it, possibly another hermit.
    const inherited = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR'].flatMap(name => process.env[name] ? [`${name}=${process.env[name]}`] : []);
    spawn('tmux', ['new-session', '-d', '-s', session, '-c', path.dirname(dir), 'env', `AGENT_DIR=${dir}`, ...inherited, process.execPath, path.join(import.meta.dir, 'browser-display.ts'), 'run'], { stdio: 'ignore' });
  } catch (error) { console.error(`[hermit] Browser display: ${error instanceof Error ? error.message : error}`); }
}
export type DisplayResult = { display: string; vncSocket: string } | { blocker: 'image_rebuild_pending' | 'image_missing' | 'display_start_failed' | 'unsupported' };
interface DisplayOptions {
  deployment?: BrowserDeployment; marker?: string; platform?: NodeJS.Platform;
  spawn?: typeof spawnSync; sessionAlive?: typeof tmuxSessionAlive; available?: boolean;
  waitMs?: number;
}
function displayRecord(dir: string) {
  const record = readJson(path.join(dir, 'state/browser-display.json'));
  return record?.display && record?.vncSocket && pidAlive(record.pid)
    && (!record.xvncPid || pidAlive(record.xvncPid)) && fs.existsSync(record.vncSocket) ? record : null;
}
export function browserDisplayStatus(dir = hermitDir(), options: DisplayOptions = {}) {
  const deployment = options.deployment ?? browserDeployment(dir);
  const supported = (options.platform ?? browserHostPlatform()) === 'linux'
    && (deployment === 'container' || (deployment === 'host' && browserRuntimeMode(dir) === 'tmux'));
  const record = supported ? displayRecord(dir) : null;
  const viewerOn = deployment === 'container' || !!readSettledConfig(dir).browser.port;
  return { display: supported ? record ? 'up' : 'down' : 'unsupported',
    viewer: viewerOn ? record?.viewer === 'up' ? 'up' : 'down' : 'off' };
}
export async function ensureDisplay(dir = hermitDir(), options: DisplayOptions = {}): Promise<DisplayResult> {
  const deployment = options.deployment ?? browserDeployment(dir);
  if ((options.platform ?? browserHostPlatform()) !== 'linux' || !browserEnabled(dir)
    || deployment === 'docker_host' || (deployment === 'host' && browserRuntimeMode(dir) !== 'tmux')) return { blocker: 'unsupported' };
  if (deployment === 'container') {
    let marker: string;
    try { marker = fs.readFileSync(options.marker ?? '/etc/hermit/managed-browser', 'utf8'); }
    catch { return { blocker: 'image_missing' }; }
    if (!marker.split('\n').includes('display=plugin')) return { blocker: 'image_rebuild_pending' };
  }
  if (!(options.available ?? !!Bun.which('Xvnc'))) return { blocker: 'display_start_failed' };
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const lock = path.join(dir, 'state/browser-display-start.lock');
  const deadline = Date.now() + (options.waitMs ?? 12_000);
  let held = false;
  try {
    while (!(held = acquireLock(lock))) {
      if (Date.now() >= deadline) return { blocker: 'display_start_failed' };
      await Bun.sleep(25);
    }
    let record = displayRecord(dir);
    if (record) return { display: record.display, vncSocket: record.vncSocket };
    const session = browserDisplaySession(getSessionName(readSettledConfig(dir)));
    const sessionAlive = options.sessionAlive ?? tmuxSessionAlive;
    if (!sessionAlive(session)) {
      const inherited = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'HERMIT_BROWSER_VIEWER_BIND']
        .flatMap(name => process.env[name] ? [`${name}=${process.env[name]}`] : []);
      const result = (options.spawn ?? spawnSync)('tmux', ['new-session', '-d', '-s', session, '-c', path.dirname(dir),
        'env', `AGENT_DIR=${dir}`, ...inherited, process.execPath, path.join(import.meta.dir, 'browser-display.ts'), 'run'], { stdio: 'ignore' });
      if (result.status !== 0) return { blocker: 'display_start_failed' };
    }
    do {
      record = displayRecord(dir);
      if (record) return { display: record.display, vncSocket: record.vncSocket };
      if (!sessionAlive(session)) return { blocker: 'display_start_failed' };
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    return { blocker: 'display_start_failed' };
  } catch { return { blocker: 'display_start_failed' }; }
  finally { if (held) releaseLock(lock); }
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
export function browserDisplaySettings(dir: string, deployment = browserDeployment(dir)) {
  const socketDir = browserSocketDir(dir);
  const port = readSettledConfig(dir).browser.port;
  return {
    profile: browserProfile(dir, deployment), socketDir, vncSocket: path.join(socketDir, 'vnc.sock'),
    reservations: deployment === 'container' ? socketDir : browserDataDir(),
    viewerBind: deployment === 'container' ? process.env.HERMIT_BROWSER_VIEWER_BIND : port ? `127.0.0.1:${port}` : undefined,
  };
}
export async function runBrowserDisplay(dir = hermitDir()): Promise<void> {
  if (browserHostPlatform() !== 'linux') throw new Error('takeover_unsupported');
  if (!browserEnabled(dir)) return;
  const deployment = browserDeployment(dir);
  if (deployment === 'container') {
    if (!fs.readFileSync('/etc/hermit/managed-browser', 'utf8').split('\n').includes('display=plugin')) throw new Error('image_rebuild_pending');
  }
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
    const { socketDir, vncSocket, profile, reservations } = browserDisplaySettings(dir, deployment);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(socketDir, 0o700);
    // Only this hermit's socket and recorded, dead X server may be stale.
    if (old?.vncSocket === vncSocket && !pidAlive(old.xvncPid ?? 0)) fs.rmSync(vncSocket, { force: true });
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); fs.chmodSync(profile, 0o700);
    if (!profileAlive(profile)) for (const name of fs.readdirSync(profile)) if (name.startsWith('Singleton')) fs.rmSync(path.join(profile, name));
    owned = reserveDisplay(reservations);
    const xvnc = Bun.spawn(['Xvnc', owned.display, '-geometry', '500x1082', '-depth', '24', '-rfbport', '-1', '-rfbunixpath', vncSocket, '-rfbunixmode', '0600', '-SecurityTypes', 'None', '-nolisten', 'tcp', '-SendCutText=0'], { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' });
    children.push(xvnc);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(vncSocket) && xvnc.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    if (!fs.existsSync(vncSocket)) throw new Error('browser_display_start_failed');
    const display = owned.display;
    const publish = (viewer: 'up' | 'down' | 'off') => writeFileAtomic(file, JSON.stringify({ viewer, pid: process.pid, xvncPid: xvnc.pid, display, vncSocket, profile }) + '\n', 0o600);
    publish(deployment === 'container' || readSettledConfig(dir).browser.port ? 'down' : 'off');
    const env = { ...process.env, DISPLAY: owned.display, AGENT_DIR: dir };
    children.push(Bun.spawn(['openbox'], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' }));
    // tmux kill-session delivers SIGHUP, the signal this display normally stops on.
    process.on('SIGHUP', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
    const done = new Promise<void>(resolve => { finish = resolve; });
    const viewer = async () => {
      while (!stopping) {
        // Takeover setup can save the port while this display is already running.
        const { port } = readSettledConfig(dir).browser;
        if (deployment === 'container' || port) {
          const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'browser-viewer.ts')], { env: { ...env, HERMIT_BROWSER_VIEWER_BIND: browserDisplaySettings(dir, deployment).viewerBind }, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
          children.push(child);
          // The child publishes readiness only after Bun.serve has bound its listener.
          for await (const chunk of child.stdout) {
            if (new TextDecoder().decode(chunk).includes('viewer_ready')) { publish('up'); break; }
          }
          await child.exited;
          publish('down');
          children.splice(children.indexOf(child), 1);
        }
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
    process.off('SIGHUP', stop); process.off('SIGTERM', stop); process.off('SIGINT', stop);
    releaseLock(lock);
  }
}
export function stopBrowserDisplay(dir = hermitDir(), spawn = spawnSync, sessionAlive = tmuxSessionAlive): void {
  // A wedged lease must not keep the display alive or abort the hermit's own shutdown.
  try {
    const session = browserDisplaySession(getSessionName(readSettledConfig(dir)));
    if (!sessionAlive(session)) return;
    try {
      browserLease('human-release', undefined, dir);
      browserLease('teardown', 'shutdown', dir);
      spawn(process.execPath, [path.join(import.meta.dir, 'browser-agent.ts'), '--task', 'shutdown', 'close'], { env: { ...process.env, AGENT_DIR: dir }, stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' });
      browserLease('teardown', undefined, dir);
    } finally { spawn('tmux', ['kill-session', '-t', `=${session}`], { stdio: 'ignore' }); }
  } catch (error) { console.error(`[hermit] Browser display: ${error instanceof Error ? error.message : error}`); }
}
if (import.meta.main) {
  const verb = process.argv[2] ?? 'run';
  if (verb === 'status') printJson(browserDisplayStatus());
  else if (verb === 'stop') stopBrowserDisplay();
  else if (verb === 'ensure') printJson(await ensureDisplay());
  else if (verb === 'run') await runBrowserDisplay();
  else { printJson({ error: 'unknown_verb' }); process.exitCode = 1; }
}
