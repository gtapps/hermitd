import { test, expect } from 'bun:test';
import { decodeTask, encodeTask } from '../scripts/lib/tasks';
import { taskFixture } from './helpers/tasks';

test('older records backfill missing nullable fields before validation', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open();
    const old = f.text(id).replace(/^(check|stall_at|stall_status|stall_next|last_worker):.*\n/gm, '').replace('## Lessons\n\n', '');
    const record = decodeTask(old);
    expect(record.last_worker).toBeNull();
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
