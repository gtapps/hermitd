// bun test port of tests/test-evolve-plan.sh — drives scripts/evolve-plan.ts
// (issue #211, the read-only pre-pass analyzer for hermit-evolve) against
// fixture project trees. Covers version gap, bounded CHANGELOG slice, deep
// config-key diff, template/bin byte-compare, the no_config vs 0.0.0 distinction, and operator-value preservation.
// Also covers registry-driven sibling hermit plans (work_pending, gap, no-gap
// path-unresolved, detected-but-unregistered, leak guard).
//
// Usage: bun test tests/evolve-plan.test.ts   (from the plugin root)

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPinnedScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { adoptDocker, applyEvolve, classifyDockerTemplates, dockerMergeChecks } from '../scripts/evolve-plan';
import { render, renderSources } from '../scripts/render-docker-templates';

const MARKER = '<!-- hermitd: Session Discipline -->';
const SIBLING_MARKER = '<!-- hermitd-dev: Dev Workflow -->';

// Fake plugin root with plugin version 1.1.7 (shared, read-only across tests).
let PR: string;
// Fake sibling plugin root (hermitd-dev at v0.4.3).
let SP: string;
// Path to a file containing `[]` — passed as --plugin-list-json to keep existing
// tests hermetic (no live `claude plugin list` spawn needed for non-sibling tests).
let EMPTY_PLUGIN_LIST: string;

// The only fixture here without its own `finally` cleanup: writePluginList()
// hands back a path, so removal has to wait for the end of the file.
const { freshDir: freshPluginListDir, cleanup: cleanupPluginListDirs } = freshDirFactory('hermit-pl-');

beforeAll(() => {
  PR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-evolve-pr-'));
  fs.mkdirSync(path.join(PR, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(PR, 'state-templates', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(PR, '.claude-plugin', 'plugin.json'), '{"version":"1.1.7"}\n');
  fs.writeFileSync(path.join(PR, 'CHANGELOG.md'), `# Changelog

## [1.1.7] - 2026-05-31
### Fixed
- newest change

### Upgrade Instructions
Run the evolve skill.

## [1.1.6] - 2026-05-28
### Added
- middle change

## [1.1.5] - 2026-05-25
### Added
- oldest change
`);
  fs.writeFileSync(path.join(PR, 'state-templates', 'config.json.template'), `{
  "_hermit_versions": {},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "quality_gate": {"tier": "budget"},
  "heartbeat": {"enabled": true, "waiting_timeout": null}
}
`);
  fs.writeFileSync(path.join(PR, 'state-templates', 'SHELL.md.template'), 'SHELL TEMPLATE V1\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'SESSION-REPORT.md.template'), 'REPORT TEMPLATE\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'PROPOSAL.md.template'), 'PROPOSAL TEMPLATE\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'bin', 'hermitd-run'), '#!/bin/sh\necho run\n');
  fs.mkdirSync(path.join(PR, 'state-templates', 'docker'), { recursive: true });
  fs.writeFileSync(path.join(PR, 'state-templates', 'docker', 'docker-entrypoint.hermit.sh.template'), 'ENTRYPOINT UPSTREAM\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'docker', 'docker-compose.hermit.yml.template'), 'COMPOSE UPSTREAM {{X}}\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'docker', 'Dockerfile.hermit.template'), 'DOCKERFILE UPSTREAM {{Y}}\n');

  // Sibling plugin root: hermitd-dev at v0.4.3.
  SP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-evolve-sp-'));
  fs.mkdirSync(path.join(SP, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(SP, 'state-templates'), { recursive: true });
  fs.writeFileSync(path.join(SP, '.claude-plugin', 'plugin.json'), '{"version":"0.4.3"}\n');
  fs.writeFileSync(path.join(SP, 'CHANGELOG.md'), `# Changelog

## [0.4.3] - 2026-06-01
### Fixed
- sibling fix C

## [0.4.2] - 2026-05-20
### Added
- sibling add B

## [0.4.1] - 2026-05-10
### Fixed
- sibling fix A

## [0.4.0] - 2026-05-01
### Added
- initial sibling release
`);

  // Empty plugin list fixture — used by existing tests to avoid spawning claude.
  EMPTY_PLUGIN_LIST = path.join(os.tmpdir(), 'hermit-empty-plugin-list.json');
  fs.writeFileSync(EMPTY_PLUGIN_LIST, '[]\n');
});

afterAll(() => {
  try { fs.rmSync(PR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(EMPTY_PLUGIN_LIST); } catch {}
  cleanupPluginListDirs();
});

/** Run a test body against a throwaway project tree, always cleaning up. */
function withProj(fn: (proj: string) => Promise<void> | void) {
  return async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-evolve-proj-'));
    fs.mkdirSync(path.join(proj, '.hermit'), { recursive: true });
    try { await fn(proj); } finally {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  };
}

const hermitDir = (proj: string) => path.join(proj, '.hermit');
const writeConfig = (proj: string, content: string) =>
  fs.writeFileSync(path.join(hermitDir(proj), 'config.json'), content);

/** Run evolve-plan and return the parsed plan.
 *  pluginListPath defaults to the empty-list fixture so tests don't spawn claude.
 *  Pass an explicit path for sibling tests that need a populated plugin list. */
async function runPlan(proj: string, _target?: string, pluginListPath?: string): Promise<any> {
  const args = [hermitDir(proj)];
  args.push(`--plugin-list-json=${pluginListPath ?? EMPTY_PLUGIN_LIST}`);
  const r = await runPinnedScript('evolve-plan.ts', hermitDir(proj), args, { env: { CLAUDE_PLUGIN_ROOT: PR } });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

// -------------------------------------------------------
// 1. Version gap + bounded changelog slice
// -------------------------------------------------------

test('version gap: from 1.1.6 -> to 1.1.7, not up_to_date', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.from).toBe('1.1.6');
  expect(d.to).toBe('1.1.7');
  expect(d.up_to_date).toBe(false);
  expect(d.errors).toEqual([]);
}));

test('changelog slice: only (1.1.6, 1.1.7], excludes older', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.changelog_versions).toEqual(['1.1.7']);
  const s = d.changelog_slice;
  expect(s).toContain('newest change');
  expect(s).toContain('Upgrade Instructions');
  expect(s).not.toContain('middle change');
  expect(s).not.toContain('oldest change');
}));

// -------------------------------------------------------
// 2. Up to date
// -------------------------------------------------------

test('up_to_date true when config == plugin version', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.7"}}');
  const d = await runPlan(proj, 'local');
  expect(d.up_to_date).toBe(true);
  expect(d.changelog_versions).toEqual([]);
  expect(d.loaded_core_older_than_applied).toBe(false);
}));

// -------------------------------------------------------
// 2b. Config stamped AHEAD of the loaded plugin = stale install, not an upgrade
// -------------------------------------------------------

// up_to_date collapses "ahead" into "current", so it cannot carry this state. The
// separate field is what lets the skill stop before Step 2/7 instead of running
// migrations and then stamping the OLDER loaded version over the applied one.
test('config ahead of loaded plugin -> loaded_core_older_than_applied', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.2.0"}}');
  const d = await runPlan(proj, 'local');
  expect(d.from).toBe('1.2.0');
  expect(d.to).toBe('1.1.7');
  expect(d.loaded_core_older_than_applied).toBe(true);
  expect(d.errors).toEqual([]);
}));

