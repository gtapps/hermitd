import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { decodeTask, encodeTask, readTaskInventory, validRequester } from '../scripts/lib/tasks';
import { taskFixture } from './helpers/tasks';

test('older records backfill missing nullable fields before validation', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open();
    const old = f.text(id).replace(/^(check|stall_at|stall_status|stall_next|last_worker):.*\n/gm, '').replace('## Lessons\n\n', '');
    const record = decodeTask(old);
    expect(record.last_worker).toBeNull();
    expect(() => decodeTask(old.replace('result_rev:', 'last_worker: "main"\nresult_rev:'))).toThrow('invalid_record');
    expect(record.check).toBeNull();
    expect(record.stall_at).toBeNull();
    expect(decodeTask(encodeTask(record))).toEqual(record);
  } finally { f.cleanup(); }
});


test('the documented queued-task import preserves its note without a separate done flag', async () => {
  const f = taskFixture();
  try {
    const note = '## Task\nUpgrade the worker\n\n## Suggested Plan\n1. Verify the existing worker.';
    const { id } = await f.ok('open', ['--owner', 'resident', '--requester', 'operator', '--title', 'Upgrade the worker', '--note-stdin'], note);
    const record = decodeTask(f.text(id));
    expect(record.summary).toBe('Upgrade the worker');
    expect(record.body).toContain('Verify the existing worker.');
    expect((await f.run('open', ['--requester', 'operator', '--title', 'Missing done'])).exitCode).not.toBe(0);
  } finally { f.cleanup(); }
});

test('decision and proposal metadata default to null and preserve quoted JSON labels', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open();
    const fields = ['kind', 'decision', 'approved_rev', 'approved_by', 'source', 'category'] as const;
    const old = f.text(id).replace(/^(kind|decision|approved_rev|approved_by|source|category):.*\n/gm, '');
    const record = decodeTask(old);
    for (const field of fields) expect(record[field]).toBeNull();
    expect(decodeTask(old.replace(/^tags:.*\n/m, '')).tags).toBeNull();
    record.kind = 'proposal';
    record.decision = JSON.stringify({ purpose: 'input', authority: 'admin', generation: 1, options: ['Say "ready"', 'C:\\work'] });
    record.tags = JSON.stringify(['Say "ready"', 'C:\\work']);
    record.approved_rev = '0';
    record.approved_by = 'discord:u1';
    record.source = 'reflect';
    record.category = 'improvement';
    expect(decodeTask(encodeTask(record))).toEqual(record);
    expect(validRequester('agent')).toBe(true);
    expect((await f.open(['--requester', 'agent'])).id).toBeTruthy();
  } finally { f.cleanup(); }
});

test('inventory distinguishes an absent tasks directory from an unreadable subdirectory', async () => {
  const f = taskFixture();
  try {
    expect(readTaskInventory(f.dir)).toEqual({ ok: true, records: [] });
    const { id } = await f.open();
    expect(readTaskInventory(f.dir)).toMatchObject({ ok: true, records: [{ id }] });
    const unreadable = path.join(f.dir, 'tasks', 'unreadable');
    fs.mkdirSync(unreadable);
    const read = fs.readdirSync;
    const mock = spyOn(fs, 'readdirSync').mockImplementation(((directory: any, options: any) => {
      if (String(directory) === unreadable) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(directory, options);
    }) as typeof fs.readdirSync);
    try { expect(readTaskInventory(f.dir)).toEqual({ ok: false }); }
    finally { mock.mockRestore(); }
  } finally { f.cleanup(); }
});
