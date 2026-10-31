import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-auth-gate-');
afterAll(cleanup);

async function gate(event: string, prompt: string | null, entry: any = {}) {
  const dir = freshDir();
  const hermit = path.join(dir, '.hermit');
  fs.mkdirSync(hermit, { recursive: true });
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({ operator_profile: 'non-technical', channels: { custom: entry } }));
  const transcript = path.join(dir, 'turn.jsonl');
  if (prompt !== null) fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: prompt } }) + '\n');
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
  for (const phrase of ['Do not show', 'admin must reconnect', '--notice', 'without the link', 'reflect the send result']) expect(member).toContain(phrase);
  expect(await gate('PostToolUse', 'sign in')).toBeNull();
  expect(await gate('PostToolUse', null)).toBeNull();
});
