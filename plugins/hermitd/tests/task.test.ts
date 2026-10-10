import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture, taskLib } from './helpers/tasks';
import { runScript } from './helpers/run';

it('round-trips every key including a title with double quotes and a backslash', async () => {
  const f = taskFixture(); try {
    const title = 'Review "ready" at C:\\work';
    const { id } = await f.open(['--title', title]);
    const lib = await taskLib(); const record = lib.decodeTask(f.text(id));
    expect(record.title).toBe(title);
    expect(lib.decodeTask(lib.encodeTask(record))).toEqual(record);
    expect(Object.keys(record).length).toBeGreaterThan(30);
  } finally { f.cleanup(); }
});
it('rejects malformed records with a stable error', async () => { const lib = await taskLib(); expect(() => lib.decodeTask('---\nid: bad\n---\n')).toThrow('invalid-record'); });
it('uses timestamp ids and a single base36 suffix on collision', async () => {
  const lib = await taskLib(); const now = '2026-09-14T12:34:56.000Z';
  expect(lib.allocateTaskId([], now)).toBe('T-20260914-123456');
  expect(lib.allocateTaskId(['T-20260914-123456'], now)).toMatch(/^T-20260914-123456-[a-z0-9]$/);
});
it('concurrent opens produce distinct ids', async () => { const f = taskFixture(); try { const rows = await Promise.all([f.open(), f.open()]); expect(rows[0].id).not.toBe(rows[1].id); } finally { f.cleanup(); } });
it('replayed dedupe returns the existing open record', async () => { const f = taskFixture(); try { const a = await f.open(['--dedupe-key', 'duty:heartbeat:item']); const b = await f.open(['--dedupe-key', 'duty:heartbeat:item']); expect(b.id).toBe(a.id); expect(b.created).toBe(false); expect(b.open_count).toBe(1); } finally { f.cleanup(); } });
it('note appends progress and done bumps revision and clears result', async () => { const f = taskFixture(); try { const { id } = await f.open(); await f.ok('note', [id], 'Milestone reached'); expect(f.text(id)).toContain('Milestone reached'); await f.ok('block', [id, '--result-stdin'], 'Ready'); const r = await f.ok('note', [id, '--done', 'New definition', '--actor', 'discord:u2']); expect(r.result_rev).toBe(2); const lib = await taskLib(); expect(lib.decodeTask(f.text(id)).result).toBeNull(); } finally { f.cleanup(); } });
for (const approver of [null, 'discord:u2']) it(`result waits on ${approver ?? 'requester'}`, async () => { const f = taskFixture(); try { const { id } = await f.open(approver ? ['--approver', approver] : []); expect(await f.ok('block', [id, '--result-stdin'], 'Ready')).toMatchObject({ listing: 'unconfirmed', result_rev: 1, waiting_on: approver ?? 'discord:u1' }); } finally { f.cleanup(); } });
it('stall needs both fields and names the post destination', async () => { const f = taskFixture(); try { const { id } = await f.open(['--conversation', 'discord:c1']); expect((await f.run('block', [id, '--waiting-on', 'discord:u2'])).stderr).toContain('stall-needs-status-and-next'); expect(await f.ok('block', [id, '--waiting-on', 'discord:u2', '--status-line', 'Need access', '--next', 'Grant access'])).toMatchObject({ post_to: { conversation: 'discord:c1', requester: 'discord:u1' }, status_line: 'Need access', next_step: 'Grant access' }); } finally { f.cleanup(); } });
it('caps listing, preserves totals and returns exact handles and ids beyond the cap', async () => { const f = taskFixture(); try { let last: any; for (let i = 0; i < 22; i++) last = await f.open(['--title', `Task ${i}`]); const list = await f.ok('list'); expect(list.rows).toHaveLength(20); expect(list.total).toBe(22); expect(list.omitted).toBe(2); for (const flag of ['--handle', '--id']) { const exact = await f.ok('list', [flag, flag === '--id' ? last.id : last.handle]); expect(exact.rows[0]).toMatchObject({ id: last.id, result_rev: 0 }); } } finally { f.cleanup(); } });
it('standup groups stable identities and displays late and waiting work with split costs and runnable queue ordering', async () => { const f = taskFixture(); try { const a = await f.open(['--due', '2020-01-01T00:00:00Z', '--requester-name', 'Person']); const b = await f.open(); await f.ok('block', [a.id, '--waiting-on', 'discord:u2', '--status-line', 'Waiting', '--next', 'Reply']); fs.writeFileSync(path.join(f.dir, '../.claude/cost-log.jsonl'), JSON.stringify({ task_id: a.id, task_ids: [a.id, b.id], bucket: 'tasks', estimated_cost_usd: 2, timestamp: new Date().toISOString() }) + '\n'); const result = await f.ok('standup'); const person = result.byPerson.find((p: any) => p.identity === 'discord:u1'); expect(person.name).toBe('Person'); expect(person.promised[0].id).toBe(a.id); expect(person.late[0].listing).toContain('late'); expect(person.promised[0].cost_usd).toBe(1); expect(person.promised[1].cost_usd).toBe(1); expect(person.promised[1].listing).not.toContain('queued'); expect(result.byPerson.find((p: any) => p.identity === 'discord:u2').waiting[0].id).toBe(a.id); } finally { f.cleanup(); } });
it('foreign root exits 2 before reading', async () => { const f = taskFixture(); try { const r = await runScript('task.ts', { args: ['list', '/nonexistent/foreign'], env: { AGENT_DIR: f.dir }, cwd: f.dir }); expect(r.exitCode).toBe(2); expect(r.stdout).toBe(''); } finally { f.cleanup(); } });
it('open note block and close leave session and other ledgers byte-identical', async () => { const f = taskFixture(); try { fs.writeFileSync(path.join(f.dir, 'state/hypotheses.jsonl'), ''); fs.writeFileSync(path.join(f.dir, 'sessions', 'SHELL.md'), 'frozen'); const files = ['state/runtime.json', 'sessions/SHELL.md', 'state/hypotheses.jsonl']; const before = files.map(p => fs.readFileSync(path.join(f.dir, p), 'utf8')); const { id } = await f.open(); await f.ok('note', [id], 'Progress'); await f.ok('block', [id, '--result-stdin'], 'Ready'); await f.ok('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', '--result-rev', '1', '--reason-stdin'], 'ok'); expect(files.map(p => fs.readFileSync(path.join(f.dir, p), 'utf8'))).toEqual(before); } finally { f.cleanup(); } });
it('hands a carded record to a worker and back', async () => { const f = taskFixture(); try { const lib = await taskLib(); const { id } = await f.open(['--card', JSON.stringify({ chat_id: 'c1', message_id: 'm1' })]); await f.ok('note', [id, '--owner', 'worker:a1b2c3d4e5f6a7b8c'], ''); let record = lib.decodeTask(f.text(id)); expect(record.owner).toBe('worker:a1b2c3d4e5f6a7b8c'); expect(record.card_chat_id).toBe('c1'); expect(record.card_message_id).toBe('m1'); await f.ok('note', [id, '--owner', 'worker:a2b2c3d4e5f6a7b8c'], ''); await f.ok('note', [id, '--owner', 'resident'], ''); record = lib.decodeTask(f.text(id)); expect(record.owner).toBe('resident'); expect((await f.run('note', [id, '--owner', 'helper:discord:c1'], '')).stderr).toContain('invalid-owner'); expect((await f.run('note', [id, '--owner', 'worker:*'], '')).stderr).toContain('invalid-owner'); expect((await f.run('note', [id, '--owner', 'worker:agent-1'], '')).stderr).toContain('invalid-owner'); } finally { f.cleanup(); } });
it('list json exposes stored card ids or null after a worker handoff', async () => { const f = taskFixture(); try { const carded = await f.open(['--card', JSON.stringify({ chat_id: 'c1', message_id: 'm1' })]); const plain = await f.open(); await f.ok('note', [carded.id, '--owner', 'worker:a1b2c3d4e5f6a7b8c'], ''); expect((await f.ok('list', ['--id', carded.id, '--json'])).rows[0]).toMatchObject({ card_chat_id: 'c1', card_message_id: 'm1' }); expect((await f.ok('list', ['--id', plain.id, '--json'])).rows[0]).toMatchObject({ card_chat_id: null, card_message_id: null }); } finally { f.cleanup(); } });
it('rejects a malformed helper owner at open and lists worker records by wildcard', async () => { const f = taskFixture(); try { expect((await f.run('open', ['--title', 'T', '--requester', 'discord:u1', '--done', 'D', '--owner', 'helper:discord:c1'])).stderr).toContain('invalid-owner'); const { id } = await f.open(['--owner', 'worker:a1b2c3d4e5f6a7b8c']); const list = await f.ok('list', ['--open', '--owner', 'worker:*', '--json']); expect(list.rows.map((r: any) => r.id)).toEqual([id]); } finally { f.cleanup(); } });
it('muted round-trips and a record without it decodes false', async () => { const f = taskFixture(); try { const lib = await taskLib(); const { id } = await f.open(); expect(lib.decodeTask(f.text(id)).muted).toBe(false); await f.ok('note', [id, '--muted', 'true'], ''); expect(lib.decodeTask(f.text(id)).muted).toBe(true); const file = path.join(f.dir, 'tasks', `${id}.md`); fs.writeFileSync(file, f.text(id).replace(/^muted: true\n/m, '')); expect(lib.decodeTask(f.text(id)).muted).toBe(false); } finally { f.cleanup(); } });

