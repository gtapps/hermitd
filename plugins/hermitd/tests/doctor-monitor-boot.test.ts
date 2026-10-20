import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { checkHeartbeat, checkRoutineMonitor } from '../scripts/doctor-check';
import { sameMonitorCommand } from '../scripts/lib/heartbeat/monitor-cmd';
import { freshDirFactory } from './helpers/workdir';

import { monitorFixture, type FixtureOpts } from './helpers/monitor-fixture';
const { freshDir, cleanup } = freshDirFactory('doctor-monitor-boot-');
afterAll(cleanup);

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

const fixture = (opts: FixtureOpts = {}) => monitorFixture(freshDir, opts).paths;

describe('doctor monitor boot gate', () => {
  test('a runtime boot_id from a previous boot fails both checks', () => {
    const p = fixture({
      bootId: 'boot-current',
      heartbeatBootId: 'boot-old',
      routineBootId: 'boot-old',
    });

    const heartbeat = checkHeartbeat(p);
    expect(heartbeat.status).toBe('fail');
    expect(heartbeat.detail).toContain('previous boot');
    expect(heartbeat.detail).toContain('/hermitd:heartbeat start');

    const routine = checkRoutineMonitor(p);
    expect(routine.status).toBe('fail');
    expect(routine.detail).toContain('previous boot');
    expect(routine.detail).toContain('/hermitd:hermit-routines load');
  });

  test('a matching boot_id leaves both checks ok', () => {
    const p = fixture({ bootId: 'boot-now' });

    const heartbeat = checkHeartbeat(p);
    expect(heartbeat.status).toBe('ok');
    expect(heartbeat.detail).toContain('ticking');

    const routine = checkRoutineMonitor(p);
    expect(routine.status).toBe('ok');
    expect(routine.detail).toContain('ticking');
  });

  test('a pre-upgrade runtime without boot_id falls through to freshness', () => {
    const p = fixture({ bootId: 'boot-now', heartbeatBootId: null, routineBootId: null });

    const heartbeat = checkHeartbeat(p);
    expect(heartbeat.status).toBe('ok');
    expect(heartbeat.detail).toContain('ticking');

    const routine = checkRoutineMonitor(p);
    expect(routine.status).toBe('ok');
    expect(routine.detail).toContain('ticking');
  });

  // A hermit that has never booted through hermitd-start has no marker to compare
  // against, so the gate must stay silent rather than condemn every registration.
  test('a hermit with no .boot-id never trips the gate', () => {
    const p = fixture({ heartbeatBootId: 'boot-old', routineBootId: 'boot-old' });

    expect(checkHeartbeat(p).status).toBe('ok');
    expect(checkRoutineMonitor(p).status).toBe('ok');
  });

  // croncreate-fallback writes no liveness file, so the boot id is the only
  // evidence its durable:false crons died with the process that registered them.
  test('croncreate-fallback is gated on boot id, not reported ok unconditionally', () => {
    const stale = checkRoutineMonitor(
      fixture({ bootId: 'boot-current', routineBootId: 'boot-old', routineMode: 'croncreate-fallback' }),
    );
    expect(stale.status).toBe('fail');
    expect(stale.detail).toContain('previous boot');

    const current = checkRoutineMonitor(
      fixture({ bootId: 'boot-now', routineMode: 'croncreate-fallback' }),
    );
    expect(current.status).toBe('ok');
    expect(current.detail).toContain('croncreate-fallback');
  });
});

// The heartbeat monitor writes its first tick before `start-commit` records started_at,
// so that tick reads untrusted until the next poll — a whole interval away. The two
// untrusted cases get different graces, because they mean different things.
describe('doctor heartbeat startup graces', () => {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  function seed(p: ReturnType<typeof fixture>, startedMinsAgo: number, tickMinsAgo: number | null, interval = 1800) {
    writeJson(path.join(p.stateDir, 'heartbeat-monitor.runtime.json'), {
      ...JSON.parse(fs.readFileSync(path.join(p.stateDir, 'heartbeat-monitor.runtime.json'), 'utf8')),
      description: 'heartbeat-monitor', started_at: minsAgo(startedMinsAgo), interval,
    });
    const config = JSON.parse(fs.readFileSync(p.configPath, 'utf8'));
    config.heartbeat.every = `${interval / 60}m`;
    writeJson(p.configPath, config);
    const liveness = path.join(p.stateDir, 'heartbeat-liveness.json');
    if (tickMinsAgo === null) fs.rmSync(liveness, { force: true });
    else writeJson(liveness, { last_peek_at: minsAgo(tickMinsAgo) });
  }

  // interval 1800 → predates-grace 1860s (31 min).
  test('a tick predating started_at is tolerated for one interval', () => {
    const p = fixture();
    seed(p, 10, 20);
    expect(checkHeartbeat(p).status).toBe('ok');
  });

  test('and faults once that interval is up', () => {
    const p = fixture();
    seed(p, 35, 40);
    const r = checkHeartbeat(p);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('belongs to another registration');
  });

  // The split: no tick at all is a subprocess that never spawned, and nothing will
  // supersede it, so it keeps the 2-minute spawn grace instead of the interval.
  test('no tick at all still faults on the 2m spawn grace', () => {
    const p = fixture();
    seed(p, 5, null);
    const r = checkHeartbeat(p);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('spawn likely blocked');
  });

  // Keep config and registration aligned so drift does not pre-empt freshness.
  // A 2h registration has 121 minutes of predates grace and is warming up at 60.
  test('the predates grace covers the registered 2h interval', () => {
    const p = fixture();
    seed(p, 60, 70, 7200);
    expect(checkHeartbeat(p).status).toBe('ok');
  });
});

