// Tests for `routines.ts cron-registry` — the diff-based plan/commit planner behind
// hermit-routines `load`. planCron/commitCron are pure (no fs, no Date.now()), so
// these are in-process unit tests, not subprocess runs — the real boundary
// (reading config.json/the mirror file, writing the mirror) is exercised by the
// CLI wiring, which the hermit-routines content-contract tests below pin at the
// SKILL.md-prose level instead of re-implementing a fs harness here.
//
// Coverage mirrors the acceptance criteria from the audit-driven design: unchanged
// config is a no-op; a metadata/schedule edit forces exactly that routine's
// delete+create; a boot-id mismatch or missing/corrupt mirror treats every enabled
// routine as needing (re-)creation with NO deletes (durable:false crons already
// died with the prior process); an entry aged past the conservative re-register
// threshold is recreated even with unchanged config, so a long-lived process can
// never silently ride a routine past CC's real 7-day auto-expiry cliff.

import { describe, test, expect } from 'bun:test';
import { planCron, commitCron, computeWakeSpread, promptHash, REREGISTER_AGE_MS, filterRoutinesByIds } from '../scripts/lib/routines/registry';
import { shiftCron } from '../scripts/lib/cron-shift';

const PLUGIN_ROOT = '/plugin';
const BOOT_A = 'boot-aaa';
const T0 = Date.parse('2026-06-01T00:00:00Z');

function r(id: string, overrides: Record<string, any> = {}) {
  return { id, skill: `hermitd:${id}`, schedule: '0 9 * * *', enabled: true, ...overrides };
}

function seedMirror(routines: any[], schedules: Record<string, string>, registeredAt: number, bootId = BOOT_A) {
  const entries: Record<string, any> = {};
  for (const routine of routines) {
    entries[routine.id] = {
      prompt_hash: promptHash(routine, schedules[routine.id] ?? routine.schedule, PLUGIN_ROOT),
      registered_at: registeredAt,
    };
  }
  return { boot_id: bootId, routines: entries };
}

describe('planCron — unchanged / fresh', () => {
  test('unchanged config, matching boot id, all fresh → KEEP everything, no mutations', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000);
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(2);
  });

  test('boot id mismatch → every enabled routine is CREATE, no DELETE', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000, 'boot-old');
    const plan = planCron(routines, mirror, 'boot-new', PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(plan.keepCount).toBe(0);
  });

  test('missing/corrupt mirror (boot_id null, empty routines) → all CREATE, no DELETE', () => {
    const routines = [r('a'), r('b')];
    const emptyMirror = { boot_id: null, routines: {} };
    const plan = planCron(routines, emptyMirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(plan.keepCount).toBe(0);
  });

  test('--force (load --reset) → all CREATE, no DELETE, even with a matching fresh mirror', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000);
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0, /* forceReset */ true);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(plan.keepCount).toBe(0);
  });
});

