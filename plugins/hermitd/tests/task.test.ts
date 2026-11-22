import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture, taskLib } from './helpers/tasks';
import { runScript } from './helpers/run';

it('clears only the matching wait and leaves stale notes byte-identical', async () => {
  const f = taskFixture(); try {
    const { id } = await f.open();
    await f.ok('block', [id, '--waiting-on', 'admin', '--status-line', 'Login', '--next', 'Hand back']);
    const before = f.text(id);
    const lib = await taskLib();
    const since = lib.decodeTask(before).waiting_since!;
    const stale = await f.run('note', [id, '--clear-waiting', '--if-waiting-since', 'old'], 'Must not append');
    expect(stale.exitCode).toBe(0);
    expect(JSON.parse(stale.stdout)).toEqual({ status: 'refused', reason: 'stale_wait' });
    expect(f.text(id)).toBe(before);
    await f.ok('note', [id, '--clear-waiting', '--if-waiting-since', since], 'Handed back');
    expect(lib.decodeTask(f.text(id)).waiting_since).toBeNull();
    const cleared = f.text(id);
    expect(JSON.parse((await f.run('note', [id, '--clear-waiting', '--if-waiting-since', since], 'Replay')).stdout).reason).toBe('stale_wait');
    expect(f.text(id)).toBe(cleared);
  } finally { f.cleanup(); }
});

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
it('rejects malformed records with a stable error', async () => { const lib = await taskLib(); expect(() => lib.decodeTask('---\nid: bad\n---\n')).toThrow('invalid_record'); });
it('uses timestamp ids and a single base36 suffix on collision', async () => {
  const lib = await taskLib(); const now = '2026-09-14T12:34:56.000Z';
  expect(lib.allocateTaskId([], now)).toBe('T-20260914-123456');
  expect(lib.allocateTaskId(['T-20260914-123456'], now)).toMatch(/^T-20260914-123456-[a-z0-9]$/);
});
it('concurrent opens produce distinct ids', async () => { const f = taskFixture(); try { const rows = await Promise.all([f.open(), f.open()]); expect(rows[0].id).not.toBe(rows[1].id); } finally { f.cleanup(); } });
it('replayed dedupe returns the existing open record', async () => { const f = taskFixture(); try { const a = await f.open(['--dedupe-key', 'duty:heartbeat:item']); const b = await f.open(['--dedupe-key', 'duty:heartbeat:item']); expect(b.id).toBe(a.id); expect(b.created).toBe(false); expect(b.open_count).toBe(1); } finally { f.cleanup(); } });
it('note appends progress and done bumps revision and clears result', async () => { const f = taskFixture(); try { const { id } = await f.open(); await f.ok('note', [id], 'Milestone reached'); expect(f.text(id)).toContain('Milestone reached'); await f.ok('block', [id, '--result-stdin'], 'Ready'); const r = await f.ok('note', [id, '--done', 'New definition', '--actor', 'discord:u2']); expect(r.result_rev).toBe(2); const lib = await taskLib(); expect(lib.decodeTask(f.text(id)).result).toBeNull(); } finally { f.cleanup(); } });
for (const approver of [null, 'discord:u2']) it(`result waits on ${approver ?? 'requester'}`, async () => { const f = taskFixture(); try { const { id } = await f.open(approver ? ['--approver', approver] : []); expect(await f.ok('block', [id, '--result-stdin'], 'Ready')).toMatchObject({ listing: 'unconfirmed', result_rev: 1, waiting_on: approver ?? 'discord:u1' }); } finally { f.cleanup(); } });
it('stall needs both fields and names the post destination', async () => { const f = taskFixture(); try { const { id } = await f.open(['--conversation', 'discord:c1']); expect((await f.run('block', [id, '--waiting-on', 'discord:u2'])).stdout).toContain('stall_needs_status_and_next'); expect(await f.ok('block', [id, '--waiting-on', 'discord:u2', '--status-line', 'Need access', '--next', 'Grant access'])).toMatchObject({ post_to: { conversation: 'discord:c1', requester: 'discord:u1' }, status_line: 'Need access', next_step: 'Grant access' }); } finally { f.cleanup(); } });
it('caps listing, preserves totals and returns exact handles and ids beyond the cap', async () => { const f = taskFixture(); try { let last: any; for (let i = 0; i < 22; i++) last = await f.open(['--title', `Task ${i}`]); const list = await f.ok('list'); expect(list.rows).toHaveLength(20); expect(list.total).toBe(22); expect(list.omitted).toBe(2); for (const flag of ['--handle', '--id']) { const exact = await f.ok('list', [flag, flag === '--id' ? last.id : last.handle]); expect(exact.rows[0]).toMatchObject({ id: last.id, result_rev: 0 }); } } finally { f.cleanup(); } });
it('standup groups stable identities and displays late and waiting work with split costs and runnable queue ordering', async () => { const f = taskFixture(); try { const a = await f.open(['--due', '2020-01-01T00:00:00Z', '--requester-name', 'Person']); const b = await f.open(); await f.ok('block', [a.id, '--waiting-on', 'discord:u2', '--status-line', 'Waiting', '--next', 'Reply']); fs.writeFileSync(path.join(f.dir, '../.claude/cost-log.jsonl'), JSON.stringify({ task_id: a.id, task_ids: [a.id, b.id], bucket: 'tasks', estimated_cost_usd: 2, timestamp: new Date().toISOString() }) + '\n'); const result = await f.ok('standup'); const person = result.by_person.find((p: any) => p.identity === 'discord:u1'); expect(person.name).toBe('Person'); expect(person.promised[0].id).toBe(a.id); expect(person.late[0].listing).toContain('late'); expect(person.promised[0].cost_usd).toBe(1); expect(person.promised[1].cost_usd).toBe(1); expect(person.promised[1].listing).not.toContain('queued'); expect(result.by_person.find((p: any) => p.identity === 'discord:u2').waiting[0].id).toBe(a.id); } finally { f.cleanup(); } });
it('foreign root exits 1 before reading', async () => { const f = taskFixture(); try { const r = await runScript('task.ts', { args: ['list', '/nonexistent/foreign'], env: { AGENT_DIR: f.dir }, cwd: f.dir }); expect(r.exitCode).toBe(1); expect(JSON.parse(r.stdout)).toEqual({ error: `foreign_state_dir:${f.dir}` }); } finally { f.cleanup(); } });
it('open note block and close leave session and other ledgers byte-identical', async () => { const f = taskFixture(); try { fs.writeFileSync(path.join(f.dir, 'state/hypotheses.jsonl'), ''); fs.writeFileSync(path.join(f.dir, 'sessions', 'SHELL.md'), 'frozen'); const files = ['state/runtime.json', 'sessions/SHELL.md', 'state/hypotheses.jsonl']; const before = files.map(p => fs.readFileSync(path.join(f.dir, p), 'utf8')); const { id } = await f.open(); await f.ok('note', [id], 'Progress'); await f.ok('block', [id, '--result-stdin'], 'Ready'); await f.ok('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', '--result-rev', '1', '--reason-stdin'], 'ok'); expect(files.map(p => fs.readFileSync(path.join(f.dir, p), 'utf8'))).toEqual(before); } finally { f.cleanup(); } });
it('hands a carded record to a worker and back', async () => { const f = taskFixture(); try { const lib = await taskLib(); const { id } = await f.open(['--card', JSON.stringify({ chat_id: 'c1', message_id: 'm1' })]); await f.ok('note', [id, '--owner', 'worker:a1b2c3d4e5f6a7b8c'], ''); let record = lib.decodeTask(f.text(id)); expect(record.owner).toBe('worker:a1b2c3d4e5f6a7b8c'); expect(record.card_chat_id).toBe('c1'); expect(record.card_message_id).toBe('m1'); await f.ok('note', [id, '--owner', 'worker:a2b2c3d4e5f6a7b8c'], ''); await f.ok('note', [id, '--owner', 'resident'], ''); record = lib.decodeTask(f.text(id)); expect(record.owner).toBe('resident'); expect((await f.run('note', [id, '--owner', 'helper:discord:c1'], '')).stdout).toContain('invalid_owner'); expect((await f.run('note', [id, '--owner', 'worker:*'], '')).stdout).toContain('invalid_owner'); expect((await f.run('note', [id, '--owner', 'worker:agent-1'], '')).stdout).toContain('invalid_owner'); } finally { f.cleanup(); } });
it('remembers worker owners on handoff and preserves them on other owner changes', async () => {
  const f = taskFixture(); try {
    const lib = await taskLib();
    const { id } = await f.open();
    const record = () => lib.decodeTask(f.text(id));
    expect(record().last_worker).toBeNull();
    await f.ok('note', [id, '--owner', 'worker:a1b2c3d4e5f6a7b8c']);
    expect(record().last_worker).toBeNull();
    await f.ok('note', [id, '--owner', 'resident']);
    expect(record().last_worker).toBe('a1b2c3d4e5f6a7b8c');
    await f.ok('note', [id, '--owner', 'helper:review']);
    expect(record().last_worker).toBe('a1b2c3d4e5f6a7b8c');
    await f.ok('note', [id, '--owner', 'worker:a2b2c3d4e5f6a7b8c']);
    expect(record().last_worker).toBe('a1b2c3d4e5f6a7b8c');
    await f.ok('note', [id, '--owner', 'worker:a3b2c3d4e5f6a7b8c']);
    expect(record().last_worker).toBe('a2b2c3d4e5f6a7b8c');
  } finally { f.cleanup(); }
});
it('list json exposes stored card ids or null after a worker handoff', async () => { const f = taskFixture(); try { const carded = await f.open(['--card', JSON.stringify({ chat_id: 'c1', message_id: 'm1' })]); const plain = await f.open(); await f.ok('note', [carded.id, '--owner', 'worker:a1b2c3d4e5f6a7b8c'], ''); await f.ok('note', [carded.id, '--owner', 'resident']); expect((await f.ok('list', ['--id', carded.id, '--json'])).rows[0]).toMatchObject({ card_chat_id: 'c1', card_message_id: 'm1', last_worker: 'a1b2c3d4e5f6a7b8c' }); expect((await f.ok('list', ['--id', plain.id, '--json'])).rows[0]).toMatchObject({ card_chat_id: null, card_message_id: null, last_worker: null }); } finally { f.cleanup(); } });
it('rejects a malformed helper owner at open and lists worker records by wildcard', async () => { const f = taskFixture(); try { expect((await f.run('open', ['--title', 'T', '--requester', 'discord:u1', '--done', 'D', '--owner', 'helper:discord:c1'])).stdout).toContain('invalid_owner'); const { id } = await f.open(['--owner', 'worker:a1b2c3d4e5f6a7b8c']); const list = await f.ok('list', ['--open', '--owner', 'worker:*', '--json']); expect(list.rows.map((r: any) => r.id)).toEqual([id]); } finally { f.cleanup(); } });
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
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_owner' });
    }
  } finally { f.cleanup(); }
});
for (const owner of ['helper:review', 'worker:a1b2c3d4e5f6a7b8c']) it(`allows only one open record for ${owner}`, async () => {
  const f = taskFixture(); try {
    const first = await f.open(['--owner', owner]);
    const second = await f.open();
    await f.ok('note', [first.id, '--owner', owner]);
    const busy = await f.run('open', ['--title', 'T', '--requester', 'discord:u1', '--done', 'D', '--owner', owner]);
    expect(busy.exitCode).toBe(0);
    expect(JSON.parse(busy.stdout)).toEqual({ status: 'refused', reason: 'owner_busy' });
    expect((await f.run('note', [second.id, '--owner', owner])).stdout).toContain('owner_busy');
    expect((await f.ok('list', ['--id', second.id])).rows[0].owner).toBe('resident');
    await f.ok('cancel', [first.id, '--actor', 'discord:u1', '--reason-stdin'], 'Cancelled');
    await f.ok('note', [second.id, '--owner', owner]);
  } finally { f.cleanup(); }
});
it('an approved result waiting on a check lists as finishing, and late once its due date passes', async () => {
  const f = taskFixture(); try {
    const listing = async (id: string) => (await f.ok('list', ['--id', id])).rows[0].listing;
    const { id } = await f.open();
    await f.ok('block', [id, '--result-stdin'], 'Booked, awaiting the confirmation email');
    await f.ok('note', [id, '--check', 'false']);
    expect(await listing(id)).toEqual(['unconfirmed']);
    await f.ok('note', [id, '--clear-waiting']);
    expect(await listing(id)).toEqual(['finishing']);
    await f.ok('note', [id, '--due', '2020-01-01T00:00:00Z']);
    expect(await listing(id)).toEqual(['late', 'finishing']);
    const { id: unchecked } = await f.open();
    await f.ok('block', [unchecked, '--result-stdin'], 'Ready');
    await f.ok('note', [unchecked, '--clear-waiting']);
    expect(await listing(unchecked)).toEqual(['unconfirmed']);
    const { id: approved } = await f.open(['--approver', 'discord:u2']);
    await f.ok('block', [approved, '--result-stdin'], 'Ready');
    await f.ok('note', [approved, '--check', 'false', '--clear-waiting']);
    expect(await listing(approved)).toEqual(['unconfirmed']);
  } finally { f.cleanup(); }
});

