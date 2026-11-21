import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { installHost } from './lib/host-install';
import { isContainer } from './lib/container';
import { resolvePlugin, isResolveError } from './lib/domain-hatch/resolve';
import { isDockerProject, marketplace, readRegistry, registerProject, prune } from './lib/host-registry';
import { dockerTransport, tmuxTransport, readRuntime, projectStatus, renderStatus, inspect } from './lib/hermit-status';
import { verdictLine } from './doctor-check';
import { printJson } from './lib/cli';
import { inside } from './lib/credproxy';
import { resolveProjection } from './lib/cc-compat';

const coreRoot = path.resolve(import.meta.dir, '..');
const bunIsolation = '--config=/dev/null --no-env-file';
function restoreTmuxEnvironment(project: string): void {
  delete process.env.BUN_OPTIONS;
  let contents: string;
  try { contents = fs.readFileSync(path.join(project, '.env'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (key !== 'BUN_OPTIONS' && key !== 'BASH_ENV') process.env[key] ??= value;
  }
}
function execute(command: string, args: string[], project: string, env: Record<string, string> = {}): number {
  const result = spawnSync(command, args, { cwd: project, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) console.error(`[hermit] ${result.error.message}`);
  return result.status ?? 1;
}
function wrapper(project: string, name: string, args: string[]): number {
  return execute('bash', [path.join(project, '.hermit/bin', name), ...args], project);
}
function findProject(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    // A projected .hermit/ resolves to the real root above it.
    if (fs.existsSync(path.join(dir, '.hermit/config.json'))) {
      const hermit = resolveProjection(path.join(dir, '.hermit'));
      return fs.realpathSync(path.dirname(hermit));
    }
    if (dir === path.dirname(dir)) return;
  }
}
function warnProjectContainsHostConfig(project: string, root: string): void {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const canonical = (candidate: string) => {
    try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
  };
  if (inside(canonical(root), project) || inside(canonical(configDir), project)) {
    console.error('[hermit] Warning: this project contains the host Claude configuration or plugin. The agent can change code the host runs.');
  }
}
function registry(root: string) { const mp = marketplace(root); return mp ? readRegistry(mp) : []; }
const SUBCOMMANDS: Record<string, string[]> = {
  skills: ['status', 'restore', 'archive', 'pin', 'unpin', 'rollback'],
  pause: ['on', 'off', 'snooze', 'status'], watchdog: ['run', 'install', 'uninstall'],
  docker: ['up', 'down', 'attach', 'agents', 'bash', 'login', 'setup-token', 'logs', 'restart', 'update', 'doctor'],
  credproxy: ['map', 'unmap', 'status', 'set', 'unset', 'render'],
  connector: ['enable', 'disable', 'status', 'pair', 'list', 'revoke', 'render'],
  approve: [],
};
const VERBS = ['status', 'start', 'stop', 'restart', 'attach', 'agents', 'update', 'doctor', 'docker', 'pause', 'watchdog', 'skills', 'run', 'install', 'register', 'credproxy', 'connector', 'approve', 'setup', 'mcp'];
const USAGE = 'Usage: hermitd list|status|start|stop|restart|attach|agents|update|doctor|prune|docker|pause|watchdog|skills|run|credproxy|connector|approve|setup|mcp [name] [args]';
const VERB_USAGE: Record<string, string> = {
  list: 'hermitd list [--json]', status: 'hermitd status [name] [--json]', prune: 'hermitd prune [name]',
  start: 'hermitd start [name] [--resume] [--build]', restart: 'hermitd restart [name] [--fresh] [--build]',
  update: 'hermitd update [name] [--dry-run] [--yes]', doctor: 'hermitd doctor [name] [--fix]', setup: 'hermitd setup [skill]',
  mcp: 'hermitd mcp serve [--roots <dir,dir>]', approve: 'hermitd approve [name]', run: 'hermitd run [name] <script> [args]',
};
const HELP = ['--help', '-h'];
function usage(verb: string): string {
  if (VERB_USAGE[verb]) return `Usage: ${VERB_USAGE[verb]}`;
  if (!VERBS.includes(verb)) return USAGE;
  const subs = SUBCOMMANDS[verb];
  return subs?.length ? `Usage: hermitd ${verb} [name] ${subs.join('|')} [args]` : `Usage: hermitd ${verb} [name]`;
}
function target(args: string[], verb: string, cwd: string, root: string): string {
  const first = verb === 'setup' ? undefined : args[0];
  const matches = registry(root).filter(row => row.name === first || row.agent_name === first);
  if (matches.length > 1) throw new Error(`Ambiguous name ${first}: ${matches.map(row => row.project_dir).join(', ')}`);
  if (matches.length === 1) { args.shift(); return matches[0].project_dir; }
  if (first && !first.startsWith('-') && verb !== 'run' && !(SUBCOMMANDS[verb] ?? []).includes(first)) throw new Error(`Unknown hermit: ${first}`);
  const project = findProject(cwd);
  if (!project) throw new Error('No hermit project here. Pass a registered name.');
  return project;
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
  // A core older than Docker approval has no checker; the updated install's lifecycle records the baseline after the host update.
  const approve = path.join(host.installPath, 'scripts/approve.ts');
  if (fs.existsSync(approve)) {
    const approval = execute(process.execPath, [approve, project], '/', { BUN_OPTIONS: bunIsolation });
    if (approval !== 0) {
      console.error('[hermit] Nothing was applied.');
      dockerScript(project, ['notify-approval'], host.installPath);
      return approval;
    }
  }
  if (host.scope === 'user') console.error(`[hermit] Skipping shared user-scope host update: ${host.id}`);
  else {
    const code = execute('claude', ['plugin', 'update', host.id, '--scope', host.scope], project);
    if (code !== 0) return code;
  }
  const fresh = hostInstall(project);
  return dockerScript(project, ['update', ...args], fresh.installPath);
}
type DoctorCheck = { id: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string; installed_version?: string };
function doctorProject(project: string, args: string[], useDocker: boolean, up: boolean): number {
  const fix = args[0] === '--fix';
  if (args.length > (fix ? 1 : 0)) throw new Error(usage('doctor'));
  if (useDocker && !up) {
    console.log('start it with `hermitd start`, then rerun `hermitd doctor`');
    return 1;
  }
  let host: ReturnType<typeof hostInstall>;
  try { host = hostInstall(project); }
  catch (error) {
    console.error(`doctor needs \`claude plugin list\` to find the installed plugin: ${error instanceof Error ? error.message : error}. Check \`claude --version\`.`);
    return 1;
  }
  const runtime = useDocker ? {} : readRuntime(project);
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: host.installPath,
    ...(runtime.config_dir ? { CLAUDE_CONFIG_DIR: runtime.config_dir } : {}) };
  const capture = (command: string, argv: string[]) => {
    const result = spawnSync(command, argv, { cwd: project, env, encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('malformed doctor output'); }
  };
  const dockerArgs = (argv: string[]) => [path.join(host.installPath, 'scripts/hermitd-docker.sh'), 'doctor', ...argv];
  const checks = (): DoctorCheck[] => {
    const report = useDocker ? capture('bash', dockerArgs([]))
      : capture(process.execPath, [path.join(host.installPath, 'scripts/doctor-check.ts'), path.join(project, '.hermit')]);
    if (!Array.isArray(report?.checks) || report.checks.length === 0 || !report.checks.every((row: DoctorCheck) =>
      row && typeof row.id === 'string' && ['ok', 'warn', 'fail'].includes(row.status) && typeof row.detail === 'string')) {
      throw new Error('malformed doctor report');
    }
    return report.checks;
  };
  const before = checks();
  let after = before;
  if (fix) {
    const outcomes = new Map<string, string>();
    for (const row of before) {
      if (!row.fix || outcomes.has(row.fix)) continue;
      try {
        if (row.fix === 'evolve') {
          if (!up) outcomes.set(row.fix, 'skipped: start the agent with `hermitd start`; the upgrade runs at start');
          else if (!row.installed_version) outcomes.set(row.fix, 'failed: installed version missing');
          else {
            const result = useDocker ? capture('bash', dockerArgs(['evolve', row.installed_version]))
              : capture(process.execPath, [path.join(host.installPath, 'scripts/harness-request.ts'), '/reload-plugins', '--then',
                '/hermitd:hermit-evolve', 'unattended', '--expect-version', row.installed_version, '--purpose', 'upgrade']);
            outcomes.set(row.fix, result?.status === 'queued' ? 'queued' : result?.status === 'skipped'
              ? `skipped: ${result.reason ?? 'unknown'}` : `failed: ${result?.reason ?? result?.error ?? 'invalid repair output'}`);
          }
        } else if (row.fix === 'watchdog-install') {
          if (useDocker) outcomes.set(row.fix, 'skipped: watchdog install needs tmux mode');
          else {
            const code = wrapper(project, 'hermitd-watchdog', ['install']);
            outcomes.set(row.fix, code === 0 ? 'applied' : `failed: exit ${code}`);
          }
        } else outcomes.set(row.fix, 'skipped: unknown repair');
      } catch (error) { outcomes.set(row.fix, `failed: ${error instanceof Error ? error.message : error}`); }
    }
    if ([...outcomes.values()].some(outcome => outcome === 'applied' || outcome === 'queued')) after = checks();
    for (const [repair, outcome] of outcomes) {
      const confirm = repair === 'watchdog-install' && outcome === 'applied'
        && before.some(row => row.fix === repair && after.some(check => check.id === row.id && check.status !== 'ok'));
      console.log(`${repair}: ${outcome}${confirm ? '; the next scheduled run (within 5 minutes) confirms it' : ''}`);
    }
    const fixed = before.filter(row => row.fix && row.fix !== 'evolve' && row.status !== 'ok'
      && after.some(check => check.id === row.id && check.status === 'ok')).length;
    console.log(`Fixed ${fixed}`);
  }
  const remaining = after.filter(row => row.status !== 'ok');
  remaining.forEach((row, i) => console.log(`${i + 1}. ${row.status} ${row.id}: ${row.detail}`));
  if (!remaining.length) console.log('All checks passed.');
  else if (!remaining.some(row => row.status === 'fail')) console.log(`No failures; ${remaining.length} warning(s).`);
  if (!fix) {
    const repairs = before.filter(row => row.fix).length;
    if (repairs) console.log(`\`hermitd doctor --fix\` applies ${repairs} safe repair(s)`);
  }
  return verdictLine(after).startsWith('FAIL') ? 1 : 0;
}
// `install` is the one helper verb here (hatch and docker-setup run it), so it prints the
// helper-script output; every other verb is an operator CLI. PATH notices stay on stderr.
function install(args: string[], cwd: string, root: string): number {
  try {
    if (isContainer()) { printJson({ status: 'skip', reason: 'container' }); return 0; }
    const project = target(args, 'install', cwd, root);
    if (isDockerProject(project, root)) warnProjectContainsHostConfig(project, root);
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
    const canonical = fs.realpathSync(path.dirname(resolveProjection(path.join(dir, '.hermit'))));
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
      return { ...projectStatus(project, isDockerProject(project, root)), ...entry };
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
  // Help never resolves a project or runs a verb. `run` and `agents` pass later arguments on.
  if (HELP.includes(verb)) { console.log(USAGE); return 0; }
  const named = verb === 'run' && HELP.includes(args[1]) && registry(root).some(row => row.name === args[0] || row.agent_name === args[0]);
  if (named || (verb === 'run' || verb === 'agents' ? HELP.includes(args[0]) : args.some(arg => HELP.includes(arg)))) {
    console.log(usage(verb));
    return 0;
  }
  if (verb === 'install') return install(args, cwd, root);
  if (verb === 'register' && isContainer()) return 0;
  if (verb === 'list' || verb === 'prune') {
    const project = verb === 'prune' && args[0]
      ? registry(root).find(row => [row.project_dir, row.name, row.agent_name].includes(args[0]))?.project_dir
      : findProject(cwd);
    if (project && isDockerProject(project, root)) warnProjectContainsHostConfig(project, root);
  }
  if (verb === 'list') { list(root, cwd, args.includes('--json')); return 0; }
  if (verb === 'prune') {
    const mp = marketplace(root);
    if (!mp) return 0;
    const { kept } = prune(mp, args[0]);
    for (const row of kept) console.error(`[hermit] kept ${row.project_dir}: ${row.reason}`);
    return kept.length ? 1 : 0;
  }
  if (!VERBS.includes(verb)) throw new Error(USAGE);
  if (verb === 'setup') {
    if (isContainer()) { printJson({ error: 'host_only' }); return 1; }
    if (args.length > 1) throw new Error(usage('setup'));
    const project = target(args, verb, cwd, root);
    const host = hostInstall(project);
    warnProjectContainsHostConfig(project, host.installPath);
    const options = ['--setting-sources', 'user'];
    if (host.scope !== 'user') options.push('--plugin-dir', host.installPath);
    if (args[0]) options.push('/hermitd:' + args[0]);
    return execute('claude', options, project, { BUN_OPTIONS: bunIsolation });
  }
  if (verb === 'mcp') {
    // The control surface runs from installed code, never a project wrapper. It runs from `/`,
    // so relative roots are resolved against the caller's folder first.
    if (args[0] !== 'serve') throw new Error(usage('mcp'));
    const absolute = (list: string) => list.split(',').map(r => r.trim()).filter(Boolean).map(r => path.resolve(cwd, r)).join(',');
    const rest = args.slice(1).map((arg, i, all) => all[i - 1] === '--roots' ? absolute(arg)
      : arg.startsWith('--roots=') ? '--roots=' + absolute(arg.slice('--roots='.length)) : arg);
    const env: Record<string, string> = { BUN_OPTIONS: bunIsolation };
    if (process.env.HERMIT_MCP_ROOTS) env.HERMIT_MCP_ROOTS = absolute(process.env.HERMIT_MCP_ROOTS);
    return execute(process.execPath, [path.join(root, 'scripts/mcp-server.ts'), ...rest], '/', env);
  }
  if (verb === 'approve') {
    if (isContainer()) { printJson({ error: 'host_only' }); return 1; }
    const project = target(args, verb, cwd, root);
    if (args.length) throw new Error(usage('approve'));
    if (!isDockerProject(project, root)) throw new Error('hermitd approve requires a Docker project');
    warnProjectContainsHostConfig(project, root);
    const host = hostInstall(project);
    const approve = path.join(host.installPath, 'scripts/approve.ts');
    if (!fs.existsSync(approve)) {
      // hermitd update skips a shared user-scope core, so it cannot bring this one forward.
      const step = host.scope === 'user' ? `claude plugin update ${host.id} --scope user` : 'hermitd update';
      throw new Error(`This agent's installed core predates hermitd approve. Run ${step} first.`);
    }
    return execute(process.execPath, [approve, project], '/', { BUN_OPTIONS: bunIsolation });
  }
  const project = target(args, verb, cwd, root);
  const runScript = verb === 'run' ? args[0]?.replace(/\.ts$/, '') : undefined;
  const channelToken = runScript === 'channel-token';
  const useDocker = !channelToken && isDockerProject(project, root);
  const hostStore = verb === 'credproxy' || verb === 'connector' || channelToken;
  if (useDocker && !hostStore) warnProjectContainsHostConfig(project, root);
  if (!hostStore && verb !== 'docker' && !useDocker) {
    restoreTmuxEnvironment(project);
  }
  if (verb === 'register') {
    registerProject(project, root, useDocker ? 'docker' : 'tmux');
    return 0;
  }
  if (verb === 'status') { console.log(renderStatus([projectStatus(project, useDocker)], args.includes('--json'))); return 0; }
  if (useDocker && (['start', 'restart', 'update'].includes(verb) || (verb === 'docker' && ['up', 'restart', 'update'].includes(args[0])))
    && !fs.existsSync(path.join(project, 'docker-compose.hermit.yml'))) {
    throw new Error(`No docker-compose.hermit.yml found in ${project}`);
  }
  if (verb === 'run' && !hostStore) {
    if (runScript === 'hermitd-cli') throw new Error('hermitd run refuses recursive hermitd-cli dispatch');
    if (useDocker && runScript === 'browser-host') {
      const install = hostInstall(project).installPath;
      return execute(process.execPath, [path.join(install, 'scripts/browser-host.ts'), ...args.slice(1)], project);
    }
    if (useDocker) return dockerScript(project, [verb, ...args], hostInstall(project).installPath);
    return wrapper(project, 'hermitd-run', args);
  }
  if (['pause', 'watchdog', 'skills'].includes(verb)) {
    if (useDocker) return dockerScript(project, [verb, ...args], hostInstall(project).installPath);
    return wrapper(project, `hermitd-${verb}`, args);
  }
  if (hostStore) {
    if (isContainer()) { printJson({ error: 'host_only' }); return channelToken ? 0 : 1; }
    // Runs only the installed plugin's script, from outside the project (bun reads bunfig.toml
    // from its cwd), so no file the agent can write executes.
    const install = fs.realpathSync(hostInstall(project).installPath);
    if (inside(install, project)) { printJson({ error: 'untrusted_install' }); return 1; }
    const [sub, ...rest] = channelToken ? args.slice(1) : args;
    const script = channelToken ? 'channel-token' : verb;
    return execute(process.execPath, [path.join(install, `scripts/${script}.ts`), sub ?? '', project, ...rest], '/', { BUN_OPTIONS: bunIsolation });
  }
  if (verb === 'docker') return args[0] === 'update' ? updateProject(project, args.slice(1), true) : dockerScript(project, args, hostInstall(project).installPath);
  const docker = dockerTransport(project, useDocker);
  // A live conflict still deserves a diagnostic; Docker routing never falls back to tmux.
  const runtime = !useDocker || docker === 'up' ? readRuntime(project) : {};
  const tmux = tmuxTransport(project, runtime.tmux_session);
  if (docker === 'up' && tmux === 'up') throw new Error(`Live-owner conflict: Docker hermit and host tmux ${runtime.tmux_session} are both running`);
  if (docker === 'unknown' || tmux === 'unknown') throw new Error('Owner inspection failed: runtime is unknown');
  const interactive = !useDocker && runtime.runtime_mode === 'interactive' && tmux !== 'up';
  if (verb === 'doctor') return doctorProject(project, args, useDocker, useDocker ? docker === 'up' : tmux === 'up');
  if (verb === 'update') return updateProject(project, args, useDocker);
  if (verb === 'agents') {
    if (useDocker) return dockerScript(project, ['agents', ...args], hostInstall(project).installPath);
    return execute('claude', ['agents', ...args], project, runtime.config_dir ? { CLAUDE_CONFIG_DIR: runtime.config_dir } : {});
  }
  if (interactive && verb === 'attach') { console.error('[hermit] Interactive session: nothing to attach to.'); return 1; }
  if (interactive && verb === 'stop') return wrapper(project, 'hermitd-stop', args);
  if (useDocker) return dockerScript(project, [verb === 'start' ? 'up' : verb === 'stop' ? 'down' : verb, ...args], hostInstall(project).installPath);
  if (verb === 'restart') {
    // Restart keeps the conversation unless --fresh; --resume is accepted as a no-op.
    const fresh = args.includes('--fresh');
    const rest = args.filter((a) => a !== '--fresh' && a !== '--resume');
    const code = wrapper(project, 'hermitd-stop', []);
    return code === 0 ? wrapper(project, 'hermitd-start', fresh ? rest : ['--resume', ...rest]) : code;
  }
  return wrapper(project, `hermitd-${verb}`, args);
}
if (import.meta.main) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`[hermit] ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
