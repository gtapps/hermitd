import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, SCRIPTS_DIR, runBash } from './helpers/run';
import { setupWorkdir, hermit, write, readJson } from './helpers/workdir';
import { doctorPassStub, listDuplicateScopes, runInterruptedBash } from './helpers/plugin-update';

describe('static file checks', () => {
  test('hermitd-update refreshes marketplaces (core first), then moves the pin', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'update-sequence.ts'), 'utf8');
    const marketplaceIdx = src.indexOf("'plugin', 'marketplace', 'update'");
    const updateLoopIdx = src.indexOf("'plugin', 'update', id, '--scope', scope");
    expect(marketplaceIdx).toBeGreaterThan(-1);
    expect(updateLoopIdx).toBeGreaterThan(-1);
    expect(marketplaceIdx).toBeLessThan(updateLoopIdx);
  });
});

describe('hermitd-update with Docker scaffolding and no running stack', () => {
  // PATH holds only an optional `docker` stub, so `command -v docker` sees exactly that.
  async function run(dockerStub: string | null) {
    const wd = setupWorkdir();
    const proj = wd.dir;
    try {
      fs.mkdirSync(hermit(proj, 'bin'), { recursive: true });
      write(hermit(proj, 'config.json'), '{}');
      write(path.join(proj, 'docker-compose.hermit.yml'), 'services:\n  hermit:\n    image: test\n');
      write(path.join(proj, 'Dockerfile.hermit'), 'FROM ubuntu:26.04\n');
      const bin = path.join(proj, '.path');
      fs.mkdirSync(bin);
      if (dockerStub) {
        write(path.join(bin, 'docker'), dockerStub);
        fs.chmodSync(path.join(bin, 'docker'), 0o755);
      }
      const proc = Bun.spawn({
        cmd: [Bun.which('bash')!, path.join(SCRIPTS_DIR, 'hermitd-update.sh'), '--yes'],
        cwd: proj,
        env: { HOME: proj, PATH: bin },
        stdin: Buffer.from(''), stdout: 'pipe', stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { stderr, exitCode };
    } finally { wd.cleanup(); }
  }

  // Inside the container the image ships no docker CLI.
  test('without a docker CLI it points at the Docker host', async () => {
    const r = await run(null);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('host terminal where Docker runs');
    expect(r.stderr).not.toContain('container is stopped');
  });

  test('with docker but no running stack it says the container is stopped', async () => {
    const r = await run('#!/bin/sh\nexit 0\n');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('container is stopped');
    expect(r.stderr).not.toContain('host terminal where Docker runs');
  });
});

describe('hermitd-update host path', () => {
  // Build a workdir with the wrapper installed at .hermit/bin, a config
  // (no docker compose → host path), and stub `claude`/`tmux` on a prepended PATH.
  function fixture(opts: { listJson: (proj: string) => string }) {
    const wd = setupWorkdir();
    const proj = wd.dir;
    const binDir = hermit(proj, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'bin', 'hermitd-update'),
      path.join(binDir, 'hermitd-update'),
    );
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin', 'hermitd-run'), hermit(proj, 'bin', 'hermitd-run'));
    fs.chmodSync(hermit(proj, 'bin', 'hermitd-run'), 0o755);
    write(hermit(proj, 'config.json'),
      JSON.stringify({ tmux_session_name: 'hermit-{project_name}', _hermit_versions: { 'hermitd': '1.2.0' } }));

    const stub = path.join(proj, '.stub');
    fs.mkdirSync(stub, { recursive: true });
    const listFile = path.join(stub, 'list.json');
    const recFile = path.join(stub, 'rec.txt');
    const mpRecFile = path.join(stub, 'mp-rec.txt');
    write(listFile, opts.listJson(proj));
    write(path.join(stub, 'claude'),
      `#!/usr/bin/env bash\n` +
      `if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then cat "${listFile}"; exit 0; fi\n` +
      `if [ "$1" = "plugin" ] && [ "$2" = "update" ]; then echo "$@" >> "${recFile}"; exit 0; fi\n` +
      `if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "update" ]; then echo "$4" >> "${mpRecFile}"; exit 0; fi\n` +
      `exit 0\n`);
    write(path.join(stub, 'tmux'),
      `#!/usr/bin/env bash\n[ "$1" = "has-session" ] && exit 1\nexit 0\n`);
    fs.chmodSync(path.join(stub, 'claude'), 0o755);
    fs.chmodSync(path.join(stub, 'tmux'), 0o755);

    return { wd, proj, recFile, mpRecFile, env: { HERMIT_PLUGIN_ROOT: PLUGIN_ROOT, HOME: proj, CLAUDE_CONFIG_DIR: path.join(proj, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(proj, 'plugins'), PATH: `${stub}:${process.env.PATH}` } };
  }

  for (const scenario of ['doctor-fails', 'doctor-no-report', 'verdict-fail', 'interrupted', 'ready', 'request-pending', 'timeout-evolve', 'stop-fails', 'old-watchdog', 'self-run', 'suffix-gap', 'suffix-current', 'below-floor']) {
    test(`live host update: ${scenario}`, async () => {
      const f = fixture({ listJson: proj => {
        const list = JSON.parse(listDuplicateScopes(proj, scenario.startsWith('suffix-') ? '-467be32f41fc' : ''));
        if (scenario === 'below-floor') for (const p of list) p.installPath = path.join(proj, 'cache', p.id.split('@')[0]);
        return JSON.stringify(list);
      } });
      try {
        const log = path.join(f.proj, 'live-calls');
        const bin = hermit(f.proj, 'bin');
        write(path.join(f.proj, '.stub/tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LIVE_CALLS"
if [ "$1" = capture-pane ]; then printf '❯ ────────\\n'; fi
if [ "$1" = display-message ]; then printf 'hermit-test\\n'; fi
exit 0
`);
        write(path.join(bin, 'hermitd-watchdog'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LIVE_CALLS"
[ "$LIVE_SCENARIO" != old-watchdog ] || { echo unsupported; exit 1; }
count=0
[ ! -f "$LIVE_CALLS.count" ] || read -r count < "$LIVE_CALLS.count"
count=$((count + 1)); echo "$count" > "$LIVE_CALLS.count"
if [ "$LIVE_SCENARIO" = interrupted ] && [ "$count" = 1 ]; then
  : > "$LIVE_CALLS.ready"
  exec sleep 30
fi
if [ "$LIVE_SCENARIO" = timeout-evolve ]; then
  echo '{"status":"timeout","reason":"evolve_pending"}'
else
  echo '{"status":"ready"}'
fi
`);
        for (const name of ['stop', 'start']) {
          write(path.join(bin, `hermitd-${name}`), `#!/usr/bin/env bash\n echo "${name} $*" >> "$LIVE_CALLS"\n[ "${name}:$LIVE_SCENARIO" != stop:stop-fails ]\n`);
          fs.chmodSync(path.join(bin, `hermitd-${name}`), 0o755);
        }
        fs.chmodSync(path.join(bin, 'hermitd-watchdog'), 0o755);
        // The core mod's queue: record the request and answer as the verb would.
        fs.renameSync(path.join(bin, 'hermitd-run'), path.join(bin, 'hermitd-run.real'));
        write(path.join(bin, 'hermitd-run'), `#!/usr/bin/env bash
${doctorPassStub}if [ "$1" = harness-request ]; then
  printf '%s\\n' "$*" >> "$LIVE_CALLS"
  if [ "$LIVE_SCENARIO" = request-pending ]; then echo '{"status":"unknown","reason":"wait_timeout"}'; exit 0; fi
  case " $* " in *" --wait "*) echo '{"status":"ok"}' ;; *) echo '{"status":"queued","id":"q1"}' ;; esac
  exit 0
fi
if [ "$1" = request-restart ]; then
  printf '%s\\n' "$*" >> "$LIVE_CALLS"
  echo '{"status":"requested","when":"quiet"}'
  exit 0
fi
exec "$(dirname "$0")/hermitd-run.real" "$@"
`);
        fs.chmodSync(path.join(bin, 'hermitd-run'), 0o755);
        // A local override wins over the project pin; both still get updated.
        write(hermit(f.proj, 'config.json'), JSON.stringify({ channels: {}, docker: { packages: ['poppler-utils'] }, tmux_session_name: 'hermit-test', _hermit_versions: { hermitd: scenario === 'suffix-current' ? '1.2.0' : '0.0.1' } }));
        if (scenario === 'below-floor') {
          fs.mkdirSync(path.join(f.proj, 'cache/hermitd/.claude-plugin'), { recursive: true });
          write(path.join(f.proj, 'cache/hermitd/.claude-plugin/plugin.json'), JSON.stringify({ engines: { 'claude-code': '>=2.1.308' } }));
          const claudeStub = path.join(f.proj, '.stub/claude');
          write(claudeStub, fs.readFileSync(claudeStub, 'utf8').replace('exit 0\n', '') + 'if [ "$1" = "--version" ]; then echo "2.1.301 (Claude Code)"; fi\nexit 0\n');
        }
        const runUpdate = scenario === 'interrupted'
          ? (script: string, opts: NonNullable<Parameters<typeof runBash>[1]>) => runInterruptedBash(script, opts, `${log}.ready`)
          : runBash;
        const r = await runUpdate(hermit(f.proj, 'bin', 'hermitd-update'), {
          args: ['--yes'], cwd: f.proj,
          env: { ...f.env, LIVE_CALLS: log, LIVE_SCENARIO: scenario, TMUX: scenario === 'self-run' ? '/tmp/tmux-test,1,0' : '' },
        });
        if (scenario === 'interrupted') {
          expect(r.exitCode).toBe(130);
          expect(r.stderr).toContain('Update interrupted before the restart; rerun `hermitd update` to finish.');
          expect(fs.existsSync(hermit(f.proj, 'state', 'update-in-progress.json'))).toBe(false);
          expect(fs.readFileSync(log, 'utf8')).not.toMatch(/^stop(?: |$)/m);
          return;
        }
        expect(r.exitCode).toBe(0);
        const history = readJson(hermit(f.proj, 'state/update-history.jsonl'));
        expect(history.doctor).toEqual(scenario === 'self-run' ? { status: 'skipped', reason: 'self_run' }
          : scenario.startsWith('doctor-') ? { status: 'error' } : { status: 'ran', issues: [{ id: 'watchdog', status: 'warn' }] });
        expect(r.stdout.includes('fixture doctor pass')).toBe(scenario !== 'self-run');
        expect(r.stdout.includes('fixture doctor pass --fix')).toBe(scenario !== 'self-run' && scenario !== 'below-floor');
        expect(r.stderr.includes('doctor check could not run; run `hermitd doctor`')).toBe(scenario.startsWith('doctor-'));
        if (scenario === 'below-floor') {
          // Evolve would stop on the old Claude Code: nothing is queued, waited on or restarted.
          const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
          expect(r.stderr).toContain("below hermitd's minimum 2.1.308");
          expect(r.stdout).toContain('Update blocked');
          expect(calls).not.toContain('harness-request');
          expect(calls).not.toMatch(/^(stop|start)/m);
          return;
        }
        const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
        if (scenario === 'self-run') {
          // The resident's own turn keeps the immediate path: reload and evolve queue, nothing waits or restarts.
          expect(r.stdout).not.toContain('Waiting for a quiet boundary');
          expect(r.stdout).not.toContain('Waiting for hermit-evolve');
          expect(calls.some(l => l.includes('await-upgrade'))).toBe(false);
          expect(calls).toContain('harness-request /reload-plugins --then /hermitd:hermit-evolve unattended --expect-version 1.2.0 --source update --purpose upgrade');
          expect(calls).toContain('request-restart .hermit --when-quiet --expect hermitd=1.2.0');
          expect(calls.some(l => l.startsWith('send-keys'))).toBe(false);
          expect(calls.some(l => l.startsWith('stop') || l.startsWith('start'))).toBe(false);
          expect(fs.existsSync(hermit(f.proj, 'state/update-in-progress.json'))).toBe(false);
          return;
        }
        if (scenario === 'request-pending') expect(r.stderr).not.toContain('did not complete');
        if (scenario === 'ready') {
          expect(r.stderr).not.toContain('Update interrupted');
          expect(r.stdout).not.toContain('Waiting for a quiet boundary');
          expect(r.stdout).toContain('Waiting for hermit-evolve');
        }
        const stopped = calls.findIndex(line => line.trim() === 'stop');
        const started = calls.indexOf('start --resume');
        if (scenario.startsWith('timeout-')) {
          expect(stopped).toBe(-1);
          expect(started).toBe(-1);
          expect(r.stderr).toContain('rerun `hermitd update`');
        } else {
          expect(stopped).toBeGreaterThan(-1);
          if (scenario === 'stop-fails') expect(started).toBe(-1);
          else expect(started).toBeGreaterThan(stopped);
        }
        expect(calls[0]).toContain('has-session');
        // The only wait is for evolve (or, with no version gap, an evolve turn still running),
        // after the reload is queued and before the stop.
        expect(calls.filter(l => l.startsWith('await-upgrade'))).toEqual([scenario === 'suffix-current' ? 'await-upgrade' : 'await-upgrade --expect hermitd=1.2.0']);
        expect(calls.findIndex(l => l.startsWith('harness-request'))).toBeLessThan(calls.findIndex(l => l.startsWith('await-upgrade')));
        if (stopped > -1) expect(calls.findIndex(l => l.startsWith('await-upgrade'))).toBeLessThan(stopped);
        if (scenario === 'suffix-current') expect(r.stdout).not.toContain('Waiting for hermit-evolve');
        expect(calls.some(l => l.startsWith('send-keys') || l.startsWith('capture-pane'))).toBe(false);
        expect(calls.find(l => l.startsWith('harness-request'))).toBe(scenario === 'suffix-current'
          ? 'harness-request /reload-plugins --expect-version 1.2.0 --source update --wait 300 --purpose upgrade'
          : 'harness-request /reload-plugins --then /hermitd:hermit-evolve unattended --expect-version 1.2.0 --source update --wait 300 --purpose upgrade');
        if (scenario === 'suffix-current') expect(calls.some(l => l.includes('--expect '))).toBe(false);
        expect(fs.existsSync(hermit(f.proj, 'state/update-in-progress.json'))).toBe(false);
      } finally { f.wd.cleanup(); }
    }, 30000);
  }

  test('duplicate ids keep per-scope versions and failure status in history and summary', async () => {
    const f = fixture({ listJson: listDuplicateScopes });
    try {
      const rows = JSON.parse(listDuplicateScopes(f.proj));
      rows[2].errors = ['no-matching-tag'];
      write(path.join(f.proj, '.stub', 'list.json'), JSON.stringify(rows));
      write(path.join(f.proj, '.stub', 'claude'), `#!/usr/bin/env bash
if [ "$1 $2" = "plugin list" ]; then cat "$HOST_STUB_LIST"; exit 0; fi
if [ "$1 $2" = "plugin update" ]; then
  printf '%s\\n' "$*" >> "$HOST_STUB_CALLS"
  [ "$3 $5" = "hermitd@hermitd local" ] && exit 1
fi
exit 0
`);
      const r = await runBash(hermit(f.proj, 'bin', 'hermitd-update'), {
        args: ['--yes'], cwd: f.proj,
        env: { ...f.env, HOST_STUB_LIST: path.join(f.proj, '.stub', 'list.json'), HOST_STUB_CALLS: f.recFile },
      });
      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(f.recFile, 'utf8').trim().split('\n')).toHaveLength(3);
      const entry = readJson(hermit(f.proj, 'state', 'update-history.jsonl'));
      expect(entry.plugins).toEqual([
        { id: 'hermitd@hermitd', scope: 'local', before: '1.2.0', after: '1.2.0', status: 'failed' },
        { id: 'hermitd@hermitd', scope: 'project', before: '1.2.14', after: '1.2.14', status: 'blocked', error: 'no-matching-tag' },
        { id: 'hermitd-scribe@hermitd', scope: 'project', before: '0.0.5', after: '0.0.5', status: 'unchanged' },
      ]);
      expect(r.stdout).toContain('hermitd@hermitd (scope local): v1.2.0 -> v1.2.0 (FAILED');
      expect(r.stdout).toContain('hermitd@hermitd (scope project): v1.2.14 -> v1.2.14 (blocked');
    } finally { f.wd.cleanup(); }
  });

  const listThreeScopes = (proj: string) => JSON.stringify([
    { id: 'hermitd@hermitd', scope: 'local', enabled: true, version: '1.2.0', projectPath: proj },
    { id: 'some-user@official', scope: 'user', enabled: true, version: '0.5.0', projectPath: '/elsewhere' },
    { id: 'cross@mp', scope: 'local', enabled: true, version: '9.9.9', projectPath: '/other/project' },
  ]);

  test('stale host core bootstraps once through claude', async () => {
    const f = fixture({ listJson: listThreeScopes });
    try {
      const core = path.join(f.proj, 'plugins/marketplaces/test-mp/plugins/hermitd');
      fs.mkdirSync(path.join(core, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(core, 'scripts'), { recursive: true });
      write(path.join(core, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'hermitd' }));
      fs.copyFileSync(path.join(PLUGIN_ROOT, 'scripts/hermitd-exec.sh'), path.join(core, 'scripts/hermitd-exec.sh'));
      const claude = path.join(f.proj, '.stub/claude');
      write(claude, `#!/usr/bin/env bash
if [ "$1 $2" = "plugin list" ]; then
  printf '[{"id":"hermitd@test-mp","scope":"local","enabled":true,"projectPath":"%s","installPath":"%s"}]\\n' "$PWD" "$HERMIT_PLUGIN_ROOT"
  exit 0
fi
printf '%s\\n' "$*" >> "$BOOTSTRAP_LOG"
printf 'printf "bootstrapped\\n"\\n' > "$HERMIT_PLUGIN_ROOT/scripts/hermitd-update.sh"
`);
      const r = await runBash(hermit(f.proj, 'bin', 'hermitd-update'), {
        cwd: f.proj, env: { ...f.env, HERMIT_PLUGIN_ROOT: core, BOOTSTRAP_LOG: f.recFile },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('bootstrapped');
      expect(fs.readFileSync(f.recFile, 'utf8').trim()).toBe('plugin update hermitd@test-mp --scope local');
    } finally { f.wd.cleanup(); }
  });

  test('updates project plugin with full id + scope; skips user + cross-project', async () => {
    const f = fixture({ listJson: listThreeScopes });
    try {
      const r = await runBash(hermit(f.proj, 'bin', 'hermitd-update'), { args: ['--yes'], cwd: f.proj, env: f.env });
      const rec = fs.existsSync(f.recFile) ? fs.readFileSync(f.recFile, 'utf8') : '';
      // durable update of the project-local plugin, full id + explicit scope
      expect(rec).toContain('plugin update hermitd@hermitd --scope local');
      // user-scope and cross-project entries are NOT updated
      expect(rec).not.toContain('some-user@official');
      expect(rec).not.toContain('cross@mp');
      // user-scope surfaced as a skip hint; no live tmux session message
      expect(r.stdout).toContain('some-user@official');
      expect(r.stdout).toContain('No live tmux session');
      // history entry shape
      const hist = fs.readFileSync(hermit(f.proj, 'state', 'update-history.jsonl'), 'utf8').trim();
      const entry = JSON.parse(hist);
      expect(entry.trigger).toBe('hermitd-update');
      expect(entry.mode).toBe('host-plugins');
      expect(Array.isArray(entry.plugins)).toBe(true);
      expect(entry.plugins[0].id).toBe('hermitd@hermitd');
      // marketplace refreshed before the pin move (the bug this fixes: `plugin update`
      // only moves the pin against whatever is already in the local cache)
      const mpRec = fs.existsSync(f.mpRecFile) ? fs.readFileSync(f.mpRecFile, 'utf8') : '';
      expect(mpRec).toContain('hermitd');
    } finally { f.wd.cleanup(); }
  });

  test('--dry-run records no update calls', async () => {
    const f = fixture({ listJson: listThreeScopes });
    try {
      await runBash(hermit(f.proj, 'bin', 'hermitd-update'), { args: ['--dry-run'], cwd: f.proj, env: f.env });
      expect(fs.existsSync(f.recFile)).toBe(false);
    } finally { f.wd.cleanup(); }
  });

  // Regression: siblings (dev-hermit, hermit-scribe, ...) previously never moved past
  // core because the source list here is intentionally NOT core-first — the wrapper
  // must reorder it itself.
  const listMultiSibling = (proj: string) => JSON.stringify([
    { id: 'hermitd-scribe@hermitd', scope: 'project', enabled: true, version: '0.0.5', projectPath: proj },
    { id: 'hermitd-dev@hermitd', scope: 'project', enabled: true, version: '0.4.6', projectPath: proj },
    { id: 'hermitd@hermitd', scope: 'project', enabled: true, version: '1.2.14', projectPath: proj },
  ]);

  test('multi-sibling: every hermit updates, core first, all recorded in history', async () => {
    const f = fixture({ listJson: listMultiSibling });
    try {
      await runBash(hermit(f.proj, 'bin', 'hermitd-update'), { args: ['--yes'], cwd: f.proj, env: f.env });
      const rec = fs.existsSync(f.recFile) ? fs.readFileSync(f.recFile, 'utf8').trim().split('\n') : [];
      // every sibling gets a durable pin move with its own id and scope
      expect(rec.some(l => l === 'plugin update hermitd@hermitd --scope project')).toBe(true);
      expect(rec.some(l => l === 'plugin update hermitd-dev@hermitd --scope project')).toBe(true);
      expect(rec.some(l => l === 'plugin update hermitd-scribe@hermitd --scope project')).toBe(true);
      // core is updated before either sibling, regardless of source list order
      const coreIdx = rec.findIndex(l => l.includes('hermitd@hermitd'));
      const devIdx = rec.findIndex(l => l.includes('hermitd-dev@hermitd'));
      const scribeIdx = rec.findIndex(l => l.includes('hermitd-scribe@hermitd'));
      expect(coreIdx).toBeGreaterThanOrEqual(0);
      expect(coreIdx).toBeLessThan(devIdx);
      expect(coreIdx).toBeLessThan(scribeIdx);
      // history entry records all three, not just core
      const hist = fs.readFileSync(hermit(f.proj, 'state', 'update-history.jsonl'), 'utf8').trim();
      const entry = JSON.parse(hist);
      expect(entry.plugins.map((p: any) => p.id).sort()).toEqual([
        'hermitd-dev@hermitd',
        'hermitd-scribe@hermitd',
        'hermitd@hermitd',
      ]);
    } finally { f.wd.cleanup(); }
  });
});
