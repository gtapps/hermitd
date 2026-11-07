import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { runScript } from './helpers/run';
import { readTasks, encodeTask, type Task } from '../scripts/lib/tasks';
import { briefContext, briefDigest, type BriefMode } from '../scripts/lib/brief-digest';

const reference = new Date('2026-10-20T12:00:00Z');
function save(dir: string, task: Task) {
  fs.writeFileSync(path.join(dir, 'tasks', `${task.id}.md`), encodeTask(task));
}
async function seed(f: ReturnType<typeof taskFixture>) {
  await f.open();
  const task = readTasks(f.dir)[0];
  task.created = task.opened_at = '2026-10-20T10:00:00Z';
  save(f.dir, task);
  return task;
}

test('empty install and CLI mode and argument contracts', async () => {
  const f = taskFixture();
  try {
    const missing = await runScript('brief-digest.ts', { cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir }, args: [f.dir, 'morning'] });
    expect(missing.exitCode).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({ status: 'needs_selector' });
    await expect(briefContext(f.dir, {})).rejects.toThrow('needs_selector');
    for (const mode of ['morning', 'evening', 'daily'] as BriefMode[]) {
      const result = await runScript('brief-digest.ts', { cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir }, args: [f.dir, mode, '--agent'] });
      expect(result.exitCode).toBe(0);
      const row = JSON.parse(result.stdout);
      expect(Object.keys(row)).toEqual(mode === 'morning' ? ['mode', 'today', 'scope', 'agent_steps', 'latest', 'decisions_pending', 'open', 'decisions', 'duties', 'omitted'] : ['mode', 'today', 'scope', 'agent_steps', 'records', 'decisions_pending', 'open', 'decisions', 'duties', 'omitted']);
      expect(row.open).toEqual([]);
      expect(mode === 'morning' ? row.latest : row.records).toEqual(mode === 'morning' ? null : []);
    }
    for (const [args, error] of [[['bad'], 'invalid_mode:bad'], [['daily', 'extra'], 'invalid_arguments']] as const) {
      const result = await runScript('brief-digest.ts', { cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir }, args: [f.dir, ...args] });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toBe(error);
    }
  } finally { f.cleanup(); }
});

test('local day selection, newest latest, all owners in records and recent decisions on old records', async () => {
  const f = taskFixture();
  try {
    const base = await seed(f);
    base.created = base.opened_at = '2026-10-19T23:30:00Z';
    base.owner = 'helper:research';
    base.body = '## Decisions\n- 2026-10-20T11:00:00Z telegram:actor: Keep this\n- invalid No stamp\n- 2026-10-18T11:00:00Z actor: Old\n';
    save(f.dir, base);
    f.put('config.json', { timezone: 'Europe/Lisbon' });
    const local = await briefDigest(f.dir, 'evening', reference, { agent: true });
    if (!('records' in local)) throw new Error('Expected evening records');
    expect(local.records).toHaveLength(1);
    expect(local.records![0].id).toBe(base.id);
    expect(local.records![0]).not.toHaveProperty('decisions');
    expect(local.open[0].state).toBe('delegated');
    f.put('config.json', { timezone: 'UTC' });
    const daily = await briefDigest(f.dir, 'daily', reference, { agent: true });
    if (!('records' in daily)) throw new Error('Expected daily records');
    expect(daily.records).toEqual([]);
    expect(local.decisions).toEqual([{ task_title: base.title, text: 'telegram:actor: Keep this' }]);
    const morning = await briefDigest(f.dir, 'morning', reference, { agent: true });
    if (!('latest' in morning)) throw new Error('Expected morning latest');
    expect(morning.latest?.id).toBe(base.id);
  } finally { f.cleanup(); }
});

