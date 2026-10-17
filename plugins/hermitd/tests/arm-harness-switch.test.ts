import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readDeferredSwitch, writeModState, DEFERRED_SWITCH_FILE } from '../scripts/lib/harness-mod';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

const runtime = { runtime_mode: 'headless', tmux_session: 'hermit-test' };
function seed(dir: string, value = runtime): string {
  const root = path.join(dir, '.hermit');
  fs.writeFileSync(path.join(root, 'state/runtime.json'), JSON.stringify(value));
  return root;
}

for (const args of [['--model', 'sonnet', '--effort', 'low'], ['--model', 'future-model'], ['--effort', 'low']]) {
  test(`arms ${args.join(' ')}, replacing the singleton`, withDir(async (dir) => {
    const root = seed(dir);
    writeModState(root, DEFERRED_SWITCH_FILE, { commands: [{ command: '/model', arg: 'old' }], by: 'old', requested_at: new Date().toISOString() });
    const result = await runScript('arm-harness-switch.ts', { cwd: dir, args: [root, ...args] });
    expect(result.exitCode).toBe(0);
    const pending = readDeferredSwitch(root)!;
    expect(pending.by).toBe('terminal');
    expect(pending.commands[0].command).toBe(args[0] === '--model' ? '/model' : '/effort');
    expect(pending.commands[0].arg).toBe(args[1]);
    expect(pending.commands.slice(1)).toEqual(args.length === 4 ? [{ command: '/effort', arg: 'low' }] : []);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'armed', commands: pending.commands.map(c => `${c.command} ${c.arg}`) });
  }));
}

for (const [label, value, args, error] of [
  ['bad arg', runtime, ['--model', 'sonnet\n/clear'], 'invalid_argument'],
  ['missing flags', runtime, [], 'missing_model_or_effort'],
  ['missing value', runtime, ['--model'], 'invalid_argument'],
  ['unknown flag', runtime, ['--other', 'low'], 'invalid_flag'],
  ['missing runtime', null, ['--model', 'sonnet'], 'no_runtime'],
] as const) {
  test(`refuses ${label}`, withDir(async (dir) => {
    const root = value ? seed(dir, value) : path.join(dir, '.hermit');
    const result = await runScript('arm-harness-switch.ts', { cwd: dir, args: [root, ...args] });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error });
    expect(readDeferredSwitch(root)).toBeNull();
  }));
}

for (const value of [{ runtime_mode: 'interactive', tmux_session: '' }, { runtime_mode: 'headless', tmux_session: '' }]) {
  test(`arms without a pane in ${value.runtime_mode}`, withDir(async dir => {
    const root = seed(dir, value);
    const result = await runScript('arm-harness-switch.ts', { cwd: dir, args: [root, '--effort', 'low'] });
    expect(result.exitCode).toBe(0);
    expect(readDeferredSwitch(root)?.commands).toEqual([{ command: '/effort', arg: 'low' }]);
  }));
}
