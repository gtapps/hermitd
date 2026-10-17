import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const script = join(import.meta.dir, '../scripts/native-permissions.ts');
const rules: string[] = JSON.parse(readFileSync(join(import.meta.dir, '../state-templates/native-permissions.json'), 'utf8')).ask;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-permissions-')); dirs.push(root);
  mkdirSync(join(root, '.claude')); mkdirSync(join(root, '.hermit'));
  return root;
}
function run(root: string, file = '.claude/settings.local.json') {
  return Bun.spawnSync(['bun', script, join(root, file)]);
}
test('install preserves unrelated settings and denies; repeated seeding is stable', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  writeFileSync(file, JSON.stringify({ env: { KEEP: 'yes' }, permissions: { deny: ['Bash(custom *)'], ask: ['Read(private)'] } }));
  const first = run(root);
  expect(first.exitCode).toBe(0); expect(first.stdout.toString()).toBe('OK\n');
  const once = readFileSync(file, 'utf8'), data = JSON.parse(once);
  expect(data.env.KEEP).toBe('yes'); expect(data.permissions.deny).toEqual(['Bash(custom *)']);
  for (const rule of rules) expect(data.permissions.ask).toContain(rule);
  expect(run(root).exitCode).toBe(0); expect(readFileSync(file, 'utf8')).toBe(once);
});
test('malformed permission arrays are not overwritten', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  const original = '{"permissions":{"ask":"bad"}}'; writeFileSync(file, original);
  const result = run(root);
  expect(result.exitCode).toBe(1); expect(readFileSync(file, 'utf8')).toBe(original);
  expect(JSON.parse(result.stdout.toString())).toEqual({ error: 'invalid_permissions:ask' });
});
test('an existing deny on a shipped ask is reported', () => {
  const root = fixture(), file = join(root, '.claude/settings.local.json');
  writeFileSync(file, JSON.stringify({ permissions: { deny: [rules[0]] } }));
  const result = run(root);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ status: 'installed', deny_conflicts: [rules[0]] });
});
test('failures print one error token', () => {
  const root = fixture();
  expect(JSON.parse(run(root, 'settings.json').stdout.toString())).toEqual({ error: 'not_project_settings' });
  const usage = Bun.spawnSync(['bun', script]);
  expect(usage.exitCode).toBe(1); expect(JSON.parse(usage.stdout.toString())).toEqual({ error: 'usage' });
  writeFileSync(join(root, '.claude/settings.local.json'), '{ not json');
  expect(JSON.parse(run(root).stdout.toString())).toEqual({ error: 'invalid_settings' });
});
