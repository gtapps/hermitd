/**
 * channel-log.ts — episodic channel-message log (bun:sqlite + FTS5).
 *
 * This is the ONLY module in the plugin that imports bun:sqlite — every other
 * search/state path stays Node-stdlib-only. Keep it that way: if a caller
 * needs sqlite, it goes through this file's exports, never a direct import.
 *
 * Storage: <hermitDir>/state/channel-log.sqlite (WAL). Created lazily on the
 * first logMessage() call — read paths (searchLog/unconsolidated/prune) never
 * create the file, so a hermit with no channel traffic never gets one.
 *
 * Schema:
 *   messages(id, ts, source, chat_id, direction, sender, sender_id, message_id, text, consolidated_at)
 *   messages_fts — external-content FTS5 index over messages.text, kept in
 *     sync by AFTER INSERT/DELETE triggers (external-content tables do not
 *     auto-sync).
 *
 * Every export catches internally and returns a result object — this module
 * must never throw into a fail-open hook or a CLI that needs a clean exit code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { readSettledConfig } from './config-read';
import { channelEntry } from './channel-auth';

type Json = any;

const MAX_TEXT_LEN = 8 * 1024;
const DEFAULT_CANDIDATE_LIMIT = 200;

interface LogInput {
  source: string;
  chat_id: string;
  direction: 'in' | 'out';
  sender?: string | null;
  sender_id?: string | null;
  message_id?: string | null;
  text: string;
  ts?: string; // ISO; defaults to now
}

interface ChannelRow {
  id: number;
  ts: string;
  source: string;
  chat_id: string;
  direction: string;
  sender: string | null;
  sender_id: string | null;
  message_id: string | null;
  text: string;
  consolidated_at: string | null;
}

function dbPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'channel-log.sqlite');
}

function dbExists(hermitDir: string): boolean {
  try {
    return fs.existsSync(dbPath(hermitDir));
  } catch {
    return false;
  }
}

// Busy-wait budgets. Capture runs inside hooks with their own enforced timeouts
// (user-prompt-pipeline.ts: 15s shared across all its stages, channel-hook.ts:
// 5s in hooks.json), and
// bun:sqlite blocks synchronously — so the hook path must fail fast rather than
// stall past its budget and get killed. The weekly-review CLI writers aren't
// timeout-bound, so they can wait out real contention.
const HOOK_BUSY_TIMEOUT_MS = 500;
const CLI_BUSY_TIMEOUT_MS = 5000;

/**
 * Open the channel-log DB with a busy_timeout so a concurrent writer waits for
 * the lock instead of immediately failing with SQLITE_BUSY and dropping a
 * capture. Defaults to the short hook budget; CLI write paths pass the longer
 * one explicitly.
 */
function openDb(hermitDir: string, opts?: { readonly?: boolean; busyTimeoutMs?: number }): Database {
  const db = new Database(dbPath(hermitDir), opts?.readonly ? { readonly: true } : undefined);
  db.run(`PRAGMA busy_timeout = ${opts?.busyTimeoutMs ?? HOOK_BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Per-channel log_chats overrides the default-on knowledge.channel_log_enabled gate.
 * Shared by channel-hook.ts (outbound) and the channel-reply-reminder stage (inbound)
 * so the "only an explicit false disables capture" rule lives in one place.
 */
function isLoggingEnabled(config: Json, source?: string): boolean {
  const override = source ? channelEntry(config, source)?.log_chats : undefined;
  if (typeof override === 'boolean') return override;
  return config?.knowledge?.channel_log_enabled !== false;
}

function ensureSchema(db: Json): void {
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      sender TEXT,
      sender_id TEXT,
      message_id TEXT,
      text TEXT NOT NULL,
      consolidated_at TEXT
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text, content='messages', content_rowid='id'
    )
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END
  `);
  db.run('CREATE INDEX IF NOT EXISTS messages_consolidated_idx ON messages(consolidated_at)');
  db.run('CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages(ts)');
  // Schema drift is handled only here (first precedent in the repo): a DB
  // created without sender_id gains the column on the next logMessage() call.
  const columns = db.query('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'sender_id')) {
    try {
      db.run('ALTER TABLE messages ADD COLUMN sender_id TEXT');
    } catch (e: any) {
      // A concurrent writer added it between the check and the ALTER.
      if (!/duplicate column/i.test(e?.message || '')) throw e;
    }
  }
}

/**
 * Insert one message. Creates the DB/schema on first call for this hermit.
 * Never throws — returns { ok:false, error } on any failure so fail-open
 * hooks can decide whether to surface a marker.
 */
