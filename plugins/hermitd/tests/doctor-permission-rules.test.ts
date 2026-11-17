import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, checkPermissionRules } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-perm-rules-');
afterAll(cleanup);

// The seeded ask list, read from the shipped template rather than restated, so a
// template edit cannot silently make these fixtures stop describing the seed.
const SEEDED_ASK: string[] = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json'), 'utf8'),
).ask;

type Fixture = { mode?: string; local?: any; project?: any; target?: 'local' | 'committed' };

function scenario({ mode, local, project, target }: Fixture) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.hermit'), { recursive: true });
  if (target) {
    fs.mkdirSync(path.join(dir, '.hermit', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hermit', 'state', 'hatch-options.json'), JSON.stringify({ target }));
  }
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.hermit', 'config.json'),
    JSON.stringify(mode === undefined ? {} : { permission_mode: mode }, null, 2),
  );
  const writeSettings = (name: string, value: any) =>
    fs.writeFileSync(path.join(dir, '.claude', name), JSON.stringify(value, null, 2));
  if (local !== undefined) writeSettings('settings.local.json', local);
  if (project !== undefined) writeSettings('settings.json', project);

  return {
    result: checkPermissionRules(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT), { container: false }),
    dir,
  };
}

const standard = { permissions: { deny: [], ask: SEEDED_ASK } };
const hardened = { permissions: { deny: SEEDED_ASK, ask: [] } };

// Under bypassPermissions Claude Code consults no rule that would prompt, so the
// Standard seed's ask entries are inert — the one posture where the hatch answer
// and the running behavior diverge silently. Only the deny array survives bypass.
describe('doctor permission-rules check', () => {
  test('auto mode with the Standard seed → ok', () => {
    const { result } = scenario({ mode: 'auto', local: standard });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('auto');
  });

  test('bypassPermissions with the Standard seed → warn naming the settings file', () => {
    const { result, dir } = scenario({ mode: 'bypassPermissions', local: standard });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(`${SEEDED_ASK.length} seeded ask rules`);
    expect(result.detail).toContain(path.join(dir, '.claude', 'settings.local.json'));
    expect(result.detail).toContain('deny hardened');
  });

  test('committed stamp names one target remedy when only local settings carry the seed', () => {
    const { result, dir } = scenario({ mode: 'bypassPermissions', local: standard, target: 'committed' });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(`${SEEDED_ASK.length} seeded ask rules`);
    expect(result.detail).toContain(`${path.join(dir, '.claude', 'settings.json')} deny hardened`);
    expect(result.detail).not.toContain('settings.local.json deny hardened');
    expect(result.detail.match(/apply-settings\.ts/g)).toHaveLength(1);
  });

  test('bypassPermissions with the Hardened seed (asks in deny) → ok', () => {
    const { result } = scenario({ mode: 'bypassPermissions', local: hardened });
    expect(result.status).toBe('ok');
  });

  test('bypassPermissions with no settings file → ok', () => {
    const { result } = scenario({ mode: 'bypassPermissions' });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('no settings file');
  });

  test('bypassPermissions with the Skip seed (no seeded entries) → ok', () => {
    const { result } = scenario({ mode: 'bypassPermissions', local: { permissions: { deny: [], ask: [] } } });
    expect(result.status).toBe('ok');
  });

  // Claude Code unions permissions.ask/deny across both project scopes, and a deny
  // in either one hard-blocks. So a Hardened local file covers a Standard
  // settings.json, and — the case that matters — a Standard settings.json is NOT
  // covered by an unrelated local file, which hermitd-start writes on every boot.
  test('a deny in either scope covers an ask in the other', () => {
    const { result } = scenario({ mode: 'bypassPermissions', local: hardened, project: standard });
    expect(result.status).toBe('ok');
  });

  test('seed in settings.json is still seen when an unrelated settings.local.json exists', () => {
    const { result, dir } = scenario({
      mode: 'bypassPermissions',
      local: { env: { FOO: 'bar' } },
      project: standard,
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(`${SEEDED_ASK.length} seeded ask rules`);
    expect(result.detail).toContain(path.join(dir, '.claude', 'settings.json'));
  });

  test('an unparseable settings file warns rather than reading ok', () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.hermit'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.hermit', 'config.json'),
      JSON.stringify({ permission_mode: 'bypassPermissions' }),
    );
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"permissions":');
    const result = checkPermissionRules(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT), { container: false });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('unparseable');
  });
});

describe('container managed deny floor', () => {
  for (const [file, mode, enabled, container, detail] of [
    ['missing', 'auto', true, true, 'deny floor missing; rebuild with hermitd update'],
    ['missing', 'bypassPermissions', true, true, 'deny floor missing'],
    ['unlocked', 'auto', true, true, 'bypass lock missing; rebuild to apply'],
    ['invalid', 'auto', true, true, 'bypass lock missing'],
    ['locked', 'auto', true, true, null],
    ['unlocked', 'bypassPermissions', true, true, null],
    ['missing', 'auto', false, true, null],
    ['missing', 'auto', true, false, null],
  ] as const) {
    test(`${file}, ${mode}, enabled=${enabled}, container=${container}`, () => {
      const { dir } = scenario({ mode });
      fs.writeFileSync(path.join(dir, '.hermit/config.json'), JSON.stringify({
        permission_mode: mode, docker: { security: { managed_ceiling: enabled } },
      }));
      const managedSettingsPath = path.join(dir, 'hermitd-security.json');
      if (file !== 'missing') fs.writeFileSync(managedSettingsPath, file === 'invalid' ? '{' : JSON.stringify({
        permissions: file === 'locked' ? { disableBypassPermissionsMode: 'disable' } : {},
      }));
      const result = checkPermissionRules(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT), { container, managedSettingsPath });
      expect(result.status).toBe(detail ? 'warn' : 'ok');
      if (detail) expect(result.detail).toContain(detail);
    });
  }

  test('existing bypass ask warning takes priority over the missing floor', () => {
    const { dir } = scenario({ mode: 'bypassPermissions', local: standard });
    const result = checkPermissionRules(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT), {
      container: true, managedSettingsPath: path.join(dir, 'missing.json'),
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('seeded ask rules never fire');
  });
});
