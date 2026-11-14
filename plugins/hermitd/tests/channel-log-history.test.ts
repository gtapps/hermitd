import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { conversationHistory, dbExists, enrichInbound, logMessage, rows, searchLog } from '../scripts/lib/channel-log';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('conversation-history-');
afterAll(cleanup);

test('inbound enrichment preserves sender and body, is searchable and idempotent', () => {
  const dir = freshDir();
  const target = { source: 'custom', chat_id: 'chat', message_id: 'voice' };
  logMessage(dir, { ...target, direction: 'in', sender: 'Alice', sender_id: 'alice', text: '(attachment)' });
  logMessage(dir, { ...target, direction: 'out', text: 'outbound unchanged' });
  const input = { ...target, transcript: 'Buy kumquats tomorrow' };
  expect(enrichInbound(dir, input)).toEqual({ ok: true });
  expect(enrichInbound(dir, input)).toEqual({ ok: true });
  const found = searchLog(dir, ['kumquats']);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ ...target, sender: 'Alice', text: '(attachment)\n🎙️ Buy kumquats tomorrow', direction: 'in' });
  expect(rows(dir).rows[0].sender_id).toBe('alice');
  expect(rows(dir).rows[1].text).toBe('outbound unchanged');
  expect(searchLog(dir, ['attachment'])).toHaveLength(1);
});

test('enrichment keeps the stored text cap', () => {
  const dir = freshDir();
  const input = { source: 'custom', chat_id: 'chat', message_id: 'voice', transcript: 'x'.repeat(10_000) };
  logMessage(dir, { ...input, direction: 'in', text: '(attachment)' });
  expect(enrichInbound(dir, input)).toEqual({ ok: true });
  expect(enrichInbound(dir, input)).toEqual({ ok: true });
  expect(rows(dir).rows[0].text).toHaveLength(8 * 1024);
});

test('enrichment with logging off or no row is a no-op and never creates a database', () => {
  const dir = freshDir();
  const input = { source: 'custom', chat_id: 'chat', message_id: 'voice', transcript: 'spoken' };
  expect(enrichInbound(dir, input)).toEqual({ ok: false });
  expect(dbExists(dir)).toBe(false);
  logMessage(dir, { ...input, direction: 'in', text: '(attachment)' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ knowledge: { channel_log_enabled: false } }));
  expect(enrichInbound(dir, input)).toEqual({ ok: false });
  expect(rows(dir).rows[0].text).toBe('(attachment)');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  expect(enrichInbound(dir, { ...input, message_id: 'absent' })).toEqual({ ok: false });
});

test('history selects the newest rows across both directions in chronological order', () => {
  const dir = freshDir();
  const rows = [
    { ts: '2026-09-12T10:03:00Z', direction: 'out', sender: 'helper', text: 'result' },
    { ts: '2026-09-12T10:01:00Z', direction: 'in', sender: 'alice', text: 'task' },
    { ts: '2026-09-12T10:02:00Z', direction: 'out', sender: 'helper', text: 'working' },
    { ts: '2026-09-12T10:02:00Z', direction: 'in', sender: 'bob', text: 'steering' },
  ] as const;
  for (const row of rows) expect(logMessage(dir, { source: 'discord', chat_id: 'thread', ...row }).ok).toBe(true);
  logMessage(dir, { source: 'discord', chat_id: 'other', ...rows[0], text: 'another chat' });
  logMessage(dir, { source: 'telegram', chat_id: 'thread', ...rows[0], text: 'another source' });
  expect(conversationHistory(dir, 'discord', 'thread', { limit: 3 })).toEqual([rows[2], rows[3], rows[0]]);
  expect(conversationHistory(dir, 'discord', 'thread', { limit: 0 })).toEqual([]);
});

