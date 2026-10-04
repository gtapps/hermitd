import { expect, mock, test } from 'claude-code/testing';
import { classifyStdout, isCommandPrompt } from '../register';

const channel = (body: string) => ({ text: `<channel source="telegram" chat_id="12345" user="u1">${body}</channel>`, origin: { kind: 'channel' as const, server: 'telegram' } });
const run = (command = '/effort', arg: string | null = 'low') => ({ decision: 'run', commands: [{ command, arg }], reply_to: { source: 'telegram', chat_id: '12345' } });

test('composer and ordinary channel prompts never start a process', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }));
  let calls = 0;
  on('process.run', () => { calls++; return { value: { exitCode: 0, stdout: '{}', stderr: '' } }; });
  expect(await $.prompt.submit({ text: '!clear', origin: { kind: 'composer' } })).toEqual({ text: '!clear' });
  await $.prompt.submit(channel('hello'));
  expect(calls).toBe(0);
  for (const text of ['!clear', '<@777> !model sonnet', '!effort@bot high', '@bot !advisor opus']) {
    expect(isCommandPrompt(channel(text).text)).toBe(true);
  }
  expect(isCommandPrompt(channel('please !clear').text)).toBe(false);
});

test('intake drops, dispatches after return, and waits for model switch evidence', async ($, on) => {
  const clock = mock.clock(on);
  const calls: string[] = [];
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 'resident' }));
  on('process.run', ($, e) => {
    calls.push(e.argv[3]);
    return { value: { exitCode: 0, stdout: JSON.stringify(e.argv[3] === 'intake' ? run('/model', 'sonnet') : { decision: 'ok' }), stderr: '' } };
  });
  on('command.run', ($, e) => { calls.push(e.command); return {}; });
  on('classic.PreModelSwitch', () => ({}));
  on('classic.PostModelSwitch', () => ({}));
  expect((await $.prompt.submit(channel('!model sonnet'))).drop).toBeDefined();
  expect(calls).toEqual(['intake']);
  await clock.settle();
  expect(calls).toEqual(['intake', 'model']);
  await $.classic.PreModelSwitch({ requested_model: 'sonnet', to_model: 'claude-sonnet' });
  await $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'unrelated' });
  await clock.settle();
  expect(calls).toEqual(['intake', 'model']);
  await $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'claude-sonnet' });
  await clock.settle();
  expect(calls).toEqual(['intake', 'model', 'finalize']);
});

for (const decision of ['deny', 'ask', 'none']) {
  test(`model approval respects ${decision} and is armed for one target only`, async ($, on) => {
    const clock = mock.clock(on);
    on('session.cwd', () => ({ value: '/work' }));
    on('session.id', () => ({ value: 'resident' }));
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(run('/model', 'sonnet')), stderr: '' } }));
    on('command.run', () => ({}));
    const answer = decision === 'none' ? {} : { permissionDecision: decision, permissionDecisionReason: 'settings decision' };
    on('classic.PreModelSwitch', () => answer);
    expect(await $.classic.PreModelSwitch({ requested_model: 'sonnet' })).toEqual(answer);
    await $.prompt.submit(channel('!model sonnet'));
    await clock.settle();
    expect(await $.classic.PreModelSwitch({ requested_model: 'opus' })).toEqual(answer);
    expect(await $.classic.PreModelSwitch({ requested_model: 'sonnet' })).toEqual(decision === 'none' ? { permissionDecision: 'allow' } : answer);
    if (decision === 'none') expect(await $.classic.PreModelSwitch({ requested_model: 'sonnet' })).toEqual({});
  });
}

