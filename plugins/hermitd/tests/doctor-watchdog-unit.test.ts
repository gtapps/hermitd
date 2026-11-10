// The doctor's watchdog check reads the systemd unit's own last-run outcome.
//
// A unit whose ExecStart cannot resolve bun exits 127 before the watchdog stamps
// last_run, so staleness alone eventually notices — after ~20 minutes, and only
// to say "enabled but not firing", which points at the wrong remedy. Asking
// systemd directly names the case immediately.
//
// Spawned, not imported: the check shells out to systemctl, and a fake
// executable only takes effect across a process boundary (Bun snapshots PATH for
// in-process spawns).

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

// Serial by necessity, not by taste: bunfig.toml's `concurrentTestGlob`
// runs every `beforeEach`, then every body, then every `afterEach`, so
// teardown sees the LAST value of a module/describe-scope fixture and rm's
// a directory another test still needs. `test.serial` restores be/ae
// pairing per test (`describe.serial` is silently ignored, Bun 1.3.14).
// Drop it only after giving each test its own fixture.
let dir: string;
let hermit: string;
let fakeBin: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-wd-'));
  hermit = path.join(dir, '.hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  fakeBin = path.join(dir, 'fake-bin');
  fs.mkdirSync(fakeBin);

  fs.writeFileSync(
    path.join(hermit, 'config.json'),
    JSON.stringify({ timezone: 'UTC', watchdog: { enabled: true } }),
  );
  fs.writeFileSync(
    path.join(hermit, 'state', 'runtime.json'),
    JSON.stringify({ version: 1, runtime_mode: 'tmux' }),
  );
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

/**
 * Fake systemctl that answers `show` for exactly one unit name and mimics
 * systemd's behaviour for every other: a unit that does not exist reports
 * ExecMainStatus=0 / Result=success, indistinguishable from a healthy one. That
 * synthesis is what makes a wrong unit name silently lose the diagnosis, so the
 * stub reproduces it rather than erroring.
 */
function writeFakeSystemctl(unitName: string, props: Record<string, string>): void {
  const answers = Object.entries(props).map(([k, v]) => `echo "${k}=${v}"`).join('\n  ');
  fs.writeFileSync(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash
unit=""
for a in "$@"; do case "$a" in *.service) unit="$a" ;; esac; done
if [ "$unit" = "${unitName}.service" ]; then
  ${answers}
else
  echo "ExecMainStatus=0"
  echo "Result=success"
fi
exit 0
`,
  );
  fs.chmodSync(path.join(fakeBin, 'systemctl'), 0o755);
}

/** Run the doctor and return its watchdog check. `cwd` defaults to the project. */
async function watchdogCheck(
  cwd = dir,
  env: Record<string, string> = {},
): Promise<{ status: string; detail: string; fix?: string }> {
  const r = await runScript('doctor-check.ts', {
    args: [hermit],
    cwd,
    env: { PATH: `${fakeBin}:${process.env.PATH}`, ...env },
  });
  const checks = JSON.parse(r.stdout).checks;
  return checks.find((c: any) => c.id === 'watchdog');
}

// The unit hermitd-watchdog install generated for this project: the default
// tmux_session_name with {project_name} expanded to the project dir's basename.
const unitFor = (projectDir: string) => `hermit-watchdog@hermit-${path.basename(projectDir)}`;

const isLinux = process.platform === 'linux';

describe('watchdog unit status', () => {
  test.serial.if(isLinux)('exit 127 → fail naming the PATH remedy', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '127', Result: 'exit-code' });
    const check = await watchdogCheck();
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('127');
    expect(check.fix).toBe('watchdog-install');
    expect(check.detail).toContain('hermitd watchdog install');
  });

  test.serial.if(isLinux)('a non-127 failure points at the journal, not at re-installing', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '0', Result: 'timeout' });
    const check = await watchdogCheck();
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('journalctl');
    expect(check.detail).not.toContain('hermitd watchdog install');
  });

  test.serial.if(isLinux)('a healthy unit falls through to the existing staleness logic', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '0', Result: 'success' });
    const check = await watchdogCheck();
    expect(check.status).not.toBe('fail');
    // No last_run was ever stamped in this fixture, so staleness still reports.
    expect(check.detail).toContain('not firing');
    expect(check.fix).toBe('watchdog-install');
  });

  // A unit written before the PATH fix still ticks — hermitd-exec.sh resolves bun
  // by absolute path — so neither the exit-status probe nor staleness sees it,
  // while every restart dies in hermitd-start's preflight. The unit file is the
  // only remaining evidence, so the doctor reads it once liveness is satisfied.
  function writeUnit(home: string, body: string): void {
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, `${unitFor(dir)}.service`), body);
  }

  /** A firing watchdog: fresh last_run, so the staleness gate stays quiet. */
  function stampFreshRun(): void {
    fs.writeFileSync(
      path.join(hermit, 'state', 'watchdog-state.json'),
      JSON.stringify({ last_run: new Date().toISOString() }),
    );
  }

  test.serial.if(isLinux)('firing unit with no baked PATH → warn pointing at re-install', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '0', Result: 'success' });
    stampFreshRun();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-wd-home-'));
    try {
      writeUnit(home, '[Service]\nType=oneshot\nExecStart=/x/hermitd-watchdog run\n');
      const check = await watchdogCheck(dir, { HOME: home });
      expect(check.status).toBe('warn');
      // Not the staleness warn, which also names install — this is the unit-file read.
      expect(check.detail).toContain('no Environment=PATH');
      expect(check.fix).toBe('watchdog-install');
      expect(check.detail).toContain('hermitd watchdog install');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test.serial.if(isLinux)('firing unit with a baked PATH → no PATH warning', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '0', Result: 'success' });
    stampFreshRun();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-wd-home-'));
    try {
      writeUnit(home, '[Service]\nType=oneshot\nEnvironment="PATH=/usr/bin"\nExecStart=/x/w run\n');
      const check = await watchdogCheck(dir, { HOME: home });
      expect(check.detail).not.toContain('Environment=PATH');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test.serial.if(isLinux)('scheduler_enabled false → ok opted out even when the unit would fail', async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '127', Result: 'exit-code' });
    fs.writeFileSync(
      path.join(hermit, 'config.json'),
      JSON.stringify({ timezone: 'UTC', watchdog: { enabled: true, scheduler_enabled: false } }),
    );
    const check = await watchdogCheck();
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('scheduler opted out');
    expect(check.detail).not.toContain('hermitd watchdog install');
  });

  test.serial.if(isLinux)('the unit name comes from the hermit dir, not the working directory', async () => {
    // The stub only answers for the project's real unit; anything else gets
    // systemd's healthy-looking synthesis. Running the doctor from an unrelated
    // cwd must therefore still produce the failure.
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '127', Result: 'exit-code' });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-wd-cwd-'));
    try {
      const check = await watchdogCheck(elsewhere);
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('127');
    expect(check.fix).toBe('watchdog-install');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

for (const mode of ['tmux', 'docker']) {
  test.serial.if(isLinux)(`repair policy in ${mode} with restart tier disabled`, async () => {
    writeFakeSystemctl(unitFor(dir), { ExecMainStatus: '0', Result: 'success' });
    fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({ watchdog: { enabled: false }, context_hygiene: { clear: { enabled: true } } }));
    fs.writeFileSync(path.join(hermit, 'state/runtime.json'), JSON.stringify({ runtime_mode: mode }));
    expect((await watchdogCheck()).fix).toBeUndefined();
    const home = path.join(dir, 'home');
    const units = path.join(home, '.config/systemd/user');
    fs.mkdirSync(units, { recursive: true });
    fs.writeFileSync(path.join(units, `${unitFor(dir)}.timer`), '[Timer]');
    expect((await watchdogCheck(dir, { HOME: home })).fix).toBe(mode === 'tmux' ? 'watchdog-install' : undefined);
  });
}

test.serial.if(isLinux)('no systemctl means no safe install tag', async () => {
  // The subprocess uses Bun by absolute path; no scheduler is discoverable.
  expect((await watchdogCheck(dir, { PATH: fakeBin })).fix).toBeUndefined();
});
