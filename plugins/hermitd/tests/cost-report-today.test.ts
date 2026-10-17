// Tests for cost-report.ts's today verb: today's spend summary from cost-log.jsonl.
// Cost-path resolution must be anchored to the hermit root, not process.cwd() —
// the calling shell (brief, invoked inline in main) persists cd across calls,
// so a drifted cwd must not silently misreport a zero.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';

function withTmpdir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-today-cost-'));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  };
}

function seedCostLog(dir: string, entries: object[]): void {
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const logPath = path.join(claudeDir, 'cost-log.jsonl');
  fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function seedHermitRoot(dir: string): void {
  const hermitDir = path.join(dir, '.hermit');
  // state/ alongside config.json is what marks a real root: config.json on its
  // own is the worktree-projection shape, which the resolver walks past.
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(hermitDir, 'config.json'), '{}');
}

// Explicit env per case: runScript merges process.env into the child, so an
// ambient CLAUDE_PROJECT_DIR/AGENT_DIR would otherwise leak in and resolve
// against this repo's real .hermit/ instead of the fixture.
function baseEnv(projectDir: string) {
  return { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: projectDir, AGENT_DIR: '' };
}

const today = new Date().toISOString().slice(0, 10);

describe('cost-report.ts today', () => {
  test('drift regression: reports the real total when cwd has drifted into a subdir', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: `${today}T10:00:00Z`, session_id: 'S-001', estimated_cost_usd: 14.91, total_tokens: 28500000, source: 'other' },
    ]);
    seedHermitRoot(dir);
    const drifted = path.join(dir, '.hermit', 'proposals');
    fs.mkdirSync(drifted, { recursive: true });

    const r = await runScript('cost-report.ts', { args: ['today'], cwd: drifted, env: baseEnv(dir) });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 14.91, tokens: 28500000, sessions: 1 });
  }));

  test('drift regression: walk-up anchor resolves without CLAUDE_PROJECT_DIR set', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: `${today}T10:00:00Z`, session_id: 'S-001', estimated_cost_usd: 1.5, total_tokens: 1000, source: 'other' },
    ]);
    seedHermitRoot(dir);
    const drifted = path.join(dir, '.hermit', 'proposals');
    fs.mkdirSync(drifted, { recursive: true });

    const r = await runScript('cost-report.ts', { args: ['today'],
      cwd: drifted,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: '', AGENT_DIR: '' },
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 1.5, tokens: 1000, sessions: 1 });
  }));

  test('unavailable: cost log absent', withTmpdir(async (dir) => {
    seedHermitRoot(dir);
    const r = await runScript('cost-report.ts', { args: ['today'], cwd: dir, env: baseEnv(dir) });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'unavailable', reason: 'cost_log_unreadable' });
  }));

  test('unavailable: cost log path is a directory (non-ENOENT read failure)', withTmpdir(async (dir) => {
    seedHermitRoot(dir);
    fs.mkdirSync(path.join(dir, '.claude', 'cost-log.jsonl'), { recursive: true });
    const r = await runScript('cost-report.ts', { args: ['today'], cwd: dir, env: baseEnv(dir) });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'unavailable', reason: 'cost_log_unreadable' });
  }));

  test('honest zero: log present but no rows dated today', withTmpdir(async (dir) => {
    seedCostLog(dir, [
      { timestamp: '2020-01-01T10:00:00Z', session_id: 'S-001', estimated_cost_usd: 5, total_tokens: 5000, source: 'other' },
    ]);
    seedHermitRoot(dir);
    const r = await runScript('cost-report.ts', { args: ['today'], cwd: dir, env: baseEnv(dir) });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ cost_usd: 0, tokens: 0, sessions: 0 });
  }));
});
