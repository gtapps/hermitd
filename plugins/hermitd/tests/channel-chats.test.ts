import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupWorkdir } from './helpers/workdir';
import { lookupChat, lookupGuildRoles, createThread } from '../scripts/lib/channel-chats';

test.serial('Discord metadata caches success, errors, and retries errors after 24 hours', async () => {
  const wd = setupWorkdir();
  const dir = path.join(wd.dir, '.hermit');
  const tokenDir = path.join(wd.dir, 'discord');
  fs.mkdirSync(tokenDir);
  fs.writeFileSync(path.join(tokenDir, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  const config = { channels: { discord: { state_dir: tokenDir, bot_user_id: '7' } } };
  const previousStateDir = process.env.DISCORD_STATE_DIR;
  process.env.DISCORD_STATE_DIR = tokenDir;
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(req) {
    expect(req.headers.get('Authorization') === 'Bot test-token').toBe(true);
    const route = new URL(req.url).pathname;
    requests.push(route);
    if (route === '/channels/403') return new Response('', { status: 403 });
    return Response.json(route.includes('/guilds/') ? { roles: ['9'] } : { parent_id: null, guild_id: '2', type: 0 });
  } });
  const prev = process.env.HERMIT_DISCORD_API_URL;
  process.env.HERMIT_DISCORD_API_URL = server.url.toString().replace(/\/$/, '');
  try {
    expect(await lookupChat(dir, config, '1')).toMatchObject({ guild_id: '2', type: 0, parent_id: null });
    await lookupChat(dir, config, '1');
    expect(requests).toEqual(['/channels/1']);
    expect(await lookupChat(dir, config, '403')).toBeNull();
    expect(await lookupChat(dir, config, '403')).toBeNull();
    expect(requests.length).toBe(2);
    const file = path.join(dir, 'state', 'channel-chats.json');
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cache.discord.chats['403'].error).toBe(403);
    cache.discord.chats['403'].fetched_at = new Date(Date.now() - 86400001).toISOString();
    fs.writeFileSync(file, JSON.stringify(cache));
    await lookupChat(dir, config, '403');
    expect(requests.length).toBe(3);
    expect(await lookupGuildRoles(dir, config, '2')).toMatchObject({ role_ids: ['9'] });
    await lookupGuildRoles(dir, config, '2');
    expect(requests.length).toBe(4);
    expect(requests).toEqual(['/channels/1', '/channels/403', '/channels/403', '/guilds/2/members/7']);
    expect(await lookupGuildRoles(dir, { channels: { discord: { state_dir: tokenDir } } }, '3')).toBeNull();
    expect(requests.length).toBe(4);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).discord.guilds).not.toHaveProperty('3');
    // Roles are mutable, so a cached success expires on the same 24h clock.
    const aged = JSON.parse(fs.readFileSync(file, 'utf8'));
    aged.discord.guilds['2'].fetched_at = new Date(Date.now() - 86400001).toISOString();
    fs.writeFileSync(file, JSON.stringify(aged));
    expect(await lookupGuildRoles(dir, config, '2')).toMatchObject({ role_ids: ['9'] });
    expect(requests.length).toBe(5);
  } finally {
    if (prev === undefined) delete process.env.HERMIT_DISCORD_API_URL;
    else process.env.HERMIT_DISCORD_API_URL = prev;
    if (previousStateDir === undefined) delete process.env.DISCORD_STATE_DIR;
    else process.env.DISCORD_STATE_DIR = previousStateDir;
    server.stop(true);
    wd.cleanup();
  }
});

test.serial('thread creation posts the name and returns null on HTTP or network failure', async () => {
  const wd = setupWorkdir();
  const dir = path.join(wd.dir, '.hermit');
  const tokenDir = path.join(wd.dir, 'discord');
  fs.mkdirSync(tokenDir);
  fs.writeFileSync(path.join(tokenDir, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  const previousStateDir = process.env.DISCORD_STATE_DIR;
  const previousApi = process.env.HERMIT_DISCORD_API_URL;
  process.env.DISCORD_STATE_DIR = tokenDir;
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    expect(req.method).toBe('POST');
    expect(req.headers.get('Authorization')).toBe('Bot test-token');
    bodies.push(await req.json());
    const route = new URL(req.url).pathname;
    requests.push(route);
    if (route.includes('/taken/')) return Response.json({ code: 160004, message: 'A thread has already been created for this message' }, { status: 400 });
    return route.includes('/403/') ? new Response('', { status: 403 }) : Response.json({ id: 'new-thread' });
  } });
  process.env.HERMIT_DISCORD_API_URL = server.url.toString().replace(/\/$/, '');
  try {
    const config = { channels: { discord: { state_dir: tokenDir } } };
    expect(await createThread(dir, config, '123', '456', 'Task thread')).toBe('new-thread');
    expect(await createThread(dir, config, '403', '456', 'Task thread')).toBeNull();
    expect(requests).toEqual(['/channels/123/messages/456/threads', '/channels/403/messages/456/threads']);
    // A message that already holds a thread falls back to a standalone public one,
    // an announcement thread under an announcement parent.
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'channel-chats.json'), JSON.stringify({ discord: { chats: {
      '123': { parent_id: null, guild_id: '2', type: 0, fetched_at: new Date().toISOString() },
      '555': { parent_id: null, guild_id: '2', type: 5, fetched_at: new Date().toISOString() },
    } } }));
    expect(await createThread(dir, config, '123', 'taken', 'Task thread')).toBe('new-thread');
    expect(await createThread(dir, config, '555', 'taken', 'Task thread')).toBe('new-thread');
    expect(requests.slice(2)).toEqual(['/channels/123/messages/taken/threads', '/channels/123/threads', '/channels/555/messages/taken/threads', '/channels/555/threads']);
    expect(bodies.slice(2)).toEqual([{ name: 'Task thread' }, { name: 'Task thread', type: 11 }, { name: 'Task thread' }, { name: 'Task thread', type: 10 }]);
    server.stop(true);
    expect(await createThread(dir, config, '123', '456', 'Task thread')).toBeNull();
  } finally {
    if (previousStateDir === undefined) delete process.env.DISCORD_STATE_DIR;
    else process.env.DISCORD_STATE_DIR = previousStateDir;
    if (previousApi === undefined) delete process.env.HERMIT_DISCORD_API_URL;
    else process.env.HERMIT_DISCORD_API_URL = previousApi;
    server.stop(true);
    wd.cleanup();
  }
});
