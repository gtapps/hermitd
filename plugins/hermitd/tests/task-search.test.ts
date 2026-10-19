import { it, expect } from 'bun:test';
import { taskFixture } from './helpers/tasks';
import { search } from '../scripts/lib/search';

it('unscoped task recall includes the task path and created date', async () => { const f = taskFixture(); try { await f.open(['--title', 'Unique commitment']); const rows = search(f.dir, 'Unique commitment', {}); expect(rows[0]?.path).toMatch(/^tasks\//); expect(rows[0]?.date).toMatch(/^\d{4}-/); } finally { f.cleanup(); } });
it('scoped recall sees own and shared chat records but hides operator and other chat', async () => { const f = taskFixture(); try { f.put('config.json', { channels: { discord: { isolate_chats: true, shared_chats: ['c2'] } } }); await f.open(['--title', 'Unique own', '--conversation', 'discord:c1']); await f.open(['--title', 'Unique shared', '--conversation', 'discord:c2']); await f.open(['--title', 'Unique other', '--conversation', 'discord:c3']); await f.open(['--title', 'Unique operator']); const rows = search(f.dir, 'Unique', { chat: 'discord:c1' }); expect(rows.map(r => r.title).sort()).toEqual(['Unique own', 'Unique shared']); } finally { f.cleanup(); } });

it('thread recall includes parent pages, tasks and channel log, with no sibling access', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { logMessage } = await import('../scripts/lib/channel-log');
  const f = taskFixture();
  try {
    f.put('config.json', { channels: { discord: {} } });
    fs.mkdirSync(path.join(f.dir, 'compiled'));
    f.put('state/channel-chats.json', { discord: { chats: { thread: { type: 11, parent_id: 'parent', fetched_at: new Date().toISOString() } } } });
    for (const chat of ['thread', 'parent', 'sibling']) {
      fs.writeFileSync(path.join(f.dir, 'compiled', `${chat}.md`), `---\ntitle: Unique page ${chat}\naudience: discord:${chat}\n---\nUnique ${chat} content\n`);
      await f.open(['--title', `Unique task ${chat}`, '--conversation', `discord:${chat}`]);
      expect(logMessage(f.dir, { source: 'discord', chat_id: chat, direction: 'in', text: `Unique log ${chat}` }).ok).toBe(true);
    }
    const rows = search(f.dir, 'Unique', { chat: 'discord:thread', limit: 30 });
    expect(rows.filter(r => r.source === 'file').map(r => r.title).sort()).toEqual(['Unique page parent', 'Unique page thread', 'Unique task parent', 'Unique task thread']);
    expect(rows.filter(r => r.source === 'channel').map(r => r.text).sort()).toEqual(['Unique log parent', 'Unique log thread']);
    const parent = search(f.dir, 'Unique', { chat: 'discord:parent', limit: 30 });
    expect(parent.filter(r => r.source === 'file').map(r => r.title).sort()).toEqual(['Unique page parent', 'Unique task parent']);
    expect(parent.filter(r => r.source === 'channel').map(r => r.text)).toEqual(['Unique log parent']);
  } finally { f.cleanup(); }
});

it('recall CLI lazily looks up Discord thread metadata and stays scoped on lookup failure', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { runScript } = await import('./helpers/run');
  const f = taskFixture();
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(req) {
    const route = new URL(req.url).pathname;
    requests.push(route);
    return route.endsWith('/missing') ? Response.json({ code: 10003 }, { status: 404 })
      : Response.json({ type: 11, parent_id: 'parent' });
  } });
  try {
    fs.mkdirSync(path.join(f.dir, 'compiled'));
    const state = path.join(f.dir, 'discord');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
    f.put('config.json', { channels: { discord: { state_dir: state } } });
    fs.writeFileSync(path.join(f.dir, 'compiled', 'parent.md'), '---\ntitle: Unique parent\naudience: discord:parent\n---\nUnique parent\n');
    for (const chat of ['thread', 'thread', 'missing']) {
      const result = await runScript('search.ts', { args: [f.dir, `--chat=discord:${chat}`, 'Unique'], env: { HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, '') } });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).hits.map((r: any) => r.title)).toEqual(chat === 'thread' ? ['Unique parent'] : []);
    }
    expect(requests).toEqual(['/channels/thread', '/channels/missing']);
  } finally { server.stop(true); f.cleanup(); }
});
