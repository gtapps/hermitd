// Unit tests for scripts/lib/cost-log.ts — in-process (pure fs, no HERMIT_DIR
// module-load cache like cost-tracker.ts, so direct import is safe here).
//
// Covers: by_week/by_month aggregation incl. a tz day/week/month boundary case,
// INDEX_VERSION-bump rebuild, week/month pruning, scanUnpricedModels.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  updateCostIndex, readCostIndex, computeIndex, scanUnpricedModels, scanRoutineLedger,
  scanRoutineCostWindow, buildMainCostRow, buildSubagentCostRow, appendCostRows,
} from '../scripts/lib/cost-log';

function withTmpdir(fn: (dir: string) => void) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-log-'));
    try { fn(dir); } finally { fs.rmSync(dir, { recursive: true }); }
  };
}

function writeLog(dir: string, entries: object[]): string {
  const logPath = path.join(dir, 'cost-log.jsonl');
  fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return logPath;
}

const NY = 'America/New_York';
// Reference "now" for the retention cutoffs, pinned a couple days after the fixture
// dates so the 2026-07-04/05 buckets stay inside the trailing by_date window regardless
// of the real wall-clock date (otherwise these fixed-date fixtures age out and fail).
const ASOF = new Date('2026-07-06T12:00:00Z');

describe('#10d — timezone change re-buckets the index', () => {
  test('a config.timezone change triggers a rebuild under the new tz', withTmpdir((dir) => {
    // 2026-07-05T02:00:00Z = 2026-07-04 in NY (EDT), but 2026-07-05 in UTC.
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-05T02:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');

    const utc = updateCostIndex(logPath, idxPath, 'UTC', ASOF);
    expect(Object.keys(utc.by_date)).toEqual(['2026-07-05']);
    expect(utc.timezone).toBe('UTC');

    // Same log, new timezone — must re-bucket, not keep the stale UTC key.
    const ny = updateCostIndex(logPath, idxPath, NY, ASOF);
    expect(ny.timezone).toBe(NY);
    expect(Object.keys(ny.by_date)).toEqual(['2026-07-04']);
    expect(ny.by_date['2026-07-05']).toBeUndefined();
  }));
});

describe('#10c — computeIndex: read-only spend without writing the index', () => {
  test('returns correct buckets and does NOT create/modify the index file', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T22:17:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.5 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');

    const idx = computeIndex(logPath, NY, ASOF);
    expect(idx.by_date['2026-07-04'].cost).toBe(1.5);
    expect(idx.timezone).toBe(NY);
    expect(fs.existsSync(idxPath)).toBe(false); // read-only — sole-writer invariant preserved
  }));
});

describe('updateCostIndex — by_week/by_month tz-aware aggregation', () => {
  test('a UTC-late-night entry buckets into the prior NY calendar day/week/month', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      // 2026-07-05T02:00:00Z = 2026-07-04T22:00:00 America/New_York (EDT, UTC-4)
      { timestamp: '2026-07-05T02:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    const idx = updateCostIndex(logPath, idxPath, NY, ASOF);

    expect(Object.keys(idx.by_date)).toEqual(['2026-07-04']);
    expect(idx.by_week['2026-W27'].cost).toBe(1.0);
    expect(idx.by_month['2026-07'].cost).toBe(1.0);
  }));

  test('two entries in the same tz-local day/week/month accumulate into one bucket each', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T22:17:00Z', session_id: 's1', source: 'heartbeat', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.5 },
      { timestamp: '2026-07-05T02:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 50, estimated_cost_usd: 0.5 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    const idx = updateCostIndex(logPath, idxPath, NY, ASOF);

    expect(Object.keys(idx.by_date)).toEqual(['2026-07-04']);
    expect(idx.by_date['2026-07-04'].cost).toBe(2);
    expect(idx.by_week['2026-W27'].cost).toBe(2);
    expect(idx.by_month['2026-07'].cost).toBe(2);
    expect(idx.total_cost_usd).toBe(2);
  }));

  test('default timezone (UTC) behaves as before when unspecified', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T22:17:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    const idx = updateCostIndex(logPath, idxPath, undefined, ASOF); // timezone omitted -> defaults to UTC

    expect(Object.keys(idx.by_date)).toEqual(['2026-07-04']);
    expect(idx.by_week['2026-W27']).toBeDefined();
  }));

  test('incremental update (second call) only processes newly appended bytes', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    updateCostIndex(logPath, idxPath, 'UTC', ASOF);

    fs.appendFileSync(logPath, JSON.stringify({
      timestamp: '2026-07-04T13:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 50, estimated_cost_usd: 0.5,
    }) + '\n');
    const idx = updateCostIndex(logPath, idxPath, 'UTC', ASOF);

    expect(idx.by_date['2026-07-04'].cost).toBe(1.5);
    expect(idx.total_cost_usd).toBe(1.5);
  }));
});

