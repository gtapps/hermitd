import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { transcriptPathKey } from '../scripts/lib/cc-compat';

const { freshDir, cleanup } = freshDirFactory('hermit-dpf-');
afterAll(cleanup);

async function run(projectRoot: string, env: Record<string, string> = {}) {
  // CLAUDE_CONFIG_DIR is blanked by default: runScript merges process.env, so a
  // maintainer whose own config dir is set would otherwise have the seed probe
  // look somewhere the fixture never wrote.
  const r = await runScript('docker-preflight.ts', {
    args: [projectRoot],
    env: { CLAUDE_CONFIG_DIR: '', ...env },
  });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe('docker-preflight.ts', () => {
  test('clean project: stable shape, fail-open fields', async () => {
    const dir = freshDir();
    const out = await run(dir);

    // docker_version is host-dependent — string or null, never throws.
    expect(out.docker_version === null || typeof out.docker_version === 'string').toBe(true);
    expect(out.config_exists).toBe(false);
    expect(out.is_wsl).toBe(false);
    expect(out.existing).toEqual({ dockerfile: false, entrypoint: false, compose: false });
    expect(typeof out.gitconfig_exists).toBe('boolean');
    // path key is derived from the project root passed in — keyed off the supplied
    // logical path, not a resolved one — using CC's scheme via cc-compat.
    expect(out.memory.path_key).toBe(transcriptPathKey(dir));
    expect(typeof out.memory.seed_exists).toBe('boolean');
  });

  test('detects config.json and existing docker files', async () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.hermit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hermit', 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'Dockerfile.hermit'), 'FROM ubuntu\n');
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');

    const out = await run(dir);
    expect(out.config_exists).toBe(true);
    expect(out.existing.dockerfile).toBe(true);
    expect(out.existing.compose).toBe(true);
    expect(out.existing.entrypoint).toBe(false);
  });
  // live_owner mirrors the entrypoint's split-brain guard and hermitd-start's
  // shouldRefuseBoot: a non-docker runtime_mode that is not cleanly
  // shut down, backed by a liveness file inside the 600s freshness window.
  function seedOwner(dir: string, runtime: object, ageSecs = 0) {
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify(runtime));
    const liveness = path.join(stateDir, 'routine-monitor-liveness.json');
    fs.writeFileSync(liveness, '{}');
    if (ageSecs) {
      const when = new Date(Date.now() - ageSecs * 1000);
      fs.utimesSync(liveness, when, when);
    }
  }

  test('no runtime.json: no live owner', async () => {
    const out = await run(freshDir());
    expect(out.live_owner).toBe(null);
  });

  test('live tmux owner: reported with mode and liveness age', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'tmux' });

    const out = await run(dir);
    expect(out.live_owner.mode).toBe('tmux');
    expect(out.live_owner.age_secs).toBeGreaterThanOrEqual(0);
    expect(out.live_owner.age_secs).toBeLessThan(600);
  });

  // The reason live_owner is not a call into shouldRefuseBoot: a running Docker
  // hermit is the supported case for re-running /docker-setup over an existing
  // container, so it must never gate the wizard.
  test('a live docker owner never gates the wizard', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'docker' });

    expect((await run(dir)).live_owner).toBe(null);
  });

  test('cleanly-stopped owner is definitively dead, not live', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'tmux', shutdown_completed_at: '2026-07-24T11:00:00Z' });

    expect((await run(dir)).live_owner).toBe(null);
  });

  test('stale liveness proves nothing: no live owner', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'tmux' }, 660);

    expect((await run(dir)).live_owner).toBe(null);
  });

  // The fake tmux answers only the exact-match target, so this also pins `=name`:
  // a bare target would let `hermit-demo` match a live `hermit-demo-2`.
  test('live host tmux session owns the state even when liveness is stale', async () => {
    const dir = freshDir();
    seedOwner(dir, { runtime_mode: 'tmux', tmux_session: 'hermit-demo' }, 660);
    const bin = path.join(dir, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tmux'),
      '#!/usr/bin/env bash\n[ "$1 $2 $3" = "has-session -t =hermit-demo" ] && exit 0\nexit 1\n', { mode: 0o755 });

    const out = await run(dir, { PATH: `${bin}:${process.env.PATH}` });
    expect(out.live_owner.mode).toBe('tmux');
    expect(out.live_owner.age_secs).toBeGreaterThanOrEqual(660);
  });

  // The older `pwd | sed 's|/|-|g'` scheme replaced slashes only, so any dotted
  // path key diverged from the one CC actually writes and the seed probe missed a
  // memory file that was sitting right there.
  test('a dotted project root keys the way CC does, dots included', async () => {
    const dir = path.join(freshDir(), 'my.project');
    fs.mkdirSync(dir, { recursive: true });

    const out = await run(dir);
    expect(out.memory.path_key).toBe(transcriptPathKey(dir));
    expect(out.memory.path_key).not.toContain('.');
  });

  test('the seed probe follows CLAUDE_CONFIG_DIR, not ~/.claude', async () => {
    const dir = freshDir();
    const configDir = freshDir();
    const seedDir = path.join(configDir, 'projects', transcriptPathKey(dir), 'memory');
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'MEMORY.md'), '# seed\n');

    expect((await run(dir, { CLAUDE_CONFIG_DIR: configDir })).memory.seed_exists).toBe(true);
    expect((await run(dir)).memory.seed_exists).toBe(false); // blanked: falls back to ~/.claude
  });
});
