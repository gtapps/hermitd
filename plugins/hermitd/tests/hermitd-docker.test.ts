import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLUGIN_ROOT, SCRIPTS_DIR, runBash } from './helpers/run';
import { setupWorkdir, freshDirFactory, hermit, write, readJson } from './helpers/workdir';
import { appliedSet, contextsName } from '../scripts/lib/approval';
import { doctorPassStub, listDuplicateScopes, runInterruptedBash } from './helpers/plugin-update';

const { freshDir: freshDockerHome, cleanup: cleanupDockerHomes } = freshDirFactory('hermit-docker-home-');
afterAll(cleanupDockerHomes);

describe('static file checks', () => {
  test('hermitd-docker update hands off to the shared update sequence', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hermitd-docker.sh'), 'utf8');
    const update = src.slice(src.indexOf('\n  update)'), src.indexOf('\n  update-step)'));
    // The running check and the boot-owner verdict come before anything moves.
    expect(update.indexOf('_require_running')).toBeLessThan(update.indexOf('_refuse_if_host_tmux_owner'));
    expect(update.indexOf('_refuse_if_host_tmux_owner')).toBeLessThan(update.indexOf('exec bun "$HOST_SCRIPTS/lib/update-sequence.ts" docker'));
  });

  test('hermitd-docker warns when the container runs a stale baked entrypoint', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hermitd-docker.sh'), 'utf8');
    // The guard content-hashes the on-disk entrypoint against the image's baked copy.
    expect(src).toContain('_warn_if_entrypoint_stale()');
    expect(src).toContain('/home/claude/docker-entrypoint.sh');
    expect(src).toContain('sha256sum');
    // `up` invokes it after bringing the container up.
    const upIdx = src.indexOf('_dc up -d "$@"');
    const upGuardIdx = src.indexOf('_warn_if_entrypoint_stale', upIdx);
    expect(upIdx).toBeGreaterThan(-1);
    expect(upGuardIdx).toBeGreaterThan(upIdx);
    // `update` warns only in --plugins-only mode (rebuild modes fix it inline).
    expect(src).toContain('[ "$PLUGINS_ONLY" = true ] && _warn_if_entrypoint_stale');
    // Evolve completes before the image build.
    expect(src).not.toContain('once more');
  });

  test('hermitd-docker setup-token gates on the container core version', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hermitd-docker.sh'), 'utf8');
    expect(src).toContain('_require_core_version_at_least()');
    expect(src).toContain('sort -V');
    // The gate runs before the mint dispatch, so a stale clone is caught up front.
    const gateIdx = src.indexOf('_require_core_version_at_least "1.2.30" "setup-token"');
    const mintIdx = src.indexOf('hermitd-run setup-token-mint terminal');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(mintIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(mintIdx);
  });

  test('hermitd-docker login switches a running hermit through the staged relay', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hermitd-docker.sh'), 'utf8');
    const login = src.slice(src.indexOf('\n  login)'), src.indexOf('\n  logs)'));

    // A running container already has a tmux server, so the sign-in goes through the
    // same staged path a channel-relayed renewal uses.
    const aliveIdx = login.indexOf('tmux has-session -t "$TMUX_SESSION"');
    const relayIdx = login.indexOf('setup-token-mint terminal --target login');
    expect(aliveIdx).toBeGreaterThan(-1);
    expect(relayIdx).toBeGreaterThan(aliveIdx);
    expect(login).toContain('hermitd-watchdog restart reauth');

    // Token mode no longer dead-ends: it explains the switch and continues.
    expect(login).toContain('Continuing switches it to a claude.ai sign-in');
    expect(login.slice(login.indexOf('$TOKEN_MODE'), aliveIdx)).not.toContain('exit 0');

    // The REPL path stays for a container with no session yet, and the mode is
    // written only AFTER the credential check — never before one exists.
    const replIdx = login.indexOf('Opening Claude Code REPL for login');
    const checkIdx = login.indexOf('.credentials.json not found');
    const writeIdx = login.indexOf("set auth_mode login");
    expect(replIdx).toBeGreaterThan(relayIdx);
    expect(writeIdx).toBeGreaterThan(checkIdx);
  });

  // A token hermit keeps its old sign-in on the volume, so the REPL path accepts only
  // a credential file the REPL rewrote with a usable login, never one that merely exists.
  test('hermitd-docker login REPL check needs a rewritten, usable sign-in', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hermitd-docker.sh'), 'utf8');
    const snippet = (start: string) => {
      const from = src.indexOf(`'bun -e "${start}`);
      return src.slice(from + 1, src.indexOf(`'`, from + 1));
    };
    const before = snippet('try{console.log(require');
    const after = snippet('const fs=require');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-login-check-'));
    const cred = (dir: string, token: string) =>
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
    const run = (name: string, seed: string | null, repl: string | null): number => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      if (seed !== null) cred(dir, seed);
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
      const mtime = execFileSync('sh', ['-c', before], { env, encoding: 'utf8' }).trim();
      if (repl !== null) {
        cred(dir, repl);
        const t = new Date(Date.now() + 5000);
        fs.utimesSync(path.join(dir, '.credentials.json'), t, t);
      }
      try {
        execFileSync('sh', ['-c', after, '_', mtime], { env, stdio: 'ignore' });
        return 0;
      } catch (e: any) {
        return e.status;
      }
    };
    try {
      expect(run('absent', null, null)).toBe(1);
      expect(run('stale-unchanged', 'old', null)).toBe(1);
      expect(run('rewritten-stub', 'old', '')).toBe(1);
      expect(run('rewritten-usable', 'old', 'new')).toBe(0);
      expect(run('fresh-install', null, 'new')).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hermitd-docker running-container gate', () => {
  function fixture(mode: 'running' | 'stopped' | 'failed' | 'invalid') {
    const wd = setupWorkdir();
    const proj = wd.dir;
    const binDir = hermit(proj, 'bin');
    const stateDir = hermit(proj, 'state');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    for (const name of ['hermitd-docker', 'hermitd-attach', 'hermitd-run']) {
      const dest = path.join(binDir, name);
      fs.copyFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin', name), dest);
      fs.chmodSync(dest, 0o755);
    }

    write(hermit(proj, 'config.json'), JSON.stringify({
      tmux_session_name: 'hermit-{project_name}',
    }));
    write(path.join(stateDir, 'runtime.json'), JSON.stringify({
      runtime_mode: 'docker',
      tmux_session: `hermit-${path.basename(proj)}`,
    }));
    write(path.join(proj, 'docker-compose.hermit.yml'), 'services:\n  hermit:\n    image: test\n');
    write(path.join(proj, 'Dockerfile.hermit'), 'FROM ubuntu:26.04\n');
    write(path.join(proj, 'docker-compose.security.yml'), 'services:\n  hermit:\n    environment: []\n');

    const stubDir = path.join(proj, '.stub');
    const callsFile = path.join(stubDir, 'docker-calls.txt');
    fs.mkdirSync(stubDir, { recursive: true });
    write(path.join(stubDir, 'docker'), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_STUB_CALLS"
if [[ " $* " == *" config -q "* ]] && [ "$DOCKER_STUB_MODE" = "invalid" ]; then
  printf 'services.hermit.volumes must be a list\n' >&2
  exit 42
fi
if [[ " $* " == *" ps --status running "* ]]; then
  case "$DOCKER_STUB_MODE" in
    running) printf 'hermit\n'; exit 0 ;;
    stopped) printf 'hermit-netguard\n'; exit 0 ;;
    failed)
      for i in 1 2 3 4 5 6 7; do
        printf 'probe-line-%s:%0400d\n' "$i" 0 >&2
      done
      exit 23
      ;;
  esac
