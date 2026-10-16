// Contract tests for the routine wake gate — `routines[].precheck`, run by
// `routines.ts due` before it decides whether to wake the session.
//
// Driven through `due` as a subprocess rather than by importing runGate: the
// whole point of the gate is what it does to the emission, the cursor and the
// ledger, and those only exist at the process boundary.
//
// Usage: bun test tests/routine-gate.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { verdictLine } from '../scripts/doctor-check';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { validatePrecheckValue, validatePrecheckTimeout, resolveGate } from '../scripts/lib/routines/gate';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const schedulePath = (dir: string) => hermit(dir, 'state', 'routine-schedule.json');

const readRows = (dir: string) => {
  try {
    return fs.readFileSync(hermit(dir, 'state', 'routine-metrics.jsonl'), 'utf-8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const readSchedule = (dir: string): any => {
  try { return JSON.parse(fs.readFileSync(schedulePath(dir), 'utf-8')); } catch { return null; }
};
const writeSchedule = (dir: string, value: any) => fs.writeFileSync(schedulePath(dir), JSON.stringify(value));
const writeConfig = (dir: string, routines: any[]) =>
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ timezone: 'UTC', routines }));

/** A gate script at <project>/tools/<name>, executable, with the given body. */
function writeGate(dir: string, name: string, body: string): string {
  const rel = path.join('tools', name);
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, { mode: 0o755 });
  return rel;
}

const ROUTINE = (overrides: any = {}) => ({
  id: 'gated', skill: 'my-plugin:thing', schedule: '0 9 * * *',
  enabled: true, ...overrides,
});

/** The cursor is one hour behind the fire, so every run below has a mark to consume. */
const PRIMED = { gated: { last_consumed_mark: '2026-07-15T08:00:00.000Z' } };
const NOW = '2026-07-15T09:30:00Z';
const MARK = '2026-07-15T09:00:00.000Z';

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const runDue = (dir: string, now = NOW, env: Record<string, string> = {}) =>
  runScript('routines.ts', { args: ['due', hermit(dir)], env: { HERMIT_NOW: now, ...env } });

describe('routine gate — verdicts', () => {
  test('expired occurrence does not execute its precheck', withDir(async (dir) => {
    const rel = writeGate(dir, 'late.sh', '#!/usr/bin/env bash\ntouch tools/gate-ran\necho WAKE\n');
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);
    const result = await runDue(dir, '2026-07-15T10:01:00Z');
    expect(result.stdout).toBe('');
    expect(fs.existsSync(path.join(dir, 'tools', 'gate-ran'))).toBe(false);
    expect(readRows(dir).map((r) => r.event)).toEqual(['skipped-late']);
    expect(readSchedule(dir).gated.last_consumed_mark).toBe(MARK);
  }));

  test('SKIP consumes the fire, stamps skipped-precheck, emits nothing', withDir(async (dir) => {
    const rel = writeGate(dir, 'skip.sh', '#!/usr/bin/env bash\necho SKIP\n');
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);

    const r = await runDue(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(readSchedule(dir).gated.last_consumed_mark).toBe(MARK);
    const rows = readRows(dir);
    expect(rows.map((x) => x.event)).toEqual(['skipped-precheck']);
    expect(rows[0].delivery).toBe('monitor');
  }));

  test('WAKE emits the unchanged ROUTINE_DUE line and stamps nothing', withDir(async (dir) => {
    const rel = writeGate(dir, 'wake.sh', '#!/usr/bin/env bash\necho WAKE\n');
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);

    const r = await runDue(dir);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:gated]');
    const rows = readRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'gated', event: 'dispatched', delivery: 'monitor' });
    expect(readSchedule(dir).gated.last_consumed_mark).toBe(MARK);
  }));

  test('non-zero exit wakes anyway and records the exit code', withDir(async (dir) => {
    const rel = writeGate(dir, 'broken.sh', '#!/usr/bin/env bash\necho SKIP\nexit 3\n');
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);

    const r = await runDue(dir);
    // A failing CLI that happens to print SKIP must never be read as a skip.
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:gated]');
    const rows = readRows(dir);
    expect(rows.map((x) => x.event)).toEqual(['precheck-error', 'dispatched']);
    expect(rows[0].detail).toBe('exit:3');
  }));

  test('unparseable output wakes anyway with bad-verdict', withDir(async (dir) => {
    const rel = writeGate(dir, 'chatty.sh', '#!/usr/bin/env bash\necho "no new mail, nothing to do"\n');
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);

    const r = await runDue(dir);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:gated]');
    expect(readRows(dir)[0].detail).toBe('bad-verdict');
  }));

  test('a gate that is not executable wakes anyway', withDir(async (dir) => {
    const rel = path.join('tools', 'plain.sh');
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'echo SKIP\n', { mode: 0o644 });
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);

    const r = await runDue(dir);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:gated]');
    expect(readRows(dir)[0].detail).toBe('not-executable');
  }));

  test('a path outside the project is refused, not run', withDir(async (dir) => {
    const outside = path.join(dir, '..', 'evil.sh');
    fs.writeFileSync(outside, '#!/usr/bin/env bash\necho SKIP\n', { mode: 0o755 });
    try {
      writeConfig(dir, [ROUTINE({ precheck: '../evil.sh' })]);
      writeSchedule(dir, PRIMED);

      const r = await runDue(dir);
      expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:gated]');
      expect(readRows(dir)[0].detail).toBe('bad-config');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  }));
});

