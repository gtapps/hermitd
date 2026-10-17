import { it, expect } from 'bun:test';
import { taskFixture } from './helpers/tasks';
import { search } from '../scripts/lib/search';

it('unscoped task recall includes the task path and created date', async () => { const f = taskFixture(); try { await f.open(['--title', 'Unique commitment']); const rows = search(f.dir, 'Unique commitment', {}); expect(rows[0]?.path).toMatch(/^tasks\//); expect(rows[0]?.date).toMatch(/^\d{4}-/); } finally { f.cleanup(); } });
it('scoped recall sees own and shared chat records but hides operator and other chat', async () => { const f = taskFixture(); try { f.put('config.json', { channels: { discord: { isolate_chats: true, shared_chats: ['c2'] } } }); await f.open(['--title', 'Unique own', '--conversation', 'discord:c1']); await f.open(['--title', 'Unique shared', '--conversation', 'discord:c2']); await f.open(['--title', 'Unique other', '--conversation', 'discord:c3']); await f.open(['--title', 'Unique operator']); const rows = search(f.dir, 'Unique', { chat: 'discord:c1' }); expect(rows.map(r => r.title).sort()).toEqual(['Unique own', 'Unique shared']); } finally { f.cleanup(); } });
