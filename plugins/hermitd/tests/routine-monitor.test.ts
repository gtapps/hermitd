import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SCRIPTS_DIR, runBash } from './helpers/run';
import { setupGitWorkdir } from './helpers/workdir';
import { runMonitorUntil } from './helpers/run-monitor';

describe('routine-monitor', () => {
  const RT_MONITOR_SH = path.join(SCRIPTS_DIR, 'routine-monitor.sh');

  function makeRtStub(body: string): { path: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stub-'));
    const p = path.join(dir, 'stub.js');
    fs.writeFileSync(p, body);
    return { path: p, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
  }

  async function rtMonitorOnce(stubBody: string): Promise<{ stdout: string; cleanup(): void }> {
    const stub = makeRtStub(stubBody);
    const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-hermit-'));
    try {
      const r = await runBash(RT_MONITOR_SH, {
        args: ['60', rtDir],
        env: { ROUTINE_MONITOR_ONCE: '1', ROUTINE_DUE_SCRIPT: stub.path },
      });
      return {
        stdout: r.stdout.trimEnd(),
        cleanup: () => { try { fs.rmSync(rtDir, { recursive: true, force: true }); } catch {} },
      };
    } finally {
      stub.cleanup();
    }
  }

  test('routine-monitor (non-empty ROUTINE_DUE line echoed as-is)', async () => {
    const r = await rtMonitorOnce('process.stdout.write("ROUTINE_DUE [hermit-routine:reflect]\\n");\n');
    r.cleanup();
    expect(r.stdout).toBe('ROUTINE_DUE [hermit-routine:reflect]');
  });

  test('routine-monitor under the supervisor exits on a fallback recorded for this boot, polls on a stale one', async () => {
    const stub = makeRtStub('process.stdout.write("ROUTINE_DUE [hermit-routine:reflect]\\n");\n');
    const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-hermit-'));
    try {
      fs.mkdirSync(path.join(rtDir, 'state'), { recursive: true });
      fs.writeFileSync(path.join(rtDir, 'state', '.boot-id'), 'boot-now\n');
      const runtime = path.join(rtDir, 'state', 'routine-monitor.runtime.json');
      const env = { ROUTINE_MONITOR_ONCE: '1', ROUTINE_DUE_SCRIPT: stub.path, MONITOR_SUPERVISOR_PID: '1' };

      fs.writeFileSync(runtime, JSON.stringify({ mode: 'croncreate-fallback', boot_id: 'boot-now' }));
      const current = await runBash(RT_MONITOR_SH, { args: ['60', rtDir], env });
      expect(current.exitCode).toBe(0);
      expect(current.stdout).toBe('');

      fs.writeFileSync(runtime, JSON.stringify({ mode: 'croncreate-fallback', boot_id: 'boot-old' }));
      const stale = await runBash(RT_MONITOR_SH, { args: ['60', rtDir], env });
      expect(stale.stdout.trimEnd()).toBe('ROUTINE_DUE [hermit-routine:reflect]');
    } finally {
      stub.cleanup();
      fs.rmSync(rtDir, { recursive: true, force: true });
    }
  });

  test('routine-monitor (empty stdout → silent)', async () => {
    const r = await rtMonitorOnce('process.stdout.write("");\n');
    r.cleanup();
    expect(r.stdout).toBe('');
  });

  test('routine-monitor silently sweeps an orphaned locked bridge worktree', async () => {
    const wd = setupGitWorkdir();
    const stub = makeRtStub('process.stdout.write("");\n');
    try {
      const rtDir = path.join(wd.dir, '.hermit');
      const wt = path.join(wd.dir, '.claude', 'worktrees', 'bridge-monitor');
      fs.mkdirSync(rtDir, { recursive: true });
      execFileSync('git', ['-C', wd.dir, 'worktree', 'add', '-q', '-b', 'bridge-monitor', wt]);
      execFileSync('git', ['-C', wd.dir, 'worktree', 'lock', wt]);
      // Past the unattended sweep's brand-new grace period (rc-server.ts).
      const aged = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(path.join(wt, '.git'), aged, aged);

      const r = await runBash(RT_MONITOR_SH, {
        args: ['60', rtDir],
        env: { ROUTINE_MONITOR_ONCE: '1', ROUTINE_DUE_SCRIPT: stub.path },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
      expect(fs.existsSync(wt)).toBe(false);
    } finally {
      stub.cleanup();
      wd.cleanup();
    }
  });

  test('routine-monitor (routine-due nonzero exit → ROUTINE_MONITOR_ERROR)', async () => {
    const r = await rtMonitorOnce('process.stderr.write("crash\\n"); process.exit(1);\n');
    r.cleanup();
    expect(r.stdout).toContain('ROUTINE_MONITOR_ERROR: routine-due failed');
  });

  // Loop reaches iter-2 without ONCE — confirms no per-iteration suppression
  // (unlike heartbeat's cold-start damper, routine-due's init-to-now semantics
  // already make iter-1 safe, so no suppression is needed here). Bounded by
  // observed iterations rather than a wall-clock window.
  test('routine-monitor (loop reaches iter-2 without ONCE)', async () => {
    const { stdout } = await runMonitorUntil({
      scriptPath: RT_MONITOR_SH,
      stubBody: 'process.stdout.write("ROUTINE_DUE [hermit-routine:x]\\n");\n',
      envVar: 'ROUTINE_DUE_SCRIPT',
      interval: '0.2',
      iters: 2,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  }, 45000);

  const countErrors = (s: string) => s.split('\n').filter(l => l.includes('ROUTINE_MONITOR_ERROR')).length;

  // Persistent failure: 1st emits, every consecutive failure suppressed (count never
  // reaches 60 across the 5 observed iterations), so exactly one error line.
  test('routine-monitor (consecutive failures throttled to one error line)', async () => {
    const { stdout } = await runMonitorUntil({
      scriptPath: RT_MONITOR_SH,
      stubBody: 'process.exit(1);\n',
      envVar: 'ROUTINE_DUE_SCRIPT',
      interval: '0.2',
      iters: 5,
    });
    expect(countErrors(stdout)).toBe(1);
  }, 45000);

  // Alternating fail/success (odd calls fail via a counter file): each success resets the
  // counter, so each subsequent failure is a fresh streak that re-emits — ≥2 error lines
  // proves the reset re-arms emission (without reset it would stay at exactly 1).
  test('routine-monitor (success resets the throttle → next failure re-emits)', async () => {
    const { stdout } = await runMonitorUntil({
      scriptPath: RT_MONITOR_SH,
      stubBody: `const cf=path.join(d,'.rtcount');
let m=0; try{m=parseInt(fs.readFileSync(cf,'utf8'))||0;}catch{}
m++; fs.writeFileSync(cf,String(m));
if(m%2===1) process.exit(1);
`,
      envVar: 'ROUTINE_DUE_SCRIPT',
      interval: '0.2',
      iters: 5,
    });
    expect(countErrors(stdout)).toBeGreaterThanOrEqual(2);
  }, 45000);
});
