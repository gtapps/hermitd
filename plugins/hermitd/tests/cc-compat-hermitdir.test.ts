// Unit tests for hermitDir() — the project-root resolver added in #384.
//
// IMPORTANT: each case explicitly controls CLAUDE_PROJECT_DIR and AGENT_DIR before
// importing the module, because the test process inherits the real env when run
// inside a CC session. An ambient CLAUDE_PROJECT_DIR would silently satisfy
// branch (2) and hide cwd-drift bugs the tests are meant to catch.
//
// Strategy: dynamically re-import cc-compat.ts for each case so the module-level
// `process.env` reads happen fresh. Bun re-evaluates dynamic imports per module
// instance only when the module hasn't been cached — so we manipulate env before
// each call and restore it after.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeTmpHermit(): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-test-')));
  fs.mkdirSync(path.join(tmp, '.hermit', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.hermit', 'config.json'), '{}');
  return tmp;
}

// Save + restore env vars per test
let savedEnv: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
}

// hermitDir() reads process.env at call time (not module load time), so we can
// import once and control env per-call.
const { hermitDir, findHermitDir, assertStateDir } = await import('../scripts/lib/cc-compat');

// A `claude --worktree` worktree: the `.worktreeinclude` managed block's copies
// (config.json, never state/) under <root>/.claude/worktrees/wt. Returns the
// projected `.hermit`, i.e. what the relative argv resolves to from
// inside that worktree.
function makeProjection(root: string): string {
  const wt = path.join(root, '.claude', 'worktrees', 'wt', '.hermit');
  fs.mkdirSync(path.join(wt, 'compiled'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'config.json'), '{}');
  return wt;
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

// Serial by necessity, not by taste: bunfig.toml's `concurrentTestGlob`
// runs every `beforeEach`, then every body, then every `afterEach`, so
// teardown sees the LAST value of a module/describe-scope fixture and rm's
// a directory another test still needs. `test.serial` restores be/ae
// pairing per test (`describe.serial` is silently ignored, Bun 1.3.14).
// Drop it only after giving each test its own fixture.
describe('hermitDir()', () => {
  let tmp: string;
  let origCwd: string;

  beforeEach(() => {
    tmp = makeTmpHermit();
    origCwd = process.cwd();
    saveEnv('AGENT_DIR', 'CLAUDE_PROJECT_DIR');
    // Clear both so tests start from a clean slate
    delete process.env.AGENT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    restoreEnv();
    try { process.chdir(origCwd); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.serial('(a) absolute AGENT_DIR wins over CLAUDE_PROJECT_DIR and drifted cwd', () => {
    const agentDir = path.join(tmp, '.hermit');
    // Set a conflicting CLAUDE_PROJECT_DIR pointing somewhere else
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-other-')));
    try {
      fs.mkdirSync(path.join(other, '.hermit'), { recursive: true });
      fs.writeFileSync(path.join(other, '.hermit', 'config.json'), '{}');
      process.env.AGENT_DIR = agentDir;
      process.env.CLAUDE_PROJECT_DIR = other;
      // cwd is unrelated
      expect(hermitDir()).toBe(agentDir);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it.serial('(b) relative AGENT_DIR is ignored — falls through to CLAUDE_PROJECT_DIR', () => {
    // This is the legacy registration shape that CAUSED #384: AGENT_DIR=".hermit"
    process.env.AGENT_DIR = '.hermit'; // relative — must be ignored
    process.env.CLAUDE_PROJECT_DIR = tmp;
    expect(hermitDir()).toBe(path.join(tmp, '.hermit'));
  });

  it.serial('(c) CLAUDE_PROJECT_DIR set, cwd drifted — env branch wins', () => {
    // Simulate the #384 trigger: cwd drifted inside .hermit/
    delete process.env.AGENT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp;
    process.chdir(path.join(tmp, '.hermit', 'state'));
    expect(hermitDir()).toBe(path.join(tmp, '.hermit'));
  });

  it.serial('(d) no env vars, cwd drifted into subdir — walk-up recovers', () => {
    delete process.env.AGENT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    process.chdir(path.join(tmp, '.hermit', 'state'));
    expect(hermitDir()).toBe(path.join(tmp, '.hermit'));
  });

  it.serial('(e) no env vars, unrelated cwd — fail-open returns resolved .hermit', () => {
    delete process.env.AGENT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    // Use a tmpdir with no hermit (walk-up finds nothing)
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-bare-')));
    try {
      process.chdir(bare);
      const result = hermitDir();
      // Should be path.resolve('.hermit') from the bare dir
      expect(result).toBe(path.join(bare, '.hermit'));
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it.serial('(b2) CLAUDE_PROJECT_DIR set but .hermit subdir absent — falls to walk-up', () => {
    // existsSync guard: if CLAUDE_PROJECT_DIR doesn't actually have a .cch dir, skip it
    delete process.env.AGENT_DIR;
    const noHermit = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-noh-')));
    try {
      process.env.CLAUDE_PROJECT_DIR = noHermit; // no .hermit inside
      process.chdir(path.join(tmp, '.hermit', 'state'));
      // Walk-up from drifted cwd finds tmp's hermit dir
      expect(hermitDir()).toBe(path.join(tmp, '.hermit'));
    } finally {
      fs.rmSync(noHermit, { recursive: true, force: true });
    }
  });

  it.serial('(b3) CLAUDE_PROJECT_DIR names a worktree projection — falls to walk-up', () => {
    // A `claude --worktree` session: CLAUDE_PROJECT_DIR is the worktree, whose
    // .cch dir is the projected copy (config.json, no state/). Honouring it
    // would anchor every hook-driven writer to a state dir that isn't there.
    delete process.env.AGENT_DIR;
    const wt = path.join(tmp, '.claude', 'worktrees', 'wt');
    fs.mkdirSync(path.join(wt, '.hermit'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.hermit', 'config.json'), '{}');
    process.env.CLAUDE_PROJECT_DIR = wt;
    process.chdir(wt);
    expect(hermitDir()).toBe(path.join(tmp, '.hermit'));
  });

  // findHermitDir() is hermitDir()'s walk without the env branches or the
  // fail-open tail: callers that start somewhere other than cwd (routines/event.ts)
  // need a null they can refuse on, and must not have an ambient
  // CLAUDE_PROJECT_DIR override the root their caller resolved.
  describe('findHermitDir()', () => {
    // Builds <root>/a/b/... `levels` deep; the hermit lives at the root.
    function nest(levels: number): { root: string; deepest: string } {
      const root = makeTmpHermit();
      let deepest = root;
      for (let i = 0; i < levels; i++) {
        deepest = path.join(deepest, `l${i}`);
        fs.mkdirSync(deepest);
      }
      return { root, deepest };
    }

    // The cap is 8 CHECKS — the start dir plus 7 ancestors — so the deepest
    // findable sentinel sits 7 levels up. Pinned because both the cap and the
    // off-by-one are easy to "tidy" into a different boundary later.
    it.serial('finds a sentinel 7 levels up, and gives up at 8', () => {
      const at7 = nest(7);
      const at8 = nest(8);
      try {
        expect(findHermitDir(at7.deepest)).toBe(path.join(at7.root, '.hermit'));
        expect(findHermitDir(at8.deepest)).toBeNull();
      } finally {
        fs.rmSync(at7.root, { recursive: true, force: true });
        fs.rmSync(at8.root, { recursive: true, force: true });
      }
    });

    it.serial('walks past a config-less decoy to the real project above it', () => {
      // A partially-populated `.hermit/` — OPERATOR.md but no
      // config.json — must not capture the walk.
      const root = makeTmpHermit();
      try {
        const worktree = path.join(root, '.claude', 'worktrees', 'wt');
        fs.mkdirSync(path.join(worktree, '.hermit'), { recursive: true });
        fs.writeFileSync(path.join(worktree, '.hermit', 'OPERATOR.md'), '');
        expect(findHermitDir(worktree)).toBe(path.join(root, '.hermit'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it.serial('walks past a worktree projection to the main checkout above it', () => {
      // The real `claude --worktree` shape: `.worktreeinclude`'s managed block
      // copies OPERATOR.md, config.json and compiled/ in, but never state/.
      // The config.json sentinel alone would capture the walk here and route
      // every ledger read and write into a state dir that does not exist.
      const root = makeTmpHermit();
      try {
        const wt = path.join(root, '.claude', 'worktrees', 'wt', '.hermit');
        fs.mkdirSync(path.join(wt, 'compiled'), { recursive: true });
        fs.writeFileSync(path.join(wt, 'OPERATOR.md'), '');
        fs.writeFileSync(path.join(wt, 'config.json'), '{}');
        expect(findHermitDir(path.dirname(wt))).toBe(path.join(root, '.hermit'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it.serial('accepts a root once it has state/ — the projection test is state-based', () => {
      // Guards the discriminator itself: config.json + state/ is a real root at
      // any depth, so the skip above can never swallow a genuine nested hermit.
      const root = makeTmpHermit();
      try {
        const nested = path.join(root, 'sub', 'project');
        fs.mkdirSync(path.join(nested, '.hermit', 'state'), { recursive: true });
        fs.writeFileSync(path.join(nested, '.hermit', 'config.json'), '{}');
        expect(findHermitDir(nested)).toBe(path.join(nested, '.hermit'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it.serial('ignores CLAUDE_PROJECT_DIR — the caller-supplied start wins', () => {
      const elsewhere = makeTmpHermit();
      try {
        process.env.CLAUDE_PROJECT_DIR = elsewhere;
        expect(findHermitDir(tmp)).toBe(path.join(tmp, '.hermit'));
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });
});

// -------------------------------------------------------------------------
// assertStateDir() — worktree projections
//
// The resident prompt commands pass the relative `.hermit`. From a
// worktree that resolves to the projection while every accepted root is main's,
// so the pin has to normalize it or refuse the spelling the hermit itself ships.
// AGENT_DIR pins hermitDir() to a known root so these assert the argv side only.
// -------------------------------------------------------------------------

describe('assertStateDir() with a worktree projection', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpHermit();
    saveEnv('AGENT_DIR', 'CLAUDE_PROJECT_DIR');
    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.AGENT_DIR = path.join(tmp, '.hermit');
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.serial('normalizes a projection of the accepted root to that root', () => {
    expect(assertStateDir(makeProjection(tmp))).toBe(path.join(tmp, '.hermit'));
  });

  it.serial('still refuses a projection belonging to another project', () => {
    const foreign = makeTmpHermit();
    try {
      expect(assertStateDir(makeProjection(foreign))).toBeNull();
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });

  it.serial('leaves a real root untouched', () => {
    expect(assertStateDir(path.join(tmp, '.hermit'))).toBe(path.join(tmp, '.hermit'));
  });
});
