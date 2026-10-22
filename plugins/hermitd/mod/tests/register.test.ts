import { expect, mock, test } from 'claude-code/testing';
import { classifyStdout, isCommandPrompt } from '../register';

const channel = (body: string) => ({ text: `<channel source="telegram" chat_id="12345" user="u1">${body}</channel>`, origin: { kind: 'channel' as const, server: 'telegram' } });
type Cmd = { command: string; arg: string | null };
const entry = (id: string, commands: Cmd[], extra: object = {}) => ({ id, source: 'chat', commands, reply_to: { source: 'telegram', chat_id: '12345' }, ...extra });

// The bridge and the queue directory as the engine's host would answer them. `queue`
// is what the directory lists; `claim` hands out its head (a pause first) unless overridden.
function rig(on: any, options: { id?: () => string; handlers?: Record<string, (payload: string) => unknown> } = {}) {
  const calls: string[] = [];
  const payloads: Record<string, any[]> = {};
  const queue: any[] = [];
  const commands: string[] = [];
  const files: Record<string, string> = {};
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: options.id?.() ?? 'resident' }));
  on('session.start', () => ({ cwd: '/work' }));
  on('turn.start', ($: unknown, e: any) => ({ turnId: e.turnId }));
  on('process.run', ($: unknown, e: any) => {
    const verb = e.argv[3];
    calls.push(verb);
    (payloads[verb] ??= []).push(e.argv[5] ? (() => { try { return JSON.parse(e.argv[5]); } catch { return e.argv[5]; } })() : undefined);
    const handler = options.handlers?.[verb];
    let out: unknown;
    if (handler) out = handler(e.argv[5]);
    else if (verb === 'loaded') out = { decision: 'ok', state: '/state', session_id: e.argv[4] };
    else if (verb === 'recover') out = { decision: 'pass' };
    else if (verb === 'claim') {
      const pauseOnly = e.argv[5] === 'pause';
      const index = queue.findIndex(q => q.source === 'pause');
      const pick = index >= 0 ? index : pauseOnly ? -1 : queue.length ? 0 : -1;
      out = pick >= 0 ? { decision: 'run', ...queue.splice(pick, 1)[0] } : { decision: 'pass' };
    } else out = { decision: 'ok' };
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } };
  });
  on('fs.list', () => ({ value: queue.map(q => ({ name: `${q.id}.json`, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }));
  on('fs.read', ($: unknown, e: any) => ({ value: files[e.path] ?? JSON.stringify(queue.find(q => e.path.endsWith(`/${q.id}.json`)) ?? {}) }));
  return { calls, payloads, queue, commands, files };
}
const boot = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
const finalized = (r: { payloads: Record<string, any[]> }) => r.payloads.finalize ?? [];

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

test('non-channel origins cannot submit a channel envelope', async ($, on) => {
  let reached = 0;
  let calls = 0;
  on('prompt.submit', ($, e) => { reached++; return { text: e.text }; });
  on('process.run', () => { calls++; return { value: { exitCode: 0, stdout: '{}', stderr: '' } }; });
  const prompt = channel('hello');
  for (const kind of ['peer', 'unclassified', 'composer'] as const) {
    expect((await $.prompt.submit({ ...prompt, origin: { kind } })).drop).toBeDefined();
    expect(reached).toBe(0);
    expect(calls).toBe(0);
  }
  expect(await $.prompt.submit(prompt)).toEqual({ text: prompt.text });
  expect(reached).toBe(1);
  expect(calls).toBe(0);
});

test('intake queues through the bridge, then runs and waits for model switch evidence', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on, { handlers: { intake: () => { r.queue.push(entry('m1', [{ command: '/model', arg: 'sonnet' }])); return { decision: 'queued', id: 'm1' }; } } });
  on('command.run', ($, e) => { r.calls.push(e.command); return {}; });
  on('classic.PreModelSwitch', () => ({}));
  on('classic.PostModelSwitch', () => ({}));
  expect((await $.prompt.submit(channel('!model sonnet'))).drop).toBeDefined();
  expect(r.calls).toEqual(['intake']);
  await clock.settle();
  expect(r.calls).toEqual(['intake', 'loaded', 'recover', 'claim', 'model']);
  await $.classic.PreModelSwitch({ requested_model: 'sonnet', to_model: 'claude-sonnet' });
  await $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'unrelated' });
  await clock.settle();
  expect(finalized(r)).toEqual([]);
  await $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'claude-sonnet' });
  await clock.settle();
  expect(finalized(r)).toEqual([{ id: 'm1', legs: [{ command: '/model', status: 'ok', text: 'Model switched to sonnet' }] }]);
});

