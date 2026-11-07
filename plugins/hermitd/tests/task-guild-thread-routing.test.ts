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

for (const conversation of ['discord:thread1', 'slack:chat~m1', 'telegram:123', 'discord:dm1']) {
  test(`second open and closed-thread reuse for ${conversation}`, async () => {
    const f = taskFixture();
    try {
      f.put('state/channel-chats.json', { discord: { chats: {
        thread1: { type: 11, parent_id: 'parent', guild_id: 'guild', fetched_at: new Date().toISOString() },
        dm1: { type: 1, parent_id: null, guild_id: null, fetched_at: new Date().toISOString() },
      } } });
      const args = ['--conversation', conversation];
      const first = await f.open([...args, '--dedupe-key', 'same']);
      expect((await f.open([...args, '--dedupe-key', 'same'])).id).toBe(first.id);
      const second = await f.open(args);
      if (conversation === 'telegram:123' || conversation === 'discord:dm1') expect(second.id).toBeString();
      else {
        expect(second).toEqual({ status: 'refused', reason: 'thread_busy' });
        expect((await f.ok('list', ['--all', '--json'])).rows).toHaveLength(1);
        await f.ok('cancel', [first.id, '--actor', 'operator', '--reason-stdin'], 'Done');
        expect((await f.open(args)).id).toBeString();
      }
    } finally { f.cleanup(); }
  });
}

test('concurrent opens on one thread write only one record', async () => {
  const f = taskFixture();
  try {
    const results = await Promise.all([f.open(['--conversation', 'slack:chat~m1']), f.open(['--conversation', 'slack:chat~m1'])]);
    expect(results.filter(r => r.id)).toHaveLength(1);
    expect(results.filter(r => r.reason === 'thread_busy')).toHaveLength(1);
    expect((await f.ok('list', ['--all', '--json'])).rows).toHaveLength(1);
  } finally { f.cleanup(); }
});


for (const questionFirst of [false, true]) test('agent questions coexist with thread work, question first=' + questionFirst, async () => {
  const f = taskFixture(); try {
    f.put('state/channel-chats.json', { discord: { chats: { thread: { type: 11, parent_id: 'parent', fetched_at: new Date().toISOString() } } } });
    const question = ['--requester', 'agent', '--conversation', 'discord:thread', '--waiting-on', 'chat', '--decision', JSON.stringify({ purpose: 'input', authority: 'chat', generation: 1 })];
    const work = ['--conversation', 'discord:thread'];
    const a = await f.open(questionFirst ? question : work);
    const b = await f.open(questionFirst ? work : question);
    expect(a.id).toBeString();
    expect(b.id).toBeString();
    expect((await f.ok('list', ['--all', '--json'])).rows).toHaveLength(2);
  } finally { f.cleanup(); }
});
