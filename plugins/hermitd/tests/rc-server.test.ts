// Contract tests for the rc-server spawn-gate verb.
// Covers gc (the only subcommand with real logic that runs without a live
// Remote Control server), status against a fake tmux, and argument handling.
// No live RC server is started here — `start` is exercised manually.
//
// Usage: bun test tests/rc-server.test.ts   (from the plugin root)

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScript } from './helpers/run';
import { setupGitWorkdir } from './helpers/workdir';

// A fake `tmux` on PATH so status/gc never touch the real server.
function fakeTmux(dir: string, exitCode: number): string {
  const binDir = path.join(dir, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const tmux = path.join(binDir, 'tmux');
  fs.writeFileSync(tmux, `#!/bin/sh\nexit ${exitCode}\n`);
  fs.chmodSync(tmux, 0o755);
  return `${binDir}:${process.env.PATH ?? ''}`;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
}

async function rcServer(dir: string, args: string[], pathOverride?: string) {
  return runScript('rc-server.ts', {
    args,
    cwd: dir,
    env: { PATH: pathOverride ?? fakeTmux(dir, 1) },
  });
}

describe('rc-server.ts', () => {
  it('gc removes an orphaned locked bridge worktree and its branch', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-fake123');
      // Branch name deliberately unrelated to the directory name: gc must read
      // the branch from `git worktree list`, not derive it from the path.
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'cse-session-xyz', wt);
      git(wd.dir, 'worktree', 'lock', wt);

      const res = await rcServer(wd.dir, ['gc']);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ removed: ['bridge-fake123'], kept: [], failed: [] });
      expect(fs.existsSync(wt)).toBe(false);
      expect(git(wd.dir, 'branch', '--list', 'cse-session-xyz').trim()).toBe('');
    } finally {
      wd.cleanup();
    }
  });

  // The unattended sweep dates a worktree by the `.git` file `worktree add`
  // writes once, so back-dating that file is how a test says "not brand new".
  function ageWorktree(wt: string, minutes: number): void {
    const t = new Date(Date.now() - minutes * 60_000);
    fs.utimesSync(path.join(wt, '.git'), t, t);
  }

  it('sweep silently removes an orphaned locked bridge worktree and its branch', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-sweep123');
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'cse-session-sweep', wt);
      git(wd.dir, 'worktree', 'lock', wt);
      ageWorktree(wt, 10);

      const res = await rcServer(wd.dir, ['sweep']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('OK');
      expect(fs.existsSync(wt)).toBe(false);
      expect(git(wd.dir, 'branch', '--list', 'cse-session-sweep').trim()).toBe('');
    } finally {
      wd.cleanup();
    }
  });

  // A spawn is clean and unheld for the moment between `git worktree add` and
  // the session chdir-ing into it. gc runs on a timer now, so that window has to
  // be safe. The un-aged twin of the `gc removes an orphaned...` case above,
  // which pins that the operator-invoked verb still sweeps it either way.
  it('sweep leaves a brand-new worktree alone', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-fresh999');
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'cse-session-fresh', wt);

      const res = await rcServer(wd.dir, ['sweep']);
      expect(res.exitCode).toBe(0);
      expect(fs.existsSync(wt)).toBe(true);
      expect(git(wd.dir, 'branch', '--list', 'cse-session-fresh').trim()).not.toBe('');
    } finally {
      wd.cleanup();
    }
  });

  it('gc on a repo with no bridge worktrees is a no-op', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, ['gc']);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ removed: [], kept: [], failed: [] });
    } finally {
      wd.cleanup();
    }
  });

  it('gc leaves a bridge worktree that a live process is sitting in', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-live456');
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'worktree-bridge-live456', wt);

      // A live process whose cwd IS the worktree — the liveness signal gc reads.
      const holder = Bun.spawn({ cmd: ['sleep', '30'], cwd: wt });
      try {
        const res = await rcServer(wd.dir, ['gc']);
        expect(res.exitCode).toBe(0);
        expect(res.stdout).not.toContain('bridge-live456');
        expect(fs.existsSync(wt)).toBe(true);
      } finally {
        holder.kill();
      }
    } finally {
      wd.cleanup();
    }
  });

  it('gc sweeps a committed-but-unmerged worktree without destroying its commits', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-committed321');
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'cse-session-committed', wt);
      // A spawned session that finished its work and committed it: the tree is
      // clean, so the dirty guard waves it through — only -d keeps the commits.
      fs.writeFileSync(path.join(wt, 'done.txt'), 'finished work\n');
      git(wt, 'add', 'done.txt');
      // Identity passed inline: CI runners have none configured, same reason
      // setupGitWorkdir spells it out for its own commits.
      git(wt, '-c', 'user.name=test', '-c', 'user.email=test@test', '-c', 'commit.gpgsign=false',
        'commit', '-qm', 'work from a spawned session');

      const res = await rcServer(wd.dir, ['gc']);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).removed).toEqual(['bridge-committed321']);
      expect(fs.existsSync(wt)).toBe(false);
      expect(git(wd.dir, 'branch', '--list', 'cse-session-committed').trim()).not.toBe('');
    } finally {
      wd.cleanup();
    }
  });

  it('gc keeps a bridge worktree holding uncommitted work', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-dirty789');
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'cse-session-dirty', wt);
      fs.writeFileSync(path.join(wt, 'unsaved.txt'), 'work the operator has not committed\n');

      const res = await rcServer(wd.dir, ['gc']);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).kept).toEqual(['bridge-dirty789']);
      expect(fs.existsSync(wt)).toBe(true);
      expect(git(wd.dir, 'branch', '--list', 'cse-session-dirty').trim()).not.toBe('');
    } finally {
      wd.cleanup();
    }
  });

  // stop() returns gc() on both branches, which is why the skill no longer tells
  // the model to follow a stop with a gc. The already-down branch is the one a
  // refactor would most plausibly drop, so it is the one pinned here.
  it('stop on an already-down gate still sweeps an orphaned bridge worktree', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-afterstop');
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'cse-session-afterstop', wt);
      git(wd.dir, 'worktree', 'lock', wt);

      const res = await rcServer(wd.dir, ['stop']);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ status: 'down', gc: { removed: ['bridge-afterstop'], kept: [], failed: [] } });
      expect(fs.existsSync(wt)).toBe(false);
    } finally {
      wd.cleanup();
    }
  });

  it('stop with nothing to sweep omits gc', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, ['stop']);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ status: 'down' });
    } finally {
      wd.cleanup();
    }
  });

  it('status reports down when no gate session exists', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, ['status']);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ status: 'down' });
    } finally {
      wd.cleanup();
    }
  });

  it('status lists a live bridge worktree', async () => {
    const wd = setupGitWorkdir();
    try {
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-status456');
      git(wd.dir, 'worktree', 'add', '-q', '-b', 'cse-session-status', wt);

      const holder = Bun.spawn({ cmd: ['sleep', '30'], cwd: wt });
      try {
        const res = await rcServer(wd.dir, ['status']);
        expect(res.exitCode).toBe(0);
        expect(JSON.parse(res.stdout)).toEqual({ status: 'down', live_spawns: ['bridge-status456'] });
      } finally {
        holder.kill();
      }
    } finally {
      wd.cleanup();
    }
  });

  it('unknown subcommand is a usage error', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, ['bogus']);
      expect(res.exitCode).toBe(1);
      expect(JSON.parse(res.stdout)).toEqual({ error: 'usage' });
    } finally {
      wd.cleanup();
    }
  });

  it('missing subcommand is a usage error', async () => {
    const wd = setupGitWorkdir();
    try {
      const res = await rcServer(wd.dir, []);
      expect(res.exitCode).toBe(1);
    } finally {
      wd.cleanup();
    }
  });
});
