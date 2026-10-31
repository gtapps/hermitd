import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-deny-');
afterAll(cleanup);

const PATTERNS = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json'), 'utf8'),
) as { deny: string[]; ask: string[] };
const DENY = PATTERNS.deny;
const ASK = PATTERNS.ask;
const LEGACY_HARD_BLOCKS = [
  'Bash(npm publish*)',
  'Bash(git push --force*)',
  'Bash(git push origin main*)',
  'Bash(git reset --hard*)',
  'Bash(*--no-verify*)',
];

function seedSettings(dir: string, settings: any): string {
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function readSettings(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('apply-settings.ts deny', () => {
  test('deny standard seeds deny + ask and removes nothing — a Hardened install keeps its hard blocks', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {
      permissions: { deny: [...LEGACY_HARD_BLOCKS, 'Bash(operator-own*)'] },
    });
    const r = await runScript('apply-settings.ts', { args: [file, 'deny', 'standard'] });
    expect(r.exitCode).toBe(0);
    const settings = readSettings(file);
    const deny = settings.permissions.deny;
    const ask = settings.permissions.ask;
    for (const pattern of DENY) expect(deny).toContain(pattern);
    for (const pattern of ASK) expect(ask).toContain(pattern);
    for (const pattern of LEGACY_HARD_BLOCKS) expect(deny).toContain(pattern);
    expect(JSON.parse(r.stdout)).toEqual({ added: ASK });
    expect(deny).toContain('Bash(operator-own*)');
    expect(JSON.stringify(settings)).not.toContain('Write(');
  });

  test('deny hardened merges both arrays into deny and strips nothing', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {
      permissions: { deny: ['Bash(operator-own*)'] },
    });
    const r = await runScript('apply-settings.ts', { args: [file, 'deny', 'hardened'] });
    expect(r.exitCode).toBe(0);
    const settings = readSettings(file);
    const deny = settings.permissions.deny;
    for (const pattern of DENY) expect(deny).toContain(pattern);
    for (const pattern of ASK) expect(deny).toContain(pattern);
    expect(settings.permissions.ask).toBeUndefined();
    expect(deny).toContain('Bash(operator-own*)');
    for (const pattern of LEGACY_HARD_BLOCKS) expect(deny).toContain(pattern);
    expect(r.stdout.trim()).toBe('OK');
    expect(JSON.stringify(settings)).not.toContain('Write(');
  });

  test('deny ask-only seeds asks on a previously-seeded file and leaves deny untouched', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {
      permissions: { deny: [DENY[0], 'Bash(operator-own*)'] },
    });
    const before = fs.readFileSync(file, 'utf8');
    const r = await runScript('apply-settings.ts', { args: [file, 'deny', 'ask-only'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ added: ASK });
    const settings = readSettings(file);
    expect(settings.permissions.deny).toEqual([DENY[0], 'Bash(operator-own*)']);
    for (const pattern of ASK) expect(settings.permissions.ask).toContain(pattern);
    expect(before).not.toBe(fs.readFileSync(file, 'utf8'));
    expect(JSON.stringify(settings)).not.toContain('Write(');
  });

  // The ask-only and hardened tests above carry every ASK entry; this pins the spellings.
  test('every hermitd update spelling is a seeded ask rule', () => {
    for (const pattern of [
      'Bash(hermitd update*)',
      'Bash(*/hermitd update*)',
      'Bash(*.hermit/bin/hermitd-update*)',
      'Bash(*.hermit/bin/hermitd-run hermitd-update*)',
      'Bash(hermitd run *hermitd-update*)',
      'Bash(*/hermitd run *hermitd-update*)',
    ]) expect(ASK).toContain(pattern);
  });

  test('trust-workspace apply spellings are seeded asks, but check is not', () => {
    const patterns = [
      'Bash(bun */scripts/trust-workspace.ts apply *)',
      'Bash(*.hermit/bin/hermitd-run trust-workspace apply*)',
      'Bash(hermitd run trust-workspace apply*)',
      'Bash(*/hermitd run trust-workspace apply*)',
    ];
    expect(ASK.filter((pattern) => pattern.includes('trust-workspace'))).toEqual(patterns);
    for (const [index, command] of [
      'bun /plugin/scripts/trust-workspace.ts check /root/.hermit /root/repo',
      '/root/.hermit/bin/hermitd-run trust-workspace check /root/.hermit /root/repo',
      'hermitd run trust-workspace check /root/.hermit /root/repo',
      '/usr/bin/hermitd run trust-workspace check /root/.hermit /root/repo',
    ].entries()) {
      const glob = patterns[index].slice(5, -1).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
      expect(new RegExp(`^${glob}$`).test(command)).toBe(false);
      expect(new RegExp(`^${glob}$`).test(command.replace(' check ', ' apply '))).toBe(true);
    }
  });

  test('deny ask-only skips and writes nothing on a virgin file', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, { permissions: { deny: ['Bash(operator-own*)'] } });
    const before = fs.readFileSync(file, 'utf8');
    const r = await runScript('apply-settings.ts', { args: [file, 'deny', 'ask-only'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skipped', reason: 'not_seeded' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('re-runs add nothing — additive and idempotent', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, { permissions: { deny: ['Bash(operator-own*)'] } });
    await runScript('apply-settings.ts', { args: [file, 'deny', 'standard'] });
    const once = readSettings(file);
    const r = await runScript('apply-settings.ts', { args: [file, 'deny', 'standard'] });
    expect(r.exitCode).toBe(0);
    const twice = readSettings(file);
    expect(twice.permissions.deny).toEqual(once.permissions.deny);
    expect(twice.permissions.ask).toEqual(once.permissions.ask);
    expect(twice.permissions.deny.filter((p: string) => p === 'Bash(rm -fr *)').length).toBe(1);
    expect(twice.permissions.ask.filter((p: string) => p === 'Bash(ssh *)').length).toBe(1);
    expect(twice.permissions.deny).toContain('Bash(operator-own*)');
  });

  test('unknown deny arg exits 1', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {});
    const r = await runScript('apply-settings.ts', { args: [file, 'deny', 'consent'] });
    expect(r.exitCode).toBe(1);
  });
});


test('message rewording asks for every spelling, leaving maintenance and reads alone', () => {
  const spellings = [
    'bun /plugin/scripts/messages.ts', '/root/.hermit/bin/hermitd-run messages',
    'hermitd run messages', '/usr/bin/hermitd run messages',
  ];
  const patterns = ASK.filter(pattern => pattern.includes('messages'));
  expect(patterns).toHaveLength(8);
  const matches = (command: string) => patterns.some(pattern => {
    const glob = pattern.slice(5, -1).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${glob}$`).test(command);
  });
  for (const spelling of spellings) {
    for (const verb of ['set', 'reset']) expect(matches(`${spelling} ${verb} .hermit deny_tail text`)).toBe(true);
    for (const verb of ['scaffold', 'apply', 'clear', 'list', 'status']) expect(matches(`${spelling} ${verb} .hermit`)).toBe(false);
  }
});
