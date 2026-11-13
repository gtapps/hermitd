import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { composeFiles } from '../scripts/lib/compose-files';
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
