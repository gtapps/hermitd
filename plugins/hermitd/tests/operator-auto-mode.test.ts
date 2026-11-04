import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { generatedAutoMode, mergeOperatorAutoMode } from '../scripts/lib/settings/operator-auto-mode';
import { runScript } from './helpers/run';
import { withDir, writeConfig } from './helpers/workdir';

function fakeClaude(dir: string, body: string): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  return runScript('operator-auto-mode.ts', {
    cwd: dir, args, env: { CLAUDE_CONFIG_DIR: path.join(dir, 'user-config'), ...env },
  });
}

const critique = (text: string) => ['critique', '--list', 'allow', '--text', text];

test('critique uses the launch composition plus candidate, and leaves stores unchanged', withDir(async (dir) => {
  const bin = fakeClaude(dir, `
    const fs = require('node:fs');
    const p = process.argv[process.argv.indexOf('--settings') + 1];
    fs.copyFileSync(p, 'captured-settings.json');
    console.log(p);
  `);
  const config = { watchdog: { enabled: true } };
  const operator = { allow: ['$defaults', 'rule A'], classifyAllShell: true };
  writeConfig(dir, config);
  const settings = path.join(dir, '.hermit/claude-settings.json');
  const runtime = path.join(dir, '.hermit/state/runtime.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet', autoMode: operator }));
  fs.writeFileSync(runtime, '{"runtime_mode":"tmux"}');
  const before = [fs.readFileSync(settings, 'utf8'), fs.readFileSync(runtime, 'utf8')];
  const env = { PATH: bin, CLAUDE_CONFIG_DIR: path.join(dir, 'user-config') };
  const result = await run(dir, critique('rule B'), env);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({ status: 'checked', list: 'allow', text: 'rule B' });
  const captured = JSON.parse(fs.readFileSync(path.join(dir, 'captured-settings.json'), 'utf8'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  try {
    const expected = mergeOperatorAutoMode(generatedAutoMode(config), operator).autoMode;
    expected.allow = [...(expected.allow as string[]), 'rule B'];
    expect(captured).toEqual({ autoMode: expected });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
  expect(fs.existsSync(output.critique)).toBe(false);
  expect([fs.readFileSync(settings, 'utf8'), fs.readFileSync(runtime, 'utf8')]).toEqual(before);
}));

test('unique scratch paths are removed on success and CLI errors', withDir(async (dir) => {
  const bin = fakeClaude(dir, `
    const fs = require('node:fs');
    const p = process.argv[process.argv.indexOf('--settings') + 1];
    fs.appendFileSync('paths', p + '\\n');
    process.exit(process.env.FAIL === '1' ? 2 : 0);
  `);
  const results = await Promise.all([
    run(dir, critique('first'), { PATH: bin }),
    run(dir, critique('second'), { PATH: bin, FAIL: '1' }),
  ]);
  expect(results.map((result) => JSON.parse(result.stdout).status).sort()).toEqual(['checked', 'unchecked']);
  const paths = fs.readFileSync(path.join(dir, 'paths'), 'utf8').trim().split('\n');
  expect(new Set(paths).size).toBe(2);
  expect(paths.every((p) => !fs.existsSync(p))).toBe(true);
}));

test('timeout and missing executable are unchecked and clean up scratch', withDir(async (dir) => {
  const bin = fakeClaude(dir, 'setInterval(() => {}, 1000);');
  const timeout = await run(dir, critique('rule'), { PATH: bin, HERMIT_AUTO_MODE_CRITIQUE_TIMEOUT_MS: '100' });
  expect(JSON.parse(timeout.stdout)).toEqual({ status: 'unchecked', reason: 'timeout' });
  const missing = await run(dir, critique('rule'), { PATH: path.join(dir, 'no-bin') });
  expect(JSON.parse(missing.stdout)).toEqual({ status: 'unchecked', reason: 'claude_missing' });
  expect(fs.readdirSync(path.join(dir, '.hermit/state'))).toEqual([]);
}));

test('check validates lists and reports activation gate', withDir(async (dir) => {
  const settings = path.join(dir, '.hermit/claude-settings.json');
  const runtime = path.join(dir, '.hermit/state/runtime.json');
  fs.writeFileSync(settings, '{broken');
  expect(JSON.parse((await run(dir, ['check'])).stdout)).toEqual({ status: 'invalid', reason: 'settings:malformed_json' });
  fs.writeFileSync(settings, '{"autoMode":{"allow":42}}');
  expect(JSON.parse((await run(dir, ['check'])).stdout)).toEqual({ status: 'invalid', reason: 'allow:not_string_array' });
  fs.writeFileSync(settings, '{"autoMode":{"allow":["rule"]}}');
  writeConfig(dir, { watchdog: { enabled: true } });
  fs.writeFileSync(runtime, '{"runtime_mode":"interactive"}');
  expect(JSON.parse((await run(dir, ['check'])).stdout).applies).toBe('next_start');
  fs.writeFileSync(runtime, '{"runtime_mode":"tmux"}');
  writeConfig(dir, { watchdog: { enabled: false } });
  expect(JSON.parse((await run(dir, ['check'])).stdout).applies).toBe('next_start');
  writeConfig(dir, { watchdog: { enabled: true } });
  expect(JSON.parse((await run(dir, ['check'])).stdout).applies).toBe('quiet_restart');
  expect(fs.readFileSync(settings, 'utf8')).toBe('{"autoMode":{"allow":["rule"]}}');
}));

test('bad arguments exit with an error object', withDir(async (dir) => {
  const result = await run(dir, ['critique', '--list', 'bad', '--text', 'rule']);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ error: 'invalid_arguments' });
}));