test('open includes more than twenty resident rows with each state and includes delegated worker and helper states', async () => {
  const f = taskFixture();
  try {
    const base = await seed(f);
    for (let i = 0; i < 26; i++) {
      const row = { ...base, id: `T-20261020-100000-${i.toString(36)}` };
      if (i === 0) { row.result = 'Ready'; row.check = 'true'; }
      if (i === 1) row.result = 'Confirm';
      if (i === 2) row.waiting_on = 'telegram:operator';
      if (i === 3) { row.result = 'Late'; row.check = 'true'; row.due = '2000-01-01T00:00:00Z'; }
      if (i === 24) row.owner = 'worker:abcdef12';
      if (i === 25) row.owner = 'helper:research';
      save(f.dir, row);
    }
    const digest = await briefDigest(f.dir, 'evening', reference, { agent: true });
    expect(digest.open).toHaveLength(27);
    expect(digest.open.find(row => row.id.endsWith('-0'))?.state).toBe('finishing');
    expect(digest.open.find(row => row.id.endsWith('-1'))?.state).toBe('unconfirmed');
    expect(digest.open.find(row => row.id.endsWith('-2'))?.state).toBe('waiting');
    expect(digest.open.find(row => row.id.endsWith('-3'))).toMatchObject({ state: 'unconfirmed', late: true });
    expect(digest.open.find(row => row.id.endsWith('-4'))?.state).toBe('runnable');
    for (const suffix of ['-o', '-p']) expect(digest.open.find(row => row.id.endsWith(suffix))?.state).toBe('delegated');
  } finally { f.cleanup(); }
});

test('clips safely, excludes long evidence and counts truncated-result lessons', async () => {
  const f = taskFixture();
  try {
    const row = await seed(f);
    row.title = 'x'.repeat(199) + '😀tail';
    row.result = 'r'.repeat(4001);
    row.waiting_on = 'w'.repeat(500);
    row.closed_reason = 'c'.repeat(500);
    row.body = `## Lessons\n- useful\n- ${'l'.repeat(401)}\n\n## Decisions\n- 2026-10-20T11:00:00Z actor: ${'d'.repeat(401)}\n`;
    save(f.dir, row);
    const digest = await briefDigest(f.dir, 'daily', reference, { agent: true });
    if (!('records' in digest)) throw new Error('Expected daily records');
    expect(digest.records![0]).toMatchObject({ title: 'x'.repeat(199), result_truncated: true, lessons: [] });
    expect(digest.records![0].result).toHaveLength(4000);
    expect(digest.omitted).toMatchObject({ clipped: 6, lessons: 2, decisions: 1 });
  } finally { f.cleanup(); }
});

test('all oversized sections pack below exact stdout ceiling including escaped controls and preserve index', async () => {
  const f = taskFixture();
  try {
    const base = await seed(f);
    const huge = '\u0001'.repeat(5000);
    const routines = Array.from({ length: 150 }, (_, i) => ({ id: `${i}${huge}`, schedule: huge }));
    f.put('config.json', { routines });
    fs.mkdirSync(path.join(f.dir, 'proposals'), { recursive: true });
    f.put('state/proposals-index.json', { sentinel: true });
    const before = fs.readFileSync(path.join(f.dir, 'state/proposals-index.json'));
    for (let i = 0; i < 150; i++) {
      save(f.dir, { ...base, id: `T-20261020-${String(100001 + i).padStart(6, '0')}`, title: huge, result: huge, waiting_on: 'admin', kind: 'proposal', decision: JSON.stringify({ purpose: 'consent', authority: 'admin', generation: 1 }),
        body: `## Lessons\n- ${'l'.repeat(390)}\n\n## Decisions\n- 2026-10-20T11:00:00Z actor: ${'d'.repeat(390)}\n` });
      fs.writeFileSync(path.join(f.dir, 'proposals', `PROP-${i}.md`), `---\nstatus: proposed\nsource: auto-detected\ntitle: ${'p'.repeat(500)}\n---\n`);
    }
    const missing = await runScript('brief-digest.ts', { cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir }, args: [f.dir, 'morning'] });
    expect(missing.exitCode).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({ status: 'needs_selector' });
    await expect(briefContext(f.dir, {})).rejects.toThrow('needs_selector');
    for (const mode of ['morning', 'evening', 'daily'] as BriefMode[]) {
      const row = await briefDigest(f.dir, mode, reference, { agent: true });
      expect(Buffer.byteLength(JSON.stringify(row) + '\n')).toBeLessThanOrEqual(25000);
      expect(row.omitted.clipped).toBeGreaterThan(0);
      expect(row.omitted.open).toBeGreaterThan(0);
      expect(row.omitted.duties).toBeGreaterThan(0);
      if (mode === 'morning') {
        if (!('latest' in row)) throw new Error('Expected morning latest');
        expect(row.latest).not.toBeNull();
        expect(row.omitted.decisions_pending).toBeGreaterThan(0);
      }
      else { expect(row.omitted.records).toBeGreaterThan(0); expect(row.omitted.decisions).toBeGreaterThan(0); }
    }
    expect(fs.readFileSync(path.join(f.dir, 'state/proposals-index.json'))).toEqual(before);
  } finally { f.cleanup(); }
});

