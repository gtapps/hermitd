import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('skill-lint-');
afterAll(cleanup);
async function write(dir: string, content: string, name = 'sample') {
  const file = path.join(dir, '.claude/skills', name, 'SKILL.md');
  const opts = { cwd: dir, env: { AGENT_DIR: path.join(dir, '.hermit') }, stdin: JSON.stringify({ tool_name: 'Write', session_id: 'resident', tool_input: { file_path: file, content } }) };
  await runScript('skill-guard.ts', opts);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  return runScript('skill-lint.ts', opts);
}
function fixture() { const dir = freshDir(); fs.mkdirSync(path.join(dir, '.hermit/state'), { recursive: true }); return dir; }
test('post hook records create then patch and emits warnings as context', async () => {
  const dir = fixture();
  expect((await write(dir, '---\nname: sample\ndescription: Test\n---\nSteps')).exitCode).toBe(0);
  const result = await write(dir, '---\nname: sample\ndescription: Test\n---\n[ref](references/missing.md)');
  expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('Missing reference');
  const ledger = fs.readFileSync(path.join(dir, '.hermit/state/skill-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(ledger.map(row => row.action)).toEqual(['create', 'patch']);
  expect(ledger[1].lint.warnings.length).toBe(1);
});
test('post hook exits 2 for each lint error and leaves written content', async () => {
  for (const text of ['---\nname: sample', '---\nname: [\n---\n', '---\nname: other\n---\n', '---\nname: BAD\n---\n']) {
    const dir = fixture(); const result = await write(dir, text);
    expect(result.exitCode).toBe(2); expect(result.stderr.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(dir, '.claude/skills/sample/SKILL.md'), 'utf8')).toBe(text);
    expect(fs.readFileSync(path.join(dir, '.hermit/state/skill-ledger.jsonl'), 'utf8')).toContain('errors');
  }
});

test('invalid folder names reach lint and still record the write', async () => {
  const dir = fixture();
  const result = await write(dir, '---\nname: Bad_Name\n---\nSteps', 'Bad_Name');
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain('Invalid skill name');
  expect(fs.readFileSync(path.join(dir, '.hermit/state/skill-ledger.jsonl'), 'utf8')).toContain('Bad_Name');
});