// Claude Code can cache one release as `<ver>` and `<ver>-<sha12>`; which copy runs
// the check must not decide drift.
describe('doctor monitor command drift', () => {
  function registerFrom(p: ReturnType<typeof fixture>, rewrite: (cmd: string) => string, pid?: number) {
    for (const [runtime, liveness] of [
      ['heartbeat-monitor.runtime.json', 'heartbeat-liveness.json'],
      ['routine-monitor.runtime.json', 'routine-monitor-liveness.json'],
    ]) {
      const file = path.join(p.stateDir, runtime);
      const rt = JSON.parse(fs.readFileSync(file, 'utf8'));
      writeJson(file, { ...rt, command: rewrite(rt.command) });
      if (pid !== undefined) {
        const live = path.join(p.stateDir, liveness);
        writeJson(live, { ...JSON.parse(fs.readFileSync(live, 'utf8')), pid });
      }
    }
  }

  test('a registration from the sha-suffixed sibling cache dir is not drift', () => {
    const p = fixture();
    registerFrom(p, (cmd) => cmd.replace('"/scripts/', '-5954e0f6849a"/scripts/'));
    expect(checkHeartbeat(p).status).toBe('ok');
    expect(checkRoutineMonitor(p).status).toBe('ok');
  });

  test('two different sha suffixes are two builds, not one release', () => {
    const cmd = (root: string) => `bash "${root}"/scripts/monitor-supervisor.sh heartbeat "/h"`;
    expect(sameMonitorCommand(cmd('/c/1.4.7-5954e0f6849a'), cmd('/c/1.4.7'))).toBe(true);
    expect(sameMonitorCommand(cmd('/c/1.4.7-5954e0f6849a'), cmd('/c/1.4.7-0123456789ab'))).toBe(false);
  });

  test('a registration from another version dir is drift', () => {
    const p = fixture();
    registerFrom(p, (cmd) => cmd.replace('"/scripts/', '-1.4.6"/scripts/'));
    expect(checkHeartbeat(p).detail).toContain('command-drift');
    expect(checkRoutineMonitor(p).detail).toContain('command-drift');
  });

  test('drift with a live supervisor fails until the resident restarts', () => {
    const p = fixture({ commandDrift: true });
    registerFrom(p, (cmd) => cmd, process.pid);
    for (const r of [checkHeartbeat(p), checkRoutineMonitor(p)]) {
      expect(r.status).toBe('fail');
      expect(r.detail).toContain('restart the resident');
    }
  });

  test('drift with no live supervisor still fails with re-arm advice', () => {
    const p = fixture({ commandDrift: true });
    const heartbeat = checkHeartbeat(p);
    expect(heartbeat.status).toBe('fail');
    expect(heartbeat.detail).toContain('/hermitd:heartbeat start');
    const routine = checkRoutineMonitor(p);
    expect(routine.status).toBe('fail');
    expect(routine.detail).toContain('/hermitd:hermit-routines load');
  });
});

describe('doctor monitor registration states', () => {
  test('an explicitly stopped heartbeat is ok, not a missing registration', () => {
    const p = fixture();
    writeJson(path.join(p.stateDir, 'heartbeat-monitor.control.json'), { mode: 'stopped' });
    writeJson(path.join(p.stateDir, 'heartbeat-monitor.runtime.json'), {});
    const r = checkHeartbeat(p);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('stopped');
  });

  test('a routine tick that predates the registration reads warming up, not ticking', () => {
    const p = fixture();
    const runtimePath = path.join(p.stateDir, 'routine-monitor.runtime.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    writeJson(runtimePath, { ...runtime, started_at: new Date(Date.now() - 30_000).toISOString() });
    writeJson(path.join(p.stateDir, 'routine-monitor-liveness.json'), { last_peek_at: new Date(Date.now() - 60_000).toISOString() });
    const r = checkRoutineMonitor(p);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('warming up');
  });
});
