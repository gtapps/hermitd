import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { runScript } from './helpers/run';
import { readTasks, encodeTask, type Task } from '../scripts/lib/tasks';
import { briefDigest, type BriefMode } from '../scripts/lib/brief-digest';

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
    for (const mode of ['morning', 'evening', 'daily'] as BriefMode[]) {
      const result = await runScript('brief-digest.ts', { cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir }, args: [f.dir, mode] });
      expect(result.exitCode).toBe(0);
      const row = JSON.parse(result.stdout);
      expect(Object.keys(row)).toEqual(mode === 'morning' ? ['mode', 'today', 'latest', 'proposals', 'open', 'decisions', 'duties', 'omitted'] : ['mode', 'today', 'records', 'open', 'decisions', 'duties', 'omitted']);
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
    const local = briefDigest(f.dir, 'evening', reference);
    if (!('records' in local)) throw new Error('Expected evening records');
    expect(local.records).toHaveLength(1);
    expect(local.records![0].id).toBe(base.id + '.md');
    expect(local.records![0]).not.toHaveProperty('decisions');
    expect(local.open).toEqual([]);
    f.put('config.json', { timezone: 'UTC' });
    const daily = briefDigest(f.dir, 'daily', reference);
    if (!('records' in daily)) throw new Error('Expected daily records');
    expect(daily.records).toEqual([]);
    expect(local.decisions).toEqual([{ task_title: base.title, text: 'telegram:actor: Keep this' }]);
    const morning = briefDigest(f.dir, 'morning', reference);
    if (!('latest' in morning)) throw new Error('Expected morning latest');
    expect(morning.latest?.id).toBe(base.id + '.md');
  } finally { f.cleanup(); }
});

test('open includes more than twenty resident rows with each state and excludes worker and helper owners', async () => {
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
    const digest = briefDigest(f.dir, 'evening', reference);
    expect(digest.open).toHaveLength(25);
    expect(digest.open.find(row => row.id.endsWith('-0'))?.state).toBe('finishing');
    expect(digest.open.find(row => row.id.endsWith('-1'))?.state).toBe('unconfirmed');
    expect(digest.open.find(row => row.id.endsWith('-2'))?.state).toBe('waiting');
    expect(digest.open.find(row => row.id.endsWith('-3'))).toMatchObject({ state: 'unconfirmed', late: true });
    expect(digest.open.find(row => row.id.endsWith('-4'))?.state).toBe('runnable');
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
    const digest = briefDigest(f.dir, 'daily', reference);
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
      save(f.dir, { ...base, id: `T-20261020-${String(100001 + i).padStart(6, '0')}`, title: huge, result: huge, waiting_on: huge,
        body: `## Lessons\n- ${'l'.repeat(390)}\n\n## Decisions\n- 2026-10-20T11:00:00Z actor: ${'d'.repeat(390)}\n` });
      fs.writeFileSync(path.join(f.dir, 'proposals', `PROP-${i}.md`), `---\nstatus: proposed\nsource: auto-detected\ntitle: ${'p'.repeat(500)}\n---\n`);
    }
    for (const mode of ['morning', 'evening', 'daily'] as BriefMode[]) {
      const row = briefDigest(f.dir, mode, reference);
      expect(Buffer.byteLength(JSON.stringify(row) + '\n')).toBeLessThanOrEqual(25000);
      expect(row.omitted.clipped).toBeGreaterThan(0);
      expect(row.omitted.open).toBeGreaterThan(0);
      expect(row.omitted.duties).toBeGreaterThan(0);
      if (mode === 'morning') {
        if (!('latest' in row)) throw new Error('Expected morning latest');
        expect(row.latest).not.toBeNull();
        expect(row.omitted.proposals).toBeGreaterThan(0);
      }
      else { expect(row.omitted.records).toBeGreaterThan(0); expect(row.omitted.decisions).toBeGreaterThan(0); }
    }
    expect(fs.readFileSync(path.join(f.dir, 'state/proposals-index.json'))).toEqual(before);
  } finally { f.cleanup(); }
});
