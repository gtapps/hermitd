import { afterEach, expect, test as bunTest } from 'bun:test';
const test = bunTest.serial;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectStatus, renderStatus } from '../scripts/lib/hermit-status';
import { mutateTask } from '../scripts/lib/tasks';
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
