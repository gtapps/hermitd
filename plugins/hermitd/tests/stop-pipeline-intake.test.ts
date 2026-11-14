import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { fixturesDir, withDir } from './helpers/workdir';
import { markGuest } from '../scripts/lib/guest-marker';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const PIPE_ENV = { AGENT_HOOK_PROFILE: 'standard', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
const SESSION_ID = 'test-session-001'; // as carried by the stop-hook fixture

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

function stopHookInput(dir: string): string {
  const transcript = path.join(dir, '.claude', 'transcript.jsonl');
  fs.copyFileSync(path.join(fixturesDir, 'transcript.jsonl'), transcript);
  return fs
    .readFileSync(path.join(fixturesDir, 'stop-hook-input.json'), 'utf-8')
    .replace('__TRANSCRIPT_PATH__', transcript);
}

function writeTurn(dir: string, at = '2020-01-01T00:00:00.000Z'): void {
  fs.writeFileSync(hermit(dir, 'state', 'operator-turn-open.json'), JSON.stringify({ at }) + '\n');
}

function writeAck(dir: string, patch: Record<string, unknown> = {}): void {
  const ack = {
    at: '2020-01-01T00:00:01.000Z',
    channel: 'discord',
    chat_id: 'home',
    session_id: SESSION_ID,
    ...patch,
  };
  fs.appendFileSync(hermit(dir, 'state', 'intake-acks.jsonl'), JSON.stringify({
    key: `${ack.channel}:${ack.chat_id}`,
    ...ack,
  }) + '\n');
}

function writeChats(dir: string, chatId: string, type: number): void {
  fs.writeFileSync(hermit(dir, 'state', 'channel-chats.json'), JSON.stringify({
    discord: { chats: { [chatId]: { type, parent_id: type === 11 ? 'home' : null, guild_id: 'guild', fetched_at: '2020-01-01T00:00:00.000Z' } } },
  }) + '\n');
}

async function openResident(dir: string, conversation: string | null, extra: string[] = []): Promise<void> {
  const r = await runScript('task.ts', {
    cwd: dir,
    env: { AGENT_DIR: hermit(dir) },
    args: ['open', hermit(dir), '--owner', 'resident', '--requester', 'discord:u1', ...(conversation ? ['--conversation', conversation] : []), ...extra, '--title', 'Work', '--done', 'Verified'],
  });
  expect(r.exitCode).toBe(0);
}

async function runStop(dir: string, stdin?: string) {
  return runScript('stop-pipeline.ts', {
    stdin: stdin ?? stopHookInput(dir),
    cwd: dir,
    env: { ...PIPE_ENV, AGENT_DIR: hermit(dir) },
  });
}

function turnExists(dir: string): boolean {
  return fs.existsSync(hermit(dir, 'state', 'operator-turn-open.json'));
}

describe('stop-pipeline — channel intake checkpoint', () => {
  test('no ack: stdout empty, turn marker removed', withDir(async (dir) => {
    writeTurn(dir);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('ack plus a record opened this turn on a cached thread: stdout empty, turn marker removed', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { chat_id: 'thread' });
    writeChats(dir, 'thread', 11);
    await openResident(dir, 'discord:thread');
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('ack with no record: block JSON, reason contains task.ts open, turn marker kept', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('task.ts open');
    expect(body.reason).toContain('task skill');
    expect(turnExists(dir)).toBe(true);
  }));

  test('ack in a conversation that already has an open record: stdout empty, turn marker removed', withDir(async (dir) => {
    writeChats(dir, 'thread', 11);
    await openResident(dir, 'discord:thread');
    writeTurn(dir, new Date(Date.now() + 1000).toISOString());
    writeAck(dir, { chat_id: 'thread', at: new Date(Date.now() + 2000).toISOString() });
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('missing record with stop_hook_active true: stdout empty, turn marker removed', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir);
    const r = await runStop(dir, stopHookInput(dir).replace('"stop_hook_active": false', '"stop_hook_active": true'));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('missing record in a guest session: stdout empty', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir);
    markGuest(hermit(dir, 'state'), SESSION_ID);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('foreign ack session is ignored: stdout empty, turn marker removed, ack deleted', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { session_id: 'other-session' });
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
    expect(fs.existsSync(hermit(dir, 'state', 'intake-acks.jsonl'))).toBe(false);
  }));

  test('two acks with a record for only one: block JSON naming the unrecorded chat', withDir(async (dir) => {
    writeTurn(dir);
    writeChats(dir, 't1', 11);
    writeAck(dir, { chat_id: 't2' });
    writeAck(dir, { chat_id: 't1' });
    await openResident(dir, 'discord:t1');
    const r = await runStop(dir);
    const body = JSON.parse(r.stdout);
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('discord:t2');
    expect(body.reason).not.toContain('discord:t1');
    expect(turnExists(dir)).toBe(true);
  }));

  test('two thread acks in one parent with only one record: block naming the missing thread', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { channel: 'slack', chat_id: 'C1', key: 'slack:C1~m1' });
    writeAck(dir, { channel: 'slack', chat_id: 'C1', key: 'slack:C1~m2' });
    await openResident(dir, 'slack:C1~m1');
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('slack:C1~m2');
    expect(body.reason).not.toContain('slack:C1~m1');
  }));

  test('sibling thread card in the same parent does not satisfy a thread ack', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { channel: 'slack', chat_id: 'C1', key: 'slack:C1~m2' });
    await openResident(dir, 'slack:C1~m1', ['--card', JSON.stringify({ chat_id: 'C1', message_id: 'r1' })]);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('slack:C1~m2');
  }));

  test('thread ack with its exact record: stdout empty', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { channel: 'slack', chat_id: 'C1', key: 'slack:C1~m1' });
    await openResident(dir, 'slack:C1~m1');
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('ack without a key is ignored', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { key: undefined });
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('two acks each with its own record: stdout empty, turn marker removed', withDir(async (dir) => {
    writeTurn(dir);
    writeChats(dir, 't1', 11);
    writeAck(dir, { chat_id: 't1' });
    writeAck(dir, { chat_id: 't2' });
    await openResident(dir, 'discord:t1');
    await openResident(dir, 'discord:t2');
    const r = await runStop(dir);
    expect(r.stdout.trim()).toBe('');
    expect(turnExists(dir)).toBe(false);
  }));

  test('two acks in one chat with a single record: blocked', withDir(async (dir) => {
    writeTurn(dir);
    writeChats(dir, 'dm', 1);
    writeAck(dir, { chat_id: 'dm' });
    writeAck(dir, { chat_id: 'dm' });
    await openResident(dir, 'discord:dm');
    const r = await runStop(dir);
    expect(JSON.parse(r.stdout).decision).toBe('block');
  }));

  test('two unrecorded chats plus a touched conversation-less record: block JSON', withDir(async (dir) => {
    writeTurn(dir);
    writeAck(dir, { chat_id: 't1' });
    writeAck(dir, { chat_id: 't2' });
    await openResident(dir, null);
    const r = await runStop(dir);
    expect(JSON.parse(r.stdout).decision).toBe('block');
  }));

  test('ack for an earlier conversation-less record updated this turn: stdout empty', withDir(async (dir) => {
    await openResident(dir, null);
    const [file] = fs.readdirSync(hermit(dir, 'tasks'));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(hermit(dir, 'tasks', file), past, past);
    writeTurn(dir, new Date(Date.now() - 1000).toISOString());
    writeAck(dir, { at: new Date().toISOString() });
    const blocked = await runStop(dir);
    expect(JSON.parse(blocked.stdout).decision).toBe('block');

    writeAck(dir, { at: new Date().toISOString() });
    const r = await runScript('task.ts', {
      cwd: dir,
      env: { AGENT_DIR: hermit(dir) },
      args: ['note', hermit(dir), file.replace(/\.md$/, '')],
      stdin: 'Resumed\n',
    });
    expect(r.exitCode).toBe(0);
    const passed = await runStop(dir);
    expect(passed.stdout.trim()).toBe('');
  }));
});