describe('routine gate — timeout and process hygiene', () => {
  test('a hung gate is killed at precheck_timeout_s and wakes the routine', withDir(async (dir) => {
    const rel = writeGate(dir, 'hang.sh', '#!/usr/bin/env bash\nsleep 30\necho SKIP\n');
    writeConfig(dir, [ROUTINE({ precheck: rel, precheck_timeout_s: 1 })]);
    writeSchedule(dir, PRIMED);

    const started = Date.now();
    const r = await runDue(dir);
    const elapsed = Date.now() - started;

    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:gated]');
    expect(readRows(dir)[0].detail).toBe('timeout');
    // The point of the timeout: `due` returns on its own schedule, not the gate's.
    expect(elapsed).toBeLessThan(15000);
  }), 20000);

  test('a gate that backgrounds a child still returns immediately', withDir(async (dir) => {
    // stdout goes to a file rather than a pipe precisely so this cannot block:
    // the forked `sleep` inherits the descriptor and outlives the gate.
    const rel = writeGate(dir, 'forker.sh', '#!/usr/bin/env bash\nsleep 20 &\necho SKIP\nexit 0\n');
    writeConfig(dir, [ROUTINE({ precheck: rel, precheck_timeout_s: 5 })]);
    writeSchedule(dir, PRIMED);

    const started = Date.now();
    const r = await runDue(dir);
    const elapsed = Date.now() - started;

    expect(r.stdout.trim()).toBe('');
    expect(readRows(dir)[0].event).toBe('skipped-precheck');
    expect(elapsed).toBeLessThan(10000);
  }), 20000);

  test('liveness is refreshed after a slow gate, not only at exit', withDir(async (dir) => {
    const rel = writeGate(dir, 'slow.sh', '#!/usr/bin/env bash\nsleep 1\necho SKIP\n');
    writeConfig(dir, [ROUTINE({ precheck: rel, precheck_timeout_s: 10 })]);
    writeSchedule(dir, PRIMED);

    await runDue(dir);
    const liveness = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'routine-monitor-liveness.json'), 'utf-8'));
    expect(typeof liveness.last_peek_at).toBe('string');
    expect(Date.now() - Date.parse(liveness.last_peek_at)).toBeLessThan(60000);
  }), 20000);
});

describe('routine gate — environment', () => {
  test('gets HERMIT_DIR/ROUTINE_ID/ROUTINE_LAST_FIRED and none of the monitor secrets', withDir(async (dir) => {
    const rel = writeGate(dir, 'dump.sh', [
      '#!/usr/bin/env bash',
      'printf "%s|%s|%s|%s|%s|%s\\n" "$ROUTINE_ID" "$HERMIT_DIR" "$ROUTINE_LAST_FIRED" "${SENTINEL_SECRET:-unset}" "$CLAUDE_CONFIG_DIR" "$HERMIT_PLUGIN_ROOT" > "$HERMIT_DIR/state/gate-env.txt"',
      'echo SKIP',
      '',
    ].join('\n'));
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);
    fs.writeFileSync(
      hermit(dir, 'state', 'routine-metrics.jsonl'),
      JSON.stringify({ ts: '2026-07-14T09:00:03Z', routine_id: 'gated', event: 'fired', delivery: 'monitor' }) + '\n',
    );

    await runDue(dir, NOW, { SENTINEL_SECRET: 'leaked', CLAUDE_CONFIG_DIR: '/custom/claude', HERMIT_PLUGIN_ROOT: '/custom/core' });
    const [id, hermitDir, lastFired, secret, configDir, pluginRoot] =
      fs.readFileSync(hermit(dir, 'state', 'gate-env.txt'), 'utf-8').trim().split('|');
    expect(id).toBe('gated');
    expect(hermitDir).toBe(hermit(dir));
    expect(lastFired).toBe('2026-07-14T09:00:03Z');
    expect(secret).toBe('unset');
    expect(configDir).toBe('/custom/claude');
    expect(pluginRoot).toBe('/custom/core');
  }), 20000);

  test('ROUTINE_LAST_FIRED is empty on a routine that has never fired', withDir(async (dir) => {
    const rel = writeGate(dir, 'first.sh', [
      '#!/usr/bin/env bash',
      'printf "[%s]" "$ROUTINE_LAST_FIRED" > "$HERMIT_DIR/state/gate-env.txt"',
      'echo SKIP',
      '',
    ].join('\n'));
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);

    await runDue(dir);
    expect(fs.readFileSync(hermit(dir, 'state', 'gate-env.txt'), 'utf-8')).toBe('[]');
  }), 20000);
});

