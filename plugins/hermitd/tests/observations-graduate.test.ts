// `observations.ts graduate` — the promotion rules reflect step 3b used to walk by
// hand over the raw ledger. The three that decide whether a pattern becomes a
// candidate are the ones worth pinning: distinct local dates behind it, at least one
// row newer than the graduation cursor, and origin inherited from any single
// external-content row.
//
// Usage: bun test tests/observations-graduate.test.ts   (from the plugin root)

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runPinnedScript } from './helpers/run';
import { resolveSessionId } from '../scripts/lib/observations';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-graduate-');
afterAll(cleanup);

const CURSOR = '2026-07-01T00:00:00Z';
const STALE = '2026-06-01T09:00:00Z';
const FRESH = '2026-07-05T09:00:00Z';

const row = (o: Record<string, unknown>) => JSON.stringify({ source: 'reflect-noticed', ...o });

const LEDGER = [
  // Only the shared sentinel behind it — never a candidate.
  row({ ts: FRESH, pattern: 'ghost pattern', session_id: 'unknown' }),
  row({ ts: FRESH, pattern: 'ghost pattern', session_id: 'unknown' }),
  // Real dates, but nothing newer than the cursor.
  row({ ts: STALE, pattern: 'already promoted', session_id: '2026-06-01' }),
  row({ ts: STALE, pattern: 'already promoted', session_id: '2026-07-05' }),
  // Two dates, one fresh row, one of them external-content.
  row({ ts: STALE, pattern: 'flaky deploy step', session_id: '2026-06-01', origin: 'own-work' }),
  row({ ts: FRESH, pattern: 'flaky deploy step', session_id: '2026-07-05', origin: 'external-content' }),
  // The unknown sentinel is dropped from the session tally, not from the row count.
  row({ ts: FRESH, pattern: 'flaky deploy step', session_id: 'unknown' }),
  'not json at all',
].join('\n') + '\n';

function fixture(opts: { ledger?: string; cursor?: string | null; minSessions?: number } = {}) {
  const stateDir = path.join(freshDir(), '.hermit');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  if (opts.ledger !== undefined) fs.writeFileSync(path.join(stateDir, 'state', 'observations.jsonl'), opts.ledger);
  fs.writeFileSync(path.join(stateDir, 'state', 'reflection-state.json'),
    JSON.stringify({ counters: { last_graduation_at: opts.cursor === undefined ? CURSOR : opts.cursor } }));
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    timezone: 'UTC',
    ...(opts.minSessions === undefined ? {} : { reflection: { graduation_min_sessions: opts.minSessions } }),
  }));
  return stateDir;
}

async function graduate(stateDir: string, args: string[] = []) {
  const r = await runPinnedScript('observations.ts', stateDir, ['graduate', stateDir, ...args]);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.trim()).candidates;
}

describe('observations.ts graduate', () => {
  test('promotes only the fresh multi-date pattern, with the aggregated origin', async () => {
    expect(await graduate(fixture({ ledger: LEDGER }))).toEqual([
      { pattern: 'flaky deploy step', sessions: ['2026-06-01', '2026-07-05'], origin: 'external-content', rows: 3 },
    ]);
  });

  test('--cursor overrides the stored one', async () => {
    const stateDir = fixture({ ledger: LEDGER });
    expect(await graduate(stateDir, ['--cursor', '2026-05-01T00:00:00Z']))
      .toEqual([
        { pattern: 'already promoted', sessions: ['2026-06-01', '2026-07-05'], origin: 'own-work', rows: 2 },
        { pattern: 'flaky deploy step', sessions: ['2026-06-01', '2026-07-05'], origin: 'external-content', rows: 3 },
      ]);
    expect(await graduate(stateDir, ['--cursor', '2026-08-01T00:00:00Z'])).toEqual([]);
  });

  test('a null cursor makes every row fresh', async () => {
    const out = await graduate(fixture({ ledger: LEDGER, cursor: null }));
    expect(out.map((c: any) => c.pattern)).toEqual(['already promoted', 'flaky deploy step']);
  });

  test('graduation_min_sessions gates the tally', async () => {
    expect(await graduate(fixture({ ledger: LEDGER, minSessions: 3 }))).toEqual([]);
  });

  test('a missing or empty ledger yields no candidates', async () => {
    expect(await graduate(fixture())).toEqual([]);
    expect(await graduate(fixture({ ledger: '' }))).toEqual([]);
  });

  test('skill-preference-applied rows never promote their own pattern', async () => {
    const ledger = [
      row({ ts: FRESH, pattern: 'skill-preference:commit', session_id: '2026-06-01', source: 'skill-preference-applied' }),
      row({ ts: FRESH, pattern: 'skill-preference:commit', session_id: '2026-07-05', source: 'skill-preference-applied' }),
    ].join('\n') + '\n';
    expect(await graduate(fixture({ ledger }))).toEqual([]);
  });
});

describe('observation local-date identity', () => {
  test('the configured timezone supplies the observation date without runtime state', () => {
    const stateDir = fixture({ ledger: '' });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ timezone: 'Pacific/Kiritimati' }));
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    expect(resolveSessionId(stateDir)).toBe(expected);
  });
});
