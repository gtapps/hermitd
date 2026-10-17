/**
 * search.ts — full-text search lib over hermit state: sessions/, compiled/,
 * proposals/ (files, Node stdlib only) plus the episodic channel log
 * (state/channel-log.sqlite, PROP-010) as a fourth source when present.
 *
 * Usage as lib:   import { search } from './search' — search(hermitDir, query, opts) => hits[]
 *
 * hits, ranked best first, already in search.ts's stdout shape:
 *   File hit:    { source: 'file', path, date?, title?, snippets: [{ line, start_line, text }] }
 *     path is relative to hermitDir; title only when it differs from the filename;
 *     line is the matching line, start_line the first context line, both file-relative
 *     (frontmatter offset included) so path:line resolves.
 *   Channel hit: { source: 'channel', untrusted: true, title, date?, text }
 *     a bounded, safeForLLM-sanitized excerpt of past chat text: operator- or
 *     member-authored external input, not a file, so no line refs.
 *
 * opts: { type?: string, since?: string (ISO date), limit?: number, chat?: string }
 *   chat: when present, also scopes compiled/ by frontmatter `audience` and
 *     hides sessions/ and proposals/ from a scoped reader.
 */

import path from 'node:path';
import { globDirRecursive, readFileWithFrontmatter } from './frontmatter';
import { searchLog } from './channel-log';
import { audienceVisible, recallScope } from './channel-auth';
import { readConfigRaw } from './config-read';
import { safeForLLM } from './sanitize';

type Json = any;

// Weight multiplier for a term hit in a frontmatter field (vs. plain body hit)
const FM_BOOST = 5;
// Max snippets returned per file
const MAX_SNIPPETS_PER_FILE = 3;
// Max chars per snippet context block
const SNIPPET_MAX_CHARS = 200;
// Soft recency half-life in days (0 days → 1.0; this many days → ~0.5)
const RECENCY_HALF_LIFE_DAYS = 180;
// Candidate rows pulled from the channel log before scoring/sorting
const CHANNEL_CANDIDATE_LIMIT = 200;
// Max chars per channel excerpt (channel text has no lines to snip around)
const CHANNEL_EXCERPT_MAX_CHARS = 200;

/**
 * Extract the best available date string from a frontmatter object.
 * Tries keys in priority order; returns null if none found.
 */
function extractDate(fm: Json): string | null {
  for (const key of ['updated', 'created', 'date', 'accepted_date', 'start_date']) {
    if (fm[key] && typeof fm[key] === 'string') return fm[key];
  }
  return null;
}

/**
 * Recency multiplier [0..1]. Exponential half-life decay from RECENCY_HALF_LIFE_DAYS.
 * Unparseable date → neutral (0.5).
 */
function recencyBoost(dateStr: string | null): number {
  if (!dateStr) return 0.5;
  const ms = Date.parse(dateStr);
  if (isNaN(ms)) return 0.5;
  const daysSince = Math.max(0, (Date.now() - ms) / (1000 * 60 * 60 * 24));
  return Math.pow(0.5, daysSince / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Tokenize a string into lowercase terms of length >= 2.
 * Strips non-alphanumeric chars except hyphens and underscores.
 */
function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^a-z0-9_-]/g, ''))
    .filter(t => t.length >= 2);
}

/**
 * Count overlapping occurrences of all terms in text (case-insensitive).
 */
function countHits(text: string, terms: string[]): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    let idx = 0;
    while ((idx = lower.indexOf(term, idx)) !== -1) {
      hits++;
      idx += term.length;
    }
  }
  return hits;
}

/**
 * Extract up to MAX_SNIPPETS_PER_FILE snippets from body for matching lines.
 * Each snippet includes the matching line + one line of context above and below.
 * lineOffset is the number of lines preceding `body` in the source file (frontmatter
 * + stripped leading blanks) so the returned line numbers resolve against the real file.
 * Returns Array<{ line, start_line, text }>; both line numbers are 1-indexed, file-relative.
 */
function extractSnippets(body: string, terms: string[], lineOffset: number): Array<{ line: number; start_line: number; text: string }> {
  const lines = (body || '').split('\n');
  const snippets: Array<{ line: number; start_line: number; text: string }> = [];

  for (let i = 0; i < lines.length && snippets.length < MAX_SNIPPETS_PER_FILE; i++) {
    const lower = lines[i].toLowerCase();
    if (!terms.some(t => lower.includes(t))) continue;

    const contextStart = Math.max(0, i - 1);
    const contextEnd = Math.min(lines.length - 1, i + 1);
    const contextText = lines.slice(contextStart, contextEnd + 1).join('\n');
    const text = contextText.slice(0, SNIPPET_MAX_CHARS).split('\n').map(l => l.trimEnd()).join('\n').trimEnd();

    snippets.push({
      line: lineOffset + i + 1,
      start_line: lineOffset + contextStart + 1,
      text,
    });
  }
  return snippets;
}

/**
 * Bounded excerpt centered on the first matching term, so a long channel
 * message doesn't dump its full text (capped elsewhere at 8KB) into a result.
 * Falls back to the leading chars when no term substring is found (FTS5
 * tokenization can match a row our own substring scan doesn't hit exactly).
 */
function excerptAround(text: string, terms: string[], maxChars: number): string {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return text.slice(0, maxChars).trim();
  const start = Math.max(0, idx - Math.floor(maxChars / 2));
  return text.slice(start, start + maxChars).trim();
}