describe('routine gate — ordering against the other gates', () => {
  const counterGate = (dir: string) => writeGate(dir, 'count.sh', [
    '#!/usr/bin/env bash',
    'echo x >> "$HERMIT_DIR/state/gate-calls.txt"',
    'echo SKIP',
    '',
  ].join('\n'));
  const callCount = (dir: string) => {
    try {
      return fs.readFileSync(hermit(dir, 'state', 'gate-calls.txt'), 'utf-8').trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  test('not run while an operator turn is open, and the fire is not consumed', withDir(async (dir) => {
    const rel = counterGate(dir);
    writeConfig(dir, [ROUTINE({ precheck: rel })]);
    writeSchedule(dir, PRIMED);
    fs.writeFileSync(hermit(dir, 'state', 'operator-turn-open.json'), JSON.stringify({ at: NOW }));

    const r = await runDue(dir, NOW);
    expect(r.stdout.trim()).toBe('');
    expect(callCount(dir)).toBe(0);
    // Deferred, not consumed: the gate must get its one run at the next poll.
    expect(readSchedule(dir).gated.last_consumed_mark).toBe('2026-07-15T08:00:00.000Z');
  }));

  test('two gated routines co-firing each run their own gate once', withDir(async (dir) => {
    const skip = writeGate(dir, 'one.sh', '#!/usr/bin/env bash\necho SKIP\n');
    const wake = writeGate(dir, 'two.sh', '#!/usr/bin/env bash\necho WAKE\n');
    writeConfig(dir, [
      ROUTINE({ id: 'quiet', precheck: skip }),
      ROUTINE({ id: 'noisy', precheck: wake }),
    ]);
    writeSchedule(dir, {
      quiet: { last_consumed_mark: '2026-07-15T08:00:00.000Z' },
      noisy: { last_consumed_mark: '2026-07-15T08:00:00.000Z' },
    });

    const r = await runDue(dir);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:noisy]');
    expect(readRows(dir).map((x) => `${x.routine_id}:${x.event}`)).toEqual(['quiet:skipped-precheck', 'noisy:dispatched']);
  }));

  test('an ungated routine never spawns anything and behaves exactly as before', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE()]);
    writeSchedule(dir, PRIMED);

    const r = await runDue(dir);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:gated]');
    const rows = readRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'gated', event: 'dispatched', delivery: 'monitor' });
  }));
});

