// bun test port of tests/test-evolve-plan.sh — drives scripts/evolve-plan.ts
// (issue #211, the read-only pre-pass analyzer for hermit-evolve) against
// fixture project trees. Covers version gap, bounded CHANGELOG slice, deep
// config-key diff, template/bin byte-compare, separator-aware CLAUDE-APPEND
// diff, the no_config vs 0.0.0 distinction, and operator-value preservation.
// Also covers registry-driven sibling hermit plans (work_pending, gap, no-gap
// CLAUDE-APPEND drift, path-unresolved, detected-but-unregistered, leak guard).
//
// Usage: bun test tests/evolve-plan.test.ts   (from the plugin root)

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { markerOnward, extractSiblingMarker, classifyDockerTemplates } from '../scripts/evolve-plan';
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
  fs.writeFileSync(path.join(PR, 'state-templates', 'CLAUDE-APPEND.md'),
    `---\n\n${MARKER}\n## Session Discipline\n\nbody line\n`);
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
  fs.writeFileSync(
    path.join(SP, 'state-templates', 'CLAUDE-APPEND.md'),
    `---\n\n${SIBLING_MARKER}\n## Dev Workflow\n\ndev body line\n`,
  );

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
async function runPlan(proj: string, hatchTarget?: string, pluginListPath?: string): Promise<any> {
  const args = [hermitDir(proj)];
  if (hatchTarget !== undefined) args.push(`--hatch-target=${hatchTarget}`);
  args.push(`--plugin-list-json=${pluginListPath ?? EMPTY_PLUGIN_LIST}`);
  const r = await runScript('evolve-plan.ts', { args, env: { CLAUDE_PLUGIN_ROOT: PR } });
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
// 5a. CLAUDE-APPEND identical (target has leading ---) -> not changed
// -------------------------------------------------------

test('CLAUDE-APPEND identical (modulo leading ---) -> changed=false, no old_block', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# My Project\n\nstuff\n\n---\n\n${MARKER}\n## Session Discipline\n\nbody line\n`);
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(false);
  // should omit old_block when unchanged
  expect('claude_append_old_block' in d).toBe(false);
}));

// -------------------------------------------------------
// 5b. CLAUDE-APPEND different -> changed + exact old_block
// -------------------------------------------------------

test('CLAUDE-APPEND different -> changed=true, old_block is exact marker-onward', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  const target = path.join(proj, 'CLAUDE.local.md');
  fs.writeFileSync(target,
    `# My Project\n\nstuff\n\n---\n\n${MARKER}\n## Session Discipline\n\nOLD body line\n`);
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(true);
  const ob: string = d.claude_append_old_block;
  expect(ob.startsWith(MARKER)).toBe(true);
  expect(ob).toContain('OLD body line');
  // must be an exact substring of the target file (so a targeted Edit will match)
  expect(fs.readFileSync(target, 'utf-8')).toContain(ob);
}));

// -------------------------------------------------------
// 5c. CLAUDE-APPEND marker absent -> changed (append case), no old_block
// -------------------------------------------------------

test('CLAUDE-APPEND marker absent -> changed=true (append), no old_block', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'), '# My Project\n\nno hermit block here\n');
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(true);
  // append case must omit old_block
  expect('claude_append_old_block' in d).toBe(false);
}));

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
// 10. no_hatch_target: required flag missing -> errors[no_hatch_target]
// -------------------------------------------------------

test('no_hatch_target: missing flag -> errors[no_hatch_target], exit 0', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  const d = await runPlan(proj); // no --hatch-target flag (runPlan asserts exit 0)
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('no_hatch_target');
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
  agentHookProfile: 'strict',
  networkMode: 'bridge' as const,
  gitIdentityMount: true,
  fleetMesh: false,
};