test('DM old open record does not satisfy a new acknowledgement', withDir(async dir => {
  writeChats(dir, 'dm', 1);
  await openResident(dir, 'discord:dm');
  writeTurn(dir, new Date(Date.now() + 1000).toISOString());
  writeAck(dir, { chat_id: 'dm', at: new Date(Date.now() + 2000).toISOString() });
  const result = await runStop(dir);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).decision).toBe('block');
}));

test('two DM acknowledgements with two new records pass', withDir(async dir => {
  writeChats(dir, 'dm', 1);
  writeTurn(dir);
  writeAck(dir, { chat_id: 'dm' });
  writeAck(dir, { chat_id: 'dm' });
  await openResident(dir, 'discord:dm');
  await openResident(dir, 'discord:dm');
  const result = await runStop(dir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('');
}));

for (const scenario of ['opener', 'joined', 'plugin-recovery', 'typed-copy', 'blocked', 'guest'] as const) {
  test(`normal Stop clears only this turn's unfinished conversations: ${scenario}`, withDir(async dir => {
    const { markUnfinished, stillUnfinished } = await import('../scripts/lib/channel-recovery');
    fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ channels: { custom: { attributes: { thread_id: 'topic' } } } }));
    const key = 'custom:chat~one';
    markUnfinished(hermit(dir), key, new Date().toISOString());
    markUnfinished(hermit(dir), 'custom:unrelated', new Date().toISOString());
    fs.writeFileSync(hermit(dir, 'state/recovery-pending'), '');
    const recovery = '<command-name>/hermitd:channel-responder</command-name>\n<command-args>recover custom:chat~one</command-args>';
    const channel = '<channel source="custom" chat_id="chat" user="u1" topic="one">hello</channel>';
    const lines: unknown[] = [{ type: 'user', origin: scenario === 'plugin-recovery' ? { kind: 'plugin', name: 'hermitd' } : { kind: 'human' }, message: { role: 'user', content: scenario === 'plugin-recovery' || scenario === 'typed-copy' ? recovery : scenario === 'joined' ? 'work' : channel } }];
    if (scenario === 'joined') lines.push({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'channel' }, prompt: channel } });
    if (scenario === 'blocked') { writeTurn(dir); writeAck(dir); }
    if (scenario === 'guest') markGuest(hermit(dir, 'state'), SESSION_ID);
    const transcript = path.join(dir, 'recovery-turn.jsonl');
    fs.writeFileSync(transcript, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const result = await runStop(dir, JSON.stringify({ session_id: SESSION_ID, transcript_path: transcript, stop_hook_active: scenario !== 'blocked' }));
    expect(result.exitCode).toBe(0);
    expect(stillUnfinished(hermit(dir), key)).toBe(['typed-copy', 'blocked', 'guest'].includes(scenario));
    expect(stillUnfinished(hermit(dir), 'custom:unrelated')).toBe(true);
    expect(fs.existsSync(hermit(dir, 'state/recovery-pending'))).toBe(true);
  }));
}