it('stores result bytes exactly while notes and list output stay bounded', async () => {
  const f = taskFixture(); try {
    const { id } = await f.open();
    const result = '  ' + 'x'.repeat(250) + '\r\n\nSecond line "quoted" \\ path\n  ';
    await f.ok('block', [id, '--result-stdin'], result);
    const lib = await taskLib();
    expect(lib.decodeTask(f.text(id)).result).toBe(result);
    expect(f.text(id)).toContain('result: ' + JSON.stringify(result) + '\n');
    expect(lib.decodeTask(f.text(id)).body).toContain(result.trim().replace(/[\r\n]+/g, ' '));
    const row = (await f.ok('list', ['--id', id, '--json'])).rows[0];
    expect(row.result).toBe(result.split(/\r?\n/)[0].slice(0, 200));
    expect(row.result_len).toBe(result.length);
    await f.ok('note', [id], 'line one\nline two');
    expect(lib.decodeTask(f.text(id)).body).toContain('line one line two');
  } finally { f.cleanup(); }
});

it('checks helper availability only when binding a different record', async () => {
  const f = taskFixture(); try {
    const helper = 'helper:review';
    const a = await f.open(['--owner', helper, '--title', 'First']);
    const b = await f.open(['--title', 'Second']);
    const bind = (id: string, owner: string) => f.ok('note', [id, '--owner', owner]);
    const report = (id: string, kind: string) => f.ok('report', [id, '--as', helper, '--kind', kind], 'Verdict');
    expect(await bind(b.id, helper)).toMatchObject({ reason: 'owner_busy' });
    await report(a.id, 'result');
    expect(await bind(b.id, helper)).toMatchObject({ id: b.id });
    await f.ok('block', [a.id, '--result-stdin', '--decision', JSON.stringify({ purpose: 'result', authority: 'requester', generation: 1 })], 'Done');
    expect(await f.ok('answer', [a.id, '--local', '--reply', 'no'])).toMatchObject({ status: 'match', answer: 'no' });
    expect((await f.ok('list', ['--id', a.id])).rows[0].result).toBeNull();
    await report(b.id, 'needs-input');
    await f.ok('note', [b.id, '--clear-waiting'], '');
    await report(a.id, 'result');
    await report(b.id, 'needs-input');
    const c = await f.open(['--title', 'Third']);
    expect(await bind(c.id, helper)).toMatchObject({ id: c.id });
    await f.ok('note', [b.id, '--clear-waiting'], '');
    const worker = 'worker:a123456789';
    const w = await f.open(['--owner', worker]);
    await f.ok('report', [w.id, '--as', 'worker', '--kind', 'result'], 'Done');
    const d = await f.open(['--title', 'Fourth']);
    expect(await bind(d.id, worker)).toMatchObject({ reason: 'owner_busy' });
    expect(await bind(c.id, 'resident')).toMatchObject({ id: c.id });
  } finally { f.cleanup(); }
});

