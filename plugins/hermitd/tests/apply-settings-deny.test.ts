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

  const UPDATE_SPELLINGS = [
    'Bash(hermitd update*)',
    'Bash(*/hermitd update*)',
    'Bash(*.hermit/bin/hermitd-update*)',
    'Bash(*.hermit/bin/hermitd-run hermitd-update*)',
    'Bash(hermitd run *hermitd-update*)',
    'Bash(*/hermitd run *hermitd-update*)',
  ];

  // The standard and hardened tests above carry every DENY entry; this pins the spellings.
  test('every hermitd update spelling is a seeded deny rule, not an ask', () => {
    for (const pattern of UPDATE_SPELLINGS) {
      expect(DENY).toContain(pattern);
      expect(ASK).not.toContain(pattern);
    }
  });

  test('deny deny-only adds the missing deny rules to a seeded Standard install', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {
      permissions: { deny: [DENY[0], 'Bash(operator-own*)'], ask: [...UPDATE_SPELLINGS] },
    });
    const r = await runScript('apply-settings.ts', { args: [file, 'deny', 'deny-only'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ added: DENY.slice(1) });
    const settings = readSettings(file);
    for (const pattern of [...DENY, 'Bash(operator-own*)']) expect(settings.permissions.deny).toContain(pattern);
    expect(settings.permissions.ask).toEqual(UPDATE_SPELLINGS);
  });

  test('deny deny-only adds nothing on Hardened and skips an unseeded file', async () => {
    const dir = freshDir();
    const hardened = seedSettings(dir, { permissions: { deny: ['Bash(operator-own*)'] } });
    await runScript('apply-settings.ts', { args: [hardened, 'deny', 'hardened'] });
    const before = fs.readFileSync(hardened, 'utf8');
    let r = await runScript('apply-settings.ts', { args: [hardened, 'deny', 'deny-only'] });
    expect(JSON.parse(r.stdout)).toEqual({ added: [] });
    expect(fs.readFileSync(hardened, 'utf8')).toBe(before);
    const virgin = seedSettings(freshDir(), { permissions: { deny: ['Bash(operator-own*)'] } });
    const untouched = fs.readFileSync(virgin, 'utf8');
    r = await runScript('apply-settings.ts', { args: [virgin, 'deny', 'deny-only'] });
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skipped', reason: 'not_seeded' });
    expect(fs.readFileSync(virgin, 'utf8')).toBe(untouched);
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


describe('offered ask history', () => {
  function install(settings: any = {}) {
    const dir = freshDir();
    const state = path.join(dir, '.hermit/state');
    fs.mkdirSync(state, { recursive: true });
    return { state, file: seedSettings(dir, settings), record: path.join(state, 'ask-offered.json') };
  }
  for (const profile of ['standard', 'ask-only']) {
    test(`${profile} offers once, preserves deletions and adds newly offered entries`, async () => {
      const { file, record } = install({ permissions: { deny: [DENY[0]] } });
      const run = () => runScript('apply-settings.ts', { args: [file, 'deny', profile] });
      expect((await run()).exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual(ASK);
      const settings = readSettings(file);
      settings.permissions.ask = [];
      fs.writeFileSync(file, JSON.stringify(settings));
      expect(JSON.parse((await run()).stdout)).toEqual({ added: [] });
      expect(readSettings(file).permissions.ask).toEqual([]);
      // A later seed adds an entry the install has not seen before.
      fs.writeFileSync(record, JSON.stringify(ASK.slice(1)));
      expect(JSON.parse((await run()).stdout)).toEqual({ added: [ASK[0]] });
      expect(readSettings(file).permissions.ask).toEqual([ASK[0]]);
    });
  }
  test('ask-stamp preserves settings bytes and stamps absent ask entries', async () => {
    const { file, record } = install({ permissions: { deny: [DENY[0]], ask: ['operator'] } });
    const before = fs.readFileSync(file, 'utf8');
    const result = await runScript('apply-settings.ts', { args: [file, 'deny', 'ask-stamp'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('OK');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual(ASK);
    expect(JSON.parse((await runScript('apply-settings.ts', { args: [file, 'deny', 'standard'] })).stdout)).toEqual({ added: [] });
    expect(readSettings(file).permissions.ask).toEqual(['operator']);
  });
  test('ask-stamp skips unseeded settings and missing state', async () => {
    const { file, record } = install();
    expect(JSON.parse((await runScript('apply-settings.ts', { args: [file, 'deny', 'ask-stamp'] })).stdout)).toEqual({ status: 'skipped', reason: 'not_seeded' });
    expect(fs.existsSync(record)).toBe(false);
    const noState = seedSettings(freshDir(), { permissions: { deny: [DENY[0]] } });
    expect(JSON.parse((await runScript('apply-settings.ts', { args: [noState, 'deny', 'ask-stamp'] })).stdout)).toEqual({ status: 'skipped', reason: 'no_state_dir' });
  });
  test('failed settings write never stamps history', async () => {
    const { file, record } = install();
    // A directory at the atomic replacement target forces the write to fail.
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect((await runScript('apply-settings.ts', { args: [file, 'deny', 'standard'] })).exitCode).not.toBe(0);
    expect(fs.existsSync(record)).toBe(false);
  });
});
