import { it, expect } from 'bun:test';
import { taskFixture } from './helpers/tasks';
import { loadDashboardState, renderCoreSections } from '../scripts/lib/dashboard';

it('missing tasks renders the by-person empty state', () => { const f = taskFixture(); try { const state: any = loadDashboardState(f.dir); expect(state.by_person).toEqual([]); expect((renderCoreSections(state) as any).by_person).toContain('No open tasks'); } finally { f.cleanup(); } });
it('renders promised late waiting work with escaped names', async () => { const f = taskFixture(); try { const { id } = await f.open(['--requester-name', '<script>Person</script>', '--due', '2020-01-01T00:00:00Z']); await f.ok('block', [id, '--waiting-on', 'discord:u2', '--status-line', 'Waiting', '--next', 'Reply']); const state: any = loadDashboardState(f.dir); expect(state.by_person[0].promised.length).toBe(1); const html = (renderCoreSections(state) as any).by_person; expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>Person'); expect(html).toContain('Waiting'); expect(html).toContain('Late'); } finally { f.cleanup(); } });