function writeDerivableDockerConfig(proj: string): void {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.6' },
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

test('no-gap + changed CLAUDE-APPEND block -> claude_append_changed=true, no Edit intent implied', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.3' },
  }));
  // Write a stale sibling block in the target CLAUDE.local.md
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${SIBLING_MARKER}\n## Dev Workflow\n\nSTALE dev body\n`);
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  const s = d.siblings[0];
  expect(s.up_to_date).toBe(true);             // no version gap
  expect(s.claude_append_changed).toBe(true);  // but block is stale
  // old_block is present so the skill can report what drifted (advisory only, no Edit for no-gap)
  expect(s.claude_append_old_block).toContain('STALE dev body');
  expect(d.work_pending).toBe(true);           // drift alone triggers work_pending
}));

test('gap + changed CLAUDE-APPEND block -> both up_to_date=false and claude_append_changed=true', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.1' },
  }));
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${SIBLING_MARKER}\n## Dev Workflow\n\nOLD dev body\n`);
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  const s = d.siblings[0];
  expect(s.up_to_date).toBe(false);
  expect(s.claude_append_changed).toBe(true);
  expect(s.claude_append_old_block).toContain('OLD dev body');
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

test('work_pending: all current + no drift -> false', withProj(async (proj) => {
  writeConfig(proj, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.3' },
  }));
  // Write correct core AND sibling blocks so both are drift-free.
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${MARKER}\n## Session Discipline\n\nbody line\n\n---\n\n${SIBLING_MARKER}\n## Dev Workflow\n\ndev body line\n`);
  const pl = writePluginList([siblingEntry(proj)]);
  const d = await runPlan(proj, 'local', pl);
  expect(d.up_to_date).toBe(true);
  expect(d.claude_append_changed).toBe(false);
  expect(d.siblings[0].up_to_date).toBe(true);
  expect(d.siblings[0].claude_append_changed).toBe(false);
  expect(d.work_pending).toBe(false);
}));

// -------------------------------------------------------
// 13. Block-bounds regressions: two live mis-slices found by running the
// pre-fix helpers against the real shipped templates (not idealized fixtures).
// -------------------------------------------------------

// Defect A: extractSiblingMarker used to return the FIRST HTML comment line in
// a template, so a leading "<!-- mode:standard-only -->" annotation
// was mistaken for the block marker. Since mode markers are stripped
// before install, that "marker" never
// exists in the target -> append branch -> the full un-rendered template
// (both mode variants + mode markers) would be appended to the operator's file.
//
// Defect C: even with marker discovery fixed, a template whose block still
// carries mode: markers is raw/un-rendered content that core cannot compare
// or write — computeSiblings/_diffClaudeAppendByText must refuse to sync it
// at all (needs_render), not just avoid the append branch.
function writeDevLikeSibling(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-devlike-sp-'));
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state-templates'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{"version":"0.4.3"}\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'),
    '# Changelog\n\n## [0.4.3] - 2026-06-01\n### Fixed\n- x\n\n## [0.4.1] - 2026-05-01\n### Added\n- init\n');
  fs.writeFileSync(
    path.join(root, 'state-templates', 'CLAUDE-APPEND.md'),
    [
      '<!-- mode:standard-only -->',
      '',
      '<!-- /mode:standard-only -->',
      '---',
      '<!-- hermitd-dev: Development Workflow -->',
      '## Development Workflow',
      '',
      '- rendered body',
      '<!-- mode:safety-only -->',
      '- safety-only body',
      '<!-- /mode:safety-only -->',
      '<!-- /hermitd-dev: Development Workflow -->',
      '',
    ].join('\n'),
  );
  return root;
}

test('REGRESSION defect A: marker discovery picks the dev block marker, not the leading mode: comment', withProj(async (proj) => {
  const devLikeRoot = writeDevLikeSibling();
  try {
    writeConfig(proj, JSON.stringify({
      _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.1' },
    }));
    // Target carries a correctly-rendered block, as a real hatch would produce (no mode: markers).
    fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
      '# Project\n\n---\n\n<!-- hermitd-dev: Development Workflow -->\n' +
      '## Development Workflow\n\n- rendered body\n<!-- /hermitd-dev: Development Workflow -->\n');
    const pl = writePluginList([{
      id: 'hermitd-dev@hermitd', version: '0.4.3', scope: 'local',
      enabled: true, installPath: devLikeRoot, projectPath: proj,
    }]);
    const d = await runPlan(proj, 'local', pl);
    const s = d.siblings.find((x: any) => x.name === 'hermitd-dev');
    expect(s).toBeDefined();
    expect(s.marker).toBe('<!-- hermitd-dev: Development Workflow -->');
  } finally {
    try { fs.rmSync(devLikeRoot, { recursive: true, force: true }); } catch {}
  }
}));

