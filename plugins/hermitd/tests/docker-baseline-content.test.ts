// Content-assertion tests for the Docker baseline templates.
// (bun test port of test-docker-baseline-content.sh)
//
// Guards against accidental removal or layer-splitting of the gh install
// added in v1.0.40 (PROP-028, GH #82). No Docker daemon required — pure
// file inspection.
//
// Usage: bun test tests/docker-baseline-content.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { memoryDirFor } from '../scripts/lib/cc-compat';
import { getSessionName } from '../scripts/lib/tmux';

const dockerfile = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'Dockerfile.hermit.template'), 'utf-8');
const compose = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'docker-compose.hermit.yml.template'), 'utf-8');
const entrypoint = fs.readFileSync(
  path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'docker-entrypoint.hermit.sh.template'), 'utf-8');

const dockerfileLines = dockerfile.split('\n');
const rmLine = dockerfileLines.findIndex((l) => l.includes('rm -rf /var/lib/apt/lists'));

// -------------------------------------------------------
// Dockerfile: gh apt source present
// -------------------------------------------------------
describe('Dockerfile: gh apt source', () => {
  test('Dockerfile: cli.github.com apt source present', () => {
    expect(dockerfile).toContain('cli.github.com/packages');
  });

  test('Dockerfile: githubcli-archive-keyring.gpg fetched', () => {
    expect(dockerfile).toContain('githubcli-archive-keyring.gpg');
  });

  test('Dockerfile: gh installed via apt-get', () => {
    expect(dockerfile).toMatch(/apt-get install.*--no-install-recommends gh/);
  });
});

// -------------------------------------------------------
// Dockerfile: gh install is in the same layer as the cleanup
// (regression guard: no accidental RUN split that produces a
// dangling apt-get update without a matching rm -rf)
// -------------------------------------------------------
describe('Dockerfile: layer integrity', () => {
  test('Dockerfile: exactly one rm -rf /var/lib/apt/lists/ in base section (no layer split)', () => {
    const count = dockerfileLines.filter((l) => l.includes('rm -rf /var/lib/apt/lists')).length;
    expect(count).toBe(1);
  });

  test('Dockerfile: gh line appears before rm -rf (same layer ordering)', () => {
    const ghLine = dockerfileLines.findIndex((l) => /apt-get install.*--no-install-recommends gh/.test(l));
    expect(ghLine).toBeGreaterThanOrEqual(0);
    expect(rmLine).toBeGreaterThanOrEqual(0);
    expect(ghLine).toBeLessThan(rmLine);
  });
});

// -------------------------------------------------------
// Compose: HERMIT_GH_TOKEN mapped to GH_TOKEN
// -------------------------------------------------------
describe('Compose: GH_TOKEN mapping', () => {
  test('Compose: GH_TOKEN env var present', () => {
    expect(compose).toContain('GH_TOKEN=');
  });

  test('Compose: GH_TOKEN uses HERMIT_GH_TOKEN source with empty-safe default', () => {
    expect(compose).toContain('GH_TOKEN=${HERMIT_GH_TOKEN:-}');
  });

  test('Compose: GH_TOKEN entry is in the environment block (indented with spaces)', () => {
    expect(compose).toMatch(/^ {6}- GH_TOKEN=/m);
  });
});

// -------------------------------------------------------
// Dockerfile: sandbox deps (bubblewrap + socat) present
// Added in v1.1.2 — required for Claude Code sandbox inside
// unprivileged containers.
// -------------------------------------------------------
describe('Dockerfile: sandbox deps', () => {
  test('Dockerfile: bubblewrap present in apt-get install', () => {
    expect(dockerfile).toContain('bubblewrap');
  });

  test('Dockerfile: socat present in apt-get install', () => {
    expect(dockerfile).toContain('socat');
  });

  test('Dockerfile: bubblewrap and socat in same RUN layer as cleanup', () => {
    const bwrapLine = dockerfileLines.findIndex((l) => l.includes('bubblewrap'));
    expect(bwrapLine).toBeGreaterThanOrEqual(0);
    expect(rmLine).toBeGreaterThanOrEqual(0);
    expect(bwrapLine).toBeLessThan(rmLine);
  });
});