test('behind (normal upgrade) does NOT set loaded_core_older_than_applied', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.loaded_core_older_than_applied).toBe(false);
}));

// The destructive path: sibling drift keeps work_pending true, which is what walked the
// runner into Step 7 + Step 9 and the stamp downgrade. The verdict must fire anyway.
test('REGRESSION: config ahead + sibling gap -> still flagged, despite work_pending', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.2.0', 'hermitd-dev': '0.4.1' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.loaded_core_older_than_applied).toBe(true);
  expect(d.work_pending).toBe(true); // sibling work would otherwise carry the run forward
}));

// -------------------------------------------------------
// 3. New config keys: top-level + nested leaf reported, present omitted
// -------------------------------------------------------

test('new_config_keys: reports quality_gate + heartbeat.waiting_timeout, omits present', withProj(async (proj) => {
  writeConfig(proj, `{
  "_hermit_versions": {"hermitd": "1.1.6"},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "heartbeat": {"enabled": true}
}
`);
  const d = await runPlan(proj, 'local');
  const keys: Record<string, any> = {};
  for (const k of d.new_config_keys) keys[k.path] = k.default;
  expect(Object.keys(keys)).toContain('quality_gate');
  expect(keys['quality_gate']).toEqual({ tier: 'budget' });
  expect(Object.keys(keys)).toContain('heartbeat.waiting_timeout');
  expect(keys['heartbeat.waiting_timeout']).toBeNull();
  expect(Object.keys(keys)).not.toContain('model');
  expect(Object.keys(keys)).not.toContain('heartbeat.enabled');
}));

// -------------------------------------------------------
// 4. templates_changed / bin_changed: only differing/absent files
// -------------------------------------------------------

test('bootstrap (no manifest): diff + absent reported, identical skipped, manifest_bootstrap=true', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir(proj), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), 'DIFFERENT CONTENT\n');
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SESSION-REPORT.md.template'), 'REPORT TEMPLATE\n'); // identical to upstream
  // PROPOSAL.md.template absent -> class=missing
  fs.writeFileSync(path.join(hermitDir(proj), 'bin', 'hermitd-run'), '#!/bin/sh\necho CHANGED\n'); // differs
  const d = await runPlan(proj, 'local');

  expect(d.manifest_bootstrap).toBe(true);

  const tNames = d.templates_changed.map((f: any) => f.name);
  expect(tNames).not.toContain('SHELL.md.template');
  expect(tNames).toContain('PROPOSAL.md.template');
  expect(tNames).not.toContain('SESSION-REPORT.md.template'); // identical -> excluded

  const shell = d.templates_changed.find((f: any) => f.name === 'SHELL.md.template');
  expect(shell).toBeUndefined();
  expect(fs.readFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), 'utf8')).toBe('DIFFERENT CONTENT\n');

  const proposal = d.templates_changed.find((f: any) => f.name === 'PROPOSAL.md.template');
  expect(proposal.class).toBe('missing');

  expect(d.bin_changed).toHaveLength(1);
  expect(d.bin_changed[0].name).toBe('hermitd-run');
  expect(d.bin_changed[0].class).toBe('unmodified'); // bootstrap
  expect(d.bin_changed[0].boot_critical).toBe(true); // all bin/ are boot-critical
}));

// -------------------------------------------------------
// 4b. 3-way classification with manifest present
// -------------------------------------------------------

/** Write a template-manifest.json into the scratch project's state/ dir. */
function writeManifest(proj: string, files: Record<string, { sha256: string; plugin_version: string }>) {
  const stateDir = path.join(hermitDir(proj), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'template-manifest.json'), JSON.stringify({ version: 1, files }));
}

function writeRawManifest(proj: string, content: string) {
  const stateDir = path.join(hermitDir(proj), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'template-manifest.json'), content);
}

// Use real sha256 for fixtures — import the lib helper
import { sha256 } from '../scripts/lib/hash';

test('manifest: unmodified (on-disk == baseline, upstream changed) -> overwrite', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  const onDisk = 'OLD TEMPLATE\n';
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'PROPOSAL.md.template'), onDisk);
  // SESSION-REPORT identical to upstream -> excluded
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SESSION-REPORT.md.template'), 'REPORT TEMPLATE\n');
  // Manifest records the current on-disk hash as baseline (operator never touched it)
  writeManifest(proj, {
    'templates/PROPOSAL.md.template': { sha256: sha256(Buffer.from(onDisk)), plugin_version: '1.1.5' },
  });
  const d = await runPlan(proj, 'local');
  expect(d.manifest_bootstrap).toBeUndefined();
  const shell = d.templates_changed.find((f: any) => f.name === 'PROPOSAL.md.template');
  expect(shell).toBeDefined();
  expect(shell.class).toBe('unmodified');
}));

test('manifest: customized-kept (on-disk != baseline, upstream == baseline) -> kept', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  // Upstream template content (from the fake plugin root)
  const upstream = 'PROPOSAL TEMPLATE\n';
  // Operator edited on-disk
  const onDisk = 'OPERATOR CUSTOMIZED\n';
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'PROPOSAL.md.template'), onDisk);
  // Manifest baseline == upstream (template hasn't changed since hatch)
  writeManifest(proj, {
    'templates/PROPOSAL.md.template': { sha256: sha256(Buffer.from(upstream)), plugin_version: '1.1.6' },
  });
  const d = await runPlan(proj, 'local');
  const shell = d.templates_changed.find((f: any) => f.name === 'PROPOSAL.md.template');
  expect(shell).toBeDefined();
  expect(shell.class).toBe('customized-kept');
}));

test('manifest: conflict (on-disk != baseline, upstream != baseline) -> conflict', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  const onDisk = 'OPERATOR EDIT\n';
  const originalBaseline = 'OLD TEMPLATE V0\n'; // neither upstream nor on-disk
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'PROPOSAL.md.template'), onDisk);
  writeManifest(proj, {
    'templates/PROPOSAL.md.template': { sha256: sha256(Buffer.from(originalBaseline)), plugin_version: '1.1.0' },
  });
  const d = await runPlan(proj, 'local');
  const shell = d.templates_changed.find((f: any) => f.name === 'PROPOSAL.md.template');
  expect(shell).toBeDefined();
  expect(shell.class).toBe('conflict');
}));

test('manifest: missing (on-disk absent) -> missing regardless of manifest', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'bin'), { recursive: true });
  // hermitd-run absent -> class=missing, boot_critical=true
  writeManifest(proj, {
    'bin/hermitd-run': { sha256: sha256(Buffer.from('OLD WRAPPER\n')), plugin_version: '1.1.6' },
  });
  const d = await runPlan(proj, 'local');
  const run = d.bin_changed.find((f: any) => f.name === 'hermitd-run');
  expect(run).toBeDefined();
  expect(run.class).toBe('missing');
  expect(run.boot_critical).toBe(true);
}));

test('manifest-entry-absent: file on-disk but no manifest entry -> unmodified', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  // PROPOSAL.md.template differs from upstream but has no manifest entry
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'PROPOSAL.md.template'), 'SOME CONTENT\n');
  writeManifest(proj, {}); // empty manifest (has entries for nothing)
  const d = await runPlan(proj, 'local');
  expect(d.manifest_bootstrap).toBeUndefined(); // manifest exists, just no entry
  const shell = d.templates_changed.find((f: any) => f.name === 'PROPOSAL.md.template');
  expect(shell).toBeDefined();
  expect(shell.class).toBe('unmodified'); // no manifest entry -> seed-as-unmodified
}));

