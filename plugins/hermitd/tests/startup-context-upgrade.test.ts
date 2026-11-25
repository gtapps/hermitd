import { describe, test, expect } from 'bun:test';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { setupWorkdir, hermit, write, readJson } from './helpers/workdir';

// startup-context.ts composes the SessionStart section from check-upgrade.sh's verdict.
describe('startup-context upgrade section', () => {
  const pluginVer = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version;
  async function run(configObj: any) {
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify(configObj));
      const r = await runScript('startup-context.ts', {
        cwd: wd.dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_RESIDENT: '1' }, stdin: '{"source":"startup"}',
      });
      return r.stdout;
    } finally { wd.cleanup(); }
  }

  test('always_on=true + gap -> the upgrade runs by itself, no directive', async () => {
    const out = await run({ always_on: true, _hermit_versions: { 'hermitd': '0.0.0' } });
    expect(out).toContain('---Upgrade Available---');
    expect(out).toContain('runs by itself');
    expect(out).not.toContain('REQUIRED');
    expect(out).not.toContain('/hermitd:hermit-evolve');
  });

  test('always_on=false + gap -> the operator types the upgrade command', async () => {
    const out = await run({ always_on: false, _hermit_versions: { 'hermitd': '0.0.0' } });
    expect(out).toContain('---Upgrade Available---');
    expect(out).toContain('type /hermitd:hermit-evolve in a terminal or the Claude app');
    expect(out).not.toContain('REQUIRED');
  });

  test('no gap -> no upgrade section', async () => {
    const out = await run({ always_on: true, _hermit_versions: { 'hermitd': pluginVer } });
    expect(out).not.toContain('---Upgrade Available---');
    expect(out).not.toContain('---Stale Plugin Runtime---');
  });

  test('config ahead of plugin -> stale-runtime notice, never an evolve directive', async () => {
    for (const always_on of [true, false]) {
      const out = await run({ always_on, _hermit_versions: { 'hermitd': '99.0.0' } });
      const section = out.slice(out.indexOf('---Stale Plugin Runtime---'));
      expect(out).toContain('---Stale Plugin Runtime---');
      expect(out).not.toContain('---Upgrade Available---');
      expect(section).not.toContain('REQUIRED');
      expect(section).not.toContain('/hermitd:hermit-evolve');
      expect(section).toContain(`v${pluginVer}`);
      expect(section).toContain('v99.0.0');
      expect(section).toContain(PLUGIN_ROOT); // the loaded root identifies the stale entry
    }
  });

  // The section body is sliced to BUDGETS.upgrade (500). The install path is
  // machine-dependent and printed last, so only the fixed prose is budgeted here.
  test('stale-runtime prose leaves room for the path within the 500-char budget', async () => {
    const out = await run({ always_on: true, _hermit_versions: { 'hermitd': '99.0.0' } });
    const section = out.slice(out.indexOf('---Stale Plugin Runtime---') + '---Stale Plugin Runtime---\n'.length);
    expect(section.split('Loaded from:')[0].length).toBeLessThanOrEqual(350);
  });
});
