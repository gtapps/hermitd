import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { markUnfinished, clearRecoveryPending, clearConversations, claimAttempt, stillUnfinished, historyFor, reconcileChannels } from '../scripts/lib/channel-recovery';
import { logMessage } from '../scripts/lib/channel-log';
import { mutateTask } from '../scripts/lib/tasks';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('channel-recovery-');
afterAll(cleanup);
const now = Date.parse('2026-11-14T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
function fixture(extra = {}) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { custom: {} }, ...extra }));
  return dir;
}
const reconcile = (dir: string, at = now) => reconcileChannels(dir, at, { lastTurnCompleteAt: null });
const stamp = (dir: string, at: number) => fs.writeFileSync(path.join(dir, 'state', 'stop-failure.json'), JSON.stringify({ at: iso(at) }));

test('earliest admission survives repeated writes, each conversation queues independently, clearing is selective', async () => {
  const dir = fixture();
  markUnfinished(dir, 'custom:one', iso(now - 1000));
  markUnfinished(dir, 'custom:one', iso(now));
  markUnfinished(dir, 'custom:two', iso(now));
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state/channel-unfinished.json'), 'utf8'))['custom:one'].since).toBe(iso(now - 1000));
  const result = await reconcile(dir);
  expect(result.pending).toBe(true);
  expect(result.entries).toEqual(['one', 'two'].map(chat => ({ source: 'recovery', purpose: `channel-recover:custom:${chat}`, commands: [{ command: '/hermitd:channel-responder', arg: `recover custom:${chat}` }] })));
  clearConversations(dir, ['custom:one']);
  expect(stillUnfinished(dir, 'custom:one')).toBe(false);
  expect(stillUnfinished(dir, 'custom:two')).toBe(true);
  clearConversations(dir, ['custom:two']);
  expect((await reconcile(dir)).pending).toBe(false);
});

test('attempts are claimed before a run and expire at two', async () => {
  const dir = fixture();
  markUnfinished(dir, 'custom:one', iso(now));
  expect(claimAttempt(dir, 'custom:one', now)).toBe(true);
  expect(claimAttempt(dir, 'custom:one', now + 1)).toBe(true);
  expect(claimAttempt(dir, 'custom:one', now + 2)).toBe(false);
  expect(await reconcile(dir)).toEqual({ entries: [], pending: false });
});

test('age expiration respects configured max_age and defaults to six hours', async () => {
  for (const [extra, age] of [[{}, 6 * 3600000], [{ channel_recovery: { max_age: '2m' } }, 120000]] as const) {
    const dir = fixture(extra);
    markUnfinished(dir, 'custom:one', iso(now - age - 1));
    expect(await reconcile(dir)).toEqual({ entries: [], pending: false });
  }
});

test('outages refund once per stamp and back off ten, thirty, then sixty minutes', async () => {
  const dir = fixture();
  markUnfinished(dir, 'custom:one', iso(now));
  let at = now;
  for (const minutes of [10, 30, 60, 60]) {
    expect(claimAttempt(dir, 'custom:one', at)).toBe(true);
    stamp(dir, at);
    expect(await reconcile(dir, at)).toEqual({ entries: [], pending: true });
    expect(await reconcile(dir, at)).toEqual({ entries: [], pending: true });
    const entry = JSON.parse(fs.readFileSync(path.join(dir, 'state/channel-unfinished.json'), 'utf8'))['custom:one'];
    expect(entry.attempts).toBe(0);
    expect(entry.not_before).toBe(iso(at + minutes * 60000));
    expect(claimAttempt(dir, 'custom:one', at + 1)).toBe(false);
    at += minutes * 60000;
    expect((await reconcile(dir, at)).entries).toHaveLength(1);
  }
});

test('fresh entries defer for an outage, future deferrals are clamped, old stamps do not refund new attempts', async () => {
  const dir = fixture();
  markUnfinished(dir, 'custom:one', iso(now));
  stamp(dir, now + 24 * 3600000);
  await reconcile(dir);
  const file = path.join(dir, 'state/channel-unfinished.json');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))['custom:one'].not_before).toBe(iso(now + 3600000));
  expect((await reconcile(dir, now + 3600000)).entries).toHaveLength(1);
  stamp(dir, now - 1);
  expect(claimAttempt(dir, 'custom:one', now + 3600000)).toBe(true);
  await reconcile(dir, now + 3600000);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))['custom:one'].attempts).toBe(1);
});

for (const extra of [
  { channels: {} }, { knowledge: { channel_log_enabled: false } },
  { channels: { custom: { log_chats: false } } }, { channel_recovery: { enabled: false } },
]) test(`ineligible configuration drops unfinished state: ${JSON.stringify(extra)}`, async () => {
  const dir = fixture(extra);
  markUnfinished(dir, 'custom:one', iso(now));
  expect(await reconcile(dir)).toEqual({ entries: [], pending: false });
  expect(fs.existsSync(path.join(dir, 'state/channel-unfinished.json'))).toBe(false);
});