test('invalid manifest shape -> error before template/bin classification', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir(proj), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), 'OPERATOR CUSTOMIZED\n');
  fs.writeFileSync(path.join(hermitDir(proj), 'bin', 'hermitd-run'), '#!/bin/sh\necho customized\n');
  writeRawManifest(proj, '{"version":1}');

  const d = await runPlan(proj, 'local');
  expect(d.errors.map((e: any) => e.code)).toContain('manifest_invalid');
  expect(d.errors[0].message).toContain('files');
  expect(d.manifest_bootstrap).toBeUndefined();
  expect('templates_changed' in d).toBe(false);
  expect('bin_changed' in d).toBe(false);
}));

test('invalid manifest sha256 -> error before template/bin classification', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  writeRawManifest(proj, '{"version":1,"files":{"templates/SHELL.md.template":{"sha256":"abcdef"}}}');

  const d = await runPlan(proj, 'local');
  expect(d.errors.map((e: any) => e.code)).toContain('manifest_invalid');
  expect(d.errors[0].message).toContain('templates/SHELL.md.template');
  expect(d.manifest_bootstrap).toBeUndefined();
  expect('templates_changed' in d).toBe(false);
  expect('bin_changed' in d).toBe(false);
}));

// -------------------------------------------------------
// Core blocks are retired by the deterministic migration, never planned here.
for (const body of ['', `${MARKER}\nEdited rules.\n`, `${MARKER}\n${MARKER}\n`]) {
  test(`core plan omits instruction block fields: ${body.length}`, withProj(async (proj) => {
    writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.7"}}');
    fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'), body);
    const d = await runPlan(proj, 'local');
    expect(d.work_pending).toBe(false);
  }));
}

// -------------------------------------------------------
// 6. no_config: missing config.json -> errors[no_config], no top-level error key
// -------------------------------------------------------

test('no_config: missing config.json -> errors[no_config], single contract', withProj(async (proj) => {
  const d = await runPlan(proj, 'local');
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('no_config');
  // must not use a top-level error key
  expect('error' in d).toBe(false);
  // should not report a version when there is no config
  expect('from' in d).toBe(false);
}));

// -------------------------------------------------------
// 7. malformed config.json -> errors[config_json_invalid], not no_config
// -------------------------------------------------------

test('malformed config.json -> errors[config_json_invalid], not no_config', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":');
  const d = await runPlan(proj, 'local');
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('config_json_invalid');
  expect(codes).not.toContain('no_config');
  // should not report a version when config is invalid
  expect('from' in d).toBe(false);
}));

// -------------------------------------------------------
// 8. missing _hermit_versions only -> from 0.0.0, clean errors
// -------------------------------------------------------

test('missing _hermit_versions -> from 0.0.0, errors empty', withProj(async (proj) => {
  writeConfig(proj, '{"model":"sonnet"}');
  const d = await runPlan(proj, 'local');
  expect(d.from).toBe('0.0.0');
  expect(d.errors).toEqual([]);
}));

// -------------------------------------------------------
// 9. Operator value preserved: present nested key (non-default) omitted
//    (script-level guard for idempotent Step 9 — never re-lists a set key)
// -------------------------------------------------------

test('operator value preserved: set quality_gate.tier not re-listed', withProj(async (proj) => {
  writeConfig(proj, `{
  "_hermit_versions": {"hermitd": "1.1.6"},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "quality_gate": {"tier": "balanced"},
  "heartbeat": {"enabled": true, "waiting_timeout": "30m"}
}
`);
  const d = await runPlan(proj, 'local');
  const paths = d.new_config_keys.map((k: any) => k.path);
  expect(paths).not.toContain('quality_gate');
  expect(paths).not.toContain('heartbeat.waiting_timeout');
}));

// -------------------------------------------------------
// 11. Docker template drift — F1 (entrypoint, manifest-managed) + F2 (report-only)
// -------------------------------------------------------

const deployDocker = (proj: string, f: { entrypoint?: string; compose?: string; dockerfile?: string }) => {
  if (f.entrypoint !== undefined) fs.writeFileSync(path.join(proj, 'docker-entrypoint.hermit.sh'), f.entrypoint);
  if (f.compose !== undefined) fs.writeFileSync(path.join(proj, 'docker-compose.hermit.yml'), f.compose);
  if (f.dockerfile !== undefined) fs.writeFileSync(path.join(proj, 'Dockerfile.hermit'), f.dockerfile);
};
const dockerManifest = (proj: string, hashes: Record<string, string>) =>
  writeManifest(proj, Object.fromEntries(
    Object.entries(hashes).map(([k, v]) => [k, { sha256: v, plugin_version: '1.1.6' }])));

test('docker: no deployment -> entrypoint null, templates empty', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.docker_entrypoint).toBeNull();
  expect(d.docker_templates).toEqual([]);
}));

test('docker bootstrap (no manifest): entrypoint unmodified, templates unknown', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT OLD\n', compose: 'rendered\n', dockerfile: 'rendered\n' });
  const d = await runPlan(proj, 'local');
  expect(d.manifest_bootstrap).toBe(true);
  expect(d.docker_entrypoint.class).toBe('unmodified');
  expect(d.docker_entrypoint.boot_critical).toBe(true);
  const statuses = Object.fromEntries(d.docker_templates.map((t: any) => [t.name, t.status]));
  expect(statuses['docker-compose.hermit.yml']).toBe('unknown');
  expect(statuses['Dockerfile.hermit']).toBe('unknown');
}));

test('docker with manifest: compose match omitted, stale Dockerfile -> changed, identical entrypoint -> null', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT UPSTREAM\n', compose: 'rendered\n', dockerfile: 'rendered\n' });
  dockerManifest(proj, {
    'docker/docker-compose.hermit.yml.template': sha256(Buffer.from('COMPOSE UPSTREAM {{X}}\n')),
    'docker/Dockerfile.hermit.template': sha256(Buffer.from('DOCKERFILE OLD {{Y}}\n')), // stale baseline
  });
  const d = await runPlan(proj, 'local');
  expect(d.docker_entrypoint).toBeNull(); // on-disk identical to upstream
  const names = d.docker_templates.map((t: any) => t.name);
  expect(names).not.toContain('docker-compose.hermit.yml'); // upstream unchanged -> omitted
  expect(d.docker_templates).toContainEqual({ name: 'Dockerfile.hermit', status: 'changed' });
}));

const DOCKER_INPUTS = {
  packages: ['ffmpeg'],
  auth: 'oauth-token' as const,
  channels: { envLines: [] as string[], volumeLines: [] as string[] },
  networkMode: 'bridge' as const,
  gitIdentityMount: true,
  fleetMesh: false,
};

function writeDerivableDockerConfig(proj: string): void {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.6' },
    browser: { enabled: false },
    channels: {},
    docker: {
      packages: DOCKER_INPUTS.packages,
      network_mode: DOCKER_INPUTS.networkMode,
      fleet_mesh: DOCKER_INPUTS.fleetMesh,
    },
  }));
}