import { markStarted, readUnfinished } from '../scripts/lib/routines/unfinished';
for (const kind of ['shell', 'monitor', 'subagent', 'unreachable', 'blocked', 'guest', 'empty']) {
  test(`routine normal end with ${kind}`, withDir(async dir => {
    markStarted(hermit(dir), { routine_id: 'r', skill: 'test:run', mark: 'm', delivery: 'monitor', session_id: SESSION_ID });
    const payload = JSON.parse(stopHookInput(dir));
    delete payload.background_tasks;
    if (kind !== 'unreachable') payload.background_tasks = kind === 'empty' ? [] : [{ type: kind, status: 'running' }];
    if (kind === 'blocked') { writeAck(dir); writeTurn(dir); }
    if (kind === 'guest') markGuest(hermit(dir, 'state'), SESSION_ID);
    await runStop(dir, JSON.stringify(payload));
    const entries = Object.values(readUnfinished(hermit(dir)));
    if (['shell', 'monitor', 'empty'].includes(kind)) expect(entries).toEqual([]);
    else expect(entries[0].state).toBe(kind === 'subagent' ? 'awaiting' : 'started');
  }));
}

test('a later Stop with no delegated work running settles an awaiting routine', withDir(async dir => {
  markStarted(hermit(dir), { routine_id: 'r', skill: 'test:run', mark: 'm', delivery: 'monitor', session_id: SESSION_ID });
  const payload = JSON.parse(stopHookInput(dir));
  payload.background_tasks = [{ type: 'subagent', status: 'running' }];
  await runStop(dir, JSON.stringify(payload));
  expect(Object.values(readUnfinished(hermit(dir)))[0].state).toBe('awaiting');
  payload.background_tasks = [];
  await runStop(dir, JSON.stringify(payload));
  expect(readUnfinished(hermit(dir))).toEqual({});
}));