test('morning latest omits lessons without reporting them as left out', async () => {
  const f = taskFixture();
  try {
    const row = await seed(f);
    row.body = '## Lessons\n- useful\n';
    save(f.dir, row);
    const digest = await briefDigest(f.dir, 'morning', reference, { agent: true });
    if (!('latest' in digest)) throw new Error('Expected morning latest');
    expect(digest.latest?.lessons).toEqual([]);
    expect(digest.omitted.lessons).toBe(0);
  } finally { f.cleanup(); }
});

test('packing shortens a result whose lessons are gone before dropping its record', async () => {
  const f = taskFixture();
  try {
    const base = await seed(f);
    for (let i = 0; i < 8; i++) {
      save(f.dir, { ...base, id: `T-20261020-${String(100001 + i).padStart(6, '0')}`, result: 'r'.repeat(3900), body: '## Lessons\n- useful\n' });
    }
    const digest = await briefDigest(f.dir, 'evening', reference, { agent: true });
    if (!('records' in digest)) throw new Error('Expected evening records');
    expect(digest.omitted.records).toBe(0);
    expect(digest.records).toHaveLength(9);
    const shortened = digest.records!.filter(row => row.result_truncated);
    expect(shortened.length).toBeGreaterThan(0);
    for (const row of shortened) expect(row.result).toHaveLength(400);
  } finally { f.cleanup(); }
});

test('delegated results and waits retain actionable states', async () => {
  const f = taskFixture();
  try {
    const base = await seed(f);
    for (const [i, owner, result, waiting_on, check] of [
      [1, 'helper:research', 'Ready', null, null],
      [2, 'worker:abcdef12', null, 'operator', null],
      [3, 'helper:research', 'Ready', null, 'true'],
    ] as const) save(f.dir, { ...base, id: `T-20261020-10000${i}`, owner, result, waiting_on, check });
    const digest = await briefDigest(f.dir, 'morning', reference, { agent: true });
    expect(digest.open.filter(row => row.id !== base.id).map(row => row.state)).toEqual(['unconfirmed', 'waiting', 'finishing']);
  } finally { f.cleanup(); }
});