function realDockerSources() {
  const dockerDir = path.join(PLUGIN_ROOT, 'state-templates', 'docker');
  return {
    compose: fs.readFileSync(path.join(dockerDir, 'docker-compose.hermit.yml.template'), 'utf8'),
    dockerfile: fs.readFileSync(path.join(dockerDir, 'Dockerfile.hermit.template'), 'utf8'),
  };
}

function writePristineCompose(proj: string, contents: string): string {
  const pristinePath = path.join(
    hermitDir(proj),
    'state/pristine/docker/docker-compose.hermit.yml.template',
  );
  fs.mkdirSync(path.dirname(pristinePath), { recursive: true });
  fs.writeFileSync(pristinePath, contents);
  return pristinePath;
}

function classifyRealDockerTemplates(proj: string, composeHash: string) {
  return classifyDockerTemplates(
    path.join(PLUGIN_ROOT, 'state-templates'),
    proj,
    { 'docker/docker-compose.hermit.yml.template': { sha256: composeHash } },
  );
}

test('docker templates: explicit browser opt-out leaves rendered Docker files unchanged', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const rendered = render(DOCKER_INPUTS);
  deployDocker(proj, { compose: rendered.compose, dockerfile: rendered.dockerfile });
  const entries = classifyRealDockerTemplates(proj, sha256(Buffer.from(realDockerSources().compose)));
  expect(entries).toEqual([]);
}));

test('docker templates: verified pristine bytes expose a rendered base_path', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const current = realDockerSources();
  const baseCompose = current.compose.replace('# Defense in depth', '# Previous defense in depth');
  const baseRendered = renderSources(DOCKER_INPUTS, { ...current, compose: baseCompose });
  deployDocker(proj, {
    compose: `${baseRendered.compose}\nx-operator-setting: true\n`,
    dockerfile: baseRendered.dockerfile,
  });
  writePristineCompose(proj, baseCompose);

  const entries = classifyRealDockerTemplates(proj, sha256(Buffer.from(baseCompose)));
  const compose = entries.find((entry: any) => entry.name === 'docker-compose.hermit.yml');
  expect(compose.class).toBe('conflict');
  expect(compose.bootstrap).toBeUndefined();
  expect(fs.existsSync(compose.base_path)).toBe(true);
  expect(fs.existsSync(compose.theirs_path)).toBe(true);
}));

test('docker templates: a custom git identity source merges and survives the 3-way merge', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const current = realDockerSources();
  const baseCompose = current.compose.replace('# Defense in depth', '# Previous defense in depth');
  const baseRendered = renderSources(DOCKER_INPUTS, { ...current, compose: baseCompose });
  const customLine = '${PWD}/.claude.local/gitconfig:/home/claude/.gitconfig:ro';
  deployDocker(proj, {
    compose: baseRendered.compose.replace('${HOME}/.gitconfig:/home/claude/.gitconfig:ro', customLine),
    dockerfile: baseRendered.dockerfile,
  });
  writePristineCompose(proj, baseCompose);

  const entries = classifyRealDockerTemplates(proj, sha256(Buffer.from(baseCompose)));
  const compose = entries.find((entry: any) => entry.name === 'docker-compose.hermit.yml');
  expect(compose.class).toBe('conflict');
  expect(compose.base_path).toBeDefined();

  const ours = path.join(proj, 'docker-compose.hermit.yml');
  const merged = Bun.spawnSync({ cmd: ['git', 'merge-file', ours, compose.base_path, compose.theirs_path] });
  expect(merged.exitCode).toBe(0);
  const result = fs.readFileSync(ours, 'utf8');
  expect(result).toContain(customLine);
  expect(result).toContain('# Defense in depth');
}));

test('docker templates: a pristine compose with the retired hook-profile placeholder merges the line away', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const current = realDockerSources();
  const nodeOptions = '      - NODE_OPTIONS=--max-old-space-size=4096\n';
  const baseCompose = current.compose.replace(nodeOptions, `${nodeOptions}      - AGENT_HOOK_PROFILE={{AGENT_HOOK_PROFILE}}\n`);
  expect(baseCompose).not.toBe(current.compose);
  const baseRendered = renderSources(DOCKER_INPUTS, {
    ...current,
    compose: baseCompose.replace('{{AGENT_HOOK_PROFILE}}', 'strict'),
  });
  deployDocker(proj, {
    compose: `${baseRendered.compose}\nx-operator-setting: true\n`,
    dockerfile: baseRendered.dockerfile,
  });
  writePristineCompose(proj, baseCompose);

  const entries = classifyRealDockerTemplates(proj, sha256(Buffer.from(baseCompose)));
  const compose = entries.find((entry: any) => entry.name === 'docker-compose.hermit.yml');
  expect(compose.base_path).toBeDefined();

  const ours = path.join(proj, 'docker-compose.hermit.yml');
  const merged = Bun.spawnSync({ cmd: ['git', 'merge-file', ours, compose.base_path, compose.theirs_path] });
  expect(merged.exitCode).toBe(0);
  const result = fs.readFileSync(ours, 'utf8');
  expect(result).not.toContain('AGENT_HOOK_PROFILE');
  expect(result).toContain('x-operator-setting: true');
}));

test('docker templates: stale pristine bytes force bootstrap without base_path', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const current = realDockerSources();
  const rendered = render(DOCKER_INPUTS);
  deployDocker(proj, { compose: `${rendered.compose}\nx-operator-setting: true\n`, dockerfile: rendered.dockerfile });
  writePristineCompose(proj, `${current.compose}\nSTALE`);

  const entries = classifyRealDockerTemplates(proj, sha256(Buffer.from(current.compose)));
  const compose = entries.find((entry: any) => entry.name === 'docker-compose.hermit.yml');
  expect(compose.bootstrap).toBe(true);
  expect(compose.base_path).toBeUndefined();
  expect(fs.existsSync(compose.theirs_path)).toBe(true);
}));

test('docker templates: absent pristine bytes force bootstrap without base_path', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const current = realDockerSources();
  const rendered = render(DOCKER_INPUTS);
  deployDocker(proj, { compose: `${rendered.compose}\nx-operator-setting: true\n`, dockerfile: rendered.dockerfile });

  const entries = classifyRealDockerTemplates(proj, sha256(Buffer.from(current.compose)));
  const compose = entries.find((entry: any) => entry.name === 'docker-compose.hermit.yml');
  expect(compose.bootstrap).toBe(true);
  expect(compose.base_path).toBeUndefined();
}));

test('docker templates: underivable inputs retain report-only output', withProj((proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  deployDocker(proj, { compose: 'rendered\n', dockerfile: 'rendered\n' });
  const current = realDockerSources();
  const entries = classifyDockerTemplates(
    path.join(PLUGIN_ROOT, 'state-templates'),
    proj,
    { 'docker/docker-compose.hermit.yml.template': { sha256: sha256(Buffer.from(`${current.compose}old`)) } },
  );

  expect(entries).toContainEqual({ name: 'docker-compose.hermit.yml', status: 'changed' });
}));

