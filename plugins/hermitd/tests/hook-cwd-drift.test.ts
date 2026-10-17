// Regression tests for #384 — hook cwd-drift bug class.
//
// Each test simulates the exact failure mode: hook fires with cwd pinned inside
// .hermit/ (the paulinho field-report trigger). Before the fix,
// validate-config would read .hermit/.hermit/config.json
// (ENOENT → exit 2). The others would silently write to wrong paths.
//
// Env discipline: opts.env overrides process.env in run.ts (spread order is
// { ...process.env, ...opts.env }), so setting a key here wins over the ambient
// CC session value. To force walk-up (branch 3 of hermitDir), we point
// CLAUDE_PROJECT_DIR at a nonexistent path and AGENT_DIR to a relative value.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';

// -------------------------------------------------------------------------
// Fixture
// -------------------------------------------------------------------------

let tmpRoot: string;       // project root — contains .hermit/
let hermitDir: string;     // tmpRoot/.hermit
let driftedCwd: string;    // tmpRoot/.hermit/state  (the bug's cwd)

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
  hermitDir = path.join(tmpRoot, '.hermit');
  driftedCwd = path.join(hermitDir, 'state');
  fs.mkdirSync(driftedCwd, { recursive: true });
  // Minimal config.json
  fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({
    agent_name: null, language: null, timezone: null,
    escalation: 'conservative', channels: {}, env: {},
    heartbeat: { enabled: false }, routines: [], quality_gate: { tier: 'balanced' },
  }));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Force hermitDir() walk-up branch: CLAUDE_PROJECT_DIR nonexistent, AGENT_DIR relative
function driftEnv(): Record<string, string> {
  return {
    AGENT_DIR: '.hermit',           // relative — ignored by hermitDir()
    CLAUDE_PROJECT_DIR: '/nonexistent-path',    // existsSync fails — falls to walk-up
  };
}

// -------------------------------------------------------------------------
// Tier 1: validate-config (the reported bug)
// -------------------------------------------------------------------------

// The second test overwrites (and restores) the shared hermitDir/config.json
// fixture in-place — a mutation of tmpRoot, not just a read — which the first
// test also reads via an absolute path. Empirically confirmed (bun 1.3.14 & 1.4.0):
// describe.serial does not reliably force sequential execution of its own
// child tests under --concurrent — per-test .serial marking does.
describe('validate-config with drifted cwd (#384 regression)', () => {
  it.serial('exits 0 for valid config when cwd is inside .hermit/', async () => {
    // Before fix: readFileSync(path.resolve('.hermit/config.json')) from
    // driftedCwd = .../state → read .../state/.hermit/config.json → ENOENT → exit 2
    // After fix: reads filePath (absolute from payload) directly → exit 0
    const payload = JSON.stringify({
      tool: 'Edit',
      tool_input: { file_path: path.join(hermitDir, 'config.json') },
    });
    const result = await runScript('validate-config.ts', {
      stdin: payload,
      cwd: driftedCwd,    // drifted: inside .hermit/state
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('[config-validate] OK');
  });

  it.serial('still exits 2 for invalid config (double-path fix does not break validation)', async () => {
    const badConfig = JSON.stringify({ escalation: 'bad-value', channels: {}, env: {}, heartbeat: {}, routines: [], quality_gate: {} });
    const badConfigPath = path.join(hermitDir, 'config-bad.json');
    fs.writeFileSync(badConfigPath, badConfig);
    const payload = JSON.stringify({
      tool: 'Edit',
      // Spoof basename as config.json so the basename gate passes
      tool_input: { file_path: path.join(path.dirname(badConfigPath), 'config.json') },
    });
    // Write bad config to the path the hook will read
    fs.writeFileSync(path.join(hermitDir, 'config.json'), badConfig);
    try {
      const result = await runScript('validate-config.ts', {
        stdin: payload,
        cwd: driftedCwd,
      });
      expect(result.exitCode).toBe(2);
    } finally {
      // Restore valid config
      fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({
        agent_name: null, language: null, timezone: null,
        escalation: 'conservative', channels: {}, env: {},
        heartbeat: { enabled: false }, routines: [], quality_gate: { tier: 'balanced' },
      }));
    }
  });
});

// -------------------------------------------------------------------------
// Tier 2: record-operator-action (payload-less hook, uses hermitDir)
// -------------------------------------------------------------------------

describe('record-operator-action with drifted cwd', () => {
  it('writes last-operator-action.json to the correct hermit dir via walk-up', async () => {
    const statePath = path.join(hermitDir, 'state', 'last-operator-action.json');
    // Remove if exists from a previous run
    try { fs.unlinkSync(statePath); } catch {}

    const payload = JSON.stringify({ prompt: 'hello' });
    const result = await runScript('record-operator-action.ts', {
      stdin: payload,
      cwd: driftedCwd,
      env: driftEnv(),   // force walk-up: no absolute AGENT_DIR, no valid CLAUDE_PROJECT_DIR
    });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(statePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(typeof written.at).toBe('string');

    // Sanity: confirm the wrong doubled path was NOT created
    const wrongPath = path.join(driftedCwd, '.hermit', 'state', 'last-operator-action.json');
    expect(fs.existsSync(wrongPath)).toBe(false);
  });

  it('--force writes the marker and prints OK', async () => {
    const statePath = path.join(hermitDir, 'state', 'last-operator-action.json');
    try { fs.unlinkSync(statePath); } catch {}
    const result = await runScript('record-operator-action.ts', { args: ['--force'], cwd: driftedCwd, env: driftEnv() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('OK\n');
    expect(fs.existsSync(statePath)).toBe(true);
  });
});

// -------------------------------------------------------------------------
// Tier 2: generate-summary (has file_path — anchors on payload)
// -------------------------------------------------------------------------

describe('generate-summary with drifted cwd', () => {
  it('regenerates state-summary.md in the correct state dir from absolute filePath', async () => {
    // Seed the state files generate-summary reads
    const stateDir = path.join(hermitDir, 'state');
    fs.writeFileSync(path.join(stateDir, 'alert-state.json'), JSON.stringify({}));

    const editedFile = path.join(stateDir, 'alert-state.json');
    const payload = JSON.stringify({
      tool: 'Edit',
      tool_input: { file_path: editedFile },
    });

    const summaryPath = path.join(stateDir, 'state-summary.md');
    // Remove if exists from a previous run
    try { fs.unlinkSync(summaryPath); } catch {}

    const result = await runScript('generate-summary.ts', {
      stdin: payload,
      cwd: driftedCwd,
    });

    expect(result.exitCode).toBe(0);
    // Confirm it wrote to the correct absolute path (not doubled)
    expect(fs.existsSync(summaryPath)).toBe(true);

    const wrongSummary = path.join(driftedCwd, '.hermit', 'state', 'state-summary.md');
    expect(fs.existsSync(wrongSummary)).toBe(false);
  });
});