test('brief selectors scope all record sections and suppress agent-wide sections', async () => {
  const f = taskFixture();
  try {
    const base = await seed(f);
    f.put('config.json', { channels: { discord: { default_chat_id: 'home', shared_chats: ['grant'] } }, routines: [{ id: 'group', chat: 'discord:group' }, { id: 'home' }] });
    f.put('state/channel-chats.json', { discord: { chats: {
      group: { type: 0 }, child: { type: 11, parent_id: 'group' }, private: { type: 12, parent_id: 'group' },
      category: { type: 0, parent_id: 'group' }, grant: { type: 0 }, sibling: { type: 11, parent_id: 'grant' },
    } } });
    for (const [i, audience] of ['discord:group', 'discord:group~topic', 'discord:child', 'discord:grant', 'discord:private', 'discord:category', 'discord:sibling', 'operator', 'discord:unknown'].entries()) {
      save(f.dir, { ...base, id: `T-20261020-10000${i}`, audience, body: '## Decisions\n- 2026-10-20T11:00:00Z actor: Decide\n' });
    }
    const digest = await briefDigest(f.dir, 'daily', reference, { routine: 'group' });
    expect(digest.scope).toBe('chat');
    expect(digest.agent_steps).toBe(false);
    if (!('records' in digest)) throw new Error('Expected daily records');
    expect(digest.open.map(row => row.id)).toEqual([0, 1, 2, 3].map(i => `T-20261020-10000${i}`));
    expect(digest.records).toHaveLength(4);
    expect(digest.decisions).toHaveLength(4);
    expect(digest.duties).toEqual([]);
    expect(digest.omitted.open).toBe(1);
    const morning = await briefDigest(f.dir, 'morning', reference, { chat: 'discord:group' });
    if (!('latest' in morning)) throw new Error('Expected morning latest');
    expect(morning.latest?.id).toBe('T-20261020-100000');
    expect(morning.decisions_pending).toEqual([]);
    const decision = { ...base, id: 'T-20261020-100010', conversation: 'discord:group', audience: 'discord:group', decision: JSON.stringify({ purpose: 'consent', authority: 'admin', generation: 1 }), waiting_on: 'admin' };
    save(f.dir, decision);
    save(f.dir, { ...decision, id: 'T-20261020-100011', conversation: null, audience: 'operator' });
    expect((await briefDigest(f.dir, 'morning', reference, { chat: 'discord:group' })).decisions_pending.map(row => row.id)).toEqual([decision.id]);
    expect((await briefDigest(f.dir, 'morning', reference, { agent: true })).scope).toBe('agent');
    expect((await briefDigest(f.dir, 'morning', reference, { routine: 'home' })).scope).toBe('agent');
    for (const args of [['context', '--routine', 'group'], ['context', '--chat', 'discord:group']]) {
      const result = await runScript('brief-digest.ts', { cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir }, args: [f.dir, ...args] });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ scope: 'chat', agent_steps: false, destination: 'discord:group' });
    }
    for (const args of [['context', '--routine', 'missing'], ['morning', '--chat', 'bad'], ['morning', '--chat', 'discord:group', '--routine', 'group']]) {
      const result = await runScript('brief-digest.ts', { cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir }, args: [f.dir, ...args] });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toHaveProperty('error');
    }
    f.put('config.json', { operator_profile: 'non-technical', channels: { discord: { default_chat_id: 'group' } } });
    const home = await briefDigest(f.dir, 'morning', reference, { chat: 'discord:group~topic' });
    expect(home.scope).toBe('chat');
    expect(home.agent_steps).toBe(true);
    expect(await briefContext(f.dir, { chat: 'discord:group' })).toEqual({ scope: 'chat', agent_steps: true, destination: 'discord:group' });
  } finally { f.cleanup(); }
});

test('scoped briefs skip closed unresolved records and bound morning candidates to recent closed work', async () => {
  const f = taskFixture();
  try {
    const base = await seed(f);
    f.put('config.json', { channels: { discord: { default_chat_id: 'home' } }, routines: [{ id: 'group', chat: 'discord:group' }] });
    const chats: Record<string, unknown> = { group: { type: 0 } };
    const closed = (i: number, audience: string) => ({ ...base, id: `T-20261019-${String(100000 + i)}`, audience, status: 'closed' as const,
      opened_at: '2026-10-19T08:00:00Z', created: '2026-10-19T08:00:00Z', closed_at: `2026-10-19T${String(9 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
      closed_by: 'confirmed' as const, closed_reason: 'done' });
    save(f.dir, closed(0, 'discord:group'));
    for (let i = 1; i <= 20; i++) { chats[`other${i}`] = { type: 0 }; save(f.dir, closed(i, `discord:other${i}`)); }
    save(f.dir, closed(21, 'discord:gone'));
    save(f.dir, { ...base, id: 'T-20261020-110000', audience: 'discord:gone-open' });
    f.put('state/channel-chats.json', { discord: { chats } });
    const morning = await briefDigest(f.dir, 'morning', reference, { routine: 'group' });
    if (!('latest' in morning)) throw new Error('Expected morning latest');
    expect(morning.latest).toBeNull();
    expect(morning.omitted).toMatchObject({ open: 1, records: 0 });
  } finally { f.cleanup(); }
});
