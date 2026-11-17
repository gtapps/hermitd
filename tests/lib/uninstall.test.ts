import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true }); });
const repo = path.resolve(import.meta.dir, '../..');
function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}
async function uninstall(remaining: boolean, foreign = false, docker = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-uninstall-'))); roots.push(root);
  const project = path.join(root, 'project');
  const state = path.join(project, '.hermit');
  write(path.join(state, 'config.json'), '{}');
  const registry = path.join(root, 'plugins/data/hermitd-mp/instances.json');
  write(registry, JSON.stringify([{ project_dir: project, name: 'project', agent_name: 'test', runtime_hint: docker ? 'docker' : 'tmux', registered_at: new Date().toISOString() }]));
  const shim = path.join(root, '.local/bin/hermitd');
  write(shim, foreign ? '#!/bin/sh\necho foreign\n' : '#!/bin/sh\n# hermitd: managed host CLI\n');
  const cli = path.join(repo, 'plugins/hermitd/scripts/hermitd-cli.ts');
  const code = `import { main } from ${JSON.stringify(cli)}; process.exitCode = main(process.argv.slice(2), process.cwd(), process.env.TEST_CORE_ROOT);`;
  write(path.join(root, 'prune.ts'), code);
  write(path.join(state, 'bin/hermitd-run'), '#!/bin/sh\nshift\nexec "$TEST_BUN" "$HOME/prune.ts" "$@"\n');
  if (docker) {
    for (const verb of ['run', 'stop', 'watchdog', 'docker']) {
      write(path.join(state, `bin/hermitd-${verb}`), '#!/bin/sh\necho project-wrapper-ran >&2\nexit 8\n');
    }
    write(shim, '#!/bin/sh\n# hermitd: managed host CLI\nif [ "$*" = "docker down" ]; then exit 0; fi\nexec "$TEST_BUN" "$HOME/prune.ts" "$@"\n');
  }
  const bin = path.join(root, 'bin');
  write(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$2" = list ]; then printf "%s\\n" "$TEST_INSTALLS"; fi\nexit 0\n');
  for (const name of ['tmux', 'docker', 'crontab']) write(path.join(bin, name), '#!/bin/sh\nexit 1\n');
  const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(root, 'plugins'), PATH: `${bin}:${process.env.PATH}`, TEST_BUN: process.execPath, TEST_CORE_ROOT: path.join(root, 'plugins/cache/mp/hermitd/1'), TEST_INSTALLS: JSON.stringify(remaining ? [{ id: 'hermitd@other' }] : []) };
  const child = Bun.spawn(['bash', path.join(repo, 'scripts/uninstall.sh')], { cwd: project, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { shim, registry, stdout, stderr, exitCode };
}
test('uninstall removes registration and the last managed shim', async () => {
  const result = await uninstall(false);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(result.registry, 'utf8'))).toEqual([]);
  expect(fs.existsSync(result.shim)).toBe(false);
});
test('another core install keeps the managed shim', async () => {
  const result = await uninstall(true);
  expect(result.exitCode).toBe(0);
  expect(fs.existsSync(result.shim)).toBe(true);
});
test('foreign shim survives the last core uninstall', async () => {
  const result = await uninstall(false, true);
  expect(result.exitCode).toBe(0);
  expect(fs.readFileSync(result.shim, 'utf8')).toContain('foreign');
});
test('a registered Docker project with Compose deleted never runs project wrappers during uninstall', async () => {
  const result = await uninstall(false, false, true);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('container stopped');
  expect(result.stderr).not.toContain('project-wrapper-ran');
  expect(JSON.parse(fs.readFileSync(result.registry, 'utf8'))).toEqual([]);
});
