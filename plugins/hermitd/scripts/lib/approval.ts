import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { assertOutside, storeDir } from './credproxy';
import { deriveRenderInputs } from './derive-render-inputs';
import { sha256 } from './hash';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { writeFileAtomic } from './md-write';

export const composeNames: readonly string[] = ['docker-compose.hermit.yml', 'docker-compose.security.yml', 'docker-compose.override.yml'];
const dockerfile = 'Dockerfile.hermit';
const configName = '.hermit/config.json';
const buildHook = 'docker-build.hermit-local.sh';
const netguardDir = '.hermit/docker';
export const contextsName = 'docker-compose.host-contexts.yml';

type Values = Record<string, unknown>;
type RecordFile = {
  applied: string;
  digest: string;
  files: Record<string, string>;
  env: Record<string, string>;
  values: Values;
};
type ApprovalOptions = {
  configRoot?: string;
  waitMs?: number;
  prompt?: (question: string) => string | Promise<string>;
  report?: (message: string) => void;
};
export type ApprovalResult = { code: 0 | 1; applied?: string };

export function approvalStore(project: string, configRoot?: string): string {
  const credentials = storeDir(project, configRoot);
  return path.resolve(path.dirname(credentials), '..', 'approvals', path.basename(credentials));
}

function physicalPath(file: string): string {
  try { return fs.realpathSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || file === path.dirname(file)) throw error;
    return path.join(physicalPath(path.dirname(file)), path.basename(file));
  }
}

function readRecord(store: string): RecordFile | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(store, 'record.json'), 'utf8')) as RecordFile;
    if (!/^set-[A-Za-z0-9]+$/.test(record.applied)) throw new Error('Invalid Docker approval record');
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export function appliedSet(project: string, configRoot?: string): string | undefined {
  const store = physicalPath(approvalStore(project, configRoot));
  try { assertOutside(store, fs.realpathSync(project)); }
  catch { return; }
  const record = readRecord(store);
  return record && path.join(store, record.applied);
}

function fileBytes(file: string): Buffer | undefined {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Docker input is not a regular file: ' + path.basename(file));
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// A build-context input that is a symbolic link is kept as a link, as Docker sends it:
// the host never copies the link's target into the image's build context.
function linkText(file: string): Buffer | undefined {
  try { return fs.lstatSync(file).isSymbolicLink() ? Buffer.from('symbolic link -> ' + fs.readlinkSync(file) + '\n') : undefined; }
  catch { return; }
}

function netguardFiles(project: string, dir = netguardDir): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(project, dir), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? netguardFiles(project, file) : [file];
  }).sort();
}

function writeCopy(set: string, name: string, bytes: Buffer | string): void {
  const file = path.join(set, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}

function renderCopy(set: string, inputs: ReturnType<typeof deriveRenderInputs>, warn: (message: string) => void): boolean {
  if (!inputs || !fs.existsSync(path.join(set, dockerfile))) return false;
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dir, '../render-docker-templates.ts'), set], {
    cwd: '/', encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('Docker file render failed: ' + (result.stderr || result.stdout || result.error?.message || 'no output').trim());
  const report = JSON.parse(result.stdout);
  if (report.reason === 'newer_renderer') warn('[hermit] Docker files use a newer renderer; update the host plugin.');
  if (report.status === 'skipped') return false;
  for (const file of [dockerfile, composeNames[0], 'docker-entrypoint.hermit.sh']) {
    const dest = path.join(set, file);
    if (fs.existsSync(dest) && !linkText(dest)) fs.chmodSync(dest, 0o600);
  }
  return true;
}

function trackedValues(config: Values, inputs: ReturnType<typeof deriveRenderInputs>): Values {
  const enabled = (value: unknown) => (value as { enabled?: boolean } | null)?.enabled !== false;
  return {
    'docker.packages': inputs?.packages,
    'docker.network_mode': inputs?.networkMode,
    'docker.git_identity_mount': inputs?.gitIdentityMount,
    'docker.fleet_mesh': inputs?.fleetMesh,
    'docker.security.managed_ceiling': inputs?.managedCeiling,
    'channel mounts': inputs?.channels,
    'channel plugins': inputs?.channelPlugins,
    'browser.port': inputs?.browserPort,
    'browser.enabled': enabled(config.browser),
    'transcription.enabled': enabled(config.transcription),
  };
}

