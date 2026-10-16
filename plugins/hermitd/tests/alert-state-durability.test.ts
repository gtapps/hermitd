// Durability of alert-state.json against interrupted/concurrent writes (issue #463).
// Both writers (lib/heartbeat/precheck.ts, lib/heartbeat/alert-update.ts) must (a) write atomically
// via temp+rename so a killed write never leaves a truncated file, and (b) never reinit
// the skill-owned alerts{}/self_eval{} over a file that exists — a present-but-unparseable
// file is quarantined to alert-state.json.corrupt-<ts>, not silently overwritten.
//
// Scripts are exercised as subprocesses (via runScript) — the boundary hooks/routines see.
//
// Usage: bun test tests/alert-state-durability.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeItemKey } from '../scripts/lib/heartbeat-items';
import { runScript } from './helpers/run';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const alertPath = (dir: string) => hermit(dir, 'state', 'alert-state.json');
const stateFiles = (dir: string) => fs.readdirSync(hermit(dir, 'state'));

const HEARTBEAT_MD = '# Heartbeat\n\n- [ ] Check system\n';
const NOW = '2026-05-20T22:00:00+00:00';
const ITEM_KEY = normalizeItemKey(HEARTBEAT_MD.split('\n')[2])!;
const CORRUPT = '{"alerts":{"x":{"suppressed":true}},"self_eval":{"a":1},"total_ticks":686';

interface Tmp { dir: string; cleanup(): void }

function makeDir(): Tmp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-alertdur-'));
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  fs.writeFileSync(hermit(dir, 'HEARTBEAT.md'), HEARTBEAT_MD);
  // Full-day active hours: without a config.json the settled defaults
  // (08:00-23:00) would gate the tick by the real wall clock.
  fs.writeFileSync(hermit(dir, 'config.json'),
    '{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"24:00"}}}');
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const t = makeDir();
    try { await fn(t.dir); } finally { t.cleanup(); }
  };
}

/** Run heartbeat-precheck from inside the workdir, return verdict. */
async function precheck(dir: string, peek = false): Promise<string> {
  const r = await runScript('heartbeat.ts', {
    args: ['precheck', ...(peek ? ['--peek'] : []), '.hermit'],
    cwd: dir,
    env: { HERMIT_NOW: NOW },
  });
  return r.stdout.trim();
}

/** Run update-alert-state against the workdir's alert-state.json with a stdin payload. */
async function updateAlertState(dir: string, payload: object): Promise<void> {
  await runScript('heartbeat.ts', {
    args: ['alert-state', alertPath(dir)],
    stdin: JSON.stringify(payload),
  });
}

