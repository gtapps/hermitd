// Residency branch in startup-context.ts's SessionStart injection.
// Verifies: the managed session (HERMIT_MANAGED=1) always gets the full
// framing; an unmanaged session in a project whose managed tmux session is
// alive gets the short guest banner and nothing else; and a dead or absent
// tmux session falls back to the full framing (fail-open).
//
// The tmux probe runs through spawnSync, so the fake tmux must be a real
// executable on PATH — an in-process PATH edit would not reach it.
//
// Usage: bun test tests/startup-context-guest.test.ts   (from the plugin root)

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { writeRegistryEntry } from './helpers/registry-fixture';
import { runScript } from './helpers/run';
import { setupWorkdir } from './helpers/workdir';

const SESSION = 'hermit-fixture';

// Writes a runtime.json naming the managed tmux session, plus a fake `tmux`
// on PATH that exits with `exitCode` for `has-session`. Returns the env
// overlay a run needs to see both.
function fixture(dir: string, opts: { tmuxSession?: string; tmuxExit?: number; peerName?: string }): Record<string, string> {
  const stateDir = path.join(dir, '.hermit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'runtime.json'),
    JSON.stringify({
      version: 1,
      tmux_session: opts.tmuxSession ?? null,
      peer_name: opts.peerName ?? null,
    }),
  );

  const binDir = path.join(dir, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const tmux = path.join(binDir, 'tmux');
  fs.writeFileSync(tmux, `#!/bin/sh\nexit ${opts.tmuxExit ?? 0}\n`);
  fs.chmodSync(tmux, 0o755);

  return {
    HERMIT_RESIDENT: '',
    EVAL_HERMIT_RESIDENT: '',
    AGENT_DIR: path.join(dir, '.hermit'),
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };
}

async function run(dir: string, env: Record<string, string>, sessionId?: string) {
  const payload = sessionId === undefined ? {} : { session_id: sessionId };
  return runScript('startup-context.ts', { stdin: JSON.stringify(payload), env });
}

const markerFor = (dir: string, sessionId: string) =>
  path.join(dir, '.hermit', 'state', `.guest-${sessionId}`);

describe('startup-context.ts — resident vs guest', () => {
  for (const ownParent of [false, true]) {
    it(`resident flag with ${ownParent ? 'own parent' : 'foreign incumbent'} registry stamp`, async () => {
      const wd = setupWorkdir();
      try {
        const env = fixture(wd.dir, { tmuxSession: SESSION });
        const configDir = path.join(wd.dir, 'config');
        const pid = ownParent ? process.pid : process.ppid;
        writeRegistryEntry(configDir, pid);
        fs.writeFileSync(path.join(wd.dir, '.hermit', 'state', 'runtime.json'), JSON.stringify({
          version: 1, session_pid: pid, config_dir: configDir,
        }));
        const sessionId = 'registry-residency-test';
        const res = await run(wd.dir, { ...env, HERMIT_RESIDENT: '1' }, sessionId);
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain(ownParent ? '---Open tasks---' : '---Guest Session---');
        expect(fs.existsSync(markerFor(wd.dir, sessionId))).toBe(!ownParent);
      } finally {
        wd.cleanup();
      }
    });
  }

  it('eval-run resident flag gets the full framing; no flag gets the guest banner', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 1 });
      const asEval = await run(wd.dir, { ...env, HERMIT_MANAGED: '', EVAL_HERMIT_RESIDENT: '1' });
      expect(asEval.exitCode).toBe(0);
      expect(asEval.stdout).toContain('---Open tasks---');
      const neither = await run(wd.dir, { ...env, HERMIT_MANAGED: '', EVAL_HERMIT_RESIDENT: '' });
      expect(neither.stdout).toContain('---Guest Session---');
    } finally {
      wd.cleanup();
    }
  });

  it('managed session gets the full framing even while its tmux session is alive', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '', HERMIT_RESIDENT: '1' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain('---Guest Session---');
      expect(res.stdout).toContain('---Open tasks---');
    } finally {
      wd.cleanup();
    }
  });

  it('unmanaged session with a live resident gets the guest banner and nothing else', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0, peerName: 'hermit-peer' });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('---Guest Session---');
      expect(res.stdout).toContain('A managed hermit session is already running here');
      expect(res.stdout).toContain('@hermit-peer');
      expect(res.stdout).toContain('GUEST_REPORT:');
      expect(res.stdout).not.toContain('---Open tasks---');
      expect(res.stdout.trim().split('\n').length).toBeLessThanOrEqual(8);
    } finally {
      wd.cleanup();
    }
  });

  // A resident that booted before the --name stamp existed has no peer_name, and
  // `Resident: @.` is an instruction the guest cannot act on. Drop the two
  // handoff lines rather than name a session nobody answers to.
  it('drops the handoff lines when the resident has no resolvable peer name', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.stdout).toContain('---Guest Session---');
      expect(res.stdout).not.toContain('Resident: @');
      expect(res.stdout).not.toContain('GUEST_REPORT:');
    } finally {
      wd.cleanup();
    }
  });

  it('unmanaged session with a dead resident gets the guest banner', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 1 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('---Guest Session---');
      expect(res.stdout).not.toContain('---Open tasks---');
      expect(res.stdout).toContain('hermitd start');
    } finally {
      wd.cleanup();
    }
  });

  it('unmanaged session with no tmux_session recorded gets the guest banner', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('---Guest Session---');
      expect(res.stdout).not.toContain('---Open tasks---');
      expect(res.stdout).toContain('hermitd start');
    } finally {
      wd.cleanup();
    }
  });
});

