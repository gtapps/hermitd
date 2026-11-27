import { mutateTask } from '../scripts/lib/tasks';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runScript } from './helpers/run';
import { setupWorkdir, withDir, type Workdir, hermit, write, readJson } from './helpers/workdir';
import { normalizeItemKey } from '../scripts/lib/heartbeat-items';
import { utcDate } from './helpers/fixture-dates';

const DEFAULT_CHECKLIST = '# Heartbeat\n- Review proposals/ for any needing attention\n';

function seedHeartbeat(dir: string, opts: {
  end?: string;
  alertState?: string;
  runtime?: string;
  micro?: string;
  checklist?: string | null; // null → no HEARTBEAT.md
} = {}) {
  write(hermit(dir, 'config.json'),
    `{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"${opts.end ?? '24:00'}"}}}`);
  write(hermit(dir, 'state', 'alert-state.json'),
    opts.alertState ?? '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":0}');
  write(hermit(dir, 'state', 'runtime.json'), opts.runtime ?? '{}');
  write(hermit(dir, 'state', 'micro-proposals.json'), opts.micro ?? '{"pending":[]}');
  if (opts.checklist != null) write(hermit(dir, 'HEARTBEAT.md'), opts.checklist);
}

async function precheckOut(dir: string, peek = false): Promise<string> {
  const r = await runScript('heartbeat.ts', {
    args: ['precheck', ...(peek ? ['--peek', hermit(dir)] : [hermit(dir)])],
  });
  expect(r.exitCode).toBe(0);
  return r.stdout.trimEnd();
}