test('evolve reference places the base_path and bootstrap merge branches in section 5d', () => {
  const reference = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/hermit-evolve/reference.md'), 'utf8');
  const section5c = reference.indexOf('### 5c.');
  const section5d = reference.indexOf('### 5d.');
  const section6 = reference.indexOf('### 6.', section5d);
  const body = reference.slice(section5d, section6);

  expect(section5d).toBeGreaterThan(section5c);
  expect(body).toContain('base_path');
  expect(body).toContain('bootstrap: true');
  expect(body).toContain('git merge-file');
  expect(body).toContain('kept(bootstrap');
  expect(body).not.toContain('Apply every operator hunk');
});

test('docker entrypoint per-file bootstrap: manifest present but NO docker key + customized entrypoint -> unmodified + bootstrap (forces .bak)', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT OPERATOR EDIT\n' }); // differs from upstream
  // Manifest exists (templates key) but has NO docker/ entrypoint baseline — the
  // exact data-loss scenario: an existing operator who never re-ran /docker-setup.
  dockerManifest(proj, { 'templates/SHELL.md.template': sha256(Buffer.from('x')) });
  const d = await runPlan(proj, 'local');
  expect(d.manifest_bootstrap).toBeUndefined(); // global bootstrap is FALSE (manifest present)
  expect(d.docker_entrypoint.class).toBe('unmodified');
  expect(d.docker_entrypoint.bootstrap).toBe(true); // -> Step 5c writes a recovery .bak
}));

test('docker entrypoint conflict: operator edited AND upstream moved', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT OPERATOR EDIT\n' });
  dockerManifest(proj, { 'docker/docker-entrypoint.hermit.sh': sha256(Buffer.from('ENTRYPOINT BASELINE\n')) });
  const d = await runPlan(proj, 'local');
  expect(d.docker_entrypoint.class).toBe('conflict');
  expect(d.docker_entrypoint.boot_critical).toBe(true);
  expect(d.docker_entrypoint.bootstrap).toBeUndefined(); // baseline present -> not a bootstrap
}));

test('docker entrypoint: base_path exposed when a pristine copy exists', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT OPERATOR EDIT\n' });
  dockerManifest(proj, { 'docker/docker-entrypoint.hermit.sh': sha256(Buffer.from('ENTRYPOINT BASELINE\n')) });
  const pristine = path.join(proj, '.hermit', 'state', 'pristine', 'docker');
  fs.mkdirSync(pristine, { recursive: true });
  fs.writeFileSync(path.join(pristine, 'docker-entrypoint.hermit.sh'), 'ENTRYPOINT BASELINE\n');

  const d = await runPlan(proj, 'local');
  expect(d.docker_entrypoint.class).toBe('conflict');
  expect(d.docker_entrypoint.base_path)
    .toBe(path.join(pristine, 'docker-entrypoint.hermit.sh'));
}));

test('docker entrypoint: base_path absent without a pristine copy', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  deployDocker(proj, { entrypoint: 'ENTRYPOINT OPERATOR EDIT\n' });
  dockerManifest(proj, { 'docker/docker-entrypoint.hermit.sh': sha256(Buffer.from('ENTRYPOINT BASELINE\n')) });
  const d = await runPlan(proj, 'local');
  expect(d.docker_entrypoint.class).toBe('conflict');
  expect(d.docker_entrypoint.base_path).toBeUndefined();
}));

// -------------------------------------------------------
// 12. Sibling hermit plans — registry-driven from _hermit_versions
// -------------------------------------------------------

/** Write a plugin-list fixture JSON to a temp file and return its path. */
function writePluginList(entries: any[]): string {
  const p = freshPluginListDir() + '/list.json';
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));
  return p;
}

/** Build a plugin-list entry pointing sibling installPath to SP. */
function siblingEntry(projectPath: string, opts: { scope?: string; enabled?: boolean; name?: string } = {}): any {
  return {
    id: `${opts.name ?? 'hermitd-dev'}@hermitd`,
    version: '0.4.3',
    scope: opts.scope ?? 'local',
    enabled: opts.enabled ?? true,
    installPath: SP,
    projectPath,
  };
}

test('sibling with gap: siblings[] entry has up_to_date=false and changelog_slice', withProj(async (proj) => {
  // sibling registered at 0.4.1; installed at 0.4.3 -> gap
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.1' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.errors).toEqual([]);
  expect(d.siblings).toHaveLength(1);
  const s = d.siblings[0];
  expect(s.name).toBe('hermitd-dev');
  expect(s.from).toBe('0.4.1');
  expect(s.to).toBe('0.4.3');
  expect(s.up_to_date).toBe(false);
  expect(s.changelog_slice).toContain('sibling fix C');
  expect(s.changelog_slice).toContain('sibling add B');
  expect(s.changelog_slice).not.toContain('initial sibling release'); // 0.4.0 excluded (from=0.4.1)
  expect(d.work_pending).toBe(true); // sibling has gap -> work_pending=true even when core is up_to_date
}));

// Note: the assertion above already covers the Finding 2 regression.
// work_pending must be true when a sibling has a gap, even if core is up_to_date.
test('REGRESSION Finding 2: core current + sibling behind -> work_pending=true', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.1' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.up_to_date).toBe(true);         // core is current
  expect(d.siblings[0].up_to_date).toBe(false); // sibling is not
  expect(d.work_pending).toBe(true);        // must be true so skill does NOT short-circuit
}));

test('sibling no-gap: up_to_date=true, no changelog_slice, work_pending reflects core', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.6', 'hermitd-dev': '0.4.3' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  const s = d.siblings[0];
  expect(s.up_to_date).toBe(true);
  expect('changelog_slice' in s).toBe(false);
  // core has a gap (1.1.6 < 1.1.7), so work_pending stays true
  expect(d.work_pending).toBe(true);
}));

test('siblings_path_unresolved: registered sibling not found in plugin list', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.1' },
  }));
  // Empty plugin list -> sibling can't be path-resolved
  const d = await runPlan(proj, 'local');
  expect(d.siblings).toHaveLength(0);
  expect(d.siblings_path_unresolved).toContain('hermitd-dev');
  // core is current (1.1.7) but a registered sibling is unassessed -> work_pending
  // must stay true so the skill runs Step 7 and surfaces it (not "up to date").
  expect(d.work_pending).toBe(true);
}));

test('siblings_detected_unregistered: project-effective hermit not in _hermit_versions', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7' },
  }));
  // Plugin list has a hermit entry for this project, but it's not in _hermit_versions
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.siblings).toHaveLength(0); // not in registry -> not in siblings[]
  expect(d.siblings_detected_unregistered).toContain('hermitd-dev');
}));

test('leak guard: duplicate hermit names in plugin list — only project-effective entry selected', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.1' },
  }));
  // Two entries for the same sibling: one for this project, one for another project.
  const otherProjectPath = '/tmp/other-project-entirely';
  const otherSP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-other-sp-'));
  try {
    fs.mkdirSync(path.join(otherSP, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(otherSP, '.claude-plugin', 'plugin.json'), '{"version":"9.9.9"}\n');
    const pl = writePluginList([
      { id: 'hermitd-dev@hermitd', version: '9.9.9', scope: 'local', enabled: true, installPath: otherSP, projectPath: otherProjectPath },
      siblingEntry(proj), // project-effective entry for this project at SP (v0.4.3)
    ]);
    const d = await runPlan(proj, 'local', pl);
    expect(d.siblings).toHaveLength(1);
    expect(d.siblings[0].install_path).toBe(SP);  // selected THIS project's entry
    expect(d.siblings[0].to).toBe('0.4.3');       // NOT 9.9.9 from the other project
  } finally {
    try { fs.rmSync(otherSP, { recursive: true, force: true }); } catch {}
  }
}));

