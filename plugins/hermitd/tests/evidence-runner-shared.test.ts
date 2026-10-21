import { test, expect } from 'bun:test';
import path from 'node:path';
import { runEvidence } from '../scripts/lib/evidence-runner';
import { withDir } from './helpers/workdir';
import { runScript } from './helpers/run';

const LOOP = 'while :; do :; done';

for (const cmd of ["printf evidence; test -d .hermit", "printf failure >&2; exit 7", "printf '%03000d' 0", "printf '%02047d' 0; printf '€'", LOOP]) {
  test(`shared runner matches later check: ${cmd}`, withDir(async dir => {
    // Only the loop needs a short deadline; a short one on a terminating
    // command races process startup under parallel CI load.
    const env = { LATER_CHECK_TIMEOUT_MS: cmd === LOOP ? '100' : '30000' };
    const added = await runScript('later.ts', { cwd: dir, args: ['add', path.join(dir, '.hermit'), '--claim', 'fixture check', '--cmd', cmd, '--due', '2026-09-16T00:00:00Z', '--origin', 'operator'] });
    expect(added.exitCode).toBe(0);
    const id = JSON.parse(added.stdout).id;
    const checked = await runScript('later.ts', { cwd: dir, env, args: ['check', path.join(dir, '.hermit'), id] });
    expect(checked.exitCode).toBe(0);
    const { exit, output, timed_out } = JSON.parse(checked.stdout);
    const previous = process.env.LATER_CHECK_TIMEOUT_MS;
    process.env.LATER_CHECK_TIMEOUT_MS = env.LATER_CHECK_TIMEOUT_MS;
    try {
      expect(JSON.stringify(await runEvidence(cmd, dir, 30))).toBe(JSON.stringify({ exit, output, timed_out }));
    } finally {
      if (previous === undefined) delete process.env.LATER_CHECK_TIMEOUT_MS;
      else process.env.LATER_CHECK_TIMEOUT_MS = previous;
    }
  }));
}
