// Behavioural coverage for the shared domain-hatch protocol.
//
// Everything the five domain hatches used to do in prose is asserted here
// against real files: the version floor read from the manifest (four hatches
// hardcoded a stale one), the two distinct stale-core remedies, the
// missing-`target`-key repair, and stamped settings targets.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { freshDirFactory } from './helpers/workdir';
import { runScript, SCRIPTS_DIR } from './helpers/run';
import { satisfiesFloor, preflight } from '../scripts/lib/domain-hatch/preflight';
import { resolvePlugin, isResolveError } from '../scripts/lib/domain-hatch/resolve';
import { ensureHatchTarget, readTargetState, optionsPath } from '../scripts/lib/domain-hatch/target';

const { freshDir, cleanup } = freshDirFactory('hermit-domain-hatch-');
afterAll(cleanup);

const PLUGIN = 'hermitd-feed';
// A project with core hatched plus a fake installed domain plugin, wired the
// way `claude plugin list --json` would report it.
function scaffold(opts: {
  coreApplied?: string | null;
  selfStamped?: string | null;
  selfVersion?: string;
  floor?: string;
  coreInstalled?: string;
  hatchOptions?: unknown;
} = {}) {
  const root = freshDir();
  const hermit = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });

  const versions: Record<string, string> = {};
  if (opts.coreApplied !== null) versions['hermitd'] = opts.coreApplied ?? '1.2.30';
  if (opts.selfStamped) versions[PLUGIN] = opts.selfStamped;
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({ _hermit_versions: versions }, null, 2));

  if (opts.hatchOptions !== undefined) {
    fs.writeFileSync(optionsPath(hermit), JSON.stringify(opts.hatchOptions, null, 2));
  }

  // The domain plugin's install tree.
  const install = path.join(root, 'installed', PLUGIN);
  fs.mkdirSync(path.join(install, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(install, 'state-templates'), { recursive: true });
  fs.writeFileSync(
    path.join(install, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN, version: opts.selfVersion ?? '1.0.4' }),
  );
  fs.writeFileSync(
    path.join(install, '.claude-plugin', 'hermit-meta.json'),
    JSON.stringify({ required_core_version: opts.floor ?? '>=1.2.30' }),
  );

  // A fake core plugin root, so core's own installed version is controllable.
  const coreRoot = path.join(root, 'installed', 'hermitd');
  fs.mkdirSync(path.join(coreRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(coreRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'hermitd', version: opts.coreInstalled ?? '1.2.33' }),
  );

  const list = [
    { id: `${PLUGIN}@mp`, scope: 'local', enabled: true, projectPath: root, installPath: install },
    { id: 'hermitd@mp', scope: 'local', enabled: true, projectPath: root, installPath: coreRoot },
  ];

  return { root, hermit, install, coreRoot, stdinJson: JSON.stringify(list) };
}

function run(s: ReturnType<typeof scaffold>) {
  return preflight({
    pluginId: PLUGIN,
    hermitDir: s.hermit,
    projectRoot: s.root,
    corePluginRoot: s.coreRoot,
    stdinJson: s.stdinJson,
  });
}

describe('resolvePlugin', () => {
  test('empty list falls back to the checkout when the manifest name matches', () => {
    const s = scaffold();
    const core = resolvePlugin([], 'hermitd', s.root, s.coreRoot);
    if (isResolveError(core)) throw new Error(core.error);
    expect(core.installPath).toBe(s.coreRoot);

    const feed = resolvePlugin([], PLUGIN, s.root, s.coreRoot);
    if (isResolveError(feed)) throw new Error(feed.error);
    expect(feed.installPath).toBe(s.install);
  });

  test('empty list without a matching checkout dir is plugin_list_unavailable', () => {
    const s = scaffold();
    const r = resolvePlugin([], 'no-such-hermit', s.root, s.coreRoot);
    expect(isResolveError(r)).toBe(true);
    if (isResolveError(r)) expect(r.error).toBe('plugin_list_unavailable');
  });

  test('a non-empty list without a match and no sibling dir is plugin_not_installed', () => {
    const s = scaffold();
    const r = resolvePlugin(JSON.parse(s.stdinJson), 'no-such-hermit', s.root, s.coreRoot);
    expect(isResolveError(r)).toBe(true);
    if (isResolveError(r)) expect(r.error).toBe('plugin_not_installed');
  });

  test('a registered core does not fall back to an unregistered sibling dir', () => {
    const s = scaffold();
    const list = JSON.parse(s.stdinJson).filter((e: any) => !e.id.startsWith(PLUGIN));
    const r = resolvePlugin(list, PLUGIN, s.root, s.coreRoot);
    expect(isResolveError(r)).toBe(true);
    if (isResolveError(r)) expect(r.error).toBe('plugin_not_installed');
  });

  test('a registered entry still wins when a checkout copy also exists', () => {
    const s = scaffold();
    const other = path.join(s.root, 'checkout', 'hermitd');
    fs.mkdirSync(path.join(other, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(other, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'hermitd', version: '9.9.9' }),
    );
    const r = resolvePlugin(JSON.parse(s.stdinJson), 'hermitd', s.root, other);
    if (isResolveError(r)) throw new Error(r.error);
    expect(r.installPath).toBe(s.coreRoot);
  });
});

