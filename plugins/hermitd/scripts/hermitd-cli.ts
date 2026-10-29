import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installHost } from './lib/host-install';
import { isContainer } from './lib/container';
import { resolvePlugin, isResolveError } from './lib/domain-hatch/resolve';
import { marketplace, readRegistry, registerProject, prune } from './lib/host-registry';
import { dockerTransport, tmuxTransport, readRuntime, projectStatus, renderStatus, inspect } from './lib/hermit-status';
import { printJson } from './lib/cli';

const coreRoot = path.resolve(import.meta.dir, '..');
function execute(command: string, args: string[], project: string, env: Record<string, string> = {}): number {
  const result = spawnSync(command, args, { cwd: project, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) console.error(`[hermit] ${result.error.message}`);
  return result.status ?? 1;
}
function wrapper(project: string, name: string, args: string[]): number {
  return execute('bash', [path.join(project, '.hermit/bin', name), ...args], project);
}
function nearestProject(cwd: string): string {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.hermit/config.json'))) return fs.realpathSync(dir);
    if (dir === path.dirname(dir)) throw new Error('No hermit project here. Pass a registered name.');
  }
}
function registry(root: string) { const mp = marketplace(root); return mp ? readRegistry(mp) : []; }
function target(args: string[], verb: string, cwd: string, root: string): string {
  const first = args[0];
  const reserved: Record<string, string[]> = {
    skills: ['status', 'restore', 'archive', 'pin', 'unpin', 'rollback'],
    pause: ['on', 'off', 'snooze', 'status'], watchdog: ['run', 'install', 'uninstall'],
    docker: ['up', 'down', 'attach', 'agents', 'bash', 'login', 'setup-token', 'logs', 'restart', 'update'],
  };
  const matches = registry(root).filter(row => row.name === first || row.agent_name === first);
  if (matches.length > 1) throw new Error(`Ambiguous name ${first}: ${matches.map(row => row.project_dir).join(', ')}`);
  if (matches.length === 1) { args.shift(); return matches[0].project_dir; }
  if (first && !first.startsWith('-') && verb !== 'run' && !(reserved[verb] ?? []).includes(first)) throw new Error(`Unknown hermit: ${first}`);
  return nearestProject(cwd);
}
export function hostInstall(project: string) {
  const result = inspect('claude', ['plugin', 'list', '--json'], project);
  if (result.error || result.status !== 0) throw new Error('Could not read claude plugin list --json');
  const list = JSON.parse(result.stdout);
  if (!Array.isArray(list)) throw new Error('Invalid claude plugin list --json');
  // `project` is a realpath; compare Claude Code's projectPath the same way (macOS /var -> /private/var, symlinked folders).
  const canonical = (p: unknown) => { if (typeof p !== 'string') return p; try { return fs.realpathSync(p); } catch { return p; } };
  const resolved = resolvePlugin(list.map(p => ({ ...p, projectPath: canonical(p?.projectPath) })), 'hermitd', project);
  if (isResolveError(resolved)) throw new Error(resolved.message);
  const ranks = ['local', 'project', 'user'];
  const entry = list.filter(p => p.enabled === true && p.id?.startsWith('hermitd@') && p.installPath === resolved.installPath
    && (p.scope === 'user' || canonical(p.projectPath) === project)).sort((a, b) => ranks.indexOf(a.scope) - ranks.indexOf(b.scope))[0];
  if (!entry) throw new Error('Core installation binding is unavailable');
  return { id: entry.id as string, scope: entry.scope as string, projectPath: entry.projectPath as string | undefined, installPath: resolved.installPath };
}
function dockerScript(project: string, args: string[], root: string): number {
  return execute('bash', [path.join(root, 'scripts/hermitd-docker.sh'), ...args], project);
}
function updateProject(project: string, args: string[], docker: boolean): number {
  const host = hostInstall(project);
  if (!docker) return execute('bash', [path.join(host.installPath, 'scripts/hermitd-update.sh'), ...args], project);
  if (args.includes('--dry-run')) {
    console.log('[hermit] Dry run: skipping the host core update.');
    return dockerScript(project, ['update', ...args], host.installPath);
  }
  if (host.scope === 'user') console.error(`[hermit] Skipping shared user-scope host update: ${host.id}`);
  else {
    const code = execute('claude', ['plugin', 'update', host.id, '--scope', host.scope], project);
    if (code !== 0) return code;
  }
  const fresh = hostInstall(project);
  return dockerScript(project, ['update', ...args], fresh.installPath);
}
// `install` is the one helper verb here (hatch and docker-setup run it), so it prints the
// helper-script output; every other verb is an operator CLI. PATH notices stay on stderr.
function install(args: string[], cwd: string, root: string): number {
  try {
    if (isContainer()) { printJson({ status: 'skip', reason: 'container' }); return 0; }
    const project = target(args, 'install', cwd, root);
    if (!marketplace(root)) { printJson({ status: 'skip', reason: 'no_marketplace' }); return 0; }
    const { id, scope, projectPath } = hostInstall(project);
    const skipped = installHost(project, root, { id, scope, projectPath });
    if (skipped) printJson(skipped); else console.log('OK');
    return 0;
  } catch (error) {
    printJson({ error: `install_failed:${error instanceof Error ? error.message : error}` });
    return 1;
  }
}
function list(root: string, cwd: string, json: boolean): void {
  const entries = registry(root);
  const projects = new Map(entries.map(entry => [entry.project_dir, { registered: true, state: entry.state, name: entry.name }]));
  const discover = (dir: string) => {
    if (!dir || !fs.existsSync(path.join(dir, '.hermit/config.json'))) return;
    const canonical = fs.realpathSync(dir);
    if (!projects.has(canonical)) projects.set(canonical, { registered: false, state: 'present', name: path.basename(canonical) });
  };
  const docker = inspect('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.service=hermit', '--format', '{{.Label "com.docker.compose.project.working_dir"}}'], cwd);
  const tmux = inspect('tmux', ['list-sessions', '-F', '#{session_path}'], cwd);
  for (const [name, result] of [['docker', docker], ['tmux', tmux]] as const) {
    // A missing binary or an idle tmux server is an empty result, not a failure.
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || (name === 'tmux' && result.status === 1 && /no server running/.test(result.stderr))) continue;
    if (result.error || result.status !== 0) console.error(`[hermit] ${name} discovery unavailable`);
    else result.stdout.split(/\r?\n/).forEach(discover);
  }
  const rows = [...projects].map(([project, entry]) => {
    try {
      if (entry.state !== 'present') return { ...entry, project_dir: project, transport: 'unknown', execution: 'unknown' };
      return { ...projectStatus(project), ...entry };
    } catch (error) {
      console.error(`[hermit] ${project}: ${error instanceof Error ? error.message : error}`);
      return { ...entry, project_dir: project, state: 'error', transport: 'unknown', error: String(error) };
    }
  });
  console.log(json ? JSON.stringify(rows) : renderStatus(rows));
  const missing = entries.filter(entry => entry.state === 'missing').length;
  if (missing && !json) console.log(`${missing} missing — run hermitd prune`);
}
export function main(argv = process.argv.slice(2), cwd = process.cwd(), root = coreRoot): number {
  const [verb, ...args] = argv;
  if (verb === 'install') return install(args, cwd, root);
  if (verb === 'register' && isContainer()) return 0;
  if (verb === 'list') { list(root, cwd, args.includes('--json')); return 0; }
  if (verb === 'prune') {
    const mp = marketplace(root); if (mp) prune(mp, args[0]); return 0;
  }
  if (!['status', 'start', 'stop', 'restart', 'attach', 'agents', 'update', 'docker', 'pause', 'watchdog', 'skills', 'run', 'install', 'register'].includes(verb)) {
    throw new Error('Usage: hermitd list|status|start|stop|restart|attach|agents|update|prune|docker|pause|watchdog|skills|run [name] [args]');
  }
  const project = target(args, verb, cwd, root);
  if (verb === 'register') {
    registerProject(project, root, fs.existsSync(path.join(project, 'docker-compose.hermit.yml')) ? 'docker' : 'tmux');
    return 0;
  }
  if (verb === 'status') { console.log(renderStatus([projectStatus(project)], args.includes('--json'))); return 0; }
  if (verb === 'run') {
    if (args[0]?.replace(/\.ts$/, '') === 'hermitd-cli') throw new Error('hermitd run refuses recursive hermitd-cli dispatch');
    return wrapper(project, 'hermitd-run', args);
  }
  if (verb === 'skills') {
    if (args[0] !== 'status') {
      const docker = dockerTransport(project);
      if (docker === 'unknown') throw new Error('Owner inspection failed: Docker runtime is unknown');
      if (docker === 'up') return dockerScript(project, ['skills', ...args], hostInstall(project).installPath);
    }
    return wrapper(project, 'hermitd-skills', args);
  }
  if (verb === 'pause' || verb === 'watchdog') return wrapper(project, `hermitd-${verb}`, args);
  if (verb === 'docker') return args[0] === 'update' ? updateProject(project, args.slice(1), true) : dockerScript(project, args, hostInstall(project).installPath);
  const runtime = readRuntime(project);
  const docker = dockerTransport(project);
  const tmux = tmuxTransport(project, runtime.tmux_session);
  if (docker === 'up' && tmux === 'up') throw new Error(`Live-owner conflict: Docker hermit and host tmux ${runtime.tmux_session} are both running`);
  if (docker === 'unknown' || tmux === 'unknown') throw new Error('Owner inspection failed: runtime is unknown');
  const interactive = runtime.runtime_mode === 'interactive' && docker !== 'up' && tmux !== 'up';
  const useDocker = docker === 'up' || (tmux !== 'up' && fs.existsSync(path.join(project, 'docker-compose.hermit.yml')));
  if (verb === 'update') return updateProject(project, args, useDocker);
  if (verb === 'agents') {
    if (useDocker) return dockerScript(project, ['agents', ...args], hostInstall(project).installPath);
    return execute('claude', ['agents', ...args], project, runtime.config_dir ? { CLAUDE_CONFIG_DIR: runtime.config_dir } : {});
  }
  if (interactive && verb === 'attach') { console.error('[hermit] Interactive session: nothing to attach to.'); return 1; }
  if (interactive && verb === 'stop') return wrapper(project, 'hermitd-stop', args);
  if (useDocker) return dockerScript(project, [verb === 'start' ? 'up' : verb === 'stop' ? 'down' : verb, ...args], hostInstall(project).installPath);
  if (verb === 'restart') {
    const code = wrapper(project, 'hermitd-stop', []);
    return code === 0 ? wrapper(project, 'hermitd-start', args) : code;
  }
  return wrapper(project, `hermitd-${verb}`, args);
}
if (import.meta.main) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`[hermit] ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
