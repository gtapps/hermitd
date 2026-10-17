// Unit tests for proposal.ts's success-signal verb (bun test port of test-eval-success-signal.sh).
// Validate mode (grammar) and evaluate mode (MET / UNMET / INSUFFICIENT_DATA).
//
// The script is a CLI contract (argv in, process.exit + one-line JSON on stdout,
// nothing exported) — exercised as a subprocess via runScript. The bash suite's
// inline `bun -e` JSON probes are replaced by JSON.parse of stdout.
//
// Usage: bun test tests/eval-success-signal.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runScript, runProposal, SCRIPTS_DIR } from './helpers/run';
import { costLogPath } from '../scripts/lib/cc-compat';
import { costIndexPath, updateCostIndex } from '../scripts/lib/cost-log';

// ---------- helpers ----------

const validate = (predicate: string) =>
  runScript('proposal.ts', { args: ['success-signal', '--validate', predicate] });

/** Validate-mode rejection: exit 0 (an expected answer), the reason token. */
async function invalidReason(predicate: string) {
  const r = await validate(predicate);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.status).toBe('invalid');
  return out.reason;
}

/** Run a test body with a throwaway .hermit state dir (sessions/ pre-made). */
function withStateDir(fn: (sdir: string) => Promise<void> | void, subdir = 'sessions') {
  return async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-eval-'));
    const sdir = path.join(workdir, '.hermit');
    fs.mkdirSync(path.join(sdir, subdir), { recursive: true });
    try {
      await fn(sdir);
    } finally {
      recordIds.delete(sdir);
      try { fs.rmSync(workdir, { recursive: true }); } catch {}
    }
  };
}

const recordIds = new Map<string, Map<string, string>>();