describe('satisfiesFloor', () => {
  test('accepts an equal and a higher version', () => {
    expect(satisfiesFloor('1.2.30', '>=1.2.30')).toBe(true);
    expect(satisfiesFloor('1.3.0', '>=1.2.30')).toBe(true);
    expect(satisfiesFloor('2.0.0', '>=1.2.30')).toBe(true);
  });

  test('rejects a lower version, including a higher patch on a lower minor', () => {
    expect(satisfiesFloor('1.2.29', '>=1.2.30')).toBe(false);
    expect(satisfiesFloor('1.1.99', '>=1.2.30')).toBe(false);
    expect(satisfiesFloor('1.0.16', '>=1.2.30')).toBe(false);
  });

  test('an undeclared floor enforces nothing; an unknown version fails a declared one', () => {
    expect(satisfiesFloor('1.0.0', null)).toBe(true);
    expect(satisfiesFloor(null, '>=1.2.30')).toBe(false);
  });
});

describe('preflight', () => {
  test('no config.json means core was never hatched', () => {
    const s = scaffold();
    fs.rmSync(path.join(s.hermit, 'config.json'));
    expect(run(s)).toEqual({ plugin: PLUGIN, action: 'bootstrap_core', next_steps: ['/hermitd:hatch', `/${PLUGIN}:hatch`] });
  });

  // The bug the five hatches shipped: HA checked 1.0.16, fitness 1.0.26, feed
  // 1.2.22, forge 1.1.1, while every manifest declared >=1.2.30.
  test('a stale installed package is reported as a package problem', () => {
    const r = run(scaffold({ coreInstalled: '1.2.28', coreApplied: '1.2.28' }));
    expect(r.action).toBe('upgrade_core_package');
    expect(r.core_floor).toBe('>=1.2.30');
    expect(r.next_steps).toEqual(['hermitd update', '/hermitd:hermit-evolve', `/${PLUGIN}:hatch`]);
  });

  // The distinction that matters: hermit-evolve advances applied state and can
  // never advance installed code, so the two cases need different advice.
  test('current package with stale applied state is an evolve problem', () => {
    const r = run(scaffold({ coreInstalled: '1.2.33', coreApplied: '1.2.28' }));
    expect(r.action).toBe('upgrade_core_applied');
    expect(r.next_steps).toEqual(['/hermitd:hermit-evolve', `/${PLUGIN}:hatch`]);
  });

  test('full on a first run, verify when the stamped version already matches', () => {
    const full = run(scaffold({ selfVersion: '1.0.4' }));
    expect(full.action).toBe('full');
    expect(full.next_steps).toBeUndefined();
    expect(run(scaffold({ selfVersion: '1.0.4', selfStamped: '1.0.3' })).action).toBe('full');
    expect(run(scaffold({ selfVersion: '1.0.4', selfStamped: '1.0.4' })).action).toBe('verify');
  });

  test('an uninstalled plugin fails loud rather than resolving to a path', () => {
    const s = scaffold();
    const r = preflight({
      pluginId: 'not-a-plugin',
      hermitDir: s.hermit,
      projectRoot: s.root,
      corePluginRoot: s.coreRoot,
      stdinJson: s.stdinJson,
    });
    expect(r.error).toBe('plugin_not_installed');
    expect(r.action).toBeUndefined();
  });

  // coreScope() resolves a user-scope core (its user branch ignores
  // projectPath on purpose), and hatch-options.json is allowed to record
  // core_install_scope: "user" — so resolution must reach that tier too.
  test('a user-scope install still resolves', () => {
    const s = scaffold();
    const list = [
      { id: `${PLUGIN}@mp`, scope: 'user', enabled: true, projectPath: '/elsewhere', installPath: s.install },
      { id: 'hermitd@mp', scope: 'user', enabled: true, projectPath: '/elsewhere', installPath: s.coreRoot },
    ];
    const r = preflight({
      pluginId: PLUGIN,
      hermitDir: s.hermit,
      projectRoot: s.root,
      corePluginRoot: s.coreRoot,
      stdinJson: JSON.stringify(list),
    });
    expect(r.error).toBeUndefined();
    expect(r.action).toBe('full');
  });

  // hermit-evolve takes hatch_target from this verb and has no fallback of its
  // own; the stamped file needs no plugin list, so an
  // unreadable list must not strand it without a target.
  test('an unresolvable plugin still reports the target', () => {
    const s = scaffold({
      hatchOptions: { target: 'local', core_install_scope: 'local', stamped_at: 'x', stamped_by: 'y', version: '1.0.0' },
    });
    const r = preflight({
      pluginId: 'no-such-hermit',
      hermitDir: s.hermit,
      projectRoot: s.root,
      corePluginRoot: s.coreRoot,
      stdinJson: '[]',
    });
    expect(r.error).toBe('plugin_list_unavailable');
    expect(r.target).toBe('local');
    expect(r.target_file).toBe('CLAUDE.local.md');
    expect(r.needs_target_question).toBe(false);
  });

  test('reports the target once it exists', () => {
    const s = scaffold({
      hatchOptions: { target: 'committed', core_install_scope: 'project', stamped_at: 'x', stamped_by: 'y', version: '1.0.0' },
    });
    const r = run(s);
    expect(r.target).toBe('committed');
    expect(r.target_file).toBe('CLAUDE.md');
    expect(r.needs_target_question).toBe(false);
  });
});

