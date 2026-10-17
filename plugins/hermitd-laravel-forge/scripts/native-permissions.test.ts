import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const script = join(import.meta.dir, 'native-permissions.ts');
const template: { ask: string[]; deny: string[] } = JSON.parse(readFileSync(join(import.meta.dir, '../state-templates/native-permissions.json'), 'utf8'));
const rules = template.ask;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-permissions-')); dirs.push(root);
  mkdirSync(join(root, '.claude')); mkdirSync(join(root, '.hermit'));
  return root;
}
function run(root: string) {
  return Bun.spawnSync(['bun', script, join(root, '.claude/settings.local.json')]);
}
test('install preserves unrelated settings and denies; repeated seeding is stable', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  writeFileSync(file, JSON.stringify({ env: { KEEP: 'yes' }, permissions: { deny: ['Bash(custom *)'], ask: ['Read(private)'] } }));
  const first = run(root);
  expect(first.exitCode).toBe(0); expect(first.stdout.toString()).toBe('OK\n');
  const once = readFileSync(file, 'utf8'), data = JSON.parse(once);
  expect(data.env.KEEP).toBe('yes'); expect(data.permissions.deny).toEqual(['Bash(custom *)', 'Edit(.env)']);
  for (const rule of rules) expect(data.permissions.ask).toContain(rule);
  expect(run(root).exitCode).toBe(0); expect(readFileSync(file, 'utf8')).toBe(once);
});
test('installation preserves other settings scopes and configuration', () => {
  const root = fixture();
  const shared = join(root, '.claude/settings.json');
  const config = join(root, '.hermit/config.json');
  writeFileSync(shared, JSON.stringify({ permissions: { deny: rules } }));
  writeFileSync(config, '{"custom":7}');
  const originals = [shared, config].map(file => readFileSync(file, 'utf8'));
  expect(run(root).exitCode).toBe(0);
  expect(run(root).exitCode).toBe(0);
  expect([shared, config].map(file => readFileSync(file, 'utf8'))).toEqual(originals);
});
test('fresh installation reports target denies and writes nothing outside the target', () => {
  const root = fixture();
  const file = join(root, '.claude/settings.local.json');
  writeFileSync(file, JSON.stringify({ permissions: { deny: rules } }));
  const result = run(root);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ status: 'installed', deny_conflicts: rules });
  expect(JSON.parse(readFileSync(file, 'utf8')).permissions.deny).toEqual([...rules, ...template.deny]);
  expect(existsSync(join(root, '.hermit/state'))).toBe(false);
});
test('malformed permission arrays are not overwritten', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  const original = '{"permissions":{"ask":"bad"}}'; writeFileSync(file, original);
  const result = run(root);
  expect(result.exitCode).toBe(1); expect(JSON.parse(result.stdout.toString())).toEqual({ error: 'invalid_permissions:ask' });
  expect(readFileSync(file, 'utf8')).toBe(original);
});
test('unparseable settings and a non-project target fail with an error token', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  writeFileSync(file, '{ not json');
  const broken = run(root);
  expect(broken.exitCode).toBe(1); expect(JSON.parse(broken.stdout.toString())).toEqual({ error: 'invalid_settings' });
  const outside = Bun.spawnSync(['bun', script, join(root, 'settings.json')]);
  expect(outside.exitCode).toBe(1); expect(JSON.parse(outside.stdout.toString())).toEqual({ error: 'not_project_settings' });
  const usage = Bun.spawnSync(['bun', script]);
  expect(usage.exitCode).toBe(1); expect(JSON.parse(usage.stdout.toString())).toEqual({ error: 'usage' });
});
