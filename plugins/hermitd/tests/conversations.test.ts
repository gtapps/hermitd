import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { logMessage } from '../scripts/lib/channel-log';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('conversations-');
afterAll(cleanup);

async function cli(dir: string, args: string[], env?: typeof process.env) {
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../scripts/conversation.ts'), dir, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env, AGENT_DIR: env?.AGENT_DIR ?? dir } });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

test('the channel library wrappers answer history and is-trusted', async () => {
  const dir = freshDir();
  const tokenDir = path.join(dir, 'discord');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    channels: { discord: { state_dir: tokenDir, allowed_users: ['u1'] } },
  }));
  for (const [i, text] of ['first', 'second', 'third'].entries()) {
    logMessage(dir, { source: 'discord', chat_id: '123', direction: i % 2 ? 'out' : 'in', sender: 'u1', text, ts: `2026-01-01T00:00:0${i}Z` });
  }
  const server = Bun.serve({ port: 0, fetch(req) {
    const route = new URL(req.url).pathname;
    if (route === '/channels/123') return Response.json({ parent_id: null, guild_id: '2', type: 0 });
    return new Response('', { status: 404 });
  } });
  const env = { HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, ''), DISCORD_STATE_DIR: tokenDir };
  const run = (...args: string[]) => cli(dir, args, env);
  try {
    const history = await run('history', '--source', 'discord', '--chat-id', '123', '--limit', '2');
    expect(history.code).toBe(0);
    expect(JSON.parse(history.stdout).rows.map((r: { text: string }) => r.text)).toEqual(['second', 'third']);
    expect(JSON.parse((await run('history', '--source', 'discord', '--chat-id', '999')).stdout)).toEqual({ rows: [] });
    expect(await run('history', '--source', 'discord')).toEqual({ stdout: '{"error":"missing_chat_id"}\n', code: 1 });
    expect(await run('history', '--source', 'discord', '--chat-id', '123', '--limit', '0')).toEqual({ stdout: '{"error":"invalid_limit"}\n', code: 1 });
    expect(await run('is-trusted', '--source', 'discord', '--user-id', 'u1', '--chat-id', '123')).toEqual({ stdout: 'OK\n', code: 0 });
    expect(await run('is-trusted', '--source', 'discord', '--user-id', 'u2', '--chat-id', '123')).toEqual({ stdout: '{"status":"untrusted"}\n', code: 0 });
    expect(await run('is-trusted', '--source', 'discord', '--user-id', 'u1', '--chat-id', '123', '--name', 'x')).toEqual({ stdout: '{"error":"invalid_options"}\n', code: 1 });
    for (const verb of ['bind', 'update', 'unbind', 'lookup', 'list', 'prune', 'helper-status', 'await-agent', 'chat-lookup', 'thread-create']) {
      expect(await run(verb, '--chat-id', '123')).toEqual({ stdout: '{"error":"unknown_verb"}\n', code: 1 });
    }
  } finally {
    server.stop(true);
  }
});