describe('planCron — targeted changes', () => {
  test('one routine edited (skill changed) → exactly that id DELETE+CREATE, the other KEEPs', () => {
    const before = [r('a'), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a', { skill: 'hermitd:a-renamed' }), r('b')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(1);
  });

  // In fallback mode the wake gate runs from the CronCreate prompt, so a changed
  // precheck has to re-register that prompt like any other execution input.
  test('precheck added → exactly that id DELETE+CREATE', () => {
    const before = [r('a'), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a', { precheck: 'tools/gate.sh' }), r('b')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(1);
  });

  test('precheck_timeout_s changed → exactly that id DELETE+CREATE', () => {
    const before = [r('a', { precheck: 'tools/gate.sh', precheck_timeout_s: 30 }), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a', { precheck: 'tools/gate.sh', precheck_timeout_s: 90 }), r('b')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(1);
  });

  test('effort changed → exactly that id DELETE+CREATE; an unset effort keeps the hash', () => {
    const before = [r('a', { model: 'haiku' }), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    expect(planCron(before, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0).deletes).toEqual([]);
    const after = [r('a', { model: 'haiku', effort: 'high' }), r('b')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(1);
  });

  // expect_artifact is embedded in the fallback CronCreate prompt, so it has to
  // be part of the hash — otherwise adding or editing a contract leaves the old
  // prompt registered indefinitely.
  test('expect_artifact added → exactly that id DELETE+CREATE', () => {
    const before = [r('a'), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a', { expect_artifact: 'raw/snapshot-{date}.md' }), r('b')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(1);
  });

  test('expect_artifact changed → exactly that id DELETE+CREATE', () => {
    const before = [r('a', { expect_artifact: 'raw/old-{date}.md' }), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a', { expect_artifact: 'raw/new-{date}.md' }), r('b')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
  });

  test('expect_artifact removed → exactly that id DELETE+CREATE', () => {
    const before = [r('a', { expect_artifact: 'raw/snapshot-{date}.md' }), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a'), r('b')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
  });

  test('routine removed from config → DELETE only, no matching CREATE', () => {
    const before = [r('a'), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['b']);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(1);
  });

  test('routine disabled (enabled:false) → treated same as removed: DELETE only', () => {
    const before = [r('a'), r('b')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a'), r('b', { enabled: false })];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['b']);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(1);
  });

  test('routine added to config → CREATE only, others KEEP', () => {
    const before = [r('a')];
    const mirror = seedMirror(before, {}, T0 - 1000);
    const after = [r('a'), r('c')];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates.map(c => c.id)).toEqual(['c']);
    expect(plan.keepCount).toBe(1);
  });

  test('entry aged past REREGISTER_AGE_MS → DELETE+CREATE even with unchanged config', () => {
    const routines = [r('a'), r('b')];
    const freshMirror = seedMirror(routines, {}, T0 - 1000);
    const staleAt = T0 - REREGISTER_AGE_MS - 1000;
    const mirror = { ...freshMirror, routines: { ...freshMirror.routines, a: { ...freshMirror.routines.a, registered_at: staleAt } } };
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(1);
  });

  test('entry just under the age threshold → still KEEP', () => {
    const routines = [r('a')];
    const freshEnoughAt = T0 - REREGISTER_AGE_MS + 60_000; // 1 minute inside the window
    const mirror = seedMirror(routines, {}, freshEnoughAt);
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(1);
  });

  test('duplicate enabled ids in config register once, not twice', () => {
    const routines = [r('a'), r('a')]; // config foot-gun — validate-config only warns on dup ids
    const mirror = { boot_id: null, routines: {} };
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.creates.map(c => c.id)).toEqual(['a']); // a single CREATE, not a duplicate live cron
  });

  test('malformed mirror entry (non-finite registered_at) fails safe to re-register, not KEEP', () => {
    const routines = [r('a')];
    const mirror = {
      boot_id: BOOT_A,
      routines: { a: { prompt_hash: promptHash(r('a'), '0 9 * * *', PLUGIN_ROOT), registered_at: NaN } },
    };
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates.map(c => c.id)).toEqual(['a']);
    expect(plan.keepCount).toBe(0);
  });

  test('DST-driven schedule shift changes the hash → DELETE+CREATE despite a fresh registered_at', () => {
    // Reuses the Europe/Lisbon fixture from cron-tz-shift.test.ts: winter Lisbon=UTC+0
    // (no shift), summer Lisbon=UTC+1 (1h shift) — the same schedule/tz pair produces
    // two different registered crons depending on which instant `load` runs at.
    const winter = Date.parse('2026-01-15T12:00:00Z');
    const summer = Date.parse('2026-07-15T12:00:00Z');
    const routine = r('a', { schedule: '0 4 * * *' });
    const winterShift = shiftCron('0 4 * * *', 'Europe/Lisbon', 'UTC', new Date(winter)).result;
    const summerShift = shiftCron('0 4 * * *', 'Europe/Lisbon', 'UTC', new Date(summer)).result;
    expect(winterShift).not.toBe(summerShift); // sanity: this pair actually shifts across the transition

    const mirror = {
      boot_id: BOOT_A,
      routines: { a: { prompt_hash: promptHash(routine, winterShift, PLUGIN_ROOT), registered_at: summer - 1000 } },
    };
    const plan = planCron([routine], mirror, BOOT_A, PLUGIN_ROOT, 'Europe/Lisbon', 'UTC', summer);
    expect(plan.deletes).toEqual(['a']);
    expect(plan.creates).toEqual([{ id: 'a', schedule: summerShift, warn: undefined }]);
    expect(plan.keepCount).toBe(0);
  });
});

describe('commitCron', () => {
  test('created ids are stamped with now + the new boot id', () => {
    const routines = [r('a')];
    const mirror = { boot_id: 'boot-old', routines: {} };
    const plan = planCron(routines, mirror, 'boot-new', PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(routines.map(x => [x.id, x]));
    const next = commitCron(mirror, plan, new Set(['a']), routineById, PLUGIN_ROOT, 'boot-new', T0);
    expect(next.boot_id).toBe('boot-new');
    expect(next.routines.a.registered_at).toBe(T0);
    expect(next.routines.a.prompt_hash).toBe(promptHash(routines[0], plan.creates[0].schedule, PLUGIN_ROOT));
  });

  test('KEEP entries carry forward with registered_at unchanged (not restamped)', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000);
    const after = [r('a'), r('b', { skill: 'hermitd:b-renamed' })];
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(after.map(x => [x.id, x]));
    const next = commitCron(mirror, plan, new Set(['b']), routineById, PLUGIN_ROOT, BOOT_A, T0);
    expect(next.routines.a).toEqual(mirror.routines.a); // untouched KEEP entry, byte-identical
  });

  test('a plan.creates id absent from createdIds (failed CronCreate) is not recorded', () => {
    const routines = [r('a'), r('b')];
    const mirror = { boot_id: 'boot-old', routines: {} };
    const plan = planCron(routines, mirror, 'boot-new', PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(routines.map(x => [x.id, x]));
    // Only 'a' actually succeeded; 'b's CronCreate threw.
    const next = commitCron(mirror, plan, new Set(['a']), routineById, PLUGIN_ROOT, 'boot-new', T0);
    expect(next.routines.a).toBeDefined();
    expect(next.routines.b).toBeUndefined(); // stays missing → next plan() sees it as CREATE again
  });

  test('boot-mismatch commit drops a prior-boot entry not created this boot (no ghost KEEP)', () => {
    // Prior boot had {a (still enabled), x (disabled/removed while down)}. After a restart
    // the bootMismatch plan CREATEs only the enabled set and issues NO deletes, so commit
    // must not resurrect x — else a later boot-match load would misread x as a live KEEP
    // although its durable:false cron died with the prior process and was never recreated.
    const priorMirror = {
      boot_id: 'boot-old',
      routines: {
        a: { prompt_hash: promptHash(r('a'), '0 9 * * *', PLUGIN_ROOT), registered_at: T0 - 1000 },
        x: { prompt_hash: promptHash(r('x'), '0 9 * * *', PLUGIN_ROOT), registered_at: T0 - 1000 },
      },
    };
    const enabled = [r('a')];
    const plan = planCron(enabled, priorMirror, 'boot-new', PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(enabled.map(x => [x.id, x]));
    const next = commitCron(priorMirror, plan, new Set(['a']), routineById, PLUGIN_ROOT, 'boot-new', T0);
    expect(next.routines.x).toBeUndefined(); // ghost not carried forward
    expect(next.routines.a).toBeDefined();
    expect(next.routines.a.registered_at).toBe(T0); // recreated this boot, freshly stamped
  });

  test('a DELETE id is dropped from the mirror', () => {
    const routines = [r('a'), r('b')];
    const mirror = seedMirror(routines, {}, T0 - 1000);
    const after = [r('a')]; // 'b' removed
    const plan = planCron(after, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(after.map(x => [x.id, x]));
    const next = commitCron(mirror, plan, new Set([]), routineById, PLUGIN_ROOT, BOOT_A, T0);
    expect(next.routines.b).toBeUndefined();
    expect(next.routines.a).toEqual(mirror.routines.a); // 'a' was an untouched KEEP
  });
});

// -------------------------------------------------------
// computeWakeSpread — the wake-clustering lint (audit §7 PR-8). Pure over already
// -shifted schedules, so tested in-process like planCron/commitCron above.
// -------------------------------------------------------
describe('computeWakeSpread — wake-clustering lint', () => {
  // Same schedules as state-templates/config.json.template's default routines.
  const STOCK = [
    { id: 'heartbeat-restart', schedule: '0 4 * * *' },
    { id: 'reflect', schedule: '0 9 * * *' },
    { id: 'scheduled-checks', schedule: '5 9 * * *' },
    { id: 'weekly-review', schedule: '0 23 * * 0' },
    { id: 'daily-auto-close', schedule: '0 0 * * *' },
    { id: 'doctor', schedule: '0 10 * * 1' },
  ];

  test('stock template config → null (5 distinct windows, under the default 6)', () => {
    // windows: 04:00→8, 09:00 & 09:05→18, 23:00→46, 00:00→0, 10:00→20 = {0,8,18,20,46} = 5
    expect(computeWakeSpread(STOCK, 6)).toBeNull();
  });

  test('scattered fire-times over the threshold → warn naming every (singleton) fire', () => {
    const scattered = [0, 2, 4, 6, 8, 10, 12].map((h, i) => ({ id: `r${i}`, schedule: `0 ${h} * * *` }));
    const s = computeWakeSpread(scattered, 6);
    expect(s).not.toBeNull();
    expect(s!.distinct).toBe(7);
    expect(s!.loneliest).toEqual([
      'r0@00:00', 'r1@02:00', 'r2@04:00', 'r3@06:00', 'r4@08:00', 'r5@10:00', 'r6@12:00',
    ]);
  });

  test('a shared 30-min window is not "lonely" — only singleton windows are named', () => {
    const set = [
      { id: 'a', schedule: '0 0 * * *' },   // 00:00 → window 0
      { id: 'b', schedule: '15 0 * * *' },  // 00:15 → window 0 (shares with a)
      { id: 'c', schedule: '0 3 * * *' },   // window 6
      { id: 'd', schedule: '0 6 * * *' },   // window 12
      { id: 'e', schedule: '0 9 * * *' },   // window 18
      { id: 'f', schedule: '0 12 * * *' },  // window 24
      { id: 'g', schedule: '0 15 * * *' },  // window 30
      { id: 'h', schedule: '0 18 * * *' },  // window 36
    ];
    const s = computeWakeSpread(set, 6);
    expect(s!.distinct).toBe(7); // window 0 counts once despite two fires
    expect(s!.loneliest).toEqual(['c@03:00', 'd@06:00', 'e@09:00', 'f@12:00', 'g@15:00', 'h@18:00']);
  });

  test('over threshold with no singleton windows → names the least-populated windows, never empty', () => {
    // 7 windows, each shared by exactly 2 fires: no window is a singleton. The advisory
    // must still name concrete fires rather than emit an empty "consider clustering:".
    const set = [
      { id: 'a1', schedule: '0 0 * * *' }, { id: 'a2', schedule: '15 0 * * *' },  // window 0
      { id: 'b1', schedule: '0 1 * * *' }, { id: 'b2', schedule: '10 1 * * *' },  // window 2
      { id: 'c1', schedule: '0 2 * * *' }, { id: 'c2', schedule: '15 2 * * *' },  // window 4
      { id: 'd1', schedule: '0 3 * * *' }, { id: 'd2', schedule: '10 3 * * *' },  // window 6
      { id: 'e1', schedule: '0 4 * * *' }, { id: 'e2', schedule: '15 4 * * *' },  // window 8
      { id: 'f1', schedule: '0 5 * * *' }, { id: 'f2', schedule: '10 5 * * *' },  // window 10
      { id: 'g1', schedule: '0 6 * * *' }, { id: 'g2', schedule: '15 6 * * *' },  // window 12
    ];
    const s = computeWakeSpread(set, 6);
    expect(s!.distinct).toBe(7);
    expect(s!.loneliest.length).toBeGreaterThan(0); // never dangles with nothing to name
    expect(s!.loneliest).toContain('a1@00:00'); // min-count windows all have 2 → all named
  });

  test('every-hour routines are excluded from the spread, however the hour field is spelled', () => {
    const sixWindows = [0, 2, 4, 6, 8, 10].map((h, i) => ({ id: `r${i}`, schedule: `0 ${h} * * *` }));
    expect(computeWakeSpread(sixWindows, 6)).toBeNull(); // exactly 6 windows, at threshold
    // Adding an every-hour routine must not push it over — if counted it would occupy
    // all 48 windows. Both `*` and its range form `0-23` are excluded (fire every hour),
    // so the set stays at 6 windows → still null.
    const withHourly = [
      ...sixWindows,
      { id: 'star', schedule: '0 * * * *' },
      { id: 'range', schedule: '0 0-23 * * *' },
    ];
    expect(computeWakeSpread(withHourly, 6)).toBeNull();
  });

  test('malformed schedule is skipped, never throws', () => {
    const set = [{ id: 'bad', schedule: 'not a cron' }, { id: 'ok', schedule: '0 9 * * *' }];
    expect(computeWakeSpread(set, 6)).toBeNull(); // only 'ok' contributes one window
  });

  test('threshold is honored — a lower max flips the stock config to a warn', () => {
    const s = computeWakeSpread(STOCK, 3);
    expect(s).not.toBeNull();
    expect(s!.distinct).toBe(5);
  });
});

describe('planCron — enabledShifted', () => {
  test('collects only enabled routines, with their shifted schedules', () => {
    const routines = [r('a'), r('b', { enabled: false }), r('c')];
    const mirror = seedMirror([r('a'), r('c')], {}, T0 - 1000);
    const plan = planCron(routines, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.enabledShifted.map(x => x.id).sort()).toEqual(['a', 'c']); // disabled 'b' excluded
    expect(plan.enabledShifted.every(x => x.schedule === '0 9 * * *')).toBe(true); // r() default, UTC → no shift
  });
});

// --ids <csv> filter (monitor-mode anchor-only plan/commit). filterRoutinesByIds is a
// pure pre-filter applied to the routines array before planCron — no change to
// planCron/commitCron's own signatures or diff semantics, so the suites above stay
// byte-identical to today when the flag is absent.
describe('filterRoutinesByIds', () => {
  test('null idsCsv → routines unchanged (identity, absent-flag case)', () => {
    const routines = [r('heartbeat-restart'), r('reflect'), r('weekly-review')];
    expect(filterRoutinesByIds(routines, null)).toBe(routines);
  });

  test('csv restricts to the named ids, order-preserving', () => {
    const routines = [r('heartbeat-restart'), r('reflect'), r('weekly-review')];
    const filtered = filterRoutinesByIds(routines, 'heartbeat-restart');
    expect(filtered.map(x => x.id)).toEqual(['heartbeat-restart']);
  });

  test('multi-id csv with whitespace', () => {
    const routines = [r('a'), r('b'), r('c')];
    expect(filterRoutinesByIds(routines, ' a , c ').map(x => x.id)).toEqual(['a', 'c']);
  });

  test('empty string idsCsv → routines unchanged', () => {
    const routines = [r('a')];
    expect(filterRoutinesByIds(routines, '')).toBe(routines);
  });
});

describe('planCron with --ids filter — monitor-mode anchor-only registration', () => {
  test('plan --ids heartbeat-restart on a mirror tracking 6 routines → KEEP anchor, DELETE the other 5', () => {
    const all = ['heartbeat-restart', 'reflect', 'scheduled-checks', 'weekly-review', 'daily-auto-close', 'doctor'].map(id => r(id));
    const mirror = seedMirror(all, {}, T0 - 1000); // all 6 tracked, fresh
    const filtered = filterRoutinesByIds(all, 'heartbeat-restart');
    const plan = planCron(filtered, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.deletes.sort()).toEqual(['daily-auto-close', 'doctor', 'reflect', 'scheduled-checks', 'weekly-review']);
    expect(plan.creates).toEqual([]);
    expect(plan.keepCount).toBe(1); // anchor kept, unchanged
  });

  test('plan --ids heartbeat-restart on an empty mirror → CREATE anchor only, no deletes', () => {
    const filtered = filterRoutinesByIds([r('heartbeat-restart'), r('reflect')], 'heartbeat-restart');
    const emptyMirror = { boot_id: BOOT_A, routines: {} };
    const plan = planCron(filtered, emptyMirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(plan.creates.map(c => c.id)).toEqual(['heartbeat-restart']);
    expect(plan.deletes).toEqual([]);
  });

  test('commit --ids heartbeat-restart prunes the mirror to the anchor alone', () => {
    const all = [r('heartbeat-restart'), r('reflect'), r('weekly-review')];
    const mirror = seedMirror(all, {}, T0 - 1000);
    const filtered = filterRoutinesByIds(all, 'heartbeat-restart');
    const plan = planCron(filtered, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    const routineById = new Map(filtered.map((x: any) => [x.id, x]));
    const next = commitCron(mirror, plan, new Set(), routineById, PLUGIN_ROOT, BOOT_A, T0);
    expect(Object.keys(next.routines)).toEqual(['heartbeat-restart']);
  });

  test('no --ids flag → planCron output is byte-identical to the unfiltered call', () => {
    const all = [r('heartbeat-restart'), r('reflect')];
    const mirror = seedMirror(all, {}, T0 - 1000);
    const viaFilter = planCron(filterRoutinesByIds(all, null), mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    const direct = planCron(all, mirror, BOOT_A, PLUGIN_ROOT, null, 'UTC', T0);
    expect(viaFilter).toEqual(direct);
  });
});
