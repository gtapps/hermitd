import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from '../scripts/lib/proposals/migrate';
import { decodeTask, encodeTask, readTasks, mutateTask } from '../scripts/lib/tasks';
import { taskFixture } from './helpers/tasks';
const created = '2026-10-01T10:00:00.000Z';
function proposal(dir: string, number: number, status = 'proposed') {
  const legacy = `PROP-${String(number).padStart(3, '0')}`;
  const file = path.join(dir, 'proposals', legacy + '-example.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nid: ${legacy}\ntitle: Example ${number}\ncreated: ${created}\nstatus: ${status}\nsource: reflect\ncategory: improvement\ntags: [example]\nreason: Not useful\n---\n## Proposed Solution\nUse example ${number}.\n`);
  return { file, key: `proposal:${legacy}` };
}

test('all legacy statuses map correctly, retain dates, archive after verification, and rerun is a no-op', () => {
  const f = taskFixture(); try {
    const statuses = ['proposed', 'deferred', 'dismissed', 'accepted', 'resolved'];
    statuses.forEach((status, index) => proposal(f.dir, index + 1, status));
    f.put('state/proposals-index.json', { obsolete: true });
    expect(migrate(f.dir)).toEqual({ imported: 4, linked: 0, archived: 5, alerts_dropped: 0, skipped: [] });
    const records = readTasks(f.dir);
    for (const [index, status] of statuses.entries()) {
      const record = records.find(row => row.dedupe_key === `proposal:PROP-00${index + 1}`)!;
      if (status === 'resolved') { expect(record).toBeUndefined(); continue; }
      expect(record).toMatchObject({ kind: 'proposal', requester: 'agent', approver: null, created, opened_at: created, source: 'reflect', tags: '["example"]' });
      expect(record.body).toContain(`Use example ${index + 1}.`);
      if (['proposed', 'deferred', 'accepted'].includes(status)) {
        expect(record).toMatchObject({ waiting_on: 'admin', approved_rev: null, owner: 'resident' });
        expect(JSON.parse(record.decision!)).toEqual({ purpose: 'consent', authority: 'admin', generation: 1 });
      }
      if (status === 'dismissed') expect(record).toMatchObject({ closed_by: 'cancelled', closed_reason: 'Not useful' });
    }
    expect(Object.values(JSON.parse(fs.readFileSync(path.join(f.dir, 'state/decision-deliveries.json'), 'utf8')))).toEqual([2, 2, 2, 2]);
    expect(fs.existsSync(path.join(f.dir, 'state/proposals-index.json'))).toBe(false);
    expect(migrate(f.dir)).toEqual({ imported: 0, linked: 0, archived: 0, alerts_dropped: 0, skipped: [] });
    const dismissed = records.find(record => record.closed_by === 'cancelled')!;
    expect(mutateTask(f.dir, 'open', undefined, { requester: 'agent', title: 'Retry', done: 'Done', kind: 'proposal', 'dedupe-key': dismissed.dedupe_key! }, '')).toMatchObject({ id: dismissed.id, created: false });
  } finally { f.cleanup(); }
});

for (const status of ['accepted', 'resolved', 'proposed', 'dismissed']) {
  test(status + ' linked task stays byte-identical and retires linked questions', async () => {
    const f = taskFixture(); try {
      const { id } = await f.open(['--dedupe-key', 'proposal:PROP-001', '--owner', 'worker:aabbccddeeff0011', '--check', 'true', '--conversation', 'discord:team']);
      await f.ok('block', [id, '--result-stdin'], 'Existing result');
      const before = f.text(id);
      proposal(f.dir, 1, status);
      f.put('state/micro-proposals.json', { pending: [{ id: 'MP-1', status: 'pending', proposal_id: 'PROP-001' }] });
      expect(migrate(f.dir)).toEqual({ imported: 0, linked: 1, archived: 1, alerts_dropped: 0, skipped: [] });
      expect(f.text(id)).toBe(before);
      expect(fs.existsSync(path.join(f.dir, 'state/micro-proposals.json'))).toBe(false);
    } finally { f.cleanup(); }
  });
}

test('multiple records sharing a source key are all left untouched', async () => {
  const f = taskFixture(); try {
    const a = await f.open();
    const b = await f.open();
    for (const id of [a.id, b.id]) {
      const record = decodeTask(f.text(id));
      record.dedupe_key = 'proposal:PROP-001';
      fs.writeFileSync(path.join(f.dir, 'tasks', id + '.md'), encodeTask(record));
    }
    const before = [f.text(a.id), f.text(b.id)];
    proposal(f.dir, 1);
    expect(migrate(f.dir)).toMatchObject({ imported: 0, linked: 1, archived: 1, skipped: [] });
    expect([f.text(a.id), f.text(b.id)]).toEqual(before);
  } finally { f.cleanup(); }
});

for (const status of ['proposed', 'deferred']) for (const config of [false, true]) {
  test('skill draft ' + status + ' with config=' + config, () => {
    const f = taskFixture(); try {
      const { file } = proposal(f.dir, 1, status);
      fs.appendFileSync(file, '\n## Skill Draft\nDraft\n' + (config ? '## Config\n{}\n' : ''));
      expect(migrate(f.dir)).toMatchObject({ imported: 1, archived: 1, skipped: [] });
      expect(readTasks(f.dir)[0]).toMatchObject(config
        ? { status: 'open', waiting_on: 'admin' }
        : { status: 'closed', closed_by: 'cancelled', closed_reason: 'Close-time learned skills replace standalone skill drafts.' });
    } finally { f.cleanup(); }
  });
}

test('corrupt sources stay untouched and prevent final queue/index removal', () => {
  const f = taskFixture(); try {
    const { file } = proposal(f.dir, 1);
    fs.writeFileSync(file, 'broken');
    f.put('state/proposals-index.json', {});
    fs.writeFileSync(path.join(f.dir, 'state/micro-proposals.json'), '{');
    const result = migrate(f.dir) as any;
    expect(result.skipped).toHaveLength(2);
    expect(fs.readFileSync(file, 'utf8')).toBe('broken');
    expect(fs.readFileSync(path.join(f.dir, 'state/micro-proposals.json'), 'utf8')).toBe('{');
    expect(fs.existsSync(path.join(f.dir, 'state/proposals-index.json'))).toBe(true);
    expect(readTasks(f.dir)).toHaveLength(0);
  } finally { f.cleanup(); }
});

test('a crash after record write and before archive resumes without a second record', () => {
  const f = taskFixture(); try {
    const { file } = proposal(f.dir, 1);
    const rename = fs.renameSync;
    const spy = spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(source) === file) throw new Error('interrupted');
      return rename(source, destination);
    });
    try {
      expect(migrate(f.dir)).toMatchObject({ imported: 1, archived: 0, alerts_dropped: 0, skipped: [{ reason: 'archive_failed' }] });
      expect(fs.existsSync(file)).toBe(true);
    } finally { spy.mockRestore(); }
    expect(migrate(f.dir)).toEqual({ imported: 0, linked: 1, archived: 1, alerts_dropped: 0, skipped: [] });
    expect(readTasks(f.dir)).toHaveLength(1);
  } finally { f.cleanup(); }
});