fi
case "$*" in
  *"claude plugin list --json"*) printf '[{"id":"hermitd@mp","enabled":true,"scope":"user","installPath":"/installed/core"}]\\n' ;;
  *"doctor-check.ts"*) printf '{"checks":[{"id":"runtime","status":"ok","detail":"ready"}]}\\n' ;;
  *"harness-request"*) printf '{"status":"queued","id":"upgrade"}\\n' ;;
esac
exit 0
`);
    fs.chmodSync(path.join(stubDir, 'docker'), 0o755);

    return {
      wd,
      proj,
      callsFile,
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        HERMIT_PLUGIN_ROOT: PLUGIN_ROOT, HOME: freshDockerHome(), CLAUDE_CONFIG_DIR: path.join(proj, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(proj, 'plugins'),
        DOCKER_STUB_CALLS: callsFile,
        DOCKER_STUB_MODE: mode,
      },
    };
  }

  for (const mode of ['running', 'stopped'] as const) {
    for (const args of [['doctor'], ['doctor', 'evolve', '1.4.30']]) {
      test(`doctor ${args.slice(1).join(' ')} with container ${mode}`, async () => {
        const f = fixture(mode);
        try {
          const r = await runBash(hermit(f.proj, 'bin', 'hermitd-docker'), { args, cwd: f.proj, env: f.env });
          expect(r.exitCode).toBe(mode === 'running' ? 0 : 1);
          const calls = fs.readFileSync(f.callsFile, 'utf8');
          if (mode === 'stopped') {
            expect(r.stderr).toContain('hermitd start');
            expect(calls).not.toContain('exec -T');
          } else if (args.length === 1) {
            expect(JSON.parse(r.stdout).checks[0].status).toBe('ok');
            expect(calls).toContain('exec -T hermit bun /installed/core/scripts/doctor-check.ts .hermit');
          } else {
            expect(JSON.parse(r.stdout)).toEqual({ status: 'queued', id: 'upgrade' });
            expect(calls).toContain('harness-request /reload-plugins --then /hermitd:hermit-evolve unattended --expect-version 1.4.30 --purpose upgrade');
          }
        } finally { f.wd.cleanup(); }
      });
    }
  }

  test('running service reaches the configured tmux session', async () => {
    const f = fixture('running');
    try {
      const r = await runBash(hermit(f.proj, 'bin', 'hermitd-docker'), {
        args: ['attach'],
        cwd: f.proj,
        env: f.env,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`[hermit] Attaching to tmux session: hermit-${path.basename(f.proj)}`);
      const calls = fs.readFileSync(f.callsFile, 'utf8');
      expect(calls).toContain('ps --status running --format {{.Service}}');
      expect(calls).toContain(`exec hermit tmux -u attach -t hermit-${path.basename(f.proj)}`);
    } finally {
      f.wd.cleanup();
    }
  });

  test('stopped service prints start guidance through both attach entrypoints', async () => {
    const f = fixture('stopped');
    try {
      for (const name of ['hermitd-docker', 'hermitd-attach']) {
        const r = await runBash(hermit(f.proj, 'bin', name), {
          args: name === 'hermitd-docker' ? ['attach'] : [],
          cwd: f.proj,
          env: f.env,
        });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain('[hermit] Container is not running. Start it first:');
        expect(r.stderr).toContain('hermitd start');
        expect(r.stderr).not.toContain('Could not query Docker Compose');
      }
    } finally {
      f.wd.cleanup();
    }
  });

  test('failed Compose probe prints a bounded underlying cause', async () => {
    const f = fixture('failed');
    try {
      const r = await runBash(hermit(f.proj, 'bin', 'hermitd-docker'), {
        args: ['attach'],
        cwd: f.proj,
        env: f.env,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('[hermit] Could not query Docker Compose for running services.');
      expect(r.stderr).not.toContain('Container is not running');
      const diagnosticLines = r.stderr.split('\n').filter(line => line.startsWith('probe-line-'));
      expect(diagnosticLines).toHaveLength(5);
      expect(diagnosticLines.every(line => line.length <= 300)).toBe(true);
      expect(r.stderr).not.toContain('probe-line-6:');
    } finally {
      f.wd.cleanup();
    }
  });

  test('hermitd-docker refuses up when compose config -q fails', async () => {
    const f = fixture('invalid');
    try {
      const backup = hermit(f.proj, 'state', 'docker-compose.hermit.yml.20260831T010203Z.bak');
      write(backup, 'services:\n  hermit:\n    image: previous\n');
      const r = await runBash(hermit(f.proj, 'bin', 'hermitd-docker'), {
        args: ['up'],
        cwd: f.proj,
        env: f.env,
      });

      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('services.hermit.volumes must be a list');
      expect(r.stderr).toContain('docker-compose.override.yml');
      const calls = fs.readFileSync(f.callsFile, 'utf8');
      expect(calls).toContain('config -q');
      expect(calls).not.toContain('up -d');
    } finally {
      f.wd.cleanup();
    }
  });
});

describe('hermitd-docker update plugin loop', () => {
  for (const scenario of ['doctor-fails', 'doctor-no-report', 'verdict-fail', 'interrupted', 'plugins-only', 'full', 'cc-only', 'evolve-timeout', 'evolve-ready', 'evolve-pending', 'evolve-suffix', 'old-watchdog', 'below-floor', 'below-floor-plugins-only', 'engine-held', 'symlink-log', 'symlink-state']) {
  test(`quiet update: ${scenario}`, async () => {
    const wd = setupWorkdir();
    const dockerHome = freshDockerHome();
    const outerState = scenario.startsWith('symlink-') ? setupWorkdir() : undefined;
    const proj = wd.dir;
    try {
      fs.mkdirSync(hermit(proj, 'bin'), { recursive: true });
      for (const name of ['hermitd-docker', 'hermitd-run']) {
        const dest = hermit(proj, 'bin', name);
        fs.copyFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin', name), dest);
        fs.chmodSync(dest, 0o755);
      }
      const runner = hermit(proj, 'bin/hermitd-run');
      write(runner, '#!/bin/sh\necho project-wrapper-ran >&2\nexit 8\n');
      write(hermit(proj, 'config.json'), JSON.stringify({ channels: {}, docker: { packages: ['poppler-utils'] }, tmux_session_name: 'hermit-test', _hermit_versions: scenario.startsWith('evolve-') || scenario.startsWith('below-floor') || scenario === 'interrupted' || scenario === 'old-watchdog' ? { hermitd: '0.0.1', 'hermitd-scribe': '0.0.1' } : {} }));
      write(path.join(proj, 'docker-compose.hermit.yml'), 'services:\n  hermit:\n    image: test\n');
      write(path.join(proj, 'Dockerfile.hermit'), 'FROM ubuntu:26.04\n');
      if (['full', 'evolve-ready', 'below-floor'].includes(scenario)) write(path.join(proj, 'Dockerfile.hermit'), '# Generated by hermitd 0.0.1\nstale\n');
      const stub = path.join(proj, '.stub');
      fs.mkdirSync(stub);
      const callsFile = path.join(stub, 'docker-calls.txt');
      if (outerState) {
        write(path.join(outerState.dir, 'update-history.jsonl'), 'host log\n');
        write(path.join(outerState.dir, 'update-in-progress.json'), 'host marker\n');
        if (scenario === 'symlink-state') {
          fs.rmdirSync(hermit(proj, 'state'));
          fs.symlinkSync(outerState.dir, hermit(proj, 'state'));
        } else {
          for (const name of ['update-history.jsonl', 'update-in-progress.json']) {
            fs.symlinkSync(path.join(outerState.dir, name), hermit(proj, 'state', name));
          }
        }
      }
      write(path.join(stub, 'bun'), `#!/usr/bin/env bash
