import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { composeFiles } from '../scripts/lib/compose-files';
import { approveProject, contextsName } from '../scripts/lib/approval';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit compose files ');
afterAll(cleanup);

test.each([[false, false], [true, false], [false, true], [true, true]])('compose stack: security=%s override=%s', (security, override) => {
  const dir = freshDir();
  const files = ['docker-compose.hermit.yml'];
  if (security) files.push('docker-compose.security.yml');
  if (override) files.push('docker-compose.override.yml');
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  expect(composeFiles(dir)).toEqual(files.flatMap(file => ['-f', path.join(dir, file)]));
});
test('host callers resolve the applied stack and container callers retain the project stack', async () => {
  const project = freshDir();
  const home = freshDir();
  const base = path.join(project, 'docker-compose.hermit.yml');
  fs.writeFileSync(base, 'services: {}\n');
  const result = await approveProject(project, { configRoot: path.join(home, '.claude'), report: () => {} });
  expect(result.code).toBe(0);
  const set = result.applied!;
  fs.writeFileSync(path.join(project, 'docker-compose.override.yml'), 'services: {}\n');
  const module = path.resolve(import.meta.dir, '../scripts/lib/compose-files.ts');
  const code = `import { composeFiles } from ${JSON.stringify(module)};
console.log(JSON.stringify(composeFiles(process.argv[1])));`;
  for (const container of ['', 'docker']) {
    const child = Bun.spawn([process.execPath, '-e', code, project], {
      env: { ...process.env, HOME: home, container }, stdout: 'pipe',
    });
    const args = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(args).toEqual(container
      ? ['-f', base, '-f', path.join(project, 'docker-compose.override.yml')]
      : ['--project-directory', project, '--env-file', path.join(set, '.env'),
        '-f', path.join(set, 'docker-compose.hermit.yml'), '-f', path.join(set, contextsName)]);
  }
});
