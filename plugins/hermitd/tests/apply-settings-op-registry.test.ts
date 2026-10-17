import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { SEALED_SETTINGS_OPS, TERMINAL_ONLY_SETTINGS_OPS } from '../scripts/lib/settings/automode-entries';

const { freshDir, cleanup } = freshDirFactory('hermit-op-registry-');
afterAll(cleanup);

// The classifier's allow entry names the ops it covers, so an op added to the
// dispatch without reaching SEALED_SETTINGS_OPS (or being declared terminal-only)
// would run unattended under a policy that never mentioned it.
// TERMINAL_ONLY_SETTINGS_OPS are real but deliberately outside the classifier
// grant — reachable only from an explicit terminal choice.
describe('apply-settings.ts op registry', () => {
  test('every dispatched op is sealed or terminal-only', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, '..', 'scripts', 'apply-settings.ts'),
      'utf8',
    );
    const dispatched = [...src.matchAll(/^  case '([a-z-]+)':/gm)].map((m) => m[1]);
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.sort()).toEqual(
      [...SEALED_SETTINGS_OPS, ...TERMINAL_ONLY_SETTINGS_OPS].sort(),
    );
  });

  test('the usage message advertises exactly the sealed ops', async () => {
    const r = await runScript('apply-settings.ts', { args: [path.join(freshDir(), 'settings.local.json'), 'no-such-op'] });
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.error).toBe('unknown_op:no-such-op');
    for (const op of SEALED_SETTINGS_OPS) expect(out.valid_ops).toContain(op);
  });
});
