import { test, expect } from 'bun:test';
import { taskFixture, taskLib } from './helpers/tasks';

test('only runnable resident records queue and close/cancel hands off the next one', async () => {
  const f = taskFixture();
  try {
    const a = await f.open();
    const b = await f.open();
    await f.ok('block', [a.id, '--waiting-on', 'operator', '--status-line', 'Waiting', '--next', 'Review']);
    const c = await f.open();
    const list = await f.ok('list', ['--open', '--owner', 'resident', '--limit', '2', '--json']);
    expect(list.rows[0].listing).not.toContain('queued');
    expect(list.rows[1].listing).not.toContain('queued');
    expect(list.omitted).toBe(1);
    expect(await f.ok('cancel', [a.id, '--actor', 'operator', '--reason-stdin'], 'Withdrawn')).toMatchObject({ next_queued: { id: b.id } });
    await f.ok('block', [b.id, '--result-stdin'], 'Ready');
    expect(await f.ok('close', [b.id, '--by', 'confirmed', '--actor', 'operator', '--result-rev', '1', '--reason-stdin'], 'Accepted')).toMatchObject({ next_queued: { id: c.id } });
  } finally { f.cleanup(); }
});

test('waiting proposal opens atomically with a verbatim body and stays out of the runnable queue', async () => {
  const f = taskFixture();
  try {
    const body = 'First paragraph.\n\nSecond "quoted" paragraph.\n';
    const receipt = await f.ok('open', ['--title', 'Proposal', '--done', 'Verified', '--requester', 'agent', '--kind', 'proposal', '--waiting-on', 'admin', '--decision', JSON.stringify({ purpose: 'consent', authority: 'admin', generation: 1 }), '--body-stdin'], body);
    const lib = await taskLib();
    const record = lib.decodeTask(f.text(receipt.id));
    expect(record.waiting_on).toBe('admin');
    expect(record.waiting_since).not.toBeNull();
    expect(record.body).toContain('## Proposal\n' + body);
    expect(receipt.queued).toBe(false);
    expect(lib.isRunnable(record)).toBe(false);
    expect(lib.currentWork(lib.readTasks(f.dir))).toBeNull();
  } finally { f.cleanup(); }
});

test('a cancelled proposal latches its dedupe key but a completed proposal allows a new one', async () => {
  const f = taskFixture();
  try {
    f.put('config.json', { channels: { discord: { operators: ['admin'] } } });
    const args = ['--kind', 'proposal', '--dedupe-key', 'proposal:example'];
    const first = await f.open(args);
    expect(await f.ok('answer', [first.id, '--chat', 'discord:home', '--user', 'admin', '--reply', 'no'])).toMatchObject({ status: 'match' });
    expect(await f.open(args)).toMatchObject({ id: first.id, created: false });
    const second = await f.open(['--kind', 'proposal', '--dedupe-key', 'proposal:completed']);
    expect(await f.ok('answer', [second.id, '--chat', 'discord:home', '--user', 'admin', '--reply', 'yes'])).toMatchObject({ status: 'match' });
    await f.ok('close', [second.id, '--by', 'confirmed', '--chat', 'discord:home', '--user', 'admin', '--reason-stdin'], 'Completed');
    expect(await f.open(['--kind', 'proposal', '--dedupe-key', 'proposal:completed'])).toMatchObject({ created: true });
  } finally { f.cleanup(); }
});

test('a new untyped wait clears the previous decision', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open();
    const args = [id, '--waiting-on', 'admin', '--status-line', 'Question', '--next', 'Reply'];
    await f.ok('block', [...args, '--decision', JSON.stringify({ purpose: 'input', authority: 'admin', generation: 1 })]);
    const lib = await taskLib();
    expect(lib.decodeTask(f.text(id)).decision).not.toBeNull();
    await f.ok('block', args);
    expect(lib.decodeTask(f.text(id)).decision).toBeNull();
  } finally { f.cleanup(); }
});