describe('updateCostIndex — interleaved writers', () => {
  test('one fold after two appends counts both new rows once', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    updateCostIndex(logPath, idxPath, 'UTC', ASOF);

    appendCostRows(logPath, [
      { timestamp: '2026-07-04T13:00:00Z', session_id: 's2', source: 'other', model: 'sonnet', total_tokens: 50, estimated_cost_usd: 0.25 },
      { timestamp: '2026-07-04T14:00:00Z', session_id: 's3', source: 'other', model: 'sonnet', total_tokens: 25, estimated_cost_usd: 0.5 },
    ]);
    const idx = updateCostIndex(logPath, idxPath, 'UTC', ASOF);

    expect(idx.total_cost_usd).toBe(1.75);
    expect(idx.byte_offset).toBe(fs.statSync(logPath).size);
  }));

  test('a stale checkpoint winning the rename still counts each row once', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    updateCostIndex(logPath, idxPath, 'UTC', ASOF);

    appendCostRows(logPath, [
      { timestamp: '2026-07-04T13:00:00Z', session_id: 's2', source: 'other', model: 'sonnet', total_tokens: 50, estimated_cost_usd: 0.25 },
    ]);
    const checkpointA = JSON.parse(JSON.stringify(updateCostIndex(logPath, idxPath, 'UTC', ASOF)));
    appendCostRows(logPath, [
      { timestamp: '2026-07-04T14:00:00Z', session_id: 's3', source: 'other', model: 'sonnet', total_tokens: 25, estimated_cost_usd: 0.5 },
    ]);
    updateCostIndex(logPath, idxPath, 'UTC', ASOF);

    // Stale _writeIndex rename: checkpoint@A lands after checkpoint@A+B.
    fs.writeFileSync(idxPath, JSON.stringify(checkpointA));
    const idx = updateCostIndex(logPath, idxPath, 'UTC', ASOF);

    expect(idx.total_cost_usd).toBe(1.75);
    expect(idx.by_date['2026-07-04'].cost).toBe(1.75);
    expect(idx.byte_offset).toBe(fs.statSync(logPath).size);
  }));
});

describe('index version bump forces a rebuild', () => {
  test('a v2 (pre-PROP-016) index is discarded and rebuilt with by_week/by_month', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    // Simulate a stale v2 index (no by_week/by_month, different byte_offset).
    fs.writeFileSync(idxPath, JSON.stringify({
      version: 2, byte_offset: 0, total_cost_usd: 0, total_tokens: 0, total_sessions: 0,
      last_session_id: null, by_source: {}, by_date: {}, skipped_corrupt_lines: 0,
      updated_at: new Date(0).toISOString(),
    }));

    const idx = updateCostIndex(logPath, idxPath, 'UTC');

    expect(idx.version).toBe(4);
    expect(idx.by_week).toBeDefined();
    expect(idx.by_month).toBeDefined();
    expect(idx.total_cost_usd).toBe(1.0);
  }));

  test('readCostIndex returns null for a stale v2 file (forces caller rebuild)', withTmpdir((dir) => {
    const idxPath = path.join(dir, 'cost-index.json');
    fs.writeFileSync(idxPath, JSON.stringify({ version: 2, by_date: {} }));
    expect(readCostIndex(idxPath)).toBeNull();
  }));
});