for (const decision of ['deny', 'ask', 'none']) {
  test(`model approval respects ${decision} and is armed for one target only`, async ($, on) => {
    const clock = mock.clock(on);
    const r = rig(on);
    on('command.run', () => ({}));
    const answer = decision === 'none' ? {} : { permissionDecision: decision, permissionDecisionReason: 'settings decision' };
    on('classic.PreModelSwitch', () => answer);
    expect(await $.classic.PreModelSwitch({ requested_model: 'sonnet' })).toEqual(answer);
    r.queue.push(entry('m1', [{ command: '/model', arg: 'sonnet' }]));
    await boot($);
    await clock.advance(2000);
    expect(await $.classic.PreModelSwitch({ requested_model: 'opus' })).toEqual(answer);
    expect(await $.classic.PreModelSwitch({ requested_model: 'sonnet' })).toEqual(decision === 'none' ? { permissionDecision: 'allow' } : answer);
    if (decision === 'none') expect(await $.classic.PreModelSwitch({ requested_model: 'sonnet' })).toEqual({});
  });
}

test('one timer; requests run in order and an uncertain model skips the dependent effort', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  on('command.run', ($, e) => { r.commands.push(e.command); return {}; });
  on('classic.PreModelSwitch', () => ({}));
  on('classic.PostModelSwitch', () => ({}));
  r.queue.push(entry('a', [{ command: '/model', arg: 'bad' }, { command: '/effort', arg: 'high' }]), entry('b', [{ command: '/model', arg: 'sonnet' }]));
  await boot($);
  await boot($);
  await clock.advance(2000);
  expect(r.calls.filter(c => c === 'claim')).toHaveLength(1);
  expect(r.commands).toEqual(['model']);
  await clock.advance(120000);
  expect(finalized(r)[0]).toEqual({ id: 'a', legs: [{ command: '/model', status: 'unknown', text: 'deadline reached' }] });
  await clock.advance(2000);
  expect(r.commands).toEqual(['model', 'model']);
  await $.classic.PreModelSwitch({ requested_model: 'sonnet', to_model: 'claude-sonnet' });
  await $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'claude-sonnet' });
  await clock.settle();
  expect(finalized(r).map(f => f.legs[0].status)).toEqual(['unknown', 'ok']);
});

test('the deadline records unknown but keeps the slot until the run settles', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  let release: () => void = () => undefined;
  on('command.run', ($, e) => { r.commands.push(e.command); return new Promise(resolve => { release = () => resolve({}); }); });
  r.queue.push(entry('a', [{ command: '/advisor', arg: 'opus' }]), entry('b', [{ command: '/advisor', arg: 'sonnet' }]));
  await boot($);
  await clock.advance(2000);
  await clock.advance(120000);
  expect(finalized(r).map(f => f.id)).toEqual(['a']);
  await clock.advance(10000);
  expect(r.commands).toEqual(['advisor']);
  expect(r.calls.filter(c => c === 'claim')).toHaveLength(1);
  release();
  await clock.advance(2000);
  expect(r.commands).toEqual(['advisor', 'advisor']);
});

test('a rejected model reports failed from its engine-origin rows, without the deadline', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  on('command.run', ($, e) => { r.commands.push(e.command); return {}; });
  const row = (content: string, uuid: string, origin: any = { kind: 'engine' }, type = 'system') =>
    $.session.append({ message: { type, content: [{ type: 'text', text: content }] }, door: 'command', origin, uuid } as any);
  r.queue.push(entry('a', [{ command: '/model', arg: 'low' }]));
  await boot($);
  await clock.advance(2000);
  expect(r.commands).toEqual(['model']);
  // A row naming another command never counts as this run's output.
  await row('<command-name>/reload-plugins</command-name><command-args></command-args>', 'a');
  await row('<local-command-stdout>Reloaded</local-command-stdout>', 'b');
  await row('<command-name>/model</command-name><command-args>low</command-args>', 'c', { kind: 'peer' });
  await row("<local-command-stdout>Model 'low' not found</local-command-stdout>", 'd', { kind: 'peer' });
  await row('<command-name>/model</command-name><command-args>low</command-args>', 'g', { kind: 'engine' }, 'user');
  await row("<local-command-stdout>Model 'low' not found</local-command-stdout>", 'h', { kind: 'engine' }, 'user');
  await clock.settle();
  expect(finalized(r)).toEqual([]);
  await row('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>low</command-args>', 'e');
  await row("<local-command-stdout>Model 'low' not found</local-command-stdout>", 'f');
  await clock.settle();
  expect(finalized(r)[0].legs[0]).toMatchObject({ command: '/model', status: 'failed', text: "Model 'low' not found" });
});