describe('heartbeat-precheck', () => {
  // 12. SKIP — HEARTBEAT.md missing
  test('heartbeat-precheck (SKIP: missing HEARTBEAT.md)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: null });
    expect(await precheckOut(dir)).toMatch(/^SKIP\|/);
  }));

  // 13. SKIP — empty HEARTBEAT.md (no checklist items)
  test('heartbeat-precheck (SKIP: empty HEARTBEAT.md)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: '# Heartbeat Checklist\n<!-- no items -->\n' });
    expect(await precheckOut(dir)).toMatch(/^SKIP\|/);
  }));

  // 14. SKIP — outside active hours. Zero-width window (start==end "00:00") is
  // outside at every wall-clock time: the precheck SKIPs when hhmm < start OR
  // hhmm >= end, and one of those always holds. (A "00:00–00:01" window instead
  // flaked when CI ran during the 00:00 minute.)
  test('heartbeat-precheck (SKIP: outside active hours)', withDir(async (dir) => {
    seedHeartbeat(dir, { end: '00:00', checklist: '# Heartbeat\n- Check something\n' });
    expect(await precheckOut(dir)).toMatch(/^SKIP\|/);
  }));

  // 15. EVALUATE — no alert entry for checklist item
  test('heartbeat-precheck (EVALUATE: item not in alerts)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: DEFAULT_CHECKLIST });
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));

  // 16. EVALUATE — pending tier-1 micro-proposal
  test('heartbeat-precheck (EVALUATE: tier-1 micro-proposal pending)', withDir(async (dir) => {
    seedHeartbeat(dir, {
      micro: '{"pending":[]}',
      checklist: DEFAULT_CHECKLIST,
    });
    mutateTask(hermit(dir), 'open', undefined, { requester: 'agent', kind: 'proposal', title: 'Question', done: 'Answered' }, '');
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));

  // 17. EVALUATE — session in_progress
  test('heartbeat-precheck (EVALUATE: session in_progress)', withDir(async (dir) => {
    seedHeartbeat(dir, { runtime: '{}', checklist: DEFAULT_CHECKLIST });
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));

  // 18. EVALUATE — self-eval due (tick 20)
  test('heartbeat-precheck (EVALUATE: self-eval due at tick 20)', withDir(async (dir) => {
    seedHeartbeat(dir, {
      alertState: '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":19}',
      checklist: DEFAULT_CHECKLIST,
    });
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));

  // 19. OK — all items suppressed and stable, structural checks clear
  test('heartbeat-precheck (OK: all items suppressed and stable)', withDir(async (dir) => {
    seedHeartbeat(dir, {
      alertState: `{"alerts":{"${normalizeItemKey(DEFAULT_CHECKLIST.split('\n')[1])}":{"count":6,"suppressed":true,"consecutive_clean":0,"first_seen":"2026-04-01","last_seen":"2026-04-28","text":"Review proposals"}},"last_digest_date":"${utcDate(new Date())}","self_eval":{},"total_ticks":5}`,
      checklist: DEFAULT_CHECKLIST,
    });
    expect(await precheckOut(dir)).toBe('OK');
  }));

  // 20. total_ticks incremented exactly once; alerts{} and self_eval{} untouched by precheck
  describe('state mutation', () => {
    let wd: Workdir;
    let alertState: any;

    beforeAll(async () => {
      wd = setupWorkdir();
      seedHeartbeat(wd.dir, {
        alertState: `{"alerts":{"checklist:reviewpr":{"count":6,"suppressed":true,"consecutive_clean":0}},"last_digest_date":"${utcDate(new Date())}","self_eval":{"mykey":{"clean_ticks":5}},"total_ticks":3}`,
        checklist: DEFAULT_CHECKLIST,
      });
      await precheckOut(wd.dir);
      alertState = readJson(hermit(wd.dir, 'state', 'alert-state.json'));
    });
    afterAll(() => wd.cleanup());

    test('heartbeat-precheck (total_ticks incremented once)', () => {
      expect(alertState.total_ticks).toBe(4);
    });
    test('heartbeat-precheck (alerts{} not mutated by precheck)', () => {
      expect(alertState.alerts['checklist:reviewpr'].count).toBe(6);
    });
    test('heartbeat-precheck (self_eval{} not mutated by precheck)', () => {
      expect(alertState.self_eval.mykey.clean_ticks).toBe(5);
    });
  });

  // 20a. --peek returns verdict without mutating total_ticks
  describe('--peek (read-only mode)', () => {
    let wd: Workdir;
    let peekOut = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      seedHeartbeat(wd.dir, {
        alertState: '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":5}',
        checklist: null,
      });
      peekOut = await precheckOut(wd.dir, true);
    });
    afterAll(() => wd.cleanup());

    test('heartbeat-precheck --peek (returns verdict)', () => {
      expect(peekOut.length).toBeGreaterThan(0);
    });
    test('heartbeat-precheck --peek (total_ticks not mutated)', () => {
      expect(readJson(hermit(wd.dir, 'state', 'alert-state.json')).total_ticks).toBe(5);
    });
  });

  // 20a-2. --peek fires self-eval EVALUATE one tick early (at total_ticks=19)
  describe('--peek self-eval', () => {
    let wd: Workdir;
    let peekOut = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      seedHeartbeat(wd.dir, {
        alertState: '{"alerts":{},"last_digest_date":null,"self_eval":{},"total_ticks":19}',
        checklist: DEFAULT_CHECKLIST,
      });
      peekOut = await precheckOut(wd.dir, true);
    });
    afterAll(() => wd.cleanup());

    test('heartbeat-precheck --peek (self-eval EVALUATE at tick 19)', () => {
      expect(peekOut).toBe('EVALUATE');
    });
    test('heartbeat-precheck --peek (self-eval: total_ticks still 19)', () => {
      expect(readJson(hermit(wd.dir, 'state', 'alert-state.json')).total_ticks).toBe(19);
    });
  });
});

// heartbeat-precheck — pause gate (PROP-015)
// ----------------------------------------------------------
describe('heartbeat-precheck (PROP-015 pause gate)', () => {
  test('heartbeat-precheck (SKIP: paused, indefinite)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: DEFAULT_CHECKLIST });
    write(hermit(dir, 'state', 'pause.json'),
      '{"paused":true,"paused_until":null,"reason":"operator","by":"test","ts":"2026-01-01T00:00:00.000Z"}');
    expect(await precheckOut(dir)).toBe('SKIP|paused');
  }));

  test('heartbeat-precheck (SKIP: paused, --peek mode identical)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: DEFAULT_CHECKLIST });
    write(hermit(dir, 'state', 'pause.json'),
      '{"paused":true,"paused_until":null,"reason":"operator","by":"test","ts":"2026-01-01T00:00:00.000Z"}');
    expect(await precheckOut(dir, true)).toBe('SKIP|paused');
  }));

  test('heartbeat-precheck (EVALUATE: expired snooze reads as unpaused)', withDir(async (dir) => {
    seedHeartbeat(dir, { checklist: DEFAULT_CHECKLIST });
    write(hermit(dir, 'state', 'pause.json'),
      '{"paused":true,"paused_until":"2000-01-01T00:00:00.000Z","reason":"operator","by":"test","ts":"2000-01-01T00:00:00.000Z"}');
    expect(await precheckOut(dir)).toBe('EVALUATE');
  }));
});

