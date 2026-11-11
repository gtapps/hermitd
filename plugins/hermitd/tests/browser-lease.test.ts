import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserLease, BROWSER_IDLE_MS, reapOrphanedChrome, sweepBrowserLease } from '../scripts/lib/browser-lease';
import { browserProfile } from '../scripts/lib/browser-runtime';
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
    if (args[0] === 'status') {
      expect(['up', 'down', 'unsupported']).toContain(JSON.parse(result.stdout).display);
      expect(['up', 'down', 'off']).toContain(JSON.parse(result.stdout).viewer);
    }
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

test('human generations, disconnect expiry, forced release and browser loss preserve the claim', () => {
  const dir = freshDir();
  const opts = { login: 'admin', admins: ['admin'], chromeAlive: () => true };
  browserLease('claim', 'holder', dir, 0);
  const first = browserLease('takeover', undefined, dir, 10, opts);
  expect(browserLease('renew', 'holder', dir, BROWSER_IDLE_MS, opts).status).toBe('human');
  const second = browserLease('takeover', undefined, dir, BROWSER_IDLE_MS, opts);
  expect(second.epoch!).toBeGreaterThan(first.epoch!);
  expect(browserLease('hand-back', undefined, dir, BROWSER_IDLE_MS, { ...opts, generation: first.epoch }).status).toBe('stale_generation');
  browserLease('disconnect', undefined, dir, BROWSER_IDLE_MS, { ...opts, generation: second.epoch });
  const expired = browserLease('inspect', undefined, dir, BROWSER_IDLE_MS + 30 * 60 * 1000, opts);
  expect(expired.human).toBeNull();
  expect(expired.pending![0].reason).toBe('expired');
  expect(expired.expires_at).toBe(BROWSER_IDLE_MS * 2 + 30 * 60 * 1000);
  expect(expired.holder).toBe('holder');
  browserLease('takeover', undefined, dir, Date.now(), opts);
  expect(browserLease('human-release', undefined, dir, Date.now(), opts).status).toBe('released');
  browserLease('takeover', undefined, dir, Date.now(), opts);
  const lost = browserLease('inspect', undefined, dir, Date.now(), { chromeAlive: () => false });
  expect(lost.status).toBe('recovery');
  expect(lost.pending!.map(event => event.reason)).toEqual(['expired', 'released', 'browser_lost']);
  expect(new Set(lost.pending!.map(event => event.id)).size).toBe(3);
});

test('restart records a dropped viewer and hand back records the exact task wait', () => {
  const dir = freshDir();
  const { id } = openTask(dir, 'Login');
  blockOn(dir, id, 'admin');
  const opts = { login: 'admin', admins: ['admin'], chromeAlive: () => true };
  const taken = browserLease('takeover', id, dir, 100, opts);
  expect(taken.human!.task).toBe(id);
  expect(taken.human!.waiting_since).toBe(readTasks(dir)[0].waiting_since);
  browserLease('restart', undefined, dir, 200, opts);
  expect(browserLease('inspect', undefined, dir, 300, opts).human!.disconnected_at).toBe(200);
  browserLease('hand-back', undefined, dir, 400, { ...opts, generation: taken.epoch });
  expect(browserLease('inspect', undefined, dir, 400, opts).pending![0]).toMatchObject({ reason: 'hand_back', task: id, waiting_since: taken.human!.waiting_since });
  expect(readTasks(dir)[0].waiting_since).toBe(taken.human!.waiting_since);
});

test('a replaced takeover keeps its wait or releases it for a different task', () => {
  const dir = freshDir();
  const first = openTask(dir, 'First login');
  const second = openTask(dir, 'Second login');
  blockOn(dir, first.id, 'admin');
  blockOn(dir, second.id, 'admin');
  const opts = { login: 'admin', admins: ['admin'], chromeAlive: () => true };
  browserLease('takeover', first.id, dir, 100, opts);
  const bare = browserLease('takeover', undefined, dir, 200, opts);
  expect(bare.human!.task).toBe(first.id);
  const other = browserLease('takeover', second.id, dir, 300, opts);
  expect(other.human!.task).toBe(second.id);
  expect(browserLease('inspect', undefined, dir, 300, opts).pending!.map(event => [event.reason, event.task])).toEqual([['released', first.id]]);
  browserLease('hand-back', undefined, dir, 400, { ...opts, generation: other.epoch });
  expect(browserLease('inspect', undefined, dir, 400, opts).pending!.map(event => event.task)).toEqual([first.id, second.id]);
});