case "$1" in
  */hermitd-cli.ts)
    shift
    if [ "$1" = install ]; then echo OK; exit 0; fi
    set -- hermitd-cli "$@"
    ${doctorPassStub}
    exit 8 ;;
  *) exec "${process.execPath}" "$@" ;;
esac
`);
      fs.chmodSync(path.join(stub, 'bun'), 0o755);
      const suffix = scenario === 'evolve-suffix' ? '-467be32f41fc' : '';
      const list = JSON.parse(listDuplicateScopes(proj, suffix));
      if (scenario.startsWith('below-floor')) for (const p of list) p.installPath = `/cache/${p.id.split('@')[0]}/${p.version}`;
      write(path.join(stub, 'list.json'), JSON.stringify(list));
      write(path.join(stub, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_STUB_CALLS"
echo "HERMIT_BROWSER=$HERMIT_BROWSER" >> "$DOCKER_STUB_CALLS"
if [[ " $* " == *" up -d "* ]]; then echo "HERMIT_RESUME=$HERMIT_RESUME" >> "$DOCKER_STUB_CALLS"; fi
if [[ " $* " == *" build "* ]]; then
  for arg in "$@"; do
    case "$arg" in
      */docker-compose.hermit.yml)
        if grep -q 'poppler-utils' "$(dirname "$arg")/Dockerfile.hermit"; then echo RENDERED_BEFORE_BUILD >> "$DOCKER_STUB_CALLS"; fi
        break ;;
    esac
  done
fi
if [[ " $* " == *" exec "* ]]; then
  cat >/dev/null
fi
case "$*" in
  *".claude-plugin/plugin.json"*) [[ "$UPDATE_SCENARIO" != below-floor* ]] || echo '{"engines":{"claude-code":">=2.1.308"}}' ;;
  *"exec -T hermit claude plugin update hermitd@hermitd --scope project --json"*)
    [ "$UPDATE_SCENARIO" != engine-held ] || echo '{"command":"update","outcome":"ok","message":"Skipped: hermitd stays at 1.2.14.","updateOutcome":"skipped","skipReason":"engine_range"}' ;;
  *"await-upgrade"*)
    count=0
    [ ! -f "$DOCKER_STUB_CALLS.await" ] || read -r count < "$DOCKER_STUB_CALLS.await"
    count=$((count + 1)); echo "$count" > "$DOCKER_STUB_CALLS.await"
    if [ "$UPDATE_SCENARIO" = interrupted ] && [ "$count" = 1 ]; then
      : > "$DOCKER_STUB_CALLS.ready"
      exec sleep 30
    fi
    if [ "$UPDATE_SCENARIO" = old-watchdog ]; then echo 'unknown subcommand'; exit 1; fi
    if [ "$UPDATE_SCENARIO" = evolve-timeout ]; then
      echo '{"status":"timeout","reason":"worker_running"}'
    else
      echo '{"status":"ready"}'
    fi ;;
  *"harness-request"*)
    if [ "$UPDATE_SCENARIO" = evolve-ready ]; then printf 'services: {}\\n' > docker-compose.override.yml; fi
    if [ "$UPDATE_SCENARIO" = evolve-pending ]; then echo '{"status":"unknown","reason":"wait_timeout"}'; else echo '{"status":"ok"}'; fi ;;
  *"npm view"*) echo '2.1.302' ;;
  *"ps --status running"*) echo hermit ;;
  *"claude plugin list --json"*) cat "$DOCKER_STUB_LIST" ;;
  *"claude --version"*) echo '2.1.301 (Claude Code)' ;;
  *"tmux capture-pane"*) printf '❯ ────────\\n' ;;
esac
exit 0
`);
      fs.chmodSync(path.join(stub, 'docker'), 0o755);
      const runUpdate = scenario === 'interrupted'
        ? (script: string, opts: NonNullable<Parameters<typeof runBash>[1]>) => runInterruptedBash(script, opts, `${callsFile}.ready`)
        : runBash;
      const r = await runUpdate(path.join(SCRIPTS_DIR, 'hermitd-docker.sh'), {
        args: ['update', ...(scenario === 'plugins-only' || scenario === 'below-floor-plugins-only' ? ['--plugins-only'] : scenario === 'cc-only' ? ['--cc-only'] : []), '--yes'], cwd: proj,
        env: {
          PATH: `${stub}:${process.env.PATH}`, HERMIT_PLUGIN_ROOT: PLUGIN_ROOT,
          HOME: dockerHome, CLAUDE_CONFIG_DIR: path.join(proj, 'config'),
          CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(proj, 'plugins'),
          UPDATE_SCENARIO: scenario, DOCKER_STUB_CALLS: callsFile, DOCKER_STUB_LIST: path.join(stub, 'list.json'),
        },
      });
      expect(r.stderr).not.toContain('project-wrapper-ran');
      if (outerState) {
        expect(fs.readFileSync(path.join(outerState.dir, 'update-history.jsonl'), 'utf8')).toBe('host log\n');
        expect(fs.readFileSync(path.join(outerState.dir, 'update-in-progress.json'), 'utf8')).toBe('host marker\n');
        expect(r.exitCode).toBe(scenario === 'symlink-state' ? 1 : 0);
        return;
      }
      if (scenario === 'interrupted') {
        expect(r.exitCode).toBe(130);
        expect(r.stderr).toContain('Update interrupted before the restart; rerun `hermitd update` to finish.');
        expect(fs.existsSync(hermit(proj, 'state', 'update-in-progress.json'))).toBe(false);
        expect(fs.readFileSync(callsFile, 'utf8')).not.toContain(' down');
        return;
      }
      expect(r.exitCode).toBe(0);
      const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n');
      if (['full', 'evolve-ready', 'below-floor'].includes(scenario)) expect(calls).toContain('RENDERED_BEFORE_BUILD');
      if (scenario === 'evolve-ready') {
        const set = appliedSet(proj, path.join(dockerHome, '.claude'))!;
        const override = '-f ' + path.join(set, 'docker-compose.override.yml');
        expect(calls.find(line => line.includes(' build '))).toContain(override);
        expect(calls.find(line => line.endsWith(' up -d'))).toContain(override);
      }
      if (scenario === 'cc-only') expect(r.stdout).toContain('hermitd setup docker-customize');
      const entry = readJson(hermit(proj, 'state', 'update-history.jsonl'));
      expect(fs.existsSync(hermit(proj, 'state', 'update-in-progress.json'))).toBe(false);
      expect(calls).toContain('HERMIT_BROWSER=1');
      const idx = (text: string) => calls.findIndex(l => l.includes(text));
      const timeout = scenario.includes('timeout');
      const blocked = scenario === 'below-floor-plugins-only';
      expect(r.stdout).toContain('fixture doctor pass');
      expect(r.stdout.includes('fixture doctor pass --fix')).toBe(!blocked);
      expect(entry.doctor).toEqual(scenario.startsWith('doctor-') ? { status: 'error' }
        : { status: 'ran', issues: [{ id: 'watchdog', status: 'warn' }] });
      expect(r.stderr.includes('doctor check could not run; run `hermitd doctor`')).toBe(scenario.startsWith('doctor-'));
      expect(entry.restarted).toBe(!timeout && !blocked);
      expect(entry.await.status).toBe(timeout ? 'timeout' : blocked ? 'blocked' : 'ready');
      expect(entry.image_built).toBe(!['plugins-only', 'evolve-timeout', 'below-floor-plugins-only'].includes(scenario));
      expect(idx(' down') >= 0).toBe(!timeout && !blocked);
      expect(idx(' up -d') >= 0).toBe(!timeout && !blocked);
      if (timeout) {
        expect(r.stderr).toContain('worker_running');
        expect(r.stderr).toContain('rerun `hermitd update`');
        expect(entry.cc_after).toBe('2.1.301');
      } else if (blocked) {
        expect(entry.await.reason).toBe('cc_below_floor');
        expect(idx('harness-request')).toBe(-1);
        expect(r.stdout).toContain('Update blocked');
        expect(r.stdout).not.toContain('/reload-plugins not sent');
      } else {
        expect(calls).toContain('HERMIT_RESUME=1');
        // Every scenario that queues evolve waits for it before the bounce.
        if (scenario.startsWith('evolve-') || scenario === 'old-watchdog') {
          expect(idx('await-upgrade')).toBeGreaterThan(-1);
          expect(idx('await-upgrade')).toBeLessThan(idx(' down'));
        }
      }
      if (scenario === 'evolve-timeout') expect(r.stdout).toContain('Update paused');
      if (scenario === 'cc-only') {
        expect(idx('claude plugin update ')).toBe(-1);
      } else {
      expect(calls.filter(l => l.includes('claude plugin update ')).map(l => l.slice(l.indexOf('claude plugin update ')))).toEqual([
        'claude plugin update hermitd@hermitd --scope local --json',
        'claude plugin update hermitd@hermitd --scope project --json',
        'claude plugin update hermitd-scribe@hermitd --scope project --json',
      ]);
      expect(calls.filter(l => l.includes('claude plugin marketplace update '))).toHaveLength(1);
      expect(entry.plugins).toEqual([
        { id: 'hermitd@hermitd', scope: 'local', before: `1.2.0${suffix}`, after: `1.2.0${suffix}`, status: 'unchanged' },
        { id: 'hermitd@hermitd', scope: 'project', before: `1.2.14${suffix}`, after: `1.2.14${suffix}`, status: 'unchanged' },
        { id: 'hermitd-scribe@hermitd', scope: 'project', before: `0.0.5${suffix}`, after: `0.0.5${suffix}`, status: 'unchanged' },
      ]);
      }
      if (scenario === 'evolve-ready') {
        expect(r.stdout).toContain('Waiting for hermit-evolve');
      }
      if (scenario === 'full' || scenario === 'cc-only') {
        // No version gap: nothing waits before the pins move, and only an evolve turn still
        // running from an earlier stamp is waited on before the bounce.
        expect(r.stderr).not.toContain('Update interrupted');
        expect(r.stdout).not.toContain('Waiting for');
        expect(calls.filter(l => l.includes('await-upgrade'))).toHaveLength(1);
        expect(idx('await-upgrade')).toBeGreaterThan(idx(' build '));
        expect(idx('await-upgrade')).toBeLessThan(idx(' down'));
      }
      if (scenario === 'evolve-pending') expect(r.stderr).not.toContain('did not complete');
      if (scenario === 'evolve-ready' || scenario === 'evolve-pending') {
        expect(idx('harness-request')).toBeLessThan(idx('await-upgrade --expect'));
        expect(idx('await-upgrade --expect')).toBeLessThan(idx(' build '));
        // The evolve wait before the build, then one check for a running evolve turn before the bounce.
        const waits = calls.filter(l => l.includes('await-upgrade'));
        expect(waits).toHaveLength(2);
        expect(waits[0]).toContain('await-upgrade --expect');
        expect(waits[1]).toMatch(/await-upgrade$/);
        expect(calls.findLastIndex(l => l.includes('await-upgrade'))).toBeLessThan(idx(' down'));
      }
      if (scenario === 'full' || scenario === 'evolve-ready') {
        expect(idx('claude plugin marketplace update')).toBeLessThan(idx(' build '));
        expect(idx(' build ')).toBeLessThan(idx(' down'));
        expect(idx(' down')).toBeLessThan(idx(' up -d'));
      }
      if (scenario.startsWith('evolve-')) {
        const wait = calls.find(l => l.includes('await-upgrade --expect')) ?? '';
        expect(wait).toContain('--expect hermitd=1.2.0');
        expect(wait).not.toContain('hermitd=1.2.14');
        expect(wait).toContain('--expect hermitd-scribe=0.0.5');
        expect(wait).not.toContain('467be32f41fc');
        expect(idx('/hermitd:hermit-evolve')).toBeLessThan(idx('await-upgrade --expect'));
        // One queued batch for the core mod: reload, then evolve, waited on from outside.
        const request = calls.find(l => l.includes('harness-request')) ?? '';
        expect(request).toContain('harness-request /reload-plugins --then /hermitd:hermit-evolve unattended --expect-version 1.2.0 --source update --wait 300 --purpose upgrade');
      }
      expect(calls.some(l => l.includes('send-keys') || l.includes('capture-pane'))).toBe(false);
      if (scenario === 'below-floor') {
        // Evolve would stop on the old Claude Code, so the image is rebuilt first and boot runs it.
        expect(r.stdout).toContain('below an updated plugin\'s minimum');
        expect(r.stdout).toContain('load at boot on the rebuilt image');
        expect(idx('harness-request')).toBe(-1);
        expect(idx('cat /cache/hermitd/1.2.0/.claude-plugin/plugin.json')).toBeGreaterThan(idx('claude plugin update '));
        expect(idx(' build ')).toBeLessThan(idx(' down'));
        expect(idx(' run --rm')).toBe(-1);
      }
      if (scenario === 'engine-held') {
        // The running Claude Code misses the new core's engines range, so the core stays put;
        // the rebuilt image updates it before the bounce and boot runs the pending evolve.
        expect(r.stdout).toContain('below an updated plugin\'s minimum');
        expect(r.stderr).toContain('Skipped: hermitd stays at 1.2.14.');
        expect(idx('harness-request')).toBe(-1);
        const held = idx('run --rm --no-deps -T --entrypoint claude hermit plugin update hermitd@hermitd --scope project');
        expect(held).toBeGreaterThan(idx(' build '));
        expect(held).toBeLessThan(idx(' down'));
        expect(calls.filter(l => l.includes(' run --rm'))).toHaveLength(1);
      }
      if (scenario === 'old-watchdog') {
        expect(r.stderr.split('await-upgrade unavailable')).toHaveLength(2);
      }

    } finally { outerState?.cleanup(); wd.cleanup(); }
  }, 30000);
  }
});

