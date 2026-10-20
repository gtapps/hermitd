import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readConfigRaw } from './lib/config-read';
import { writeFileAtomic } from './lib/md-write';
import { collectTree } from './lib/proc';

interface WatchConfig { id: string; description: string; command: string; enabled: boolean }
interface Watch {
  config: WatchConfig;
  child: ChildProcess | null;
  started: number;
  restarts: number;
  lastExit: number | null;
  stderr: string | null;
  delay: number;
  nextStart: number;
  lastError: number | null;
  stopping: boolean;
}

const hermitDir = path.resolve(process.argv[2] ?? '.hermit');
const projectRoot = path.dirname(hermitDir);
const pluginRoot = path.resolve(import.meta.dir, '..');
// Timing overrides are deliberately restricted to subprocess tests.
function timing(name: string, fallback: number): number {
  if (process.env.WATCH_MONITOR_TEST !== '1') return fallback;
  const value = Number(process.env[`WATCH_MONITOR_${name}_MS`]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const pollMs = timing('POLL', 1000);
const initialBackoff = timing('BACKOFF', 5000);
const maxBackoff = timing('MAX_BACKOFF', 300000);
const healthyMs = timing('HEALTHY', 600000);
const errorMs = timing('ERROR', 3600000);
const watches = new Map<string, Watch>();
const runtimePath = path.join(hermitDir, 'state/watch-monitor.runtime.json');
let stopping = false;
let configMtime: number | null | undefined;

function saveRuntime(): void {
  writeFileAtomic(runtimePath, JSON.stringify({
    watches: [...watches.values()].map(w => ({
      id: w.config.id,
      pid: w.child?.pid ?? null,
      started_at: w.started ? new Date(w.started).toISOString() : null,
      restarts: w.restarts,
      last_exit_code: w.lastExit,
      last_stderr_line: w.stderr,
    })),
    updated_at: new Date().toISOString(),
  }) + '\n');
}

function start(w: Watch): void {
  const command = w.config.command
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('${CLAUDE_PROJECT_DIR}', projectRoot);
  w.started = Date.now();
  w.stderr = null;
  const child = spawn('bash', ['-c', command], {
    cwd: projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  w.child = child;
  const stdout = createInterface({ input: child.stdout! });
  const stderr = createInterface({ input: child.stderr! });
  stdout.on('line', line => {
    if (!w.stopping && !stopping) console.log(`WATCH_EVENT [hermit-watch:${w.config.id}] (${w.config.description}) ${line}`);
  });
  stderr.on('line', line => { if (line.trim()) w.stderr = line; });
  child.on('error', error => { w.stderr = error.message; });
  child.on('close', (code, signal) => {
    w.child = null;
    w.lastExit = code;
    if (!w.stopping && !stopping) {
      const now = Date.now();
      if (now - w.started >= healthyMs) {
        w.delay = initialBackoff;
        w.lastError = null;
      }
      if (w.lastError === null || now - w.lastError >= errorMs) {
        console.log(`WATCH_MONITOR_ERROR: ${w.config.id} exit code ${code ?? `null (${signal ?? 'spawn failed'})`}${w.stderr ? `: ${w.stderr}` : ''}`);
        w.lastError = now;
      }
      w.nextStart = now + w.delay;
      w.delay = Math.min(w.delay * 2, maxBackoff);
    }
    saveRuntime();
  });
  saveRuntime();
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch {}
}

async function stop(w: Watch): Promise<void> {
  w.stopping = true;
  const child = w.child;
  if (!child?.pid) return;
  // Freeze the shell before capture so it cannot launch another pipeline during
  // teardown. Children stay in the monitor's process group; never use detached.
  signal(child.pid, 'SIGSTOP');
  const tree = collectTree([child.pid], Number.MAX_SAFE_INTEGER);
  const descendants = tree.pids.slice(1).reverse();
  for (const pid of descendants) signal(pid, 'SIGTERM');
  // Queue the root shell's SIGTERM while it is still frozen, so a loop cannot
  // relaunch its pipeline between SIGCONT and the shell's own termination.
  child.kill('SIGTERM');
  signal(child.pid, 'SIGCONT');
  // Escalation applies only to this watch's captured descendants, never to the
  // monitor group.
  await Bun.sleep(100);
  for (const pid of descendants) signal(pid, 'SIGKILL');
  // Wait for exit, not close: a process outside the captured tree can hold the
  // stdout pipe open indefinitely.
  await new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function reconcile(): Promise<void> {
  let mtime: number | null;
  try { mtime = fs.statSync(path.join(hermitDir, 'config.json')).mtimeMs; } catch { mtime = null; }
  if (mtime === configMtime) return;
  const config = readConfigRaw(hermitDir);
  // An editor's incomplete write must not tear down working watches.
  if (mtime !== null && config === null) return;
  configMtime = mtime;
  const entries: WatchConfig[] = Array.isArray(config?.monitors) ? config.monitors : [];
  // A live edit bypasses validate-config; a malformed entry must not crash the
  // monitor and orphan the other watches' children.
  const enabled = new Map(entries
    .filter(w => w?.enabled === true && typeof w.id === 'string' && typeof w.command === 'string')
    .map(w => [w.id, w]));
  for (const [id, w] of watches) {
    const next = enabled.get(id);
    if (!next || next.command !== w.config.command) {
      await stop(w);
      watches.delete(id);
      saveRuntime();
    } else {
      w.config = next;
    }
  }
  for (const [id, config] of enabled) {
    if (stopping) return;
    if (watches.has(id)) continue;
    const w: Watch = {
      config, child: null, started: 0, restarts: 0, lastExit: null,
      stderr: null, delay: initialBackoff, nextStart: 0, lastError: null, stopping: false,
    };
    watches.set(id, w);
    start(w);
  }
}

fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
saveRuntime();
for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { stopping = true; });
while (!stopping) {
  await reconcile();
  for (const w of watches.values()) {
    if (!stopping && !w.child && Date.now() >= w.nextStart) {
      w.restarts++;
      start(w);
    }
  }
  if (!stopping) await Bun.sleep(pollMs);
}
await Promise.all([...watches.values()].map(stop));