describe('routine gate — reflect provider', () => {
  // A fresh hermit has cadence phases due, so reflect-precheck answers RUN here.
  // That is the interesting half anyway: EMPTY is just the skip path already
  // covered above, while RUN is the one that has to hand phases across the wake.
  test('RUN wakes the routine and parks the phases under this fire mark', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'reflect', skill: 'hermitd:reflect', precheck: 'reflect' })]);
    writeSchedule(dir, { reflect: { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });

    const r = await runDue(dir);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:reflect]');
    expect(readRows(dir).map((x) => x.event)).toEqual(['dispatched']);

    const parked = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'reflect-gate.json'), 'utf-8')).reflect;
    expect(parked.mark).toBe(MARK);
    expect(parked.phases.startsWith('RUN|')).toBe(true);
    // The parked mark is what `routines.ts precheck` matches against before
    // handing the phases to the skill, so it must equal the consumed cursor.
    expect(readSchedule(dir).reflect.last_consumed_mark).toBe(parked.mark);
  }), 30000);

  test('the awake precheck verb replays the parked phases instead of re-running reflect', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'reflect', skill: 'hermitd:reflect', precheck: 'reflect' })]);
    writeSchedule(dir, { reflect: { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });
    await runDue(dir);

    const r = await runScript('routines.ts', {
      args: ['precheck', 'reflect', 'monitor'],
      cwd: dir,
    });
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('PROCEED');
    expect(lines[1].startsWith('REFLECT RUN|')).toBe(true);
  }), 30000);

  test('a stale parked verdict (different fire) is ignored, leaving a bare PROCEED', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'reflect', skill: 'hermitd:reflect', precheck: 'reflect' })]);
    writeSchedule(dir, { reflect: { last_consumed_mark: '2026-07-16T09:00:00.000Z' } });
    fs.writeFileSync(
      hermit(dir, 'state', 'reflect-gate.json'),
      JSON.stringify({ reflect: { mark: '2026-07-15T09:00:00.000Z', phases: 'RUN|{"compute":true}' } }),
    );

    const r = await runScript('routines.ts', {
      args: ['precheck', 'reflect', 'monitor'],
      cwd: dir,
    });
    expect(r.stdout.trim()).toBe('PROCEED');
  }), 30000);

  test('another routine on the same mark cannot consume this one\'s phases', withDir(async (dir) => {
    // Nothing stops two routines from both declaring the builtin and coming due
    // in the same minute. Keyed by mark alone, the second write would clobber the
    // first and the mark check would still pass — one routine running on the
    // other's phases. Keyed by id, a routine with no parked verdict gets none.
    writeConfig(dir, [ROUTINE({ id: 'reflect', skill: 'hermitd:reflect', precheck: 'reflect' })]);
    writeSchedule(dir, { reflect: { last_consumed_mark: '2026-07-16T09:00:00.000Z' } });
    fs.writeFileSync(
      hermit(dir, 'state', 'reflect-gate.json'),
      JSON.stringify({ 'other-reflect': { mark: '2026-07-16T09:00:00.000Z', phases: 'RUN|{"compute":true}' } }),
    );

    const r = await runScript('routines.ts', {
      args: ['precheck', 'reflect', 'monitor'],
      cwd: dir,
    });
    expect(r.stdout.trim()).toBe('PROCEED');
  }), 30000);
});

describe('routine gate — doctor builtin', () => {
  const runDoctor = (dir: string, args: string[] = []) =>
    runScript('doctor-check.ts', { args: [hermit(dir), ...args] });

  // The fixture config (writeConfig's {timezone, routines}) is missing every
  // other required key, so checkConfig fails deterministically — guaranteeing
  // at least one unconfirmed finding on a hermit's first ever doctor run.
  test('an unconfirmed finding on a fresh hermit → WAKE', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'doctor', precheck: 'doctor' })]);
    writeSchedule(dir, { doctor: { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });

    const r = await runDue(dir);
    expect(r.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:doctor]');
    const rows = readRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routine_id: 'doctor', event: 'dispatched', delivery: 'monitor' });
  }), 30000);

  test('everything owed already confirmed delivered → SKIP', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'doctor', precheck: 'doctor' })]);
    writeSchedule(dir, { doctor: { last_consumed_mark: '2026-07-15T08:00:00.000Z' } });

    // Seed the ledger the way the gate's own first run would, then confirm
    // delivery of everything owed — this fire's gate run must then see nothing new.
    const seeded = JSON.parse((await runDoctor(dir)).stdout);
    const owedIds = seeded.escalation.new.map((f: any) => f.id);
    expect(owedIds.length).toBeGreaterThan(0); // sanity: this fixture has something owed
    const marked = await runDoctor(dir, ['--mark-notified', ...owedIds]);
    expect(JSON.parse(marked.stdout).marked).toBe(true);

    const r = await runDue(dir);
    expect(r.stdout.trim()).toBe('');
    expect(readRows(dir).map((x: any) => x.event)).toEqual(['skipped-precheck']);
  }), 30000);

  test('--gate prints a bare verdict, never the checks JSON', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'doctor', precheck: 'doctor' })]);
    const r = await runDoctor(dir, ['--gate']);
    expect(['SKIP', 'WAKE']).toContain(r.stdout.trim());
  }), 30000);

  test('--verdict prints failing check ids on one line and exits 1', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'doctor', precheck: 'doctor' })]);
    const r = await runDoctor(dir, ['--verdict']);
    expect(r.stdout).toMatch(/^FAIL [^\n]+\n$/);
    expect(r.stdout.trim().slice('FAIL '.length).split(', ')).toContain('config');
    expect(r.exitCode).toBe(1);
  }), 30000);

  test('verdictLine counts only failures', () => {
    const checks = [{ id: 'runtime', status: 'ok' }, { id: 'cost', status: 'warn' }];
    expect(verdictLine(checks)).toBe('OK');
    expect(verdictLine([...checks, { id: 'config', status: 'fail' }])).toBe('FAIL config');
    expect(verdictLine([...checks, { id: 'classifier-denials', status: 'fail' }])).toBe('OK');
  });

  test('verdictLine leaves out failures that predate the upgrade', () => {
    const checks = [{ id: 'state', status: 'fail' }, { id: 'config', status: 'fail' }];
    expect(verdictLine(checks, (id) => id === 'state')).toBe('FAIL config');
    expect(verdictLine([checks[0]], (id) => id === 'state')).toBe('OK');
  });

  test('--verdict --since ignores a failure the ledger saw before the upgrade', withDir(async (dir) => {
    writeConfig(dir, [ROUTINE({ id: 'doctor', precheck: 'doctor' })]);
    const before = (await runDoctor(dir, ['--verdict'])).stdout.trim();
    expect(before).toContain('config');
    const r = await runDoctor(dir, ['--verdict', '--since', new Date(Date.now() + 60_000).toISOString()]);
    expect(r.stdout.trim()).toBe('OK');
    expect(r.exitCode).toBe(0);
    const after = await runDoctor(dir, ['--verdict', '--since', new Date(Date.now() - 3_600_000).toISOString()]);
    expect(after.stdout.trim()).toContain('config');
    expect(after.exitCode).toBe(1);
  }), 30000);
});