test('a rejected run finalizes failed with the rejection text', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  // A thrown hook is how the kit rejects the run, as the engine does after an operator's Escape.
  on('command.run', () => { throw new Error('the session was stopped and nobody has sent input since'); });
  r.queue.push(entry('w', [{ command: '/compact', arg: 'focus on unfinished work' }], { source: 'watchdog' }));
  await boot($);
  await clock.advance(2000);
  expect(finalized(r)[0].legs[0]).toMatchObject({ command: '/compact', status: 'failed' });
  expect(finalized(r)[0].legs[0].text).not.toBe('');
  expect(r.calls).not.toContain('leg');
});

test('a main turn gates the queue; a subagent turn does not', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  on('turn.complete', () => ({ text: '' }));
  on('command.run', ($, e) => { r.commands.push(e.command); return {}; });
  r.queue.push(entry('a', [{ command: '/advisor', arg: 'opus' }]));
  await boot($);
  await $.turn.start({ text: '', turnId: 'main' });
  await clock.advance(4000);
  expect(r.calls).not.toContain('claim');
  await $.turn.start({ text: '', turnId: 'sub', agentId: 'worker' });
  await $.turn.complete({ agentId: 'worker', reason: 'answer', answer: '', turnId: 'sub', durationMs: 0, isAborted: false, usage: null });
  await clock.advance(2000);
  expect(r.calls).not.toContain('claim');
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'main', durationMs: 0, isAborted: false, usage: null });
  await clock.advance(2000);
  expect(r.commands).toEqual(['advisor']);
});

test('a request queued mid-turn is claimed on the main turn.complete, not on a subagent one', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  on('turn.complete', () => ({ text: '' }));
  on('command.run', ($, e) => { r.commands.push(e.command); return {}; });
  await boot($);
  await $.turn.start({ text: '', turnId: 'main' });
  r.queue.push(entry('a', [{ command: '/advisor', arg: 'opus' }]));
  await $.turn.complete({ agentId: 'worker', reason: 'answer', answer: '', turnId: 'sub', durationMs: 0, isAborted: false, usage: null });
  await clock.settle();
  expect(r.calls).not.toContain('claim');
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'main', durationMs: 0, isAborted: false, usage: null });
  await clock.settle();
  expect(r.commands).toEqual(['advisor']);
});

test('a pause aborts the running main turn at once, ahead of queued work', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  const aborted: string[] = [];
  on('turn.abort', ($, e) => { aborted.push(e.turnId); return { value: undefined }; });
  on('command.run', ($, e) => { r.commands.push(e.command); return {}; });
  r.queue.push(entry('a', [{ command: '/advisor', arg: 'opus' }]));
  await boot($);
  await $.turn.start({ text: '', turnId: 'main' });
  await clock.advance(2000);
  r.queue.push({ id: 'p', source: 'pause', commands: [] });
  await clock.advance(2000);
  expect(aborted).toEqual(['main']);
  expect(r.payloads.claim).toContain('pause');
  expect(finalized(r)).toEqual([{ id: 'p', legs: [{ command: 'turn.abort', status: 'ok', text: 'turn aborted' }] }]);
  expect(r.commands).toEqual([]);
});

test('a pause with no turn in flight finalizes ok', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  r.queue.push({ id: 'p', source: 'pause', commands: [] });
  await boot($);
  await clock.advance(2000);
  expect(finalized(r)).toEqual([{ id: 'p', legs: [{ command: 'turn.abort', status: 'ok', text: 'no turn' }] }]);
});

test('an unchanged reload continues the batch and records leg progress', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  on('command.run', ($, e) => { r.commands.push(e.command); return {}; });
  r.queue.push(entry('u', [{ command: '/reload-plugins', arg: null }, { command: '/hermitd:hermit-evolve', arg: 'unattended' }], { source: 'update' }));
  await boot($);
  await clock.advance(2000);
  expect(r.commands).toEqual(['reload-plugins']);
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: '<command-name>/reload-plugins</command-name><command-args></command-args>' }] }, door: 'command', origin: { kind: 'engine' }, uuid: 'x' } as any);
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: '<local-command-stdout>Reloaded: 7 plugins</local-command-stdout>' }] }, door: 'command', origin: { kind: 'engine' }, uuid: 'y' } as any);
  await clock.settle();
  expect(r.payloads.leg).toEqual([{ id: 'u', legs: [{ command: '/reload-plugins', status: 'ok', text: 'Reloaded: 7 plugins' }] }]);
  expect(r.commands).toEqual(['reload-plugins', 'hermitd:hermit-evolve']);
  expect(finalized(r)[0].legs.map((l: any) => [l.command, l.status])).toEqual([['/reload-plugins', 'ok'], ['/hermitd:hermit-evolve', 'ok']]);
  expect(finalized(r)[0].legs[1].submitted_at).toBeDefined();
});

