// Tests for `routines.ts tz-shift` — timezone-aware cron shifting
// (bun test port of cron-tz-shift.test.sh).
//
// Exercised as a subprocess (runScript): the machine timezone (TZ env, resolved
// via Intl in main()) and the pinned reference instant (HERMIT_CRON_TZ_SHIFT_NOW,
// parsed in main()) are process-level inputs, so the env-driven CLI is the
// genuine boundary — an in-process shiftCron() call would bypass exactly the
// plumbing these cases pin down.
//
// Usage: bun test tests/cron-tz-shift.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';

import { runScript } from './helpers/run';

const W = '2026-01-15T12:00:00Z'; // winter reference (Lisbon=UTC+0)
const S = '2026-07-15T12:00:00Z'; // summer reference (Lisbon=UTC+1)

const shift = (tz: string, now: string, cron: string, fromTz: string) =>
  runScript('routines.ts', {
    args: ['tz-shift', cron, fromTz],
    env: { TZ: tz, HERMIT_CRON_TZ_SHIFT_NOW: now },
  });

// checkStdout cases: exit 0, exact `cron`, no `warning`, and nothing on stderr.
// [name, expected-stdout, TZ, NOW, cron, from-tz]
const STDOUT_CASES: [string, string, string, string, string, string][] = [
  // --- No-shift cases ---
  ['winter no-shift Lisbon→UTC',     '0 4 * * *',    'UTC',           W, '0 4 * * *',    'Europe/Lisbon'],
  ['empty fromTz no-op',             '0 4 * * *',    'UTC',           S, '0 4 * * *',    ''],
  ['same TZ no-op',                  '0 4 * * *',    'Europe/Lisbon', S, '0 4 * * *',    'Europe/Lisbon'],
  ['hour=* passes through',          '*/15 * * * *', 'UTC',           S, '*/15 * * * *', 'Europe/Lisbon'],
  // --- Hour shifts (daily routines) ---
  ['summer 1h shift Lisbon→UTC',     '0 3 * * *',    'UTC',           S, '0 4 * * *',    'Europe/Lisbon'],
  ['summer NY→UTC (-4h)',            '0 13 * * *',   'UTC',           S, '0 9 * * *',    'America/New_York'],
  ['winter NY→UTC (-5h)',            '0 14 * * *',   'UTC',           W, '0 9 * * *',    'America/New_York'],
  // --- Fractional-offset zones ---
  ['Kolkata +5:30 → UTC',            '0 4 * * *',    'UTC',           S, '30 9 * * *',   'Asia/Kolkata'],
  ['Kathmandu +5:45 → UTC',          '0 4 * * *',    'UTC',           S, '45 9 * * *',   'Asia/Kathmandu'],
  ['Adelaide summer +10:30 → UTC',   '30 22 * * *',  'UTC',           W, '0 9 * * *',    'Australia/Adelaide'],
  // --- DOW shift ---
  ['DOW no wrap (23:00 Sun Lisbon→UTC summer)',      '0 22 * * 0', 'UTC', S, '0 23 * * 0', 'Europe/Lisbon'],
  ['DOW backward wrap (00:00 Sun Lisbon→UTC summer)', '0 23 * * 6', 'UTC', S, '0 0 * * 0',  'Europe/Lisbon'],
  // --- Multi-hour (list) that allows DOW=* shift ---
  ['multi-hour DOW=* allowed',       '0 11,23 * * *', 'UTC',          S, '0 0,12 * * *', 'Europe/Lisbon'],
  // --- Step patterns that survive shift ---
  ['*/2 step preserved after 1h shift', '0 1-23/2 * * *', 'UTC',      S, '0 */2 * * *',  'Europe/Lisbon'],
  ['hour range/step, shifted start off field-min', '0 8-23/6 * * *', 'UTC', S, '0 9-21/6 * * *', 'Europe/Lisbon'],
];

// checkWarn cases: exit 0, `cron` matches, `warning` is unshiftable_cron, `detail` contains the pattern.
// [name, expected-stdout, detail-pattern, TZ, NOW, cron, from-tz]
const WARN_CASES: [string, string, string, string, string, string, string][] = [
  ['DOM-restricted pass-through',     '0 4 1 * *',    'DOM',             'UTC', S, '0 4 1 * *',    'Europe/Lisbon'],
  ['mixed day-wrap DOW restricted',   '0 0,12 * * 0', 'mixed day-wrap',  'UTC', S, '0 0,12 * * 0', 'Europe/Lisbon'],
  ['step loses structure (*/7 +1h)',  '0 */7 * * *',  'step pattern',    'UTC', S, '0 */7 * * *',  'Europe/Lisbon'],
  ['invalid from-tz',                 '0 4 * * *',    'invalid from-tz', 'UTC', S, '0 4 * * *',    'Atlantic/Atlantis'],
];

describe('cron-tz-shift (shift + pass-through)', () => {
  for (const [name, expected, tz, now, cron, fromTz] of STDOUT_CASES) {
    test(name, async () => {
      const r = await shift(tz, now, cron, fromTz);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ cron: expected });
      expect(r.stderr.trim()).toBe('');
    });
  }
});

describe('cron-tz-shift (WARN pass-through)', () => {
  for (const [name, expected, pattern, tz, now, cron, fromTz] of WARN_CASES) {
    test(name, async () => {
      const r = await shift(tz, now, cron, fromTz);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.cron).toBe(expected);
      expect(out.warning).toBe('unshiftable_cron');
      expect(out.detail).toContain(pattern);
    });
  }
});

describe('cron-tz-shift (exit non-zero)', () => {
  test('malformed cron (not 5 fields)', async () => {
    const r = await shift('UTC', S, 'garbage', 'Europe/Lisbon');
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toStartWith('invalid_cron:');
  });

  test('bad HERMIT_CRON_TZ_SHIFT_NOW', async () => {
    const r = await shift('UTC', 'not-a-date', '0 4 * * *', 'Europe/Lisbon');
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_now' });
  });
});