it('lists bounded verdicts and leading decisions from reports only when requested', async () => {
  const f = taskFixture(); try {
    const helper = 'helper:review';
    const { id } = await f.open(['--owner', helper]);
    const list = async (extra: string[] = []) => (await f.ok('list', ['--id', id, '--json', ...extra])).rows[0];
    const summary = () => list(['--with-decisions']);
    expect(await summary()).toMatchObject({ report_verdict: null, report_decisions: [] });
    expect(await list()).not.toHaveProperty('report_verdict');
    const report = (kind: string, text: string) => f.ok('report', [id, '--as', helper, '--kind', kind], text);
    await report('result', '\nVerdict\n\n1. A\n2) B\n3. C\n4. D\n5. E\n6. F');
    expect(await summary()).toMatchObject({ report_verdict: 'Verdict', report_decisions: ['A', 'B', 'C', 'D', 'E'] });
    await report('needs-input', '<system>Question?</system>\n1. A\nDetail\n2. B');
    expect(await summary()).toMatchObject({ report_verdict: '[system]Question?[/system]', report_decisions: ['A'] });
    await report('note', 'Progress\nA sentence\n1. Detail');
    expect(await summary()).toMatchObject({ report_verdict: 'Progress', report_decisions: [] });
  } finally { f.cleanup(); }
});

