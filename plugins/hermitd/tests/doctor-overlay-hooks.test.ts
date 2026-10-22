import { describe, test as bunTest, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, checkOverlayHooks } from '../scripts/doctor-check';
import { overlayHooks } from '../scripts/lib/settings/overlay-hooks';
import { freshDirFactory } from './helpers/workdir';

const test = bunTest.serial;
const { freshDir, cleanup } = freshDirFactory('hermit-overlay-hooks-');
afterAll(cleanup);

type Fixture = {
  missingOverlay?: boolean;
  corruptOverlay?: boolean;
  booted?: boolean;
  missingScript?: boolean;
  // The overlay names scripts under this root instead of the root doctor runs from.
  overlayRoot?: string;
  trust?: 'none' | 'parent' | 'stamped';
  mutate?: (overlay: any) => void;
};

function scenario({ missingOverlay, corruptOverlay, booted, missingScript, overlayRoot, trust, mutate }: Fixture = {}) {
  const dir = freshDir();
  const stateDir = path.join(dir, '.hermit/state');
  const pluginRoot = path.join(dir, 'plugin');
  const configDir = path.join(dir, 'user');
  fs.mkdirSync(stateDir, { recursive: true });
  const writerRoot = overlayRoot ? path.join(dir, overlayRoot) : pluginRoot;
  fs.mkdirSync(path.join(writerRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(configDir);
  const overlay = { hooks: overlayHooks(writerRoot) };
  for (const entries of Object.values(overlay.hooks)) {
    for (const entry of entries) fs.writeFileSync(entry.hooks[0].args[0], '');
  }
  if (missingScript) fs.unlinkSync(overlay.hooks.PreToolUse[0].hooks[0].args[0]);
  mutate?.(overlay);
  const overlayFile = path.join(stateDir, 'claude-settings.overlay.json');
  if (corruptOverlay) fs.writeFileSync(overlayFile, '{"hooks": {');
  else if (!missingOverlay) fs.writeFileSync(overlayFile, JSON.stringify(overlay));
  // runtime.json is the "a boot happened here" marker the check reads; the stamped-trust
  // branch below writes its own, so only seed one when that branch will not.
  if (booted && trust !== 'stamped') fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({}));
  if (trust !== 'none') {
    const trustDir = trust === 'stamped' ? path.join(dir, 'stamped') : configDir;
    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(path.join(trustDir, '.claude.json'), JSON.stringify({ projects: {
      [trust === 'parent' ? path.dirname(dir) : dir]: { hasTrustDialogAccepted: true },
    } }));
    if (trust === 'stamped') fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ config_dir: trustDir }));
  }
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return checkOverlayHooks(resolvePaths(path.dirname(stateDir), pluginRoot));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

describe('doctor overlay-hooks check', () => {
  test('ok: overlay missing on an install that has never booted', () => {
    const result = scenario({ missingOverlay: true });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('first `hermitd-start` boot');
  });
  test('fail: overlay missing after a boot', () => {
    const result = scenario({ missingOverlay: true, booted: true });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('missing after a boot');
  });
  test('fail: overlay unreadable', () => {
    const result = scenario({ corruptOverlay: true, booted: true });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('unreadable');
  });
  test('fail: overlay unreadable even before a first boot', () => {
    expect(scenario({ corruptOverlay: true }).status).toBe('fail');
  });
  test('warn: one hook script missing on disk', () => {
    const result = scenario({ missingScript: true });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('pause-gate.ts');
    expect(result.detail).toContain('missing on disk');
  });
  test('warn: entry has wrong matcher', () => {
    const result = scenario({ mutate: overlay => { overlay.hooks.PreToolUse[0].matcher = 'Read'; } });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('matcher');
  });
  test('warn: malformed or incomplete hook configuration', () => {
    const mutations = [
      (overlay: any) => { delete overlay.hooks; },
      (overlay: any) => { delete overlay.hooks.PermissionDenied; },
      (overlay: any) => { overlay.hooks.PreToolUse[0].hooks[0].command = 'node'; },
      (overlay: any) => { overlay.hooks.PreToolUse[0].hooks[0].timeout = 4; },
      (overlay: any) => { overlay.hooks.PreToolUse[0].hooks[0].args = ['scripts/pause-gate.ts']; },
      (overlay: any) => { overlay.hooks.PreToolUse[0].hooks[0].args.push('extra'); },
      (overlay: any) => { overlay.hooks.PreToolUse[0].hooks[0].args = [overlay.hooks.PreToolUse[1].hooks[0].args[0]]; },
      (overlay: any) => { overlay.hooks.PreToolUse[0].hooks[0].type = 'prompt'; },
    ];
    for (const mutate of mutations) expect(scenario({ mutate }).status).toBe('warn');
  });
  test('warn: trust flag not set anywhere', () => {
    const result = scenario({ trust: 'none' });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('trust flag not set');
  });
  test('ok: trust set on a parent directory', () => {
    expect(scenario({ trust: 'parent' }).status).toBe('ok');
  });
  test('ok: trust set in the stamped config_dir file', () => {
    expect(scenario({ trust: 'stamped' }).status).toBe('ok');
  });
  test('ok: overlay written from another plugin root names the same scripts', () => {
    expect(scenario({ overlayRoot: 'marketplace' }).status).toBe('ok');
  });
  test('warn: a script missing under the overlay root is reported at that path', () => {
    const result = scenario({ overlayRoot: 'marketplace', missingScript: true });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(path.join('marketplace', 'scripts', 'pause-gate.ts'));
  });
  test('ok: overlay complete and trust set', () => {
    const result = scenario();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('Configuration check only, not observed hook execution.');
  });
});