test('REGRESSION defect C: template requiring rendering is never synced, never leaks raw mode: content into the plan', withProj(async (proj) => {
  const devLikeRoot = writeDevLikeSibling();
  try {
    writeConfig(proj, JSON.stringify({
      _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.1' },
    }));
    // No target block installed at all — the historically-dangerous case (append branch).
    const pl = writePluginList([{
      id: 'hermitd-dev@hermitd', version: '0.4.3', scope: 'local',
      enabled: true, installPath: devLikeRoot, projectPath: proj,
    }]);
    const d = await runPlan(proj, 'local', pl);
    const s = d.siblings.find((x: any) => x.name === 'hermitd-dev');
    expect(s).toBeDefined();
    expect(s.claude_append_needs_render).toBe(true);
    expect('claude_append_old_block' in s).toBe(false);
    // The guarantee: no raw un-rendered template content anywhere in the plan.
    expect(JSON.stringify(d)).not.toContain('<!-- mode:');
  } finally {
    try { fs.rmSync(devLikeRoot, { recursive: true, force: true }); } catch {}
  }
}));

// needs_render must still surface on the plan (Step 7 defers the sync on a version
// gap) but must not by itself pin work_pending. Rationale: see the siblingWorkNeeded
// comment in buildPlan() in evolve-plan.ts.
test('needs_render alone (no version gap) is surfaced but does not pin work_pending', withProj(async (proj) => {
  const devLikeRoot = writeDevLikeSibling();
  try {
    // Registered version matches installed -> no gap. needs_render must still surface.
    writeConfig(proj, JSON.stringify({
      _hermit_versions: { 'hermitd': '1.1.7', 'hermitd-dev': '0.4.3' },
    }));
    // Core's own block drift-free, so work_pending reflects only the sibling.
    fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
      `# Project\n\n---\n\n${MARKER}\n## Session Discipline\n\nbody line\n`);
    const pl = writePluginList([{
      id: 'hermitd-dev@hermitd', version: '0.4.3', scope: 'local',
      enabled: true, installPath: devLikeRoot, projectPath: proj,
    }]);
    const d = await runPlan(proj, 'local', pl);
    const s = d.siblings.find((x: any) => x.name === 'hermitd-dev');
    expect(s.up_to_date).toBe(true);
    expect(s.claude_append_needs_render).toBe(true);
    expect(s.claude_append_changed).toBe(false);
    expect(d.work_pending).toBe(false);
  } finally {
    try { fs.rmSync(devLikeRoot, { recursive: true, force: true }); } catch {}
  }
}));

// Defect B: markerOnward used to stop at the FIRST standalone "---" line
// after the marker, with no concept of a closing marker. hermitd-laravel-forge's
// real template has a closing marker at line 76 but seven internal standalone
// "---" lines starting at line 7 — the old heuristic truncated its block to 6
// of 77 lines, so drift past line 6 was silently invisible.
test('REGRESSION defect B: markerOnward spans through the closing marker, ignoring internal --- lines (forge-shaped fixture)', () => {
  const marker = '<!-- hermitd-laravel-forge: Forge Workflow -->';
  const closing = '<!-- /hermitd-laravel-forge: Forge Workflow -->';
  const text = [
    marker,
    '## Laravel Forge',
    '- line 1',
    '---',
    '### Safety rule',
    '- line 2',
    '---',
    '- line 3',
    closing,
  ].join('\n');
  const block = markerOnward(text, marker);
  expect(block).not.toBeNull();
  expect(block!.split('\n')).toHaveLength(text.split('\n').length); // full fixture, not truncated to 4
  expect(block).toContain('line 3');
  expect(block!.trim().endsWith(closing)).toBe(true);
});

