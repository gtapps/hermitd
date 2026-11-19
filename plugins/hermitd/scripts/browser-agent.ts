#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserSocketDir, browserDeployment, browserEnabled, browserProfile, browserDataDir, browserHostPlatform, browserUserAgent, installedBrowser, type BrowserDeployment } from './lib/browser-runtime';
export { browserSocketDir } from './lib/browser-runtime';
import { ensureDisplay, type DisplayResult } from './browser-display';
import { hermitDir } from './lib/cc-compat';
import { browserLease, persistentChromeAlive, type PendingStore } from './lib/browser-lease';
import { acquireLockWithWait, releaseLock, pidAlive as alive } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { failJson, printJson, readJson } from './lib/cli';
import { readProxyInfo } from './lib/credproxy-env';
import { privateEnvPath, upsertEnvVar } from './lib/env-file';

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

const STORE_SINK = 'data:text/html,<textarea id=p></textarea>';
const STORE_FIELD = '#p';

type StoreRequest = { name: string; file: string } | 'cancel' | 'bad_name' | 'bad_destination';
type StoreCommand = (step: string, args: string[]) => Promise<string>;

function storeRefusal(reason: string): number {
  printJson({ status: 'refused', reason });
  return 0;
}

async function overwriteClipboard(run: StoreCommand, placeholder: string): Promise<void> {
  await run('fill', ['fill', STORE_FIELD, placeholder]);
  await run('select', ['press', 'Control+a']);
  await run('copy', ['clipboard', 'copy']);
}

async function cleanStore(run: StoreCommand, placeholder: string, sinkOpen = false): Promise<void> {
  try {
    if (!sinkOpen) await run('open', ['open', STORE_SINK]);
    await overwriteClipboard(run, placeholder);
  } finally {
    await run('blank', ['open', 'about:blank']);
  }
}

async function storeCopied(request: StoreRequest, pending: PendingStore | undefined, projectRoot: string, run: StoreCommand,
  update: (store?: Omit<PendingStore, 'task' | 'handed_back'>) => void): Promise<number> {
  if (request === 'bad_name' || request === 'bad_destination') return storeRefusal(pending ? 'mismatch' : request);
  if (request !== 'cancel' && pending && (pending.name !== request.name || pending.file !== request.file)) {
    return storeRefusal('mismatch');
  }
  const placeholder = pending?.placeholder ?? randomUUID();
  let step = 'open';
  let temporaryTab = false;
  let sinkOpen = false;
  const command: StoreCommand = (name, args) => {
    step = name;
    return run(name, args);
  };
  const cleanup = async () => {
    let failed = false;
    // A preparation that failed outside its own tab copied nothing: leave the console page alone.
    if (pending || temporaryTab) {
      try { await cleanStore(run, placeholder, sinkOpen); } catch { failed = true; }
    }
    if (temporaryTab) {
      try { await run('tab_close', ['tab', 'close']); } catch { failed = true; }
    }
    if (pending) {
      try { update(); } catch { failed = true; }
    }
    return failed;
  };
  if (request === 'cancel') {
    if (pending) await cleanup();
    printJson({ status: 'cancelled' });
    return 0;
  }
  const { name, file } = request;
  let value: string;
  try {
    if (!pending) {
      await command('tab_new', ['tab', 'new', STORE_SINK]);
      temporaryTab = sinkOpen = true;
      await overwriteClipboard(command, placeholder);
      await command('tab_close', ['tab', 'close']);
      temporaryTab = sinkOpen = false;
      step = 'prepare';
      update({ name, file, placeholder });
    }
    if (!pending?.handed_back) {
      printJson({ status: 'armed', var: name });
      return 0;
    }
    await command('open', ['open', STORE_SINK]);
    sinkOpen = true;
    await command('click', ['click', STORE_FIELD]);
    await command('paste', ['clipboard', 'paste']);
    const output = await command('get_value', ['--json', 'get', 'value', STORE_FIELD]);
    const result = JSON.parse(output);
    if (result.success !== true || typeof result.data?.value !== 'string') throw new Error('invalid_result');
    value = result.data.value;
    let refusal: string | undefined;
    if (!value || value === placeholder) refusal = 'nothing_copied';
    else if (/[\r\n\u2028\u2029]/u.test(value)) refusal = 'multiline';
    else if (/[\s\p{Cc}]/u.test(value) || Buffer.byteLength(value) > 4096) refusal = 'bad_value';
    else if (privateEnvPath(projectRoot, file) !== file) refusal = 'bad_destination';
    if (refusal) {
      await cleanup();
      return storeRefusal(refusal);
    }
    step = 'write';
    upsertEnvVar(file, name, value);
  } catch {
    await cleanup();
    printJson({ error: `store_failed:${step}` });
    return 1;
  }
  const failed = await cleanup();
  printJson({ status: 'saved', var: name, length: value.length, ...(failed ? { cleanup: 'failed' } : {}) });
  return 0;
}

