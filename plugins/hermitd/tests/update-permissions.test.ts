// update-permissions.ts: the permission sync `hermitd update` runs after moving the core pin.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, writeConfig } from './helpers/workdir';

// Tests run concurrently, so each gets its own project. PATH holds only bun, so
// target resolution never reaches the operator's `claude` CLI.
async function withProject(fn: (p: ReturnType<typeof project>) => Promise<void>) {
  const p = project();
  try { await fn(p); } finally { p.cleanup(); }
}

function project() {
  const { dir, cleanup } = setupWorkdir();
  const at = (p: string) => path.join(dir, p);
  fs.mkdirSync(at('bin'));
  fs.symlinkSync(process.execPath, at('bin/bun'));
  return {
    at,
    cleanup,
    hatch(target?: string) {
      writeConfig(dir, { _hermit_versions: { hermitd: '1.0.0' } });
      if (target) fs.writeFileSync(at('.hermit/state/hatch-options.json'), JSON.stringify({ target }));
    },
    settings: (file: string) => JSON.parse(fs.readFileSync(at(`.claude/${file}`), 'utf-8')),
    run: () => runScript('update-permissions.ts', { cwd: dir, env: { PATH: at('bin') } }),
  };
}

test('syncs the stamped local target and keeps operator entries', () => withProject(async (p) => {
  p.hatch('local');
  fs.writeFileSync(p.at('.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(git status:*)'] } }));
  const r = await p.run();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout);
  const allow = p.settings('settings.local.json').permissions.allow;
  expect(allow).toContain('Bash(git status:*)');
  expect(out.missing.length).toBe(allow.length - 1);
  expect(out.settings_file).toBe('.claude/settings.local.json');
  expect(out.summary).toContain(`${out.missing.length} added`);
}));

test('syncs the committed file for a committed target', () => withProject(async (p) => {
  p.hatch('committed');
  fs.writeFileSync(p.at('.claude/settings.json'), '{}');
  const r = await p.run();
  expect(r.exitCode).toBe(0);
  expect(p.settings('settings.json').permissions.allow.length).toBeGreaterThan(0);
  expect(fs.existsSync(p.at('.claude/settings.local.json'))).toBe(false);
}));

test('an unstamped target uses the install-scope default', () => withProject(async (p) => {
  p.hatch();
  const r = await p.run();
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout).settings_file).toBe('.claude/settings.local.json');
}));

test('an unhatched project is skipped', () => withProject(async (p) => {
  const r = await p.run();
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ status: 'skipped', reason: 'not_hatched' });
  expect(fs.readdirSync(p.at('.claude'))).toEqual([]);
}));

test('a failed sync exits 1 with an error token', () => withProject(async (p) => {
  p.hatch('local');
  fs.writeFileSync(p.at('.claude/settings.local.json'), '{not json');
  const r = await p.run();
  expect(r.exitCode).toBe(1);
  expect(JSON.parse(r.stdout).error).toStartWith('sync_failed');
}));
