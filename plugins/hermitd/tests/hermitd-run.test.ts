// Resolver coverage for the boot dispatcher pair: state-templates/bin/hermitd-run
// (finds core's plugin root) and scripts/hermitd-exec.sh (maps a logical name to a
// script, rejecting traversal). Spawning bash is intentional — these run at boot,
// before any TypeScript is loaded, and the process boundary is what we assert on.

import { afterAll, test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, RunResult } from './helpers/run';

const HERMIT_RUN = path.join(PLUGIN_ROOT, 'state-templates', 'bin', 'hermitd-run');
const HERMIT_EXEC = path.join(PLUGIN_ROOT, 'scripts', 'hermitd-exec.sh');

async function bash(script: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: ['bash', script, ...args],
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// A fake core plugin root: manifest with the given name + a stub hermitd-exec.sh
// that prints which root hermitd-run resolved (so the test can assert on selection).
function mkCoreRoot(dir: string, name = 'hermitd'): string {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '9.9.9' }));
  fs.writeFileSync(
    path.join(dir, 'scripts', 'hermitd-exec.sh'),
    '#!/usr/bin/env bash\necho "RESOLVED:$(cd "$(dirname "$0")/.." && pwd)"\n',
  );
  return dir;
}

// A hatched project whose bin/hermitd-run is the real hardened script under test.
function mkProject(root: string, withConfig = true): string {
  const bin = path.join(root, '.hermit', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(HERMIT_RUN, path.join(bin, 'hermitd-run'));
  if (withConfig) fs.writeFileSync(path.join(root, '.hermit', 'config.json'), '{}');
  return path.join(bin, 'hermitd-run');
}

const tmpdirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpdirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpdirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe('hermitd-run resolver', () => {
  test('missing config.json → exit 1, points at hatch', async () => {
    const proj = tmp('hr-noconf-');
    const runPath = mkProject(proj, false);
    const r = await bash(runPath, ['whatever'], { CLAUDE_CONFIG_DIR: tmp('hr-empty-') });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No config found');
  });

  test('scan resolves a single marketplace core install', async () => {
    const proj = tmp('hr-single-');
    const runPath = mkProject(proj);
    const cfg = tmp('hr-cfg-');
    const core = mkCoreRoot(path.join(cfg, 'plugins', 'marketplaces', 'mp1', 'plugins', 'hermitd'));
    const r = await bash(runPath, ['probe'], { CLAUDE_CONFIG_DIR: cfg });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`RESOLVED:${fs.realpathSync(core)}`);
  });

  test('two marketplaces shipping core → ambiguity exit 1', async () => {
    const proj = tmp('hr-ambig-');
    const runPath = mkProject(proj);
    const cfg = tmp('hr-cfg2-');
    mkCoreRoot(path.join(cfg, 'plugins', 'marketplaces', 'mpA', 'plugins', 'hermitd'));
    mkCoreRoot(path.join(cfg, 'plugins', 'marketplaces', 'mpB', 'plugins', 'hermitd'));
    const r = await bash(runPath, ['probe'], { CLAUDE_CONFIG_DIR: cfg });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Ambiguous');
  });

  test('valid HERMIT_PLUGIN_ROOT is used directly', async () => {
    const proj = tmp('hr-env-');
    const runPath = mkProject(proj);
    const envRoot = mkCoreRoot(tmp('hr-envroot-'));
    const r = await bash(runPath, ['probe'], {
      CLAUDE_CONFIG_DIR: tmp('hr-empty2-'),
      HERMIT_PLUGIN_ROOT: envRoot,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`RESOLVED:${fs.realpathSync(envRoot)}`);
  });

  test('foreign HERMIT_PLUGIN_ROOT is ignored, scan wins', async () => {
    const proj = tmp('hr-envbad-');
    const runPath = mkProject(proj);
    const foreign = mkCoreRoot(tmp('hr-foreign-'), 'some-other-plugin');
    const cfg = tmp('hr-cfg3-');
    const core = mkCoreRoot(path.join(cfg, 'plugins', 'marketplaces', 'mp1', 'plugins', 'hermitd'));
    const r = await bash(runPath, ['probe'], { CLAUDE_CONFIG_DIR: cfg, HERMIT_PLUGIN_ROOT: foreign });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('does not point at hermitd');
    expect(r.stdout).toContain(`RESOLVED:${fs.realpathSync(core)}`);
  });
});

describe('hermitd-exec.sh name guard', () => {
  test('bash scripts receive arguments and preserve exit codes', async () => {
    const dir = tmp('hx-shell-');
    const script = path.join(dir, 'hermitd-exec.sh');
    fs.copyFileSync(HERMIT_EXEC, script);
    fs.writeFileSync(path.join(dir, 'x.sh'), 'printf "%s\\n" "$@"\nexit 7\n');
    const r = await bash(script, ['x', 'two words', '--flag'], {});
    expect(r.stdout).toBe('two words\n--flag\n');
    expect(r.exitCode).toBe(7);
  });

  test('path traversal is rejected', async () => {
    const r = await bash(HERMIT_EXEC, ['micro-proposal/../../etc'], {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Invalid script name');
  });

  test('bare double-dot is rejected', async () => {
    const r = await bash(HERMIT_EXEC, ['..'], {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Invalid script name');
  });

  test('unknown bare name → exit 1 with predate hint', async () => {
    const r = await bash(HERMIT_EXEC, ['definitely-not-a-real-script'], {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('may predate this command');
  });

  test('a real script name dispatches to bun', async () => {
    // proposal.ts with no verb prints its own usage error and exits 1 — proof the
    // name resolved to scripts/proposal.ts and bun ran it.
    const r = await bash(HERMIT_EXEC, ['proposal'], {});
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('{"error":"usage"}\n');
  });
});

// Generated watchdog units run with an environment that need not carry bun's
// install dir; a bare `exec bun` there exits 127 on every tick. This file ships
// via /plugin update, so the probe is what repairs installs whose unit was baked
// before the PATH fix — there is no live session to run a repair in when both the
// hermit and its watchdog are down.
describe('hermitd-exec bun resolution', () => {
  // A copy of the shipped dispatcher beside a trivial script, so the test can
  // control PATH without running a real hermit script.
  function mkExecFixture(): { script: string; dir: string } {
    const dir = tmp('hx-');
    const script = path.join(dir, 'hermitd-exec.sh');
    fs.copyFileSync(HERMIT_EXEC, script);
    fs.writeFileSync(path.join(dir, 'ping.ts'), 'console.log("PONG");\n');
    return { script, dir };
  }

  test('bun absent from PATH → resolved via BUN_INSTALL', async () => {
    const { script } = mkExecFixture();
    const bunHome = tmp('hx-bun-');
    fs.mkdirSync(path.join(bunHome, 'bin'));
    fs.symlinkSync(process.execPath, path.join(bunHome, 'bin', 'bun'));

    const r = await bash(script, ['ping'], {
      PATH: '/usr/bin:/bin',
      BUN_INSTALL: bunHome,
      HOME: tmp('hx-home-'), // no ~/.bun here, so BUN_INSTALL is what resolves
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('PONG');
  });

  test('bun absent from PATH → resolved via ~/.bun/bin', async () => {
    const { script } = mkExecFixture();
    const home = tmp('hx-home-');
    fs.mkdirSync(path.join(home, '.bun', 'bin'), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(home, '.bun', 'bin', 'bun'));

    const r = await bash(script, ['ping'], { PATH: '/usr/bin:/bin', HOME: home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('PONG');
  });

  // Only meaningful where the last-resort candidates are genuinely absent.
  const noSystemBun = !['/usr/local/bin/bun', '/opt/homebrew/bin/bun'].some((p) => fs.existsSync(p));
  test.if(noSystemBun)('bun nowhere → names bun instead of a bare 127', async () => {
    const { script } = mkExecFixture();
    const r = await bash(script, ['ping'], { PATH: '/usr/bin:/bin', HOME: tmp('hx-home-') });
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toContain('bun not found');
  });
});
