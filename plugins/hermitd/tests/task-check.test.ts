import { test, expect } from 'bun:test';
import { taskFixture } from './helpers/tasks';
import { runScript } from './helpers/run';
import { decodeTask, mutateTask } from '../scripts/lib/tasks';

test('stored command closes by check and failing checks keep the task open', async () => {
  const f = taskFixture();
  try {
    for (const code of [1, 0]) {
      const { id } = await f.open(['--check', `printf proof; exit ${code}`]);
      const result = await runScript('task-check.ts', { cwd: f.dir + '/..', env: { AGENT_DIR: f.dir }, args: [id] });
      expect(result.exitCode).toBe(0);
      const record = decodeTask(f.text(id));
      expect(record.closed_by).toBe(code === 0 ? 'check' : null);
      expect(record.body).toContain('proof');
    }
  } finally { f.cleanup(); }
});

test('changing a check, its definition or status refuses the old snapshot', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--check', 'true']);
    const snapshot = await f.ok('check-snapshot', [id]);
    await f.ok('note', [id, '--check', 'false']);
    expect(() => mutateTask(f.dir, 'check-result', id, { 'result-rev': String(snapshot.result_rev), exit: '0', 'output-stdin': true }, 'proof')).toThrow('stale_check');
    await f.ok('note', [id, '--check', 'clear']);
    expect((await f.ok('list', ['--with-check'])).rows).toEqual([]);
    const { id: redefined } = await f.open(['--check', 'true']);
    await f.ok('note', [redefined, '--done', 'New definition', '--actor', 'discord:u1']);
    expect(decodeTask(f.text(redefined)).check).toBeNull();
    expect((await f.ok('list', ['--with-check'])).rows).toEqual([]);
    const { id: replaced } = await f.open(['--check', 'true']);
    await f.ok('note', [replaced, '--done', 'New definition', '--actor', 'discord:u1', '--check', 'false']);
    expect(decodeTask(f.text(replaced)).check).toBe('false');
    expect((await f.ok('list', ['--with-check'])).rows.map((row: { id: string }) => row.id)).toEqual([replaced]);
  } finally { f.cleanup(); }
});

test('task.ts exposes no check-result verb, so only a real check run closes by check', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--check', 'false']);
    const r = await f.run('check-result', [id, '--result-rev', '0', '--exit', '0', '--output-stdin'], 'proof');
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_verb' });
    expect(decodeTask(f.text(id)).status).toBe('open');
  } finally { f.cleanup(); }
});

test('a finishing record closes by check once its outcome is observed', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open();
    await f.ok('block', [id, '--result-stdin'], 'Approved, waiting for the merge');
    await f.ok('note', [id, '--check', 'printf merged', '--clear-waiting']);
    expect((await f.ok('list', ['--id', id])).rows[0].listing).toEqual(['finishing']);
    const result = await runScript('task-check.ts', { cwd: f.dir + '/..', env: { AGENT_DIR: f.dir }, args: [id] });
    expect(result.exitCode).toBe(0);
    expect(decodeTask(f.text(id)).closed_by).toBe('check');
  } finally { f.cleanup(); }
});