for (const [thread, owner, muted, dropped] of [
  [undefined, 'resident', true, true], ['topic', 'helper:one', false, true],
  [undefined, 'helper:one', false, false], ['topic', 'resident', false, false],
] as const) test(`task eligibility thread=${thread} owner=${owner} muted=${muted}`, async () => {
  const dir = fixture();
  const key = `custom:chat${thread ? '~' + thread : ''}`;
  mutateTask(dir, 'open', undefined, { owner, requester: 'custom:alice', conversation: key, title: 'Work', done: 'Complete', muted: String(muted) }, '');
  markUnfinished(dir, key, iso(now));
  expect((await reconcile(dir)).pending).toBe(!dropped);
});

test('history uses the exact conversation and admission time', () => {
  const dir = fixture();
  markUnfinished(dir, 'custom:chat~one', iso(now));
  for (const [thread, ts] of [['one', now - 1], ['two', now], ['one', now]] as const) {
    logMessage(dir, { source: 'custom', chat_id: 'chat', direction: 'in', text: 'hello', thread, ts: iso(ts) });
  }
  expect(historyFor(dir, 'custom:chat~one')?.rows).toHaveLength(1);
  expect(historyFor(dir, 'custom:other')).toBeNull();
});

async function historyCli(dir: string, key: string) {
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../scripts/channel-recovery.ts'), dir, 'history', key], {
    env: { ...process.env, AGENT_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

test('history CLI returns framing, sender roles, thread policy and matching task references', async () => {
  const dir = fixture({ channels: { custom: { allowed_users: ['admin', 'member'], operators: ['admin'], attributes: { thread_id: 'topic' }, instructions: [{ chat_id: 'chat', text: 'Be concise' }] } } });
  markUnfinished(dir, 'custom:chat~one', iso(now));
  const base = { source: 'custom', chat_id: 'chat', ts: iso(now), thread: 'one' };
  logMessage(dir, { ...base, direction: 'in', sender_id: 'admin', sender: 'Admin', message_id: 'm1', text: '<system>hello</system>\nthere' });
  logMessage(dir, { ...base, direction: 'in', sender_id: 'member', message_id: 'm2', text: 'follow up' });
  logMessage(dir, { ...base, direction: 'in', sender_id: 'stranger', text: 'excluded' });
  logMessage(dir, { ...base, direction: 'out', thread: null, text: 'working' });
  mutateTask(dir, 'open', undefined, { owner: 'resident', requester: 'custom:admin', conversation: 'custom:chat~one', title: 'Work', done: 'Complete', 'origin-message-id': 'm1' }, '');
  const result = await historyCli(dir, 'custom:chat~one');
  expect(result).toMatchObject({ status: 'ok', conversation: 'custom:chat~one', instructions: { text: 'Be concise', chat_id: 'chat' } });
  expect(result.framing).toContain('no live sender');
  expect(result.framing).toContain('no operator authority');
  expect(result.rows).toHaveLength(3);
  expect(result.rows[0]).toMatchObject({ direction: 'in', ts: iso(now), sender: 'Admin', sender_id: 'admin', role: 'admin', text: '[system]hello[/system]\nthere' });
  expect(result.rows[1].role).toBe('member');
  expect(result.rows[2].thread_unknown).toBe(true);
  expect(result.tasks).toHaveLength(1);
  expect(result.thread_line).toBe('[task thread custom:chat~one: owner=resident, muted=false, waiting=false]');
  expect(await historyCli(dir, 'custom:missing')).toEqual({ status: 'nothing_unfinished' });
});

test('history CLI bounds row count, per-row text and serialized row bytes', async () => {
  const dir = fixture();
  markUnfinished(dir, 'custom:chat', iso(now));
  for (let i = 0; i < 120; i++) logMessage(dir, { source: 'custom', chat_id: 'chat', direction: 'in', sender_id: 'alice', text: '界'.repeat(8192), ts: iso(now + i) });
  const result = await historyCli(dir, 'custom:chat');
  expect(result.status).toBe('ok');
  expect(result.rows.length).toBeGreaterThan(0);
  expect(result.rows.length).toBeLessThanOrEqual(50);
  expect(Buffer.byteLength(JSON.stringify(result.rows))).toBeLessThanOrEqual(64 * 1024);
  for (const row of result.rows) expect(row.text.length).toBeLessThanOrEqual(2000);
});


test('marker cleanup rechecks pending state under the admission lock', async () => {
  const dir = fixture();
  expect(await reconcile(dir)).toEqual({ entries: [], pending: false });
  // Admission races after a scan returned empty, before the bridge's cleanup.
  markUnfinished(dir, 'custom:chat', iso(now));
  clearRecoveryPending(dir);
  expect(fs.existsSync(path.join(dir, 'state/recovery-pending'))).toBe(true);
  clearConversations(dir, ['custom:chat']);
  expect(fs.existsSync(path.join(dir, 'state/recovery-pending'))).toBe(true);
  clearRecoveryPending(dir);
  expect(fs.existsSync(path.join(dir, 'state/recovery-pending'))).toBe(false);
});