test('leak guard: scope precedence — local scope wins over project when both match', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.1' },
  }));
  // Two entries for same sibling at same projectPath: one local, one project scope.
  // Local scope should win (local overrides project, matching resolve-siblings.ts);
  // localSP is at 0.4.2.
  const localSP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-local-sp-'));
  try {
    fs.mkdirSync(path.join(localSP, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(localSP, '.claude-plugin', 'plugin.json'), '{"version":"0.4.2"}\n');
    const pl = writePluginList([
      { id: 'hermitd-dev@hermitd', version: '0.4.2', scope: 'local', enabled: true, installPath: localSP, projectPath: proj },
      { id: 'hermitd-dev@hermitd', version: '0.4.3', scope: 'project', enabled: true, installPath: SP, projectPath: proj },
    ]);
    const d = await runPlan(proj, 'local', pl);
    expect(d.siblings[0].install_path).toBe(localSP);
    expect(d.siblings[0].to).toBe('0.4.2');
  } finally {
    try { fs.rmSync(localSP, { recursive: true, force: true }); } catch {}
  }
}));

test('invalid --plugin-list-json: siblings empty, siblings_warnings set, core proceeds', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.6', 'hermitd-dev': '0.4.1' },
  }));
  const badPath = path.join(os.tmpdir(), 'hermit-bad-pl-' + Date.now() + '.json');
  fs.writeFileSync(badPath, 'NOT JSON {{');
  try {
    const d = await runPlan(proj, 'local', badPath);
    expect(d.errors).toEqual([]); // core errors must be clean
    expect(d.siblings).toHaveLength(0); // sibling resolution skipped
    expect(d.siblings_warnings).toBeDefined();
    expect(d.siblings_warnings[0]).toContain('plugin-list unavailable');
    // Core analysis still ran
    expect(d.from).toBe('1.1.6');
    expect(d.up_to_date).toBe(false);
  } finally {
    try { fs.rmSync(badPath); } catch {}
  }
}));

test('from > to (downgrade): treated as no-gap, warning emitted', withProj(async (proj) => {
  // Config claims 0.4.5 but installed is 0.4.3 — a rollback scenario.
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.5' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  const s = d.siblings[0];
  expect(s.up_to_date).toBe(true);   // from(0.4.5) > to(0.4.3) -> no bump
  expect('changelog_slice' in s).toBe(false);
  expect(d.siblings_warnings?.some((w: string) => w.includes('downgrade'))).toBe(true);
}));

test('work_pending: all current -> false', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.3' },
  }));
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.up_to_date).toBe(true);
  expect(d.siblings[0].up_to_date).toBe(true);
  expect(d.work_pending).toBe(false);
}));

test('changelog root tokens resolve to each owning plugin install', withProj(async (proj) => {
  const coreRoot = path.join(proj, 'core-install');
  const siblingRoot = path.join(proj, 'sibling-install');
  fs.cpSync(PR, coreRoot, { recursive: true });
  fs.cpSync(SP, siblingRoot, { recursive: true });
  const instructions = '\n### Upgrade Instructions\nRun ${CLAUDE_PLUGIN_ROOT}/scripts/one.ts and <plugin_root>/scripts/two.ts.\n';
  fs.writeFileSync(path.join(coreRoot, 'CHANGELOG.md'), '## [1.1.7]\n' + instructions);
  fs.writeFileSync(path.join(siblingRoot, 'CHANGELOG.md'), '## [0.4.3]\n' + instructions);
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.6', 'hermitd-dev': '0.4.1' },
  }));
  const pluginList = writePluginList([{ ...siblingEntry(proj), installPath: siblingRoot }]);
  const result = await runPinnedScript('evolve-plan.ts', hermitDir(proj), [hermitDir(proj), `--plugin-list-json=${pluginList}`], {
    env: { CLAUDE_PLUGIN_ROOT: coreRoot },
  });
  expect(result.exitCode).toBe(0);
  const plan = JSON.parse(result.stdout);
  expect(plan.errors).toEqual([]);
  expect(plan.siblings).toHaveLength(1);
  for (const [slice, ownRoot, otherRoot] of [
    [plan.changelog_slice, coreRoot, siblingRoot],
    [plan.siblings[0].changelog_slice, siblingRoot, coreRoot],
  ]) {
    expect(slice).toContain(`${ownRoot}/scripts/one.ts`);
    expect(slice).toContain(`${ownRoot}/scripts/two.ts`);
    expect(slice).not.toContain(otherRoot);
    expect(slice).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(slice).not.toContain('<plugin_root>');
  }
}));

test('Docker browser toggles leave the gated Dockerfile and operator edits unchanged', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const source = realDockerSources();
  const pristine = path.join(hermitDir(proj), 'state/pristine/docker/Dockerfile.hermit.template');
  fs.mkdirSync(path.dirname(pristine), { recursive: true });
  fs.writeFileSync(pristine, source.dockerfile);
  const manifest = { 'docker/Dockerfile.hermit.template': { sha256: sha256(Buffer.from(source.dockerfile)) } };
  const rendered = render(DOCKER_INPUTS);
  deployDocker(proj, { compose: rendered.compose, dockerfile: rendered.dockerfile + '\nRUN echo operator-customization\n' });
  for (const enabled of [true, false]) {
    const configFile = path.join(hermitDir(proj), 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.browser.enabled = enabled;
    fs.writeFileSync(configFile, JSON.stringify(config));
    const entries = classifyDockerTemplates(path.join(PLUGIN_ROOT, 'state-templates'), proj, manifest);
    const entry = entries.find((row: any) => row.name === 'Dockerfile.hermit');
    expect(entry.class).toBe('customized-kept');
    const ours = path.join(proj, 'Dockerfile.hermit');
    const result = fs.readFileSync(ours, 'utf8');
    expect(result).toContain('RUN echo operator-customization');
    expect(result).toContain('ARG HERMIT_BROWSER=1');
  }
}));

function applyFixture(proj: string, pluginRoot = PR) {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  return () => applyEvolve(hermitDir(proj), pluginRoot, EMPTY_PLUGIN_LIST);
}
function diskSnapshot(root: string): Record<string, number> {
  const result: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, file.name);
      if (file.isDirectory()) walk(full);
      else result[path.relative(root, full)] = fs.statSync(full).mtimeMs;
    }
  };
  walk(root);
  return result;
}

test('apply restores missing raw files, seeds upstream and repeats without writes', withProj((proj) => {
  const apply = applyFixture(proj);
  const receipt = apply();
  expect(receipt.applied).toContainEqual({ file: 'bin/hermitd-run', outcome: 'restored' });
  expect(receipt.applied).toContainEqual({ file: 'templates/PROPOSAL.md.template', outcome: 'restored' });
  expect(fs.statSync(path.join(hermitDir(proj), 'bin/hermitd-run')).mode & 0o111).toBe(0o111);
  const before = diskSnapshot(proj);
  expect(apply().applied).toEqual([]);
  expect(diskSnapshot(proj)).toEqual(before);
}));