test('a claim during human control queues, and its wait clears after control returns', () => {
  const dir = freshDir();
  const { id } = openTask(dir, 'Signed-in work');
  const opts = { login: 'admin', admins: ['admin'], chromeAlive: () => true };
  const taken = browserLease('takeover', undefined, dir, 100, opts);
  expect(browserLease('claim', id, dir, 200, opts).status).toBe('human');
  blockOn(dir, id, 'admin');
  browserLease('hand-back', undefined, dir, 300, { ...opts, generation: taken.epoch });
  expect(readTasks(dir)[0].waiting_since).not.toBeNull();
  browserLease('status', undefined, dir, 400, opts);
  expect(readTasks(dir)[0].waiting_since).toBeNull();
});

test('the human-release verb frees control for the shutdown close', async () => {
  const { PLUGIN_ROOT } = await import('./helpers/run');
  const dir = freshDir();
  browserLease('takeover', undefined, dir, Date.now(), { login: 'admin', admins: ['admin'], chromeAlive: () => true });
  const child = Bun.spawn([process.execPath, path.join(PLUGIN_ROOT, 'scripts/browser.ts'), 'human-release'], { env: { ...process.env, AGENT_DIR: dir }, stdout: 'pipe' });
  expect(JSON.parse(await new Response(child.stdout).text()).status).toBe('released');
  expect(browserLease('inspect', undefined, dir, Date.now(), { chromeAlive: () => true }).pending![0].reason).toBe('released');
});

test('event delivery advances after print, skips replayed ids across restarts and prunes on the next transaction', async () => {
  const { deliverBrowserEvents } = await import('../scripts/browser');
  const dir = freshDir();
  const opts = { login: 'admin', admins: ['admin'], chromeAlive: () => true };
  for (let i = 0; i < 2; i++) {
    browserLease('takeover', undefined, dir, Date.now(), opts);
    browserLease('human-release', undefined, dir);
  }
  const original = browserLease('inspect', undefined, dir).pending!;
  const printed: string[] = [];
  const print = async (event: { id: string }) => { printed.push(event.id); };
  await deliverBrowserEvents(dir, print);
  expect(printed).toEqual(original.map(event => event.id));
  await deliverBrowserEvents(dir, print);
  expect(printed).toHaveLength(2);
  expect(browserLease('inspect', undefined, dir).pending).toEqual([]);
  const file = path.join(dir, 'state/browser-lease.json');
  const replay = JSON.parse(fs.readFileSync(file, 'utf8'));
  replay.pending = original;
  fs.writeFileSync(file, JSON.stringify(replay));
  await deliverBrowserEvents(dir, print);
  expect(printed).toHaveLength(2);
  browserLease('takeover', undefined, dir, Date.now(), opts);
  browserLease('human-release', undefined, dir);
  await expect(deliverBrowserEvents(dir, async () => { throw new Error('interrupted print'); })).rejects.toThrow('interrupted print');
  await deliverBrowserEvents(dir, print);
  expect(printed).toHaveLength(3);
});