// heartbeat-precheck — clean-recheck damper
// ----------------------------------------------------------
function seedDamper(dir: string, opts: {
  nowIso: string;
  // null writes no last_clean_eval_at at all — the "damper never armed" case.
  cleanAgoMs: number | null;
  cooldown: string | null | undefined;
  alerts?: Record<string, unknown>;
  lastDigestDate?: string;
}) {
  const now = new Date(opts.nowIso).getTime();
  const cooldownPart = opts.cooldown === undefined ? '' :
    `,"clean_recheck_cooldown":${opts.cooldown === null ? 'null' : `"${opts.cooldown}"`}`;
  write(hermit(dir, 'config.json'),
    `{"timezone":"UTC","heartbeat":{"active_hours":{"start":"00:00","end":"24:00"}${cooldownPart}}}`);
  write(hermit(dir, 'state', 'alert-state.json'), JSON.stringify({
    alerts: opts.alerts ?? {},
    last_digest_date: opts.lastDigestDate ?? null,
    self_eval: {},
    total_ticks: 3,
    ...(opts.cleanAgoMs === null
      ? {}
      : { last_clean_eval_at: new Date(now - opts.cleanAgoMs).toISOString() }),
  }));
  write(hermit(dir, 'state', 'runtime.json'), '{}');
  write(hermit(dir, 'state', 'micro-proposals.json'), '{"pending":[]}');
  write(hermit(dir, 'HEARTBEAT.md'), DEFAULT_CHECKLIST);
}

async function precheckWithNow(dir: string, nowIso: string, peek = false): Promise<string> {
  const r = await runScript('heartbeat.ts', {
    args: ['precheck', ...(peek ? ['--peek', hermit(dir)] : [hermit(dir)])],
    env: { HERMIT_NOW: nowIso },
  });
  expect(r.exitCode).toBe(0);
  return r.stdout.trimEnd();
}

const NOW_ISO = '2026-06-14T12:00:00.000Z';