describe('hermitd-docker up host tmux guard', () => {
  // The fake tmux reports only the exact-match `=hermit-demo` target alive; the
  // fake docker records its argv so a refused boot shows no `up -d`, and reports
  // the service running so restart gets past its running check.
  async function up(runtime: object, env: Record<string, string> = {}, cmd = 'up', freshLiveness = false) {
    const wd = setupWorkdir();
    const proj = wd.dir;
    fs.mkdirSync(hermit(proj, 'bin'), { recursive: true });
    fs.mkdirSync(hermit(proj, 'state'), { recursive: true });
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin', 'hermitd-docker'), hermit(proj, 'bin', 'hermitd-docker'));
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin', 'hermitd-run'), hermit(proj, 'bin', 'hermitd-run'));
    fs.chmodSync(hermit(proj, 'bin', 'hermitd-run'), 0o755);
    write(hermit(proj, 'config.json'), JSON.stringify({ tmux_session_name: 'hermit-demo' }));
    write(path.join(proj, 'docker-compose.hermit.yml'), 'services: {}\n');
    write(path.join(proj, 'Dockerfile.hermit'), 'FROM ubuntu:26.04\n');
    write(hermit(proj, 'state', 'runtime.json'), JSON.stringify(runtime));
    if (freshLiveness) write(hermit(proj, 'state', 'routine-monitor-liveness.json'), '{}');
    const stub = path.join(proj, '.stub');
    const dockerLog = path.join(stub, 'docker.log');
    fs.mkdirSync(stub);
    write(path.join(stub, 'docker'), `#!/usr/bin/env bash\necho "$*" >> "${dockerLog}"\ncase "$*" in *" ps "*) echo hermit ;; *"up -d"*) echo "HERMIT_RESUME=\${HERMIT_RESUME:-unset}" >> "${dockerLog}" ;; esac\nexit 0\n`);
    write(path.join(stub, 'tmux'), '#!/usr/bin/env bash\n[ "$1 $2 $3" = "has-session -t =hermit-demo" ] && exit 0\nexit 1\n');
    write(path.join(stub, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    for (const f of ['docker', 'tmux', 'sleep']) fs.chmodSync(path.join(stub, f), 0o755);
    try {
      const r = await runBash(hermit(proj, 'bin', 'hermitd-docker'), {
        args: cmd.split(' '), cwd: proj, env: { HERMIT_PLUGIN_ROOT: PLUGIN_ROOT, HOME: freshDockerHome(), CLAUDE_CONFIG_DIR: path.join(proj, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(proj, 'plugins'), PATH: `${stub}:${process.env.PATH}`, ...env },
      });
      const calls = fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, 'utf8') : '';
      return { ...r, booted: calls.includes('up -d'), resume: /HERMIT_RESUME=(\S+)/.exec(calls)?.[1] };
    } finally { wd.cleanup(); }
  }

  test('refuses while the recorded host tmux session is alive', async () => {
    const r = await up({ runtime_mode: 'tmux', tmux_session: 'hermit-demo' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("host tmux session for this project's 'tmux' hermit");
    expect(r.booted).toBe(false);
  });

  // An inert container left by a boot conflict still counts as running, so
  // restart reaches the entrypoint just like up does.
  test('restart refuses too while the host tmux session is alive', async () => {
    const r = await up({ runtime_mode: 'tmux', tmux_session: 'hermit-demo' }, {}, 'restart');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("host tmux session for this project's 'tmux' hermit");
    expect(r.booted).toBe(false);
  });

  // The same verdict the entrypoint gives: a fresh liveness file without the
  // tmux session is a live orphan, and the container would only go inert over it.
  test('refuses a live orphan whose tmux session is gone', async () => {
    const r = await up({ runtime_mode: 'tmux', tmux_session: 'hermit-dem' }, {}, 'up', true);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("a live 'tmux' instance owns this project's state dir");
    expect(r.booted).toBe(false);
  });

  test('boots when the session is gone, the record is docker, or HERMIT_FORCE_BOOT=1', async () => {
    expect((await up({ runtime_mode: 'tmux', tmux_session: 'hermit-dem' })).booted).toBe(true);
    expect((await up({ runtime_mode: 'docker', tmux_session: 'hermit-demo' })).booted).toBe(true);
    expect((await up({ runtime_mode: 'tmux', tmux_session: 'hermit-demo' }, { HERMIT_FORCE_BOOT: '1' })).booted).toBe(true);
  }, 20000);

  test('restart resumes by default, --fresh starts clean, up stays fresh', async () => {
    const docker = { runtime_mode: 'docker', tmux_session: 'hermit-demo' };
    expect((await up(docker, {}, 'restart')).resume).toBe('1');
    expect((await up(docker, {}, 'restart --resume')).resume).toBe('1');
    expect((await up(docker, {}, 'restart --fresh')).resume).toBe('0');
    expect((await up(docker)).resume).toBe('unset');
  }, 20000);
});

test('Docker run, pause, skills and watchdog dispatch only into a running container', async () => {
  const wd = setupWorkdir();
  try {
    const project = wd.dir;
    const bin = hermit(project, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    write(hermit(project, 'config.json'), '{}');
    write(path.join(project, 'docker-compose.hermit.yml'), 'services: {}');
    const stub = path.join(project, 'docker');
    fs.writeFileSync(stub, `#!/bin/sh
case " $* " in
  *" ps "*) [ "$RUNNING" != yes ] || echo hermit ;;
  *" exec "*) printf '%s\\n' "$*"; exit 7 ;;
esac
`, { mode: 0o755 });
    const home = freshDockerHome();
    const invoke = (args: string[], running: boolean) => runBash(path.join(SCRIPTS_DIR, 'hermitd-docker.sh'), {
      args, cwd: project, env: { HOME: home, PATH: `${project}:${process.env.PATH}`, RUNNING: running ? 'yes' : 'no' },
    });
    for (const [verb, command] of [['run', 'backup'], ['pause', 'status'], ['skills', 'status'], ['watchdog', 'run']]) {
      fs.writeFileSync(path.join(bin, `hermitd-${verb}`), '#!/bin/sh\necho project-wrapper-ran >&2\nexit 8\n', { mode: 0o755 });
      expect(await invoke([verb, command], true)).toMatchObject({
        exitCode: 7, stdout: expect.stringContaining(`exec -T hermit .hermit/bin/hermitd-${verb} ${command}`), stderr: '',
      });
      expect(await invoke([verb, command], false)).toMatchObject({
        exitCode: 1, stderr: expect.stringContaining('hermitd start'),
      });
    }
    for (const command of ['install', 'uninstall']) {
      expect(await invoke(['watchdog', command], true)).toMatchObject({
        exitCode: 1, stderr: expect.stringContaining('The container runs its own watchdog.'),
      });
    }
  } finally { wd.cleanup(); }
});

describe('hermitd-docker restart build arguments', () => {
  for (const enabled of [false, true, undefined]) {
    test(`restart --build exports browser and transcription=${enabled}`, async () => {
      const wd = setupWorkdir();
      const proj = wd.dir;
      try {
        fs.mkdirSync(hermit(proj, 'bin'), { recursive: true });
        write(hermit(proj, 'config.json'), JSON.stringify({ browser: { enabled }, transcription: { enabled } }));
        write(path.join(proj, 'docker-compose.hermit.yml'), 'services: {}');
        write(path.join(proj, 'Dockerfile.hermit'), 'FROM ubuntu:26.04\n');
        const stub = path.join(proj, '.stub');
        fs.mkdirSync(stub);
        const callsFile = path.join(stub, 'docker-calls.txt');
        write(path.join(stub, 'docker'), '#!/bin/sh\necho "$HERMIT_BROWSER $HERMIT_TRANSCRIPTION $*" >> "$DOCKER_STUB_CALLS"\ncase "$*" in *"claude --version"*) echo "2.1.301";; *"ps --status running"*) echo hermit;; esac\n');
        fs.chmodSync(path.join(stub, 'docker'), 0o755);
        write(hermit(proj, 'bin', 'hermitd-run'), '#!/bin/sh\necho OK\n');
        fs.chmodSync(hermit(proj, 'bin', 'hermitd-run'), 0o755);
        const result = await runBash(path.join(SCRIPTS_DIR, 'hermitd-docker.sh'), {
          args: ['restart', '--build'], cwd: proj,
          env: { HOME: freshDockerHome(), PATH: `${stub}:${process.env.PATH}`, DOCKER_STUB_CALLS: callsFile },
        });
        expect(result.exitCode).toBe(0);
        const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n');
        expect(calls.some(line => line.includes(' build '))).toBe(true);
        // Compose calls only; the stale-sidecar check is a plain `docker ps`.
        expect(calls.filter(line => !line.includes('ps -aq')).every(line => line.startsWith(enabled === false ? '0 0 ' : '1 1 '))).toBe(true);
      } finally { wd.cleanup(); }
    });
  }
});

test('Docker lifecycle renders config in the applied set before validation on up and both restart modes', async () => {
  const wd = setupWorkdir();
  const proj = wd.dir;
  try {
    fs.mkdirSync(hermit(proj, 'bin'), { recursive: true });
    write(path.join(proj, 'Dockerfile.hermit'), '# Generated by hermitd 0.0.1\nstale\n');
    write(path.join(proj, 'docker-compose.hermit.yml'), 'services: {}');
    const stub = path.join(proj, '.stub'); fs.mkdirSync(stub);
    write(path.join(stub, 'sleep'), '#!/bin/sh\nexit 0\n');
    write(path.join(stub, 'docker'), `#!/bin/sh
case "$*" in
  *"config -q"*)
    for arg in "$@"; do
      case "$arg" in
        */docker-compose.hermit.yml) grep -q "$EXPECTED_PACKAGE" "$(dirname "$arg")/Dockerfile.hermit" || exit 42; break ;;
      esac
    done ;;
  *"ps --status running"*) echo hermit ;;
  *"claude --version"*) echo 2.1.325 ;;
esac
`);
    for (const name of ['sleep', 'docker']) fs.chmodSync(path.join(stub, name), 0o755);
    for (const [index, args] of [['up'], ['restart'], ['restart', '--build']].entries()) {
      const pkg = ['curl', 'git', 'jq'][index];
      const home = freshDockerHome();
      write(hermit(proj, 'config.json'), JSON.stringify({ channels: {}, docker: { packages: [pkg] } }));
      const result = await runBash(path.join(SCRIPTS_DIR, 'hermitd-docker.sh'), {
        args, cwd: proj, env: { HOME: home, PATH: `${stub}:${process.env.PATH}`, EXPECTED_PACKAGE: pkg },
      });
      expect(result.exitCode).toBe(0);
      const set = appliedSet(proj, path.join(home, '.claude'))!;
      expect(fs.readFileSync(path.join(set, 'Dockerfile.hermit'), 'utf8')).toContain(`      ${pkg} &&`);
      expect(fs.readFileSync(path.join(proj, 'Dockerfile.hermit'), 'utf8')).toContain('stale');
    }
  } finally { wd.cleanup(); }
});

test('Docker lifecycle pins approved inputs through build and refuses pending changes without a terminal', async () => {
  const wd = setupWorkdir();
  const project = wd.dir;
  const home = freshDockerHome();
  const configRoot = path.join(home, '.claude');
  const stub = path.join(project, 'stub');
  const log = path.join(stub, 'calls.jsonl');
  const override = 'services: {hermit: {environment: [COLOR=approved]}}\n';
  try {
    fs.mkdirSync(hermit(project, 'bin'), { recursive: true });
    fs.mkdirSync(hermit(project, 'docker'), { recursive: true });
    fs.mkdirSync(stub);
    write(hermit(project, 'config.json'), JSON.stringify({ channels: {}, docker: { packages: [], security: { network: {
      enabled: true, dns_mode: 'enforce', subnet: '172.28.0.0/24', gateway: '172.28.0.1', netguard_ip: '172.28.0.2',
    } } }, browser: { enabled: false } }));
    write(path.join(project, 'docker-compose.hermit.yml'), 'services: {}\n');
    write(path.join(project, 'docker-compose.override.yml'), override);
    write(path.join(project, 'Dockerfile.hermit'), '# Generated by hermitd 0.0.1\nstale\n');
    write(path.join(project, '.env'), 'UID=4242\n');
    fs.writeFileSync(path.join(stub, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(stub, 'docker'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const files = args.flatMap((arg, i) => arg === '-f' ? [args[i + 1]] : []);
const command = args[args.lastIndexOf('-f') + 2];
const envFile = args[args.indexOf('--env-file') + 1];
const overlay = files.find(file => file.endsWith('docker-compose.override.yml'));
const contexts = files.find(file => file.endsWith(${JSON.stringify(contextsName)}));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, files, command, envFile,
  override: overlay && fs.readFileSync(overlay, 'utf8'),
  contexts: contexts && JSON.parse(fs.readFileSync(contexts, 'utf8')),
  browser: process.env.HERMIT_BROWSER,
}) + '\\n');
if (command === 'build' && process.env.SWAP === 'yes') {
  fs.writeFileSync('docker-compose.override.yml', 'services: {}\\n');
  fs.writeFileSync('.env', 'UID=99\\n');
}
const text = args.join(' ');
if (text.includes('ps --status running')) console.log('hermit');
else if (text.includes('config --services')) console.log('hermit\\nhermit-netguard');
else if (text.includes('claude --version')) console.log('2.1.325');
else if (text.includes('npm view')) console.log('2.1.325');
else if (text.includes('await-upgrade')) console.log('{"status":"ready"}');
`, { mode: 0o755 });
    const run = (args: string[], swap = false) => runBash(path.join(SCRIPTS_DIR, 'hermitd-docker.sh'), {
      args, cwd: project, env: { HOME: home, PATH: `${stub}:${process.env.PATH}`, SWAP: swap ? 'yes' : 'no' },
    });
    const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(await run(['up'])).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Recorded Docker approval baseline') });
    const set = appliedSet(project, configRoot)!;
    // Validate, cached netguard build, stale-sidecar checks (a plain `docker ps -aq` per absent sidecar), start.
    const start = ['config', 'config', 'build', 'config', '-aq', '-aq', 'up', 'ps'];
    expect(calls().map(row => row.command)).toEqual(start);
    expect(calls().find(row => row.command === 'build').args.slice(-2)).toEqual(['build', 'hermit-netguard']);
    write(log, '');
    expect((await run(['up'])).exitCode).toBe(0);
    expect(calls().map(row => row.command)).toEqual(start);
    write(log, '');
    expect(await run(['restart', '--build'], true)).toMatchObject({ exitCode: 0 });
    const rebuild = calls().filter(row => row.args[0] === 'compose');
    expect(rebuild.find(row => row.command === 'up')?.override).toBe(override);
    expect(rebuild.some(row => row.args.slice(-3).join(' ') === 'build --no-cache hermit-netguard')).toBe(true);
    for (const row of rebuild) {
      expect(row.envFile).toBe(path.join(set, '.env'));
      expect(row.files.every((file: string) => file.startsWith(set + path.sep))).toBe(true);
      expect(row.contexts.services.hermit.build.context).toBe(set);
      expect(row.contexts.services['hermit-netguard'].build.context).toBe(path.join(set, '.hermit/docker'));
      expect(row.browser).toBe('0');
    }
    expect(fs.readFileSync(path.join(set, '.env'), 'utf8')).toBe('UID=4242\n');
    for (const args of [['up'], ['restart', '--build'], ['update', '--yes', '--cc-only']]) {
      write(log, '');
      const declined = await run(args);
      expect(declined.exitCode).toBe(1);
      expect(declined.stdout).toContain('Run hermitd approve in a terminal');
      expect(declined.stderr).toContain('Nothing was applied');
      expect(calls().map(row => row.command).filter(command => ['build', 'down', 'up', 'run'].includes(command))).toEqual([]);
      expect(fs.existsSync(hermit(project, 'state', 'update-in-progress.json'))).toBe(false);
      if (args[0] === 'update') expect(declined.stderr).toContain('The upgrade inside the container already ran');
    }
  } finally { wd.cleanup(); }
}, 30000);

describe('Docker lifecycle renders the credential proxy from the host-only store', () => {
  const { storeDir, writeBindings } = require('../scripts/lib/credproxy');
  function project(config: object) {
    const wd = setupWorkdir();
    const proj = wd.dir;
    fs.mkdirSync(hermit(proj, 'bin'), { recursive: true });
    write(hermit(proj, 'config.json'), JSON.stringify({ channels: {}, ...config }));
    write(path.join(proj, 'docker-compose.hermit.yml'), 'services: {}');
    write(path.join(proj, 'Dockerfile.hermit'), 'FROM ubuntu:26.04\n');
    const stub = path.join(proj, '.stub'); fs.mkdirSync(stub);
    const calls = path.join(stub, 'calls');
    write(path.join(stub, 'sleep'), '#!/bin/sh\nexit 0\n');
    write(path.join(stub, 'docker'), `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$*" in\n  *"ps --status running"*) echo hermit ;;\n  *"claude --version"*) echo 2.1.325 ;;\nesac\n`);
    for (const name of ['sleep', 'docker']) fs.chmodSync(path.join(stub, name), 0o755);
    const configDir = path.join(proj, '..', path.basename(proj) + '-config');
    const run = (args: string[]) => runBash(path.join(SCRIPTS_DIR, 'hermitd-docker.sh'), {
      args, cwd: proj, env: { PATH: `${stub}:${process.env.PATH}`, HOME: configDir },
    });
    const store = () => storeDir(proj, path.join(configDir, '.claude'));
    const cleanup = () => { wd.cleanup(); fs.rmSync(configDir, { recursive: true, force: true }); };
    return { proj, run, store, cleanup, calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
  }

  for (const config of [{}, { docker: { security: { credential_proxy: { enabled: false } } } }]) {
    test(`renders when the store has a binding, config ${JSON.stringify(config)}`, async () => {
      const p = project(config);
      try {
        writeBindings(p.store(), p.proj, [{ host: 'api.example.com', header: 'X-Key', secret: 'k' }]);
        const r = await p.run(['restart']);
        expect(r.exitCode).toBe(0);
        expect(fs.existsSync(path.join(p.store(), 'sidecar/envoy.yaml'))).toBe(true);
        expect(r.stdout).toContain('Credential proxy: some mapped headers have no value yet');
      } finally { p.cleanup(); }
    });
  }

  test('does nothing without a binding while the proxy is off', async () => {
    const p = project({});
    try {
      const r = await p.run(['up']);
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(p.store())).toBe(false);
      expect(r.stdout + r.stderr).not.toContain('Credential proxy');
    } finally { p.cleanup(); }
  });

  test('an enabled proxy without a binding gets an empty config to start on', async () => {
    const p = project({ docker: { security: { credential_proxy: { enabled: true } } } });
    try {
      const r = await p.run(['up']);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(p.store(), 'sidecar/envoy.yaml'), 'utf8')).static_resources.listeners).toHaveLength(1);
      expect(fs.existsSync(path.join(p.store(), 'agent'))).toBe(true);
    } finally { p.cleanup(); }
  });

  function stubDocker(p: { proj: string }, cases: string) {
    const stub = path.join(p.proj, '.stub');
    write(path.join(stub, 'docker'), `#!/bin/sh\necho "$*" >> "${path.join(stub, 'calls')}"\ncase "$*" in\n  *"ps --status running"*) echo hermit ;;\n  *"claude --version"*) echo 2.1.325 ;;\n${cases}\nesac\n`);
    fs.chmodSync(path.join(stub, 'docker'), 0o755);
  }

  test('a failed cached netguard build stops plain restart before anything is stopped', async () => {
    const p = project({});
    try {
      stubDocker(p, '  *"config --services"*) printf "hermit\\nhermit-netguard\\n" ;;\n  *" build hermit-netguard"*) exit 1 ;;');
      const r = await p.run(['restart']);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('Netguard build failed: the running stack was left as it is.');
      expect(p.calls()).toContain('build hermit-netguard');
      expect(p.calls()).not.toContain(' down');
    } finally { p.cleanup(); }
  });

  test('a no-terminal stop is sent to chat once per candidate; an undelivered notice says so', async () => {
    const p = project({});
    try {
      fs.mkdirSync(hermit(p.proj, 'state'), { recursive: true });
      const plugins = JSON.stringify([{ id: 'hermitd@m', enabled: true, installPath: '/core', scope: 'user' }]);
      const reply = path.join(p.proj, '.stub', 'reply');
      write(reply, 'OK');
      stubDocker(p, `  *"plugin list --json"*) echo '${plugins}' ;;\n  *"bun /core/scripts/approval-notice.ts .hermit"*) cat "${reply}" ;;`);
      expect((await p.run(['up'])).exitCode).toBe(0);
      const started = JSON.parse(fs.readFileSync(hermit(p.proj, 'state', 'docker-approval.json'), 'utf8'));
      expect(started.status).toBe('approved');
      expect(started.deployed).toBe(started.approved);
      write(path.join(p.proj, 'docker-compose.override.yml'), 'services: {}\n');
      const first = await p.run(['restart']);
      expect(first.exitCode).toBe(1);
      expect(first.stderr).toContain("The agent's chat was told");
      const note = JSON.parse(fs.readFileSync(hermit(p.proj, 'state', 'docker-approval.json'), 'utf8'));
      expect(note).toMatchObject({ status: 'pending', notified: true });
      const second = await p.run(['restart']);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).not.toContain('chat');
      expect(p.calls().match(/approval-notice/g)).toHaveLength(1);
      expect(p.calls()).not.toContain(' down');

      write(path.join(p.proj, 'docker-compose.override.yml'), 'services: {a: {}}\n');
      write(reply, '{"error":"no_channel"}');
      const third = await p.run(['restart']);
      expect(third.stderr).toContain('The approval notice was not delivered to chat ({"error":"no_channel"})');
      expect(p.calls()).toContain('harness-request /hermitd:hermit-doctor');
      expect(JSON.parse(fs.readFileSync(hermit(p.proj, 'state', 'docker-approval.json'), 'utf8')).notified).toBe(false);
      // The send is retried on the next run; the doctor fallback is asked once per candidate.
      const fourth = await p.run(['restart']);
      expect(fourth.stderr).toContain('The approval notice was not delivered to chat');
      expect(p.calls().match(/approval-notice/g)).toHaveLength(3);
      expect(p.calls().match(/harness-request \/hermitd:hermit-doctor/g)).toHaveLength(1);
    } finally { p.cleanup(); }
  });

  test('a sidecar the configuration no longer has is removed by its labels between stop and start', async () => {
    const p = project({});
    try {
      stubDocker(p, '  *"config --services"*) echo hermit ;;\n  *"com.docker.compose.service=hermit-credproxy"*) echo abc123 ;;');
      const r = await p.run(['restart']);
      expect(r.exitCode).toBe(0);
      const lines = p.calls().split('\n');
      const removed = lines.findIndex(line => line === 'rm -f abc123');
      expect(removed).toBeGreaterThan(lines.findIndex(line => line.endsWith(' down')));
      expect(removed).toBeLessThan(lines.findIndex(line => line.endsWith(' up -d')));
      expect(lines.find(line => line.startsWith('ps -aq'))).toContain(`label=com.docker.compose.project.working_dir=${p.proj}`);
      expect(p.calls()).not.toContain('--remove-orphans');
    } finally { p.cleanup(); }
  });

  test('a failed render stops restart before anything is stopped', async () => {
    const p = project({});
    try {
      fs.mkdirSync(p.store(), { recursive: true });
      fs.writeFileSync(path.join(p.store(), 'map.json'), '{not json');
      const r = await p.run(['restart']);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('Credential proxy render failed');
      expect(r.stderr).toContain('credential change was not applied');
      expect(p.calls()).not.toContain('down');
      expect(p.calls()).not.toContain('up -d');
    } finally { p.cleanup(); }
  });
});
