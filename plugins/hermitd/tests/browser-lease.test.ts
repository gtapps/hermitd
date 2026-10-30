import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserLease, BROWSER_IDLE_MS } from '../scripts/lib/browser-lease';
import { mutateTask, readTasks } from '../scripts/lib/tasks';
import { freshDirFactory } from './helpers/workdir';
import { runScript } from './helpers/run';
const { freshDir, cleanup } = freshDirFactory('browser-lease-');
afterAll(cleanup);

test('claim, refusal, renewal, idle expiry and release', () => {
  const dir = freshDir();
  expect(browserLease('status', undefined, dir, 0).status).toBe('available');
  expect(browserLease('claim', 'task-a', dir, 0)).toEqual({ status: 'claimed', holder: 'task-a', expires_at: BROWSER_IDLE_MS });
  expect(browserLease('claim', 'task-b', dir, 1)).toEqual({ status: 'busy', holder: 'task-a' });
  expect(browserLease('renew', undefined, dir, 10).expires_at).toBe(BROWSER_IDLE_MS + 10);
  expect(browserLease('claim', 'task-b', dir, BROWSER_IDLE_MS + 10).holder).toBe('task-b');
  expect(browserLease('release', undefined, dir).status).toBe('released');
  expect(browserLease('renew', undefined, dir).status).toBe('unclaimed');
  expect(fs.existsSync(path.join(dir, 'state/browser-lease.json.lock'))).toBe(false);
});

test('release clears only the next waiting task through the task writer', () => {
  const dir = freshDir();
  const open = (title: string) => mutateTask(dir, 'open', undefined, { title, requester: 'discord:u1', done: 'checked' }, '') as { id: string };
  const a = open('First');
  const b = open('Second');
  browserLease('claim', 'holder', dir);
  for (const task of [a, b]) {
    expect(browserLease('claim', task.id, dir).status).toBe('busy');
    mutateTask(dir, 'block', task.id, { 'waiting-on': 'holder', 'status-line': 'Browser busy', next: 'Retry claim' }, '');
  }
  browserLease('release', undefined, dir);
  const records = readTasks(dir);
  expect(records.filter(task => task.waiting_on === null)).toHaveLength(1);
  expect(records.filter(task => task.waiting_on === 'holder')).toHaveLength(1);
  browserLease('claim', a.id, dir);
  browserLease('release', undefined, dir);
  expect(readTasks(dir).every(task => task.waiting_on === null)).toBe(true);
});

test('CLI uses resolved state, prints one object and returns zero for busy', async () => {
  const dir = freshDir();
  const env = { AGENT_DIR: path.join(dir, '.hermit') };
  for (const [args, status] of [[['claim', 'a'], 'claimed'], [['claim', 'b'], 'busy'], [['status'], 'claimed'], [['release'], 'released']] as const) {
    const result = await runScript('browser.ts', { cwd: dir, env, args: [...args] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout).status).toBe(status);
  }
  expect(fs.existsSync(path.join(env.AGENT_DIR, 'state/browser-lease.json'))).toBe(true);
});

test('concurrent claimers grant a single holder', async () => {
  const dir = freshDir();
  const env = { AGENT_DIR: path.join(dir, '.hermit') };
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runScript('browser.ts', { cwd: dir, env, args: ['claim', `task-${i}`] })));
  expect(results.every(result => result.exitCode === 0)).toBe(true);
  const grants = results.map(result => JSON.parse(result.stdout)).filter(result => result.status === 'claimed');
  expect(grants).toHaveLength(1);
});