describe('week/month pruning', () => {
  test('by_week and by_month entries older than retention are dropped', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      // Far in the past — well outside both retention windows.
      { timestamp: '2020-01-01T12:00:00Z', session_id: 's0', source: 'other', model: 'sonnet', total_tokens: 10, estimated_cost_usd: 0.1 },
      { timestamp: '2026-07-04T12:00:00Z', session_id: 's1', source: 'other', model: 'sonnet', total_tokens: 100, estimated_cost_usd: 1.0 },
    ]);
    const idxPath = path.join(dir, 'cost-index.json');
    const idx = updateCostIndex(logPath, idxPath, 'UTC');

    // Old bucket pruned from by_date/by_week/by_month...
    expect(idx.by_date['2020-01-01']).toBeUndefined();
    expect(Object.keys(idx.by_week).some(w => w.startsWith('2020'))).toBe(false);
    expect(idx.by_month['2020-01']).toBeUndefined();
    // ...but total_cost_usd (all-time) still includes it.
    expect(idx.total_cost_usd).toBeCloseTo(1.1, 5);
  }));
});

describe('scanUnpricedModels', () => {
  test('counts a model_unpriced row with a full unknown id', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', model: 'claude-nova-9', source: 'other', estimated_cost_usd: 1.25, model_unpriced: true },
    ]);
    const result = scanUnpricedModels(logPath, '2026-07-01', 'UTC');
    expect(result.count).toBe(1);
    expect(result.cost).toBe(1.25);
  }));

  test('counts only lines flagged model_unpriced:true within the date window', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-04T12:00:00Z', model: 'sonnet', source: 'other', estimated_cost_usd: 1.0, model_unpriced: true },
      { timestamp: '2026-07-04T13:00:00Z', model: 'sonnet', source: 'other', estimated_cost_usd: 2.0, model_unpriced: false },
      { timestamp: '2026-06-01T00:00:00Z', model: 'sonnet', source: 'other', estimated_cost_usd: 5.0, model_unpriced: true }, // outside window
    ]);
    const result = scanUnpricedModels(logPath, '2026-07-01', 'UTC');
    expect(result.count).toBe(1);
    expect(result.cost).toBe(1.0);
  }));

  test('returns zero on an absent log file', () => {
    const result = scanUnpricedModels('/nonexistent/path/cost-log.jsonl', '2026-01-01');
    expect(result).toEqual({ count: 0, cost: 0 });
  });
});

