import { afterEach, expect, test as bunTest } from 'bun:test';
const test = bunTest.serial;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectStatus, renderStatus } from '../scripts/lib/hermit-status';
import { mutateTask } from '../scripts/lib/tasks';
import { isDockerProject, registerProject } from '../scripts/lib/host-registry';
import { writeRegistryEntry } from './helpers/registry-fixture';
const dirs: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true }); });
function fixture(output = 'hermit-netguard', code = 0) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-status-')); dirs.push(project);
  const dir = path.join(project, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.writeFileSync(path.join(project, 'docker-compose.hermit.yml'), 'services: {}');
  fs.writeFileSync(path.join(project, 'docker'), `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`, { mode: 0o755 });
  process.env.PATH = `${project}:${originalPath}`;
  return { project, dir };
}
test('sidecar-only is down; human output and JSON are distinct', () => {
  const { project } = fixture(); const row = projectStatus(project);
  expect(row.transport).toBe('down');
  expect(renderStatus([row])).not.toContain('{"rows"');
  expect(renderStatus([row])).toContain('WORKING ON');
  expect(JSON.parse(renderStatus([row], true)).transport).toBe('down');
});
test('Docker unavailable is unknown', () => {
  expect(projectStatus(fixture('', 127).project).transport).toBe('unknown');
});
test('registered Docker status ignores runtime.json when Compose is absent', () => {
  const { project, dir } = fixture();
  const canonical = fs.realpathSync(project);
  const root = path.join(project, 'cache/mp/hermitd/1');
  const previous = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = path.join(project, 'plugins');
  try {
    registerProject(canonical, root, 'docker');
    fs.unlinkSync(path.join(project, 'docker-compose.hermit.yml'));
    fs.writeFileSync(path.join(dir, 'state/runtime.json'), '{"runtime_mode":"interactive","tmux_session":"host"}');
    expect(projectStatus(canonical, isDockerProject(canonical, root))).toMatchObject({ runtime: 'docker', transport: 'down' });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
    else process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = previous;
  }
});
test.skipIf(process.platform !== 'linux')('an interactive resident registered from another pid namespace is unknown, not down', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-status-')); dirs.push(project);
  const dir = path.join(project, '.hermit');
  const configDir = path.join(project, 'cfg');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.writeFileSync(path.join(dir, 'state', 'runtime.json'), JSON.stringify({ runtime_mode: 'interactive', session_pid: 4194000, config_dir: configDir }));
  writeRegistryEntry(configDir, 4194000, { pidDomain: 'linux:0000:pid:[4026999999]' });
  expect(projectStatus(project).transport).toBe('unknown');
  fs.rmSync(path.join(configDir, 'sessions', '4194000.json'));
  expect(projectStatus(project).transport).toBe('down');
});
test('counts all open tasks and reads do not write or consult the host registry for Docker', () => {
  const { project, dir } = fixture('hermit');
  for (let n = 0; n < 25; n++) mutateTask(dir, 'open', undefined, { title: `Task ${n}`, requester: 'operator', done: 'Verified' }, '');
  const snapshot = (): string => JSON.stringify([project, ...fs.readdirSync(project, { recursive: true }).map(f => path.join(project, String(f)))].map(f => [f, fs.statSync(f).mtimeMs]));
  const before = snapshot();
  const row = projectStatus(project);
  expect(row.open).toBe(25);
  expect(row.working_on).toBe('Task 0');
  expect(row.execution).toBe('unknown');
  expect(snapshot()).toBe(before);
});
test('work a helper runs is what the agent is working on', () => {
  const { project, dir } = fixture('hermit');
  mutateTask(dir, 'open', undefined, { title: 'Helper draft', requester: 'operator', done: 'Verified', owner: 'helper:report' }, '');
  expect(projectStatus(project).working_on).toBe('Helper draft');
});
test('the resident\'s own runnable work wins over an older helper record', () => {
  const { project, dir } = fixture('hermit');
  mutateTask(dir, 'open', undefined, { title: 'Helper draft', requester: 'operator', done: 'Verified', owner: 'helper:report' }, '');
  mutateTask(dir, 'open', undefined, { title: 'Resident fix', requester: 'operator', done: 'Verified' }, '');
  expect(projectStatus(project).working_on).toBe('Resident fix');
});