// -------------------------------------------------------
// 14. Adjacency / no-clobber: reconstructs this repo's real CLAUDE.local.md
// shape (core block immediately followed by dev block). Two independent
// guards (the "---" fallback and the fence against a foreign block marker)
// must each stop core's block before dev's, so a replace Edit can never
// swallow or strand the adjacent sibling block.
// -------------------------------------------------------

test('adjacency: core block bounded before dev block via the --- fallback', () => {
  const coreMarker = '<!-- hermitd: Session Discipline -->';
  const devMarker = '<!-- hermitd-dev: Development Workflow -->';
  const text = `# Project prose\n\n---\n\n${coreMarker}\n## Session Discipline\ncore body\n\n---\n\n${devMarker}\n## Development Workflow\ndev body\n`;

  const coreBlock = markerOnward(text, coreMarker, ['hermitd-dev']);
  expect(coreBlock).not.toBeNull();
  expect(coreBlock).not.toContain('dev body');
  expect(coreBlock).not.toContain(devMarker);

  const devBlock = markerOnward(text, devMarker, ['hermitd']);
  expect(devBlock).not.toBeNull();
  expect(devBlock).toContain('dev body');
});

test('adjacency: fence still holds when the intervening --- is missing', () => {
  const coreMarker = '<!-- hermitd: Session Discipline -->';
  const devMarker = '<!-- hermitd-dev: Development Workflow -->';
  // No "---" between the two blocks -> only the foreign-marker fence can stop core's block.
  const text = `# Project prose\n\n---\n\n${coreMarker}\n## Session Discipline\ncore body\n\n${devMarker}\n## Development Workflow\ndev body\n`;

  const coreBlock = markerOnward(text, coreMarker, ['hermitd-dev']);
  expect(coreBlock).not.toBeNull();
  expect(coreBlock).not.toContain('dev body');
  expect(coreBlock).not.toContain(devMarker);
});

// -------------------------------------------------------
// 15. Legacy-upgrade idempotence: a target block installed before this fix
// (no closing marker) syncs exactly once against a template that now has one,
// then stabilizes — no migration script, just the existing replace path.
// -------------------------------------------------------

test('legacy-upgrade idempotence: closing-marker-less target converges to the paired template in one pass', withProj(async (proj) => {
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-legacy-sp-'));
  try {
    const name = 'test-legacy-hermit';
    const marker = `<!-- ${name}: Test Workflow -->`;
    const closing = `<!-- /${name}: Test Workflow -->`;
    fs.mkdirSync(path.join(legacyRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(legacyRoot, 'state-templates'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, '.claude-plugin', 'plugin.json'), '{"version":"1.0.0"}\n');
    fs.writeFileSync(path.join(legacyRoot, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n### Added\n- init\n');
    const tmplText = `${marker}\n## Test Workflow\n- line one\n- line two\n${closing}\n`;
    fs.writeFileSync(path.join(legacyRoot, 'state-templates', 'CLAUDE-APPEND.md'), tmplText);

    writeConfig(proj, JSON.stringify({
      _hermit_versions: { 'hermitd': '1.1.7', [name]: '0.9.0' },
    }));
    const targetPath = path.join(proj, 'CLAUDE.local.md');
    // Legacy shape: block installed by a pre-fix hatch, no closing marker.
    const legacyTargetText = `# Project\n\n---\n\n${marker}\n## Test Workflow\n- line one\n- line two\n`;
    fs.writeFileSync(targetPath, legacyTargetText);

    const pl = writePluginList([{
      id: `${name}@hermitd`, version: '1.0.0', scope: 'local', enabled: true,
      installPath: legacyRoot, projectPath: proj,
    }]);

    const first = await runPlan(proj, 'local', pl);
    const s1 = first.siblings.find((x: any) => x.name === name);
    expect(s1).toBeDefined();
    expect(s1.up_to_date).toBe(false); // real version gap -> Step 7 would apply the Edit
    expect(s1.claude_append_changed).toBe(true);
    expect(s1.claude_append_old_block).toBeDefined();
    expect(legacyTargetText).toContain(s1.claude_append_old_block); // exact substring, safe as an Edit old_string

    // Apply the replace exactly as hermit-evolve Step 7 would.
    const updated = legacyTargetText.replace(s1.claude_append_old_block, tmplText.trimEnd());
    fs.writeFileSync(targetPath, updated + '\n');

    const second = await runPlan(proj, 'local', pl);
    const s2 = second.siblings.find((x: any) => x.name === name);
    expect(s2.claude_append_changed).toBe(false);
  } finally {
    try { fs.rmSync(legacyRoot, { recursive: true, force: true }); } catch {}
  }
}));

// -------------------------------------------------------
// 16. Ambiguity guard: a duplicated marker in the target must never be
// auto-edited (old_string wouldn't be unique) and must never fall through
// to append (which would add a third copy).
// -------------------------------------------------------

test('ambiguity guard: marker appears twice in target -> ambiguous, no old_block', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.6"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${MARKER}\n## Session Discipline\n\nfirst body\n\n---\n\n${MARKER}\n## Session Discipline\n\nsecond body\n`);
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_ambiguous).toBe(true);
  expect('claude_append_old_block' in d).toBe(false);
}));

