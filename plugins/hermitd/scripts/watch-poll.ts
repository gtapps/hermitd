import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { exitError } from './lib/cli';
import { sha256 } from './lib/hash';
import { writeFileAtomic } from './lib/md-write';
import { parseDuration } from './lib/time';
import { DEFAULT_GATE_TIMEOUT_S, validatePrecheckTimeout } from './lib/routines/gate';

interface WatchState {
  check_hash: string;
  state: string | null;
  state_hash: string | null;
  failures: number;
  failing: boolean;
}

const args = process.argv.slice(2);
const id = args.shift();
if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) exitError('invalid_id');
let every = '5m';
let timeout = DEFAULT_GATE_TIMEOUT_S;
if (args[0] === '--every') {
  args.shift();
  every = args.shift() ?? '';
}
if (args[0] === '--timeout') {
  args.shift();
  const raw = args.shift();
  if (!raw || !/^\d+$/.test(raw)) exitError('invalid_timeout');
  timeout = Number(raw);
}
if (args.shift() !== '--' || !args.length || !args.join(' ').trim()) exitError('invalid_check');
const intervalMs = parseDuration(every, NaN);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) exitError('invalid_interval');
if (validatePrecheckTimeout(timeout) !== null) exitError('invalid_timeout');
const check = args.join(' ');
const checkHash = sha256(check);
const root = process.cwd();
const stateDir = path.join(root, '.hermit/state/watch-poll');
const stateFile = path.join(stateDir, `${id}.json`);
const fresh = (): WatchState => ({ check_hash: checkHash, state: null, state_hash: null, failures: 0, failing: false });
let state = fresh();
try {
  const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (previous.check_hash === checkHash) {
    if ((typeof previous.state !== 'string' && previous.state !== null)
      || (typeof previous.state_hash !== 'string' && previous.state_hash !== null)
      || !Number.isInteger(previous.failures) || previous.failures < 0
      || typeof previous.failing !== 'boolean') exitError('invalid_state');
    state = previous;
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') exitError('state_read');
}

function testTiming(name: string, fallback: number): number {
  if (process.env.WATCH_POLL_TEST !== '1') return fallback;
  const value = Number(process.env[`WATCH_POLL_${name}_MS`]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const pollMs = testTiming('EVERY', intervalMs);
const timeoutMs = testTiming('TIMEOUT', timeout * 1000);
let stopping = false;
let child: ChildProcess | null = null;
let wake: (() => void) | null = null;
let stateWriteFailed = false;

function killCheck(): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true;
    killCheck();
    wake?.();
  });
}

function event(kind: string, value: string): void {
  const display = value.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
  console.log(`${kind}: ${display.length > 300 ? display.slice(0, 300) + '…' : display}`);
}

function save(): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    writeFileAtomic(stateFile, JSON.stringify(state) + '\n');
    stateWriteFailed = false;
  } catch {
    if (!stateWriteFailed) event('failing', 'state_write');
    stateWriteFailed = true;
  }
}

async function observe(): Promise<{ value?: string; failure?: string }> {
  return new Promise(resolve => {
    let size = 0;
    const chunks: Buffer[] = [];
    let failure: string | undefined;
    child = spawn('bash', ['-o', 'pipefail', '-c', check], {
      cwd: root, env: { ...process.env, WATCH_LAST_STATE: state.state ?? '' },
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const running = child;
    const timer = setTimeout(() => {
      failure = 'timeout';
      killCheck();
    }, timeoutMs);
    running.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        failure = 'output_too_large';
        killCheck();
      } else chunks.push(chunk);
    });
    running.once('error', () => { failure = 'spawn'; });
    running.once('close', (code, signal) => {
      clearTimeout(timer);
      child = null;
      if (failure) resolve({ failure });
      else if (code !== 0) resolve({ failure: code === null ? signal ?? 'spawn' : String(code) });
      else resolve({ value: Buffer.concat(chunks).toString('utf8').trim() });
    });
  });
}

while (!stopping) {
  const observation = await observe();
  if (stopping) break;
  if (observation.failure !== undefined) {
    state.failures++;
    if (state.failures >= 3 && !state.failing) {
      state.failing = true;
      event('failing', observation.failure);
    }
  } else {
    const value = observation.value!;
    const hash = sha256(value);
    if (state.failing) event('recovered', value);
    else if (state.state_hash === null) event('initial', value);
    else if (state.state_hash !== hash) event('changed', value);
    state = { check_hash: checkHash, state: value, state_hash: hash, failures: 0, failing: false };
  }
  save();
  if (!stopping) await new Promise<void>(resolve => {
    const timer = setTimeout(() => { wake = null; resolve(); }, pollMs);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}
