import { afterEach, expect, test as bunTest } from 'bun:test';
const test = bunTest.serial;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prune, readRegistry, registerProject, registryDir } from '../scripts/lib/host-registry';
const dirs: string[] = [];
const previous = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
afterEach(() => { if (previous === undefined) delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR; else process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = previous; for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-registry-')); dirs.push(root);
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = path.join(root, 'plugins');
  const core = path.join(root, 'cache/mp/hermitd/1');
  const project = (name: string) => { const p = path.join(root, name); fs.mkdirSync(path.join(p, '.hermit'), { recursive: true }); fs.writeFileSync(path.join(p, '.hermit/config.json'), '{}'); return p; };
  return { root, core, project };
}
test('canonical dedupe, read-only reads, missing and unreadable pruning', () => {
  const f = fixture(); const a = f.project('a'); const b = f.project('b'); const c = f.project('c');
  for (const p of [a, b, c]) registerProject(p, f.core);
  fs.symlinkSync(a, path.join(f.root, 'alias')); registerProject(path.join(f.root, 'alias'), f.core);
  const file = path.join(registryDir('mp'), 'instances.json'); const before = fs.statSync(file).mtimeMs;
  expect(readRegistry('mp')).toHaveLength(3); expect(fs.statSync(file).mtimeMs).toBe(before);
  fs.unlinkSync(path.join(b, '.hermit/config.json'));
  fs.unlinkSync(path.join(c, '.hermit/config.json'));
  fs.mkdirSync(path.join(c, '.hermit/config.json')); // EISDIR is unreadable, not missing.
  expect(readRegistry('mp').find(row => row.name === 'c')?.state).toBe('unreadable');
  prune('mp'); expect(readRegistry('mp').map(row => row.name)).toEqual(['c', 'a']);
  prune('mp', 'c'); expect(readRegistry('mp')).toHaveLength(1);
});
test('inline core registration silently writes nothing', () => {
  const f = fixture(); registerProject(f.project('a'), f.root);
  expect(fs.existsSync(registryDir('mp'))).toBe(false);
});
test('Docker registrations cannot be downgraded to tmux', () => {
  const f = fixture(); const project = f.project('a');
  registerProject(project, f.core, 'docker');
  registerProject(project, f.core, 'tmux');
  expect(readRegistry('mp')[0]?.runtime_hint).toBe('docker');
});
test('concurrent processes preserve both registrations', async () => {
  const f = fixture(); const module = path.resolve(import.meta.dir, '../scripts/lib/host-registry.ts');
  const children = ['a', 'b'].map(name => Bun.spawn([process.execPath, '-e', `import { registerProject } from ${JSON.stringify(module)}; registerProject(${JSON.stringify(f.project(name))}, ${JSON.stringify(f.core)});`], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' }));
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
  expect(readRegistry('mp')).toHaveLength(2);
});