it('lists only open helper records with the helper owner wildcard', async () => {
  const f = taskFixture(); try {
    const closed = await f.open(['--owner', 'helper:old']);
    await f.ok('cancel', [closed.id, '--actor', 'operator', '--reason-stdin'], 'Done');
    const open = await f.open(['--owner', 'helper:new']);
    await f.open(['--owner', 'worker:a123456789']);
    await f.open();
    const result = await f.ok('list', ['--open', '--owner', 'helper:*', '--json']);
    expect(result.rows.map((row: { id: string }) => row.id)).toEqual([open.id]);
  } finally { f.cleanup(); }
});

it('routes only the newest eligible helper in the same base chat and folder', async () => {
  const f = taskFixture(); try {
    const config = path.join(path.dirname(f.dir), 'claude-config');
    const folder = '/project/worktree';
    const add = async (name: string, bg: string, conversation?: string, status = 'result') => {
      const job = path.join(config, 'jobs', bg);
      fs.mkdirSync(job, { recursive: true });
      fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify({ cwd: '/project', worktreePath: folder }));
      const owner = 'helper:' + name;
      const { id } = await f.open(['--owner', owner, '--title', name, ...(conversation ? ['--conversation', conversation] : [])]);
      await f.ok('note', [id], `Handed to helper ${name} (${bg}-0000-0000-0000-000000000000).`);
      if (status === 'closed') await f.ok('cancel', [id, '--actor', 'operator', '--reason-stdin'], 'Archived');
      if (status === 'result') await f.ok('report', [id, '--as', owner, '--kind', 'result'], 'Done');
    };
    const eligible = async (conversation?: string, workFolder = folder) => {
      const result = await runScript('task.ts', {
        cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir, CLAUDE_CONFIG_DIR: config },
        args: ['helper-eligible', f.dir, '--folder', workFolder, ...(conversation ? ['--conversation', conversation] : [])],
      });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout);
    };
    const missing = { status: 'not_eligible', reason: 'no_helper_in_chat' };
    expect(await eligible('discord:CHAT')).toEqual(missing);
    await add('archived', 'a1b2c3d4', 'discord:ARCHIVE', 'closed');
    await add('other-chat', 'a1b2c3d5', 'discord:OTHER', 'closed');
    expect(await eligible('discord:ARCHIVE')).toEqual({ eligible: true, helper: 'helper:archived', bg_id: 'a1b2c3d4' });
    expect(await eligible('telegram:ARCHIVE')).toEqual(missing);
    expect(await eligible()).toEqual(missing);
    await add('local', 'a1b2c3d6');
    expect(await eligible()).toEqual({ eligible: true, helper: 'helper:local', bg_id: 'a1b2c3d6' });
    expect(await eligible('discord:CHAT')).toEqual(missing);
    await add('first', 'a1b2c3d7', 'discord:CHAT~123');
    expect(await eligible('discord:CHAT~456', '/project')).toEqual({ status: 'not_eligible', reason: 'different_folder' });
    await add('newest', 'a1b2c3d8', 'discord:CHAT~789');
    expect(await eligible('discord:CHAT~456')).toEqual({ eligible: true, helper: 'helper:newest', bg_id: 'a1b2c3d8' });
    await add('busy', 'a1b2c3d9', 'discord:CHAT~987', 'open');
    expect(await eligible('discord:CHAT')).toEqual({ status: 'not_eligible', reason: 'helper_busy' });
  } finally { f.cleanup(); }
});