test('two requests execute in order and an unknown model skips dependent effort', async ($, on) => {
  const clock = mock.clock(on);
  let intake = 0;
  const commands: string[] = [];
  const finalized: any[] = [];
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 'resident' }));
  on('process.run', ($, e) => {
    if (e.argv[3] === 'finalize') finalized.push(JSON.parse(e.argv[5]));
    const result = e.argv[3] === 'intake'
      ? ++intake === 1 ? { ...run('/model', 'bad'), commands: [{ command: '/model', arg: 'bad' }, { command: '/effort', arg: 'high' }] } : run('/model', 'sonnet')
      : { decision: 'ok' };
    return { value: { exitCode: 0, stdout: JSON.stringify(result), stderr: '' } };
  });
  on('command.run', ($, e) => { commands.push(e.command); return {}; });
  on('classic.PreModelSwitch', () => ({}));
  on('classic.PostModelSwitch', () => ({}));
  await $.prompt.submit(channel('!model bad'));
  await $.prompt.submit(channel('!model sonnet'));
  await clock.settle();
  expect(commands).toEqual(['model']);
  await clock.advance(120000);
  await clock.settle();
  expect(commands).toEqual(['model', 'model']);
  await $.classic.PreModelSwitch({ requested_model: 'sonnet', to_model: 'claude-sonnet' });
  await $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'unrelated' });
  await clock.settle();
  await $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'claude-sonnet' });
  await clock.settle();
  expect(finalized.map(f => f.outcomes[0].status)).toEqual(['unknown', 'ok']);
});

test('unknown outcome is reported once on deadline, never retried', async ($, on) => {
  const clock = mock.clock(on);
  let commands = 0;
  const outcomes: any[] = [];
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 'resident' }));
  on('process.run', ($, e) => {
    if (e.argv[3] === 'finalize') outcomes.push(JSON.parse(e.argv[5]));
    return { value: { exitCode: 0, stdout: JSON.stringify(e.argv[3] === 'intake' ? run() : { decision: 'ok' }), stderr: '' } };
  });
  on('command.run', () => { commands++; return {}; });
  await $.prompt.submit(channel('!effort low'));
  await clock.settle();
  await clock.advance(120000);
  expect(outcomes[0].outcomes[0].status).toBe('unknown');
  expect(commands).toBe(1);
});

test('subagent completion never claims; main answer claims and acks after dispatch', async ($, on) => {
  const clock = mock.clock(on);
  const calls: string[] = [];
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 'resident' }));
  on('turn.complete', () => ({ text: '' }));
  on('process.run', ($, e) => {
    calls.push(e.argv[3]);
    return { value: { exitCode: 0, stdout: JSON.stringify(e.argv[3] === 'claim' ? { ...run(), requested_at: 'identity' } : { decision: 'ok' }), stderr: '' } };
  });
  on('command.run', () => { calls.push('dispatch'); return {}; });
  await $.turn.complete({ agentId: 'worker', reason: 'answer', answer: '', turnId: 'sub', durationMs: 0, isAborted: false, usage: null });
  expect(calls).toEqual([]);
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'main', durationMs: 0, isAborted: false, usage: null });
  await clock.settle();
  expect(calls).toEqual(['claim', 'dispatch', 'ack']);
});

test('session start and clear record the current session id', async ($, on) => {
  const clock = mock.clock(on);
  const loaded: string[] = [];
  let id = 'old';
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: id }));
  on('session.start', () => ({ cwd: '/work' }));
  on('session.end', () => ({ sessionId: 'old' }));
  on('classic.SessionStart', () => ({}));
  on('process.run', ($, e) => {
    if (e.argv[3] === 'loaded') loaded.push(e.argv[4]);
    return { value: { exitCode: 0, stdout: '{"decision":"ok"}', stderr: '' } };
  });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
  await $.session.end({ reason: 'clear', sessionId: 'old' });
  id = 'new';
  await clock.settle();
  expect(loaded).toEqual(['old']);
  await $.classic.SessionStart({ source: 'clear' });
  await clock.settle();
  expect(loaded).toEqual(['old', 'new']);
});

test('stdout classification recognizes observed success and failures', () => {
  for (const [command, text, expected] of [
    ['/model', 'Set model to Sonnet', 'ok'],
    ['/model', 'Model switch blocked by a PreModelSwitch hook', 'failed'],
    ['/effort', 'Set effort level to low', 'ok'],
    ['/effort', 'Invalid effort level: bogus', 'failed'],
    ['/advisor', 'Advisor set to Opus', 'ok'],
    ['/advisor', 'Advisor disabled', 'ok'],
    ['/advisor', "Invalid advisor model: Model 'bogusmodel' not found", 'failed'],
    ['/clear', '', 'ok'],
    ['/clear', 'Could not clear', 'failed'],
  ]) expect(classifyStdout(command, text)).toBe(expected);
});

