import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { mutateTask, listTasks, readTasks, decodeTask, encodeTask } from '../scripts/lib/tasks';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('task-learning-');
afterAll(cleanup);
function fixture(calls = 0, learning = true) {
  const dir = path.join(freshDir(), '.hermit'); fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ skills: { learning } }));
  fs.writeFileSync(path.join(dir, 'state/skill-review-counter'), '1'.repeat(calls));
  return dir;
}
function open(dir: string, flags: any = {}) { return (mutateTask(dir, 'open', undefined, { title: 'Example', requester: 'operator', done: 'Done', ...flags }, '') as any).id as string; }
function close(dir: string, id: string) { return mutateTask(dir, 'close', id, { by: 'confirmed', actor: 'operator', 'reason-stdin': true }, 'Confirmed') as any; }
test('threshold, reset, interrupted pending recovery, defaults and disposition idempotency', () => {
  const dir = fixture(9); const first = open(dir); close(dir, first);
  expect(readTasks(dir)[0].skill_review).toBeNull();
  fs.writeFileSync(path.join(dir, 'state/skill-review-counter'), '1'.repeat(10));
  const id = open(dir); expect(close(dir, id).skill_review).toBe('pending');
  expect(fs.statSync(path.join(dir, 'state/skill-review-counter')).size).toBe(0);
  expect(listTasks(dir, { 'skill-review': 'pending' }).rows.map(row => row.id)).toEqual([id]);
  const before = readTasks(dir).find(row => row.id === id)!;
  const result = mutateTask(dir, 'learn', id, { disposition: 'saved' }, '');
  expect(mutateTask(dir, 'learn', id, { disposition: 'saved' }, '')).toEqual(result);
  expect(() => mutateTask(dir, 'learn', id, { disposition: 'nothing' }, '')).toThrow('review_not_pending');
  expect(readTasks(dir).find(row => row.id === id)).toEqual({ ...before, skill_review: 'saved' });
  const old = encodeTask(before).replace(/^delegated:.*\n/m, '').replace(/^skill_review:.*\n/m, '');
  expect(decodeTask(old).delegated).toBe(false); expect(decodeTask(old).skill_review).toBeNull();
});
test('worker and helper ownership persist delegation; both close paths schedule learning', () => {
  for (const owner of ['worker:abcdef123456', 'helper:research']) {
    const dir = fixture(); const id = open(dir, { check: 'true' });
    mutateTask(dir, 'note', id, { owner }, ''); mutateTask(dir, 'note', id, { owner: 'resident' }, '');
    expect(readTasks(dir)[0].delegated).toBe(true);
    const digest = mutateTask(dir, 'check-result', id, { 'result-rev': '0', exit: '0', 'output-stdin': true }, 'passed') as any;
    expect(digest.skill_review).toBe('pending');
  }
});
test('cancel and learning off never schedule or reset the counter', () => {
  for (const cancelled of [true, false]) {
    const dir = fixture(10, cancelled); const id = open(dir);
    if (cancelled) mutateTask(dir, 'cancel', id, { actor: 'operator', 'reason-stdin': true }, 'Cancelled');
    else close(dir, id);
    expect(readTasks(dir)[0].skill_review).toBeNull();
    expect(fs.statSync(path.join(dir, 'state/skill-review-counter')).size).toBe(10);
  }
});
test('missing config settles learning on for delegated tasks', () => {
  const dir = fixture(); fs.unlinkSync(path.join(dir, 'config.json'));
  const id = open(dir); mutateTask(dir, 'note', id, { owner: 'helper:review' }, '');
  expect(close(dir, id).skill_review).toBe('pending');
});

test('muting a closed delegated task preserves its completed review', () => {
  const dir = fixture(); const id = open(dir);
  mutateTask(dir, 'note', id, { owner: 'helper:review' }, '');
  close(dir, id); mutateTask(dir, 'learn', id, { disposition: 'covered' }, '');
  mutateTask(dir, 'note', id, { muted: 'true' }, '');
  expect(readTasks(dir)[0].skill_review).toBe('covered');
});

test('MCP result closure returns the next queued record and schedules review; cancel skips review', () => {
  for (const cancel of [false, true]) {
    const dir = fixture(10);
    const id = open(dir, { requester: 'mcp:client' });
    const next = open(dir, { requester: 'mcp:client' });
    const digest = mutateTask(dir, cancel ? 'cancel' : 'block', id, { actor: 'hermit', 'result-stdin': true, 'reason-stdin': true }, 'Ready') as any;
    expect(digest.next_queued.id).toBe(next);
    expect(digest.skill_review).toBe(cancel ? undefined : 'pending');
  }
});
