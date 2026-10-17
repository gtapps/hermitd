import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-channel-env-');
afterAll(cleanup);

function seedSettings(dir: string, settings: any): string {
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function readSettings(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('apply-settings.ts channel-env', () => {
  test('reports the state directory and leaves existing settings byte-identical', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {
      env: { DISCORD_BOT_TOKEN: 'legacy', TELEGRAM_STATE_DIR: '/other', FOO: 'operator' },
      permissions: { allow: ['Bash(git status:*)'] },
    });
    const before = fs.readFileSync(file, 'utf8');
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'DISCORD', '/abs/state/discord'],
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ key: 'DISCORD_STATE_DIR', state_dir: '/abs/state/discord', effective: 'next_start' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('does not create an absent settings file', async () => {
    const dir = freshDir();
    const file = path.join(dir, '.claude', 'settings.local.json');
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'TELEGRAM', '/abs/state/telegram'],
    });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('requires channel and state dir arguments', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {});
    const r = await runScript('apply-settings.ts', { args: [file, 'channel-env', 'DISCORD'] });
    expect(r.exitCode).not.toBe(0);
  });

  test('refuses a channel name that is not a valid env-var identifier', async () => {
    const dir = freshDir();
    const file = seedSettings(dir, {});
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'MS-TEAMS', '/abs/state/ms-teams'],
    });
    expect(r.exitCode).not.toBe(0);
    expect(readSettings(file).env ?? {}).toEqual({});
  });

  test('refuses to overwrite a malformed settings file', async () => {
    const dir = freshDir();
    const claude = path.join(dir, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    const file = path.join(claude, 'settings.local.json');
    const malformed = '{ not valid json !!';
    fs.writeFileSync(file, malformed);
    const r = await runScript('apply-settings.ts', {
      args: [file, 'channel-env', 'DISCORD', '/abs/state/discord'],
    });
    expect(r.exitCode).not.toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(malformed);
  });
});
