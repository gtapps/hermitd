// PROP-016 budget-enforcement tests for scripts/cost-tracker.ts: the model_unpriced
// marker and the end-to-end breach -> alert-state/pause.json write path.
//
// Subprocess tests (via runScript), same rationale as cost-tracker.test.ts: cost-tracker.ts
// resolves HERMIT_DIR from cwd at module load, so an in-process import from a shared test
// run would pollute the module cache across different tmp dirs.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { triggerPrompt, assistantEntryFor as assistantEntry } from './helpers/transcript';
import { writeConfig } from './helpers/workdir';

interface Setup {
  dir: string;
  logPath: string;
  cchDir: string;
}

function setup(config: object): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-budget-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const logPath = path.join(dir, '.claude', 'cost-log.jsonl');
  const cchDir = path.join(dir, '.hermit');
  fs.mkdirSync(path.join(cchDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(cchDir, 'state', 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));
  writeConfig(dir, config);
  return { dir, logPath, cchDir };
}

async function runTurn(dir: string, model: string, inputTokens: number, outputTokens: number): Promise<void> {
  const transcriptLines = [
    triggerPrompt('[hermit-routine:demo] start'),
    assistantEntry(model, inputTokens, outputTokens),
  ];
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');
  const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
  await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
}

describe('cost-tracker: model_unpriced marker', () => {
  let s: Setup;

  beforeAll(async () => {
    s = setup({ timezone: null });
    await runTurn(s.dir, 'claude-quasar-9-unknown', 1000, 500);
  });
  afterAll(() => { fs.rmSync(s.dir, { recursive: true }); });

  test('unrecognized model string is flagged model_unpriced:true, priced at sonnet', () => {
    const line = JSON.parse(fs.readFileSync(s.logPath, 'utf-8').trim().split('\n')[0]);
    expect(line.model).toBe('claude-quasar-9-unknown');
    expect(line.model_unpriced).toBe(true);
  });
});

describe('cost-tracker: recognized model is not flagged', () => {
  let s: Setup;

  beforeAll(async () => {
    s = setup({ timezone: null });
    await runTurn(s.dir, 'claude-sonnet-4-6', 1000, 500);
  });
  afterAll(() => { fs.rmSync(s.dir, { recursive: true }); });

  test('model_unpriced is false for a recognized model string', () => {
    const line = JSON.parse(fs.readFileSync(s.logPath, 'utf-8').trim().split('\n')[0]);
    expect(line.model_unpriced).toBe(false);
  });
});

