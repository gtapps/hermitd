// Launch and resolve task-bound helpers on enrolled Remote Control environments.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { emitJson, exitError, readStdin } from './lib/cli';
import { pinStateDirOrExit } from './lib/cc-compat';
import { readConfigRaw } from './lib/config-read';
import { acquireLockWithWait, releaseLock } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { HELPER_OWNER, readTasks, TASK_ID } from './lib/tasks';
import { capturePane } from './lib/tmux';
import { submitHelperReport } from './lib/helper-reports';
import { postToSession } from './lib/peer-post';
import { renderHelperPrompt } from './lib/helper-prompt';
import { residentPeerName } from './lib/session-registry';
import { readRuntimeJson } from './lib/runtime';
import { type Binding, bindingFile, bridgeSessionId, ENV_ID, parseReport, readCloudBindings } from './lib/cloud-bindings';

const LOGIN_RE = /must be logged in|claude\.ai subscription|please run \/login/i;
const LAUNCH_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

type StartOptions = {
  environment: string;
  task: string;
  helper: string;
  model?: string;
  effort?: string;
  promptFile: string;
};

function runTmux(args: string[]): boolean {
  return spawnSync('tmux', args, { stdio: 'ignore', timeout: 5000 }).status === 0;
}

function saveCloudBindings(dir: string, entries: Binding[]): void {
  writeFileAtomic(bindingFile(dir), JSON.stringify(entries, null, 2) + '\n');
}

async function withBindingLock<T>(dir: string, operation: () => T | Promise<T>): Promise<T> {
  const lock = bindingFile(dir) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (!acquireLockWithWait(lock, 5000)) throw new Error('bindings_busy');
  try {
    return await operation();
  } finally {
    releaseLock(lock);
  }
}

function pruneClosed(dir: string, entries: Binding[]): Binding[] {
  if (!entries.length) return entries;
  const live = new Set(readTasks(dir).filter(task => task.status === 'open').map(task => task.id));
  return entries.filter(entry => live.has(entry.task));
}

