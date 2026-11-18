import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { storeName } from './credproxy';
import { isLink } from './security-files';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { writeFileAtomic } from './md-write';

export interface HostEntry {
  project_dir: string;
  name: string;
  agent_name: string;
  runtime_hint: string;
  registered_at: string;
}
export type EntryState = 'present' | 'missing' | 'unreadable';
export function marketplace(root: string): string | null {
  return root.match(/\/marketplaces\/([^/]+)\/plugins\/hermitd\/?$/)?.[1]
    ?? root.match(/\/cache\/([^/]+)\/hermitd\/[^/]+\/?$/)?.[1] ?? null;
}
export function pluginsRoot(): string {
  return process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins');
}
export function registryDir(mp: string): string {
  return path.join(pluginsRoot(), 'data', `hermitd@${mp}`.replace(/[^a-zA-Z0-9_-]/g, '-'));
}
function load(mp: string): HostEntry[] {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(registryDir(mp), 'instances.json'), 'utf8'));
    if (!Array.isArray(rows) || rows.some(row => typeof row.project_dir !== 'string' || typeof row.name !== 'string')) throw new Error('Invalid host registry');
    return rows;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function entryState(entry: HostEntry): EntryState {
  try { fs.readFileSync(path.join(entry.project_dir, '.hermit/config.json')); return 'present'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'; }
}
export function readRegistry(mp: string) {
  return load(mp).map(entry => ({ ...entry, state: entryState(entry) }));
}
export function isDockerProject(project: string, coreRoot = path.resolve(import.meta.dir, '../..')): boolean {
  if (fs.existsSync(path.join(project, 'docker-compose.hermit.yml'))) return true;
  const mp = marketplace(coreRoot);
  return mp !== null && load(mp).some(row => row.project_dir === project && row.runtime_hint === 'docker');
}
function update(mp: string, change: (rows: HostEntry[]) => HostEntry[]): void {
  const dir = registryDir(mp);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'instances.lock');
  if (!acquireLockWithWait(lock, 5000)) throw new Error('Host registry is locked or unwritable');
  try { writeFileAtomic(path.join(dir, 'instances.json'), JSON.stringify(change(load(mp)), null, 2) + '\n'); }
  finally { releaseLock(lock); }
}
export function registerProject(project: string, coreRoot: string, runtimeHint = 'tmux'): void {
  const mp = marketplace(coreRoot);
  if (mp) registerInMarketplace(mp, project, runtimeHint);
}
export function registerInMarketplace(mp: string, project: string, runtimeHint: string): void {
  const canonical = fs.realpathSync(project);
  const config = JSON.parse(fs.readFileSync(path.join(canonical, '.hermit/config.json'), 'utf8'));
  update(mp, rows => {
    const previous = rows.find(row => row.project_dir === canonical);
    const entry: HostEntry = { project_dir: canonical, name: path.basename(canonical), agent_name: config.agent_name ?? path.basename(canonical), runtime_hint: previous?.runtime_hint === 'docker' ? 'docker' : runtimeHint, registered_at: previous?.registered_at ?? new Date().toISOString() };
    return [...rows.filter(row => row.project_dir !== canonical), entry];
  });
}
export type PruneResult = { removed: string[]; kept: { project_dir: string; reason: string }[] };

/** The two host stores a project leaves under the home folder: approved Docker inputs and credentials. */
export function hostStores(project: string, home = os.homedir()): string[] {
  const name = storeName(project);
  return ['approvals', 'credproxy'].map(kind => path.join(home, '.claude', 'hermitd', kind, name));
}

/** Running containers of a Compose project, by its working-dir label; null when Docker cannot answer. */
function runningContainers(project: string): string | null {
  const result = spawnSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project.working_dir=${project}`], { encoding: 'utf8' });
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}

/** Remove a project's stores; the reason it kept them, or null once both are gone. */
function removeStores(project: string, home: string, running: (project: string) => string | null): string | null {
  const stores = hostStores(project, home).filter(store => fs.existsSync(store) || isLink(store));
  if (!stores.length) return null;
  const containers = running(project);
  if (containers === null) return 'docker_unavailable';
  if (containers) return 'containers_running';
  for (const store of stores) {
    const root = path.dirname(store);
    // A linked store or store root would point the delete outside the home folder's hermitd tree.
    if (isLink(root) || isLink(path.dirname(root)) || isLink(store)) return 'store_is_link';
    try { fs.rmSync(store, { recursive: true, force: true }); }
    catch (error) { return `store_delete_failed:${(error as NodeJS.ErrnoException).code ?? error}`; }
  }
  return null;
}

/**
 * Drop registry rows, deleting each project's host stores first so a failed delete keeps the
 * row for a retry. Bare prune selects rows whose project is gone; a name or path selects one.
 */
export function prune(mp: string, name?: string, options: { home?: string; running?: (project: string) => string | null } = {}): PruneResult {
  const rows = load(mp);
  let selected: string[];
  if (!name) selected = rows.filter(row => entryState(row) === 'missing').map(row => row.project_dir);
  else {
    // An absolute path names exactly one project; a bare name may match several.
    const matches = rows.filter(row => path.isAbsolute(name) ? [name, realOr(name)].includes(row.project_dir) : row.name === name || row.agent_name === name);
    if (matches.length > 1) throw new Error(`Ambiguous name ${name}: ${matches.map(row => row.project_dir).join(', ')}`);
    selected = matches.length ? [matches[0].project_dir] : path.isAbsolute(name) ? [realOr(name)] : [];
  }
  const result: PruneResult = { removed: [], kept: [] };
  for (const project of selected) {
    const reason = removeStores(project, options.home ?? os.homedir(), options.running ?? runningContainers);
    if (reason) result.kept.push({ project_dir: project, reason });
    else result.removed.push(project);
  }
  if (result.removed.length) update(mp, current => current.filter(row => !result.removed.includes(row.project_dir)));
  return result;
}

function realOr(file: string): string {
  try { return fs.realpathSync(file); } catch { return file; }
}