// REGRESSION: work_pending must reflect drift/ambiguity in CORE's own block even
// when core itself is up_to_date, so a stray duplicate (e.g. left by a prior bad
// sync) is never swallowed by the "already up to date" short-circuit and the skill
// still runs Step 6 to report it.
test('REGRESSION: core up_to_date but its own block is ambiguous -> work_pending=true', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.7"}}'); // matches PR plugin.json -> up_to_date
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${MARKER}\n## Session Discipline\n\nfirst body\n\n---\n\n${MARKER}\n## Session Discipline\n\nsecond body\n`);
  const d = await runPlan(proj, 'local');
  expect(d.up_to_date).toBe(true);
  expect(d.claude_append_ambiguous).toBe(true);
  expect(d.work_pending).toBe(true);
}));

test('REGRESSION: core up_to_date but its own block drifted -> work_pending=true', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.7"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# Project\n\n---\n\n${MARKER}\n## Session Discipline\n\nSTALE body\n`);
  const d = await runPlan(proj, 'local');
  expect(d.up_to_date).toBe(true);
  expect(d.claude_append_changed).toBe(true);
  expect(d.work_pending).toBe(true);
}));

test('resident drift remains pending at equal version and with ambiguous shared blocks', withProj(async (proj) => {
  const plugin = path.join(proj, 'plugin');
  fs.cpSync(PR, plugin, { recursive: true });
  const full = `${MARKER}\nShared.\n<!-- resident-only -->\n## Watches\nResident.\n<!-- /resident-only -->\n<!-- /hermitd: Session Discipline -->\n`;
  fs.writeFileSync(path.join(plugin, 'state-templates/CLAUDE-APPEND.md'), full);
  writeConfig(proj, '{"_hermit_versions":{"hermitd":"1.1.7"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), full);
  const read = async () => {
    const r = await runScript('evolve-plan.ts', { args: [hermitDir(proj), '--hatch-target=committed', `--plugin-list-json=${EMPTY_PLUGIN_LIST}`], env: { CLAUDE_PLUGIN_ROOT: plugin } });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout);
  };
  const legacy = await read();
  expect(legacy.resident_missing).toBe(true);
  expect(legacy.resident_changed).toBe(true);
  expect(legacy.claude_append_changed).toBe(true);
  expect(legacy.work_pending).toBe(true);
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), full + full);
  const ambiguous = await read();
  expect(ambiguous.claude_append_ambiguous).toBe(true);
  expect(ambiguous.resident_changed).toBe(true);
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
  const result = await runScript('evolve-plan.ts', {
    args: [hermitDir(proj), '--hatch-target=local', `--plugin-list-json=${pluginList}`],
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
