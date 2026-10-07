// Behavioral tests for opaque MCP tools — calls that reach the gate with no
// resolvable entity_id and no targeting selector (the canonical case is a
// script-derived tool like mcp__homeassistant__unlock_front, which carries
// only its own fields). These behaviors are NEW relative to the retired Python
// gate, so they live here rather than in the byte-equivalence corpus: the
// corpus divergence channel asserts py.stdout === ts.stdout, which can't
// represent "TS emits an ask decision while Python blocks".
//
// Contract:
//   strict -> block (exit 2), becomes a proposal
//   ask    -> prompt (exit 0 + permissionDecision "ask")
// Read-only tools (GetLiveContext/GetDateTime) allow in BOTH modes.
// The unresolvable-selector fan-out invariant still hard-blocks in BOTH modes.
// Hass* intent tools (name/area targeting) hard-block unless ha_assist_control_enabled.

import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';

import { cleanEnv, cleanupTmp, makeHaConfig, makeHaConfigWith, tmpPath } from './helpers';

const MCP_HOOK = join(import.meta.dir, '..', 'hooks', 'mcp-safety-gate.ts');

afterAll(cleanupTmp);

function runGate(stdin: string, mode?: string, cwd?: string) {
  const effectiveCwd = cwd ?? (mode !== undefined ? makeHaConfig(mode) : tmpPath());
  const r = Bun.spawnSync([process.execPath, MCP_HOOK], {
    cwd: effectiveCwd,
    env: cleanEnv(),
    stdin: Buffer.from(stdin, 'utf8'),
    timeout: 10_000,
  });
  return { exit: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const SCRIPT_TOOL = JSON.stringify({
  tool_name: 'mcp__homeassistant__unlock_front',
  tool_input: {},
});

test('opaque script tool blocks under strict', () => {
  const r = runGate(SCRIPT_TOOL, 'strict');
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
  expect(r.stderr).not.toBe('');
});

test('opaque script tool blocks when mode is absent (defaults strict)', () => {
  const r = runGate(SCRIPT_TOOL);
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

test('opaque script tool prompts under ask', () => {
  const r = runGate(SCRIPT_TOOL, 'ask');
  expect(r.exit).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
    'mcp__homeassistant__unlock_front',
  );
});

// Bare names (older HA) and HA 2026.9+ domain-prefixed names.
const READ_ONLY_NAMES = [
  'GetLiveContext',
  'GetDateTime',
  'homeassistant__GetLiveContext',
  'llm__GetDateTime',
];
const HASS_INTENT_NAMES = ['HassTurnOff', 'intent__HassTurnOff', 'light__HassLightSet'];

test('read-only tools allow in both modes', () => {
  for (const mode of ['strict', 'ask']) {
    for (const name of READ_ONLY_NAMES) {
      const r = runGate(
        JSON.stringify({ tool_name: `mcp__homeassistant__${name}`, tool_input: {} }),
        mode,
      );
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    }
  }
});

test('unresolvable area_id selector hard-blocks even under ask', () => {
  const r = runGate(JSON.stringify({ tool_input: { area_id: 'kitchen' } }), 'ask');
  expect(r.exit).toBe(2);
  expect(r.stdout).toBe('');
});

// Without ha_assist_control_enabled, Hass* intent tools that target by name/area
// cannot be enumerated at the gate, so they hard-block in every safety mode.
// With ha_assist_control_enabled, HA's own expose-to-Assist gate is the control
// boundary — see the following test.
test('Hass* intent tool with name/area target hard-blocks even under ask (assist control disabled)', () => {
  for (const name of HASS_INTENT_NAMES) {
    for (const input of [{ name: 'front gate' }, { area: 'garage' }]) {
      const r = runGate(
        JSON.stringify({ tool_name: `mcp__homeassistant__${name}`, tool_input: input }),
        'ask',
      );
      expect(r.exit).toBe(2);
      expect(r.stdout).toBe('');
    }
  }
});

test('Hass* intent tool with name/area target allows when assist control is enabled', () => {
  const cwd = makeHaConfigWith('ask', { ha_assist_control_enabled: true });
  for (const name of HASS_INTENT_NAMES) {
    for (const input of [{ name: 'front gate' }, { area: 'garage' }]) {
      const r = runGate(
        JSON.stringify({ tool_name: `mcp__homeassistant__${name}`, tool_input: input }),
        undefined,
        cwd,
      );
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe('');
    }
  }
});

// The read-only allowlist is exact names, not a suffix match: any other prefix
// in front of a read-only name (including the multi-API `assist__` namespace)
// stays an opaque tool, blocked under strict and prompted under ask.
test('prefixed lookalikes of read-only tools are not allowlisted', () => {
  for (const name of [
    'evil__GetDateTime',
    'script__GetLiveContext',
    'assist__homeassistant__GetLiveContext',
  ]) {
    const stdin = JSON.stringify({ tool_name: `mcp__homeassistant__${name}`, tool_input: {} });
    const strict = runGate(stdin, 'strict');
    expect(strict.exit).toBe(2);
    expect(strict.stdout).toBe('');
    const ask = runGate(stdin, 'ask');
    expect(ask.exit).toBe(0);
    expect(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
  }
});

test('a prefixed script tool is not treated as a Hass* intent under assist control', () => {
  const cwd = makeHaConfigWith('ask', { ha_assist_control_enabled: true });
  const r = runGate(
    JSON.stringify({ tool_name: 'mcp__homeassistant__script__hass_lights', tool_input: {} }),
    undefined,
    cwd,
  );
  expect(r.exit).toBe(0);
  expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
});
