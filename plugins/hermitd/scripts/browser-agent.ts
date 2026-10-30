#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hermitDir } from './lib/cc-compat';
import { browserLease } from './lib/browser-lease';
import { acquireLockWithWait, releaseLock, pidAlive as alive } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { printJson } from './lib/cli';

const REAL_BINARY = `/usr/lib/node_modules/agent-browser/bin/agent-browser-linux-${process.arch}`;

// Runtime sockets must not be shared with other hermits on the fleet mesh.
export function browserSocketDir(dir: string): string {
  return `/tmp/hermit-browser-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`;
}

/** Reserve admission while the CLI starts a daemon, without holding a long lock. */
function sessionAdmission(socketDir: string, session: string, remove = false): boolean {
  const file = path.join(socketDir, 'admissions.json');
  const lock = `${file}.lock`;
  if (!acquireLockWithWait(lock, 2000)) throw new Error('browser_lock_unavailable');
  try {
    let pending: Record<string, number[]> = {};
    try { pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const [name, pids] of Object.entries(pending)) {
      pending[name] = pids.filter(pid => alive(pid) && !(remove && name === session && pid === process.pid));
      if (!pending[name].length) delete pending[name];
    }
    const live = new Set(Object.keys(pending));
    for (const name of fs.readdirSync(socketDir)) {
      if (!name.endsWith('.pid') || name === 'default.pid') continue;
      const pid = Number(fs.readFileSync(path.join(socketDir, name), 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) live.add(name.slice(0, -4));
    }
    if (!remove && !live.has(session) && live.size >= 3) return false;
    if (!remove) pending[session] = [...(pending[session] ?? []), process.pid];
    writeFileAtomic(file, JSON.stringify(pending) + '\n', 0o600);
    return true;
  } finally { releaseLock(lock); }
}

export async function runBrowserAgent(argv: string[], realBinary = REAL_BINARY): Promise<number> {
  const pluginRoot = process.env.HERMIT_PLUGIN_ROOT;
  if (!pluginRoot || !fs.existsSync(path.join(pluginRoot, 'scripts/browser-agent.ts'))) {
    printJson({ error: 'plugin_unavailable', detail: 'Managed browser requires the hermit plugin.' });
    return 1;
  }
  const dir = hermitDir();
  const env = { ...process.env };
  // Ambient session/profile switches must not silently change the supported path.
  delete env.AGENT_BROWSER_SESSION;
  delete env.AGENT_BROWSER_SESSION_NAME;
  delete env.AGENT_BROWSER_NAMESPACE;
  delete env.AGENT_BROWSER_PROFILE;
  delete env.AGENT_BROWSER_HEADED;
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
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '0';
  // Launch-policy flags cannot override the wrapper's profile or headed mode.
  const policyFlags = new Set(['--profile', '--args', '--executable-path']);
  const argsWithoutPolicy: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (policyFlags.has(argv[i])) { i++; continue; }
    if ([...policyFlags].some(flag => argv[i].startsWith(flag + '='))) continue;
    if (argv[i] === '--headed' || argv[i].startsWith('--headed=')) continue;
    argsWithoutPolicy.push(argv[i]);
  }
  let args = argsWithoutPolicy;
  if (session) {
    env.AGENT_BROWSER_ARGS = '--no-sandbox';
    if (!sessionAdmission(socketDir, session)) {
      printJson({ error: 'session_cap' });
      return 1;
    }
  } else {
    if (browserLease('renew', undefined, dir).status !== 'claimed') {
      printJson({ error: 'browser_not_claimed' });
      return 1;
    }
    env.DISPLAY = ':1';
    env.AGENT_BROWSER_HEADED = '1';
    env.AGENT_BROWSER_PROFILE = '/home/claude/.claude/browser/profile';
    env.AGENT_BROWSER_ARGS = '--no-sandbox,--window-size=500,1082,--window-position=0,0';
  }
  try {
    const child = Bun.spawn([realBinary, ...args], { env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    return await child.exited;
  } finally {
    if (session) sessionAdmission(socketDir, session, true);
  }
}

if (import.meta.main) {
  try { process.exitCode = await runBrowserAgent(process.argv.slice(2)); }
  catch (error) {
    printJson({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}
