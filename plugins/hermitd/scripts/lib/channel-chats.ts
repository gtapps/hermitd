// Folder-shared Discord chat metadata for passive capture. Best-effort atomic
// writes are last-writer-wins, like channel-health; a lost entry is fetched again.
import fs from 'node:fs';
import path from 'node:path';
import { readChannelToken } from './channel-token';
import { writeFileAtomic } from './md-write';

type Json = any;
export interface Chat {
  parent_id: string | null;
  guild_id: string | null;
  type: number;
  fetched_at: string;
}
export interface GuildRoles {
  role_ids: string[];
  fetched_at: string;
}
type CachedError = { error: number | 'network'; fetched_at: string };
type Entry = Chat | GuildRoles | CachedError;
type Bucket = 'chats' | 'guilds';

function readCache(hermitDir: string): Json {
  try {
    return JSON.parse(fs.readFileSync(path.join(hermitDir, 'state', 'channel-chats.json'), 'utf8'));
  } catch { return {}; }
}

const TTL_MS = 24 * 60 * 60 * 1000;

// Errors expire so a failed lookup costs one request a day, and so do guild
// roles: a role granted to (or taken from) the bot after the first lookup would
// otherwise never be seen. Chat metadata (parent/guild/type) is immutable.
function cachedEntry(hermitDir: string, bucket: Bucket, id: string): Entry | null {
  const entry = readCache(hermitDir)?.discord?.[bucket]?.[id];
  if (!entry || typeof entry !== 'object') return null;
  const perishable = 'error' in entry || bucket === 'guilds';
  if (perishable && Date.now() - Date.parse(entry.fetched_at) >= TTL_MS) return null;
  return entry;
}

export function cachedChat(hermitDir: string, chatId: string): Chat | null {
  const entry = cachedEntry(hermitDir, 'chats', chatId);
  return entry && 'type' in entry ? entry as Chat : null;
}

export function cachedGuildRoles(hermitDir: string, guildId: string): GuildRoles | null {
  const entry = cachedEntry(hermitDir, 'guilds', guildId);
  return entry && 'role_ids' in entry ? entry as GuildRoles : null;
}

async function lookup(hermitDir: string, config: Json, bucket: Bucket, id: string): Promise<Entry | null> {
  try {
    const cached = cachedEntry(hermitDir, bucket, id);
    if (cached) return 'error' in cached ? null : cached;
    let entry: Entry;
    const fetched_at = new Date().toISOString();
    try {
      const token = readChannelToken(hermitDir, 'discord', config?.channels?.discord);
      if (!token) throw new Error('missing token');
      const base = process.env.HERMIT_DISCORD_API_URL || 'https://discord.com/api/v10';
      const route = bucket === 'chats' ? `/channels/${id}` : `/guilds/${id}/members/${String(config?.channels?.discord?.bot_user_id)}`;
      const response = await fetch(`${base}${route}`, {
        headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) entry = { error: response.status, fetched_at };
      else {
        const body = await response.json() as Json;
        entry = bucket === 'chats'
          ? { parent_id: body.parent_id ?? null, guild_id: body.guild_id ?? null, type: body.type, fetched_at }
          : { role_ids: body.roles, fetched_at };
      }
    } catch { entry = { error: 'network', fetched_at }; }
    try {
      const all = readCache(hermitDir);
      all.discord ??= {};
      all.discord.chats ??= {};
      all.discord.guilds ??= {};
      all.discord[bucket][id] = entry;
      const file = path.join(hermitDir, 'state', 'channel-chats.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(all, null, 2) + '\n');
    } catch { /* advisory cache; failure does not discard the HTTP result */ }
    return 'error' in entry ? null : entry;
  } catch { return null; }
}

export async function lookupChat(hermitDir: string, config: Json, chatId: string): Promise<Chat | null> {
  return await lookup(hermitDir, config, 'chats', chatId) as Chat | null;
}

export async function lookupGuildRoles(hermitDir: string, config: Json, guildId: string): Promise<GuildRoles | null> {
  if (!config?.channels?.discord?.bot_user_id) return null;
  return await lookup(hermitDir, config, 'guilds', guildId) as GuildRoles | null;
}

export function isThreadType(chat: Pick<Chat, 'type'> | null): boolean {
  return chat?.type === 10 || chat?.type === 11 || chat?.type === 12;
}

// A guild text or announcement channel, where a task opens a native thread.
export function isGuildChannelType(chat: Pick<Chat, 'type'> | null | undefined): boolean {
  return chat?.type === 0 || chat?.type === 5;
}

// Unlike the cached lookups above this is a non-idempotent write, so it takes the
// same 10s budget channel-send.ts gives its POSTs rather than the 2s a cache miss
// can afford: a timeout here can leave a thread created in the operator's server
// that the caller has been told does not exist. The name is clamped to Discord's
// 1-100 character limit — an over-long title would otherwise 400 and read as
// "thread creation unsupported".
// A message holds at most one thread (the thread takes the message's id), so when
// a message carrying several assignments already has one (Discord code 160004) the
// thread opens standalone. That route requires a thread type, so it takes a public
// one: an announcement thread (10) in an announcement channel (5), otherwise 11.
export async function createThread(hermitDir: string, config: Json, chatId: string, messageId: string, name: string): Promise<string | null> {
  try {
    const token = readChannelToken(hermitDir, 'discord', config?.channels?.discord);
    if (!token) return null;
    const title = name.trim().slice(0, 100);
    if (!title) return null;
    const base = process.env.HERMIT_DISCORD_API_URL || 'https://discord.com/api/v10';
    const post = async (route: string, payload: Json) => {
      const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: response.ok, body: await response.json().catch(() => null) as Json };
    };
    let result = await post(`/channels/${chatId}/messages/${messageId}/threads`, { name: title });
    if (!result.ok && result.body?.code === 160004) {
      const type = (await lookupChat(hermitDir, config, chatId))?.type === 5 ? 10 : 11;
      result = await post(`/channels/${chatId}/threads`, { name: title, type });
    }
    return result.ok && typeof result.body?.id === 'string' ? result.body.id : null;
  } catch { return null; }
}
