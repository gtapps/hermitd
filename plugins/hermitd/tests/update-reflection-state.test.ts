import { describe, test, expect } from 'bun:test';
import { runPinnedScript } from './helpers/run';
import { withDir, hermit, write, readJson } from './helpers/workdir';

describe('update-reflection-state', () => {
  /** Run the script against the workdir's state file and return the resulting JSON. */
  async function updateState(dir: string, payload: string) {
    const stateFile = hermit(dir, 'state', 'reflection-state.json');
    const r = await runPinnedScript('update-reflection-state.ts', hermit(dir), [stateFile, payload]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('OK\n');
    return readJson(stateFile);
  }

  // 7. Fresh state file — initializes counters from scratch
  test('update-reflection-state (initializes counters)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'), '{"last_reflection":null}');
    const d = await updateState(dir,
      '{"ran_with_candidates":true,"judge_accept":2,"proposals_created":1}');
    const c = d.counters;
    expect(c.total_runs).toBe(1);
    expect(c.runs_with_candidates).toBe(1);
    expect(c.empty_runs).toBe(0);
    expect(c.judge_accept).toBe(2);
    expect(c.proposals_created).toBe(1);
    expect(c.last_output_at).not.toBeNull();
  }));

  // 8. Empty run — increments empty_runs, leaves last_output_at null, preserves other keys
  test('update-reflection-state (empty run, preserves other keys)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"scheduled_checks":{"md-audit":{"last_run":"2026-04-01"}},"counters":{"total_runs":5,"empty_runs":2,"runs_with_candidates":3,"last_output_at":null}}');
    const d = await updateState(dir, '{"ran_with_candidates":false}');
    const c = d.counters;
    expect(c.total_runs).toBe(6);
    expect(c.empty_runs).toBe(3);
    expect(c.runs_with_candidates).toBe(3);
    expect(c.last_output_at).toBeNull();
    expect(d.scheduled_checks['md-audit'].last_run).toBe('2026-04-01');
  }));

  // 9. Missing counters object — treated as all-zero, seeds counters with since key
  test('update-reflection-state (missing counters object)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"last_reflection":"2026-04-01T00:00:00Z"}');
    const d = await updateState(dir,
      '{"ran_with_candidates":true,"proposals_created":1}');
    const c = d.counters;
    expect(c.total_runs).toBe(1);
    expect(c.proposals_created).toBe(1);
    expect(c.last_output_at).not.toBeNull();
    expect(c).toHaveProperty('since');
  }));

  // 10. Missing state file — fail-open: exits 0 and writes valid JSON
  test('update-reflection-state (missing state file, fail-open)', withDir(async (dir) => {
    const d = await updateState(dir, '{"ran_with_candidates":false}');
    expect(d.counters.total_runs).toBe(1);
  }));

  // 11. last_sparse_nudge — new entry is merged, existing entries preserved
  test('update-reflection-state removes obsolete last_sparse_nudge', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"last_sparse_nudge":{"PROP-001":"2026-04-01T00:00:00Z"},"counters":{"total_runs":1}}');
    const d = await updateState(dir,
      '{"ran_with_candidates":false,"last_sparse_nudge":{"PROP-002":"2026-04-22T00:00:00Z"}}');
    expect(d).not.toHaveProperty('last_sparse_nudge');
  }));

  // 11a. judge_suppress_by_code — first run initializes map and accumulates codes
  test('update-reflection-state (judge_suppress_by_code: initial accumulation)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'), '{"counters":{"total_runs":1}}');
    const d = await updateState(dir,
      '{"ran_with_candidates":true,"judge_suppress":2,"judge_suppress_by_code":{"no-evidence":1,"covered-by-memory":1}}');
    const m = d.counters.judge_suppress_by_code;
    expect(m['no-evidence']).toBe(1);
    expect(m['covered-by-memory']).toBe(1);
    expect(m).not.toHaveProperty('no-sessions');
  }));

  // 11b. judge_suppress_by_code — second run accumulates into existing counts
  test('update-reflection-state (judge_suppress_by_code: cumulative accumulation)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"counters":{"total_runs":2,"judge_suppress":2,"judge_suppress_by_code":{"no-evidence":1,"covered-by-memory":1}}}');
    const d = await updateState(dir,
      '{"ran_with_candidates":true,"judge_suppress":2,"judge_suppress_by_code":{"no-evidence":1,"no-sessions":1}}');
    const m = d.counters.judge_suppress_by_code;
    expect(m['no-evidence']).toBe(2);
    expect(m['covered-by-memory']).toBe(1);
    expect(m['no-sessions']).toBe(1);
  }));

  // 11c. judge_suppress_by_code — absent from payload leaves existing map unchanged
  test('update-reflection-state (judge_suppress_by_code: absent payload preserves map)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'reflection-state.json'),
      '{"counters":{"total_runs":3,"judge_suppress_by_code":{"no-evidence":5}}}');
    const d = await updateState(dir, '{"ran_with_candidates":false}');
    expect(d.counters.judge_suppress_by_code['no-evidence']).toBe(5);
  }));
});