/**
 * Full-text search over sessions/, compiled/, and proposals/ in hermitDir.
 *
 * @param {string} hermitDir - hermit state directory (e.g. .hermit)
 * @param {string} query - search query
 * @param {object} [opts]
 * @param {string}  [opts.type]  - filter by compiled/proposal `type` frontmatter field
 * @param {string}  [opts.since] - ISO date string; exclude files older than this date
 * @param {number}  [opts.limit] - max results to return (default 10)
 * @param {string}  [opts.chat]  - `<key>:<chat_id>`; scopes compiled/ by `audience`
 *   and skips sessions/ and proposals/ when the resolved scope is non-null
 * @returns hits in stdout shape (see the header)
 */
function search(hermitDir: string, query: string, opts?: Json): Json[] {
  const o = opts || {};
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const limit = typeof o.limit === 'number' ? o.limit : 10;
  const since = o.since ? Date.parse(o.since) : null;
  const typeFilter = o.type || null;

  // Presence, not truthiness: `--chat=` with an empty value is still a request
  // to scope, and must fail closed rather than fall through to an unscoped read.
  let scope: Json | null = null;
  if (o.chat !== undefined && o.chat !== null) {
    const separator = o.chat.indexOf(':');
    const key = separator < 0 ? o.chat : o.chat.slice(0, separator);
    const chatId = separator < 0 ? '' : o.chat.slice(separator + 1);
    scope = recallScope(readConfigRaw(hermitDir), key, chatId);
  }
  const scoped = scope != null;

  const dirs = scoped
    ? [path.join(hermitDir, 'compiled'), path.join(hermitDir, 'tasks')]
    : [
        path.join(hermitDir, 'sessions'),
        path.join(hermitDir, 'compiled'),
        path.join(hermitDir, 'proposals'),
        path.join(hermitDir, 'tasks'),
      ];

  const results: Array<{ score: number; hit: Json }> = [];

  for (const dir of dirs) {
    const files = globDirRecursive(dir);
    for (const filePath of files) {
      const r = readFileWithFrontmatter(filePath);
      if (!r) continue;
      const fm = r.fm || {};
      const body = r.body || '';
      if (scoped && !audienceVisible(scope, fm.audience)) continue;

      // Type filter (applies when the artifact has a type field)
      if (typeFilter && fm.type && fm.type !== typeFilter) continue;

      // Date filter — files without a parseable date are kept (undated history
      // shouldn't silently vanish under --since).
      const dateStr = extractDate(fm);
      if (since && dateStr) {
        const fileMs = Date.parse(dateStr);
        if (fileMs && fileMs < since) continue;
      }

      // Score: frontmatter field hits (boosted) + body hits
      const fmText = [
        fm.title || '',
        Array.isArray(fm.tags) ? fm.tags.join(' ') : fm.tags || '',
        fm.summary || '',
        fm.task || '',
      ].join(' ');

      const rawScore = countHits(fmText, terms) * FM_BOOST + countHits(body, terms);
      if (rawScore === 0) continue;

      const score = rawScore * recencyBoost(dateStr);
      // body is a suffix of content (frontmatter stripped, then trimStart); the prefix
      // length gives the file-relative line offset so snippet line numbers resolve.
      const lineOffset = r.content ? r.content.slice(0, r.content.length - body.length).split('\n').length - 1 : 0;
      const snippets = extractSnippets(body, terms, lineOffset);
      const relPath = path.relative(hermitDir, filePath);

      results.push({
        score,
        hit: {
          source: 'file',
          path: relPath,
          ...(dateStr ? { date: dateStr.slice(0, 10) } : {}),
          ...(fm.title && fm.title !== path.basename(filePath, '.md') ? { title: fm.title } : {}),
          snippets,
        },
      });
    }
  }

  // Channel log — fourth source (episodic tier, PROP-010). searchLog()
  // feature-detects the DB: no channel traffic yet → [] → this contributes
  // nothing, matching the "inert until a channel first delivers a message"
  // guarantee. A type filter that isn't 'channel' excludes this source
  // entirely, same as the dirs loop above excludes non-matching fm.type.
  if (!typeFilter || typeFilter === 'channel') {
    const rows = searchLog(hermitDir, terms, { since: o.since, limit: CHANNEL_CANDIDATE_LIMIT, scope });
    for (const row of rows) {
      // searchLog already matched this row via FTS5 (token/phrase/diacritic-fold
      // semantics), so keep it even when our substring countHits can't re-find
      // the term — e.g. query "foo-bar" matching stored "foo bar", or "cafe"
      // matching "café". Floor the score at 1 so an FTS-only hit still ranks,
      // and let excerptAround fall back to a leading slice.
      const score = Math.max(1, countHits(row.text, terms)) * recencyBoost(row.ts);
      const excerpt = safeForLLM(excerptAround(row.text, terms, CHANNEL_EXCERPT_MAX_CHARS));

      // untrusted travels with the safeForLLM call: the text is external input
      // that reaches context unreviewed.
      results.push({
        score,
        hit: {
          source: 'channel',
          untrusted: true,
          title: safeForLLM(`${row.direction === 'in' ? 'from' : 'to'} ${row.source} (${row.chat_id})`),
          ...(row.ts ? { date: row.ts.slice(0, 10) } : {}),
          text: excerpt,
        },
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map(r => r.hit);
}

export { search };
