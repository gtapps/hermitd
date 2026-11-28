import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { INFLIGHT_DIR, QUEUE_PROTOCOL } from '../scripts/lib/harness-mod';
import * as gate from '../scripts/model-switch-gate';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('model-switch-');
afterAll(cleanup);
const model = { command: '/model', arg: 'sonnet' };
const clear = { command: '/clear', arg: null };
const effort = { command: '/effort', arg: 'high' };

test('hook reads the queue protocol and folder used by the bridge', () => {
  expect(gate.INFLIGHT_DIR).toBe(INFLIGHT_DIR);
  expect(gate.QUEUE_PROTOCOL).toBe(QUEUE_PROTOCOL);
});

for (const [label, options, allow] of [
  ['current leg', {}, true],
  ['second current leg', { commands: [clear, model], legs: [clear] }, true],
  ['finished model leg', { commands: [model, effort], legs: [model] }, false],
  ['future model leg', { commands: [clear, model] }, false],
  ['old queue session', { entryId: 'previous' }, true],
  ['stale runtime', { runtime: 'previous' }, false],
  ['guest', { id: 'guest' }, false],
  ['old protocol', { queue: 0 }, false],
  ['wrong source', { source: 'startup' }, false],
  ['wrong target', { target: 'opus' }, false],
  ['missing runtime', { runtime: '' }, false],
  ['malformed entry', { malformed: true }, false],
] as const) {
  test(label, async () => {
    const o = { commands: [model], legs: [], entryId: 'resident', runtime: 'resident', id: 'resident',
      queue: QUEUE_PROTOCOL, source: 'command', target: 'sonnet', malformed: false, ...options };
    const cwd = freshDir();
    const dir = path.join(cwd, '.hermit');
    const state = path.join(dir, 'state');
    fs.mkdirSync(path.join(state, INFLIGHT_DIR), { recursive: true });
    if (o.runtime) fs.writeFileSync(path.join(state, 'runtime.json'), JSON.stringify({ cc_session_id: o.runtime }));
    fs.writeFileSync(path.join(state, 'harness-mod-loaded.json'), JSON.stringify({ session_id: 'resident', queue: o.queue }));
    const file = path.join(state, INFLIGHT_DIR, 'request.json');
    const entry = o.malformed ? '{' : JSON.stringify({ session_id: o.entryId, commands: o.commands, legs: o.legs });
    fs.writeFileSync(file, entry);
    const r = await runScript('model-switch-gate.ts', { cwd, env: { AGENT_DIR: dir },
      stdin: JSON.stringify({ source: o.source, session_id: o.id, requested_model: o.target }) });
    expect(r.exitCode).toBe(0);
    if (allow) expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' } });
    else expect(r.stdout).toBe('');
    expect(fs.readFileSync(file, 'utf8')).toBe(entry);
  });
}
