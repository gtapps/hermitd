// Unit tests for scripts/lib/cron.ts: hermit's numeric 5-field dialect evaluated by
// Bun.cron.parse in a target timezone, plus the config-validation gate around it.
//
// Usage: bun test tests/cron.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import { nextFire, latestFires } from '../scripts/lib/cron';
import { validate, validateCronSchedule } from '../scripts/validate-config';

const iso = (dates: Date[]) => dates.map(d => d.toISOString());
const at = (s: string) => new Date(s);

describe('nextFire', () => {
  test('first fire strictly after `after`', () => {
    expect(nextFire('0 9 * * *', 'UTC', at('2026-10-07T08:59:30Z'))?.toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(nextFire('0 9 * * *', 'UTC', at('2026-10-07T09:00:00Z'))?.toISOString()).toBe('2026-10-08T09:00:00.000Z');
  });

  test('evaluates in the target timezone', () => {
    expect(nextFire('0 9 * * *', 'America/New_York', at('2026-10-07T00:00:00Z'))?.toISOString()).toBe('2026-10-07T13:00:00.000Z');
  });

  test('null tz is machine-local', () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const from = at('2026-07-15T12:00:00Z');
    expect(nextFire('30 9 * * *', null, from)).toEqual(nextFire('30 9 * * *', local, from));
  });

  test('DOW 7 is Sunday', () => {
    expect(nextFire('0 9 * * 7', 'UTC', at('2026-10-07T00:00:00Z'))?.toISOString()).toBe('2026-10-11T09:00:00.000Z');
  });

  test('unknown timezone fails closed', () => {
    expect(nextFire('0 9 * * *', 'Bogus/Zone', at('2026-10-07T00:00:00Z'))).toBeNull();
  });

  test('schedules outside the numeric dialect never fire', () => {
    for (const s of ['0 9 * * MON', '@daily', '0 9 13 * 5', '0 9 * *', '*/0 * * * *']) {
      expect(nextFire(s, 'UTC', at('2026-10-07T00:00:00Z'))).toBeNull();
    }
  });

  test('a valid schedule with no matching date returns null', () => {
    expect(nextFire('0 0 31 2 *', 'UTC', at('2026-10-07T00:00:00Z'))).toBeNull();
  });
});

describe('latestFires', () => {
  test('window is (from, until] and keeps the latest `count`, oldest first', () => {
    const from = at('2026-10-07T00:00:00Z');
    const until = at('2026-10-07T01:00:00Z');
    expect(iso(latestFires('*/15 * * * *', 'UTC', from, until, 2))).toEqual(['2026-10-07T00:45:00.000Z', '2026-10-07T01:00:00.000Z']);
    expect(latestFires('*/15 * * * *', 'UTC', from, until, 10)).toHaveLength(4);
    expect(latestFires('0 3 * * *', 'UTC', from, until, 1)).toEqual([]);
  });

  test('invalid schedule or unknown timezone yields nothing', () => {
    const from = at('2026-10-07T00:00:00Z');
    const until = at('2026-10-08T00:00:00Z');
    expect(latestFires('not a cron', 'UTC', from, until, 1)).toEqual([]);
    expect(latestFires('0 9 * * *', 'Bogus/Zone', from, until, 1)).toEqual([]);
  });
});

describe('DST transitions', () => {
  const day = (s: string, tz: string, from: string, until: string) => iso(latestFires(s, tz, at(from), at(until), 10));

  test('spring-forward: a time inside the skipped hour fires one hour later', () => {
    // Europe/London 2026-03-29: 01:00 GMT jumps to 02:00 BST; 01:30 fires at 02:30 BST.
    expect(day('30 1 * * *', 'Europe/London', '2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z')).toEqual(['2026-03-29T01:30:00.000Z']);
    // America/New_York 2026-03-08: 02:00 EST jumps to 03:00 EDT; 02:30 fires at 03:30 EDT.
    expect(day('30 2 * * *', 'America/New_York', '2026-03-07T12:00:00Z', '2026-03-08T12:00:00Z')).toEqual(['2026-03-08T07:30:00.000Z']);
  });

  test('fall-back: the repeated hour fires once', () => {
    expect(day('30 1 * * *', 'Europe/London', '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z')).toEqual(['2026-10-25T00:30:00.000Z']);
    expect(day('30 1 * * *', 'America/New_York', '2026-10-31T12:00:00Z', '2026-11-01T12:00:00Z')).toEqual(['2026-11-01T05:30:00.000Z']);
  });
});

describe('schedule validation', () => {
  test('numeric-only dialect: names, macros and DOM+DOW both restricted are rejected', () => {
    expect(validateCronSchedule('0 9 * * MON')).toMatch(/named values/);
    expect(validateCronSchedule('0 9 * JAN *')).toMatch(/named values/);
    expect(validateCronSchedule('@daily')).toMatch(/macros/);
    expect(validateCronSchedule('0 9 13 * 5')).toMatch(/both DOM and DOW/);
    expect(validateCronSchedule('0 9 1-7 * 1')).toMatch(/both DOM and DOW/);
    expect(validateCronSchedule('0 9 * * 1-5')).toBeNull();
  });

  test('forms Bun.cron.parse rejects are rejected, not accepted and silently never fired', () => {
    for (const s of ['1-2-3 * * * *', '1/2/3 * * * *', '5.0 * * * *', '-5 * * * *']) {
      expect(validateCronSchedule(s)).not.toBeNull();
    }
  });

  test('a valid schedule that never fires is a warning, not an error', () => {
    const r = validate({
      routines: [{ id: 'leap', skill: '/x', schedule: '0 0 31 2 *', enabled: true }],
      backup: { enabled: false, schedule: '0 0 30 2 *' },
    });
    expect(r.errors.some(e => e.includes('0 0 31 2 *') || e.includes('0 0 30 2 *'))).toBe(false);
    expect(r.warnings.some(w => w.includes('routines[0]') && w.includes('never fires'))).toBe(true);
    expect(r.warnings.some(w => w.startsWith('backup.schedule') && w.includes('never fires'))).toBe(true);
  });
});
