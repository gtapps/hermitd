import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readChannelToken } from '../scripts/lib/channel-token';
import { privateEnvPath, upsertEnvVar } from '../scripts/lib/env-file';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('env-file-');
afterAll(cleanup);

test('relative destinations resolve against the project and may have missing parents', () => {
  const root = freshDir();
  expect(process.cwd()).not.toBe(root);
  const file = '.claude.local/channels/demo/.env';
  expect(privateEnvPath(root, file)).toBe(path.join(root, file));
});

test('rejects wrong names, outside paths, non-regular files and escaping symlinks', () => {
  const root = freshDir();
  const local = path.join(root, '.claude.local');
  const outside = freshDir();
  fs.mkdirSync(local);
  fs.symlinkSync(outside, path.join(local, 'escape'));
  fs.symlinkSync(path.join(outside, 'missing'), path.join(local, '.env'));
  fs.mkdirSync(path.join(local, 'folder/.env'), { recursive: true });
  fs.mkdirSync(path.join(local, 'linked'));
  fs.writeFileSync(path.join(local, 'regular'), 'TOKEN=keep');
  fs.symlinkSync(path.join(local, 'regular'), path.join(local, 'linked/.env'));
  for (const file of ['.claude.local/env', '.env', path.join(outside, '.env'),
    '.claude.local/escape/nested/.env', '.claude.local/.env', '.claude.local/folder/.env',
    '.claude.local/linked/.env', '.claude.local/regular/.env']) {
    expect(privateEnvPath(root, file)).toBeNull();
  }
  const linkedRoot = freshDir();
  fs.symlinkSync(outside, path.join(linkedRoot, '.claude.local'));
  expect(privateEnvPath(linkedRoot, '.claude.local/new/.env')).toBeNull();
});

test('replaces the first parsed key, removes duplicates and preserves unrelated lines', () => {
  const root = freshDir();
  const file = privateEnvPath(root, '.claude.local/channels/demo/.env')!;
  upsertEnvVar(file, 'TOKEN', 'first');
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  fs.writeFileSync(file, 'export TOKEN = "old"\n# keep\nOTHER = value\nTOKEN=duplicate\n');
  fs.chmodSync(file, 0o644);
  upsertEnvVar(file, 'TOKEN', 'a=b"c');
  expect(fs.readFileSync(file, 'utf8')).toBe('TOKEN="a=b"c"\n# keep\nOTHER = value\n');
  expect(readChannelToken(path.join(root, '.hermit'), 'demo', {}, 'TOKEN')).toBe('a=b"c');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
