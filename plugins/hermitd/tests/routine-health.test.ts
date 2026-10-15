// Table tests for the routine-health projection — the derivations that used to
// live as prose in skills/reflect/reference.md and could only be "tested" by
// running the skill and hoping the model counted right.
//
// Usage: bun test tests/routine-health.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { withDir, writeConfig } from './helpers/workdir';
import { runScript } from './helpers/run';
import { foldRoutineHistory, readRoutineHistory, lastRoutineFire, lastRoutineEvent, lastRoutineEventWithTimestamp } from '../scripts/lib/routines/history';
import { buildRoutineHealth } from '../scripts/lib/routines/health';

const NOW = Date.parse('2026-08-14T00:00:00.000Z');
const DAY = 86400000;

/** `daysAgo(1.5)` → an ISO stamp 36h before NOW. */
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

/**
 * Same, but anchored to the real clock. The in-process tests inject `new Date(NOW)`
 * as the window end; the CLI tests spawn `routines.ts`, which has no such seam and
 * reads the wall clock. A fixture stamped off the frozen NOW therefore falls out of
 * the health window once the real date drifts past NOW + window_days — a time bomb
 * that turns green tests red on a calendar date, with no code change.
 */
const realDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const row = (id: string, event: string, ts: string, delivery = 'monitor') =>
  JSON.stringify({ ts, routine_id: id, event, delivery });

const fold = (lines: string[], days = 14) =>
  foldRoutineHistory(lines, NOW - days * DAY, NOW);

const only = (lines: string[], days = 14) => {
  const r = fold(lines, days);
  expect(r.routines).toHaveLength(1);
  return r.routines[0];
};

const hermitOf = (dir: string) => path.join(dir, '.hermit');
const writeMetrics = (dir: string, lines: string[]) =>
  fs.writeFileSync(path.join(hermitOf(dir), 'state', 'routine-metrics.jsonl'), lines.join('\n') + '\n');
