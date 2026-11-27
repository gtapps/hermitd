import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import * as turnState from '../scripts/lib/turn-state';
import { runScript } from './helpers/run';
import { markGuest } from '../scripts/lib/guest-marker';

for (const prompt of ['Hello', 'ROUTINE_DUE test', 'HEARTBEAT_EVALUATE', '[peer] progress', '<channel source="discord" chat_id="c1" user="u1">Please work</channel>']) it(`admitted ${prompt} writes in_flight`, async () => {
  const f = taskFixture(); try {
    f.put('config.json', { channels: { discord: { enabled: true, default_chat_id: 'c1', allowed_users: ['u1'] } } });
    f.put('state/runtime.json', { hermit_pid: process.pid });
    const r = await runScript('user-prompt-pipeline.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir }, stdin: JSON.stringify({ prompt, session_id: 'resident', hook_event_name: 'UserPromptSubmit' }) });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(f.dir, 'state/execution.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/execution.json'), 'utf8')).state).toBe('in_flight');
  } finally { f.cleanup(); }
});
for (const [script, event, state, extra] of [
  ['stop-pipeline.ts', 'Stop', 'idle', {}], ['stop-failure-stamp.ts', 'StopFailure', 'idle', { error: 'api_error' }],
  ['precompact-stamp.ts', 'PreCompact', 'idle', { trigger: 'manual' }],
  ['precompact-stamp.ts', 'PreCompact', 'unknown', { trigger: 'auto' }],
  ...['startup', 'resume', 'clear'].map(source => ['startup-context.ts', 'SessionStart', source === 'clear' ? 'idle' : 'unknown', { source }]),
  ['startup-context.ts', 'SessionStart', 'unknown', {}],
] as [string, string, string, object][]) {
  it(`${event} ${JSON.stringify(extra)} writes ${state}`, async () => { const f = taskFixture(); try {
    const r = await runScript(script, { cwd: f.dir, env: { AGENT_DIR: f.dir, HERMIT_RESIDENT: '1' }, stdin: JSON.stringify({ hook_event_name: event, session_id: 'resident', ...extra }) });
    expect(r.exitCode).toBe(0); expect(fs.existsSync(path.join(f.dir, 'state/execution.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/execution.json'), 'utf8')).state).toBe(state);
  } finally { f.cleanup(); } });
  it(`guest ${event} ${JSON.stringify(extra)} writes nothing`, async () => { const f = taskFixture(); try {
    markGuest(path.join(f.dir, 'state'), 'guest');
    await runScript(script, { cwd: f.dir, env: { AGENT_DIR: f.dir, HERMIT_RESIDENT: '' }, stdin: JSON.stringify({ hook_event_name: event, session_id: 'guest', ...extra }) });
    expect(fs.existsSync(path.join(f.dir, 'state/execution.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.dir, 'state/session-start.json'))).toBe(false);
  } finally { f.cleanup(); } });
}
for (const [trigger, state] of [['manual', 'idle'], ['auto', 'unknown']]) it(`SessionStart compact keeps the ${trigger} PreCompact state`, async () => {
  const f = taskFixture(); try {
    const env = { AGENT_DIR: f.dir, HERMIT_RESIDENT: '1' };
    const precompact = await runScript('precompact-stamp.ts', { cwd: f.dir, env, stdin: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'resident', trigger }) });
    expect(precompact.exitCode).toBe(0);
    const executionPath = path.join(f.dir, 'state/execution.json');
    const before = fs.readFileSync(executionPath, 'utf8');
    expect(JSON.parse(before).state).toBe(state);
    const start = await runScript('startup-context.ts', { cwd: f.dir, env, stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'resident', source: 'compact' }) });
    expect(start.exitCode).toBe(0);
    const after = fs.readFileSync(executionPath, 'utf8');
    if (state === 'unknown') expect(after).toBe(before);
    else expect(JSON.parse(after)).toMatchObject({ state: 'idle', cc_session_id: 'resident', reason: 'resident-start:compact' });
  } finally { f.cleanup(); }
});
it('guest SessionStart compact writes no execution observation', async () => {
  const f = taskFixture(); try {
    markGuest(path.join(f.dir, 'state'), 'guest');
    const r = await runScript('startup-context.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir, HERMIT_RESIDENT: '' }, stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'guest', source: 'compact' }) });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(f.dir, 'state/execution.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.dir, 'state/session-start.json'))).toBe(false);
  } finally { f.cleanup(); }
});
it('resident SessionStart records its source in session-start.json and a later prompt leaves it', async () => { const f = taskFixture(); try {
  f.put('config.json', { channels: {} }); f.put('state/runtime.json', { hermit_pid: process.pid });
  await runScript('startup-context.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir, HERMIT_RESIDENT: '1' }, stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'resident', source: 'compact' }) });
  await runScript('user-prompt-pipeline.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir }, stdin: JSON.stringify({ prompt: 'Hello', session_id: 'resident', hook_event_name: 'UserPromptSubmit' }) });
  expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/execution.json'), 'utf8')).state).toBe('in_flight');
  expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/session-start.json'), 'utf8'))).toMatchObject({ source: 'compact' });
} finally { f.cleanup(); } });
it('blocked guest prompt does not write execution', async () => { const f = taskFixture(); try { markGuest(path.join(f.dir, 'state'), 'guest'); await runScript('user-prompt-pipeline.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir }, stdin: JSON.stringify({ session_id: 'guest', prompt: '<channel source="discord" chat_id="c1" user="u1">Hello</channel>' }) }); expect(fs.existsSync(path.join(f.dir, 'state/execution.json'))).toBe(false); } finally { f.cleanup(); } });
it('old in_flight and malformed observations read unknown', async () => { const f = taskFixture(); try { f.put('state/execution.json', { state: 'in_flight', at: '2020-01-01T00:00:00Z' }); expect(turnState.readExecution(f.dir).state).toBe('unknown'); fs.writeFileSync(path.join(f.dir, 'state/execution.json'), '{'); expect(turnState.readExecution(f.dir).state).toBe('unknown'); } finally { f.cleanup(); } });

it('a compaction keeps the source only of a tracked running turn', async () => {
  const f = taskFixture(); try {
    const { turnStarted, compacted, turnEnded, readExecution } = turnState;
    turnStarted(f.dir, 's', 'upgrade');
    compacted(f.dir, 's', false);
    expect(readExecution(f.dir).source).toBe('upgrade');
    compacted(f.dir, 's', false);
    expect(readExecution(f.dir).source).toBe('upgrade');
    turnEnded(f.dir, { cause: 'stop', session: 's', backgroundTasks: [] });
    expect(readExecution(f.dir).source).toBe('upgrade');
    // A turn that never stamped in_flight compacts without taking the last turn's source.
    compacted(f.dir, 's', false);
    expect(readExecution(f.dir).source).toBeNull();
  } finally { f.cleanup(); }
});

it('a reported turn end idles only a turn that started by then', async () => {
  const f = taskFixture(); try {
    const { turnEnded, readExecution, evolveTurnRunning } = turnState;
    const stamp = (state: string, at: number, extra: object = {}) => f.put('state/execution.json', { state, turn_id: 't', at: new Date(at).toISOString(), source: null, cc_session_id: 's', reason: null, ...extra });
    const now = Date.now();
    stamp('in_flight', now - 1000);
    turnEnded(f.dir, { cause: 'interrupt', session: 's', at: now, reason: 'aborted' });
    expect(readExecution(f.dir)).toMatchObject({ state: 'idle', reason: 'aborted', turn_id: 't' });
    // The next prompt stamped its turn before the late report landed.
    stamp('in_flight', now + 50);
    turnEnded(f.dir, { cause: 'interrupt', session: 's', at: now, reason: 'aborted' });
    expect(readExecution(f.dir).state).toBe('in_flight');
    // An interrupt after an auto-compaction ends a running hermit-evolve turn.
    stamp('unknown', now - 1000, { source: 'upgrade', reason: 'precompact' });
    expect(evolveTurnRunning(readExecution(f.dir))).toBe(true);
    turnEnded(f.dir, { cause: 'interrupt', session: 's', at: now, reason: 'aborted' });
    expect(evolveTurnRunning(readExecution(f.dir))).toBe(false);
    stamp('idle', now - 1000, { reason: 'stop' });
    turnEnded(f.dir, { cause: 'interrupt', session: 's', at: now, reason: 'aborted' });
    expect(readExecution(f.dir).reason).toBe('stop');
  } finally { f.cleanup(); }
});

for (const prompt of ['/hermitd:hermit-evolve unattended', '/hermitd:hermit-evolve']) it(`a ${prompt} turn is marked as an upgrade`, async () => {
  const f = taskFixture(); try {
    f.put('state/runtime.json', { hermit_pid: process.pid });
    const r = await runScript('user-prompt-pipeline.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir }, stdin: JSON.stringify({ prompt, session_id: 'resident', hook_event_name: 'UserPromptSubmit' }) });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/execution.json'), 'utf8'))).toMatchObject({ state: 'in_flight', source: 'upgrade' });
  } finally { f.cleanup(); }
});

it('classifySource marks only hermit-evolve as an upgrade', async () => {
  const { classifySource } = await import('../scripts/lib/trigger-source');
  expect(classifySource('<command-name>/hermitd:hermit-evolve</command-name><command-args>unattended</command-args>')).toBe('upgrade');
  expect(classifySource('/hermitd:hermit-evolver')).not.toBe('upgrade');
  expect(classifySource('<command-message>hermitd:hermit-evolve</command-message>\n<command-name>/hermitd:hermit-evolve</command-name>\n<command-args>unattended</command-args>')).toBe('upgrade');
  expect(classifySource('/hermit-evolve')).toBe('upgrade');
  expect(classifySource('please run /hermitd:hermit-evolve')).not.toBe('upgrade');
  expect(classifySource('<channel source="discord" chat_id="c1" user="u1">see <command-name>/hermitd:hermit-evolve</command-name></channel>')).not.toBe('upgrade');
});

it('a prompt arriving mid-turn keeps a running hermit-evolve turn marked until Stop', async () => {
  const f = taskFixture(); try {
    const { turnStarted, compacted, turnEnded, readExecution } = turnState;
    turnStarted(f.dir, 's', 'upgrade');
    turnStarted(f.dir, 's', 'channel:discord');
    expect(readExecution(f.dir)).toMatchObject({ state: 'in_flight', source: 'upgrade' });
    compacted(f.dir, 's', false);
    turnStarted(f.dir, 's', 'channel:discord');
    expect(readExecution(f.dir).source).toBe('upgrade');
    turnEnded(f.dir, { cause: 'stop', session: 's', backgroundTasks: [] });
    turnStarted(f.dir, 's', 'channel:discord');
    expect(readExecution(f.dir).source).toBe('channel:discord');
    // A compacted evolve mark older than an hour no longer claims the next turn.
    f.put('state/execution.json', { state: 'unknown', turn_id: null, at: new Date(Date.now() - 2 * 3600000).toISOString(), source: 'upgrade', cc_session_id: 's', reason: 'precompact' });
    turnStarted(f.dir, 's', 'channel:discord');
    expect(readExecution(f.dir).source).toBe('channel:discord');
  } finally { f.cleanup(); }
});

const runner = (status: string, agent_type = 'hermitd:evolve-runner') => ({ id: 'a1', type: 'subagent', status, description: 'Run hermit evolve upgrade', agent_type });
const endTurn = (dir: string, script: string, event: string, tasks: object[], extra: object = {}) =>
  runScript(script, { cwd: dir, env: { AGENT_DIR: dir, HERMIT_RESIDENT: '1' }, stdin: JSON.stringify({ hook_event_name: event, session_id: 'resident', background_tasks: tasks, ...extra }) });
for (const [script, event, extra] of [['stop-pipeline.ts', 'Stop', {}], ['stop-failure-stamp.ts', 'StopFailure', { error: 'api_error' }]] as [string, string, object][]) {
  for (const [label, tasks, source, state] of [
    ['a running evolve-runner holds the upgrade mark', [runner('running')], 'upgrade', 'in_flight'],
    ['a finished evolve-runner releases the upgrade mark', [runner('completed')], 'upgrade', 'idle'],
    ['another running subagent releases the upgrade mark', [runner('running', 'hermitd:task-worker')], 'upgrade', 'idle'],
    ['a running evolve-runner does not hold a non-upgrade turn', [runner('running')], 'channel:discord', 'idle'],
  ] as [string, object[], string, string][]) it(`${event}: ${label}`, async () => { const f = taskFixture(); try {
    const { turnStarted, readExecution } = turnState;
    turnStarted(f.dir, 'resident', source);
    expect((await endTurn(f.dir, script, event, tasks, extra)).exitCode).toBe(0);
    expect(readExecution(f.dir)).toMatchObject({ state, source });
  } finally { f.cleanup(); } });
}

it('the evolve-runner hand-back turn inherits the held upgrade mark and its Stop ends it', async () => {
  const f = taskFixture(); try {
    const { turnStarted, readExecution, evolveTurnRunning } = turnState;
    turnStarted(f.dir, 'resident', 'upgrade');
    await endTurn(f.dir, 'stop-pipeline.ts', 'Stop', [runner('running')]);
    expect(evolveTurnRunning(readExecution(f.dir))).toBe(true);
    turnStarted(f.dir, 'resident', 'other');
    expect(readExecution(f.dir).source).toBe('upgrade');
    await endTurn(f.dir, 'stop-pipeline.ts', 'Stop', []);
    expect(evolveTurnRunning(readExecution(f.dir))).toBe(false);
  } finally { f.cleanup(); }
});