describe('scanRoutineLedger — single-population cost and runs', () => {
  test('one main row plus its subagent rows is ONE run carrying their combined cost', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-01T00:00:00Z', source: 'routine:weekly', estimated_cost_usd: 1, source_attribution_version: 2 },
      { timestamp: '2026-07-01T00:00:05Z', source: 'routine:weekly', estimated_cost_usd: 2, subagent: true, source_attribution_version: 2 },
      { timestamp: '2026-07-01T00:00:09Z', source: 'routine:weekly', estimated_cost_usd: 3, subagent: true, source_attribution_version: 2 },
    ]);
    const result = scanRoutineLedger(logPath);
    expect(result.get('routine:weekly')).toEqual({ cost: 6, runs: 1 });
  }));

  test('a delayed async subagent row still counts toward its source, with no time window', withTmpdir((dir) => {
    // Async rows are stamped at SubagentStop and inherit the launch turn's source, so one
    // can land hours later. It is real cost of that routine — a proximity window would
    // discard it, which is why this aggregator has none.
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-01T09:30:00Z', source: 'routine:doctor', estimated_cost_usd: 0.5, source_attribution_version: 2 },
      { timestamp: '2026-07-01T21:04:00Z', source: 'routine:doctor', estimated_cost_usd: 1.1, subagent: true, source_attribution_version: 2 },
    ]);
    const result = scanRoutineLedger(logPath);
    expect(result.get('routine:doctor')).toEqual({ cost: 1.6, runs: 1 });
  }));

  test('a dispatch-hop-attributed completion turn adds cost but not a run', withTmpdir((dir) => {
    // An async-dispatching routine bills TWO main turns per fire: the wake, and the turn that
    // ingests the subagent-completion notification (which cost-tracker's dispatch hop
    // attributes back to the routine, stamping source_inherited). Counting the second as a
    // run would report $2/run for a routine that actually costs $4 per fire, letting a genuinely
    // expensive delegating routine slip under the doctor's 3×-median / floor gate.
    const logPath = writeLog(dir, [
      { timestamp: '2026-07-01T03:30:00Z', source: 'routine:daily-auto-close', estimated_cost_usd: 1, source_attribution_version: 2 },
      { timestamp: '2026-07-01T03:34:00Z', source: 'routine:daily-auto-close', estimated_cost_usd: 3, source_inherited: true, source_attribution_version: 2 },
    ]);
    expect(scanRoutineLedger(logPath).get('routine:daily-auto-close')).toEqual({ cost: 4, runs: 1 });
  }));

  test('rows written before the attribution fix are excluded entirely', withTmpdir((dir) => {
    // The historical poison: pre-v2 `source` could be captured by any tool output naming a
    // routine id, so those rows are not a measurement and must not reach $/run.
    const logPath = writeLog(dir, [
      { timestamp: '2026-06-01T00:00:00Z', source: 'routine:weekly', estimated_cost_usd: 97 },                      // v1, no field
      { timestamp: '2026-06-02T00:00:00Z', source: 'routine:weekly', estimated_cost_usd: 88, source_attribution_version: 1 },
      { timestamp: '2026-07-05T00:00:00Z', source: 'routine:weekly', estimated_cost_usd: 2, source_attribution_version: 2 },
    ]);
    const result = scanRoutineLedger(logPath);
    expect(result.get('routine:weekly')).toEqual({ cost: 2, runs: 1 });
  }));

  test('a v1-only log yields no clean sample at all', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      { timestamp: '2026-06-01T00:00:00Z', source: 'routine:weekly', estimated_cost_usd: 97 },
    ]);
    expect(scanRoutineLedger(logPath).size).toBe(0);
  }));

  test('returns an empty map on an absent log file', () => {
    expect(scanRoutineLedger('/nonexistent/path/cost-log.jsonl').size).toBe(0);
  });
});

