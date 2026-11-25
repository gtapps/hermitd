import { describe, test, expect } from 'bun:test';
import { runScript, runPinnedScript } from './helpers/run';
import { withDir, hermit } from './helpers/workdir';
import { logMessage, searchLog, rows as channelRows, unaddressedSince, prune, dbExists } from '../scripts/lib/channel-log';

describe('channel-log', () => {
  describe('lib/channel-log.ts (in-process)', () => {
    test('dbExists is false before any insert, true after', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      expect(dbExists(hermitPath)).toBe(false);
      logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'hi there' });
      expect(dbExists(hermitPath)).toBe(true);
    }));

    test('logMessage + searchLog roundtrip carries all fields', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      const r = logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', message_id: 'M1',
        text: 'the foo-bar baz thing', ts: '2026-06-01T00:00:00.000Z',
      });
      expect(r.ok).toBe(true);
      const hits = searchLog(hermitPath, ['foo-bar']);
      expect(hits.length).toBe(1);
      expect(hits[0]).toMatchObject({
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', message_id: 'M1',
        text: 'the foo-bar baz thing',
      });
    }));

    test('searchLog scopes own, channel, and shared rows by source and chat', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      for (const [source, chat_id] of [['discord', 'C1'], ['discord', 'C2'], ['telegram', 'C1'], ['telegram', 'T2']]) {
        expect(logMessage(hermitPath, { source, chat_id, direction: 'in', text: 'scopeword' }).ok).toBe(true);
      }
      const own = { source: 'discord', chat_id: 'C1' };
      const hits = (scope: { own: { source?: string; chat_id?: string }; channel?: string; shared: { source: string; chat_id: string }[] }) => searchLog(hermitPath, ['scopeword'], { scope }).map((row) => `${row.source}:${row.chat_id}`).sort();
      expect(hits({ own, shared: [] })).toEqual(['discord:C1']);
      expect(hits({ own, channel: 'discord', shared: [] })).toEqual(['discord:C1', 'discord:C2']);
      expect(hits({ own, shared: [{ source: 'telegram', chat_id: 'T2' }] })).toEqual(['discord:C1', 'telegram:T2']);
      expect(hits({ own: { chat_id: 'C1' }, shared: [] })).toEqual([]);
      expect(hits({ own: { source: 'discord' }, shared: [] })).toEqual([]);
      expect(searchLog(hermitPath, ['scopeword'])).toHaveLength(4);
    }));

    test('searchLog applies scope before the candidate limit', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      for (let i = 0; i < 250; i++) {
        expect(logMessage(hermitPath, { source: 'discord', chat_id: 'C2', direction: 'in', text: 'rankword' }).ok).toBe(true);
      }
      expect(logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'rankword with extra words to rank behind forbidden rows' }).ok).toBe(true);
      expect(searchLog(hermitPath, ['rankword']).every((row) => row.chat_id === 'C2')).toBe(true);
      expect(searchLog(hermitPath, ['rankword'], { scope: { own: { source: 'discord', chat_id: 'C1' }, shared: [] } })).toHaveLength(1);
    }));

    test('logMessage round-trips sender_id and leaves sender unchanged', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      const stored = logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'display', sender_id: 'U1',
        text: 'id-bearing inbound',
      });
      expect(stored.ok).toBe(true);
      const omitted = logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'display',
        text: 'id-omitted inbound',
      });
      expect(omitted.ok).toBe(true);
      const { rows } = channelRows(hermitPath);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: 'id-bearing inbound', sender: 'display', sender_id: 'U1' }),
        expect.objectContaining({ text: 'id-omitted inbound', sender: 'display', sender_id: null }),
      ]));
    }));

    test('searchLog uses OR semantics across terms, not AND', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'only apple here' });
      logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'only banana here' });
      logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'neither fruit' });
      const hits = searchLog(hermitPath, ['apple', 'banana']);
      expect(hits.length).toBe(2);
    }));

    test('searchLog since filter excludes older rows', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'old message', ts: '2020-01-01T00:00:00.000Z' });
      const future = new Date(Date.now() + 60_000).toISOString();
      expect(searchLog(hermitPath, ['old'], { since: future }).length).toBe(0);
      expect(searchLog(hermitPath, ['old']).length).toBe(1);
    }));

    test('searchLog type filter: non-channel type returns nothing', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'some text' });
      expect(searchLog(hermitPath, ['some'], { type: 'compiled' }).length).toBe(0);
      expect(searchLog(hermitPath, ['some'], { type: 'channel' }).length).toBe(1);
    }));

    test('searchLog returns [] when the DB does not exist (feature-detect)', withDir(async (dir) => {
      expect(searchLog(hermit(dir), ['anything'])).toEqual([]);
    }));

    test('retention prunes old rows and keeps recent rows without review bookkeeping', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'expired fact', ts: '2000-01-01T00:00:00.000Z' });
      logMessage(hermitPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'recent fact' });
      expect(channelRows(hermitPath).rows).toHaveLength(2);
      expect(prune(hermitPath, 90)).toEqual({ ok: true, deleted: 1 });
      expect(channelRows(hermitPath).rows.map(row => row.text)).toEqual(['recent fact']);
      expect(searchLog(hermitPath, ['expired'])).toEqual([]);
    }));

    test('channelRows/prune on a hermit with no channel activity: ok:true, empty/zero (no DB created)', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      expect(channelRows(hermitPath)).toEqual({ ok: true, rows: [] });
      expect(prune(hermitPath, 90)).toEqual({ ok: true, deleted: 0 });
      expect(dbExists(hermitPath)).toBe(false);
    }));

    test('unaddressedSince returns [] when the DB does not exist', withDir(async (dir) => {
      expect(unaddressedSince(hermit(dir), 'discord', 'C1', {
        notBeforeIso: '2026-01-01T00:00:00.000Z', senderIds: null,
      })).toEqual([]);
    }));

    test('unaddressedSince excludes inbound before the newest outbound and includes inbound after', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'before-out', ts: '2026-06-01T00:00:00.000Z',
      });
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'out', sender: 'bot',
        text: 'reply', ts: '2026-06-01T00:01:00.000Z',
      });
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'after-out', ts: '2026-06-01T00:02:00.000Z',
      });
      const rows = unaddressedSince(hermitPath, 'discord', 'C1', {
        notBeforeIso: '2026-01-01T00:00:00.000Z', senderIds: ['U1'],
      });
      expect(rows.map((r) => r.text)).toEqual(['after-out']);
    }));

    test('unaddressedSince excludes inbound older than notBeforeIso even with no outbound row', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'too-old', ts: '2026-06-01T00:00:00.000Z',
      });
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'in-window', ts: '2026-06-01T02:00:00.000Z',
      });
      const rows = unaddressedSince(hermitPath, 'discord', 'C1', {
        notBeforeIso: '2026-06-01T01:00:00.000Z', senderIds: ['U1'],
      });
      expect(rows.map((r) => r.text)).toEqual(['in-window']);
    }));

    test('unaddressedSince excludes other chats', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'here', ts: '2026-06-01T00:00:00.000Z',
      });
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C2', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'elsewhere', ts: '2026-06-01T00:01:00.000Z',
      });
      const rows = unaddressedSince(hermitPath, 'discord', 'C1', {
        notBeforeIso: '2026-01-01T00:00:00.000Z', senderIds: ['U1'],
      });
      expect(rows.map((r) => r.text)).toEqual(['here']);
    }));

    test('unaddressedSince applies the allowlist in SQL before LIMIT', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'allowed', ts: '2026-06-01T00:00:00.000Z',
      });
      for (let i = 1; i <= 8; i++) {
        logMessage(hermitPath, {
          source: 'discord', chat_id: 'C1', direction: 'in', sender: 'STRANGER', sender_id: 'STRANGER',
          text: `stranger-${i}`, ts: `2026-06-01T00:0${i}:00.000Z`,
        });
      }
      const rows = unaddressedSince(hermitPath, 'discord', 'C1', {
        notBeforeIso: '2026-01-01T00:00:00.000Z', senderIds: ['U1'], limit: 8,
      });
      expect(rows.map((r) => r.text)).toEqual(['allowed']);
    }));

    test('unaddressedSince never returns a row with null sender_id', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1',
        text: 'no-id', ts: '2026-06-01T00:00:00.000Z',
      });
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'has-id', ts: '2026-06-01T00:01:00.000Z',
      });
      const rows = unaddressedSince(hermitPath, 'discord', 'C1', {
        notBeforeIso: '2026-01-01T00:00:00.000Z', senderIds: null,
      });
      expect(rows.map((r) => r.text)).toEqual(['has-id']);
    }));

    test('unaddressedSince with senderIds [] returns nothing', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'anyone', ts: '2026-06-01T00:00:00.000Z',
      });
      expect(unaddressedSince(hermitPath, 'discord', 'C1', {
        notBeforeIso: '2026-01-01T00:00:00.000Z', senderIds: [],
      })).toEqual([]);
    }));

    test('unaddressedSince keeps the newest limit rows and returns them oldest first', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      for (let i = 0; i < 10; i++) {
        logMessage(hermitPath, {
          source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
          text: `row-${i}`, ts: `2026-06-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        });
      }
      const rows = unaddressedSince(hermitPath, 'discord', 'C1', {
        notBeforeIso: '2026-01-01T00:00:00.000Z', senderIds: ['U1'], limit: 8,
      });
      expect(rows.map((r) => r.text)).toEqual(['row-2', 'row-3', 'row-4', 'row-5', 'row-6', 'row-7', 'row-8', 'row-9']);
    }));

    test('unaddressedSince equal-ts rows come back in insertion order', withDir(async (dir) => {
      const hermitPath = hermit(dir);
      const ts = '2026-06-01T00:00:00.000Z';
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'first', ts,
      });
      logMessage(hermitPath, {
        source: 'discord', chat_id: 'C1', direction: 'in', sender: 'U1', sender_id: 'U1',
        text: 'second', ts,
      });
      const rows = unaddressedSince(hermitPath, 'discord', 'C1', {
        notBeforeIso: '2026-01-01T00:00:00.000Z', senderIds: ['U1'],
      });
      expect(rows.map((r) => r.text)).toEqual(['first', 'second']);
    }));
  });

  describe('scripts/channel-log.ts (subprocess CLI)', () => {
    test('prune: no DB -> exit 0 (not a failure)', withDir(async (dir) => {
      const r = await runPinnedScript('channel-log.ts', hermit(dir), [hermit(dir), 'prune', '90']);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual({ deleted: 0 });
    }));

    test('unknown subcommand -> exit 1', withDir(async (dir) => {
      const r = await runPinnedScript('channel-log.ts', hermit(dir), [hermit(dir), 'bogus']);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('{"error":"usage"}\n');
    }));

    // channel-log.ts is reachable through a pre-approved
    // `Bash(bun */scripts/channel-log.ts*)` grant that covers every argument,
    // and prune mutates (docs/security.md § Script
    // Argument Trust).
    test('state-dir pin: refuses a log belonging to another project', withDir(async (mine) => {
      await withDir(async (victim) => {
        const victimPath = hermit(victim);
        logMessage(victimPath, { source: 'discord', chat_id: 'C1', direction: 'in', text: 'victim message' });
        // AGENT_DIR pins hermitDir() to `mine`; argv still names `victim`.
        const r = await runScript('channel-log.ts', {
          args: [victimPath, 'prune', '0'],
          env: { AGENT_DIR: hermit(mine) },
        });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
        expect(channelRows(victimPath).rows?.length).toBe(1);
      })();
    }));
  });
});