describe('ensureHatchTarget', () => {
  test('creates the file with a first stamp', () => {
    const s = scaffold();
    const res = ensureHatchTarget(s.hermit, { target: 'local', core_scope: 'local', stampedBy: `${PLUGIN}:hatch`, version: '1.0.4' });
    expect(res.action).toBe('created');
    const written = JSON.parse(fs.readFileSync(optionsPath(s.hermit), 'utf8'));
    expect(written.target).toBe('local');
    expect(written.stamped_by).toBe(`${PLUGIN}:hatch`);
    expect(written.last_updated_by).toBeUndefined();
  });

  test('a later writer preserves the first stamp and records itself separately', () => {
    const s = scaffold();
    ensureHatchTarget(s.hermit, { target: 'local', core_scope: 'local', stampedBy: 'first:hatch', version: '1.0.0' });
    const before = JSON.parse(fs.readFileSync(optionsPath(s.hermit), 'utf8'));
    const res = ensureHatchTarget(s.hermit, { target: 'committed', core_scope: 'project', stampedBy: 'second:hatch', version: '2.0.0' });
    expect(res.action).toBe('updated');
    const after = JSON.parse(fs.readFileSync(optionsPath(s.hermit), 'utf8'));
    expect(after.stamped_by).toBe('first:hatch');
    expect(after.stamped_at).toBe(before.stamped_at);
    expect(after.last_updated_by).toBe('second:hatch');
    expect(after.target).toBe('committed');
  });

  // The hole the prose had: the write was gated on the FILE being absent while
  // the read fell back on the KEY being absent, so a file without `target`
  // silently resolved to committed CLAUDE.md forever.
  test('a file present without a usable target is a repair, and is asked about first', () => {
    const s = scaffold({ hatchOptions: { core_install_scope: 'user', version: '1.0.0' } });
    const state = readTargetState(s.hermit, { core_scope: 'user', target: 'local' });
    expect(state.target).toBeNull();
    expect(state.needs_target_question).toBe(true);

    const res = ensureHatchTarget(s.hermit, { target: 'local', core_scope: 'user', stampedBy: `${PLUGIN}:hatch`, version: '1.0.4' });
    expect(res.action).toBe('repaired');
    expect(JSON.parse(fs.readFileSync(optionsPath(s.hermit), 'utf8')).target).toBe('local');
  });

  test('rewriting identical content is a no-op', () => {
    const s = scaffold();
    const args = { target: 'local' as const, core_scope: 'local' as const, stampedBy: `${PLUGIN}:hatch`, version: '1.0.4' };
    ensureHatchTarget(s.hermit, args);
    expect(ensureHatchTarget(s.hermit, args).action).toBe('unchanged');
  });
});

