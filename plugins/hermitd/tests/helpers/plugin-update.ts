import { expect } from 'bun:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { runBash } from './run';

// Keep update-tail health fixtures independent of the real plugin discovery.
export const doctorPassStub = `if [ "$1 $2" = "hermitd-cli doctor" ]; then
  [ ! -f .hermit/state/update-in-progress.json ] || { echo 'marker still present' >&2; exit 8; }
  echo "fixture doctor pass $3"
  [ "\${LIVE_SCENARIO:-\${UPDATE_SCENARIO:-}}" != doctor-fails ] || exit 9
  if [ "\${LIVE_SCENARIO:-\${UPDATE_SCENARIO:-}}" = doctor-no-report ]; then exit 0; fi
  bun -e 'require("fs").writeFileSync(".hermit/state/doctor-report.json", JSON.stringify({ts: new Date().toISOString(), checks: [{id: "runtime", status: "ok"}, {id: "watchdog", status: "warn"}]}))'
  # A FAIL verdict exits 1 after writing its report; the pass still ran.
  [ "\${LIVE_SCENARIO:-\${UPDATE_SCENARIO:-}}" != verdict-fail ] || exit 1
  exit 0
fi
`;

// Duplicate ids must retain separate pins and outcomes for each install scope.
// `suffix` mimics the build suffix a plugin installed from a repository lists.
export const listDuplicateScopes = (proj: string, suffix = '') => JSON.stringify([
  { id: 'hermitd-scribe@hermitd', scope: 'project', enabled: true, version: `0.0.5${suffix}`, projectPath: proj },
  { id: 'hermitd@hermitd', scope: 'local', enabled: true, version: `1.2.0${suffix}`, projectPath: proj },
  { id: 'hermitd@hermitd', scope: 'project', enabled: true, version: `1.2.14${suffix}`, projectPath: proj },
]);

/** Interrupt the whole update process group only after its wait fixture is ready. */
export async function runInterruptedBash(
  scriptPath: string,
  opts: NonNullable<Parameters<typeof runBash>[1]>,
  readyFile: string,
) {
  const child = spawn('bash', [scriptPath, ...(opts.args ?? [])], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  try {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(readyFile) && Date.now() < deadline && child.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(readyFile)).toBe(true);
    process.kill(-child.pid!, 'SIGINT');
    const exitCode = await closed;
    return { exitCode, stdout, stderr };
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    await closed;
  }
}
