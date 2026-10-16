import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupWorkdir } from './helpers/workdir';
import { checkPassiveChats, resolvePaths } from '../scripts/doctor-check';

for (const [name, access, status, detail] of [
  ['ungated', { groups: { '1': { requireMention: false, allowFrom: [] } } }, 'ok', 'threads follow the parent'],
  ['mention gate', { groups: { '1': { requireMention: true, allowFrom: [] } } }, 'warn', 'requireMention:false'],
  ['sender gate', { groups: { '1': { requireMention: false, allowFrom: ['u1'] } } }, 'warn', 'allowFrom:[]'],
  ['missing file', undefined, 'warn', 'could not verify'],
  ['missing group', { groups: {} }, 'warn', 'groups.1'],
  ['unexpected shape', { groups: [] }, 'warn', 'could not verify'],
  ['invalid JSON', 'invalid', 'warn', 'could not verify'],
] as const) {
  test(`passive-chats doctor: ${name}`, () => {
    const wd = setupWorkdir();
    const dir = path.join(wd.dir, '.hermit');
    const stateDir = path.join(wd.dir, 'discord');
    fs.mkdirSync(stateDir);
    const prev = process.env.DISCORD_STATE_DIR;
    process.env.DISCORD_STATE_DIR = stateDir;
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        channels: { discord: { passive_chats: ['1'], bot_user_id: '123', allowed_users: ['u1'] } },
      }));
      if (access !== undefined) fs.writeFileSync(path.join(stateDir, 'access.json'), typeof access === 'string' ? access : JSON.stringify(access));
      const result = checkPassiveChats(resolvePaths(dir, path.resolve(import.meta.dir, '..')));
      expect(result.id).toBe('passive-chats');
      expect(result.status).toBe(status);
      expect(result.detail).toContain(detail);
    } finally {
      if (prev === undefined) delete process.env.DISCORD_STATE_DIR;
      else process.env.DISCORD_STATE_DIR = prev;
      wd.cleanup();
    }
  });
}

test('a passive chat without a bot identity or an allowlist warns on both', () => {
  const wd = setupWorkdir();
  const dir = path.join(wd.dir, '.hermit');
  const paths = resolvePaths(dir, path.resolve(import.meta.dir, '..'));
  try {
    fs.writeFileSync(paths.configPath, JSON.stringify({ channels: { discord: { passive_chats: ['1'] } } }));
    const result = checkPassiveChats(paths);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('set bot_user_id');
    expect(result.detail).toContain('set allowed_users');
  } finally { wd.cleanup(); }
});

test('no passive chats is ok; custom channels refer to plugin access settings', () => {
  const wd = setupWorkdir();
  const dir = path.join(wd.dir, '.hermit');
  const paths = resolvePaths(dir, path.resolve(import.meta.dir, '..'));
  try {
    fs.writeFileSync(paths.configPath, JSON.stringify({ channels: { discord: { passive_chats: [] } } }));
    expect(checkPassiveChats(paths).status).toBe('ok');
    fs.writeFileSync(paths.configPath, JSON.stringify({ channels: { custom: { passive_chats: ['1'] } } }));
    expect(checkPassiveChats(paths).status).toBe('warn');
    expect(checkPassiveChats(paths).detail).toContain("verify in the plugin's own access settings");
  } finally { wd.cleanup(); }
});


test('passive chats warn when their channel is unrecorded', () => {
  const wd = setupWorkdir();
  const paths = resolvePaths(path.join(wd.dir, '.hermit'), path.resolve(import.meta.dir, '..'));
  try {
    for (const [global, override, warns] of [[true, false, true], [false, undefined, true], [false, true, false]] as const) {
      fs.writeFileSync(paths.configPath, JSON.stringify({ knowledge: { channel_log_enabled: global }, channels: { discord: { passive_chats: ['1', '2'], log_chats: override } } }));
      const result = checkPassiveChats(paths);
      expect(result.detail.includes('log_chats: true')).toBe(warns);
      expect(result.detail.includes('channel_log_enabled')).toBe(warns);
      expect(result.detail.match(/log_chats: true/g)?.length ?? 0).toBe(warns ? 1 : 0);
    }
  } finally { wd.cleanup(); }
});