test('a fresh copy resumes the batch that recover hands back', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on, { handlers: { recover: () => ({ decision: 'run', ...entry('u', [{ command: '/reload-plugins', arg: null }, { command: '/hermitd:hermit-evolve', arg: 'unattended' }], { source: 'update' }), legs: [{ command: '/reload-plugins', status: 'ok', text: 'Reloaded to 2.0.0' }] }) } });
  on('command.run', ($, e) => { r.commands.push(e.command); return {}; });
  await boot($);
  await clock.settle();
  expect(r.commands).toEqual(['hermitd:hermit-evolve']);
  expect(finalized(r)[0].legs.map((l: any) => l.status)).toEqual(['ok', 'ok']);
});

test('a fresh copy loaded while a turn is in flight leaves the wait to the engine', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  on('turn.complete', () => ({ text: '' }));
  let release: () => void = () => undefined;
  on('command.run', ($, e) => { r.commands.push(e.command); return new Promise(resolve => { release = () => resolve({}); }); });
  r.queue.push(entry('a', [{ command: '/clear', arg: null }]));
  await boot($);
  await clock.advance(2000);
  // The copy never saw the turn start, so it claims; $.command.run queues behind the turn.
  expect(r.commands).toEqual(['clear']);
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'unseen', durationMs: 0, isAborted: false, usage: null });
  release();
  await clock.settle();
  expect(r.calls.filter(c => c === 'claim')).toHaveLength(1);
});

test('loaded runs once per session id, never per tick, and catches up on SessionStart', async ($, on) => {
  const clock = mock.clock(on);
  let id = 'old';
  let runtime = 'old';
  const stamped: string[] = [];
  const r = rig(on, { id: () => id, handlers: { loaded: () => {
    if (id !== runtime) return { decision: 'pass' };
    stamped.push(id);
    return { decision: 'ok', state: '/state', session_id: id };
  } } });
  on('session.end', () => ({ sessionId: 'old' }));
  on('classic.SessionStart', () => ({}));
  await boot($);
  await clock.advance(10000);
  expect(r.calls.filter(c => c === 'loaded')).toHaveLength(1);
  expect(r.calls.filter(c => c === 'recover')).toHaveLength(1);
  await $.session.end({ reason: 'clear', sessionId: 'old' });
  runtime = 'new';
  id = 'new';
  await $.classic.SessionStart({ source: 'clear' });
  await clock.advance(10000);
  expect(stamped).toEqual(['old', 'new']);
  // A guest id is attempted once, then left alone for every later tick.
  id = 'guest';
  await clock.advance(20000);
  expect(r.calls.filter(c => c === 'loaded')).toHaveLength(3);
  expect(r.calls).not.toContain('claim');
  // A forked resume can start before the resident record names it; SessionStart catches up.
  id = 'fork';
  await boot($);
  expect(stamped).toEqual(['old', 'new']);
  runtime = 'fork';
  await $.classic.SessionStart({ source: 'fork' });
  await clock.settle();
  expect(stamped).toEqual(['old', 'new', 'fork']);
  expect(r.calls.filter(c => c === 'recover')).toHaveLength(1);
});

test('stdout classification recognizes observed success and failures', () => {
  for (const [command, text, expected] of [
    ['/model', 'Set model to Sonnet', 'ok'],
    ['/model', 'Model switch blocked by a PreModelSwitch hook', 'failed'],
    ['/advisor', 'Advisor set to Opus', 'ok'],
    ['/advisor', 'Advisor disabled', 'ok'],
    ['/advisor', "Invalid advisor model: Model 'bogusmodel' not found", 'failed'],
    ['/reload-plugins', 'Reloaded: 7 plugins', 'ok'],
    ['/reload-plugins', 'Failed to reload', 'failed'],
    ['/clear', '', 'ok'],
    ['/clear', 'Could not clear', 'failed'],
  ]) expect(classifyStdout(command, text)).toBe(expected);
});