it('helper owners round-trip through open, note, list and thread lookup', async () => {
  const f = taskFixture(); try {
    const lib = await taskLib();
    const { id } = await f.open(['--owner', 'helper:Review_1.a-b', '--conversation', 'discord:c1']);
    expect(lib.decodeTask(f.text(id)).owner).toBe('helper:Review_1.a-b');
    expect(lib.threadRecords(f.dir).map((r: any) => r.id)).toEqual([id]);
    await f.ok('note', [id, '--owner', 'helper:next']);
    expect((await f.ok('list', ['--owner', 'helper:next', '--json'])).rows[0].id).toBe(id);
    expect((await f.ok('list', ['--owner', 'helper:Review_1.a-b'])).rows).toEqual([]);
  } finally { f.cleanup(); }
});
for (const owner of ['helper:discord:c1', 'helper:', 'helper:a b', 'helper:' + 'a'.repeat(65)]) it(`rejects malformed helper owner ${owner}`, async () => {
  const f = taskFixture(); try {
    const { id } = await f.open();
    for (const [verb, args] of [['open', ['--title', 'T', '--requester', 'discord:u1', '--done', 'D']], ['note', [id]], ['list', []]] as const) {
      const r = await f.run(verb, [...args, '--owner', owner]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('invalid-owner');
    }
  } finally { f.cleanup(); }
});
for (const owner of ['helper:review', 'worker:a1b2c3d4e5f6a7b8c']) it(`allows only one open record for ${owner}`, async () => {
  const f = taskFixture(); try {
    const first = await f.open(['--owner', owner]);
    const second = await f.open();
    await f.ok('note', [first.id, '--owner', owner]);
    expect((await f.run('open', ['--title', 'T', '--requester', 'discord:u1', '--done', 'D', '--owner', owner])).stderr).toContain('owner-busy');
    expect((await f.run('note', [second.id, '--owner', owner])).stderr).toContain('owner-busy');
    expect((await f.ok('list', ['--id', second.id])).rows[0].owner).toBe('resident');
    await f.ok('cancel', [first.id, '--actor', 'discord:u1', '--reason-stdin'], 'Cancelled');
    await f.ok('note', [second.id, '--owner', owner]);
  } finally { f.cleanup(); }
});
