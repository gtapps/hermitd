import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { taskFixture } from './helpers/tasks';

test('a guild thread resolves from its record, before and after the worker handoff', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--owner', 'resident', '--conversation', 'discord:thread1', '--card', JSON.stringify({ chat_id: 'thread1', message_id: 'card1' })]);
    let list = await f.ok('list', ['--conversation', 'discord:thread1', '--open', '--json']);
    expect(list.rows.map((r: any) => r.id)).toEqual([id]);
    expect(list.rows[0].owner).toBe('resident');
    await f.ok('note', [id, '--owner', 'worker:a1b2c3d4e5f6a7b8c'], '');
    list = await f.ok('list', ['--conversation', 'discord:thread1', '--open', '--json']);
    expect(list.rows[0].owner).toBe('worker:a1b2c3d4e5f6a7b8c');
  } finally { f.cleanup(); }
});

for (const type of [0, 5, 1, 3, 10, 11, 12]) {
  test(`task open routes cached Discord type ${type}`, async () => {
    const f = taskFixture();
    try {
      f.put('state/channel-chats.json', { discord: { chats: { chat: {
        type, parent_id: null, guild_id: null, fetched_at: new Date().toISOString(),
      } } } });
      const result = await f.open(['--conversation', 'discord:chat']);
      if (type === 0 || type === 5) {
        expect(result).toEqual({ status: 'refused', reason: 'thread_required' });
        expect((await f.ok('list', ['--all', '--json'])).rows).toEqual([]);
      } else expect(result.id).toBeString();
    } finally { f.cleanup(); }
  });
}

for (const conversation of ['slack:chat', 'slack:chat~message', 'discord:chat~message', 'telegram:123', 'fakechat:123', 'discord:uncached', null]) {
  test(`task open handles conversation ${conversation}`, async () => {
    const f = taskFixture();
    try {
      if (conversation?.startsWith('slack:')) f.put('config.json', { channels: { slack: { attributes: { thread_id: 'thread_ts' } } } });
      const result = await f.open(conversation ? ['--conversation', conversation] : []);
      if (conversation === 'slack:chat') {
        expect(result).toEqual({ status: 'refused', reason: 'thread_required' });
        expect((await f.ok('list', ['--all', '--json'])).rows).toEqual([]);
      } else expect(result.id).toBeString();
      if (conversation === null) expect(fs.existsSync(path.join(f.dir, 'state/channel-chats.json'))).toBe(false);
    } finally { f.cleanup(); }
  });
}