describe('precheck validation (pure)', () => {
  test('accepts every builtin and project-relative paths', () => {
    expect(validatePrecheckValue('reflect')).toBeNull();
    expect(validatePrecheckValue('doctor')).toBeNull();
    expect(validatePrecheckValue('tools/gate.sh')).toBeNull();
  });

  test('rejects absolute paths, traversal, empties and non-strings', () => {
    expect(validatePrecheckValue('/usr/bin/true')).toContain('absolute');
    expect(validatePrecheckValue('../escape.sh')).toContain('..');
    expect(validatePrecheckValue('  ')).toContain('empty');
    expect(validatePrecheckValue(42 as any)).toContain('string');
  });

  test('timeout bounds', () => {
    expect(validatePrecheckTimeout(30)).toBeNull();
    expect(validatePrecheckTimeout(300)).toBeNull();
    expect(validatePrecheckTimeout(0)).toContain('between');
    expect(validatePrecheckTimeout(301)).toContain('between');
    expect(validatePrecheckTimeout(1.5)).toContain('integer');
  });

  test('resolveGate names each builtin without touching the filesystem', () => {
    expect(resolveGate('reflect', '/nonexistent')).toEqual({ kind: 'builtin', name: 'reflect' });
    expect(resolveGate('doctor', '/nonexistent')).toEqual({ kind: 'builtin', name: 'doctor' });
  });
});

test('later builtin skips an empty ledger and wakes once for a past-due claim', withDir(async dir => {
  expect(validatePrecheckValue('later')).toBeNull();
  writeConfig(dir, [ROUTINE({ id: 'later-check', precheck: 'later' })]);
  const primed = { 'later-check': { last_consumed_mark: '2026-07-15T08:00:00.000Z' } };
  writeSchedule(dir, primed);
  const empty = await runDue(dir);
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout.trim()).toBe('');
  expect(readRows(dir).at(-1).event).toBe('skipped-precheck');
  fs.writeFileSync(hermit(dir, 'state', 'hypotheses.jsonl'), JSON.stringify({
    id: 'test-claim', claim: 'fix holds', cmd: 'true', due: '2026-07-14T09:00:00Z',
    origin: 'hermit', session: null, created_at: '2026-07-13T09:00:00Z', state: 'pending',
  }) + '\n');
  writeSchedule(dir, primed);
  const due = await runDue(dir);
  expect(due.exitCode).toBe(0);
  expect(due.stdout.trim()).toBe('ROUTINE_DUE [hermit-routine:later-check]');
  expect((await runDue(dir)).stdout.trim()).toBe('');
}));
