import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('tool-counter-');
afterAll(cleanup);
test('counter counts resident calls only and prints nothing', async () => {
  const dir = freshDir(); const state = path.join(dir, '.hermit/state'); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, '.guest-guest'), '');
  for (const payload of [
    { tool_name: 'Bash' }, { tool_name: 'Skill' },
    { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'normal.md') } },
    { tool_name: 'Bash', agent_id: 'worker' }, { tool_name: 'Bash', session_id: 'guest' },
    { tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.claude/skills/sample/SKILL.md') } },
  ]) {
    const result = await runScript('tool-counter.ts', { cwd: dir, env: { AGENT_DIR: path.join(dir, '.hermit') }, stdin: JSON.stringify(payload) });
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe('');
  }
  expect(fs.statSync(path.join(state, 'skill-review-counter')).size).toBe(3);
});
test('counter stops growing once the review threshold is met', async () => {
  const dir = freshDir(); const state = path.join(dir, '.hermit/state'); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'skill-review-counter'), '1'.repeat(10));
  await runScript('tool-counter.ts', { cwd: dir, env: { AGENT_DIR: path.join(dir, '.hermit') }, stdin: JSON.stringify({ tool_name: 'Bash' }) });
  expect(fs.statSync(path.join(state, 'skill-review-counter')).size).toBe(10);
});
