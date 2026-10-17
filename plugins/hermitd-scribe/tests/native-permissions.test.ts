import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const script = join(import.meta.dir, '../scripts/native-permissions.ts');
const rules = [
  'Bash(*file-issue.ts* --publish *)',
  'Bash(*file-issue.ts* --comment *)',
];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scribe-permissions-'));
  roots.push(root);
  mkdirSync(join(root, '.claude'));
  return root;
}
function run(target: string) {
  return Bun.spawnSync(['bun', script, target]);
}

for (const scope of ['settings.json', 'settings.local.json']) {
  test(`installs publication asks in a new project ${scope}`, () => {
    const target = join(fixture(), '.claude', scope);
    const result = run(target);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('OK\n');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ permissions: { ask: rules } });
  });

  test(`preserves operator policy and repeats without rewriting ${scope}`, () => {
    const target = join(fixture(), '.claude', scope);
    const original = {
      env: { KEEP: 'yes' },
      permissions: { allow: ['Bash(*)'], deny: [rules[0]], ask: ['Read(private)', rules[1]] },
    };
    writeFileSync(target, JSON.stringify(original));
    expect(run(target).exitCode).toBe(0);
    const installed = JSON.parse(readFileSync(target, 'utf8'));
    expect(installed.env).toEqual(original.env);
    expect(installed.permissions.allow).toEqual(original.permissions.allow);
    expect(installed.permissions.deny).toEqual(original.permissions.deny);
    expect(installed.permissions.ask).toEqual(['Read(private)', rules[1], rules[0]]);
    const formatted = JSON.stringify(installed);
    writeFileSync(target, formatted);
    expect(run(target).exitCode).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(formatted);
  });
}

test('invalid settings remain untouched', () => {
  const target = join(fixture(), '.claude/settings.json');
  const cases: [string, string][] = [
    ['{bad', 'invalid_settings'],
    ['null', 'invalid_settings'],
    ['[]', 'invalid_settings'],
    ['{"permissions":[]}', 'invalid_permissions'],
    ['{"permissions":{"ask":"bad"}}', 'invalid_permissions:ask'],
    ['{"permissions":{"deny":[3]}}', 'invalid_permissions:deny'],
  ];
  for (const [original, error] of cases) {
    writeFileSync(target, original);
    const result = run(target);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toEqual({ error });
    expect(readFileSync(target, 'utf8')).toBe(original);
  }
});

test('refuses paths outside project .claude settings', () => {
  const root = fixture();
  for (const [target, error] of [[join(root, 'settings.json'), 'not_project_settings'], [join(root, '.claude/config.json'), 'usage']]) {
    const result = run(target);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toEqual({ error });
  }
});
