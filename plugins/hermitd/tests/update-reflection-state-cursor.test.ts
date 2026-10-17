// --scheduled-check-run: the session skill's step-4b cursor write. Contract:
// it writes ONLY scheduled_checks.<id>.last_run (HERMIT_NOW-aware date) and
// preserves everything else, including legacy sibling per-check fields.
//
// Usage: bun test tests/update-reflection-state-cursor.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, runPinnedScript } from './helpers/run';

const NOW = '2026-07-20T12:00:00Z';
const CHECK_ID = 'ha-anomaly';

// The fixture mirrors production layout: the hermit root is the scratch dir and
// the state file lives at <hermit>/state/reflection-state.json, which is what
// the pin's `state` bound accepts.
function withTmp(fn: (stateFile: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflcursor-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    try { await fn(path.join(dir, 'state', 'reflection-state.json')); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

/** The hermit root for a state file produced by withTmp(). */
const rootOf = (stateFile: string) => path.dirname(path.dirname(stateFile));

async function runCursor(stateFile: string, id?: string) {
  // update-reflection-state.ts's argv is the state FILE, not the hermit root, so
  // the pin is containment against <hermit>/state — pass the hermit root here.
  return runPinnedScript('update-reflection-state.ts', rootOf(stateFile), [stateFile, '--scheduled-check-run', ...(id ? [id] : [])], {
    env: { HERMIT_NOW: NOW },
  });
}

describe('update-reflection-state --scheduled-check-run', () => {
  test('no state file → creates the scheduled_checks cursor from scratch', withTmp(async (stateFile) => {
    const r = await runCursor(stateFile, CHECK_ID);
    expect(r.exitCode).toBe(0);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(state).toEqual({ scheduled_checks: { [CHECK_ID]: { last_run: '2026-07-20' } } });
  }));

  test('rich existing state: only <id>.last_run changes, everything else deep-equal', withTmp(async (stateFile) => {
    const existing = {
      last_reflection: '2026-07-01T09:00:00.000Z',
      last_quick_hash: 'abc123',
      counters: { total_runs: 5, judge_accept: 2, judge_suppress_by_code: { 'covered-by-memory': 1 } },
      scheduled_checks: {
        'other-check': { last_run: '2026-06-30', consecutive_empty: 2 },
        [CHECK_ID]: {
          last_run: '2026-06-01',
          consecutive_empty: 3,
          last_error_at: '2026-06-15T00:00:00Z',
        },
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(existing, null, 2) + '\n');
    const r = await runCursor(stateFile, CHECK_ID);
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    const expected = structuredClone(existing);
    expected.scheduled_checks[CHECK_ID].last_run = '2026-07-20';
    expect(after).toEqual(expected);
  }));

  test('rejects outcome arguments without writing state', withTmp(async (stateFile) => {
    const r = await runPinnedScript('update-reflection-state.ts', rootOf(stateFile), [stateFile, '--scheduled-check-run', CHECK_ID, '--outcome', 'empty']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('{"error":"usage"}\n');
    expect(fs.existsSync(stateFile)).toBe(false);
  }));

  test('missing id argument → exit 1 with a usage error', withTmp(async (stateFile) => {
    const r = await runCursor(stateFile);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('{"error":"usage"}\n');
    expect(fs.existsSync(stateFile)).toBe(false);
  }));
});

describe('update-reflection-state --graduation-cursor', () => {
  async function runGrad(stateFile: string) {
    return runPinnedScript('update-reflection-state.ts', rootOf(stateFile), [stateFile, '--graduation-cursor']);
  }

  test('writes only counters.last_graduation_at, leaves last_run_at and last_quick_hash', withTmp(async (stateFile) => {
    const existing = {
      last_quick_hash: 'abc123',
      counters: { total_runs: 5, last_run_at: '2026-07-01T09:00:00.000Z' },
    };
    fs.writeFileSync(stateFile, JSON.stringify(existing, null, 2) + '\n');
    const r = await runGrad(stateFile);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('OK\n');
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(after.last_quick_hash).toBe('abc123');
    expect(after.counters.total_runs).toBe(5);
    expect(after.counters.last_run_at).toBe('2026-07-01T09:00:00.000Z');
    expect(typeof after.counters.last_graduation_at).toBe('string');
    expect(after.counters.last_graduation_at).not.toBe(existing.counters.last_run_at);
  }));

  test('a failed write is a real failure: write_failed, exit 1', withTmp(async (stateFile) => {
    fs.mkdirSync(stateFile);
    const r = await runGrad(stateFile);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('{"error":"write_failed"}\n');
  }));
});

// update-reflection-state.ts is reachable through a pre-approved
// `Bash(bun */scripts/update-reflection-state.ts*)` grant that covers every
// argument — the worst-shaped instance of this defect class, since its argv
// is a file path, not a directory (see docs/security.md § Script Argument
// Trust). Containment (assertUnderStateDir), not equality: a caller may
// legitimately pass a file several levels under the pinned root — but the root
// is <hermit>/state, not <hermit>, because every branch reads-with-fallback
// then rewrites whole and would otherwise overwrite operator-owned files.
describe('update-reflection-state: state-dir pin', () => {
  test('refuses a state file belonging to another project', withTmp(async (myStateFile) => {
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflcursor-victim-'));
    fs.mkdirSync(path.join(victimDir, 'state'), { recursive: true });
    const victimFile = path.join(victimDir, 'state', 'reflection-state.json');
    const before = JSON.stringify({ scheduled_checks: { [CHECK_ID]: { last_run: '2020-01-01' } } });
    fs.writeFileSync(victimFile, before);
    try {
      // AGENT_DIR pins hermitDir() to my own project's dir; argv still names the victim file.
      const r = await runScript('update-reflection-state.ts', {
        args: [victimFile, '--scheduled-check-run', CHECK_ID],
        env: { AGENT_DIR: rootOf(myStateFile), HERMIT_NOW: NOW },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
      expect(fs.readFileSync(victimFile, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(victimDir, { recursive: true, force: true });
    }
  }));

  // Containment against the hermit root alone was not enough: every write path
  // here parses with a fallback to {} and then rewrites the file whole, so an
  // in-project but non-state target is destroyed, not merged into.
  test('refuses an in-project file outside state/ (OPERATOR.md is not a counters blob)', withTmp(async (myStateFile) => {
    const root = rootOf(myStateFile);
    const operatorMd = path.join(root, 'OPERATOR.md');
    const before = '# Operator\n\nHand-curated context.\n';
    fs.writeFileSync(operatorMd, before);
    const r = await runScript('update-reflection-state.ts', {
      args: [operatorMd, JSON.stringify({ ran_with_candidates: false })],
      env: { AGENT_DIR: root, HERMIT_NOW: NOW },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
    expect(fs.readFileSync(operatorMd, 'utf-8')).toBe(before);
  }));
});
