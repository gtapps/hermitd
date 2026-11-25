import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { PLUGIN_ROOT, SCRIPTS_DIR, runBash } from './helpers/run';
import { setupWorkdir, type Workdir, hermit, write, readJson } from './helpers/workdir';

describe('check-upgrade.sh', () => {
  let wd: Workdir;
  let out = '';

  beforeAll(async () => {
    wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), '{"_hermit_versions":{"hermitd":"0.0.0"}}');
    const r = await runBash(path.join(SCRIPTS_DIR, 'check-upgrade.sh'), {
      args: [PLUGIN_ROOT], cwd: wd.dir,
    });
    out = r.stdout + r.stderr;
  });
  afterAll(() => wd.cleanup());

  test('check-upgrade.sh', () => {
    expect(out.length).toBeGreaterThan(0);
  });

  test('check-upgrade output', () => {
    expect(JSON.parse(out).status).toBe('upgrade_available');
  });
});

describe('check-upgrade.sh verdict', () => {
  const pluginVer = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version;
  async function run(config: any) {
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
      const r = await runBash(path.join(SCRIPTS_DIR, 'check-upgrade.sh'), { args: [PLUGIN_ROOT], cwd: wd.dir });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe('');
      return r.stdout;
    } finally { wd.cleanup(); }
  }

  test('gap -> upgrade_available with both versions and always_on', async () => {
    for (const [cfg, alwaysOn] of [[{ always_on: true }, true], [{ always_on: false }, false], [{}, false]] as const) {
      const out = await run({ ...cfg, _hermit_versions: { 'hermitd': '0.0.0' } });
      expect(JSON.parse(out)).toEqual({ status: 'upgrade_available', plugin_version: pluginVer, config_version: '0.0.0', always_on: alwaysOn });
    }
  });

  test('no gap -> bare OK', async () => {
    expect(await run({ always_on: true, _hermit_versions: { 'hermitd': pluginVer } })).toBe('OK\n');
  });

  // Config ahead of the loaded plugin = a stale install copy is loaded. evolve cannot
  // fix that state (it reads as up-to-date, and finalizing would downgrade the stamp),
  // so this is its own status, never upgrade_available, under any always_on value.
  test('config ahead of plugin -> stale_plugin_runtime with the loaded root', async () => {
    for (const always_on of [true, false]) {
      const out = await run({ always_on, _hermit_versions: { 'hermitd': '99.0.0' } });
      expect(JSON.parse(out)).toEqual({ status: 'stale_plugin_runtime', plugin_version: pluginVer, config_version: '99.0.0', plugin_root: PLUGIN_ROOT });
    }
  });

  test('corrupt config.json -> upgrade_available, so evolve reports the real error', async () => {
    expect(JSON.parse(await run('not json')).status).toBe('upgrade_available');
  });

  test('unparseable version on either side -> bare OK', async () => {
    expect(await run({ _hermit_versions: { 'hermitd': 'garbage' } })).toBe('OK\n');
  });
});
