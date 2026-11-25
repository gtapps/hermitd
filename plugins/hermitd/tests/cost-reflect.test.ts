import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, withDir, type Workdir, write } from './helpers/workdir';
import { utcDate, daysAgo } from './helpers/fixture-dates';

async function runCostReflect(dir: string): Promise<any> {
  const r = await runScript('cost-report.ts', { args: ['reflect', '.hermit'], cwd: dir });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe('cost-reflect', () => {
  // Fixture log with known entries. Entry timestamps use a date definitely within
  // the 7-day window (today - 1 day). One entry is older than the window (today - 8 days).
  describe('window + sections', () => {
    let wd: Workdir;
    let out: any;

    beforeAll(async () => {
      wd = setupWorkdir();
      const inWindow = utcDate(daysAgo(1));
      const old = utcDate(daysAgo(8));
      write(path.join(wd.dir, '.claude', 'cost-log.jsonl'), [
        `{"timestamp":"${inWindow}T10:00:00.000Z","session_id":"sessionA1","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":100000,"output_tokens":0,"total_tokens":100000,"estimated_cost_usd":0.03}`,
        `{"timestamp":"${inWindow}T10:01:00.000Z","session_id":"sessionA1","model":"sonnet","input_tokens":0,"cache_write_tokens":50000,"cache_read_tokens":0,"output_tokens":500,"total_tokens":50500,"estimated_cost_usd":0.195}`,
        `{"timestamp":"${inWindow}T10:02:00.000Z","session_id":"sessionA1","model":"haiku","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":200000,"output_tokens":2000,"total_tokens":202000,"estimated_cost_usd":0.024}`,
        `{"timestamp":"${inWindow}T10:03:00.000Z","session_id":"sessionB2","model":"opus","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":100000,"total_tokens":100000,"estimated_cost_usd":7.5}`,
        `{"timestamp":"${inWindow}T10:04:00.000Z","session_id":"sessionD4","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":20000,"output_tokens":1000,"total_tokens":21000,"estimated_cost_usd":0.021,"cost_by_type":{"input":0,"cache_write":0,"cache_read":0.006,"output":0.015}}`,
        `{"timestamp":"${old}T10:00:00.000Z","session_id":"session-OLD","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":999999,"output_tokens":0,"total_tokens":999999,"estimated_cost_usd":99.9999}`,
        'NOT_VALID_JSON', // malformed line to test resilience
        '',
      ].join('\n'));
      out = await runCostReflect(wd.dir);
    });
    afterAll(() => wd.cleanup());

    // Grand total = sum of 5 in-window stored dollars (session-OLD and malformed line excluded)
    // 0.03 + 0.195 + 0.024 + 7.5 + 0.021 = 7.77
    test('cost-reflect: total includes all 5 in-window entries', () => {
      expect(out.window_days).toBe(7);
      expect(out.total_usd).toBeCloseTo(7.77, 4);
      expect(out.turns).toBe(5);
    });

    // Pre-window entry excluded (session-OLD would contribute $99 if included)
    test('cost-reflect: pre-window entry excluded', () => {
      expect(out.total_usd).toBeLessThan(99);
      expect(out.top_sessions.map((s: any) => s.id)).not.toContain('session-');
    });

    // Cold-start: exactly 1 turn
    // (entry 2 matches heuristic; entry 5 has cw=0 so it is NOT a cold-start)
    test('cost-reflect: 1 cold-start turn detected', () => {
      expect(out.cold_starts).toMatchObject({ turns: 1, cost_usd: 0.195 });
    });

    // sessionB2 is the most expensive (opus, $7.5 output) → first top session
    test('cost-reflect: sessionB (opus output) is top session', () => {
      expect(out.top_sessions[0]).toMatchObject({ id: 'sessionB', cost_usd: 7.5 });
    });

    // sessionD4: sonnet, cache_read=20K tokens vs output=1K tokens — by token count
    // cache_read>output, but by sub-cost output ($0.015) > cache_read ($0.006) →
    // dominant must be 'output', not 'cache_read'.
    test('cost-reflect: dominant type by sub-cost not token volume', () => {
      const d = out.top_sessions.find((s: any) => s.id === 'sessionD');
      expect(d.dominant).toBe('output');
    });

    // The digest stays verdict-sized
    test('cost-reflect: output ≤1500 chars', () => {
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(1500);
    });

    // Per-model rows: fixture mixes sonnet, haiku, opus
    test('cost-reflect: by_model lists every model in a mixed-model window', () => {
      expect(out.by_model.map((m: any) => m.model).sort()).toEqual(['haiku', 'opus', 'sonnet']);
    });
  });

  test('cost-reflect: by_model and cold_starts stay empty for a single-model window with no warm-up', withDir(async (dir) => {
    const inWindow = utcDate(daysAgo(1));
    write(path.join(dir, '.claude', 'cost-log.jsonl'), [
      `{"timestamp":"${inWindow}T10:01:00.000Z","session_id":"s1","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":50000,"output_tokens":200,"total_tokens":50200,"estimated_cost_usd":0.018}`,
    ].join('\n'));
    const o = await runCostReflect(dir);
    expect(o.by_model).toEqual([]);
    expect(o.cold_starts).toBeNull();
  }));

  const EMPTY = { status: 'empty', reason: 'no_cost_data', window_days: 7 };

  // Empty log: no entries at all
  test('cost-reflect: empty log → empty status', withDir(async (dir) => {
    write(path.join(dir, '.claude', 'cost-log.jsonl'), '\n');
    expect(await runCostReflect(dir)).toEqual(EMPTY);
  }));

  // Missing log: .claude/cost-log.jsonl does not exist
  test('cost-reflect: missing log → empty status (exit 0)', withDir(async (dir) => {
    expect(await runCostReflect(dir)).toEqual(EMPTY);
  }));
});

describe('cost-reflect source attribution', () => {
  // Fixture log with known source values + legacy untagged entries
  describe('tagged sources', () => {
    let wd: Workdir;
    let out: any;
    const source = (name: string) => out.by_source.find((r: any) => r.source === name);

    beforeAll(async () => {
      wd = setupWorkdir();
      const d = utcDate(daysAgo(1));
      // Fixture: 4 main-turn entries + 1 subagent:true entry for routine:reflect (haiku).
      // haiku cost: input=10000→$0.008, output=2000→$0.008 = $0.016.
      // routine:reflect total: $0.06 (main) + $0.016 (subagent) = $0.076.
      // turns count must remain 4 (subagent line excluded from turn counter).
      write(path.join(wd.dir, '.claude', 'cost-log.jsonl'), [
        `{"timestamp":"${d}T10:00:00.000Z","session_id":"s1","source":"heartbeat","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":100000,"output_tokens":0,"total_tokens":100000,"estimated_cost_usd":0.03}`,
        `{"timestamp":"${d}T10:01:00.000Z","session_id":"s2","source":"routine:reflect","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":100000,"output_tokens":2000,"total_tokens":102000,"estimated_cost_usd":0.06}`,
        `{"timestamp":"${d}T10:01:30.000Z","session_id":"s2","source":"routine:reflect","model":"haiku","input_tokens":10000,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":2000,"total_tokens":12000,"estimated_cost_usd":0.016,"subagent":true,"agent_type":"general-purpose","api_calls":0}`,
        `{"timestamp":"${d}T10:02:00.000Z","session_id":"s3","source":"other","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":50000,"output_tokens":5000,"total_tokens":55000,"estimated_cost_usd":0.09}`,
        `{"timestamp":"${d}T10:03:00.000Z","session_id":"s4","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":50000,"output_tokens":1000,"total_tokens":51000,"estimated_cost_usd":0.021}`,
        '',
      ].join('\n'));
      out = await runCostReflect(wd.dir);
    });
    afterAll(() => wd.cleanup());

    test('cost-reflect: heartbeat source row present', () => {
      expect(source('heartbeat')).toBeDefined();
    });
    test('cost-reflect: legacy entry (no source) bucketed to other', () => {
      // other = $0.09 (tagged) + $0.021 (untagged legacy row)
      expect(source('other').cost_usd).toBeCloseTo(0.111, 4);
    });
    test('cost-reflect (source fixture): output ≤1500 chars', () => {
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(1500);
    });
    test('cost-reflect: subagent entry folds into routine:reflect row (cost rises)', () => {
      // routine:reflect = $0.06 (main sonnet) + $0.016 (haiku subagent) = $0.076.
      // Without subagent attribution it would be $0.06.
      expect(source('routine:reflect').cost_usd).toBeCloseTo(0.076, 4);
    });
    test('cost-reflect: subagent line is excluded from turns count', () => {
      // 4 main-turn entries in fixture (not 5); subagent line must not inflate turns.
      expect(out.turns).toBe(4);
    });
  });

  // ~20-source cap fixture: verify ≤1500 chars with many distinct routine sources
  describe('many sources cap', () => {
    let wd: Workdir;
    let out: any;

    beforeAll(async () => {
      wd = setupWorkdir();
      const d = utcDate(daysAgo(1));
      const lines = Array.from({ length: 20 }, (_, k) => {
        const i = k + 1;
        return `{"timestamp":"${d}T10:${String(i).padStart(2, '0')}:00.000Z","session_id":"s${i}","source":"routine:routine-${i}","model":"sonnet","input_tokens":0,"cache_write_tokens":0,"cache_read_tokens":10000,"output_tokens":500,"total_tokens":10500,"estimated_cost_usd":0.01}`;
      });
      write(path.join(wd.dir, '.claude', 'cost-log.jsonl'), lines.join('\n') + '\n');
      out = await runCostReflect(wd.dir);
    });
    afterAll(() => wd.cleanup());

    test('cost-reflect: 20-source fixture caps by_source at five', () => {
      expect(out.by_source).toHaveLength(5);
    });
    test('cost-reflect: 20-source fixture counts the rest in more_sources', () => {
      expect(out.more_sources).toBe(15);
    });
  });
});