describe('cost row builders', () => {
  const mainBase = {
    ccSessionId: 'cc-1', source: 'other', model: 'sonnet',
    inputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 30, outputTokens: 40,
    totalTokens: 100, apiCalls: 3, maxPromptTokens: 5000,
    lastCallPromptTokens: 4000, contextUsage: null,
    estimatedCostUsd: 0.1234, modelUnpriced: false,
  };
  const subBase = {
    source: 'heartbeat', model: 'haiku',
    inputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4,
    totalTokens: 10, agentType: 'hermitd:skill-eval-runner',
    modelResolved: true, estimatedCostUsd: 0.005,
  };

  // Consumers branch on presence, not truthiness (cost-tracker's duplicate guard
  // reads `typeof observed_at === 'string'`; scanRoutineLedger tests
  // `source_inherited !== true`). A builder that defaulted these to false/null
  // would silently change what a legacy row means.
  test('optional keys are absent, not falsy, when they do not apply', () => {
    const row = buildMainCostRow(mainBase);
    expect('observed_at' in row).toBe(false);
    expect('source_inherited' in row).toBe(false);
    expect('guest' in row).toBe(false);
    expect('cost_by_type' in row).toBe(false);
  });

  test('optional keys are present when they do apply', () => {
    const costByType = { input: 0.1, cache_write: 0.2, cache_read: 0.3, output: 0.4 };
    const row = buildMainCostRow({ ...mainBase, observedAt: '2026-08-01T00:00:00.000Z', sourceInherited: true, costByType });
    expect(row.observed_at).toBe('2026-08-01T00:00:00.000Z');
    expect(row.source_inherited).toBe(true);
    expect(row.cost_by_type).toEqual(costByType);
  });

  test('a null observedAt stays absent rather than serializing null', () => {
    expect('observed_at' in buildMainCostRow({ ...mainBase, observedAt: null })).toBe(false);
  });

  test('model_unpriced is always present, including when false', () => {
    // Distinct from the optional keys above: its absence means "written before the
    // field existed", so a false must serialize.
    const row = buildMainCostRow(mainBase);
    expect('model_unpriced' in row).toBe(true);
    expect(row.model_unpriced).toBe(false);
  });

  test('main row key set is stable', () => {
    expect(Object.keys(buildMainCostRow(mainBase)).sort()).toEqual([
      'api_calls', 'attribution', 'bucket', 'cache_read_tokens', 'cache_write_tokens', 'cc_session_id', 'context_usage',
      'estimated_cost_usd', 'input_tokens', 'last_call_prompt_tokens', 'max_prompt_tokens',
      'model', 'model_unpriced', 'output_tokens', 'source',
      'source_attribution_version', 'task_id', 'timestamp', 'total_tokens',
    ]);
  });

  test('subagent row key set is stable and marks subagent:true', () => {
    const row = buildSubagentCostRow(subBase);
    expect(Object.keys(row).sort()).toEqual([
      'agent_type', 'api_calls', 'attribution', 'bucket', 'cache_read_tokens', 'cache_write_tokens', 'context_usage',
      'estimated_cost_usd', 'input_tokens', 'model', 'model_resolved', 'output_tokens',
      'source', 'source_attribution_version', 'subagent', 'task_id', 'timestamp', 'total_tokens',
    ]);
    expect(row).toMatchObject({ subagent: true, api_calls: 0, context_usage: null });
  });

  test('model_resolved:false survives as false (a sonnet-default guess, not a fact)', () => {
    expect(buildSubagentCostRow({ ...subBase, modelResolved: false }).model_resolved).toBe(false);
  });

  test('both writers of the subagent shape agree', () => {
    // The sync path (cost-tracker) and the async hook (subagent-cost) used to spell
    // this object out separately, with nothing pinning the copies together.
    const a = buildSubagentCostRow({ ...subBase, timestamp: 'T' });
    const b = buildSubagentCostRow({ ...subBase, timestamp: 'T' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('appendCostRows writes one line per row and keeps order', withTmpdir((dir) => {
    const logPath = path.join(dir, 'cost-log.jsonl');
    const main = buildMainCostRow(mainBase);
    const sub = buildSubagentCostRow(subBase);
    appendCostRows(logPath, [main, sub]);
    appendCostRows(logPath, []);   // no-op, must not write a stray newline
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).subagent).toBeUndefined();
    expect(JSON.parse(lines[1]).subagent).toBe(true);
  }));

  test('appendCostRows preserves new rows after an unterminated partial tail', withTmpdir((dir) => {
    const logPath = path.join(dir, 'cost-log.jsonl');
    const idxPath = path.join(dir, 'cost-index.json');
    const partial = '{"timestamp":"interrupted"';
    const main = buildMainCostRow(mainBase);
    const sub = buildSubagentCostRow(subBase);
    fs.writeFileSync(logPath, partial);

    appendCostRows(logPath, [main, sub]);

    const lines = fs.readFileSync(logPath, 'utf-8').trimEnd().split('\n');
    expect(lines[0]).toBe(partial);
    expect(JSON.parse(lines[1]).subagent).toBeUndefined();
    expect(JSON.parse(lines[2]).subagent).toBe(true);

    const idx = updateCostIndex(logPath, idxPath, 'UTC');
    expect(idx.skipped_corrupt_lines).toBe(1);
    expect(idx.total_cost_usd).toBeCloseTo(main.estimated_cost_usd + sub.estimated_cost_usd, 8);
    expect(idx.total_tokens).toBe(main.total_tokens + sub.total_tokens);
  }));

  test('appendCostRows adds no extra separator to healthy, empty, or missing files', withTmpdir((dir) => {
    const row = buildMainCostRow(mainBase);
    const serialized = `${JSON.stringify(row)}\n`;
    const missingPath = path.join(dir, 'missing.jsonl');
    const emptyPath = path.join(dir, 'empty.jsonl');
    const healthyPath = path.join(dir, 'healthy.jsonl');
    fs.writeFileSync(emptyPath, '');
    fs.writeFileSync(healthyPath, `${serialized}`);

    appendCostRows(missingPath, [row]);
    appendCostRows(emptyPath, [row]);
    appendCostRows(healthyPath, [row]);

    expect(fs.readFileSync(missingPath, 'utf-8')).toBe(serialized);
    expect(fs.readFileSync(emptyPath, 'utf-8')).toBe(serialized);
    expect(fs.readFileSync(healthyPath, 'utf-8')).toBe(serialized + serialized);
  }));

  test('appendCostRows leaves an unterminated tail untouched when no rows are provided', withTmpdir((dir) => {
    const logPath = path.join(dir, 'cost-log.jsonl');
    const partial = '{"timestamp":"interrupted"';
    fs.writeFileSync(logPath, partial);

    appendCostRows(logPath, []);

    expect(fs.readFileSync(logPath, 'utf-8')).toBe(partial);
  }));
});

describe('scanRoutineCostWindow', () => {
  // `version: null` omits the stamp entirely (a legacy row). A default parameter
  // cannot express that — JS resolves an explicitly-passed `undefined` to the default.
  const row = (source: string, timestamp: string, cost: number, version: number | null = 2) => ({
    source, timestamp, estimated_cost_usd: cost,
    ...(version === null ? {} : { source_attribution_version: version }),
  });
  const since = Date.parse('2026-08-01T00:00:00.000Z');
  const asOf = Date.parse('2026-08-15T00:00:00.000Z');

  test('sums in-window v2 routine rows per id', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      row('routine:brief', '2026-08-02T00:00:00.000Z', 1),
      row('routine:brief', '2026-08-03T00:00:00.000Z', 2),
      row('routine:digest', '2026-08-03T00:00:00.000Z', 5),
    ]);
    const { perRoutine } = scanRoutineCostWindow(logPath, since, asOf);
    expect(perRoutine.get('brief')).toBe(3);
    expect(perRoutine.get('digest')).toBe(5);
  }));

  test('excludes out-of-window, v1, and non-routine rows', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      row('routine:brief', '2026-07-01T00:00:00.000Z', 100),   // before the window
      row('routine:brief', '2026-09-01T00:00:00.000Z', 100),   // after it
      row('routine:brief', '2026-08-02T00:00:00.000Z', 100, 1), // v1 attribution
      row('routine:brief', '2026-08-02T00:00:00.000Z', 100, null), // legacy, unstamped
      row('other', '2026-08-02T00:00:00.000Z', 100),
      row('heartbeat', '2026-08-02T00:00:00.000Z', 100),
    ]);
    const { perRoutine, multi } = scanRoutineCostWindow(logPath, since, asOf);
    expect(perRoutine.size).toBe(0);
    expect(multi).toBe(0);
  }));

  test('routine:multi is bucketed separately, never as a routine named multi', withTmpdir((dir) => {
    const logPath = writeLog(dir, [
      row('routine:multi', '2026-08-02T00:00:00.000Z', 4),
      row('routine:brief', '2026-08-02T00:00:00.000Z', 1),
    ]);
    const { perRoutine, multi } = scanRoutineCostWindow(logPath, since, asOf);
    expect(multi).toBe(4);
    expect(perRoutine.has('multi')).toBe(false);
    expect(perRoutine.get('brief')).toBe(1);
  }));

  test('corrupt lines and an absent log are survivable', withTmpdir((dir) => {
    const logPath = path.join(dir, 'cost-log.jsonl');
    fs.writeFileSync(logPath, '{bad\n' + JSON.stringify(row('routine:brief', '2026-08-02T00:00:00.000Z', 2)) + '\n');
    expect(scanRoutineCostWindow(logPath, since, asOf).perRoutine.get('brief')).toBe(2);
    expect(scanRoutineCostWindow('/nonexistent/cost-log.jsonl', since, asOf).perRoutine.size).toBe(0);
  }));
});
