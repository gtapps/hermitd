import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, SCRIPTS_DIR, runBash } from './helpers/run';
import { readJson } from './helpers/workdir';
import { runMonitorUntil } from './helpers/run-monitor';

describe('heartbeat-monitor', () => {
  const MONITOR_SH = path.join(SCRIPTS_DIR, 'heartbeat-monitor.sh');

  for (const mode of ['auto', 'forced', 'stopped']) {
    test(`heartbeat-monitor control ${mode} with disabled config`, async () => {
      const dir = fs.mkdtempSync(path.join(PLUGIN_ROOT, '.heartbeat-control-test-'));
      try {
        fs.mkdirSync(path.join(dir, 'state'));
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ heartbeat: { enabled: false } }));
        fs.writeFileSync(path.join(dir, 'state/heartbeat-monitor.control.json'), JSON.stringify({ mode }));
        const stub = path.join(dir, 'precheck.ts');
        fs.writeFileSync(stub, `
const dir = process.argv.at(-1);
const file = Bun.file(dir + '/count');
const count = await file.exists() ? Number(await file.text()) + 1 : 1;
await Bun.write(file, String(count));
if (count === 2) await Bun.write(dir + '/state/heartbeat-monitor.control.json', JSON.stringify({ mode: 'stopped' }));
console.log('EVALUATE');
`);
        const result = await runBash(MONITOR_SH, {
          args: ['0.1', dir],
          env: {
            HEARTBEAT_PRECHECK: stub,
            HEARTBEAT_MONITOR_ONCE: mode === 'forced' ? '' : '1',
            MONITOR_SUPERVISOR_PID: String(process.pid),
          },
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(mode === 'forced' ? 'HEARTBEAT_EVALUATE\n' : '');
        const live = path.join(dir, 'state/heartbeat-liveness.json');
        if (mode === 'stopped') expect(fs.existsSync(live)).toBe(false);
        else expect(readJson(live).pid).toBe(process.pid);
        expect(fs.existsSync(path.join(dir, 'count'))).toBe(mode === 'forced');
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  }

  test('heartbeat-monitor observes stopped during a long sliced sleep', async () => {
    const dir = fs.mkdtempSync(path.join(PLUGIN_ROOT, '.heartbeat-stop-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'state'));
      const stub = path.join(dir, 'precheck.ts');
      fs.writeFileSync(stub, `await Bun.write(process.argv.at(-1) + '/state/heartbeat-monitor.control.json', '{"mode":"stopped"}'); console.log('OK');`);
      const start = Date.now();
      const result = await runBash(MONITOR_SH, { args: ['43200', dir], env: { HEARTBEAT_PRECHECK: stub, HEARTBEAT_MONITOR_ONCE: '' } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(Date.now() - start).toBeLessThan(60_000);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  }, 65_000);

  function makeStub(body: string): { path: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-stub-'));
    const p = path.join(dir, 'stub.js');
    fs.writeFileSync(p, body);
    return { path: p, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
  }

  /** One monitor iteration with the precheck stubbed out; returns stdout and the temp hermit dir. */
  async function monitorOnce(stubBody: string): Promise<{ stdout: string; hbDir: string; cleanup(): void }> {
    const stub = makeStub(stubBody);
    const hbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hermit-'));
    try {
      const r = await runBash(MONITOR_SH, {
        args: ['60', hbDir],
        env: { HEARTBEAT_MONITOR_ONCE: '1', HEARTBEAT_PRECHECK: stub.path },
      });
      return {
        stdout: r.stdout.trimEnd(),
        hbDir,
        cleanup: () => { try { fs.rmSync(hbDir, { recursive: true, force: true }); } catch {} },
      };
    } finally {
      stub.cleanup();
    }
  }

  for (const verdict of ['ALERT', 'EVALUATE', 'OK', 'SKIP|outside-hours', 'ERROR']) {
    test(`heartbeat-monitor stamps only emitted wakes for ${verdict}`, async () => {
      const r = await monitorOnce(`console.log(${JSON.stringify(verdict)});`);
      try {
        const live = readJson(path.join(r.hbDir, 'state/heartbeat-liveness.json'));
        if (verdict === 'ALERT') {
          expect(live.last_wake_at).toBe(live.last_peek_at);
          expect(r.stdout).toBe('HEARTBEAT_EVALUATE');
        } else {
          expect(live).not.toHaveProperty('last_wake_at');
        }
      } finally {
        r.cleanup();
      }
    });
  }

  test('heartbeat-monitor preserves the emitted wake across quiet iterations', async () => {
    const { liveness, firstWake } = await runMonitorUntil({
      scriptPath: MONITOR_SH,
      stubBody: `if (__iterN === 2) fs.writeFileSync(path.join(d, 'first-wake'), JSON.parse(fs.readFileSync(path.join(d, 'state/heartbeat-liveness.json'), 'utf8')).last_wake_at);
console.log(__iterN === 1 ? 'ALERT' : 'OK');`,
      envVar: 'HEARTBEAT_PRECHECK',
      interval: '0.2',
      iters: 2,
    });
    expect(typeof firstWake).toBe('string');
    expect(liveness?.last_wake_at).toBe(firstWake);
  }, 45000);

  for (const consumed of [false, true]) {
    test(`heartbeat-monitor ${consumed ? 'restamps a repeated wake after .heartbeat catches up' : 'keeps the oldest stamp for a repeated unconsumed wake'}`, async () => {
      const { liveness, firstWake } = await runMonitorUntil({
        scriptPath: MONITOR_SH,
        stubBody: `if (__iterN === 2) {
  fs.writeFileSync(path.join(d, 'first-wake'), JSON.parse(fs.readFileSync(path.join(d, 'state/heartbeat-liveness.json'), 'utf8')).last_wake_at);
  ${consumed ? "fs.writeFileSync(path.join(d, 'state/.heartbeat'), '');" : ''}
}
console.log('ALERT');`,
        envVar: 'HEARTBEAT_PRECHECK',
        // Whole-second stamps: a 1s poll guarantees the second wake lands in a later second.
        interval: '1',
        iters: 2,
      });
      expect(typeof firstWake).toBe('string');
      if (consumed) expect(liveness?.last_wake_at).not.toBe(firstWake);
      else expect(liveness?.last_wake_at).toBe(firstWake);
    }, 45000);
  }

  // 20b. EVALUATE on iter-1 → silent (cold-start suppression)
  test('heartbeat-monitor (iter-1 EVALUATE → silent, cold-start suppressed)', async () => {
    const r = await monitorOnce('process.stdout.write("EVALUATE\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  // 20c. EVALUATE with suffix on iter-1 → silent (prefix match still suppressed)
  test('heartbeat-monitor (iter-1 EVALUATE|micro-pending → silent)', async () => {
    const r = await monitorOnce('process.stdout.write("EVALUATE|micro-pending\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  // Retired verdicts must not trigger evaluation.
  test('heartbeat-monitor (retired AUTO_CLOSE is an unknown verdict)', async () => {
    const r = await monitorOnce('process.stdout.write("AUTO_CLOSE\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('HEARTBEAT_ERROR: unknown verdict: AUTO_CLOSE');
  });

  // 20e. OK → silent (no output)
  test('heartbeat-monitor (OK → silent)', async () => {
    const r = await monitorOnce('process.stdout.write("OK\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  // 20f. SKIP|outside-hours → silent
  test('heartbeat-monitor (SKIP|outside-hours → silent)', async () => {
    const r = await monitorOnce('process.stdout.write("SKIP|outside-hours\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  // 20g. precheck nonzero exit → HEARTBEAT_ERROR: precheck failed
  test('heartbeat-monitor (nonzero exit → HEARTBEAT_ERROR: precheck failed)', async () => {
    const r = await monitorOnce('process.stderr.write("crash\\n"); process.exit(1);\n');
    r.cleanup();
    expect(r.stdout).toContain('HEARTBEAT_ERROR: precheck failed');
  });

  // 20h. unknown verdict → HEARTBEAT_ERROR: unknown verdict
  test('heartbeat-monitor (unknown verdict → HEARTBEAT_ERROR: unknown verdict)', async () => {
    const r = await monitorOnce('process.stdout.write("WHATEVER\\n");\n');
    r.cleanup();
    expect(r.stdout).toContain('HEARTBEAT_ERROR: unknown verdict');
  });

  // 20j. liveness file written on every iteration
  test('heartbeat-monitor (liveness file written with fresh last_peek_at)', async () => {
    const before = Date.now();
    const r = await monitorOnce('process.stdout.write("OK\\n");\n');
    try {
      const livenessPath = path.join(r.hbDir, 'state', 'heartbeat-liveness.json');
      expect(fs.existsSync(livenessPath)).toBe(true);
      const liveness = JSON.parse(fs.readFileSync(livenessPath, 'utf-8'));
      expect(typeof liveness.last_peek_at).toBe('string');
      const t = new Date(liveness.last_peek_at).getTime();
      // date -u has 1s precision; allow up to 1s before `before`
      expect(t).toBeGreaterThanOrEqual(before - 1000);
      expect(t).toBeLessThanOrEqual(Date.now() + 5000);
    } finally {
      r.cleanup();
    }
  });

  // 20i. EVALUATE on iter-2 → HEARTBEAT_EVALUATE (suppression is first-iteration-only).
  // Runs without HEARTBEAT_MONITOR_ONCE so the loop can reach iter-2, bounded by
  // observed iterations rather than a wall-clock window.
  test('heartbeat-monitor (iter-2 EVALUATE → HEARTBEAT_EVALUATE, suppression not permanent)', async () => {
    const { stdout } = await runMonitorUntil({
      scriptPath: MONITOR_SH,
      stubBody: 'process.stdout.write("EVALUATE\\n");\n',
      envVar: 'HEARTBEAT_PRECHECK',
      interval: '0.2',
      iters: 2,
    });
    expect(stdout).toContain('HEARTBEAT_EVALUATE');
  }, 45000);
});
