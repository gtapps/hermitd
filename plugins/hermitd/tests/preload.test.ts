import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ancestorGit, freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-preload-');
afterAll(cleanup);

test('fixtures live under a temp root with no .git above it', () => {
  expect(ancestorGit(os.tmpdir())).toBeNull();
  expect(ancestorGit(freshDir())).toBeNull();
});

test('ancestorGit finds a .git directory in a parent of the given dir', () => {
  const root = freshDir();
  const nested = path.join(root, 'tmp', 'fixture');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  expect(ancestorGit(nested)).toBe(path.join(root, '.git'));
});
