import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture, taskLib } from './helpers/tasks';
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
  ['precompact-stamp.ts', 'PreCompact', 'unknown', { trigger: 'manual' }],
  ...['startup', 'resume', 'clear', 'compact'].map(source => ['startup-context.ts', 'SessionStart', source === 'clear' ? 'idle' : 'unknown', { source }]),
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
  } finally { f.cleanup(); } });
}
it('resident SessionStart records its source in session-start.json and a later prompt leaves it', async () => { const f = taskFixture(); try {
  f.put('config.json', { channels: {} }); f.put('state/runtime.json', { hermit_pid: process.pid });
  await runScript('startup-context.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir, HERMIT_RESIDENT: '1' }, stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'resident', source: 'compact' }) });
  await runScript('user-prompt-pipeline.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir }, stdin: JSON.stringify({ prompt: 'Hello', session_id: 'resident', hook_event_name: 'UserPromptSubmit' }) });
  expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/execution.json'), 'utf8')).state).toBe('in_flight');
  expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/session-start.json'), 'utf8'))).toMatchObject({ source: 'compact' });
} finally { f.cleanup(); } });
it('blocked guest prompt does not write execution', async () => { const f = taskFixture(); try { markGuest(path.join(f.dir, 'state'), 'guest'); await runScript('user-prompt-pipeline.ts', { cwd: f.dir, env: { AGENT_DIR: f.dir }, stdin: JSON.stringify({ session_id: 'guest', prompt: '<channel source="discord" chat_id="c1" user="u1">Hello</channel>' }) }); expect(fs.existsSync(path.join(f.dir, 'state/execution.json'))).toBe(false); } finally { f.cleanup(); } });
it('old in_flight and malformed observations read unknown', async () => { const f = taskFixture(); try { const lib = await taskLib(); f.put('state/execution.json', { state: 'in_flight', at: '2020-01-01T00:00:00Z' }); expect(lib.readExecution(f.dir).state).toBe('unknown'); fs.writeFileSync(path.join(f.dir, 'state/execution.json'), '{'); expect(lib.readExecution(f.dir).state).toBe('unknown'); } finally { f.cleanup(); } });