describe('cost-tracker: budget breach with action:"pause"', () => {
  let s: Setup;

  beforeAll(async () => {
    // cost = (100000/1e6)*3 + (50000/1e6)*15 = 0.3 + 0.75 = 1.05 -> ratio 1.05 vs cap 1.0
    s = setup({ timezone: 'America/New_York', budget: { daily_usd: 1.0, weekly_usd: null, monthly_usd: null, action: 'pause' } });
    await runTurn(s.dir, 'claude-sonnet-4-6', 100000, 50000);
  });
  afterAll(() => { fs.rmSync(s.dir, { recursive: true }); });

  test('writes a budget-breach alert entry with notified:false', () => {
    const state = JSON.parse(fs.readFileSync(path.join(s.cchDir, 'state', 'budget-alerts.json'), 'utf-8'));
    const keys = Object.keys(state.alerts).filter(k => k.startsWith('budget-breach:daily:'));
    expect(keys).toHaveLength(1);
    const entry = state.alerts[keys[0]];
    expect(entry.kind).toBe('budget');
    expect(entry.level).toBe('breach');
    expect(entry.period).toBe('daily');
    expect(entry.action).toBe('pause');
    expect(entry.notified).toBe(false);
    expect(entry.cap).toBe(1.0);
  });

  test('sets state/auto-pause.json with reason:"budget" and a future paused_until', () => {
    const pause = JSON.parse(fs.readFileSync(path.join(s.cchDir, 'state', 'auto-pause.json'), 'utf-8'));
    expect(pause.paused).toBe(true);
    expect(pause.reason).toBe('budget');
    expect(pause.by).toBe('cost-tracker');
    expect(new Date(pause.paused_until).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('cost-tracker: budget warn (80-99%) with action:"alert" does not pause', () => {
  let s: Setup;

  beforeAll(async () => {
    // cost = (200000/1e6)*3 + (16000/1e6)*15 = 0.6 + 0.24 = 0.84 -> ratio 0.84 vs cap 1.0
    s = setup({ timezone: null, budget: { daily_usd: 1.0, weekly_usd: null, monthly_usd: null, action: 'alert' } });
    await runTurn(s.dir, 'claude-sonnet-4-6', 200000, 16000);
  });
  afterAll(() => { fs.rmSync(s.dir, { recursive: true }); });

  test('writes a budget-warn alert entry, not a breach', () => {
    const state = JSON.parse(fs.readFileSync(path.join(s.cchDir, 'state', 'budget-alerts.json'), 'utf-8'));
    const warnKeys = Object.keys(state.alerts).filter(k => k.startsWith('budget-warn:daily:'));
    const breachKeys = Object.keys(state.alerts).filter(k => k.startsWith('budget-breach:daily:'));
    expect(warnKeys).toHaveLength(1);
    expect(breachKeys).toHaveLength(0);
  });

  test('does not write auto-pause.json', () => {
    expect(fs.existsSync(path.join(s.cchDir, 'state', 'auto-pause.json'))).toBe(false);
  });
});

describe('cost-tracker: dedup — a second Stop within the same day does not reset notified', () => {
  let s: Setup;

  beforeAll(async () => {
    s = setup({ timezone: null, budget: { daily_usd: 1.0, weekly_usd: null, monthly_usd: null, action: 'alert' } });
    await runTurn(s.dir, 'claude-sonnet-4-6', 100000, 50000); // breach #1
    // Simulate the heartbeat skill having already announced it.
    const alertPath = path.join(s.cchDir, 'state', 'budget-alerts.json');
    const state = JSON.parse(fs.readFileSync(alertPath, 'utf-8'));
    const key = Object.keys(state.alerts).find(k => k.startsWith('budget-breach:daily:'))!;
    state.alerts[key].notified = true;
    fs.writeFileSync(alertPath, JSON.stringify(state));
    await runTurn(s.dir, 'claude-sonnet-4-6', 100000, 50000); // breach #2, same day
  });
  afterAll(() => { fs.rmSync(s.dir, { recursive: true }); });

  test('the existing entry is left untouched (still notified:true, not overwritten)', () => {
    const state = JSON.parse(fs.readFileSync(path.join(s.cchDir, 'state', 'budget-alerts.json'), 'utf-8'));
    const keys = Object.keys(state.alerts).filter(k => k.startsWith('budget-breach:daily:'));
    expect(keys).toHaveLength(1); // still exactly one entry for the day — no duplicate key
    expect(state.alerts[keys[0]].notified).toBe(true);
  });
});

describe('cost-tracker: inert budget block (all caps null) writes no alert', () => {
  let s: Setup;

  beforeAll(async () => {
    s = setup({ timezone: null, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null, action: 'alert' } });
    await runTurn(s.dir, 'claude-sonnet-4-6', 100000, 50000);
  });
  afterAll(() => { fs.rmSync(s.dir, { recursive: true }); });

  test('no budget-alerts.json is written at all', () => {
    expect(fs.existsSync(path.join(s.cchDir, 'state', 'budget-alerts.json'))).toBe(false);
  });
});

describe('cost-tracker: budget breach does not clobber a stronger operator pause', () => {
  let s: Setup;

  beforeAll(async () => {
    s = setup({ timezone: null, budget: { daily_usd: 1.0, weekly_usd: null, monthly_usd: null, action: 'pause' } });
    // Operator has already issued an indefinite hard stop (PROP-015).
    fs.writeFileSync(path.join(s.cchDir, 'state', 'pause.json'), JSON.stringify({
      paused: true, paused_until: null, reason: 'operator', by: 'operator', ts: '2026-07-04T12:00:00Z',
    }));
    await runTurn(s.dir, 'claude-sonnet-4-6', 100000, 50000); // breaches the $1 daily cap
  });
  afterAll(() => { fs.rmSync(s.dir, { recursive: true }); });

  test('the operator pause is left intact (still indefinite, reason:"operator")', () => {
    const pause = JSON.parse(fs.readFileSync(path.join(s.cchDir, 'state', 'pause.json'), 'utf-8'));
    expect(pause.reason).toBe('operator');
    expect(pause.paused_until).toBeNull();
  });

  test('the breach is still recorded as an alert (so it can be announced)', () => {
    const state = JSON.parse(fs.readFileSync(path.join(s.cchDir, 'state', 'budget-alerts.json'), 'utf-8'));
    expect(Object.keys(state.alerts).filter(k => k.startsWith('budget-breach:daily:'))).toHaveLength(1);
  });
});

describe('cost-tracker: stale budget alert entries from prior periods are reaped', () => {
  let s: Setup;

  beforeAll(async () => {
    s = setup({ timezone: null, budget: { daily_usd: 1.0, weekly_usd: null, monthly_usd: null, action: 'alert' } });
    // Seed a leftover alert from a long-past day that nothing ever removed.
    fs.writeFileSync(path.join(s.cchDir, 'state', 'budget-alerts.json'), JSON.stringify({
      alerts: {
        'budget-breach:daily:2020-01-01': { kind: 'budget', level: 'breach', period: 'daily', action: 'alert', spend: 9, cap: 1, ratio: 9, notified: true, ts: '2020-01-01T00:00:00Z' },
      },
      last_digest_date: null, self_eval: {}, total_ticks: 3,
    }));
    await runTurn(s.dir, 'claude-sonnet-4-6', 100000, 50000); // breach today
  });
  afterAll(() => { fs.rmSync(s.dir, { recursive: true }); });

  test('the past-period entry is dropped, today\'s entry remains', () => {
    const state = JSON.parse(fs.readFileSync(path.join(s.cchDir, 'state', 'budget-alerts.json'), 'utf-8'));
    const keys = Object.keys(state.alerts).filter(k => k.startsWith('budget-'));
    expect(keys.some(k => k.endsWith(':2020-01-01'))).toBe(false);
    expect(keys.filter(k => k.startsWith('budget-breach:daily:'))).toHaveLength(1);
  });
});

describe('cost-tracker: --mark-budget-notified', () => {
  test('flips notified on the named entry and prints OK', async () => {
    const s = setup({ timezone: null });
    try {
      const file = path.join(s.cchDir, 'state', 'budget-alerts.json');
      fs.writeFileSync(file, JSON.stringify({ alerts: { 'budget-breach:daily:2026-10-17': { kind: 'budget', notified: false } } }));
      const r = await runScript('cost-tracker.ts', { args: ['--mark-budget-notified', 'budget-breach:daily:2026-10-17'], cwd: s.dir });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('OK\n');
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).alerts['budget-breach:daily:2026-10-17'].notified).toBe(true);
    } finally {
      fs.rmSync(s.dir, { recursive: true });
    }
  });
});