function logMessage(hermitDir: string, input: LogInput): { ok: boolean; error?: string } {
  try {
    const stateDir = path.join(hermitDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const db = openDb(hermitDir);
    try {
      ensureSchema(db);
      const text = String(input.text ?? '').slice(0, MAX_TEXT_LEN);
      if (!text) return { ok: false, error: 'empty text' };

      const ts = input.ts || new Date().toISOString();
      db.query(
        `INSERT INTO messages (ts, source, chat_id, direction, sender, sender_id, message_id, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ts,
        String(input.source || ''),
        String(input.chat_id || ''),
        input.direction,
        input.sender ?? null,
        input.sender_id ?? null,
        input.message_id ?? null,
        text
      );
      return { ok: true };
    } finally {
      db.close();
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Build a quoted, OR-joined FTS5 MATCH expression from tokenized terms.
 * Unquoted hyphenated terms (e.g. `foo-bar`) throw "no such column: bar" in
 * FTS5's default query grammar — quoting each term sidesteps that. Space
 * separation in FTS5 MATCH means AND by default; explicit OR keeps this an
 * any-term match, matching the substring scoring the rest of search.ts uses.
 */
function buildMatchExpr(terms: string[]): string {
  return terms
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/**
 * Full-text search over the channel log. Returns [] (not an error) when the
 * DB doesn't exist yet — this is the feature-detect path search.ts relies on.
 * @param {object} [opts] - { since?: ISO date string, type?: string, limit?: number, scope?: { own: {source, chat_id}, channel?: string, shared: {source, chat_id}[] } }
 */
function searchLog(hermitDir: string, terms: string[], opts?: Json): ChannelRow[] {
  const o = opts || {};
  if (o.scope && (!o.scope.own?.source || !o.scope.own?.chat_id)) return [];
  // A type filter that isn't 'channel' can never match rows from this source.
  if (o.type && o.type !== 'channel') return [];
  if (!terms || terms.length === 0) return [];
  if (!dbExists(hermitDir)) return [];

  try {
    const db = openDb(hermitDir, { readonly: true });
    try {
      const matchExpr = buildMatchExpr(terms);
      const limit = typeof o.limit === 'number' ? o.limit : DEFAULT_CANDIDATE_LIMIT;
      // Filter `since` in SQL, before LIMIT — filtering after the rank-ordered
      // limit would drop in-window rows ranked past the candidate cap on a busy
      // channel. ts is stored ISO-8601 UTC, so lexical `>=` is chronological.
      const sinceDate = o.since ? new Date(o.since) : null;
      const sinceIso = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate.toISOString() : null;

      // Params mirror the SQL fragment's `since` branch — push in bind order.
      const params: (string | number)[] = [matchExpr];
      if (sinceIso) params.push(sinceIso);
      let scopeSql = '';
      if (o.scope) {
        const pairs = [o.scope.own, ...o.scope.shared];
        const clauses = pairs.map((pair) => {
          params.push(pair.source, pair.chat_id);
          return '(m.source = ? AND m.chat_id = ?)';
        });
        if (o.scope.channel) {
          clauses.push('m.source = ?');
          params.push(o.scope.channel);
        }
        scopeSql = ` AND (${clauses.join(' OR ')})`;
      }
      params.push(limit);

      return db
        .query(
          `SELECT m.id, m.ts, m.source, m.chat_id, m.direction, m.sender, m.message_id, m.text, m.consolidated_at
           FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ?${sinceIso ? ' AND m.ts >= ?' : ''}${scopeSql}
           ORDER BY rank LIMIT ?`
        )
        .all(...params) as ChannelRow[];
    } finally {
      db.close();
    }
  } catch {
    // Malformed MATCH expression or transient sqlite error — recall must not
    // break file search over this.
    return [];
  }
}

/**
 * Rows not yet distilled into the curated tiers. Absent DB → { ok:true, rows:[] }
 * (nothing to do, not a failure). Real errors → { ok:false, error }.
 */
function unconsolidated(hermitDir: string, beforeTs?: string): { ok: boolean; rows: ChannelRow[]; error?: string } {
  if (!dbExists(hermitDir)) return { ok: true, rows: [] };
  try {
    const db = openDb(hermitDir, { readonly: true });
    try {
      const rows = beforeTs
        ? (db
            .query('SELECT * FROM messages WHERE consolidated_at IS NULL AND ts < ? ORDER BY ts ASC')
            .all(beforeTs) as ChannelRow[])
        : (db
            .query('SELECT * FROM messages WHERE consolidated_at IS NULL ORDER BY ts ASC')
            .all() as ChannelRow[]);
      return { ok: true, rows };
    } finally {
      db.close();
    }
  } catch (e: any) {
    return { ok: false, rows: [], error: e?.message || String(e) };
  }
}

/**
 * Inbound rows at or after `sinceIso`, oldest first. Absent DB → [].
 *
 * Deliberately ignores consolidation state, unlike unconsolidated(): this is
 * for flows that poll the channel for one specific operator reply (the re-auth
 * relay waiting on an ack or a login code), where a row already distilled by
 * weekly-review is still a perfectly valid answer.
 */
function inboundSince(hermitDir: string, sinceIso: string, limit = 50): ChannelRow[] {
  if (!dbExists(hermitDir)) return [];
  try {
    const db = openDb(hermitDir, { readonly: true });
    try {
      return db
        .query(
          `SELECT * FROM messages WHERE direction = 'in' AND ts >= ? ORDER BY ts ASC LIMIT ?`
        )
        .all(sinceIso, limit) as ChannelRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Inbound rows in one chat after both `notBeforeIso` and the newest outbound
 * row for that chat, filtered by sender_id in SQL before LIMIT. Newest `limit`
 * rows (default 8), returned oldest first. Absent DB or any query error → [].
 */
function unaddressedSince(
  hermitDir: string,
  source: string,
  chatId: string,
  opts: { notBeforeIso: string; senderIds: string[] | null; limit?: number },
): ChannelRow[] {
  if (!dbExists(hermitDir)) return [];
  if (opts.senderIds !== null && opts.senderIds.length === 0) return [];
  try {
    const db = openDb(hermitDir, { readonly: true });
    try {
      const limit = opts.limit ?? 8;
      const params: (string | number)[] = [source, chatId, opts.notBeforeIso, source, chatId];
      let senderFilter = 'AND sender_id IS NOT NULL';
      if (opts.senderIds !== null) {
        senderFilter = `AND sender_id IN (${opts.senderIds.map(() => '?').join(',')})`;
        params.push(...opts.senderIds);
      }
      params.push(limit);
      const rows = db
        .query(
          `SELECT * FROM messages
           WHERE direction = 'in'
             AND source = ?
             AND chat_id = ?
             AND ts > ?
             AND ts > COALESCE(
               (SELECT MAX(ts) FROM messages WHERE direction = 'out' AND source = ? AND chat_id = ?),
               ''
             )
             ${senderFilter}
           ORDER BY ts DESC, id DESC
           LIMIT ?`
        )
        .all(...params) as ChannelRow[];
      return rows.reverse();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Stamp consolidated_at on the given row ids. Absent DB → ok:true no-op
 * (nothing to mark). Called only after the caller has successfully applied
 * the distilled writes (memory/compiled) — see weekly-review's consolidation
 * step, which owns that ordering.
 */
function markConsolidated(hermitDir: string, ids: number[]): { ok: boolean; error?: string } {
  if (!ids || ids.length === 0) return { ok: true };
  if (!dbExists(hermitDir)) return { ok: true };
  try {
    const db = openDb(hermitDir, { busyTimeoutMs: CLI_BUSY_TIMEOUT_MS });
    try {
      const ts = new Date().toISOString();
      const placeholders = ids.map(() => '?').join(',');
      db.query(`UPDATE messages SET consolidated_at = ? WHERE id IN (${placeholders})`).run(ts, ...ids);
      return { ok: true };
    } finally {
      db.close();
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Prune old CONSOLIDATED rows only (already promoted into curated tiers).
 * Unreviewed rows are retained regardless of age — they are the recall
 * substrate consolidation hasn't gotten to yet, and deleting them would
 * silently destroy the thing this feature exists to preserve.
 * Absent DB → ok:true, deleted:0 (nothing to do).
 */
function prune(hermitDir: string, retentionDays: number): { ok: boolean; deleted: number; error?: string } {
  if (!dbExists(hermitDir)) return { ok: true, deleted: 0 };
  try {
    const db = openDb(hermitDir, { busyTimeoutMs: CLI_BUSY_TIMEOUT_MS });
    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      // Count first: DELETE's .changes is inflated by the AFTER DELETE trigger's
      // own writes into the FTS5 shadow tables, so it isn't the real row count.
      const { n } = db
        .query('SELECT COUNT(*) AS n FROM messages WHERE consolidated_at IS NOT NULL AND consolidated_at < ?')
        .get(cutoff) as { n: number };
      db.query('DELETE FROM messages WHERE consolidated_at IS NOT NULL AND consolidated_at < ?').run(cutoff);
      return { ok: true, deleted: n };
    } finally {
      db.close();
    }
  } catch (e: any) {
    return { ok: false, deleted: 0, error: e?.message || String(e) };
  }
}

/**
 * Last per-chat rows in both directions, returned oldest first. `senderIds`
 * keeps only inbound rows from those senders, filtered in SQL before LIMIT.
 */
function conversationHistory(
  hermitDir: string,
  source: string,
  chatId: string,
  { limit, senderIds }: { limit: number; senderIds?: string[] | null },
): Pick<ChannelRow, 'ts' | 'direction' | 'sender' | 'text'>[] {
  try {
    if (!Number.isInteger(limit) || limit <= 0 || !dbExists(hermitDir) || !isLoggingEnabled(readSettledConfig(hermitDir), source)) return [];
    const db = openDb(hermitDir, { readonly: true });
    try {
      const senderFilter = senderIds ? `AND (direction = 'out' OR sender_id IN (${senderIds.map(() => '?').join(',')}))` : '';
      const rows = db.query(
        `SELECT ts, direction, sender, text FROM messages
         WHERE source = ? AND chat_id = ? ${senderFilter}
         ORDER BY ts DESC, id DESC LIMIT ?`
      ).all(source, chatId, ...(senderIds ?? []), limit) as Pick<ChannelRow, 'ts' | 'direction' | 'sender' | 'text'>[];
      return rows.reverse();
    } finally { db.close(); }
  } catch { return []; }
}

export { logMessage, searchLog, unconsolidated, inboundSince, unaddressedSince, conversationHistory, markConsolidated, prune, dbExists, dbPath, isLoggingEnabled };
export type { LogInput, ChannelRow };


export type ReviewRow = Pick<ChannelRow, 'id' | 'ts' | 'chat_id' | 'direction' | 'sender_id' | 'message_id' | 'text'>;
type ReviewHistory = { status: 'ok'; upper_id: number; chat_ids: string[]; rows: ReviewRow[] }
  | { status: 'no_db' | 'logging_off' } | { status: 'error'; error: string };

/** Row-id range reads for role review. Discovery and text reads are separately bounded. */
export function roleReviewHistory(
  hermitDir: string, source: string,
  opts: { cursor: number; upper?: number; since?: string; chatIds?: string[]; senderIds?: string[] | null },
): ReviewHistory {
  if (!isLoggingEnabled(readSettledConfig(hermitDir), source)) return { status: 'logging_off' };
  if (!dbExists(hermitDir)) return { status: 'no_db' };
  try {
    const db = openDb(hermitDir, { readonly: true });
    try {
      let upper_id = opts.upper ?? (db.query('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get() as { id: number }).id;
      const params: (string | number)[] = [source, opts.cursor, upper_id];
      let where = 'source = ? AND id > ? AND id <= ?';
      if (opts.since) { where += ' AND ts >= ?'; params.push(opts.since); }
      if (opts.senderIds) {
        where += ` AND (direction = 'out' OR sender_id IN (${opts.senderIds.map(() => '?').join(',')}))`;
        params.push(...opts.senderIds);
      }
      if (!opts.chatIds) {
        const chats = db.query(`SELECT chat_id, MIN(id) AS first FROM messages WHERE ${where} GROUP BY chat_id ORDER BY first LIMIT 33`).all(...params) as { chat_id: string; first: number }[];
        // Past 32 chats, stop the range before the 33rd chat's first row so the next run reaches it.
        if (chats.length > 32) upper_id = chats.pop()!.first - 1;
        return { status: 'ok', upper_id, chat_ids: chats.map(row => row.chat_id), rows: [] };
      }
      if (!opts.chatIds.length) return { status: 'ok', upper_id, chat_ids: [], rows: [] };
      where += ` AND chat_id IN (${opts.chatIds.map(() => '?').join(',')})`;
      params.push(...opts.chatIds);
      const rows = db.query(`SELECT id, ts, chat_id, direction, sender_id, message_id, text FROM messages WHERE ${where} ORDER BY id LIMIT 1001`).all(...params) as ReviewRow[];
      return { status: 'ok', upper_id, chat_ids: opts.chatIds, rows };
    } finally { db.close(); }
  } catch { return { status: 'error', error: 'channel_log_read_failed' }; }
}
