import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { memoryDirFor } from '../scripts/lib/cc-compat';
const { freshDir, cleanup } = freshDirFactory('dream-fence-');
afterAll(cleanup);
function fixture() {
  const root = freshDir(), dir = path.join(root, '.hermit'), config = path.join(root, 'cc'), memory = memoryDirFor(root, config);
  fs.mkdirSync(memory, { recursive: true }); fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(dir, 'compiled'), { recursive: true });
  for (const file of [path.join(config, 'settings.json'), path.join(root, '.claude/settings.json'), path.join(root, '.claude/settings.local.json'), path.join(dir, 'claude-settings.json')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
  }
  const run = (payload: any) => runScript('dream-fence.ts', { cwd: root, env: { AGENT_DIR: dir, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: '' }, stdin: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const write = (file: string, tool = 'Write') => ({ agent_type: 'hermitd:dream-analyzer', tool_name: tool, tool_input: { file_path: file, content: 'new' } });
  return { root, dir, memory, run, write };
}
test('dream workers write memory and only topic pages; other callers are silent', async () => {
  const f = fixture();
  for (const file of [path.join(f.memory, 'fact.md'), path.join(f.dir, 'compiled/topic-a.md')]) {
    for (const tool of ['Write', 'Edit']) expect((await f.run(f.write(file, tool))).stdout).toBe('');
  }
  expect((await f.run({ ...f.write('/outside'), agent_type: 'other' })).stdout).toBe('');
  for (const payload of [f.write(path.join(f.memory, 'feedback_role_x.md')), f.write(path.join(f.dir, 'compiled/assessment-a.md')), f.write(path.join(f.root, 'outside')),
    f.write(f.memory + '/../memory/fact.md'), '{', { agent_type: 'hermitd:dream-organizer' }]) {
    const result = await f.run(payload); expect(result.exitCode).toBe(0); expect(result.stdout).toContain('"permissionDecision":"deny"');
  }
});
test('symlinks and dangling symlink parents cannot escape', async () => {
  const f = fixture();
  fs.symlinkSync(f.root, path.join(f.memory, 'escape'));
  fs.symlinkSync(path.join(f.root, 'absent'), path.join(f.memory, 'dangling'));
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.dir, 'compiled/topic-link.md'));
  for (const file of [path.join(f.memory, 'escape/out.md'), path.join(f.memory, 'dangling/out.md'), path.join(f.dir, 'compiled/topic-link.md')]) {
    expect((await f.run(f.write(file))).stdout).toContain('deny');
  }
});
