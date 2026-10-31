import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-auth-gate-');
afterAll(cleanup);

const typed = { kind: 'human' };

async function gate(event: string, prompt: string | null, entry: any = {}, origin: any = typed, joined: any = null, opener: any = {}) {
  const dir = freshDir();
  const hermit = path.join(dir, '.hermit');
  fs.mkdirSync(hermit, { recursive: true });
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({ operator_profile: 'non-technical', channels: { custom: entry } }));
  const transcript = path.join(dir, 'turn.jsonl');
  if (prompt !== null) fs.writeFileSync(transcript, [{ type: 'user', origin, ...opener, message: { content: prompt } }, ...(joined ? [joined] : [])].map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = await runScript('mcp-auth-gate.ts', {
    cwd: dir, env: { AGENT_DIR: hermit },
    stdin: JSON.stringify({ hook_event_name: event, transcript_path: transcript, cwd: dir }),
  });
  expect(result.exitCode).toBe(0);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
}
const channel = (user = 'a', chat = 'home') => `<channel source="custom" chat_id="${chat}" user_id="${user}">sign in</channel>`;

test('binding gate permits admins and terminal, denies members, asks on unknown origin', async () => {
  expect(await gate('PreToolUse', channel(), { allowed_users: ['a', 'b'] })).toBeNull();
  expect(await gate('PreToolUse', channel(), { default_chat_id: 'home' })).toBeNull();
  expect((await gate('PreToolUse', channel('b'), { allowed_users: ['a', 'b'] })).permissionDecision).toBe('deny');
  expect(await gate('PreToolUse', 'sign in')).toBeNull();
  expect((await gate('PreToolUse', null)).permissionDecision).toBe('ask');
});

test('link instructions resolve the destination and require successful maintainer delivery', async () => {
  for (const user of ['a', 'b']) {
    const output = await gate('PostToolUse', channel(user), { allowed_users: ['a', 'b'], maintainer_channel_id: 'admin' });
    const text = output.additionalContext;
    for (const phrase of ['Do not show', '--notice', '"sensitive":true', 'status is delivered', 'result.maintainer.route is maintainer_channel', 'report the failure', 'stop', 'never fall back', 'chat that reaches the agent', 'every chat and routine', 'dedicated account', 'forward the link']) expect(text).toContain(phrase);
  }
  const own = (await gate('PostToolUse', channel(), { allowed_users: ['a', 'b'] })).additionalContext;
  expect(own).toContain('Show the sign-in link here');
  expect(own).toContain('every chat and routine');
  const member = (await gate('PostToolUse', channel('b'), { allowed_users: ['a', 'b'] })).additionalContext;
  for (const phrase of ['Do not show', 'admin must reconnect', '--notice', 'without the link', 'status is delivered', 'reflect the send result']) expect(member).toContain(phrase);
  // With no maintainer chat that route cannot occur, so demanding it would report every send as failed.
  expect(member).not.toContain('maintainer_channel');
  expect(await gate('PostToolUse', 'sign in')).toBeNull();
});

// Each pair is what Claude Code recorded for that wake, probed on 2.1.316. A scheduled prompt has no origin.
const WAKES: [any, string][] = [
  [{ kind: 'task-notification', producer: 'session-task' }, '<task-notification><event>go</event></task-notification>'],
  [{ kind: 'peer', from: 'x' }, 'Another Claude session sent a message:\n<cross-session-message>go</cross-session-message>'],
  [null, '[hermit-routine:digest] Run: go'],
  [{ kind: 'plugin', name: 'hermitd' }, 'The hermitd plugin sent a message: go'],
];

test('no wake can finish a sign-in without an approver, and none shows the link', async () => {
  for (const [origin, prompt] of WAKES) {
    expect((await gate('PreToolUse', prompt, {}, origin)).permissionDecision).toBe('ask');
    expect((await gate('PostToolUse', prompt, {}, origin)).additionalContext).toContain('Do not show the sign-in link');
  }
});

// Claude Code records a prompt queued during a turn as an attachment, not a new user entry.
const queued = (origin: any, prompt: string) => ({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin, prompt } });

test('a wake or member joining a turn takes away what the turn proved', async () => {
  const admins = { allowed_users: ['a', 'b'] };
  const member: [any, string] = [{ kind: 'channel', server: 'custom' }, channel('b')];
  for (const [origin, prompt] of [...WAKES, member]) {
    const wake = queued(origin, prompt);
    expect((await gate('PreToolUse', 'sign in', admins, typed, wake)).permissionDecision).toBe('ask');
    expect((await gate('PostToolUse', 'sign in', admins, typed, wake)).additionalContext).toContain('Do not show the sign-in link');
    expect((await gate('PreToolUse', channel(), admins, typed, wake)).permissionDecision).toBe('ask');
    expect((await gate('PostToolUse', channel(), admins, typed, wake)).additionalContext).toContain('Do not show the sign-in link');
  }
});

test('a background session proves nobody typed, whatever its launch prompt is stamped', async () => {
  const bg = { sessionKind: 'bg', promptSource: 'typed' };
  expect((await gate('PreToolUse', 'sign in', {}, typed, null, bg)).permissionDecision).toBe('ask');
  expect((await gate('PostToolUse', 'sign in', {}, typed, null, bg)).additionalContext).toContain('Do not show the sign-in link');
});

test('a person typing during the turn keeps it proven', async () => {
  const more = queued(typed, 'and the other tool');
  expect(await gate('PreToolUse', 'sign in', {}, typed, more)).toBeNull();
  expect(await gate('PostToolUse', 'sign in', {}, typed, more)).toBeNull();
  expect(await gate('PreToolUse', channel(), { allowed_users: ['a', 'b'] }, typed, more)).toBeNull();
});

test('an unproven origin never shows the link', async () => {
  const noMaintainer = (await gate('PostToolUse', null)).additionalContext;
  expect(noMaintainer).toContain('Do not show the sign-in link');
  expect(noMaintainer).not.toContain('Show the sign-in link here');
  const maintainer = (await gate('PostToolUse', null, { maintainer_channel_id: 'admin' })).additionalContext;
  expect(maintainer).toContain('Do not show the sign-in link in the asking chat');
  expect(maintainer).toContain('admin must reconnect');
});