test('missing, disabled, and unreadable logs return an empty history', () => {
  const dir = freshDir();
  expect(conversationHistory(dir, 'discord', 'thread', { limit: 10 })).toEqual([]);
  expect(dbExists(dir)).toBe(false);
  logMessage(dir, { source: 'discord', chat_id: 'thread', direction: 'in', text: 'old message' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ knowledge: { channel_log_enabled: false } }));
  expect(conversationHistory(dir, 'discord', 'thread', { limit: 10 })).toEqual([]);
  const broken = freshDir();
  fs.mkdirSync(path.join(broken, 'state'));
  fs.writeFileSync(path.join(broken, 'state', 'channel-log.sqlite'), 'not a database');
  expect(conversationHistory(broken, 'discord', 'thread', { limit: 10 })).toEqual([]);
});


test('all message directions redact local sign-in callbacks and preserve other URLs', () => {
  const dir = freshDir();
  const ordinary = 'https://example.com/callback?code=public http://localhost:3000/health';
  for (const direction of ['in', 'out'] as const) {
    for (const callback of ['http://localhost:1234/callback?code=secret', '127.0.0.1/callback?state=private', 'HTTPS://LOCALHOST/callback?x=1&code=secret', 'http://localhost:1234?code=secret', 'http://[::1]:1234/callback?code=secret']) {
      expect(logMessage(dir, { source: 'custom', chat_id: 'home', direction, text: `before ${callback} after ${ordinary}` }).ok).toBe(true);
    }
  }
  const rows = conversationHistory(dir, 'custom', 'home', { limit: 10 });
  expect(rows).toHaveLength(10);
  for (const row of rows) expect(row.text).toBe(`before [sign-in callback omitted] after ${ordinary}`);
});

test('history filters since and threads while retaining unknown outbound threads', () => {
  const dir = freshDir();
  const base = { source: 'custom', chat_id: 'chat', sender_id: 'alice', text: 'message' };
  for (const row of [
    { direction: 'in', thread: 'one', ts: '2026-09-12T10:00:00Z' },
    { direction: 'in', thread: 'one', ts: '2026-09-12T10:01:00Z' },
    { direction: 'in', thread: 'two', ts: '2026-09-12T10:02:00Z' },
    { direction: 'in', ts: '2026-09-12T10:03:00Z' },
    { direction: 'out', ts: '2026-09-12T10:04:00Z' },
    { direction: 'out', thread: 'two', ts: '2026-09-12T10:05:00Z' },
  ] as const) expect(logMessage(dir, { ...base, ...row }).ok).toBe(true);
  const history = conversationHistory(dir, 'custom', 'chat', {
    limit: 10, since: '2026-09-12T10:01:00Z', thread: 'one', senderIds: ['alice'],
  });
  expect(history.map(row => row.ts)).toEqual(['2026-09-12T10:01:00Z', '2026-09-12T10:04:00Z']);
  expect(history[0].thread_unknown).toBeUndefined();
  expect(history[1].thread_unknown).toBe(true);
  expect(conversationHistory(dir, 'custom', 'chat', { limit: 10, since: '2026-09-12T10:04:00Z' })).toHaveLength(2);
  expect(conversationHistory(dir, 'custom', 'chat', { limit: 10, thread: 'one', senderIds: [] })).toHaveLength(1);
});


test('existing databases gain thread storage once across repeated writes', () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'state'));
  const file = path.join(dir, 'state', 'channel-log.sqlite');
  const db = new Database(file);
  db.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, source TEXT NOT NULL,
    chat_id TEXT NOT NULL, direction TEXT NOT NULL, sender TEXT, sender_id TEXT,
    message_id TEXT, text TEXT NOT NULL
  )`);
  db.close();
  for (let i = 0; i < 2; i++) {
    expect(logMessage(dir, { source: 'custom', chat_id: 'chat', direction: 'in', text: 'hello', thread: 'topic' }).ok).toBe(true);
  }
  expect(rows(dir).rows.map(row => row.thread)).toEqual(['topic', 'topic']);
  const migrated = new Database(file, { readonly: true });
  try {
    const columns = migrated.query('PRAGMA table_info(messages)').all() as { name: string }[];
    expect(columns.filter(column => column.name === 'thread')).toHaveLength(1);
  } finally { migrated.close(); }
});
