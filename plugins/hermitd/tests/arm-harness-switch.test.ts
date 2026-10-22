import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { QUEUE_DIR, QUEUE_PROTOCOL } from '../scripts/lib/harness-mod';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

const runtime = { runtime_mode: 'headless', tmux_session: 'hermit-test', cc_session_id: 'resident' };
function seed(dir: string, value: object = runtime, loaded = 'resident'): string {
  const root = path.join(dir, '.hermit');
  fs.writeFileSync(path.join(root, 'state/runtime.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(root, 'state/harness-mod-loaded.json'), JSON.stringify({ session_id: loaded, queue: QUEUE_PROTOCOL }));
  return root;
}
function queued(root: string) {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(root, 'state', QUEUE_DIR)); } catch {}
  return names.map(name => JSON.parse(fs.readFileSync(path.join(root, 'state', QUEUE_DIR, name), 'utf8')));
}

for (const args of [['--model', 'sonnet', '--effort', 'low'], ['--model', 'future-model'], ['--effort', 'low']]) {
  test(`queues ${args.join(' ')} from the terminal`, withDir(async (dir) => {
    const root = seed(dir);
    const result = await runScript('arm-harness-switch.ts', { cwd: dir, args: [root, ...args] });
    expect(result.exitCode).toBe(0);
    const [entry] = queued(root);
    expect(entry).toMatchObject({ source: 'terminal', by: 'terminal', session_id: 'resident' });
    expect(entry.commands[0].command).toBe(args[0] === '--model' ? '/model' : '/effort');
    expect(entry.commands[0].arg).toBe(args[1]);
    expect(entry.commands.slice(1)).toEqual(args.length === 4 ? [{ command: '/effort', arg: 'low' }] : []);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'armed', commands: entry.commands.map((c: { command: string; arg: string }) => `${c.command} ${c.arg}`) });
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
    expect(queued(root)).toEqual([]);
  }));
}

test('reports a skip when the mod has not loaded for the resident session', withDir(async dir => {
  const root = seed(dir, runtime, 'old');
  const result = await runScript('arm-harness-switch.ts', { cwd: dir, args: [root, '--effort', 'low'] });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'skipped', reason: 'mod_not_loaded' });
  expect(queued(root)).toEqual([]);
}));

for (const value of [{ ...runtime, runtime_mode: 'interactive', tmux_session: '' }, { ...runtime, tmux_session: '' }]) {
  test(`queues without a pane in ${value.runtime_mode}`, withDir(async dir => {
    const root = seed(dir, value);
    const result = await runScript('arm-harness-switch.ts', { cwd: dir, args: [root, '--effort', 'low'] });
    expect(result.exitCode).toBe(0);
    expect(queued(root)[0].commands).toEqual([{ command: '/effort', arg: 'low' }]);
  }));
}