function trackEnvironment(envBytes: Buffer, compose: string[]): Record<string, string> {
  const values = parseEnv(envBytes.toString());
  const refs = new Set<string>();
  for (const text of compose) {
    for (const match of text.matchAll(/\$\$|\$\{?([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      if (match[1] && match[1] !== 'HERMIT_GH_TOKEN') refs.add(match[1]);
    }
  }
  return Object.fromEntries([...refs].sort().flatMap(key => {
    const value = values[key];
    return Object.hasOwn(values, key) && value !== undefined ? [[key, sha256(value)]] : [];
  }));
}

function collect(project: string, set: string, warn: (message: string) => void): RecordFile {
  const netguard = netguardFiles(project);
  const names = [...composeNames, dockerfile, 'docker-entrypoint.hermit.sh', buildHook, configName, '.env', ...netguard];
  const buildOnly = new Set(['docker-entrypoint.hermit.sh', buildHook, ...netguard]);
  const bytes = new Map<string, Buffer>();
  for (const name of names) {
    const source = path.join(project, name);
    const link = buildOnly.has(name) ? linkText(source) : undefined;
    const data = link ?? fileBytes(source);
    if (data === undefined) continue;
    bytes.set(name, data);
    if (link) {
      fs.mkdirSync(path.dirname(path.join(set, name)), { recursive: true, mode: 0o700 });
      fs.symlinkSync(fs.readlinkSync(source), path.join(set, name));
    } else writeCopy(set, name, data);
  }
  if (!bytes.has(composeNames[0])) throw new Error('No docker-compose.hermit.yml found in ' + project);
  const env = bytes.get('.env') ?? Buffer.alloc(0);
  if (!bytes.has('.env')) writeCopy(set, '.env', env);
  const inputs = deriveRenderInputs(path.join(set, configName));
  const config = JSON.parse(bytes.get(configName)?.toString() ?? '{}') ?? {};
  const rendered = renderCopy(set, inputs, warn);
  const converted = /^# Generated by hermitd \d+\.\d+\.\d+/.test(bytes.get(dockerfile)?.toString() ?? '');
  const contexts: Record<string, { build: { context: string } }> = {};
  if (converted) contexts.hermit = { build: { context: set } };
  if (bytes.has('docker-compose.security.yml') && bytes.has(path.join(netguardDir, 'Dockerfile.hermit-netguard'))) {
    contexts['hermit-netguard'] = { build: { context: path.join(set, netguardDir) } };
  }
  writeCopy(set, contextsName, JSON.stringify(Object.keys(contexts).length ? { services: contexts } : {}, null, 2) + '\n');

  const tracked = [composeNames[1], composeNames[2], buildHook, ...netguard];
  if (!rendered) tracked.push(dockerfile, composeNames[0]);
  const files = Object.fromEntries(tracked.flatMap(name => {
    const data = bytes.get(name);
    return data === undefined ? [] : [[name, sha256(data)]];
  }));
  const compose: string[] = [];
  const digests: Array<[string, string | null]> = [];
  for (const name of names) {
    const data = linkText(path.join(set, name)) ?? fileBytes(path.join(set, name));
    if (composeNames.includes(name)) compose.push(data?.toString('utf8') ?? '');
    digests.push([name, data === undefined ? null : sha256(data)]);
  }
  const digest = sha256(JSON.stringify(digests));
  return { applied: path.basename(set), digest, files, env: trackEnvironment(env, compose), values: trackedValues(config, inputs) };
}

function changedKeys(before: Values, after: Values): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function visible(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function warnCompose(before: string, after: string, report: (message: string) => void): void {
  const existing = new Set(before.split('\n'));
  const keys = new Set<string>();
  for (const line of after.split('\n')) {
    if (existing.has(line)) continue;
    for (const match of line.matchAll(/(?:^|[,{])\s*['"]?(include|extends|additional_contexts|provider)['"]?\s*:/g)) keys.add(match[1]);
  }
  for (const key of keys) {
    report(key === 'provider' ? 'Docker will run a program on the host for this provider.'
      : 'Docker will read another file for ' + key + ' that the approval check does not cover.');
  }
}

function showFiles(changed: string[], oldSet: string, set: string, report: (message: string) => void): void {
  let missingDiff = false;
  const warnings = new Set<string>();
  for (const name of changed) {
    const before = path.join(oldSet, name);
    const after = path.join(set, name);
    const oldFile = fs.existsSync(before) ? before : '/dev/null';
    const newFile = fs.existsSync(after) ? after : '/dev/null';
    const oldLink = linkText(before);
    const newLink = linkText(after);
    if (oldLink || newLink) {
      report(name + ': ' + (oldLink?.toString().trim() ?? 'file') + ' -> ' + (newLink?.toString().trim() ?? 'file'));
      continue;
    }
    if (!missingDiff) {
      const diff = spawnSync('diff', ['-u', oldFile, newFile], { encoding: 'utf8' });
      if ((diff.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        report('Compare the approved and candidate folders: ' + oldSet + ' and ' + set);
        missingDiff = true;
      } else if (diff.status === 1) report(diff.stdout.trimEnd());
      else if (diff.status !== 0) report('Compare ' + oldFile + ' and ' + newFile);
    }
    if (composeNames.includes(name)) {
      warnCompose(fs.readFileSync(oldFile, 'utf8'), fs.readFileSync(newFile, 'utf8'), line => warnings.add(line));
    }
  }
  for (const warning of warnings) report(warning);
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(question); }
  finally { terminal.close(); }
}

export async function approveProject(project: string, options: ApprovalOptions = {}): Promise<ApprovalResult> {
  project = fs.realpathSync(project);
  const report = (message: string) => (options.report ?? console.log)(visible(message));
  const store = physicalPath(approvalStore(project, options.configRoot));
  try { assertOutside(store, project); }
  catch {
    report('[hermit] Warning: the Docker approval store is inside the project. This run uses project files without recording approval.');
    return { code: 0 };
  }
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  fs.chmodSync(store, 0o700);
  const lock = path.join(store, 'approval.lock');
  if (!acquireLockWithWait(lock, options.waitMs ?? 3000)) {
    report('[hermit] Another Docker lifecycle command or hermitd approve is checking ' + project + '.');
    return { code: 1 };
  }

  let candidate: string | undefined;
  try {
    const previous = readRecord(store);
    candidate = fs.mkdtempSync(path.join(store, 'set-'));
    const next = collect(project, candidate, report);
    if (previous?.digest === next.digest) return { code: 0, applied: path.join(store, previous.applied) };
    const files = previous ? changedKeys(previous.files, next.files) : Object.keys(next.files);
    const env = previous ? changedKeys(previous.env, next.env) : Object.keys(next.env);
    const values = previous ? changedKeys(previous.values, next.values) : Object.keys(next.values).filter(key => next.values[key] !== undefined);
    const names = [...files, ...env.map(key => '.env ' + key), ...values];
    if (previous && names.length) {
      const prompt = options.prompt ?? (process.stdin.isTTY && process.stdout.isTTY ? ask : undefined);
      if (!prompt) {
        report('Changed: ' + names.join(', ') + '. Run hermitd approve in a terminal.');
        return { code: 1 };
      }
      const oldSet = path.join(store, previous.applied);
      showFiles(files, oldSet, candidate, report);
      for (const key of values) report(key + ': ' + (JSON.stringify(previous.values[key]) ?? '(unset)') + ' -> ' + (JSON.stringify(next.values[key]) ?? '(unset)'));
      for (const key of env) report('.env ' + key + ' changed');
      const answer = await prompt('Apply these changes? [y/N] ');
      if (answer.trim().toLowerCase() !== 'y') {
        report('Nothing was applied. Last approved copies: ' + oldSet);
        return { code: 1 };
      }
    }

    writeFileAtomic(path.join(store, 'record.json'), JSON.stringify(next, null, 2) + '\n', 0o600);
    const applied = candidate;
    candidate = undefined;
    // Keep the new set and the one before it (a command already building from it), drop the rest.
    const keep = new Set([path.basename(applied), previous?.applied]);
    for (const name of fs.readdirSync(store)) {
      if (name.startsWith('set-') && !keep.has(name)) fs.rmSync(path.join(store, name), { recursive: true, force: true });
    }
    if (!previous) report('Recorded Docker approval baseline: ' + (names.length ? names.join(', ') : composeNames[0]) + '.');
    return { code: 0, applied };
  } finally {
    if (candidate) fs.rmSync(candidate, { recursive: true, force: true });
    releaseLock(lock);
  }
}