/** Seed historical records exclusively through task.ts, with an isolated subprocess clock. */
function writeReport(sdir: string, label: string, date: string, cost: string) {
  const clock = path.join(sdir, 'clock.js');
  fs.writeFileSync(clock, `
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [process.env.TASK_FIXTURE_DATE])); }
  static now() { return new RealDate(process.env.TASK_FIXTURE_DATE).getTime(); }
};
`);
  const task = (verb: string, args: string[], input = '') => {
    const result = spawnSync(process.execPath, ['--preload', clock, path.join(SCRIPTS_DIR, 'task.ts'), verb, sdir, ...args], {
      cwd: path.dirname(sdir),
      env: { ...process.env, AGENT_DIR: sdir, CLAUDE_PROJECT_DIR: path.dirname(sdir), TASK_FIXTURE_DATE: date },
      input, encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  };
  const record = task('open', ['--title', label, '--requester', 'operator', '--done', 'Verified']);
  const blocked = task('block', [record.id, '--result-stdin'], 'Test result');
  task('close', [record.id, '--by', 'confirmed', '--actor', 'operator', '--result-rev', String(blocked.result_rev), '--reason-stdin'], 'Verified');
  let ids = recordIds.get(sdir);
  if (!ids) { ids = new Map(); recordIds.set(sdir, ids); }
  ids.set(label, record.id);
  const log = costLogPath(sdir);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({
    timestamp: date, bucket: 'tasks', task_id: record.id,
    estimated_cost_usd: Number(cost), total_tokens: 10000,
  }) + '\n');
  updateCostIndex(log, costIndexPath(sdir));
}

/** Evaluate-mode run; asserts exit 0 and returns the parsed JSON verdict line. */
async function evaluate(sdir: string, acceptedDate: string, acceptedInSession: string, predicate: string) {
  const r = await runProposal(sdir, ['success-signal', acceptedDate, recordIds.get(sdir)?.get(acceptedInSession) ?? acceptedInSession, predicate]);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

// -------------------------------------------------------
// Validate mode
// -------------------------------------------------------

describe('validate mode', () => {
  test('validate: canonical predicate accepted', async () => {
    expect((await validate('avg_session_cost_usd < 0.30 over 10 sessions')).stdout).toBe('OK\n');
  });

  test('validate: <= op accepted', async () => {
    expect((await validate('avg_session_cost_usd <= 0.50 over 5 sessions')).stdout).toBe('OK\n');
  });

  test('validate: > op accepted', async () => {
    expect((await validate('avg_session_cost_usd > 0.10 over 3 sessions')).stdout).toBe('OK\n');
  });

  test('validate: >= op accepted', async () => {
    expect((await validate('avg_session_cost_usd >= 0.05 over 1 session')).stdout).toBe('OK\n');
  });

  test('validate: integer threshold accepted', async () => {
    expect((await validate('avg_session_cost_usd < 1 over 7 sessions')).stdout).toBe('OK\n');
  });

  test('validate: bad op rejected', async () => {
    expect(await invalidReason('avg_session_cost_usd ~ 0.30 over 10 sessions')).toBeString();
  });

  test('validate: bad op prints reason', async () => {
    expect(await invalidReason('avg_session_cost_usd ~ 0.30 over 10 sessions')).toBe('invalid_grammar');
  });

  test('validate: unsupported metric rejected', async () => {
    expect(await invalidReason('total_tokens < 1000 over 5 sessions')).toBeString();
  });

  test('validate: unsupported metric prints reason', async () => {
    expect(await invalidReason('total_tokens < 1000 over 5 sessions')).toBe('unsupported_metric:total_tokens');
  });

  test("validate: missing 'over N sessions' rejected", async () => {
    expect(await invalidReason('avg_session_cost_usd < 0.30')).toBeString();
  });

  test('validate: missing window number rejected', async () => {
    expect(await invalidReason('avg_session_cost_usd < 0.30 over sessions')).toBeString();
  });
});

// -------------------------------------------------------
// Evaluate mode
// -------------------------------------------------------

describe('evaluate mode', () => {
  test('evaluate: INSUFFICIENT_DATA when fewer sessions than window', withStateDir(async (sdir) => {
    // 3 sessions post-accept, window = 5 → not enough
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.22');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.18');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 5 sessions');
    expect(d.status).toBe('insufficient_data');
  }));

  test('evaluate: sessions_counted in INSUFFICIENT_DATA output', withStateDir(async (sdir) => {
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 5 sessions');
    expect(d.sessions_counted).toBe(1);
  }));

  test('evaluate: MET when avg < threshold', withStateDir(async (sdir) => {
    // avg = (0.20+0.22+0.18+0.19+0.21) / 5 = 0.20 < 0.30
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.22');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.18');
    writeReport(sdir, 'S-004', '2026-05-04T10:00:00Z', '0.19');
    writeReport(sdir, 'S-005', '2026-05-05T10:00:00Z', '0.21');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 5 sessions');
    expect(d.status).toBe('met');
  }));

  test('evaluate: observed value in MET output', withStateDir(async (sdir) => {
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.observed).toBe(0.2);
  }));

  test('evaluate: UNMET when avg >= threshold (< op)', withStateDir(async (sdir) => {
    // avg = 0.40 which is NOT < 0.30
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.40');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.40');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.40');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.status).toBe('unmet');
  }));

  test('evaluate: accepted_in_session excluded from window', withStateDir(async (sdir) => {
    // S-001 is the implementation session (high cost); S-002..S-004 are under threshold.
    // If S-001 were included, avg would be (1.50+0.20+0.20+0.20)/4 = 0.525 → UNMET.
    // With exclusion, avg = (0.20+0.20+0.20)/3 = 0.20 → MET.
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '1.50');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.20');
    writeReport(sdir, 'S-004', '2026-05-04T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'S-001', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.status).toBe('met');
  }));

  test('evaluate: sessions before accepted_date excluded', withStateDir(async (sdir) => {
    // S-001 is before accepted_date and should be excluded.
    // Only S-002..S-003 are valid (< 3 needed) → INSUFFICIENT_DATA.
    writeReport(sdir, 'S-001', '2026-04-01T10:00:00Z', '0.10');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-05-01T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.status).toBe('insufficient_data');
  }));

  test('evaluate: frozen session reports are ignored', withStateDir(async (sdir) => {
    // Legacy archives are never inputs to task evaluation.
    fs.writeFileSync(path.join(sdir, 'sessions', 'S-BAD-REPORT.md'), 'not a frontmatter file\n');
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.20');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    // The frozen archive cannot affect task evaluation.
    expect(d.status).toBe('met');
  }));

  test('evaluate: missing tasks dir returns INSUFFICIENT_DATA (not crash)', withStateDir(async (sdir) => {
    // No tasks/ directory (only state/ exists).
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.status).toBe('insufficient_data');
  }, 'state'));

  test('evaluate: cost_usd=0 sessions excluded (no spurious MET)', withStateDir(async (sdir) => {
    // cost_usd defaults to 0.00 when the cost-tracker hook is inactive. Three
    // such sessions must NOT satisfy "< 0.30" — they are unrecorded, not $0.
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.00');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.00');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.00');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.status).toBe('insufficient_data');
  }));

  test('evaluate: unrecorded sessions skipped, recorded ones still count', withStateDir(async (sdir) => {
    // Two unrecorded + three recorded → window of 3 fills from the recorded ones.
    writeReport(sdir, 'S-001', '2026-05-01T10:00:00Z', '0.00');
    writeReport(sdir, 'S-002', '2026-05-02T10:00:00Z', '0.20');
    writeReport(sdir, 'S-003', '2026-05-03T10:00:00Z', '0.00');
    writeReport(sdir, 'S-004', '2026-05-04T10:00:00Z', '0.20');
    writeReport(sdir, 'S-005', '2026-05-05T10:00:00Z', '0.20');
    const d = await evaluate(sdir, '2026-04-30T00:00:00Z', 'null', 'avg_session_cost_usd < 0.30 over 3 sessions');
    expect(d.status).toBe('met');
    expect(d.sessions_counted).toBe(3);
    expect(d.observed).toBe(0.2);
  }));
});
