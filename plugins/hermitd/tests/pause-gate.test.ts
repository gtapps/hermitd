// Contract tests for scripts/pause-gate.ts — the PreToolUse binding pause gate
// (PROP-015). Exercised as a subprocess (stdin in, exit code out), the same
// boundary Claude Code sees. Probe-verified deny mechanics:
// compiled/spike-channel-stop-probe-2026-07-03.md.
//
// Usage: bun test tests/pause-gate.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

function setPauseFile(dir: string, over: Partial<Record<string, unknown>> = {}) {
  write(hermit(dir, 'state', 'pause.json'), JSON.stringify({
    paused: true,
    paused_until: null,
    reason: 'operator',
    by: 'test',
    ts: '2026-01-01T00:00:00.000Z',
    ...over,
  }));
}

const run = (payload: object, dir: string) =>
  runScript('pause-gate.ts', { stdin: JSON.stringify(payload), cwd: dir });

describe('pause-gate', () => {
  test('unpaused (no pause.json) — allow any tool', withDir(async (dir) => {
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('paused (indefinite) — Bash denied with exit 2 and a reason on stderr', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('paused');
    expect(r.stderr).toContain('operator');
  }));

  test('paused — Edit denied', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'Edit', tool_input: { file_path: 'foo.ts' } }, dir);
    expect(r.exitCode).toBe(2);
  }));

  test('paused — arbitrary MCP tool denied', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'mcp__some_server__do_thing', tool_input: {} }, dir);
    expect(r.exitCode).toBe(2);
  }));

  test('paused — a channel reply tool is exempt (discord)', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'mcp__plugin_discord_discord__reply', tool_input: {} }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('paused — a channel reply tool is exempt (telegram)', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: {} }, dir);
    expect(r.exitCode).toBe(0);
  }));

  // The reply tool surfaces in several shapes across CC versions (see
  // channel-hook.ts) — all must stay exempt so a paused hermit can answer.
  test('paused — reply tool exempt in the short mcp__<source>__reply shape', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'mcp__discord__reply', tool_input: {} }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('paused — reply tool exempt in the plugin_<source>_<source>_reply shape', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'plugin_telegram_telegram_reply', tool_input: {} }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('paused — PushNotification is exempt', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'PushNotification', tool_input: {} }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('paused — a non-reply mcp__plugin_*__ tool is still denied', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_name: 'mcp__plugin_discord_discord__send_file', tool_input: {} }, dir);
    expect(r.exitCode).toBe(2);
  }));

  test('expired snooze (paused_until in the past) — allow', withDir(async (dir) => {
    setPauseFile(dir, { paused_until: '2000-01-01T00:00:00.000Z' });
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('future snooze (paused_until ahead) — deny, reason includes the timestamp', withDir(async (dir) => {
    setPauseFile(dir, { paused_until: '2999-01-01T00:00:00.000Z' });
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('2999-01-01T00:00:00.000Z');
  }));

  test('corrupt pause.json — fail-open, allow', withDir(async (dir) => {
    write(hermit(dir, 'state', 'pause.json'), '{not json');
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, dir);
    expect(r.exitCode).toBe(0);
  }));

  test('empty stdin — fail-open, allow', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await runScript('pause-gate.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('malformed JSON stdin — fail-open, allow', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await runScript('pause-gate.ts', { stdin: '{broken', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('missing tool_name — fail-open, allow', withDir(async (dir) => {
    setPauseFile(dir);
    const r = await run({ tool_input: { command: 'ls' } }, dir);
    expect(r.exitCode).toBe(0);
  }));

  // Stdin over the 1MB cap (lib/hook-input.ts MAX_HOOK_STDIN) can't be parsed
  // for tool_name, but the exempt tools are never ~1MB — so a paused hermit
  // fails CLOSED here (exit 2) rather than letting a large payload slip past.
  test('stdin over the 1MB cap while paused — fail-closed, deny', withDir(async (dir) => {
    setPauseFile(dir);
    const padding = 'a'.repeat(1.5 * 1024 * 1024);
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls', padding } }, dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('paused');
  }));

  // The fail-closed path is gated on the pause flag — unpaused, an oversize
  // payload still fails open (allow), same as any other stdin the gate ignores.
  test('stdin over the 1MB cap while unpaused — fail-open, allow', withDir(async (dir) => {
    const padding = 'a'.repeat(1.5 * 1024 * 1024);
    const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls', padding } }, dir);
    expect(r.exitCode).toBe(0);
  }));
});


test('paused configured third-party replies are exempt and unconfigured replies denied', withDir(async (dir) => {
  setPauseFile(dir);
  write(hermit(dir, 'config.json'), JSON.stringify({ channels: { 'slack-channel': {} } }));
  for (const tool_name of ['mcp__plugin_slack_slack-channel__reply', 'mcp__plugin_slack_slack_channel__reply']) {
    expect((await run({ tool_name }, dir)).exitCode).toBe(0);
  }
  expect((await run({ tool_name: 'mcp__claude_ai_Gmail__reply' }, dir)).exitCode).toBe(2);
}));

test('paused built-in replies stay exempt with only a third-party channel configured', withDir(async (dir) => {
  setPauseFile(dir);
  write(hermit(dir, 'config.json'), JSON.stringify({ channels: { 'slack-channel': {} } }));
  for (const tool_name of ['mcp__discord__reply', 'mcp__plugin_telegram_telegram__reply']) {
    expect((await run({ tool_name }, dir)).exitCode).toBe(0);
  }
}));