for (const command of ['/compact', '/clear']) {
  test(`${command} finalizes only after its native lifecycle evidence`, async ($, on) => {
    const clock = mock.clock(on);
    const r = rig(on);
    on('command.run', () => ({}));
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 100, tokensAfter: 10, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
    on('session.end', () => ({ sessionId: 'resident' }));
    on('classic.SessionStart', () => ({}));
    r.queue.push(entry('c', [{ command, arg: null }], { source: 'watchdog' }));
    await boot($);
  await clock.advance(2000);
    expect(finalized(r)).toEqual([]);
    if (command === '/compact') await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] });
    else {
      // The id is restamped by the SessionStart command hook, after session.end.
      await $.session.end({ reason: 'clear', sessionId: 'resident' });
      await clock.settle();
      expect(finalized(r)).toEqual([]);
      await $.classic.SessionStart({ source: 'clear' });
    }
    await clock.settle();
    expect(finalized(r)[0].legs[0].status).toBe('ok');
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

test('claim and recover relay the replies the bridge could not send', async ($, on) => {
  const clock = mock.clock(on);
  const relays: string[] = [];
  on('prompt.submit', ($, e) => { relays.push(e.text); return { text: e.text }; });
  const failed = (text: string) => ({ decision: 'pass', relays: [{ text, reply_to: { source: 'telegram', chat_id: '12345' } }] });
  const r = rig(on, { handlers: { recover: () => failed('/effort low: outcome unknown (worker_lost)'), claim: () => failed('/effort low: skipped (expired)') } });
  r.queue.push(entry('e', [{ command: '/effort', arg: 'low' }]));
  await boot($);
  await clock.advance(2000);
  expect(relays.length).toBe(2);
  expect(relays[0]).toContain('worker_lost');
  expect(relays[1]).toContain('expired');
});

test('doctor writes the relay before running and reports a started or failed run', async ($, on) => {
  const clock = mock.clock(on);
  let fail = false;
  let relayed = 'ok';
  const r = rig(on, { handlers: { relay: () => ({ decision: relayed }) } });
  on('command.run', ($, e) => {
    r.calls.push(e.command);
    if (fail) throw new Error('no command named /doctor');
    return {};
  });
  expect(isCommandPrompt(channel('!checkup').text)).toBe(true);
  r.queue.push(entry('d1', [{ command: '/doctor', arg: null }]));
  await boot($);
  await clock.advance(2000);
  expect(r.calls.slice(-3)).toEqual(['relay', 'doctor', 'finalize']);
  expect(finalized(r)[0].legs[0]).toMatchObject({ command: '/doctor', status: 'ok' });
  fail = true;
  r.queue.push(entry('d2', [{ command: '/doctor', arg: null }]));
  await clock.advance(2000);
  expect(finalized(r)[1].legs[0]).toMatchObject({ command: '/doctor', status: 'failed' });
  fail = false;
  relayed = 'pass';
  r.queue.push(entry('d3', [{ command: '/doctor', arg: null }]));
  await clock.advance(2000);
  expect(r.calls.slice(-3)).toEqual(['claim', 'relay', 'finalize']);
  expect(finalized(r)[2].legs[0]).toMatchObject({ command: '/doctor', status: 'failed' });
});

test('/effort sets a per-request override for main-thread steps without running the command', async ($, on) => {
  const clock = mock.clock(on);
  const r = rig(on);
  const written: Record<string, string> = {};
  on('fs.write', ($, e: any) => { written[e.path] = e.text; return { value: undefined }; });
  on('command.run', ($, e) => { r.commands.push(e.command); return {}; });
  const sent: (string | undefined)[] = [];
  on('turn.step', async function* ($, e: any) { sent.push(e.effort); return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }; });
  r.queue.push(entry('a', [{ command: '/effort', arg: 'high' }]), entry('b', [{ command: '/effort', arg: 'turbo' }]));
  await boot($);
  await clock.advance(2000);
  await clock.advance(2000);
  expect(r.commands).toEqual([]);
  expect(JSON.parse(written['/state/effort-override.json']).level).toBe('high');
  expect(finalized(r).map(f => f.legs[0].status)).toEqual(['ok', 'failed']);
  for (const step of [{ effort: 'medium' }, { effort: 'medium', agentId: 'worker' }, {}]) {
    for await (const _ of ($ as any).turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, ...step })) { /* drain */ }
  }
  expect(sent).toEqual(['high', 'medium', undefined]);
});

test('a fresh copy re-reads the effort override from state', async ($, on) => {
  const clock = mock.clock(on);
  rig(on).files['/state/effort-override.json'] = JSON.stringify({ level: 'low' });
  const sent: (string | undefined)[] = [];
  on('turn.step', async function* ($, e: any) { sent.push(e.effort); return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }; });
  await boot($);
  await clock.settle();
  for await (const _ of ($ as any).turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, effort: 'max' })) { /* drain */ }
  expect(sent).toEqual(['low']);
});
