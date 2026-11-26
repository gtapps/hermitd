import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from './workdir';

// -------------------------------------------------------
// Shared: iteration-bounded monitor runner (heartbeat-monitor.sh /
// routine-monitor.sh). Both scripts loop forever with no iteration bound, so
// a test that needs iteration 2 (or N consecutive iterations) must supply the
// bound itself. Waits for the stub to be invoked `iters` times, then kills
// the monitor — never bounded by wall-clock, so contention makes a run
// slower, never wrong. Throws naming the shortfall if `iters` is never
// reached within `deadlineMs`.
// -------------------------------------------------------

export async function runMonitorUntil(opts: {
  scriptPath: string;
  stubBody: string;
  envVar: 'HEARTBEAT_PRECHECK' | 'ROUTINE_DUE_SCRIPT';
  interval: string;
  iters: number;
  deadlineMs?: number;
}): Promise<{ stdout: string; liveness: Record<string, unknown> | null; firstWake?: string }> {
  const { scriptPath, stubBody, envVar, interval, iters, deadlineMs = 30000 } = opts;
  const stubTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-stub-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-hermit-'));
  try {
    const stubFile = path.join(stubTmp, 'stub.js');
    const counterFile = path.join(workDir, '.mon-iters');
    // Resolve the dir positionally-agnostically: routine-monitor invokes the
    // stub as `<dir>` but heartbeat-monitor invokes it as `--peek <dir>`.
    // Names are prefixed to avoid colliding with a stubBody's own top-level
    // consts (e.g. a stub that tracks its own scenario counter as `cf`/`n`).
    const prologue = `const fs=require('fs'), path=require('path');
const d=process.argv[process.argv.length-1];
const __iterFile=path.join(d,'.mon-iters');
let __iterN=0; try{__iterN=parseInt(fs.readFileSync(__iterFile,'utf8'))||0;}catch{}
__iterN++; fs.writeFileSync(__iterFile,String(__iterN));
`;
    fs.writeFileSync(stubFile, prologue + stubBody);
    // No `timeout` wrapper: SIGKILL sent to a `timeout`-wrapped process cannot
    // be forwarded (SIGKILL is uncatchable), which would leave bash and its
    // sleep child holding the stdout pipe open forever. Kill bash directly.
    const proc = Bun.spawn({
      cmd: ['bash', scriptPath, interval, workDir],
      env: { ...process.env, [envVar]: stubFile },
      stdin: Buffer.from(''),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutPromise = new Response(proc.stdout).text();
    // Wait for iters+1, not iters: the counter increments inside the *child*
    // stub, but the matching `echo`/case-statement output happens afterward in
    // the *parent* bash loop, so "child N has exited" does not itself prove
    // "bash already echoed iteration N". bash is single-threaded, though — it
    // cannot spawn iteration N+1's child until it has run iteration N's echo,
    // ONCE-check and sleep to completion. Waiting one iteration past the target
    // makes that ordering a guarantee instead of a race, which otherwise only
    // surfaces under CPU contention (confirmed empirically: this test flaked
    // under a saturated 12-core box before this +1).
    const target = iters + 1;
    const deadline = Date.now() + deadlineMs;
    let count = 0;
    while (Date.now() < deadline) {
      try { count = parseInt(fs.readFileSync(counterFile, 'utf8')) || 0; } catch {}
      if (count >= target) break;
      await Bun.sleep(25);
    }
    proc.kill('SIGKILL');
    await proc.exited;
    const stdout = await stdoutPromise;
    if (count < target) {
      throw new Error(`runMonitorUntil: stub invoked ${count}/${target} times within ${deadlineMs}ms`);
    }
    const livenessPath = path.join(workDir, 'state/heartbeat-liveness.json');
    const liveness = fs.existsSync(livenessPath) ? readJson(livenessPath) : null;
    const firstWakePath = path.join(workDir, 'first-wake');
    const firstWake = fs.existsSync(firstWakePath) ? fs.readFileSync(firstWakePath, 'utf8') : undefined;
    return { stdout, liveness, firstWake };
  } finally {
    try { fs.rmSync(stubTmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}