interface AgentOptions { deployment?: BrowserDeployment; data?: string; platform?: NodeJS.Platform; waitMs?: number; marker?: string; ensureDisplay?: (dir: string) => Promise<DisplayResult> }
export async function runBrowserAgent(argv: string[], realBinary?: string, chromeAlive = persistentChromeAlive, options: AgentOptions = {}): Promise<number> {
  const dir = hermitDir();
  const projectRoot = path.dirname(dir);
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
  // The browser keeps each site's own certificate: it never goes through the credential proxy.
  const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const credproxy = proxyKeys.some(key => env[key]) ? readProxyInfo()?.address : undefined;
  for (const key of proxyKeys) if (credproxy && env[key] === credproxy) delete env[key];
  // Ambient session/profile switches must not silently change the supported path.
  delete env.AGENT_BROWSER_SESSION;
  delete env.AGENT_BROWSER_SESSION_NAME;
  delete env.AGENT_BROWSER_NAMESPACE;
  delete env.AGENT_BROWSER_PROFILE;
  delete env.AGENT_BROWSER_HEADED;
  delete env.AGENT_BROWSER_CONFIG;
  delete env.AGENT_BROWSER_USER_AGENT;
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
  // Launch-policy flags cannot override the wrapper's profile, socket dir, idle policy, headed
  // mode or user agent. --task is the wrapper's own, so it never reaches the real binary.
  if (task && host && (options.platform ?? browserHostPlatform()) === 'darwin') {
    printJson({ error: 'takeover_unsupported' }); return 1;
  }
  env.AGENT_BROWSER_CONFIG = install?.config ?? path.join(socketDir, 'config.json');
  if (!install) writeFileAtomic(env.AGENT_BROWSER_CONFIG, '{}\n', 0o600);
  let chromeVersion = install?.chromeVersion;
  const marker = options.marker ?? '/etc/hermit/managed-browser';
  if (host && install) env.AGENT_BROWSER_EXECUTABLE_PATH = install.chrome;
  else if (host) delete env.AGENT_BROWSER_EXECUTABLE_PATH;
  else if (fs.existsSync(marker)) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = '/opt/chrome-linux64/chrome';
    chromeVersion = fs.readFileSync(marker, 'utf8').split('\n').find(line => line.startsWith('chrome='))?.slice('chrome='.length);
  }
  else delete env.AGENT_BROWSER_EXECUTABLE_PATH;
  const baseArgs = [...host ? [] : ['--no-sandbox'], '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled'];
  const policyFlags = new Set(['--profile', '--args', '--executable-path', '--namespace', '--session-name', '--config', '--idle-timeout', '--task', '--user-agent']);
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
  const verb = args[0] === '--session' ? args[2] : args[0]?.startsWith('--session=') ? args[1] : args[0];
  let storeRequest: StoreRequest | undefined;
  if (verb === 'store-copied') {
    if (session) return storeRefusal('persistent_only');
    const [, name, file] = args;
    if (name === '--cancel' && args.length === 2) storeRequest = 'cancel';
    else if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) storeRequest = 'bad_name';
    else {
      const destination = file && args.length === 3 ? privateEnvPath(projectRoot, file) : null;
      storeRequest = destination ? { name, file: destination } : 'bad_destination';
    }
  }
  const closing = verb === 'close';
  // Every token: navigation has aliases, URLs may be schemeless and a session may be named open.
  for (const arg of storeRequest ? [] : args) {
    try {
      const hostname = new URL(arg.includes('://') ? arg : `https://${arg}`).hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
      if (['169.254.169.254', 'metadata.google.internal', 'metadata.goog', '100.100.100.200', 'fd00:ec2::254'].includes(hostname)) {
        printJson({ error: 'metadata_url_refused' }); return 1;
      }
    } catch {}
  }
  let epoch: number | undefined;
  let pending: PendingStore | undefined;
  const leaseOptions = { chromeAlive: () => chromeAlive(dir) };
  const inspect = () => browserLease('inspect', undefined, dir, Date.now(), leaseOptions);
  if (session) {
    const userAgent = browserUserAgent(chromeVersion, host ? (options.platform ?? browserHostPlatform()) : 'linux');
    // Chrome's own flag, not AGENT_BROWSER_USER_AGENT: the CDP override empties Sec-CH-UA.
    env.AGENT_BROWSER_ARGS = [...baseArgs, ...userAgent ? [`--user-agent=${userAgent}`] : []].join('\n');
    if (!sessionAdmission(socketDir, session)) {
      printJson({ error: 'session_cap' });
      return 1;
    }
  } else {
    // A task whose claim expired must not drive the page the next holder opened.
    const before = inspect();
    epoch = before.epoch;
    pending = before.pending_store;
    if (before.human) { printJson({ error: 'human_has_control' }); return 1; }
    const renewed = browserLease('renew', task, dir, Date.now(), leaseOptions);
    if (renewed.status === 'human') { printJson({ error: 'human_has_control' }); return 1; }
    if (renewed.status !== 'claimed') {
      printJson({ error: 'browser_not_claimed', ...(renewed.holder ? { holder: renewed.holder } : {}) });
      return 1;
    }
    if (pending && pending.task === task && !storeRequest && !closing) return storeRefusal('store_pending');
    if (argv.at(-1) !== 'close') {
      const display = await (options.ensureDisplay ?? (target => ensureDisplay(target, { deployment, marker: options.marker })))(dir);
      if ('blocker' in display) {
        const detail = host
          ? 'Run hermitd run browser-host for the always-on tmux display.'
          : 'Managed browser display unavailable: run `hermitd update` on the Docker host.';
        printJson({ error: 'browser_display_missing', reason: display.blocker, detail }); return 1;
      }
      env.DISPLAY = display.display;
    }
    env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '0';
    env.AGENT_BROWSER_HEADED = '1';
    env.AGENT_BROWSER_PROFILE = browserProfile(dir, deployment);
    env.AGENT_BROWSER_ARGS = [...baseArgs, '--window-size=500,1082', '--window-position=0,0'].join('\n');
  }
  if (!session && (storeRequest || pending)) {
    const lock = path.join(socketDir, 'store.lock');
    if (!acquireLockWithWait(lock, 2000)) {
      printJson({ error: 'store_failed:lock' });
      return 1;
    }
    try {
      const checkClaim = () => {
        const lease = inspect();
        if (lease.epoch !== epoch || lease.human || lease.holder !== task) throw new Error('stale_store');
        return lease;
      };
      const run: StoreCommand = async (_step, command) => {
        checkClaim();
        const readValue = command[0] === '--json';
        const child = Bun.spawn([realBinary, ...command], { env, stdin: 'ignore', stdout: readValue ? 'pipe' : 'ignore', stderr: 'ignore' });
        const [output, code] = await Promise.all([child.stdout ? new Response(child.stdout).text() : '', child.exited]);
        checkClaim();
        if (code !== 0) throw new Error('upstream_failed');
        return output;
      };
      const update = (store?: Omit<PendingStore, 'task' | 'handed_back'>) => {
        const result = browserLease(store ? 'prepare-store' : 'clear-store', task, dir, Date.now(), { ...leaseOptions, epoch, store });
        if (result.status !== 'updated') throw new Error('stale_store');
      };
      pending = checkClaim().pending_store;
      if (pending && (pending.task !== task || closing)) {
        await cleanStore(run, pending.placeholder).catch(() => {});
        update();
        pending = undefined;
      }
      if (storeRequest) return await storeCopied(storeRequest, pending, projectRoot, run, update);
      if (pending) return storeRefusal('store_pending');
    } catch {
      printJson({ error: 'store_failed:lease' });
      return 1;
    } finally {
      releaseLock(lock);
    }
  }
  try {
    const child = Bun.spawn([realBinary, ...args], { env, stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(), child.exited,
    ]);
    if (host && new TextDecoder().decode(stderr).includes('No usable sandbox')) {
      printJson({ error: 'browser_sandbox_blocked', detail: 'Run hermitd run browser-host. For Claude Code /sandbox set sandbox.excludedCommands to include: bun */scripts/browser-agent.ts *' }); return 1;
    }
    const after = session ? null : inspect();
    if (after && (after.epoch !== epoch || after.human)) { printJson({ error: 'human_has_control' }); return 1; }
    if (after?.pending_store) return storeRefusal('store_pending');
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
