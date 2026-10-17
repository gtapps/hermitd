// cost-report.ts reflect --plain mode: the channel-safe "why is my bill high" answer
// (audit's "plain spend statement" PR). Verifies composition (total vs typical,
// drivers named by work, cap status, notional caveat) and — the load-bearing
// property — that the output never leaks the raw token-category vocabulary the
// table mode uses (cache_read/cache_write, raw source strings, session ids).
//
// Subprocess test (via runScript): the reflect verb is invoked as a standalone
// script, exactly how the SKILL.md Step 1 command runs it.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';
import { writeConfig } from './helpers/workdir';
import { calculateCost } from '../scripts/lib/pricing';

const dirs: string[] = [];

afterAll(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

interface LogEntry {
  daysAgo: number;
  source: string;
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  model?: string;
  estimatedCostUsd?: number;
  /** `null` omits the field so mixed-window tests can include legacy rows. */
  costByType?: { input: number; cache_write: number; cache_read: number; output: number } | null;
}

function priced(e: LogEntry) {
  return calculateCost(e.model || 'sonnet', {
    input: e.input ?? 500,
    cacheWrite5m: e.cacheWrite ?? 1000,
    cacheWrite1h: 0,
    cacheRead: e.cacheRead ?? 10000,
    output: e.output ?? 500,
  });
}

function cost(e: LogEntry): number {
  if (e.estimatedCostUsd !== undefined) return e.estimatedCostUsd;
  return priced(e).total;
}

function setup(budget: object | null, entries: LogEntry[]): { dir: string; cchDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-reflect-plain-'));
  dirs.push(dir);
  const cchDir = path.join(dir, '.hermit');
  fs.mkdirSync(path.join(cchDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeConfig(dir, { timezone: 'UTC', budget });

  const lines = entries.map((e, i) => {
    const ts = new Date(Date.now() - e.daysAgo * 86400000).toISOString();
    const byType = e.costByType === null ? null : e.costByType ?? (() => {
      const t = priced(e).byType;
      return { input: t.input, cache_write: t.cacheWrite, cache_read: t.cacheRead, output: t.output };
    })();
    return JSON.stringify({
      timestamp: ts,
      session_id: `sess-${i}`,
      source: e.source,
      model: e.model || 'sonnet',
      input_tokens: e.input ?? 500,
      cache_write_tokens: e.cacheWrite ?? 1000,
      cache_read_tokens: e.cacheRead ?? 10000,
      output_tokens: e.output ?? 500,
      total_tokens: (e.input ?? 500) + (e.cacheWrite ?? 1000) + (e.cacheRead ?? 10000) + (e.output ?? 500),
      api_calls: 1,
      estimated_cost_usd: cost(e),
      ...(byType ? { cost_by_type: byType } : {}),
    });
  });
  fs.writeFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), lines.join('\n') + '\n');
  return { dir, cchDir };
}

async function runPlain(cchDir: string): Promise<string> {
  const result = await runScript('cost-report.ts', { args: ['reflect', cchDir, '--plain'] });
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe('cost-reflect --plain: no data', () => {
  test('reports "no spend recorded" rather than the table-mode message', async () => {
    const { cchDir } = setup(null, []);
    const out = await runPlain(cchDir);
    expect(out.trim()).toBe('No spend recorded yet.');
  });
});

describe('cost-reflect --plain: composition', () => {
  test('total, drivers, cap status, and caveat all render', async () => {
    const { cchDir } = setup(
      { daily_usd: 10.0, weekly_usd: null, monthly_usd: null, action: 'alert' },
      [
        { daysAgo: 0, source: 'other', input: 1000, cacheWrite: 2000, cacheRead: 50000, output: 3000 },
        { daysAgo: 0, source: 'heartbeat' },
        { daysAgo: 1, source: 'routine:doctor' },
        { daysAgo: 2, source: 'routine:weekly-review' },
        { daysAgo: 3, source: 'channel:discord' },
      ],
    );
    const out = await runPlain(cchDir);

    // Today's total is the sum of today's stored estimated_cost_usd.
    const todayTotal = cost({ daysAgo: 0, source: 'other', input: 1000, cacheWrite: 2000, cacheRead: 50000, output: 3000 })
      + cost({ daysAgo: 0, source: 'heartbeat' });
    expect(out).toContain(`Today: $${todayTotal.toFixed(2)}`);

    // Drivers named by work, not by raw source string.
    expect(out).toContain('Mostly from');
    expect(out).toContain('our conversations');
    expect(out).toContain('background check-ins');
    expect(out).toContain('scheduled routines');

    // Two distinct routine:<id> sources collapse into one "scheduled routines"
    // bucket rather than appearing as two separate driver entries.
    expect((out.match(/scheduled routines/g) ?? []).length).toBe(1);

    // Cap status, reusing the same phrasing as the deterministic status hook.
    expect(out).toContain(`Today: $${todayTotal.toFixed(2)} of $10.00 cap.`);

    // Notional-dollars caveat, one line.
    expect(out).toContain('These dollar figures are an estimate');
  });

  test('cap line is omitted when no budget is configured', async () => {
    const { cchDir } = setup(null, [{ daysAgo: 0, source: 'other' }]);
    const out = await runPlain(cchDir);
    expect(out).not.toContain('cap.');
  });

  test('typical-day comparison is omitted with no prior-day history', async () => {
    const { cchDir } = setup(null, [{ daysAgo: 0, source: 'other' }]);
    const out = await runPlain(cchDir);
    const todayLine = out.split('\n')[0];
    expect(todayLine).toMatch(/^Today: \$[\d.]+\.$/); // no " — ... typical day" suffix
  });

  test('typical-day comparison names a direction with prior-day history', async () => {
    const { cchDir } = setup(null, [
      { daysAgo: 0, source: 'other', cacheRead: 100000, output: 5000 }, // big today
      { daysAgo: 1, source: 'other', cacheRead: 1000, output: 50 }, // tiny prior day
    ]);
    const out = await runPlain(cchDir);
    expect(out.split('\n')[0]).toContain('typical day');
  });
});

describe('cost-reflect --plain: no-jargon invariant', () => {
  test('never emits token-category labels, raw source strings, or session ids', async () => {
    const { cchDir } = setup(
      { daily_usd: 5.0, weekly_usd: null, monthly_usd: null, action: 'alert' },
      [
        { daysAgo: 0, source: 'other' },
        { daysAgo: 0, source: 'heartbeat' },
        { daysAgo: 1, source: 'routine:doctor' },
        { daysAgo: 2, source: 'channel:discord' },
      ],
    );
    const out = await runPlain(cchDir);

    // Token-category vocabulary (the table mode's header, cost-reflect.ts:132-136).
    for (const jargon of ['cache_read', 'cache_write', 'token type', 'turns /']) {
      expect(out).not.toContain(jargon);
    }
    // Raw source strings must be translated, never passed through.
    for (const raw of ['heartbeat', 'routine:', 'channel:']) {
      expect(out.toLowerCase()).not.toContain(raw);
    }
    // No internal IDs or slash commands.
    expect(out).not.toMatch(/PROP-\d/);
    expect(out).not.toMatch(/\bS-\d{3}\b/);
    expect(out).not.toMatch(/\/hermitd/);
    expect(out).not.toMatch(/sess-\d/); // session ids
  });
});

describe('cost-reflect table mode: unaffected by --plain', () => {
  test('default invocation still returns the raw breakdown', async () => {
    const { cchDir } = setup(null, [{ daysAgo: 0, source: 'other' }]);
    const result = await runScript('cost-report.ts', { args: ['reflect', cchDir, '7'] });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.window_days).toBe(7);
    expect(out.by_type.cache_read).toBeDefined();
  });
});

describe('cost-reflect table mode: stored dollars, never re-priced', () => {
  test('alias rows sum their stored dollars unchanged', async () => {
    const { cchDir } = setup(null, [
      { daysAgo: 0, source: 'other', model: 'sonnet', estimatedCostUsd: 12.34, costByType: null },
      { daysAgo: 0, source: 'heartbeat', model: 'opus', estimatedCostUsd: 7.66, costByType: null },
    ]);
    const result = await runScript('cost-report.ts', { args: ['reflect', cchDir, '7'] });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.total_usd).toBe(20);
    expect(out.by_type).toBeNull();
  });

  test('a mixed window shows the split from cost_by_type rows only', async () => {
    const { cchDir } = setup(null, [
      {
        daysAgo: 0, source: 'other', model: 'claude-sonnet-5', estimatedCostUsd: 5,
        costByType: { input: 1, cache_write: 0.5, cache_read: 2, output: 1.5 },
      },
      { daysAgo: 0, source: 'heartbeat', model: 'claude-sonnet-5', estimatedCostUsd: 3, costByType: null },
    ]);
    const result = await runScript('cost-report.ts', { args: ['reflect', cchDir, '7'] });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.total_usd).toBe(8);
    expect(out.by_type).toEqual({
      typed_total_usd: 5,
      cache_read: { cost_usd: 2, pct: 40 },
      cache_write: { cost_usd: 0.5, pct: 10 },
      output: { cost_usd: 1.5, pct: 30 },
      input: { cost_usd: 1, pct: 20 },
    });
  });
});