describe('CLI contract', () => {
  // domain-hatch.ts no longer accepts --state-dir/--project-root/--plugin-list-file
  // (removed so a pre-approved call can't be redirected at another project's
  // state or fed a forged plugin list — see the script's header comment).
  // What those flags used to let a test override is asserted at the library
  // boundary instead: preflight()/ensureHatchTarget() take explicit roots
  // directly, same as every other describe() block in this file.
  test('preflight returns a verdict rather than throwing when resolution fails', () => {
    const s = scaffold();
    const res = preflight({
      pluginId: 'not-a-plugin',
      hermitDir: s.hermit,
      projectRoot: s.root,
      corePluginRoot: s.coreRoot,
      stdinJson: s.stdinJson,
    });
    expect(res.error).toBe('plugin_not_installed');
  });

  // The exit code is the half the library boundary cannot assert: a resolution
  // failure is `{error,...}` at exit 1, and still carries the target fields
  // hermit-evolve reads.
  //
  // Asserts the exit code and the verdict SHAPE, never the specific error code:
  // the plugin-list seam is gone, so this reaches the live `claude plugin list
  // --json`, and which failure comes back depends on the machine. With `claude`
  // present the list is non-empty and resolvePlugin() says plugin_not_installed;
  // on a CI runner that installs only bun the list is empty and it says
  // plugin_list_unavailable instead (resolve.ts distinguishes the two on
  // purpose — "absent" and "cannot tell" earn different operator advice).
  // Pinning the code here would fail on CI. The sibling library-boundary test
  // above owns the specific-code assertion, where the list is stubbed.
  test('preflight exits 1 on a resolution failure and keeps the target fields (CLI-level invariant)', async () => {
    const s = scaffold();
    const r = await runScript('domain-hatch.ts', {
      args: ['preflight', 'not-a-plugin'],
      env: { CLAUDE_PLUGIN_ROOT: s.coreRoot, AGENT_DIR: s.hermit },
    });
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.error).toMatch(/^plugin_/);
    expect(out.plugin).toBe('not-a-plugin');
    expect(out.needs_target_question).toBe(true);
    expect(out).not.toHaveProperty('ok');
    expect(out).not.toHaveProperty('message');
  });

  test('a missing verb is a usage error on stdout', async () => {
    const s = scaffold();
    const r = await runScript('domain-hatch.ts', {
      args: ['preflight'],
      env: { CLAUDE_PLUGIN_ROOT: s.coreRoot, AGENT_DIR: s.hermit },
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'usage' });
  });

  // bad_target is CLI-only argv validation (ensureHatchTarget() has no
  // equivalent check — it trusts its typed `target` param), and it exits
  // before pluginList() is ever reached, so this stays a real CLI test.
  test('a mutating verb exits non-zero on failure (bad --target)', async () => {
    const s = scaffold();
    const r = await runScript('domain-hatch.ts', {
      args: ['ensure-target', PLUGIN, '--target', 'sideways'],
      env: { CLAUDE_PLUGIN_ROOT: s.coreRoot, AGENT_DIR: s.hermit },
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toBe('bad_target');
  });

  test('a plugin id that looks like a path is rejected (CLI-level check)', async () => {
    const s = scaffold();
    const r = await runScript('domain-hatch.ts', {
      args: ['preflight', '../../etc/passwd'],
      env: { CLAUDE_PLUGIN_ROOT: s.coreRoot, AGENT_DIR: s.hermit },
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toBe('invalid_plugin_id');
  });

  test('unrecognized argv is rejected', async () => {
    const s = scaffold();
    const r = await runScript('domain-hatch.ts', {
      args: ['preflight', PLUGIN, '--state-dir', s.hermit],
      env: { CLAUDE_PLUGIN_ROOT: s.coreRoot, AGENT_DIR: s.hermit },
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toBe('unexpected_args');
  });

  test('the script is on disk where hermitd-exec.sh would dispatch it', () => {
    expect(fs.existsSync(path.join(SCRIPTS_DIR, 'domain-hatch.ts'))).toBe(true);
  });
});