test('events subprocess emits one line and stays alive until signalled, restart remains silent', async () => {
  const { PLUGIN_ROOT } = await import('./helpers/run');
  const dir = freshDir();
  browserLease('takeover', undefined, dir, Date.now(), { login: 'admin' });
  browserLease('human-release', undefined, dir);
  const start = () => Bun.spawn([process.execPath, path.join(PLUGIN_ROOT, 'scripts/browser.ts'), 'events'], {
    env: { ...process.env, AGENT_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
  });
  const first = start();
  const reader = first.stdout.getReader();
  const result = await reader.read();
  expect(new TextDecoder().decode(result.value).trim().split('\n')).toHaveLength(1);
  expect(first.exitCode).toBeNull();
  // Exit via signal only after the cursor has been durably advanced.
  await reader.cancel();
  first.kill('SIGTERM');
  expect(await first.exited).toBe(0);
  const second = start();
  // A second pending event gives an explicit readiness signal without idle sleeps.
  browserLease('takeover', undefined, dir, Date.now(), { login: 'admin' });
  browserLease('human-release', undefined, dir);
  const nextReader = second.stdout.getReader();
  const next = await nextReader.read();
  expect(new TextDecoder().decode(next.value).trim().split('\n')).toHaveLength(1);
  second.kill('SIGTERM');
  expect(await second.exited).toBe(0);
  await nextReader.cancel();
});

test('viewer expiry never writes tasks and a link still names the waiting task after its claim expires', () => {
  const dir = freshDir();
  const task = openTask(dir, 'Login after expiry');
  browserLease('claim', task.id, dir, 0);
  blockOn(dir, task.id, 'admin');
  const file = path.join(dir, 'tasks', task.id + '.md');
  const before = fs.readFileSync(file, 'utf8');
  const opts = { login: 'admin', admins: ['admin'], chromeAlive: () => true };
  const takeover = browserLease('takeover', task.id, dir, BROWSER_IDLE_MS + 1, opts);
  expect(browserLease('inspect', undefined, dir, BROWSER_IDLE_MS + 2, opts).holder).toBeNull();
  expect(takeover.human!.task).toBe(task.id);
  browserLease('hand-back', undefined, dir, BROWSER_IDLE_MS + 3, { ...opts, generation: takeover.epoch });
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(browserLease('claim', task.id, dir, BROWSER_IDLE_MS + 4).status).toBe('claimed');
});

test('forced release with no human writes nothing, even with a delivered event awaiting pruning', async () => {
  const { deliverBrowserEvents } = await import('../scripts/browser');
  const dir = freshDir();
  browserLease('takeover', undefined, dir, Date.now(), { login: 'admin' });
  browserLease('human-release', undefined, dir);
  await deliverBrowserEvents(dir, async () => {});
  const file = path.join(dir, 'state/browser-lease.json');
  const before = fs.readFileSync(file, 'utf8');
  expect(browserLease('human-release', undefined, dir).status).toBe('nothing_held');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});

test('teardown takes and drops the claim without sweeping queued tasks', () => {
  const dir = freshDir();
  browserLease('claim', 'holder', dir);
  browserLease('claim', 'queued', dir);
  expect(browserLease('teardown', 'shutdown', dir)).toMatchObject({ status: 'claimed', holder: 'shutdown' });
  browserLease('teardown', undefined, dir);
  expect(browserLease('inspect', undefined, dir).waiters).toEqual([{ task: 'queued', waiting_on: 'holder' }]);
});

test('the idle claim is taken only from an unheld, unused profile', () => {
  const dir = freshDir();
  const opts = { idleMs: 100, chromeAlive: () => true };
  browserLease('claim', 'task-a', dir, 0);
  expect(browserLease('idle', 'idle-close', dir, 500, opts).status).toBe('active');
  browserLease('release', 'task-a', dir, 10);
  expect(browserLease('idle', 'idle-close', dir, 109, opts).status).toBe('active');
  expect(browserLease('idle', 'idle-close', dir, 110, opts)).toEqual({ status: 'claimed', holder: 'idle-close' });
  browserLease('release', 'idle-close', dir, 120);
  browserLease('takeover', undefined, dir, 130, { login: 'admin', admins: ['admin'], chromeAlive: () => true });
  expect(browserLease('idle', 'idle-close', dir, 10_000, opts).status).toBe('human');
});

test('the sweep closes an unclaimed browser past the setting, and 0 disables it', () => {
  const dir = freshDir();
  const closed: string[] = [];
  const deps = (now: number) => ({ now, pids: () => [1], wrapperClose: (_: string, task: string) => { closed.push(task); } });
  const setIdle = (seconds: number) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ browser: { inactivity_timeout: seconds } }));
  setIdle(60);
  browserLease('claim', 'task-a', dir, 0);
  sweepBrowserLease(dir, deps(BROWSER_IDLE_MS - 1));
  expect(closed).toEqual([]);
  browserLease('release', 'task-a', dir, 1000);
  sweepBrowserLease(dir, deps(60_999));
  expect(closed).toEqual([]);
  setIdle(0);
  sweepBrowserLease(dir, deps(10 * 60_000));
  expect(closed).toEqual([]);
  setIdle(60);
  sweepBrowserLease(dir, deps(61_000));
  expect(closed).toEqual(['idle-close']);
  expect(browserLease('status', undefined, dir, 61_000).status).toBe('available');
});

test('the boot reap signals only Chrome on this profile, and never a held one', async () => {
  const dir = path.join(freshDir(), '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const script = path.join(path.dirname(dir), 'fake-chrome.js');
  fs.writeFileSync(script, "console.log('ready'); setInterval(() => {}, 1000);\n");
  const start = async (profile: string) => {
    const child = Bun.spawn([process.execPath, script, `--user-data-dir=${profile}`], { stdout: 'pipe' });
    for await (const chunk of child.stdout) if (new TextDecoder().decode(chunk).includes('ready')) break;
    return child;
  };
  const noClose = { wrapperClose: () => {} };
  const ours = await start(browserProfile(dir));
  const other = await start(path.join(path.dirname(dir), 'other-profile'));
  try {
    browserLease('claim', 'task-a', dir);
    expect(reapOrphanedChrome(dir, noClose)).toBe(false);
    browserLease('release', 'task-a', dir);
    browserLease('takeover', undefined, dir, Date.now(), { login: 'admin', admins: ['admin'] });
    expect(reapOrphanedChrome(dir, noClose)).toBe(false);
    browserLease('human-release', undefined, dir);
    expect(reapOrphanedChrome(dir, noClose)).toBe(true);
    await ours.exited;
    expect(other.exitCode).toBeNull();
  } finally { ours.kill(); other.kill(); }
});