test('pending questions import as input decisions and proposal-linked questions retire', () => {
  const f = taskFixture(); try {
    proposal(f.dir, 1);
    f.put('state/micro-proposals.json', { pending: [
      { id: 'MP-20261001-0', status: 'pending', ts: created, question: 'Which option?', chat: 'discord:team', user: 'member', options: ['One', 'Two'], on_resolve: '/hermitd:watch --answer' },
      { id: 'MP-20261001-1', status: 'pending', ts: created, question: 'Apply?', proposal_id: 'PROP-001' },
    ] });
    expect(migrate(f.dir)).toEqual({ imported: 2, linked: 0, archived: 1, alerts_dropped: 0, skipped: [] });
    const record = readTasks(f.dir).find(record => record.dedupe_key === 'question:MP-20261001-0')!;
    expect(record).toMatchObject({ kind: null, requester: 'discord:member', conversation: 'discord:team', waiting_on: 'requester', created });
    expect(JSON.parse(record.decision!)).toEqual({ purpose: 'input', authority: 'requester', options: ['One', 'Two'], generation: 1, resume: '/hermitd:watch --answer' });
    expect(fs.existsSync(path.join(f.dir, 'state/micro-proposals.json'))).toBe(false);
  } finally { f.cleanup(); }
});

test('absent sources give a zero receipt and large same-instant batches allocate without sleeps', () => {
  const f = taskFixture(); try {
    expect(migrate(f.dir)).toEqual({ imported: 0, linked: 0, archived: 0, alerts_dropped: 0, skipped: [] });
    for (let index = 1; index <= 45; index++) proposal(f.dir, index);
    expect(migrate(f.dir)).toEqual({ imported: 45, linked: 0, archived: 45, alerts_dropped: 0, skipped: [] });
    expect(new Set(readTasks(f.dir).map(record => record.id)).size).toBe(45);
  } finally { f.cleanup(); }
});

test('all sources with a conflicting legacy id stay untouched', () => {
  const f = taskFixture(); try {
    const { file } = proposal(f.dir, 1);
    const other = path.join(path.dirname(file), 'PROP-001-conflict.md');
    fs.copyFileSync(file, other);
    const result = migrate(f.dir) as any;
    expect(result).toMatchObject({ imported: 0, linked: 0, archived: 0 });
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((row: any) => row.reason === 'conflicting_proposal_id')).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(readTasks(f.dir)).toHaveLength(0);
  } finally { f.cleanup(); }
});

test('legacy proposal alert entries are dropped once and other alerts are kept', () => {
  const f = taskFixture(); try {
    const entry = { count: 6, suppressed: true, consecutive_clean: 0, text: 'x' };
    f.put('state/alert-state.json', { alerts: { 'proposal-pending:PROP-001': entry, 'micro-proposal-pending:MP-1': entry, 'custom:disk': entry }, total_ticks: 7, self_eval: {} });
    expect(migrate(f.dir)).toEqual({ imported: 0, linked: 0, archived: 0, alerts_dropped: 2, skipped: [] });
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'state/alert-state.json'), 'utf8'));
    expect(state).toMatchObject({ total_ticks: 7 });
    expect(state.alerts).toEqual({ 'custom:disk': entry });
    expect(migrate(f.dir)).toEqual({ imported: 0, linked: 0, archived: 0, alerts_dropped: 0, skipped: [] });
  } finally { f.cleanup(); }
});
