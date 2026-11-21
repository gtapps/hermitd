import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('channel-token-');
afterAll(cleanup);

const token = 'test-token=123';
const name = 'TELEGRAM_BOT_TOKEN';
const defaultFile = '.claude.local/channels/telegram/.env';

function save(project: string, options: { name?: string; stdin?: string; docker?: boolean; env?: Record<string, string> } = {}) {
  return runScript('channel-token.ts', {
    args: ['telegram', project, options.name ?? name, ...(options.docker ? ['--docker'] : [])],
    stdin: options.stdin ?? token + '\n',
    env: { container: '', ...options.env },
  });
}

test('saves stdin privately, keeps other lines and reports only metadata', async () => {
  const root = freshDir();
  const file = path.join(root, defaultFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# keep\nOTHER=keep\n${name}=old\n`, { mode: 0o644 });
  const result = await save(root);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain(token);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'saved', channel: 'telegram', file, length: token.length });
  expect(fs.readFileSync(file, 'utf8')).toBe(`# keep\nOTHER=keep\n${name}=${token}\n`);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test.each([
  [{ name: 'INVALID-NAME' }, 'invalid_var'],
  [{ stdin: '\n' }, 'bad_value'],
  [{ stdin: 'one\ntwo\n' }, 'bad_value'],
  [{ env: { TELEGRAM_STATE_DIR: 'public' } }, 'state_dir_outside_claude_local'],
  [{ env: { container: 'docker' } }, 'host_only'],
] as const)('rejects %j without writing a file', async (options, error) => {
  const root = freshDir();
  const result = await save(root, options);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ error });
  expect(fs.readdirSync(root)).toEqual([]);
});

test('rejects a symlink that escapes the private directory', async () => {
  const root = freshDir();
  const outside = freshDir();
  fs.mkdirSync(path.join(root, '.claude.local/channels'), { recursive: true });
  fs.symlinkSync(outside, path.dirname(path.join(root, defaultFile)));
  const result = await save(root);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ error: 'state_dir_outside_claude_local' });
  expect(fs.readdirSync(outside)).toEqual([]);
});

test('honours a private state directory override on the host', async () => {
  const root = freshDir();
  const result = await save(root, { env: { TELEGRAM_STATE_DIR: '.claude.local/custom' } });
  expect(result.exitCode).toBe(0);
  const file = path.join(root, '.claude.local/custom/.env');
  expect(JSON.parse(result.stdout).file).toBe(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(`${name}=${token}\n`);
});

test('uses the Docker bind mount before Compose exists', async () => {
  const root = freshDir();
  const result = await save(root, { docker: true, env: { TELEGRAM_STATE_DIR: '/ignored' } });
  expect(result.exitCode).toBe(0);
  const file = path.join(root, defaultFile);
  expect(JSON.parse(result.stdout).file).toBe(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(`${name}=${token}\n`);
});
