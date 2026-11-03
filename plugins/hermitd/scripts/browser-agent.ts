#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { browserSocketDir, browserDeployment, browserEnabled, browserProfile, browserDataDir, browserHostPlatform, installedBrowser, managedBrowserMergePending, type BrowserDeployment } from './lib/browser-runtime';
export { browserSocketDir } from './lib/browser-runtime';
import { ensureDisplay, type DisplayResult } from './browser-display';
import { hermitDir } from './lib/cc-compat';
import { browserLease, persistentChromeAlive } from './lib/browser-lease';
import { acquireLockWithWait, releaseLock, pidAlive as alive } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { failJson, printJson, readJson } from './lib/cli';

const REAL_BINARY = `/usr/lib/node_modules/agent-browser/bin/agent-browser-linux-${process.arch}`;

/** Reserve admission while the CLI starts a daemon, without holding a long lock. */
function sessionAdmission(socketDir: string, session: string, remove = false): boolean {
  const file = path.join(socketDir, 'admissions.json');
  const lock = `${file}.lock`;
  if (!acquireLockWithWait(lock, 2000)) throw new Error('browser_lock_unavailable');
  try {
    const pending: Record<string, number[]> = readJson(file) ?? {};
    for (const [name, pids] of Object.entries(pending)) {
      pending[name] = pids.filter(pid => alive(pid) && !(remove && name === session && pid === process.pid));
      if (!pending[name].length) delete pending[name];
    }
    const live = new Set(Object.keys(pending));
    for (const name of fs.readdirSync(socketDir)) {
      if (!name.endsWith('.pid') || name === 'default.pid' || name === 'dashboard.pid') continue;
      // Tolerant read: another session's close can remove its file mid-scan.
      const pid = readJson(path.join(socketDir, name));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) live.add(name.slice(0, -4));
    }
    if (!remove && !live.has(session) && live.size >= 3) return false;
    if (!remove) pending[session] = [...(pending[session] ?? []), process.pid];
    writeFileAtomic(file, JSON.stringify(pending) + '\n', 0o600);
    return true;
  } finally { releaseLock(lock); }
}