const writeCostLog = (dir: string, rows: object[]) =>
  fs.writeFileSync(
    path.join(dir, '.claude', 'cost-log.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
// `version: null` omits the stamp entirely (a legacy row); a default parameter
// cannot express that, since JS resolves an explicit `undefined` to the default.
const costRow = (source: string, ts: string, cost: number, version: number | null = 2) => ({
  timestamp: ts,
  source,
  estimated_cost_usd: cost,
  ...(version === null ? {} : { source_attribution_version: version }),
});

describe('foldRoutineHistory — attempt lifecycle', () => {
  test('started → fired is one clean fire, nothing else flagged', () => {
    const e = only([row('brief', 'started', daysAgo(2)), row('brief', 'fired', daysAgo(2))]);
    expect(e).toMatchObject({
      fires: 1, failure_total: 0, incomplete: 0, orphan_terminals: 0, open_attempt: false,
    });
  });

  test('same-second started/fired keeps file order — not an orphan', () => {
    // utcISOStamp truncates to whole seconds, so this is the common case, not an edge one.
    const ts = daysAgo(2);
    const e = only([row('brief', 'started', ts), row('brief', 'fired', ts)]);
    expect(e.fires).toBe(1);
    expect(e.orphan_terminals).toBe(0);
  });

  test('a second started abandons the first attempt', () => {
    const e = only([
      row('brief', 'started', daysAgo(5)),
      row('brief', 'started', daysAgo(4)),
      row('brief', 'fired', daysAgo(4)),
    ]);
    expect(e).toMatchObject({ fires: 1, incomplete: 1, open_attempt: false });
  });

  test('an attempt open at the window edge is not counted as incomplete', () => {
    // The routine may still be running; subtraction could not tell the difference.
    const e = only([row('brief', 'started', daysAgo(0.01))]);
    expect(e).toMatchObject({ fires: 0, incomplete: 0, open_attempt: true });
  });

  test.each([
    ['artifact-missing'],
    ['artifact-unchanged'],
    ['verification-error'],
  ])('failed-%s closes the attempt as a typed failure, not a fire', (reason) => {
    const e = only([row('brief', 'started', daysAgo(3)), row('brief', `failed-${reason}`, daysAgo(3))]);
    expect(e.fires).toBe(0);
    expect(e.failure_total).toBe(1);
    expect(e.failures).toEqual({ [reason]: 1 });
    expect(e.incomplete).toBe(0);
  });

  test('orphan fired is counted as a fire AND flagged, never as a negative gap', () => {
    // finish.ts writes a terminal row with no run record when precheck never stamped.
    const e = only([row('brief', 'fired', daysAgo(2))]);
    expect(e).toMatchObject({ fires: 1, orphan_terminals: 1, incomplete: 0 });
  });

  test('orphan failed-* is flagged too', () => {
    const e = only([row('brief', 'failed-verification-error', daysAgo(2))]);
    expect(e).toMatchObject({ failure_total: 1, orphan_terminals: 1 });
  });

  test('an attempt straddling the window start is closed, not orphaned', () => {
    const e = only([row('brief', 'started', daysAgo(14.5)), row('brief', 'fired', daysAgo(13.5))]);
    expect(e).toMatchObject({ fires: 1, orphan_terminals: 0, incomplete: 0 });
  });

  test('events entirely before the window contribute nothing', () => {
    expect(fold([
      row('brief', 'started', daysAgo(30)),
      row('brief', 'fired', daysAgo(30)),
    ]).routines).toHaveLength(0);
  });

  test('a started left dangling before the window is not reported as open', () => {
    // A routine that crashed months ago and was then disabled has no activity in
    // this window at all; reporting it would assert it "may still be running".
    expect(fold([row('brief', 'started', daysAgo(200))]).routines).toHaveLength(0);
  });

  test('a dangling pre-window started still marks the next attempt incomplete', () => {
    const e = only([row('brief', 'started', daysAgo(20)), row('brief', 'started', daysAgo(1))]);
    expect(e).toMatchObject({ incomplete: 1, open_attempt: true });
  });

  test('future-stamped rows are ignored', () => {
    expect(fold([row('brief', 'fired', new Date(NOW + DAY).toISOString())]).routines).toHaveLength(0);
  });

  test('skipped-* rows open no attempt', () => {
    const e = only([row('brief', 'skipped-paused', daysAgo(1)), row('brief', 'skipped-waiting', daysAgo(1))]);
    expect(e).toMatchObject({ skips: 2, fires: 0, incomplete: 0, open_attempt: false });
  });

  test('lateness skips count without opening attempts or proving a successful precheck', () => {
    const e = only([row('brief', 'skipped-late', daysAgo(1))]);
    expect(e).toMatchObject({ skips: 1, starts: 0, fires: 0, incomplete: 0, open_attempt: false, precheck_skips: 0 });
  });

  test('a skip between started and fired does not break the attempt', () => {
    const e = only([
      row('brief', 'started', daysAgo(3)),
      row('brief', 'skipped-waiting', daysAgo(2)),
      row('brief', 'fired', daysAgo(1)),
    ]);
    expect(e).toMatchObject({ fires: 1, orphan_terminals: 0, incomplete: 0, skips: 1 });
  });

  test('last_fire tracks the most recent fire only', () => {
    const recent = daysAgo(1);
    const e = only([row('brief', 'fired', daysAgo(6)), row('brief', 'fired', recent)]);
    expect(e.last_fire).toBe(recent);
  });

  test('routines are independent and sorted by id', () => {
    const r = fold([
      row('zebra', 'fired', daysAgo(1)),
      row('alpha', 'started', daysAgo(1)),
    ]);
    expect(r.routines.map((e) => e.id)).toEqual(['alpha', 'zebra']);
  });

  test('similar routine ids do not collide', () => {
    const r = fold([
      row('morning', 'fired', daysAgo(1)),
      row('morning-brief', 'fired', daysAgo(1)),
    ]);
    expect(r.routines.map((e) => [e.id, e.fires])).toEqual([['morning', 1], ['morning-brief', 1]]);
  });

  test('malformed and unusable rows are counted, not silently dropped', () => {
    const r = fold([
      '{not json',
      JSON.stringify({ ts: daysAgo(1), event: 'fired' }),            // no routine_id
      JSON.stringify({ routine_id: 'brief', event: 'fired' }),        // no ts
      JSON.stringify({ ts: 'not-a-date', routine_id: 'brief', event: 'fired' }),
      row('brief', 'fired', daysAgo(1)),
      '',
    ]);
    expect(r.malformed_rows).toBe(4);
    expect(r.routines[0].fires).toBe(1);
  });

  test('more than 400 in-window events all count (a line cap would have dropped these)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(row('chatty', 'started', daysAgo(13 - i * 0.04)));
      lines.push(row('chatty', 'fired', daysAgo(13 - i * 0.04)));
    }
    expect(only(lines).fires).toBe(300);
  });
});