test('apply handles unmodified, template conflict, boot conflict and customized-kept', withProj((proj) => {
  const apply = applyFixture(proj); apply();
  const dir = hermitDir(proj), template = path.join(dir, 'templates/PROPOSAL.md.template'), bin = path.join(dir, 'bin/hermitd-run');
  fs.writeFileSync(template, 'operator template');
  fs.writeFileSync(bin, 'operator wrapper');
  const manifest = path.join(dir, 'state/template-manifest.json');
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  data.files['templates/PROPOSAL.md.template'].sha256 = sha256(Buffer.from('old template'));
  data.files['bin/hermitd-run'].sha256 = sha256(Buffer.from('old wrapper'));
  fs.writeFileSync(manifest, JSON.stringify(data));
  const receipt = apply();
  expect(fs.readFileSync(template, 'utf8')).toBe('operator template');
  expect(fs.readFileSync(template + '.new', 'utf8')).toBe('PROPOSAL TEMPLATE\n');
  expect(fs.readFileSync(bin + '.bak', 'utf8')).toBe('operator wrapper');
  expect(receipt.applied).toContainEqual({ file: 'bin/hermitd-run', outcome: 'refreshed' });
  expect(apply().applied).toEqual([]);
  // Upstream equals baseline, so an operator-only change remains live.
  fs.writeFileSync(bin, 'new operator wrapper');
  expect(apply().remaining).toContainEqual({ file: 'bin/hermitd-run', class: 'customized-kept', base_path: null, theirs_path: null, merged_path: null, bak: null });
  // A baseline-identical project copy is safe to refresh.
  data.files['bin/hermitd-run'].sha256 = sha256(Buffer.from('new operator wrapper'));
  fs.writeFileSync(manifest, JSON.stringify(data));
  expect(apply().applied).toContainEqual({ file: 'bin/hermitd-run', outcome: 'refreshed' });
}));

test('apply bootstrap backups preserve existing raw content', withProj((proj) => {
  const apply = applyFixture(proj), dir = hermitDir(proj);
  fs.mkdirSync(path.join(dir, 'templates'));
  fs.writeFileSync(path.join(dir, 'templates/PROPOSAL.md.template'), 'operator original');
  deployDocker(proj, { entrypoint: 'old entrypoint' });
  apply();
  expect(fs.readFileSync(path.join(dir, 'templates/PROPOSAL.md.template.bak'), 'utf8')).toBe('operator original');
  const backups = fs.readdirSync(path.join(dir, 'state')).filter(name => name.startsWith('docker-entrypoint.hermit.sh.') && name.endsWith('.bak'));
  expect(backups).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, 'state', backups[0]), 'utf8')).toBe('old entrypoint');
}));

test('apply never changes entrypoint conflicts or customized-kept with a base', withProj((proj) => {
  const apply = applyFixture(proj); apply();
  const dir = hermitDir(proj), file = path.join(proj, 'docker-entrypoint.hermit.sh');
  fs.writeFileSync(file, 'operator');
  for (const base of ['old entrypoint', 'ENTRYPOINT UPSTREAM\n']) {
    const manifest = path.join(dir, 'state/template-manifest.json');
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    data.files['docker/docker-entrypoint.hermit.sh'] = { sha256: sha256(Buffer.from(base)) };
    fs.writeFileSync(manifest, JSON.stringify(data));
    const pristine = path.join(dir, 'state/pristine/docker/docker-entrypoint.hermit.sh');
    fs.mkdirSync(path.dirname(pristine), { recursive: true }); fs.writeFileSync(pristine, base);
    const receipt = apply();
    expect(receipt.remaining.find(entry => entry.file === 'docker-entrypoint.hermit.sh')?.base_path).toBe(pristine);
    expect(fs.readFileSync(file, 'utf8')).toBe('operator');
  }
}));

test('apply re-seeds raw identical copies without seeding rendered Docker copies', withProj((proj) => {
  const apply = applyFixture(proj); apply();
  const dir = hermitDir(proj), manifest = path.join(dir, 'state/template-manifest.json');
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  data.files['bin/hermitd-run'].sha256 = sha256(Buffer.from('stale'));
  fs.writeFileSync(manifest, JSON.stringify(data));
  expect(apply().applied).toContainEqual({ file: 'bin/hermitd-run', outcome: 'baseline-seeded' });
  expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).files['docker/Dockerfile.hermit.template']).toBeUndefined();
}));

test('apply parks bootstrap Docker renders once and prunes only old candidates', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const rendered = render(DOCKER_INPUTS);
  deployDocker(proj, { compose: rendered.compose, dockerfile: rendered.dockerfile + '\nRUN echo operator\n' });
  const dir = hermitDir(proj), state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  for (const name of ['Dockerfile.hermit.2000.upstream', 'Dockerfile.hermit.2001.upstream', 'Dockerfile.hermit.2000.bak']) fs.writeFileSync(path.join(state, name), 'old');
  const apply = () => applyEvolve(dir, PLUGIN_ROOT, EMPTY_PLUGIN_LIST);
  const receipt = apply();
  expect(receipt.parked).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(receipt.parked[0] + '.json', 'utf8')).project_sha).toBe(sha256(fs.readFileSync(path.join(proj, 'Dockerfile.hermit'))));
  expect(fs.existsSync(path.join(state, 'Dockerfile.hermit.2000.upstream'))).toBe(false);
  expect(fs.existsSync(path.join(state, 'Dockerfile.hermit.2000.bak'))).toBe(true);
  const before = diskSnapshot(proj);
  expect(apply().applied).toEqual([]);
  expect(diskSnapshot(proj)).toEqual(before);
}));

/** A customized Dockerfile whose recorded baseline is the 1.4.25 template; `deployed` picks the operator's base render. */
function legacyDockerFixture(proj: string, deployed: 'legacy' | 'current') {
  writeDerivableDockerConfig(proj);
  const sources = realDockerSources();
  const legacy = sources.dockerfile.replace('RUN mkdir -p /home/claude/.claude/sessions\n', 'RUN mkdir -p /home/claude/.claude/sessions\n{{BROWSER_ENV}}\n');
  const base = renderSources({ ...DOCKER_INPUTS, browser: true }, deployed === 'legacy' ? { ...sources, dockerfile: legacy } : sources);
  const operator = base.dockerfile + '\nRUN echo operator\n';
  deployDocker(proj, { compose: base.compose, dockerfile: operator });
  const dir = hermitDir(proj);
  const pristine = path.join(dir, 'state/pristine/docker/Dockerfile.hermit.template');
  fs.mkdirSync(path.dirname(pristine), { recursive: true }); fs.writeFileSync(pristine, legacy);
  dockerManifest(proj, { 'docker/Dockerfile.hermit.template': sha256(Buffer.from(legacy)) });
  return { dir, sources, operator };
}

