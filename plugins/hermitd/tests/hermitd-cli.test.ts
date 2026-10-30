import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }); });
const cli = path.resolve(import.meta.dir, '../scripts/hermitd-cli.ts');
function write(file: string, content: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o755 }); }
function fixture() {
  // Canonical root: the CLI resolves projects to realpaths (macOS tmpdir is a /var -> /private/var symlink).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cli-'))); roots.push(root);
  const core = path.join(root, 'plugins/cache/mp/hermitd/1');
  const fresh = path.join(root, 'plugins/cache/mp/hermitd/2');
  const bin = path.join(root, 'tools'); const log = path.join(root, 'calls');
  const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'), CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(root, 'plugins'), PATH: `${bin}:${process.env.PATH}`, CALLS: log, LIST: path.join(root, 'list.json'), FRESH_LIST: path.join(root, 'fresh-list.json'), TMUX_LIVE: '1', DOCKER_LIVE: '', PROJECTS: '', container: '', HERMIT_RESIDENT: '' };
  const project = (name: string, agentName = name) => {
    const p = path.join(root, name); write(path.join(p, '.hermit/config.json'), JSON.stringify({ agent_name: agentName }));
    for (const verb of ['start', 'stop', 'attach', 'pause', 'watchdog', 'skills', 'run']) write(path.join(p, `.hermit/bin/hermitd-${verb}`), `#!/bin/sh\nprintf '%s|%s|%s\\n' '${verb}' "$PWD" "$*" >> "$CALLS"\nexit \${WRAPPER_EXIT:-0}\n`);
    return p;
  };
  const p = project('demo');
  for (const [dir, label] of [[core, 'old'], [fresh, 'fresh']]) {
    write(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'hermitd', version: '1' }));
    write(path.join(dir, 'scripts/hermitd-docker.sh'), `printf '%s|%s|%s\\n' '${label}' "$PWD" "$*" >> "$CALLS"\n`);
    write(path.join(dir, 'scripts/hermitd-update.sh'), `printf 'host|%s|%s\\n' "$PWD" "$*" >> "$CALLS"\n`);
  }
  write(path.join(core, 'state-templates/host/hermitd'), fs.readFileSync(path.resolve(import.meta.dir, '../state-templates/host/hermitd'), 'utf8'));
  const listing = (dir: string) => JSON.stringify([{ id: 'hermitd@mp', scope: 'project', enabled: true, projectPath: p, installPath: dir }]);
  write(env.LIST, listing(core)); write(env.FRESH_LIST, listing(fresh));
  write(path.join(bin, 'tmux'), '#!/bin/sh\nif [ "$1" = list-sessions ]; then printf "%s\\n" "$PROJECTS"; exit 0; fi\nexit "$TMUX_LIVE"\n');
  write(path.join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = ps ]; then printf "%s\\n" "$PROJECTS"; else printf "%s\\n" "$DOCKER_LIVE"; fi\n');
  write(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = agents ]; then printf "claude|%s|%s|%s\\n" "$PWD" "$CLAUDE_CONFIG_DIR" "$*" >> "$CALLS"; exit "${AGENTS_EXIT:-0}"; fi\nif [ "$2" = list ]; then cat "$LIST"; else printf "update-host\\n" >> "$CALLS"; cp "$FRESH_LIST" "$LIST"; fi\n');
  const register = (projects = [p]) => write(path.join(root, 'plugins/data/hermitd-mp/instances.json'), JSON.stringify(projects.map(project_dir => ({ project_dir, name: path.basename(project_dir), agent_name: JSON.parse(fs.readFileSync(path.join(project_dir, '.hermit/config.json'), 'utf8')).agent_name, runtime_hint: 'tmux', registered_at: new Date().toISOString() }))));
  register();
  const run = async (args: string[], cwd = root, extra: Record<string, string> = {}) => {
    const code = `import { main } from ${JSON.stringify(cli)}; try { process.exitCode = main(${JSON.stringify(args)}, ${JSON.stringify(cwd)}, ${JSON.stringify(core)}); } catch (e) { console.error(String(e)); process.exitCode = 1; }`;
    const proc = Bun.spawn([process.execPath, '-e', code], { cwd, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { root, core, fresh, p, env, bin, project, register, run, calls };
}
test('named and nested targets dispatch at project root', async () => {
  const f = fixture(); expect((await f.run(['start', 'demo'])).exitCode).toBe(0);
  fs.mkdirSync(path.join(f.p, 'nested')); expect((await f.run(['start'], path.join(f.p, 'nested'))).exitCode).toBe(0);
  expect(f.calls()).toBe(`start|${f.p}|\nstart|${f.p}|\n`);
});
test('ambiguous agent name lists candidates', async () => {
  const f = fixture(); const a = f.project('a', 'same'); const b = f.project('b', 'same'); f.register([a, b]);
  const r = await f.run(['start', 'same']); expect(r.exitCode).toBe(1); expect(r.stderr).toContain(a); expect(r.stderr).toContain(b);
});
test('failed stop prevents restart from starting', async () => {
  const f = fixture(); expect((await f.run(['restart', 'demo'], f.root, { WRAPPER_EXIT: '7' })).exitCode).toBe(7);
  expect(f.calls()).toBe(`stop|${f.p}|\n`);
});
test('resident restart refuses before transport dispatch', async () => {
  const f = fixture();
  write(path.join(f.p, 'docker-compose.hermit.yml'), 'services: {}');
  const r = await f.run(['restart', 'demo'], f.root, { HERMIT_RESIDENT: '1', DOCKER_LIVE: 'hermit' });
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain('restart_refused_resident');
  expect(f.calls()).toBe('');
});
test('container restart refuses before transport dispatch', async () => {
  const f = fixture();
  write(path.join(f.p, 'docker-compose.hermit.yml'), 'services: {}');
  const r = await f.run(['restart', 'demo'], f.root, { container: 'docker', HERMIT_RESIDENT: '', DOCKER_LIVE: 'hermit' });
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain('restart_refused_container');
  expect(f.calls()).toBe('');
});
test('interactive status and attach', async () => {
  const f = fixture(); write(path.join(f.p, '.hermit/state/runtime.json'), '{"runtime_mode":"interactive"}');
  expect(JSON.parse((await f.run(['status', 'demo', '--json'])).stdout).runtime).toBe('interactive');
  expect((await f.run(['attach', 'demo'])).stderr).toContain('nothing to attach');
});
test('live-owner conflict refuses both owners', async () => {
  const f = fixture(); write(path.join(f.p, 'docker-compose.hermit.yml'), 'services: {}');
  write(path.join(f.p, '.hermit/state/runtime.json'), '{"runtime_mode":"tmux","tmux_session":"host"}');
  const r = await f.run(['start', 'demo'], f.root, { TMUX_LIVE: '0', DOCKER_LIVE: 'hermit' });
  expect(r.exitCode).toBe(1); expect(r.stderr).toContain('Docker hermit and host tmux host'); expect(f.calls()).toBe('');
});
test('Docker updates host first then runs fresh script; dry-run skips host', async () => {
  const f = fixture(); write(path.join(f.p, 'docker-compose.hermit.yml'), 'services: {}');
  expect((await f.run(['update', 'demo'])).exitCode).toBe(0);
  expect(f.calls()).toBe(`update-host\nfresh|${f.p}|update\n`);
  fs.unlinkSync(f.env.CALLS);
  expect((await f.run(['update', 'demo', '--dry-run'])).stdout).toContain('skipping the host');
  expect(f.calls()).toBe(`fresh|${f.p}|update --dry-run\n`);
});
test('failed tmux discovery retains discovered Docker rows and corrupt projects', async () => {
  const f = fixture(); const other = f.project('other'); write(path.join(other, 'docker-compose.hermit.yml'), 'services: {}');
  write(path.join(f.bin, 'tmux'), '#!/bin/sh\nexit 127\n');
  write(path.join(f.p, '.hermit/config.json'), '{broken');
  const r = await f.run(['list', '--json'], f.root, { PROJECTS: other, DOCKER_LIVE: 'hermit' });
  expect(r.exitCode).toBe(0); const rows = JSON.parse(r.stdout);
  expect(rows.find((r: any) => r.name === 'other').registered).toBe(false);
  expect(rows.find((r: any) => r.name === 'demo').state).toBe('error');
});
test('container install is a no-op outside any project', async () => {
  const f = fixture(); const r = await f.run(['install'], f.root, { container: 'docker' });
  expect(r.exitCode).toBe(0); expect(JSON.parse(r.stdout)).toEqual({ status: 'skip', reason: 'container' });
  expect(fs.existsSync(path.join(f.root, '.local'))).toBe(false);
});
test('pause/watchdog/run preserve args, cwd, and exit codes', async () => {
  const f = fixture();
  for (const [verb, args] of [['pause', ['snooze', '5m']], ['watchdog', ['uninstall']], ['run', ['backup', 'setup']]] as const) {
    expect((await f.run([verb, 'demo', ...args], f.root, { WRAPPER_EXIT: '9' })).exitCode).toBe(9);
    expect(f.calls()).toContain(`${verb}|${f.p}|${args.join(' ')}\n`);
  }
  expect((await f.run(['run', 'demo', 'hermitd-cli'])).exitCode).toBe(1);
});

test('host install creates bin, is idempotent, warns about PATH, and follows a refreshed installPath', async () => {
  const f = fixture(); const shim = path.join(f.root, '.local/bin/hermitd');
  const first = await f.run(['install'], f.p);
  expect(first.exitCode).toBe(0); expect(first.stdout).toBe('OK\n'); expect(first.stderr).toContain('to PATH');
  expect(fs.existsSync(shim)).toBe(true); const mtime = fs.statSync(shim).mtimeMs;
  expect((await f.run(['install'], f.p)).exitCode).toBe(0); expect(fs.statSync(shim).mtimeMs).toBe(mtime);
  write(path.join(f.fresh, 'scripts/hermitd-exec.sh'), '#!/bin/sh\nprintf "fresh:%s\\n" "$*"\n');
  fs.copyFileSync(f.env.FRESH_LIST, f.env.LIST);
  const child = Bun.spawn(['bash', shim, 'list'], { cwd: f.root, env: { ...f.env }, stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(child.stdout).text()).toBe('fresh:hermitd-cli list\n'); expect(await child.exited).toBe(0);
});
test('core lookup matches a projectPath reported through a symlink', async () => {
  const f = fixture(); const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.p, alias);
  write(f.env.LIST, JSON.stringify([{ id: 'hermitd@mp', scope: 'project', enabled: true, projectPath: alias, installPath: f.core }]));
  const r = await f.run(['docker', 'logs'], f.p);
  expect(r.stderr).not.toContain('not installed'); expect(r.exitCode).toBe(0);
  expect(f.calls()).toContain(`old|${f.p}|logs`);
});
test('shim falls back by scope precedence when the bound install is gone', async () => {
  const f = fixture(); const shim = path.join(f.root, '.local/bin/hermitd');
  expect((await f.run(['install'], f.p)).exitCode).toBe(0);
  write(path.join(f.core, 'scripts/hermitd-exec.sh'), '#!/bin/sh\nprintf "old:%s\\n" "$*"\n');
  write(path.join(f.fresh, 'scripts/hermitd-exec.sh'), '#!/bin/sh\nprintf "fresh:%s\\n" "$*"\n');
  const shimOut = async () => { const c = Bun.spawn(['bash', shim, 'list'], { cwd: f.root, env: { ...f.env }, stdout: 'pipe', stderr: 'pipe' }); return [await new Response(c.stdout).text(), await c.exited] as const; };
  // Bound project-scope install removed: this project's local install beats another user install.
  write(f.env.LIST, JSON.stringify([{ id: 'hermitd@mp', scope: 'user', enabled: true, installPath: f.core }, { id: 'hermitd@mp', scope: 'local', enabled: true, projectPath: f.p, installPath: f.fresh }]));
  expect(await shimOut()).toEqual(['fresh:hermitd-cli list\n', 0]);
  // Only an unrelated project's install left: still usable.
  write(f.env.LIST, JSON.stringify([{ id: 'hermitd@mp', scope: 'project', enabled: true, projectPath: '/elsewhere', installPath: f.core }]));
  expect(await shimOut()).toEqual(['old:hermitd-cli list\n', 0]);
  write(f.env.LIST, '[]');
  const [, code] = await shimOut(); expect(code).toBe(1);
});
for (const deleted of [false, true]) {
  test(`shim ignores caller enablement when the bound project is ${deleted ? 'deleted' : 'present'}`, async () => {
    const f = fixture(); const shim = path.join(f.root, '.local/bin/hermitd');
    // The CLI lists all installs; only the per-id enabled flag depends on the caller's settings.
    write(path.join(f.bin, 'claude'), `#!/bin/sh
if [ "$PWD" = "$ENABLING_PROJECT" ]; then enabled=true; else enabled=false; fi
sed 's/"enabled":true/"enabled":'"$enabled"'/g' "$LIST"
`);
    const env = { ...f.env, ENABLING_PROJECT: f.p };
    expect((await f.run(['install'], f.p, { ENABLING_PROJECT: f.p })).exitCode).toBe(0);
    const install = deleted ? f.fresh : f.core;
    if (deleted) {
      fs.rmSync(f.p, { recursive: true });
      write(f.env.LIST, JSON.stringify([{ id: 'hermitd@mp', scope: 'project', enabled: true, projectPath: path.join(f.root, 'other'), installPath: install }]));
    }
    write(path.join(install, 'scripts/hermitd-exec.sh'), '#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*"\n');
    const child = Bun.spawn(['bash', shim, 'status', 'demo', '--json'], { cwd: f.root, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(exitCode).toBe(0);
    expect(stdout).toBe(`${f.root}|hermitd-cli status demo --json\n`);
  });
}
test('host install refuses foreign file and notices earlier PATH tool', async () => {
  const f = fixture(); const shim = path.join(f.root, '.local/bin/hermitd');
  write(shim, '#!/bin/sh\necho foreign\n');
  expect(JSON.parse((await f.run(['install'], f.p)).stdout)).toEqual({ status: 'skip', reason: 'foreign_target', path: shim });
  expect(fs.readFileSync(shim, 'utf8')).toContain('echo foreign'); fs.unlinkSync(shim);
  write(path.join(f.bin, 'hermitd'), '#!/bin/sh\nexit 0\n');
  const r = await f.run(['install'], f.p);
  expect(r.exitCode).toBe(0); expect(r.stderr).toContain(path.join(f.bin, 'hermitd')); expect(r.stderr).toContain(shim);
});

test('agents runs claude agents on the host with the session config dir', async () => {
  const f = fixture();
  expect((await f.run(['agents', '--json'], f.p)).exitCode).toBe(0);
  expect(f.calls()).toBe(`claude|${f.p}|${path.join(f.root, '.claude')}|agents --json\n`);
  write(path.join(f.p, '.hermit/state/runtime.json'), JSON.stringify({ config_dir: '/srv/claude' }));
  expect((await f.run(['agents', 'demo', '--all'], f.root, { AGENTS_EXIT: '3' })).exitCode).toBe(3);
  expect(f.calls()).toContain(`claude|${f.p}|/srv/claude|agents --all\n`);
});
test('agents routes a Docker hermit into the container and refuses a live-owner conflict', async () => {
  const f = fixture(); write(path.join(f.p, 'docker-compose.hermit.yml'), 'services: {}');
  expect((await f.run(['agents', 'demo', '--json'], f.root, { DOCKER_LIVE: 'hermit' })).exitCode).toBe(0);
  expect((await f.run(['docker', 'agents', '--json'], f.p)).exitCode).toBe(0);
  expect(f.calls()).toBe(`old|${f.p}|agents --json\nold|${f.p}|agents --json\n`);
  write(path.join(f.p, '.hermit/state/runtime.json'), '{"runtime_mode":"interactive"}');
  expect((await f.run(['agents', 'demo'])).exitCode).toBe(0);
  expect(f.calls()).toContain(`claude|${f.p}|${path.join(f.root, '.claude')}|agents\n`);
  write(path.join(f.p, '.hermit/state/runtime.json'), '{"tmux_session":"hermit-demo"}');
  const r = await f.run(['agents', 'demo'], f.root, { TMUX_LIVE: '0', DOCKER_LIVE: 'hermit' });
  expect(r.exitCode).toBe(1); expect(r.stderr).toContain('Live-owner conflict');
});
test('skills resolves named and nearest projects and routes Docker mutations', async () => {
  const f = fixture();
  expect((await f.run(['skills', 'demo', 'pin', 'sample', '--origin', 'operator'])).exitCode).toBe(0);
  expect(f.calls()).toContain(`skills|${f.p}|pin sample --origin operator\n`);
  expect((await f.run(['skills', 'status', '--skill', 'sample'], f.p)).exitCode).toBe(0);
  expect(f.calls()).toContain(`skills|${f.p}|status --skill sample\n`);
  write(path.join(f.p, 'docker-compose.hermit.yml'), 'services: {}');
  expect((await f.run(['skills', 'demo', 'rollback', 'sample'], f.root, { DOCKER_LIVE: 'hermit' })).exitCode).toBe(0);
  expect(f.calls()).toContain(`old|${f.p}|skills rollback sample\n`);
});
