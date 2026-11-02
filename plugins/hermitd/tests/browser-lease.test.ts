import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserLease, BROWSER_IDLE_MS, sweepBrowserLease } from '../scripts/lib/browser-lease';
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
  expect(browserLease('renew', 'task-b', dir, 5)).toEqual({ status: 'not_holder', holder: 'task-a' });
  expect(browserLease('renew', 'task-a', dir, 10).expires_at).toBe(BROWSER_IDLE_MS + 10);
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

const openTask = (dir: string, title: string) => mutateTask(dir, 'open', undefined, { title, requester: 'discord:u1', done: 'checked' }, '') as { id: string };
const blockOn = (dir: string, id: string, holder: string) => mutateTask(dir, 'block', id, { 'waiting-on': holder, 'status-line': 'Browser busy', next: 'Retry claim' }, '');

test('a stale task release leaves the current holder claimed', () => {
  const dir = freshDir();
  browserLease('claim', 'task-a', dir, 0);
  browserLease('claim', 'task-b', dir, BROWSER_IDLE_MS);
  expect(browserLease('release', 'task-a', dir, BROWSER_IDLE_MS + 1)).toEqual({ status: 'not_holder', holder: 'task-b' });
  expect(browserLease('status', undefined, dir, BROWSER_IDLE_MS + 1).holder).toBe('task-b');
  expect(browserLease('release', 'task-b', dir, BROWSER_IDLE_MS + 1).status).toBe('released');
});

test('the sweep expires a dead holder and wakes its waiter', () => {
  const dir = freshDir();
  sweepBrowserLease(dir);
  expect(fs.existsSync(path.join(dir, 'state/browser-lease.json'))).toBe(false);
  const a = openTask(dir, 'Waiter');
  browserLease('claim', 'holder', dir, 0);
  browserLease('claim', a.id, dir, 1);
  blockOn(dir, a.id, 'holder');
  sweepBrowserLease(dir);
  expect(browserLease('status', undefined, dir).status).toBe('available');
  expect(readTasks(dir)[0].waiting_on).toBeNull();
});

test('a task that blocks after the release is woken by the next status', () => {
  const dir = freshDir();
  const a = openTask(dir, 'Late blocker');
  browserLease('claim', 'holder', dir);
  browserLease('claim', a.id, dir);
  browserLease('release', 'holder', dir);
  blockOn(dir, a.id, 'holder');
  expect(readTasks(dir)[0].waiting_on).toBe('holder');
  browserLease('status', undefined, dir);
  expect(readTasks(dir)[0].waiting_on).toBeNull();
});

test('a waiter that retries against a new holder is woken by that holder', () => {
  const dir = freshDir();
  const a = openTask(dir, 'Retrier');
  browserLease('claim', 'first', dir);
  browserLease('claim', a.id, dir);
  browserLease('release', 'first', dir);
  browserLease('claim', 'second', dir);
  browserLease('claim', a.id, dir);
  blockOn(dir, a.id, 'second');
  browserLease('release', 'second', dir);
  expect(readTasks(dir)[0].waiting_on).toBeNull();
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