test("state dir must be this project's before reads or Discord requests", async () => {
  const ownDir = freshDir();
  const foreignDir = freshDir();
  expect(foreignDir).not.toBe(ownDir);
  const tokenDir = path.join(foreignDir, 'discord');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  // config.json plus state/ is a real foreign hermit root. Without state/ it reads
  // as a worktree projection, and the refusal would come from the walk-up rather
  // than the equality check this pins.
  fs.mkdirSync(path.join(foreignDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(foreignDir, 'config.json'), JSON.stringify({
    channels: { discord: { state_dir: tokenDir } },
  }));
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() {
    requests += 1;
    return Response.json({ id: '789' });
  } });
  const env = { AGENT_DIR: ownDir, HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, ''), DISCORD_STATE_DIR: tokenDir };
  try {
    expect(await cli(foreignDir, ['history', '--source', 'discord', '--chat-id', '123'], env)).toMatchObject({ stdout: expect.stringMatching(/^\{"error":"foreign_state_dir:/), code: 1 });
    expect(await cli(foreignDir, ['thread-open', '--source', 'discord', '--chat-id', '123', '--message-id', '9', '--name', 'x'], env)).toMatchObject({ stdout: expect.stringMatching(/^\{"error":"foreign_state_dir:/), code: 1 });
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
  }
});

// The production shape every skill uses: the literal `.hermit` resolved
// against the project root, with no AGENT_DIR. The pin must not reject it.
test('the literal .hermit from the project root passes the pin', async () => {
  const root = freshDir();
  const hermit = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  fs.writeFileSync(path.join(hermit, 'config.json'), '{}');
  const env = { ...process.env };
  delete env.AGENT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../scripts/conversation.ts'), '.hermit', 'history', '--source', 'discord', '--chat-id', '123'], { cwd: root, stdout: 'pipe', stderr: 'pipe', env });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect({ stdout, code }).toEqual({ stdout: '{"rows":[]}\n', code: 0 });
});


test('thread-open keys bind threaded messages without binding the top-level chat', async () => {
  const { parseChannelEnvelope } = await import('../scripts/lib/channel-envelope');
  const { isKey } = await import('../scripts/lib/conversation-key');
  const { mutateTask } = await import('../scripts/lib/tasks');
  const { run } = await import('../scripts/lib/prompt-stages/conversation');
  const dir = freshDir();
  const config = { channels: { slack: { attributes: { thread_id: 'thread_ts' } } } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const opened = await cli(dir, ['thread-open', '--source', 'slack', '--chat-id', 'C0123', '--message-id', '1712345678.123456', '--name', 'Threaded task']);
  expect(opened.code).toBe(0);
  const { key, ...rest } = JSON.parse(opened.stdout);
  expect(key).toBe('slack:C0123~1712345678.123456');
  expect(rest).toEqual({ chat_id: 'C0123', reply: { thread_ts: '1712345678.123456' } });
  expect(isKey(key)).toBe(true);
  mutateTask(dir, 'open', undefined, { owner: 'resident', requester: 'slack:U1', conversation: key, title: 'Threaded task', done: 'Task complete' }, '');
  const makeContext = (thread: string) => ({
    dir, prompt: '', envelope: parseChannelEnvelope(`<channel source="slack" chat_id="C0123" user_id="U1" ${thread}>hello</channel>`, config),
    transcriptPath: null, config: () => config, runtime: () => ({}),
  });
  const threaded = makeContext('thread_ts="1712345678.123456"');
  expect((await run(threaded))?.context).toContain(`task thread ${key}`);
  expect(await run(makeContext(''))).toBeUndefined();
  expect(await cli(dir, ['thread-open', '--source', 'other', '--chat-id', 'C1', '--message-id', 'M1', '--name', 'x'])).toEqual({ code: 0, stdout: '{"key":"other:C1","chat_id":"C1"}\n' });
});

test('thread-open routes every channel to the key its later thread messages carry', async () => {
  const { parseChannelEnvelope } = await import('../scripts/lib/channel-envelope');
  const { conversationKey } = await import('../scripts/lib/conversation-key');
  const dir = freshDir();
  const tokenDir = path.join(dir, 'discord');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  const config = { channels: {
    discord: { state_dir: tokenDir },
    telegram: { attributes: { thread_id: 'message_thread_id' } },
    imessage: {},
    slack: { attributes: { thread_id: 'thread_ts' } },
  } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  let dmReachable = false;
  const server = Bun.serve({ port: 0, fetch(req) {
    const route = new URL(req.url).pathname;
    if (route === '/channels/600') return dmReachable ? Response.json({ parent_id: null, guild_id: null, type: 1 }) : new Response('', { status: 503 });
    if (route === '/channels/100') return Response.json({ parent_id: null, guild_id: '2', type: 0 });
    if (route === '/channels/200') return Response.json({ parent_id: null, guild_id: '2', type: 5 });
    if (route === '/channels/300') return Response.json({ parent_id: null, guild_id: null, type: 1 });
    if (route === '/channels/100/messages/9/threads' && req.method === 'POST') return Response.json({ id: '789' });
    return new Response('', { status: 404 });
  } });
  const env = { HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, ''), DISCORD_STATE_DIR: tokenDir };
  const open = async (...args: string[]) => {
    const { stdout, code } = await cli(dir, ['thread-open', ...args], env);
    return { code, out: JSON.parse(stdout) };
  };
  const envelopeKey = (source: string, attrs: string) => {
    const e = parseChannelEnvelope(`<channel source="${source}" ${attrs} user_id="U1">hi</channel>`, config)!;
    return conversationKey(e.sourceKey, e.chatId, e.thread);
  };
  try {
    expect(await open('--source', 'discord', '--chat-id', '100', '--message-id', '9', '--name', 'Task')).toEqual({ code: 0, out: { key: 'discord:789', chat_id: '789' } });
    expect(await open('--source', 'discord', '--chat-id', '300', '--message-id', '9', '--name', 'Task')).toEqual({ code: 0, out: { key: 'discord:300', chat_id: '300' } });
    expect(await open('--source', 'discord', '--chat-id', '200', '--message-id', '8', '--name', 'Task')).toEqual({ code: 1, out: { error: 'thread_failed' } });
    expect(await open('--source', 'discord', '--chat-id', '404', '--message-id', '9', '--name', 'Task')).toEqual({ code: 1, out: { error: 'lookup_failed' } });
    // A cached failure does not hold task opens back once Discord answers again.
    expect(await open('--source', 'discord', '--chat-id', '600', '--message-id', '9', '--name', 'Task')).toEqual({ code: 1, out: { error: 'lookup_failed' } });
    dmReachable = true;
    expect(await open('--source', 'discord', '--chat-id', '600', '--message-id', '9', '--name', 'Task')).toEqual({ code: 0, out: { key: 'discord:600', chat_id: '600' } });

    const telegram = await open('--source', 'telegram', '--chat-id', '-1001', '--message-id', '55', '--thread-id', '7', '--name', 'Task');
    expect(telegram).toEqual({ code: 0, out: { key: 'telegram:-1001~7', chat_id: '-1001', reply: { message_thread_id: '7' } } });
    expect(telegram.out.key).toBe(envelopeKey('telegram', 'chat_id="-1001" message_thread_id="7"'));

    const imessage = await open('--source', 'imessage', '--chat-id', 'iMessage;-;+1555', '--message-id', 'M1', '--name', 'Task');
    expect(imessage).toEqual({ code: 0, out: { key: 'imessage:iMessage;-;+1555', chat_id: 'iMessage;-;+1555' } });
    expect(imessage.out.key).toBe(envelopeKey('imessage', 'chat_id="iMessage;-;+1555"'));

    const slack = await open('--source', 'slack', '--chat-id', 'C1', '--message-id', '1.2', '--thread-id', '0.9', '--name', 'Task');
    expect(slack.out).toEqual({ key: 'slack:C1~0.9', chat_id: 'C1', reply: { thread_ts: '0.9' } });
    expect(slack.out.key).toBe(envelopeKey('slack', 'chat_id="C1" thread_ts="0.9"'));

    expect(await open('--source', 'slack', '--chat-id', 'C1', '--message-id', '1.2')).toEqual({ code: 1, out: { error: 'missing_name' } });
  } finally {
    server.stop(true);
  }
});