describe('foldRoutineHistory — dispatched / unhandled', () => {
  test('dispatched → started → fired is handled, nothing else flagged', () => {
    const e = only([
      row('brief', 'dispatched', daysAgo(2)),
      row('brief', 'started', daysAgo(2)),
      row('brief', 'fired', daysAgo(2)),
    ]);
    expect(e).toMatchObject({
      unhandled: 0, unhandled_open: false, fires: 1,
      incomplete: 0, orphan_terminals: 0, open_attempt: false,
    });
  });

  test('two consecutive dispatched rows yield unhandled: 1', () => {
    const e = only([
      row('brief', 'dispatched', daysAgo(3)),
      row('brief', 'dispatched', daysAgo(2)),
    ]);
    expect(e).toMatchObject({ unhandled: 1, unhandled_open: true });
  });

  test.each([
    ['started'],
    ['fired'],
    ['failed-artifact-missing'],
    ['skipped-waiting'],
    ['skipped-paused'],
  ])('dispatched closed by %s yields unhandled: 0', (closer) => {
    const e = only([row('brief', 'dispatched', daysAgo(2)), row('brief', closer, daysAgo(2))]);
    expect(e).toMatchObject({ unhandled: 0, unhandled_open: false });
  });

  test.each([
    ['skipped-precheck'],
    ['precheck-error'],
  ])('dispatched followed by %s is not closed', (nonCloser) => {
    const e = only([row('brief', 'dispatched', daysAgo(2)), row('brief', nonCloser, daysAgo(2))]);
    expect(e).toMatchObject({ unhandled: 0, unhandled_open: true });
  });

  test('chat-undelivered is counted with its latest detail and closes nothing', () => {
    const e = only([
      row('brief', 'started', daysAgo(2)),
      JSON.stringify({ ts: daysAgo(2), routine_id: 'brief', event: 'chat-undelivered', delivery: 'channel-send', detail: 'discord:42: missing_token' }),
      row('brief', 'fired', daysAgo(2)),
    ]);
    expect(e).toMatchObject({
      fires: 1, failure_total: 0, skips: 0, chat_undelivered: 1,
      last_chat_undelivered: { detail: 'discord:42: missing_token' },
    });
  });

  test('a dispatched still open at the window edge is flagged, not counted', () => {
    const e = only([row('brief', 'dispatched', daysAgo(0.01))]);
    expect(e).toMatchObject({ unhandled: 0, unhandled_open: true });
  });

  test('a dispatched left dangling before the window is not reported', () => {
    expect(fold([row('brief', 'dispatched', daysAgo(200))]).routines).toHaveLength(0);
  });

  test('a dangling pre-window dispatched still marks the next dispatch unhandled', () => {
    const e = only([row('brief', 'dispatched', daysAgo(20)), row('brief', 'dispatched', daysAgo(1))]);
    expect(e).toMatchObject({ unhandled: 1, unhandled_open: true });
  });
});

