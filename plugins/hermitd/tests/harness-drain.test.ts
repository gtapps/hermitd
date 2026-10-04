// Direct unit coverage for the Stop-hook drain guard cascade.
//
// Scope split, and why: everything here is a guard that returns BEFORE tmux is
// touched, so it needs no subprocess. The branches that do reach tmux stay in
// harness-command-delivery.test.ts, because Bun's spawnSync resolves the binary
// against the PATH captured at process start — a fake tmux prepended to
// process.env.PATH in-process is never found, so a PATH shim only works across
// a spawn boundary.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { drainHarnessCommand } from '../scripts/lib/harness-drain';
import { writePendingCommand } from '../scripts/lib/harness-command';
import { withDir } from './helpers/workdir';

type Runtime = Record<string, unknown>;

const LIVE_RUNTIME: Runtime = {
  version: 1,
  runtime_mode: 'headless',
  tmux_session: 'hermit-test',
  shutdown_requested_at: null,
  shutdown_completed_at: null,
};

const hermitRoot = (dir: string) => path.join(dir, '.hermit');
const stateDir = (dir: string) => path.join(hermitRoot(dir), 'state');
const markerPath = (dir: string) => path.join(stateDir(dir), 'pending-harness-command.json');

function seed(dir: string, opts: { runtime?: Runtime; requestedAt?: string } = {}): void {
  fs.writeFileSync(
    path.join(stateDir(dir), 'runtime.json'),
    JSON.stringify(opts.runtime ?? LIVE_RUNTIME),
  );
  writePendingCommand(hermitRoot(dir), {
    command: '/permission-mode',
    arg: 'auto',
    by: 'operator',
    requested_at: opts.requestedAt ?? new Date().toISOString(),
  });
}

/**
 * Every guard below is asserted the same way: the marker survives. A guard that
 * wrongly falls through would try to type into a session named 'hermit-test',
 * which does not exist under the test runner, so the marker is the honest signal
 * that the drain declined rather than failed.
 */
const markerSurvives = (dir: string) => fs.existsSync(markerPath(dir));

describe('drainHarnessCommand guards', () => {
  test('no marker is a no-op', withDir(async (dir) => {
    fs.writeFileSync(path.join(stateDir(dir), 'runtime.json'), JSON.stringify(LIVE_RUNTIME));

    drainHarnessCommand(hermitRoot(dir));

    expect(markerSurvives(dir)).toBe(false); // nothing was written, nothing appeared
  }));

  test('marker past its TTL is left on disk, not delivered', withDir(async (dir) => {
    seed(dir, { requestedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });

    drainHarnessCommand(hermitRoot(dir));

    expect(markerSurvives(dir)).toBe(true);
  }));

  test('a missing runtime.json defers delivery', withDir(async (dir) => {
    seed(dir);
    fs.unlinkSync(path.join(stateDir(dir), 'runtime.json'));

    drainHarnessCommand(hermitRoot(dir));

    expect(markerSurvives(dir)).toBe(true);
  }));

  test('unreadable runtime defers delivery', withDir(async (dir) => {
    seed(dir);
    fs.writeFileSync(path.join(stateDir(dir), 'runtime.json'), 'not json');

    drainHarnessCommand(hermitRoot(dir));

    expect(markerSurvives(dir)).toBe(true);
  }));

  test('interactive sessions are never typed into', withDir(async (dir) => {
    seed(dir, { runtime: { ...LIVE_RUNTIME, runtime_mode: 'interactive' } });

    drainHarnessCommand(hermitRoot(dir));

    expect(markerSurvives(dir)).toBe(true);
  }));

  for (const field of ['transition', 'shutdown_requested_at', 'shutdown_completed_at'] as const) {
    test(`lifecycle guard: ${field} in flight defers delivery`, withDir(async (dir) => {
      seed(dir, { runtime: { ...LIVE_RUNTIME, [field]: '2026-08-14T00:00:00Z' } });

      drainHarnessCommand(hermitRoot(dir));

      expect(markerSurvives(dir)).toBe(true);
    }));
  }

  test('a runtime with no tmux_session defers delivery', withDir(async (dir) => {
    seed(dir, { runtime: { ...LIVE_RUNTIME, tmux_session: null } });

    drainHarnessCommand(hermitRoot(dir));

    expect(markerSurvives(dir)).toBe(true);
  }));
});