interface AgentOptions { deployment?: BrowserDeployment; data?: string; platform?: NodeJS.Platform; waitMs?: number; marker?: string; ensureDisplay?: (dir: string) => Promise<DisplayResult> }
export async function runBrowserAgent(argv: string[], realBinary?: string, chromeAlive = persistentChromeAlive, options: AgentOptions = {}): Promise<number> {
  const dir = hermitDir();
  if (!browserEnabled(dir)) { printJson({ status: 'disabled' }); return 0; }
  const deployment = options.deployment ?? browserDeployment(dir);
  if (deployment === 'docker_host') { printJson({ error: 'docker_host_session' }); return 1; }
  const host = deployment === 'host';
  let install = host ? installedBrowser(options.data) : null;
  // Shutdown must never download a browser or wait for an installer.
  if (host && !install && !realBinary && argv.at(-1) === 'close') {
    printJson({ status: 'closed' }); return 0;
  }
  if (host && !install && !realBinary) {
    const data = options.data ?? browserDataDir();
    const lock = path.join(data, 'install.lock');
    const installError = () => readJson(path.join(data, 'install-error.json'))?.error;
    // A killed installer leaves its lock behind; only a live holder is still downloading.
    const holder = readJson(lock);
    if (Number.isInteger(holder) && alive(holder)) { printJson({ status: 'installing' }); return 0; }
    const error = installError();
    if (error) { printJson({ error: `browser_install_failed:${error}` }); return 1; }
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'browser-install.ts')], { cwd: path.dirname(dir), env: process.env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true });
    child.unref();
    const deadline = Date.now() + (options.waitMs ?? 90_000);
    do {
      await Bun.sleep(100);
      install = installedBrowser(data);
      if (install || installError()) break;
    } while (Date.now() < deadline);
    if (!install) {
      const error = installError();
      printJson(error ? { error: `browser_install_failed:${error}` } : { status: 'installing' });
      return error ? 1 : 0;
    }
  }
  realBinary ??= host ? install!.binary : REAL_BINARY;
  const env = { ...process.env };
  // Ambient session/profile switches must not silently change the supported path.
  delete env.AGENT_BROWSER_SESSION;
  delete env.AGENT_BROWSER_SESSION_NAME;
  delete env.AGENT_BROWSER_NAMESPACE;
  delete env.AGENT_BROWSER_PROFILE;
  delete env.AGENT_BROWSER_HEADED;
  delete env.AGENT_BROWSER_CONFIG;
  // Anonymous sessions keep upstream's idle backstop: one nobody closed frees its cap slot.
  delete env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  delete env.DISPLAY;
  const index = argv.indexOf('--session');
  const equals = argv.find(arg => arg.startsWith('--session='));
  const session = index >= 0 ? argv[index + 1] : equals?.slice('--session='.length);
  if ((index >= 0 || equals) && (!session || !/^[A-Za-z0-9_-]+$/.test(session) || session === 'default')) {
    printJson({ error: 'invalid_session' });
    return 1;
  }
  const socketDir = browserSocketDir(dir);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  env.AGENT_BROWSER_SOCKET_DIR = socketDir;
  const taskIndex = argv.indexOf('--task');
  const task = taskIndex >= 0 ? argv[taskIndex + 1] : argv.find(arg => arg.startsWith('--task='))?.slice('--task='.length);
  // Launch-policy flags cannot override the wrapper's profile, socket dir, idle policy or headed
  // mode. --task is the wrapper's own, so it never reaches the real binary.
  if (task && host && (options.platform ?? browserHostPlatform()) === 'darwin') {
    printJson({ error: 'takeover_unsupported' }); return 1;
  }
  env.AGENT_BROWSER_CONFIG = install?.config ?? path.join(socketDir, 'config.json');
  if (!install) writeFileAtomic(env.AGENT_BROWSER_CONFIG, '{}\n', 0o600);
  if (host && install) env.AGENT_BROWSER_EXECUTABLE_PATH = install.chrome;
  else if (host) delete env.AGENT_BROWSER_EXECUTABLE_PATH;
  else if (fs.existsSync(options.marker ?? '/etc/hermit/managed-browser')) env.AGENT_BROWSER_EXECUTABLE_PATH = '/opt/chrome-linux64/chrome';
  else delete env.AGENT_BROWSER_EXECUTABLE_PATH;
  const resolver = '--host-resolver-rules=MAP 169.254.* ^NOTFOUND';
  const policyFlags = new Set(['--profile', '--args', '--executable-path', '--namespace', '--session-name', '--config', '--idle-timeout', '--task']);
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (policyFlags.has(argv[i])) { i++; continue; }
    if ([...policyFlags].some(flag => argv[i].startsWith(flag + '='))) continue;
    if (argv[i] === '--headed' || argv[i].startsWith('--headed=')) {
      if (argv[i] === '--headed' && ['true', 'false'].includes(argv[i + 1])) i++;
      continue;
    }
    args.push(argv[i]);
  }
  // Every token: navigation has aliases, URLs may be schemeless and a session may be named open.
  for (const arg of args) {
    try {
      const hostname = new URL(arg.includes('://') ? arg : `https://${arg}`).hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
      if (['169.254.169.254', 'metadata.google.internal', 'metadata.goog', '100.100.100.200', 'fd00:ec2::254'].includes(hostname)) {
        printJson({ error: 'metadata_url_refused' }); return 1;
      }
    } catch {}
  }
  let epoch: number | undefined;
  if (session) {
    env.AGENT_BROWSER_ARGS = host ? resolver : `--no-sandbox,${resolver}`;
    if (!sessionAdmission(socketDir, session)) {
      printJson({ error: 'session_cap' });
      return 1;
    }
  } else {
    // A task whose claim expired must not drive the page the next holder opened.
    const before = browserLease('inspect', undefined, dir, Date.now(), { chromeAlive: () => chromeAlive(dir) });
    epoch = before.epoch;
    if (before.human) { printJson({ error: 'human_has_control' }); return 1; }
    const renewed = browserLease('renew', task, dir, Date.now(), { chromeAlive: () => chromeAlive(dir) });
    if (renewed.status === 'human') { printJson({ error: 'human_has_control' }); return 1; }
    if (renewed.status !== 'claimed') {
      printJson({ error: 'browser_not_claimed', ...(renewed.holder ? { holder: renewed.holder } : {}) });
      return 1;
    }
    if (argv.at(-1) !== 'close') {
      const display = await (options.ensureDisplay ?? (target => ensureDisplay(target, { deployment, marker: options.marker })))(dir);
      if ('blocker' in display) {
        let detail = 'Run hermitd run browser-host for the always-on tmux display.';
        if (!host) {
          detail = 'Managed browser display unavailable: run `hermitd update` on the Docker host.';
          const pending = managedBrowserMergePending(dir);
          if (pending) {
            detail = 'Dockerfile.hermit needs the managed-browser merge; ask the hermit to merge Dockerfile.hermit'
              + (pending.parked ? ` (parked copy: ${pending.parked})` : '') + ', then run `hermitd update`.';
          }
        }
        printJson({ error: 'browser_display_missing', reason: display.blocker, detail }); return 1;
      }
      env.DISPLAY = display.display;
    }
    env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '0';
    env.AGENT_BROWSER_HEADED = '1';
    env.AGENT_BROWSER_PROFILE = browserProfile(dir, deployment);
    env.AGENT_BROWSER_ARGS = `${host ? '' : '--no-sandbox,'}${resolver},--window-size=500,1082,--window-position=0,0`;
  }
  try {
    const child = Bun.spawn([realBinary, ...args], { env, stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(), child.exited,
    ]);
    if (host && new TextDecoder().decode(stderr).includes('No usable sandbox')) {
      printJson({ error: 'browser_sandbox_blocked', detail: 'Run hermitd run browser-host. For Claude Code /sandbox set sandbox.excludedCommands to include: bun */scripts/browser-agent.ts *' }); return 1;
    }
    const after = session ? null : browserLease('inspect', undefined, dir, Date.now(), { chromeAlive: () => chromeAlive(dir) });
    if (after && (after.epoch !== epoch || after.human)) { printJson({ error: 'human_has_control' }); return 1; }
    await Bun.write(Bun.stdout, stdout);
    await Bun.write(Bun.stderr, stderr);
    return code;
  } finally {
    // A reservation left behind ends with this pid; it must not replace the child's exit code.
    if (session) try { sessionAdmission(socketDir, session, true); } catch {}
  }
}

if (import.meta.main) {
  try { process.exitCode = await runBrowserAgent(process.argv.slice(2)); }
  catch (error) { failJson(error); }
}
