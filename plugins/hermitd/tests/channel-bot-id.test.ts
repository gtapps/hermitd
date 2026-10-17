// Behavioral tests for scripts/channel-bot-id.ts — the pairing-time capture of
// a channel bot's own platform id. Driven as a subprocess (the boundary a
// setup skill and hermit-evolve see), with a local Bun.serve standing in for
// the platform API via the HERMIT_DOCTOR_*_API overrides the probe lib reads.
//
// Usage: bun test tests/channel-bot-id.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, writeConfig, type Workdir } from './helpers/workdir';

const TOKEN = '111222333:AAsecret-token-value';

// `<NAME>_STATE_DIR` is wired into this repo's own settings.local.json, so it
// is present in the ambient env of any spawn here and would otherwise point the
// script at the maintainer's real channel state instead of the fixture. Every
// run below pins it explicitly.

// One fake platform for both shapes: Discord returns the user object flat,
// Telegram wraps it in `result` (and carries the token in the path).
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/users/@me')) {
      if (req.headers.get('authorization') !== `Bot ${TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      return Response.json({ id: '987654321098765432', username: 'hermitbot' });
    }
    if (url.pathname.endsWith('/getMe')) {
      return Response.json({ ok: true, result: { id: 111222333, username: 'hermit_tg_bot' } });
    }
    if (url.pathname.endsWith('/boom')) return new Response('nope', { status: 500 });
    return new Response('not found', { status: 404 });
  },
});
const API = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const hermitDir = (dir: string) => path.join(dir, '.hermit');
const readConfig = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(hermitDir(dir), 'config.json'), 'utf-8'));

const fixtureStateDir = (dir: string, channel: string) =>
  path.join(dir, '.claude.local', 'channels', channel);

function writeToken(dir: string, channel: string, varName: string, token = TOKEN): void {
  const stateDir = fixtureStateDir(dir, channel);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), `${varName}=${token}\n`);
}

const stateDirEnv = (dir: string) => ({
  DISCORD_STATE_DIR: fixtureStateDir(dir, 'discord'),
  TELEGRAM_STATE_DIR: fixtureStateDir(dir, 'telegram'),
});

const run = (dir: string, channel: string, ...args: string[]) =>
  runScript('channel-bot-id.ts', {
    args: [hermitDir(dir), channel, ...args],
    cwd: dir,
    env: { HERMIT_DOCTOR_DISCORD_API: API, HERMIT_DOCTOR_TELEGRAM_API: API, ...stateDirEnv(dir) },
  });

function withDir(cfg: object, fn: (dir: string) => Promise<void>) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    writeConfig(wd.dir, cfg);
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const DISCORD_CFG = { channels: { discord: { enabled: true, allowed_users: ['U1'] } } };

describe('channel-bot-id', () => {
  test('discord — reports the bot identity without writing by default', withDir(DISCORD_CFG, async (dir) => {
    writeToken(dir, 'discord', 'DISCORD_BOT_TOKEN');
    const r = await run(dir, 'discord');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ channel: 'discord', bot_user_id: '987654321098765432', bot_username: 'hermitbot', written: false });
    expect(readConfig(dir).channels.discord.bot_user_id).toBeUndefined();
  }));

  test('--write merges into the channel entry, preserving other keys', withDir(DISCORD_CFG, async (dir) => {
    writeToken(dir, 'discord', 'DISCORD_BOT_TOKEN');
    const r = await run(dir, 'discord', '--write');
    expect(JSON.parse(r.stdout)).toEqual({ channel: 'discord', bot_user_id: '987654321098765432', bot_username: 'hermitbot', written: true });
    const ch = readConfig(dir).channels.discord;
    expect(ch.bot_user_id).toBe('987654321098765432');
    expect(ch.bot_username).toBe('hermitbot');
    expect(ch.allowed_users).toEqual(['U1']); // untouched
    expect(ch.enabled).toBe(true);
  }));

  test('--write overwrites a stale id from a previous bot', withDir(
    { channels: { discord: { enabled: true, bot_user_id: 'OLD', bot_username: 'oldbot' } } },
    async (dir) => {
      writeToken(dir, 'discord', 'DISCORD_BOT_TOKEN');
      await run(dir, 'discord', '--write');
      expect(readConfig(dir).channels.discord.bot_user_id).toBe('987654321098765432');
      expect(readConfig(dir).channels.discord.bot_username).toBe('hermitbot');
    },
  ));

  test('telegram — unwraps result and stringifies a numeric id', withDir(
    { channels: { telegram: { enabled: true } } },
    async (dir) => {
      writeToken(dir, 'telegram', 'TELEGRAM_BOT_TOKEN');
      const r = await run(dir, 'telegram', '--write');
      expect(JSON.parse(r.stdout)).toEqual({ channel: 'telegram', bot_user_id: '111222333', bot_username: 'hermit_tg_bot', written: true });
      expect(readConfig(dir).channels.telegram.bot_user_id).toBe('111222333');
    },
  ));

  test('no token — SKIPs, exit 0, config untouched', withDir(DISCORD_CFG, async (dir) => {
    const r = await run(dir, 'discord', '--write');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skip', reason: 'no_token', channel: 'discord' });
    expect(readConfig(dir).channels.discord.bot_user_id).toBeUndefined();
  }));

  test('unknown platform — SKIPs without probing', withDir(
    { channels: { matrix: { enabled: true } } },
    async (dir) => {
      const r = await run(dir, 'matrix', '--write');
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ status: 'skip', reason: 'no_identity_probe', channel: 'matrix' });
    },
  ));

  test('channel absent from config — SKIPs', withDir(DISCORD_CFG, async (dir) => {
    const r = await run(dir, 'telegram', '--write');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skip', reason: 'no_channel_entry', channel: 'telegram' });
  }));

  test('non-2xx probe — SKIPs with the status, config untouched', withDir(DISCORD_CFG, async (dir) => {
    writeToken(dir, 'discord', 'DISCORD_BOT_TOKEN', 'wrong-token');
    const r = await run(dir, 'discord', '--write');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skip', reason: 'http_401', channel: 'discord' });
    expect(readConfig(dir).channels.discord.bot_user_id).toBeUndefined();
  }));

  test('unreachable API — SKIPs with a fixed reason, never the URL or token', withDir(DISCORD_CFG, async (dir) => {
    writeToken(dir, 'discord', 'DISCORD_BOT_TOKEN');
    const r = await runScript('channel-bot-id.ts', {
      args: [hermitDir(dir), 'discord', '--write'],
      cwd: dir,
      // Port 1 is reserved and refuses instantly — no timeout wait.
      env: { HERMIT_DOCTOR_DISCORD_API: 'http://localhost:1', ...stateDirEnv(dir) },
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'skip', reason: 'probe_network_error' });
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.stdout).not.toContain('localhost:1');
  }));

  test('the token never reaches stdout on the success path', withDir(
    { channels: { telegram: { enabled: true } } },
    async (dir) => {
      writeToken(dir, 'telegram', 'TELEGRAM_BOT_TOKEN');
      const r = await run(dir, 'telegram', '--write');
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    },
  ));
});