// The banner tells the model; the marker tells the state-writing hooks, which run
// per turn with no model in the loop.
describe('startup-context.ts — guest marker', () => {
  it('marks the guest session so the per-turn hooks can read the verdict', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' }, 'sess-guest');
      expect(res.stdout).toContain('---Guest Session---');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-guest'))).toBe(true);
    } finally {
      wd.cleanup();
    }
  });

  it('marks nothing for the resident or for a session with no live resident', async () => {
    const wd = setupWorkdir();
    try {
      const live = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      await run(wd.dir, { ...live, HERMIT_MANAGED: '', HERMIT_RESIDENT: '1' }, 'sess-resident');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-resident'))).toBe(false);

      const dead = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 1 });
      await run(wd.dir, { ...dead, HERMIT_MANAGED: '' }, 'sess-solo');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-solo'))).toBe(true);
    } finally {
      wd.cleanup();
    }
  });

  it('marks nothing when the payload carries no session id', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const res = await run(wd.dir, { ...env, HERMIT_MANAGED: '' });
      expect(res.stdout).toContain('---Guest Session---');
      const stateDir = path.join(wd.dir, '.hermit', 'state');
      expect(fs.readdirSync(stateDir).filter(n => n.startsWith('.guest-'))).toEqual([]);
    } finally {
      wd.cleanup();
    }
  });

  it('clears its own marker when resumed through the launcher', async () => {
    const wd = setupWorkdir();
    try {
      const live = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      await run(wd.dir, { ...live, HERMIT_MANAGED: '' }, 'sess-guest');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-guest'))).toBe(true);

      // Same session id, resident now dead — resume/clear/compact all re-fire SessionStart.
      const dead = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 1 });
      const res = await run(wd.dir, { ...dead, HERMIT_RESIDENT: '1' }, 'sess-guest');
      expect(res.stdout).not.toContain('---Guest Session---');
      expect(fs.existsSync(markerFor(wd.dir, 'sess-guest'))).toBe(false);
    } finally {
      wd.cleanup();
    }
  });

  it('prunes a marker left behind by a long-gone session', async () => {
    const wd = setupWorkdir();
    try {
      const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
      const stale = markerFor(wd.dir, 'sess-ancient');
      fs.writeFileSync(stale, 'old\n');
      const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
      fs.utimesSync(stale, old / 1000, old / 1000);

      await run(wd.dir, { ...env, HERMIT_MANAGED: '' }, 'sess-guest');

      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(markerFor(wd.dir, 'sess-guest'))).toBe(true);
    } finally {
      wd.cleanup();
    }
  });
});


it('only resident startup seeds activity, after classification, and never resets it', async () => {
  const wd = setupWorkdir();
  try {
    const env = fixture(wd.dir, { tmuxSession: SESSION, tmuxExit: 0 });
    const activity = path.join(wd.dir, '.hermit', 'state', 'last-operator-action.json');
    await run(wd.dir, { ...env, HERMIT_MANAGED: '' }, 'new-guest');
    expect(fs.existsSync(activity)).toBe(false);
    await run(wd.dir, { ...env, HERMIT_MANAGED: '', HERMIT_RESIDENT: '1' }, 'resident');
    expect(fs.existsSync(activity)).toBe(true);
    fs.writeFileSync(activity, '{"at":"2000-01-01T00:00:00Z"}');
    await run(wd.dir, { ...env, HERMIT_MANAGED: '', HERMIT_RESIDENT: '1' }, 'resident');
    expect(fs.readFileSync(activity, 'utf-8')).toBe('{"at":"2000-01-01T00:00:00Z"}');
  } finally { wd.cleanup(); }
});

it('compact guest emits no context and keeps its guest marker', async () => {
  const wd = setupWorkdir();
  try {
    const env = fixture(wd.dir, {});
    const result = await runScript('startup-context.ts', { env, stdin: JSON.stringify({ session_id: 'compact-guest', source: 'compact' }) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.existsSync(markerFor(wd.dir, 'compact-guest'))).toBe(true);
  } finally { wd.cleanup(); }
});
