import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { freshDirFactory } from './helpers/workdir';
import { runScript } from './helpers/run';
const { freshDir, cleanup } = freshDirFactory('channel-preflight-');
afterAll(cleanup);
async function check(channel: string, body: any, status = 200, token = 'private-token') {
  const dir = freshDir();
  const state = path.join(dir, 'channel');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { [channel]: { state_dir: state } } }));
  if (token) fs.writeFileSync(path.join(state, '.env'), `${channel.toUpperCase()}_BOT_TOKEN=${token}\n`);
  const server = Bun.serve({ port: 0, fetch(req) {
    if (channel === 'discord') expect(new URL(req.url).pathname).toBe('/applications/@me');
    return Response.json(body, { status });
  } });
  try {
    const r = await runScript('channel-preflight.ts', { args: [dir, channel], env: {
      [`HERMIT_DOCTOR_${channel.toUpperCase()}_API`]: server.url.origin,
      [`${channel.toUpperCase()}_STATE_DIR`]: state,
    } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('private-token');
    return JSON.parse(r.stdout);
  } finally { server.stop(true); }
}
test('Telegram validates token and rejects missing or rejected tokens', async () => {
  expect(await check('telegram', { ok: true })).toMatchObject({ status: 'ready' });
  expect(await check('telegram', {}, 401)).toMatchObject({ status: 'action_needed', reason: 'token_rejected' });
  expect(await check('telegram', {}, 404)).toMatchObject({ status: 'action_needed', reason: 'token_rejected' });
  expect(await check('telegram', {}, 200, '')).toMatchObject({ status: 'action_needed', reason: 'no_token' });
});
test('Discord checks either message-content bit and reports invite warnings', async () => {
  for (const bit of [18, 19]) expect(await check('discord', { id: '123', flags: 1 << bit, bot_public: true })).toMatchObject({ status: 'ready', warnings: ['bot_public', 'no_guilds'], invite: expect.stringContaining('client_id=123&scope=bot&permissions=274878008384') });
  expect(await check('discord', { id: '123', flags: 0 })).toMatchObject({ status: 'action_needed', reason: 'message_content_intent_off' });
});
test('unknown channel is explicitly unchecked', async () => {
  expect(await check('custom', {})).toMatchObject({ status: 'not_checked' });
});

test('two-way evidence must match the home chat', async () => {
  const { preflight } = await import('../scripts/channel-preflight');
  const dir = freshDir(); fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { custom: { default_chat_id: 'HOME' } } }));
  for (const chat_id of ['OTHER', 'HOME']) {
    fs.writeFileSync(path.join(dir, 'state/channel-activity.json'), JSON.stringify({ custom: { last_inbound_reply: { chat_id, at: new Date().toISOString() } } }));
    expect((await preflight(dir, 'custom')).two_way).toBe(chat_id === 'HOME' ? 'proven' : 'not_proven');
  }
});

test('two-way evidence older than the saved token does not count', async () => {
  const { preflight } = await import('../scripts/channel-preflight');
  const dir = freshDir(); fs.mkdirSync(path.join(dir, 'state'));
  const state = path.join(dir, 'channel'); fs.mkdirSync(state);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { custom: { default_chat_id: 'HOME', state_dir: state } } }));
  fs.writeFileSync(path.join(state, '.env'), 'CUSTOM_BOT_TOKEN=new\n');
  const saved = fs.statSync(path.join(state, '.env')).mtimeMs;
  for (const [offset, expected] of [[-60000, 'not_proven'], [60000, 'proven']] as const) {
    fs.writeFileSync(path.join(dir, 'state/channel-activity.json'), JSON.stringify({ custom: { last_inbound_reply: { chat_id: 'HOME', at: new Date(saved + offset).toISOString() } } }));
    expect((await preflight(dir, 'custom')).two_way).toBe(expected);
  }
});
