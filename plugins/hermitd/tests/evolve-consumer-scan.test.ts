import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve(import.meta.dir, '../scripts/evolve-plan.ts');
const subjects = { subjects: [
  { id: 'brief', terms: ['morning-brief'], kind: 'routine_id', to: 'hermitd:morning-brief' },
  { id: 'boot', terms: ['ha-boot'], kind: 'name' },
  { id: 'reflect', terms: ['reflect'], kind: 'routine_id', to: 'hermitd:reflect' },
] };
function fixture(git: boolean, body: (root: string, write: (file: string, text: string | Buffer) => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-scan-'));
  const write = (file: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('.hermit/config.json', '{}');
  if (git) Bun.spawnSync(['git', 'init', '-q', root]);
  try { body(root, write); } finally { fs.rmSync(root, { recursive: true }); }
}
function run(root: string, input = JSON.stringify(subjects), mode = true) {
  return Bun.spawnSync(['bun', script, '.hermit', ...(mode ? ['consumer-scan'] : [])], {
    cwd: root, stdin: Buffer.from(input), env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.resolve(import.meta.dir, '..') },
  });
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else result[path.relative(root, abs)] = entry.isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs).toString('base64');
    }
  }
  walk(root);
  return result;
}
for (const git of [true, false]) test(`discovery and exclusions, git=${git}`, () => fixture(git, (root, write) => {
  write('.claude/skills/house/SKILL.md', 'routine morning-brief\nhermitd:morning-brief\nmorning-briefing\nreflect\nRoutine reflect\nhermitd:reflect');
  write('CLAUDE.md', '/ha-boot');
  write('CLAUDE.local.md', 'ha-boot');
  write('.claude/settings.local.json', '{"hook":"ha-boot"}');
  for (const file of ['OPERATOR.md', 'HEARTBEAT.md', 'knowledge-schema.md', 'dashboard-render.ts']) write('.hermit/' + file, 'ha-boot');
  write('custom/.claude-plugin/plugin.json', '{}');
  for (const folder of ['skills', 'commands', 'agents', 'scripts']) write(`custom/${folder}/x`, 'ha-boot');
  write('checks/gate.sh', 'morning-brief');
  fs.chmodSync(path.join(root, 'checks/gate.sh'), 0o755);
  write('checks/monitor.ts', 'ha-boot');
  write('.hermit/config.json', JSON.stringify({ routines: [{ precheck: 'checks/gate.sh' }, { precheck: 'always' }], monitors: [{ command: 'bun "checks/monitor.ts"' }] }));
  for (const file of ['.claude/worktrees/copy/CLAUDE.md', '.claude/skills/node_modules/x', '.claude/skills/x.bak', '.claude/skills/x.new', '.claude/skills/x.orig', '.claude/skills/x~', '.claude/skills/x.2026-10-23.md']) write(file, 'ha-boot');
  write('.claude/skills/nested/.git/HEAD', 'ref: refs/heads/main');
  write('.claude/skills/nested/x', 'ha-boot');
  write('.claude/skills/binary', Buffer.from('ha-boot\0'));
  write('.claude/skills/huge', 'ha-boot'.padEnd(1024 * 1024 + 1, 'x'));
  fs.symlinkSync('/etc/hosts', path.join(root, '.claude/skills/escape'));
  const before = snapshot(root);
  const result = run(root);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(result.stdout.toString());
  expect(out.git).toBe(git);
  expect(out.counts).toEqual({ brief: 2, boot: 12, reflect: 1 });
  expect(out.context_filtered.reflect).toBe(1);
  expect(out.candidates.filter((c: any) => c.subject === 'brief').map((c: any) => c.file).sort()).toEqual(['.claude/skills/house/SKILL.md', 'checks/gate.sh']);
  expect(out.skipped.map((s: any) => s.reason).sort()).toEqual(['binary', 'outside_project', 'oversized']);
  expect(snapshot(root)).toEqual(before);
}));
test('qualified skill calls and routine markers retain old-name hits', () => fixture(false, (root, write) => {
  write('CLAUDE.md', '/hermitd-homeassistant:ha-boot\nroutine:morning-brief\n[hermit-routine:morning-brief]\nroutine:hermitd:morning-brief\nhermitd:reflect');
  const result = run(root);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(result.stdout.toString());
  expect(out.counts).toEqual({ brief: 2, boot: 1, reflect: 0 });
  expect(out.candidates.map((c: any) => c.line)).toEqual([1, 2, 3]);
}));
test('bounds and context examples', () => fixture(false, (root, write) => {
  write('CLAUDE.md', Array(220).fill('ha-boot ' + 'x'.repeat(250)).join('\n') + '\n' + Array(12).fill('reflect').join('\n'));
  const out = JSON.parse(run(root).stdout.toString());
  expect(out.counts.boot).toBe(220);
  expect(out.candidates).toHaveLength(200);
  expect(out.candidates.every((c: any) => c.text.length <= 200)).toBe(true);
  expect(out.truncated).toBe(true);
  expect(out.context_filtered.reflect).toBe(12);
  expect(out.context_filtered_examples.reflect).toHaveLength(5);
}));
test('unreadable config is reported', () => fixture(false, (root, write) => {
  write('.hermit/config.json', 'invalid');
  expect(JSON.parse(run(root).stdout.toString()).skipped).toContainEqual({ file: '.hermit/config.json', reason: 'unreadable_config' });
}));
test('invalid subjects fail', () => fixture(false, root => {
  for (const input of ['bad', '{}', '{"subjects":[{}]}']) {
    const result = run(root, input);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toEqual({ error: 'bad_subjects' });
  }
}));
test('no-mode output is unchanged by scanner calls', () => fixture(false, root => {
  const before = run(root, '', false);
  run(root);
  const after = run(root, '', false);
  expect(after.exitCode).toBe(before.exitCode);
  expect(after.stdout.toString()).toBe(before.stdout.toString());
}));