describe('readRoutineHistory / lastRoutineFire — source states', () => {
  test('missing ledger reports source: missing, not an empty-but-healthy report', withDir((dir) => {
    const h = readRoutineHistory(path.join(hermitOf(dir), 'state', 'nope.jsonl'), 14, new Date(NOW));
    expect(h.source).toBe('missing');
    expect(h.routines).toEqual([]);
  }));

  test('readable ledger reports source: ok', withDir((dir) => {
    writeMetrics(dir, [row('brief', 'fired', daysAgo(1))]);
    const h = readRoutineHistory(path.join(hermitOf(dir), 'state', 'routine-metrics.jsonl'), 14, new Date(NOW));
    expect(h.source).toBe('ok');
    expect(h.routines[0].fires).toBe(1);
  }));

  test('lastRoutineFire is lifetime-scoped and ignores non-fired events', withDir((dir) => {
    const p = path.join(hermitOf(dir), 'state', 'routine-metrics.jsonl');
    const old = daysAgo(90);
    writeMetrics(dir, [row('brief', 'fired', old), row('brief', 'started', daysAgo(1))]);
    expect(lastRoutineFire(p, 'brief')).toBe(old);
    expect(lastRoutineFire(p, 'absent')).toBeNull();
  }));

  test('the latest-event readers skip chat-undelivered delivery notes', withDir((dir) => {
    const p = path.join(hermitOf(dir), 'state', 'routine-metrics.jsonl');
    const at = daysAgo(1);
    writeMetrics(dir, [row('brief', 'started', at), row('brief', 'fired', at), row('brief', 'chat-undelivered', at)]);
    expect(lastRoutineEvent(p, 'brief')).toBe('fired');
    expect(lastRoutineEventWithTimestamp(p, 'brief')).toBe(`fired@${at}`);
  }));
});

describe('buildRoutineHealth — cost join', () => {
  test('per-routine cost is windowed, v2-only, and keyed off the real field names', withDir((dir) => {
    writeMetrics(dir, [row('brief', 'started', daysAgo(1)), row('brief', 'fired', daysAgo(1))]);
    writeCostLog(dir, [
      costRow('routine:brief', daysAgo(1), 0.5),
      costRow('routine:brief', daysAgo(20), 9.0),          // outside the window
      costRow('routine:brief', daysAgo(2), 7.0, 1),        // v1 attribution, untrustworthy
      costRow('other', daysAgo(1), 3.0),                   // not a routine
      { timestamp: daysAgo(1), source: 'routine:brief', cost: 4.0, source_attribution_version: 2 },
    ]);
    const report = buildRoutineHealth(hermitOf(dir), 14, new Date(NOW));
    // The last row uses the field name the old skill prose invented; it contributes 0.
    expect(report.routines).toHaveLength(1);
    expect(report.routines[0]).toMatchObject({ id: 'brief', fires: 1, cost_usd: 0.5 });
  }));

  test('routine:multi stays unattributable, never folded into a routine', withDir((dir) => {
    writeMetrics(dir, [row('brief', 'fired', daysAgo(1)), row('digest', 'fired', daysAgo(1))]);
    writeCostLog(dir, [
      costRow('routine:brief', daysAgo(1), 0.25),
      costRow('routine:multi', daysAgo(1), 1.75),
    ]);
    const report = buildRoutineHealth(hermitOf(dir), 14, new Date(NOW));
    expect(report.unattributable_multi_cost_usd).toBe(1.75);
    expect(report.routines.find((r) => r.id === 'brief')!.cost_usd).toBe(0.25);
    expect(report.routines.find((r) => r.id === 'digest')!.cost_usd).toBe(0);
    expect(report.routines.some((r) => r.id === 'multi')).toBe(false);
  }));

  test('a routine billing cost with no ledger event still appears', withDir((dir) => {
    writeMetrics(dir, [row('brief', 'fired', daysAgo(1))]);
    writeCostLog(dir, [costRow('routine:ghost', daysAgo(1), 2.0)]);
    const report = buildRoutineHealth(hermitOf(dir), 14, new Date(NOW));
    expect(report.routines.find((r) => r.id === 'ghost')).toMatchObject({ fires: 0, cost_usd: 2.0 });
  }));

  test('absent cost log is not an error', withDir((dir) => {
    writeMetrics(dir, [row('brief', 'fired', daysAgo(1))]);
    const report = buildRoutineHealth(hermitOf(dir), 14, new Date(NOW));
    expect(report.routines[0].cost_usd).toBe(0);
    expect(report.source).toBe('ok');
  }));
});