describe('heartbeat-precheck alert-state durability', () => {
  test('atomic write leaves a complete file and no .tmp sibling', withTmp(async (dir) => {
    fs.writeFileSync(alertPath(dir), JSON.stringify({ alerts: {}, last_digest_date: null, self_eval: {}, total_ticks: 5 }));

    await precheck(dir);

    const written = JSON.parse(fs.readFileSync(alertPath(dir), 'utf-8'));
    expect(written.total_ticks).toBe(6);
    expect(stateFiles(dir).some(f => f.endsWith('.tmp'))).toBe(false);
  }));

  test('present-but-corrupt file is quarantined, not wiped to total_ticks:1', withTmp(async (dir) => {
    fs.writeFileSync(alertPath(dir), CORRUPT);

    const verdict = await precheck(dir);

    expect(verdict).toBe('EVALUATE');
    // live file moved aside — never overwritten with a fresh total_ticks:1 object
    expect(fs.existsSync(alertPath(dir))).toBe(false);
    const backups = stateFiles(dir).filter(f => f.startsWith('alert-state.json.corrupt-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(hermit(dir, 'state', backups[0]), 'utf-8')).toBe(CORRUPT);
  }));

  test('--peek never quarantines or mutates a corrupt file', withTmp(async (dir) => {
    fs.writeFileSync(alertPath(dir), CORRUPT);

    const verdict = await precheck(dir, true);

    expect(verdict).toBe('EVALUATE');
    expect(fs.readFileSync(alertPath(dir), 'utf-8')).toBe(CORRUPT);
    expect(stateFiles(dir).some(f => f.startsWith('alert-state.json.corrupt-'))).toBe(false);
  }));

  // A transient read error (EACCES/EMFILE/EIO) on a HEALTHY file must NOT be treated as
  // corruption. Simulated portably by making the path a directory → readFileSync throws
  // EISDIR (works regardless of test UID, unlike chmod 000).
  test('transient read error (EISDIR) is not quarantined or reset', withTmp(async (dir) => {
    fs.mkdirSync(alertPath(dir));

    const verdict = await precheck(dir);

    expect(verdict).toBe('EVALUATE');
    expect(fs.statSync(alertPath(dir)).isDirectory()).toBe(true);
    expect(stateFiles(dir).some(f => f.startsWith('alert-state.json.corrupt-'))).toBe(false);
  }));

  test('non-object JSON is treated as corrupt, not crashed on', withTmp(async (dir) => {
    fs.writeFileSync(alertPath(dir), '5');

    const verdict = await precheck(dir);

    expect(verdict).toBe('EVALUATE');
    expect(fs.existsSync(alertPath(dir))).toBe(false);
    expect(stateFiles(dir).filter(f => f.startsWith('alert-state.json.corrupt-')).length).toBe(1);
  }));

  test('array JSON is treated as corrupt (not a valid state object)', withTmp(async (dir) => {
    fs.writeFileSync(alertPath(dir), '[]');

    const verdict = await precheck(dir);

    expect(verdict).toBe('EVALUATE');
    expect(fs.existsSync(alertPath(dir))).toBe(false);
    expect(stateFiles(dir).filter(f => f.startsWith('alert-state.json.corrupt-')).length).toBe(1);
  }));
});

describe('update-alert-state durability', () => {
  // Post-#594 contract: the eval subagent returns a `firing` set, not raw
  // alert entries — the script itself derives the entry shape (count,
  // consecutive_clean, suppressed, first_seen, last_seen, text).
  const FIRING = { firing: [{ key: ITEM_KEY, text: 'k fired' }], self_eval_updates: {} };

  test('quarantines a present-but-corrupt file instead of merging onto a blank state', withTmp(async (dir) => {
    fs.writeFileSync(alertPath(dir), CORRUPT);

    await updateAlertState(dir, FIRING);

    const backups = stateFiles(dir).filter(f => f.startsWith('alert-state.json.corrupt-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(hermit(dir, 'state', backups[0]), 'utf-8')).toBe(CORRUPT);

    const written = JSON.parse(fs.readFileSync(alertPath(dir), 'utf-8'));
    expect(written.alerts[ITEM_KEY]).toMatchObject({ count: 1, suppressed: false, text: 'k fired' });
  }));

  test('transient read error (EISDIR) declines to write, does not clobber', withTmp(async (dir) => {
    fs.mkdirSync(alertPath(dir));

    await updateAlertState(dir, FIRING);

    expect(fs.statSync(alertPath(dir)).isDirectory()).toBe(true);
    expect(stateFiles(dir).some(f => f.startsWith('alert-state.json.corrupt-'))).toBe(false);
  }));

  test('preserves precheck-owned total_ticks under atomic write, no .tmp leak', withTmp(async (dir) => {
    fs.writeFileSync(alertPath(dir), JSON.stringify({
      alerts: {}, last_digest_date: null, self_eval: { a: 1 }, total_ticks: 686, last_micro_corrupt_wake_at: '2026-05-19T00:00:00Z',
    }));

    // Off-boundary firing evidence is script-owned. A subagent that still emits
    // self_eval_updates cannot insert its own counters or entries.
    await updateAlertState(dir, { firing: [{ key: ITEM_KEY, text: 'k fired' }], self_eval_updates: { b: 2 } });

    const written = JSON.parse(fs.readFileSync(alertPath(dir), 'utf-8'));
    expect(written.total_ticks).toBe(686);
    expect(written.last_micro_corrupt_wake_at).toBe('2026-05-19T00:00:00Z');
    expect(written.self_eval).toEqual({ a: 1, [ITEM_KEY]: { fired_since_self_eval: true } });
    expect(written.alerts[ITEM_KEY]).toMatchObject({ count: 1, suppressed: false, text: 'k fired' });
    expect(stateFiles(dir).some(f => f.endsWith('.tmp'))).toBe(false);
  }));
});