for (const command of ['/compact', '/clear']) {
  test(`${command} finalizes only after its native lifecycle evidence`, async ($, on) => {
    const clock = mock.clock(on);
    const finalized: any[] = [];
    on('session.cwd', () => ({ value: '/work' }));
    on('session.id', () => ({ value: 'resident' }));
    on('process.run', ($, e) => {
      if (e.argv[3] === 'finalize') finalized.push(JSON.parse(e.argv[5]));
      return { value: { exitCode: 0, stdout: JSON.stringify(e.argv[3] === 'intake' ? run(command, null) : { decision: 'ok' }), stderr: '' } };
    });
    on('command.run', () => ({}));
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 100, tokensAfter: 10, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
    on('session.end', () => ({ sessionId: 'resident' }));
    on('classic.SessionStart', () => ({}));
    await $.prompt.submit(channel('!' + command.slice(1)));
    await clock.settle();
    expect(finalized).toEqual([]);
    if (command === '/compact') await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] });
    else {
      // The id is restamped by the SessionStart command hook, after session.end.
      await $.session.end({ reason: 'clear', sessionId: 'resident' });
      await clock.settle();
      expect(finalized).toEqual([]);
      await $.classic.SessionStart({ source: 'clear' });
    }
    await clock.settle();
    expect(finalized[0].outcomes[0].status).toBe('ok');
  });
}

test('pass keeps the prompt; refusal drops and a failed send requests one relay', async ($, on) => {
  const clock = mock.clock(on);
  let intakes = 0;
  const relays: string[] = [];
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 'resident' }));
  on('prompt.submit', ($, e) => { relays.push(e.text); return { text: e.text }; });
  on('process.run', ($, e) => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify(e.argv[3] === 'intake'
    ? ++intakes === 1 ? { decision: 'pass' } : { decision: 'refuse', reason: 'Shutting down', reply_to: { source: 'telegram', chat_id: '12345' } }
    : { decision: 'send_failed', text: 'Shutting down', reply_to: { source: 'telegram', chat_id: '12345' } }) } }));
  expect((await $.prompt.submit(channel('!clear'))).text).toBe(channel('!clear').text);
  expect((await $.prompt.submit(channel('!clear'))).drop).toBeDefined();
  await clock.settle();
  expect(relays.length).toBe(2);
  expect(relays[1]).toContain('Shutting down');
});

test('doctor writes the relay before running and reports only a failed start', async ($, on) => {
  const clock = mock.clock(on);
  const calls: string[] = [];
  const outcomes: any[] = [];
  let fail = false;
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 'resident' }));
  on('process.run', ($, e) => {
    calls.push(e.argv[3]);
    if (e.argv[3] === 'finalize') outcomes.push(JSON.parse(e.argv[5]));
    return { value: { exitCode: 0, stdout: JSON.stringify(e.argv[3] === 'intake' ? run('/doctor', null) : { decision: 'ok' }), stderr: '' } };
  });
  on('command.run', ($, e) => {
    calls.push(e.command);
    if (fail) throw new Error('no command named /doctor');
    return {};
  });
  expect(isCommandPrompt(channel('!checkup').text)).toBe(true);
  expect((await $.prompt.submit(channel('!doctor'))).drop).toBeDefined();
  await clock.settle();
  await clock.advance(120000);
  expect(calls).toEqual(['intake', 'relay', 'doctor']);
  fail = true;
  await $.prompt.submit(channel('!doctor'));
  await clock.settle();
  expect(calls.slice(3)).toEqual(['intake', 'relay', 'doctor', 'finalize']);
  expect(outcomes[0].outcomes[0]).toMatchObject({ command: '/doctor', status: 'failed' });
});