describe('routines.ts health — CLI', () => {
  // The relative arg anchors through resolveHermitDir(), which honours an
  // absolute AGENT_DIR and CLAUDE_PROJECT_DIR before it walks. runScript
  // inherits the real session's env, so both are pinned empty here — an
  // inherited value would point these fixtures at this repo's own state dir.
  const ANCHOR_ENV = { CLAUDE_PROJECT_DIR: '', AGENT_DIR: '' };

  test('prints parseable JSON with the documented top-level keys', withDir(async (dir) => {
    writeMetrics(dir, [row('brief', 'started', realDaysAgo(1)), row('brief', 'fired', realDaysAgo(1))]);
    const r = await runScript('routines.ts', { args: ['health', '.hermit'], cwd: dir, env: ANCHOR_ENV });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out).sort()).toEqual([
      'as_of', 'malformed_rows', 'routines', 'since', 'source', 'unattributable_multi_cost_usd', 'window_days',
    ]);
    expect(out.window_days).toBe(14);
    expect(out.routines[0]).toMatchObject({ id: 'brief', fires: 1 });
  }));

  test('--days is honoured', withDir(async (dir) => {
    writeMetrics(dir, [row('brief', 'fired', realDaysAgo(10))]);
    const r = await runScript('routines.ts', { args: ['health', '.hermit', '--days', '7'], cwd: dir, env: ANCHOR_ENV });
    const out = JSON.parse(r.stdout);
    expect(out.window_days).toBe(7);
    expect(out.routines).toEqual([]);
  }));

  test.each([['0'], ['-3'], ['abc'], ['9999']])('--days %s is rejected', async (bad) => {
    const r = await runScript('routines.ts', { args: ['health', '.hermit', '--days', bad], cwd: process.cwd() });
    expect(r.exitCode).toBe(1);
  });

  test('an unknown flag exits non-zero rather than guessing', async () => {
    const r = await runScript('routines.ts', { args: ['health', '--bogus'], cwd: process.cwd() });
    expect(r.exitCode).toBe(1);
  });
});

// Both documented callers (skills/reflect/reference.md, skills/hermit-evolution/
// reference.md) pass the relative `.hermit`, and a `cd` earlier in the
// session moves what that resolves to. Resolving it against the process cwd made
// the reader report `source: missing`, which both skills treat as "emit no
// candidates" — a silent skip, not a visible failure. Same drift class as the
// writer paths fixed in 1fc2642c.
describe('routines.ts health — cwd drift', () => {
  /** Fixture root with a hatched hermit, plus a nested cwd to run from. */
  function drifted(dir: string): string {
    writeConfig(dir, {});
    writeMetrics(dir, [row('brief', 'started', realDaysAgo(1)), row('brief', 'fired', realDaysAgo(1))]);
    const nested = path.join(dir, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    return nested;
  }

  test('a relative arg from a subdirectory resolves via the walk-up, not cwd', withDir(async (dir) => {
    const nested = drifted(dir);
    const r = await runScript('routines.ts', {
      args: ['health', '.hermit'],
      cwd: nested,
      // Empty (not absent): runScript inherits the real session's env, and an
      // inherited value would decide the resolution instead of the walk.
      env: { CLAUDE_PROJECT_DIR: '', AGENT_DIR: '' },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.source).toBe('ok');
    expect(out.routines[0]).toMatchObject({ id: 'brief', fires: 1 });
  }));

  test('CLAUDE_PROJECT_DIR anchors the relative arg from a subdirectory', withDir(async (dir) => {
    const nested = drifted(dir);
    const r = await runScript('routines.ts', {
      args: ['health', '.hermit'],
      cwd: nested,
      env: { CLAUDE_PROJECT_DIR: dir, AGENT_DIR: '' },
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).source).toBe('ok');
  }));

  test('an absolute arg is still honoured as passed', withDir(async (dir) => {
    const nested = drifted(dir);
    const r = await runScript('routines.ts', {
      args: ['health', hermitOf(dir)],
      cwd: nested,
      env: { CLAUDE_PROJECT_DIR: '', AGENT_DIR: '' },
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).source).toBe('ok');
  }));
});
