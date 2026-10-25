import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('skill-guard-');
afterAll(cleanup);
function fixture() {
  const dir = freshDir(); fs.mkdirSync(path.join(dir, '.hermit/state'), { recursive: true });
  return dir;
}
function run(dir: string, payload: any) {
  return runScript('skill-guard.ts', { cwd: dir, env: { AGENT_DIR: path.join(dir, '.hermit') }, stdin: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}
function write(dir: string, content: any, relative = 'sample/SKILL.md') {
  return { tool_name: 'Write', session_id: 'resident', tool_input: { file_path: path.join(dir, '.claude/skills', relative), content } };
}
test('guard denies forbidden content, worker writes and malformed payloads', async () => {
  const dir = fixture();
  for (const payload of [write(dir, '---\nallowed-tools: Bash\n---\n'), write(dir, '!`echo x`'), write(dir, '```!echo x'), write(dir, 'x', 'sample/scripts/run.sh'), write(dir, 'x'.repeat(20001)), write(dir, null), { ...write(dir, 'ok'), agent_id: 'worker' }, `{"tool_input":{"file_path":"${dir}/.claude/skills/sample/SKILL.md"`, `.claude/skills/${'x'.repeat(1048577)}`]) {
    const result = await run(dir, payload);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  }
});
test('guard snapshots allowed edits and passes guests and other paths silently', async () => {
  const dir = fixture(); const file = path.join(dir, '.claude/skills/sample/SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'old');
  expect((await run(dir, write(dir, 'new'))).stdout).toBe('');
  expect(fs.readdirSync(path.join(dir, '.hermit/state/skill-history/sample')).length).toBe(1);
  fs.writeFileSync(path.join(dir, '.hermit/state/.guest-guest'), '');
  expect((await run(dir, { ...write(dir, '!`bad`'), session_id: 'guest' })).stdout).toBe('');
  expect((await run(dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'other'), content: '!`bad`' } })).stdout).toBe('');
  for (const payload of ['{', 'x'.repeat(1048577)]) expect((await run(dir, payload)).stdout).toBe('');
  expect((await run(dir, { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'old', new_string: '!`bad`' } })).stdout).toContain('deny');
});
test('guard simulates Edit with new_string taken literally', async () => {
  const dir = fixture(); const file = path.join(dir, '.claude/skills/sample/SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '!`ok` old');
  // String.replace would expand $` into the prefix and duplicate the existing shell block.
  expect((await run(dir, { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'old', new_string: '$`' } })).stdout).toBe('');
});