test('apply hands a clean customized merge to review and adopt finishes it', withProj((proj) => {
  const { dir, operator } = legacyDockerFixture(proj, 'legacy');
  const project = path.join(proj, 'Dockerfile.hermit');
  const apply = () => applyEvolve(dir, PLUGIN_ROOT, EMPTY_PLUGIN_LIST);
  const receipt = apply();
  expect(fs.readFileSync(project, 'utf8')).toBe(operator);
  expect(receipt.applied.some(entry => entry.outcome.startsWith('merged'))).toBe(false);
  const entry = receipt.remaining.find(item => item.file === 'Dockerfile.hermit')!;
  expect(entry.class).toBe('conflict');
  expect(entry.merged_path).toBe(receipt.parked[0] + '.merged');
  const merged = fs.readFileSync(entry.merged_path!, 'utf8');
  expect(merged).toContain('ARG HERMIT_BROWSER=1');
  expect(merged).toContain('RUN echo operator');
  expect(merged).not.toContain('ENV AGENT_BROWSER_');
  const before = diskSnapshot(proj);
  expect(apply().remaining.find(item => item.file === 'Dockerfile.hermit')?.merged_path).toBe(entry.merged_path);
  expect(diskSnapshot(proj)).toEqual(before);
  fs.copyFileSync(entry.merged_path!, project);
  expect(adoptDocker(dir, PLUGIN_ROOT, 'Dockerfile.hermit')).toEqual({ status: 'adopted', file: 'Dockerfile.hermit' });
  expect(fs.existsSync(entry.merged_path!)).toBe(false);
  expect(fs.existsSync(receipt.parked[0])).toBe(false);
}));

test('apply drops a stale review candidate once the merge stops being clean', withProj((proj) => {
  const { dir } = legacyDockerFixture(proj, 'legacy');
  const apply = () => applyEvolve(dir, PLUGIN_ROOT, EMPTY_PLUGIN_LIST);
  const merged = apply().remaining.find(item => item.file === 'Dockerfile.hermit')!.merged_path!;
  fs.appendFileSync(path.join(proj, 'Dockerfile.hermit'), '<<<<<<< operator\n');
  expect(apply().remaining.find(item => item.file === 'Dockerfile.hermit')?.merged_path).toBeNull();
  expect(fs.existsSync(merged)).toBe(false);
}));

test('apply refreshes the parked receipt so adopt still refuses an unmerged edited file', withProj((proj) => {
  const { dir } = legacyDockerFixture(proj, 'legacy');
  const project = path.join(proj, 'Dockerfile.hermit');
  const apply = () => applyEvolve(dir, PLUGIN_ROOT, EMPTY_PLUGIN_LIST);
  const candidate = apply().parked[0];
  fs.appendFileSync(project, 'RUN echo later edit\n');
  expect(apply().parked).toEqual([candidate]);
  expect(JSON.parse(fs.readFileSync(candidate + '.json', 'utf8')).project_sha).toBe(sha256(fs.readFileSync(project)));
  expect(adoptDocker(dir, PLUGIN_ROOT, 'Dockerfile.hermit')).toEqual({ status: 'refused', reason: 'unmerged' });
}));

test('apply seeds the baseline when the operator file already carries the upstream change', withProj((proj) => {
  const { dir, sources } = legacyDockerFixture(proj, 'current');
  const receipt = applyEvolve(dir, PLUGIN_ROOT, EMPTY_PLUGIN_LIST);
  expect(receipt.applied).toContainEqual({ file: 'Dockerfile.hermit', outcome: 'baseline-seeded' });
  expect(receipt.remaining.some(item => item.file === 'Dockerfile.hermit')).toBe(false);
  expect(receipt.parked).toEqual([]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'state/template-manifest.json'), 'utf8'));
  expect(manifest.files['docker/Dockerfile.hermit.template'].sha256).toBe(sha256(Buffer.from(sources.dockerfile)));
}));

test('apply CLI rejects additional arguments and keeps the state pin', withProj(async (proj) => {
  writeConfig(proj, '{}');
  const result = await runPinnedScript('evolve-plan.ts', hermitDir(proj), [hermitDir(proj), 'apply', 'extra']);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error).toBe('unexpected_args');
}));

test('adopt refuses absent, unmerged, stale and structurally invalid candidates', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const rendered = render(DOCKER_INPUTS), dir = hermitDir(proj);
  deployDocker(proj, { compose: rendered.compose, dockerfile: rendered.dockerfile + '\nRUN echo operator\n' });
  const adopt = () => adoptDocker(dir, PLUGIN_ROOT, 'Dockerfile.hermit');
  expect(adopt()).toEqual({ status: 'refused', reason: 'no_candidate' });
  const receipt = applyEvolve(dir, PLUGIN_ROOT, EMPTY_PLUGIN_LIST);
  expect(adopt()).toEqual({ status: 'refused', reason: 'unmerged' });
  const candidate = receipt.parked[0], bytes = fs.readFileSync(candidate);
  fs.writeFileSync(candidate, 'stale');
  expect(adopt()).toEqual({ status: 'refused', reason: 'stale_candidate' });
  fs.writeFileSync(candidate, bytes);
  fs.writeFileSync(path.join(proj, 'Dockerfile.hermit'), 'FROM ubuntu\nUSER root\n');
  expect(adopt()).toEqual({ status: 'refused', reason: 'checks_failed' });
  fs.writeFileSync(path.join(proj, 'Dockerfile.hermit'), rendered.dockerfile + '\nRUN echo merged\n');
  expect(adopt()).toEqual({ status: 'adopted', file: 'Dockerfile.hermit' });
  expect(adopt()).toEqual({ status: 'refused', reason: 'no_candidate' });
  expect(fs.existsSync(candidate + '.json')).toBe(false);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'state/template-manifest.json'), 'utf8'));
  expect(manifest.files['docker/Dockerfile.hermit.template'].sha256).toBe(sha256(Buffer.from(realDockerSources().dockerfile)));
}));

test('adopt accepts a merged compose and keeps unrelated backups', withProj((proj) => {
  writeDerivableDockerConfig(proj);
  const rendered = render(DOCKER_INPUTS), dir = hermitDir(proj);
  deployDocker(proj, { compose: rendered.compose + '\nx-operator: original\n', dockerfile: rendered.dockerfile });
  const receipt = applyEvolve(dir, PLUGIN_ROOT, EMPTY_PLUGIN_LIST);
  const backup = path.join(dir, 'state/docker-compose.hermit.yml.original.bak');
  fs.writeFileSync(backup, 'recovery');
  fs.writeFileSync(path.join(proj, 'docker-compose.hermit.yml'), rendered.compose + '\nx-operator: merged\n');
  expect(adoptDocker(dir, PLUGIN_ROOT, 'docker-compose.hermit.yml').status).toBe('adopted');
  expect(receipt.parked.every(file => !fs.existsSync(file))).toBe(true);
  expect(fs.readFileSync(backup, 'utf8')).toBe('recovery');
}));

test('adopt CLI rejects arbitrary file paths and extra arguments', withProj(async (proj) => {
  writeConfig(proj, '{}');
  for (const args of [['../Dockerfile.hermit'], ['Dockerfile.hermit', 'extra'], []]) {
    const result = await runPinnedScript('evolve-plan.ts', hermitDir(proj), [hermitDir(proj), 'adopt', ...args]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toBe('unexpected_args');
  }
}));

test('Docker merge checks reject a root final user with any group', () => {
  const source = render(DOCKER_INPUTS).dockerfile;
  for (const user of ['root', 'root:1000', '0:claude', '00:1000']) {
    expect(dockerMergeChecks('Dockerfile.hermit', source + `\nUSER ${user}\n`)).toBe(false);
  }
  expect(dockerMergeChecks('Dockerfile.hermit', source + '\nUSER claude:root\n')).toBe(true);
});