describe('heartbeat-precheck (damper: clean-recheck cooldown)', () => {
  test('heartbeat-precheck (OK: last_clean_eval_at 1h ago, cooldown 6h)', withDir(async (dir) => {
    seedDamper(dir, { nowIso: NOW_ISO, cleanAgoMs: 1 * 3600000, cooldown: '6h' });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('OK');
  }));

  test('heartbeat-precheck (EVALUATE: last_clean_eval_at 7h ago, cooldown expired)', withDir(async (dir) => {
    seedDamper(dir, { nowIso: NOW_ISO, cleanAgoMs: 7 * 3600000, cooldown: '6h' });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('EVALUATE');
  }));

  test('heartbeat-precheck (EVALUATE: last_clean_eval_at absent)', withDir(async (dir) => {
    seedDamper(dir, { nowIso: NOW_ISO, cleanAgoMs: null, cooldown: '6h' });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('EVALUATE');
  }));

  test('heartbeat-precheck (EVALUATE: last_clean_eval_at future-dated, skew guard)', withDir(async (dir) => {
    // cleanAgoMs negative → cleanAt is in the future relative to nowIso
    seedDamper(dir, { nowIso: NOW_ISO, cleanAgoMs: -1 * 3600000, cooldown: '6h' });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('EVALUATE');
  }));

  test('heartbeat-precheck (EVALUATE: clean_recheck_cooldown null disables damper)', withDir(async (dir) => {
    seedDamper(dir, { nowIso: NOW_ISO, cleanAgoMs: 1 * 3600000, cooldown: null });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('EVALUATE');
  }));

  test('heartbeat-precheck (OK: clean_recheck_cooldown absent defaults to 6h)', withDir(async (dir) => {
    // absent key: parseDuration(undefined, 6h) falls back to 6h default → damper active
    seedDamper(dir, { nowIso: NOW_ISO, cleanAgoMs: 1 * 3600000, cooldown: undefined });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('OK');
  }));

  // An unsuppressed entry no longer bypasses the damper: the ladder sends nothing on
  // repeats before count===6, so bypassing bought five paid EVALUATEs per alert and no
  // extra message. Freshness of last_clean_eval_at is the whole gate now — a genuinely
  // new key nulls it, which is what re-opens the damper.
  test('heartbeat-precheck (OK: already-recorded unsuppressed alert does not override damper)', withDir(async (dir) => {
    seedDamper(dir, {
      nowIso: NOW_ISO, cleanAgoMs: 1 * 3600000, cooldown: '6h',
      alerts: { 'checklist:reviewpr': { count: 2, suppressed: false, consecutive_clean: 0 } },
    });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('OK');
  }));

  test('heartbeat-precheck (EVALUATE: already-recorded alert with no clean stamp)', withDir(async (dir) => {
    seedDamper(dir, {
      nowIso: NOW_ISO, cleanAgoMs: null, cooldown: '6h',
      alerts: { 'checklist:reviewpr': { count: 2, suppressed: false, consecutive_clean: 0 } },
    });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('EVALUATE');
  }));

  // A proposal-pending key's first observation is silent by design (its text carries a raw
  // PROP-NNN), so the count===6 suppression transition is the operator's FIRST notice that a
  // decision is waiting. Damping the five ticks in between would move that notice from ~5
  // ticks out to ~5 cooldown windows (>24h on the shipped 30m/6h defaults).
  test('heartbeat-precheck (OK: an old alert cannot bypass the delivery budget)', withDir(async (dir) => {
    seedDamper(dir, {
      nowIso: NOW_ISO, cleanAgoMs: 1 * 3600000, cooldown: '6h',
      alerts: { 'decision-pending:PROP-042': { count: 2, suppressed: false, consecutive_clean: 0 } },
    });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('OK');
  }));

  // …and it self-limits: once the ladder suppresses the entry the bypass stops, so a
  // long-open proposal costs five wakes total, not one per tick forever.
  test('heartbeat-precheck (OK: suppressed proposal-pending alert stops bypassing the damper)', withDir(async (dir) => {
    seedDamper(dir, {
      nowIso: NOW_ISO, cleanAgoMs: 1 * 3600000, cooldown: '6h',
      alerts: { 'decision-pending:PROP-042': { count: 6, suppressed: true, consecutive_clean: 0 } },
      // Digest already sent today, so the suppressed-digest gate above the damper stays
      // quiet. precheck's digest gate reads the real wall-clock day (todayYMD takes no
      // HERMIT_NOW override), so stamp that day, not NOW_ISO's.
      lastDigestDate: new Date().toISOString().slice(0, 10),
    });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('OK');
  }));

  test('heartbeat-precheck (EVALUATE: resolving alert consecutive_clean > 0 overrides damper)', withDir(async (dir) => {
    seedDamper(dir, {
      nowIso: NOW_ISO, cleanAgoMs: 1 * 3600000, cooldown: '6h',
      alerts: { 'checklist:reviewpr': { count: 6, suppressed: true, consecutive_clean: 1 } },
    });
    expect(await precheckWithNow(dir, NOW_ISO)).toBe('EVALUATE');
  }));

  // 21h. OK --peek — read-only, does not mutate total_ticks
  describe('--peek with damper active', () => {
    let wd: Workdir;
    let peekOut = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      seedDamper(wd.dir, { nowIso: NOW_ISO, cleanAgoMs: 1 * 3600000, cooldown: '6h' });
      peekOut = await precheckWithNow(wd.dir, NOW_ISO, true);
    });
    afterAll(() => wd.cleanup());

    test('heartbeat-precheck --peek (damper OK verdict)', () => {
      expect(peekOut).toBe('OK');
    });
    test('heartbeat-precheck --peek (damper: total_ticks not mutated)', () => {
      expect(readJson(hermit(wd.dir, 'state', 'alert-state.json')).total_ticks).toBe(3);
    });
  });
});