export async function start(dir: string, options: StartOptions, timeoutMs = LAUNCH_TIMEOUT_MS) {
  const config = readConfigRaw(dir);
  if (config?.remote !== true) return { status: 'refused', reason: 'remote_off' };
  const environments = config.remote_environments ?? {};
  const id = Object.hasOwn(environments, options.environment) ? environments[options.environment] : undefined;
  if (typeof id !== 'string' || !ENV_ID.test(id)) {
    return { status: 'refused', reason: 'unknown_environment' };
  }

  const task = readTasks(dir).find(record => record.id === options.task && record.status === 'open');
  if (!task) return { error: 'task_not_open' };
  if (task.owner !== 'helper:' + options.helper) return { error: 'not_owner' };
  const resident = residentPeerName(dir);
  if (!resident) return { error: 'resident_not_named' };
  const template = fs.readFileSync(path.resolve(import.meta.dirname, '../prompts/helper.md'), 'utf8');
  const guidance = renderHelperPrompt(template, 'cloud', { RESIDENT_NAME: resident });
  const brief = fs.readFileSync(options.promptFile, 'utf8');
  const prompt = `${guidance}\nTask ${task.id} for helper:${options.helper}\n\n${task.title}\n\n${task.body}\n\n${brief}`;
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  const pane = 'hermit-cloud-' + randomUUID();
  const settings = path.join(state, pane + '.json');
  const args = ['new-session', '-d', '-s', pane, '-c', path.dirname(dir), '--',
    'claude', '--settings', settings, '-n', options.helper];
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  args.push('--cloud', prompt);

  let sessionId: string | undefined;
  try {
    fs.writeFileSync(settings, JSON.stringify({ remote: { defaultEnvironmentId: id } }), { mode: 0o600, flag: 'wx' });
    if (!runTmux(args)) return { error: 'tmux_failed' };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const paneText = capturePane(pane);
      if (paneText === null) break;
      if (LOGIN_RE.test(paneText)) return { error: 'not_logged_in' };
      if (paneText.includes('Created cloud session')) {
        sessionId = paneText.match(/\bsession_[A-Za-z0-9]+\b/)?.[0];
        if (sessionId) break;
      }
      Bun.sleepSync(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
    if (!sessionId) return { error: 'launch_timeout' };
  } finally {
    runTmux(['kill-session', '-t', pane]);
    fs.rmSync(settings, { force: true });
  }

  const binding: Binding = {
    session_id: sessionId, task: options.task, helper: options.helper,
    environment: options.environment, started_at: new Date().toISOString(), ingested: [],
  };
  await withBindingLock(dir, () => {
    const entries = pruneClosed(dir, readCloudBindings(dir));
    saveCloudBindings(dir, [...entries, binding]);
  });
  return { status: 'started', session_id: sessionId };
}

function lookup(dir: string, flag: string, value: string) {
  return withBindingLock(dir, () => {
    const all = readCloudBindings(dir);
    const live = pruneClosed(dir, all);
    if (live.length !== all.length) saveCloudBindings(dir, live);
    const entry = live.findLast(row => flag === '--task' ? row.task === value : row.session_id === bridgeSessionId(value));
    if (!entry) return { status: 'no_match' };
    const { task, helper, environment, session_id } = entry;
    return { task, helper, environment, session_id };
  });
}

const REPORT_FAILURES = new Set([
  'not_owner', 'closed', 'empty', 'report_too_long', 'report_outside_state', 'consent_required',
  'not_found', 'invalid_author', 'invalid_kind', 'invalid_report_id', 'report_id_exhausted', 'bindings_busy',
]);
const knownFailure = (reason: unknown) => typeof reason === 'string' && REPORT_FAILURES.has(reason) ? reason : 'operation_failed';

async function ingest(dir: string, sessionId: string, promptId: string, text: string) {
  let task: string | undefined;
  type Outcome = { status: 'stored' | 'duplicate' } | { status: 'failed'; reason: string };
  const failed = (reason: string): Outcome => ({ status: 'failed', reason });
  let outcome: Outcome;
  try {
    outcome = await withBindingLock(dir, async (): Promise<Outcome> => {
      const entries = readCloudBindings(dir);
      const entry = entries.findLast(row => row.session_id === sessionId);
      if (!entry) return failed('no_match');
      task = entry.task;
      if (entry.ingested.includes(promptId)) return { status: 'duplicate' };

      const report = parseReport(text);
      if (!report) return failed('invalid_header');
      if (report.task !== task) return failed('wrong_task');
      const result = await submitHelperReport(dir, task, { as: 'helper:' + entry.helper, kind: report.kind }, report.body);
      if (result && typeof result === 'object' && 'recorded' in result && result.recorded === true) {
        entry.ingested = [...entry.ingested, promptId].slice(-20);
        saveCloudBindings(dir, entries);
        return { status: 'stored' };
      }
      const reason = result && typeof result === 'object' && 'reason' in result ? result.reason : undefined;
      return failed(knownFailure(reason));
    });
  } catch (error) {
    outcome = failed(knownFailure(error instanceof Error ? error.message : ''));
    // A busy writer prevents the locked lookup. The atomic binding file still
    // supplies the task name for the failure notice.
    if (!task) {
      try { task = readCloudBindings(dir).findLast(row => row.session_id === sessionId)?.task; } catch {}
    }
  }
  if (task && TASK_ID.test(task) && outcome.status !== 'duplicate') {
    const socket = readRuntimeJson(path.join(dir, 'state'))?.inbox_socket;
    if (typeof socket === 'string' && socket) {
      await postToSession(socket, outcome.status === 'failed'
        ? `CLOUD_REPORT_FAILED ${task} ${outcome.reason}`
        : `CLOUD_REPORT_STORED ${task}`);
    }
  }
  return outcome;
}

function flags(args: string[], allowed: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!allowed.includes(flag) || Object.hasOwn(values, flag) || !value) exitError();
    values[flag] = value;
  }
  return values;
}

if (import.meta.main) {
  const [verb, dirArg, ...args] = process.argv.slice(2);
  if (!dirArg) exitError();
  const dir = pinStateDirOrExit(dirArg);
  try {
    switch (verb) {
      case 'start': {
        const options = flags(args, ['--environment', '--task', '--helper', '--model', '--effort', '--prompt-file']);
        const environment = options['--environment'];
        const task = options['--task'];
        const helper = options['--helper'];
        const promptFile = options['--prompt-file'];
        if (!environment || !TASK_ID.test(task) || !HELPER_OWNER.test('helper:' + helper) || !helper || !promptFile) exitError();
        emitJson(await start(dir, { environment, task, helper, promptFile, model: options['--model'], effort: options['--effort'] }));
      }
      case 'lookup': {
        const options = flags(args, ['--task', '--from']);
        if (args.length !== 2) exitError();
        emitJson(await lookup(dir, args[0], options[args[0]]));
      }
      case 'ingest': {
        const options = flags(args, ['--from', '--prompt-id']);
        const sessionId = bridgeSessionId(options['--from'] ?? '');
        const promptId = options['--prompt-id'];
        if (!sessionId || !promptId) exitError();
        emitJson(await ingest(dir, sessionId, promptId, await readStdin()));
      }
      default: exitError();
    }
  } catch (error) {
    exitError(error instanceof Error && error.message === 'bindings_busy' ? 'bindings_busy' : 'operation_failed');
  }
}