// -------------------------------------------------------
// Python retired from the Docker layer (bun migration WP9).
// Bun is the hermit runtime; Node/npm stay solely for the
// Claude Code CLI and its self-update path.
// -------------------------------------------------------
describe('Dockerfile: Python retired, bun pinned', () => {
  test('Dockerfile: no python3 packages remain', () => {
    expect(dockerfile).not.toContain('python3');
  });

  test('Dockerfile: bun installed via native installer with BUN_VERSION pin', () => {
    expect(dockerfile).toContain('curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"');
  });

  test('Dockerfile: BUN_VERSION build arg pinned to a concrete version', () => {
    expect(dockerfile).toMatch(/^ARG BUN_VERSION=\d+\.\d+\.\d+$/m);
  });

  test('Dockerfile: .bun/bin on ENV PATH', () => {
    expect(dockerfile).toMatch(/^ENV PATH=\/home\/claude\/\.bun\/bin:\$PATH$/m);
  });

  test('Dockerfile: Node layer kept for the Claude Code CLI', () => {
    expect(dockerfile).toContain('deb.nodesource.com');
    expect(dockerfile).toContain('npm install -g @anthropic-ai/claude-code');
  });
});

describe('Entrypoint: setup-token auth gates', () => {
  // The entrypoint runs BEFORE hermitd-start exports CLAUDE_CODE_OAUTH_TOKEN, so
  // a gate keyed only on the env var would never see token mode and would sit
  // there waiting for credentials that are already present. The file on the
  // volume is the only boot-time signal.
  test('entrypoint: defines the token file path and gates on the FILE', () => {
    expect(entrypoint).toContain('SETUP_TOKEN_FILE="${CLAUDE_CONFIG_DIR}/.hermit-setup-token"');
    const gate = entrypoint.slice(entrypoint.indexOf('# --- 0. Wait for auth credentials'));
    const zeroGate = gate.slice(0, gate.indexOf('# --- 0c.'));
    expect(zeroGate).toContain('[ ! -f "$SETUP_TOKEN_FILE" ]');
  });

  test('entrypoint: the credential wait loop also breaks on a minted token', () => {
    expect(entrypoint).toContain('while [ ! -f "$CRED_FILE" ] && [ ! -f "$SETUP_TOKEN_FILE" ]; do');
  });

  // The credential wait may not exit: `restart: unless-stopped` respawns the
  // container straight back into the same wait, and `hermitd-docker login` execs
  // into a *running* container, so exiting destroys the recovery path the wait's
  // own banner points at. It stays up and reminds instead.
  test('entrypoint: the credential wait does not exit on a timeout', () => {
    const zeroGate = entrypoint.slice(
      entrypoint.indexOf('# --- 0. Wait for auth credentials'),
      entrypoint.indexOf('# --- 0c.'),
    );
    expect(zeroGate).not.toContain('exit 1');
    expect(zeroGate).toContain('Still waiting for credentials');
  });

  // §0b used to block boot whenever .credentials.json carried a past `expiresAt`.
  // That field is the ACCESS token's, which Claude Code refreshes silently roughly
  // every 8h, so the gate false-blocked healthy hermits (doctor-check declines to
  // warn on it for the same reason) while catching a genuinely lapsed login only by
  // accident. A lapsed login now boots 401-alive and the watchdog reports it from the
  // pane, which is also the only way the tmux path ever hears about it.
  test('entrypoint: no expiry gate blocks boot on a stale access token', () => {
    expect(entrypoint).not.toContain('EXPIRED=$(');
    expect(entrypoint).not.toContain('# --- 0b.');
    expect(entrypoint).not.toContain('Still waiting for fresh credentials');
  });

  // §0c parks a stale /login credential when a setup-token is present: interactive
  // sessions prefer .credentials.json over the env token, so an unparked stored
  // login 401s the hermit ~8h after its token lapses. Guards hermits converted
  // before install-time parking shipped.
  test('entrypoint: §0c parks a stale credential in token mode', () => {
    const guard = entrypoint.slice(entrypoint.indexOf('# --- 0c.'));
    const block = guard.slice(0, guard.indexOf('# --- 0d.'));
    expect(block).toContain('[ -f "$SETUP_TOKEN_FILE" ] && [ -f "$CRED_FILE" ]');
    expect(block).toContain('mv -f "$CRED_FILE" "${CRED_FILE}.pre-token.bak"');
  });

  // A login-mode hermit's live credential IS .credentials.json. Parking it on a
  // stray token file would take that hermit dark on its next boot, so §0c reads
  // the mode from config rather than inferring it from file presence alone.
  test('entrypoint: §0c reads auth_mode from config and never parks unconditionally', () => {
    const guard = entrypoint.slice(entrypoint.indexOf('# --- 0c.'));
    const block = guard.slice(0, guard.indexOf('# --- 0d.'));
    expect(block).toContain('auth_mode');
    expect(block).toContain('${AGENT_DIR}/config.json');
    expect(block).toContain('[ "$AUTH_MODE" = "token" ]');
    // Every `mv` in the block is behind the mode test — the mv must not appear in
    // any line that the gate does not dominate.
    const mvLine = block.indexOf('mv -f "$CRED_FILE"');
    expect(block.indexOf('[ "$AUTH_MODE" = "token" ]')).toBeLessThan(mvLine);
  });

  // Unset auth_mode has to keep behaving exactly as it did before this key existed,
  // or every already-running token hermit changes behavior on its next boot.
  test.each([
    [{ auth_mode: 'login' }, true, 'login'],
    [{ auth_mode: 'token' }, false, 'token'],
    [{}, true, 'token'],
    [{}, false, 'login'],
  ])('entrypoint: auth_mode resolution %j (token file: %s) → %s', (config, tokenFileExists, expected) => {
    const guard = entrypoint.slice(entrypoint.indexOf('# --- 0c.'));
    const block = guard.slice(0, guard.indexOf('# --- 0d.'));
    const script = block.slice(block.indexOf('const fs = require'), block.indexOf('" "${AGENT_DIR}'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-entrypoint-auth-'));
    try {
      const configPath = path.join(dir, 'config.json');
      const tokenPath = path.join(dir, '.hermit-setup-token');
      fs.writeFileSync(configPath, JSON.stringify(config));
      if (tokenFileExists) fs.writeFileSync(tokenPath, 'sk-ant-oat01-fixture\n');
      const r = spawnSync(process.execPath, ['-e', script, configPath, tokenPath], { encoding: 'utf8' });
      expect(r.stdout.trim()).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Entrypoint: placeholder-free session name resolution', () => {
  test('entrypoint: no {{...}} placeholders remain (safe to raw-copy)', () => {
    expect(entrypoint).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test('entrypoint: resolves SESSION_NAME from config.json at runtime', () => {
    expect(entrypoint).toContain('tmux_session_name');
    expect(entrypoint).toContain('hermit-{project_name}');
  });

  // Crux: the resolved name must equal what getSessionName() produces — that is what
  // hermitd-start uses to CREATE the session. Both sides must chdir into the same temp
  // dir because getSessionName() reads process.cwd() for {project_name}.
  test.serial('entrypoint: session-name resolution matches lib/tmux.getSessionName — default config', () => {
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-session-name-'));
    try {
      process.chdir(tmpDir);
      const config = {};
      const expected = getSessionName(config);
      const raw = String((config as any).tmux_session_name ?? 'hermit-{project_name}');
      const actual = raw.replaceAll('{project_name}', path.basename(process.cwd()));
      expect(actual).toBe(expected);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('entrypoint: session-name resolution matches lib/tmux.getSessionName — custom tmux_session_name', () => {
    // Custom name has no {project_name} token; no chdir or tmpDir needed.
    const config = { tmux_session_name: 'my-custom-session' };
    const actual = String(config.tmux_session_name ?? 'hermit-{project_name}');
    expect(actual).toBe(getSessionName(config));
  });

  // Execution-based parity: extract the REAL `bun -e` block from the template and run it.
  // The formula tests above only re-implement the logic in TS — they would not catch a wrong
  // process.argv[N] index in the shell snippet. This runs the actual code the container runs.
  test('entrypoint: embedded bun -e snippet resolves the same name the container will use', () => {
    // Anchored on the assignment, not on `bun -e` alone: more than one embedded
    // snippet reads config.json now, and an unanchored match grabs whichever comes
    // first in the file.
    const m = entrypoint.match(/SESSION_NAME=\$\(bun -e "\n([\s\S]*?)\n" "\$\{AGENT_DIR\}\/config\.json"/);
    expect(m).not.toBeNull();
    const snippet = m![1];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-snippet-'));
    try {
      const cfgPath = path.join(tmpDir, 'config.json');
      const projectDir = path.join(tmpDir, 'my-proj');

      // Default config: {project_name} expands to basename(projectDir).
      fs.writeFileSync(cfgPath, '{}');
      const out = spawnSync('bun', ['-e', snippet, cfgPath, projectDir], { encoding: 'utf8' });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('hermit-my-proj');

      // Custom name passes through untouched.
      fs.writeFileSync(cfgPath, JSON.stringify({ tmux_session_name: 'custom-x' }));
      const out2 = spawnSync('bun', ['-e', snippet, cfgPath, projectDir], { encoding: 'utf8' });
      expect(out2.stdout.trim()).toBe('custom-x');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// -------------------------------------------------------
// Dockerfile: base image (regression guard — prevent accidental downgrade)
// -------------------------------------------------------
describe('Dockerfile: base image', () => {
  test('Dockerfile: FROM ubuntu:26.04', () => {
    expect(dockerfile).toContain('FROM ubuntu:26.04');
  });
});

describe('Entrypoint: Python retired, PATH covers bun', () => {
  test('entrypoint: no python3 invocations remain', () => {
    expect(entrypoint).not.toContain('python3');
  });

  test('entrypoint: explicit PATH line includes both .npm-global/bin and .bun/bin', () => {
    const pathLine = entrypoint.split('\n').find((l) => l.startsWith('export PATH='));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain('/home/claude/.npm-global/bin');
    expect(pathLine).toContain('/home/claude/.bun/bin');
  });

  test('entrypoint: npm self-heal for the claude binary kept', () => {
    expect(entrypoint).toContain('npm install -g @anthropic-ai/claude-code');
  });
});

describe('Entrypoint: installs add their marketplace in one step', () => {
  test('entrypoint: every install names its marketplace source, no separate add step', () => {
    expect(entrypoint).not.toContain('plugin marketplace add');
    expect(entrypoint).not.toContain('"marketplace", "add"');
    expect(entrypoint).toContain('claude plugin install hermitd --marketplace gtapps/hermitd --scope project');
    expect(entrypoint).toContain('--marketplace anthropics/claude-plugins-official --scope local');
    expect(entrypoint).toContain('"--marketplace", marketplace');
  });

  test('entrypoint: no [ -d MARKETPLACE_DIR ] registration checks remain', () => {
    expect(entrypoint).not.toMatch(/\[ ! -d "\$\{MARKETPLACE_DIR\}/);
  });

  test('entrypoint: hermitd install decoupled from marketplace add', () => {
    expect(entrypoint).toContain("grep -qF 'hermitd@hermitd'");
  });

  test('entrypoint: enable failures distinguish benign "already enabled" from genuine', () => {
    // Shared shell helper suppresses only the benign case and warns otherwise.
    expect(entrypoint).toContain('enable_plugin()');
    expect(entrypoint).toContain('already enabled');
    // No enable site silently swallows failures via `|| true` anymore.
    expect(entrypoint).not.toMatch(/plugin enable[^\n]*\|\| true/);
  });
});

// -------------------------------------------------------
// Entrypoint §4: the auto-memory seed. It writes MEMORY.md into
// <config>/projects/<path key>/memory, where the path key is Claude Code's own
// (cc-compat transcriptPathKey): every non-alphanumeric character becomes '-'.
// A slash-only substitution seeded a directory CC never reads on any dotted
// project path. A content assertion on the substitution would not catch the
// next way of getting the key wrong, so this extracts the real block and runs
// it, comparing against transcriptPathKey rather than against its own text.
// The cases run under LC_ALL=C — the image sets no locale, so that is what the
// entrypoint actually gets, and a byte-wise match is the other way to mis-key
// an accented path.
// -------------------------------------------------------
describe('Entrypoint: §4 auto-memory seed', () => {
  const { freshDir, cleanup } = freshDirFactory('hermit-4-');
  afterAll(cleanup);

  const block = entrypoint.slice(entrypoint.indexOf('# --- 4. Seed auto-memory'), entrypoint.indexOf('# --- 4b.'));

  // PROJECT_DIR is only ever substituted into the key, never opened, so the
  // paths below do not have to exist on the test machine.
  function runSeed(projectDir: string) {
    const root = freshDir();
    const agentDir = path.join(root, '.hermit');
    const configDir = path.join(root, 'config');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'MEMORY-SEED.md'), 'seeded\n');

    const script = [
      'set -euo pipefail',
      `AGENT_DIR=${JSON.stringify(agentDir)}`,
      `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)}`,
      `PROJECT_DIR=${JSON.stringify(projectDir)}`,
      block,
    ].join('\n');
    const out = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 10_000,
    });
    return {
      status: out.status,
      seeded: path.join(memoryDirFor(projectDir, configDir), 'MEMORY.md'),
    };
  }

  test('entrypoint §4: dotted project path seeds the directory Claude Code reads', () => {
    const r = runSeed('/srv/hermits/my.project');
    expect(r.status).toBe(0);
    expect(fs.existsSync(r.seeded)).toBe(true);
  });

  test('entrypoint §4: non-ASCII project path seeds the directory Claude Code reads', () => {
    const r = runSeed('/srv/hermits/Projeção');
    expect(r.status).toBe(0);
    expect(fs.existsSync(r.seeded)).toBe(true);
  });
});

// -------------------------------------------------------
// Entrypoint §4b: the container-side split-brain boot guard.
// hermitd-start's own shouldRefuseBoot self-skips inside a container, so this
// block is the only guard against booting a container over a live host hermit.
// It shipped reading runtime.json from a doubled AGENT_DIR path, so jq always
// came back empty and the whole block was unreachable (GH #863). A content
// assertion on the path would not catch a later logic break, so this extracts
// the real block and runs it.
// -------------------------------------------------------
describe('Entrypoint: §4b boot conflict guard', () => {
  // Ends at 4c (the pre-launch sidecar hook), not 5: the hook reads PROJECT_DIR,
  // which this harness does not set, so including it would fail every case here
  // under `set -u` for a reason that has nothing to do with the guard.
  const block = entrypoint.slice(entrypoint.indexOf('# --- 4b.'), entrypoint.indexOf('# --- 4c.'));

  // `sleep` is overridden so the inert hold receives the same signal sent by
  // docker stop and exercises its trap without waiting for the real interval.
  const { freshDir, cleanup } = freshDirFactory('hermit-4b-');
  afterAll(cleanup);

  function runGuard(
    runtime: object,
    opts: { liveness?: 'fresh' | 'stale'; forceBoot?: string } = {},
  ) {
    const agentDir = path.join(freshDir(), '.hermit');
    const stateDir = path.join(agentDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify(runtime));
    if (opts.liveness) {
      const beat = path.join(stateDir, '.heartbeat');
      fs.writeFileSync(beat, '');
      // The guard's window is `find -mmin -10`; backdate 20min for the "stale
      // signal reads as unknown, so boot" branch.
      if (opts.liveness === 'stale') {
        const old = new Date(Date.now() - 20 * 60_000);
        fs.utimesSync(beat, old, old);
      }
    }

    // `set -euo pipefail` mirrors the real entrypoint header so the extracted
    // guard runs under the same shell options as it does in production.
    const script = `set -euo pipefail\nsleep() { kill -TERM $$; }\nAGENT_DIR=${JSON.stringify(agentDir)}\n${block}`;
    const out = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, HERMIT_FORCE_BOOT: opts.forceBoot ?? '0' },
      timeout: 10_000,
    });
    return {
      status: out.status,
      signal: out.signal,
      stdout: out.stdout,
      marker: fs.existsSync(path.join(stateDir, '.boot-conflict')),
    };
  }

  // The guard reads runtime.json through jq. Without it every `jq` call fails,
  // `_mode` comes back empty and the guard silently self-skips — which is the
  // exact shape of the bug under test, so assert the dependency explicitly
  // rather than let its absence read as a logic regression.
  test('entrypoint §4b: jq is available to run the guard', () => {
    expect(spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).status).toBe(0);
  });

  test('entrypoint §4b: inert hold traps signals around an interruptible sleep', () => {
    expect(block).toContain('sleep 300 & wait $!');
    expect(block.indexOf('trap ')).toBeLessThan(block.indexOf('sleep 300 & wait $!'));
  });

  test('entrypoint §4b: goes inert over a live non-docker owner', () => {
    const r = runGuard({ runtime_mode: 'tmux' }, { liveness: 'fresh' });
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stdout).toContain('BOOT CONFLICT');
    expect(r.marker).toBe(true);
  });

  test('entrypoint §4b: boots over a cleanly-stopped owner', () => {
    const r = runGuard({ runtime_mode: 'tmux', shutdown_completed_at: '2026-07-24T11:00:00Z' }, { liveness: 'fresh' });
    expect(r.status).toBe(0);
    expect(r.marker).toBe(false);
  });

  test('entrypoint §4b: boots when the recorded owner is docker', () => {
    const r = runGuard({ runtime_mode: 'docker' });
    expect(r.status).toBe(0);
    expect(r.marker).toBe(false);
  });

  // Stale-is-unknown is the guard's only protection against refusing every boot
  // after an unclean host exit (runtime.json frozen at active, owner long gone).
  test('entrypoint §4b: boots when the liveness signal is stale', () => {
    const r = runGuard({ runtime_mode: 'tmux' }, { liveness: 'stale' });
    expect(r.status).toBe(0);
    expect(r.marker).toBe(false);
  });

  test('entrypoint §4b: HERMIT_FORCE_BOOT=1 overrides a live owner', () => {
    const r = runGuard(
      { runtime_mode: 'tmux' },
      { liveness: 'fresh', forceBoot: '1' },
    );
    expect(r.status).toBe(0);
    expect(r.marker).toBe(false);
  });
});


// -------------------------------------------------------
// Entrypoint: operator sidecar hook points
// -------------------------------------------------------
describe('Entrypoint: operator sidecar', () => {
  const lines = entrypoint.split('\n');
  const sourceLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.includes('. "${PROJECT_DIR}/docker-entrypoint.hermit-local.sh"'));

  test('sourced at exactly two points', () => {
    expect(sourceLines.length).toBe(2);
  });

  test('each source is guarded by a file test', () => {
    for (const { l } of sourceLines) {
      expect(l).toContain('[ -f "${PROJECT_DIR}/docker-entrypoint.hermit-local.sh" ]');
    }
  });

  // $0 would resolve inside the image (Dockerfile COPYs the entrypoint to
  // /home/claude/), never the bind-mounted project dir where the sidecar lives.
  test('anchored on PROJECT_DIR, never $0', () => {
    expect(entrypoint).not.toContain('dirname "$0"');
  });

  test('pre-boot runs after channel dirs, before the plugin install', () => {
    const phase = lines.findIndex((l) => l.includes('export HERMIT_ENTRY_PHASE=pre-boot'));
    const install = lines.findIndex((l) => l.startsWith('# --- 3. Install plugins'));
    const channelDirs = lines.findIndex((l) => l.startsWith('# --- 2. Ensure channel state dirs'));
    expect(phase).toBeGreaterThan(channelDirs);
    expect(phase).toBeLessThan(install);
    expect(sourceLines[0].i).toBe(phase + 1);
  });

  test('pre-launch runs immediately before hermitd-start', () => {
    const phase = lines.findIndex((l) => l.includes('export HERMIT_ENTRY_PHASE=pre-launch'));
    const launch = lines.findIndex((l) => l.includes('"${AGENT_DIR}/bin/hermitd-start" "$@"'));
    expect(phase).toBeGreaterThan(-1);
    expect(phase).toBeLessThan(launch);
    expect(sourceLines[1].i).toBe(phase + 1);
  });

  const { freshDir, cleanup } = freshDirFactory('hermit-sidecar-');
  afterAll(cleanup);

  // Run the two extracted hook-point pairs under the entrypoint's own shell
  // options: a sidecar that aborts the boot is the documented contract, so the
  // absent-file case must still exit 0 under `set -euo pipefail`.
  function runHooks(sidecar: string | null): { status: number | null; phases: string } {
    const projectDir = freshDir();
    const log = path.join(projectDir, 'phases.txt');
    if (sidecar !== null) {
      fs.writeFileSync(path.join(projectDir, 'docker-entrypoint.hermit-local.sh'), sidecar);
    }
    const hooks = sourceLines
      .map(({ i }) => `${lines[i - 1]}\n${lines[i]}`)
      .join('\n');
    const script = `set -euo pipefail\nPROJECT_DIR=${JSON.stringify(projectDir)}\nSIDECAR_LOG=${JSON.stringify(log)}\n${hooks}`;
    const out = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10_000 });
    return {
      status: out.status,
      phases: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    };
  }

  test('a present sidecar runs once per phase, in order', () => {
    const r = runHooks('echo "$HERMIT_ENTRY_PHASE" >> "$SIDECAR_LOG"\n');
    expect(r.status).toBe(0);
    expect(r.phases).toBe('pre-boot\npre-launch\n');
  });

  test('an absent sidecar is not an error', () => {
    const r = runHooks(null);
    expect(r.status).toBe(0);
    expect(r.phases).toBe('');
  });
});

// -------------------------------------------------------
// Entrypoint: project .mcp.json native approval (phase 1)
// -------------------------------------------------------
describe('Entrypoint: .mcp.json native approval', () => {
  const { freshDir, cleanup } = freshDirFactory('hermit-mcpjson-');
  afterAll(cleanup);

  // The phase-1 block runs as `bun - <claude.json> <version> <project>`; extract
  // it from the heredoc and drive it directly rather than booting a container.
  const initBlock = entrypoint.split("<<'JSEOF'")[1].split('\nJSEOF')[0];

  function runInit(
    mcpJson: Record<string, unknown> | string | null,
    seedProject?: Record<string, unknown>,
  ): any {
    const projectDir = freshDir();
    const claudeJson = path.join(projectDir, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify(
      seedProject ? { projects: { [projectDir]: seedProject } } : {}));
    fs.mkdirSync(path.join(projectDir, '.hermit'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.hermit', 'config.json'), JSON.stringify({ channels: {} }));
    if (mcpJson !== null) {
      fs.writeFileSync(
        path.join(projectDir, '.mcp.json'),
        typeof mcpJson === 'string' ? mcpJson : JSON.stringify(mcpJson));
    }
    const script = path.join(projectDir, 'init.js');
    fs.writeFileSync(script, initBlock);
    const out = spawnSync('bun', [script, claudeJson, '9.9.9', projectDir], {
      encoding: 'utf8', timeout: 15_000,
    });
    return {
      status: out.status,
      stderr: out.stderr,
      project: JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects?.[projectDir],
    };
  }

  test('declared servers are left to native approval and the workspace is trusted', () => {
    const r = runInit({ mcpServers: { dropartifact: { command: 'x' }, other: { command: 'y' } } });
    expect(r.status).toBe(0);
    expect(r.project.enabledMcpjsonServers).toEqual([]);
    expect(r.project.hasTrustDialogAccepted).toBe(true);
    expect(r.stderr).toContain('Project MCP servers left to native approval in .claude/settings.json: dropartifact, other');
  });

  test('no .mcp.json leaves the project entry untouched', () => {
    const r = runInit(null);
    expect(r.status).toBe(0);
    expect(r.project).toBeUndefined();
  });

  // The config volume outlives the container, so a restart must not undo a
  // disable the operator made via /mcp.
  test('a server the operator disabled stays disabled across a restart', () => {
    const r = runInit(
      { mcpServers: { noisy: { command: 'x' }, wanted: { command: 'y' } } },
      { disabledMcpjsonServers: ['noisy'] });
    expect(r.status).toBe(0);
    expect(r.project.disabledMcpjsonServers).toEqual(['noisy']);
    expect(r.project.enabledMcpjsonServers).toEqual([]);
  });

  test('a channel plugin id is re-approved even when disabled', () => {
    const projectDir = freshDir();
    const claudeJson = path.join(projectDir, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({
      projects: { [projectDir]: { disabledMcpjsonServers: ['plugin:discord:discord'] } },
    }));
    fs.mkdirSync(path.join(projectDir, '.hermit'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.hermit', 'config.json'),
      JSON.stringify({ channels: { discord: { enabled: true } } }));
    const script = path.join(projectDir, 'init.js');
    fs.writeFileSync(script, initBlock);
    const out = spawnSync('bun', [script, claudeJson, '9.9.9', projectDir], {
      encoding: 'utf8', timeout: 15_000,
    });
    expect(out.status).toBe(0);
    const proj = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[projectDir];
    expect(proj.disabledMcpjsonServers).toEqual([]);
    expect(proj.enabledMcpjsonServers).toEqual(['plugin:discord:discord']);
  });

  // A hand-edited .mcp.json must not wedge the boot before the credential wait.
  test('an unparsable .mcp.json warns instead of aborting', () => {
    const r = runInit('{ not json');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('failed to parse .mcp.json');
  });
});
