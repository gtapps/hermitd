// Shared channel `allowed_users` allowlist gating — used by every
// UserPromptSubmit hook that reacts to an inbound <channel> envelope
// (the channel-reply-reminder, pause-keyword and channel-status-responder
// stages in lib/prompt-stages/).
// A single copy so the allowlist rule can't drift out of sync between callers.

import { iterChannelConfigs } from './channel-config';
import { normalizeChannelSource, envelopeAttr, type ChannelEnvelope } from './channel-envelope';
import { cachedChat, cachedGuildRoles, lookupChat, lookupGuildRoles, threadParent, type ThreadParent } from './channel-chats';
import { escapeRegExp } from './md-write';
import { baseChat, parseKey } from './conversation-key';

type Json = any;

/**
 * Resolves an envelope's (possibly plugin-qualified) source to its configured
 * channel entry via the normalized (bare server name) key — the same key the
 * send path derives from `envelope.sourceKey`, so the auth gate and the reply
 * target can never disagree about which channel config applies. Config keyed by
 * bare server name is the convention (see normalizeChannelSource); this is the
 * one place both gate functions below resolve it, so they can't drift apart.
 */
export function channelEntry(config: Json, source: string): Json {
  const channels = config?.channels;
  if (!channels || typeof channels !== 'object') return undefined;
  const key = normalizeChannelSource(source);
  return Object.prototype.hasOwnProperty.call(channels, key) ? channels[key] : undefined;
}

/** Audience shared by channel-log rows and transcript exports. */
export function rowAudience(config: Json, sourceKey: string, chatId: string | number): string {
  const shared = channelEntry(config, sourceKey)?.shared_chats;
  return Array.isArray(shared) && shared.map(String).includes(String(chatId))
    ? 'shared'
    : `${sourceKey}:${String(chatId)}`;
}

/** The hermit's own account on a channel. Either field is null when the entry,
 *  the field, or the config itself is missing or malformed. */
export interface ChannelBotIdentity {
  /** `@handle` — Telegram mentions and the `/cmd@handle` suffix carry this. */
  username: string | null;
  /** Numeric platform id — Discord mentions carry this, never the handle. */
  userId: string | null;
}

/**
 * Both halves of the bot's own identity from one entry lookup. Self-mention and
 * `@botname` addressing (channel-slash-address.ts) read them from three prompt
 * stages and the reply reminder reads both together; one accessor keeps "no
 * configured identity" from meaning something different in each.
 */
export function channelBotIdentity(config: Json, source: string): ChannelBotIdentity {
  const entry = channelEntry(config, source);
  return {
    username: typeof entry?.bot_username === 'string' ? entry.bot_username : null,
    userId: entry?.bot_user_id == null ? null : String(entry.bot_user_id),
  };
}

/**
 * Mirrors channel-responder/SKILL.md 1c: absent allowed_users → accept all
 * (backwards compatible); [] → lockdown; otherwise the sender's user id must
 * be present in the list. Callers that can't respond to the operator on
 * failure (hooks) can only choose not to act — never throw or block.
 *
 * `userId` arrives canonicalized by parseChannelEnvelope (the envelope's
 * `user_id` when present, else `user`) — this gate never sees the display name
 * separately, so an allowlist can only ever be matched against the platform id.
 */
export function allowedUserIds(config: Json, source: string): string[] | null {
  const allowedUsers = channelEntry(config, source)?.allowed_users;
  return Array.isArray(allowedUsers) ? allowedUsers : null;
}

export function isAllowedSender(config: Json, source: string, userId: string | null): boolean {
  const allowedUsers = allowedUserIds(config, source);
  if (allowedUsers === null) return true; // absent/malformed -> accept all
  if (userId === null) return false; // can't verify identity against a configured allowlist
  return allowedUsers.includes(userId);
}

/**
 * A sender's authority on a channel, lowest first:
 * - `none`: not admitted (isAllowedSender).
 * - `member`: admitted. Every sender on a `members_only: true` channel stops here.
 * - `controller`: chat control commands, full status and tool sign-in.
 * - `operator`: standing roles, approval rules, decisions and proposal consent.
 *
 * Operator precedence mirrors channel-responder §1c: `operators` when present
 * (an empty list names nobody), else the first `allowed_users` entry, else the
 * maintainer chat or, outside a non-technical profile, the pinned home chat.
 * Controllers are the operators plus, on a channel with neither list, the pinned
 * home chat, so a non-technical client's home keeps control with zero config.
 *
 * The anchor is the *pinned* home (default_chat_id, seeded once and moved only
 * from the terminal), so control can't be acquired by messaging from a new chat.
 * Caveat: if the home IS a group, every member of it matches; those installs
 * should set `operators`. (Documented in docs/access-model.md.)
 */
export type SenderRole = 'none' | 'member' | 'controller' | 'operator';
const RANK: Record<SenderRole, number> = { none: 0, member: 1, controller: 2, operator: 3 };
export const atLeast = (role: SenderRole, min: SenderRole): boolean => RANK[role] >= RANK[min];

/** Context for an admitted member's control command (`/pause` -> `!pause`); a non-admitted sender stays a silent no-op. */
export const controlRefusal = (command: string): string =>
  `[control] !${command.replace(/^\//, '')} refused: only an operator controls the agent. Tell the sender in one line.\n`;

export function senderRole(config: Json, source: string, userId: string | null, chatId: string | null): SenderRole {
  const ch = channelEntry(config, source);
  const allowed = Array.isArray(ch?.allowed_users) ? ch.allowed_users : null;
  if (allowed !== null && (userId === null || !allowed.includes(userId))) return 'none';
  if (ch?.members_only === true) return 'member';
  if (ch?.operators !== undefined) {
    return Array.isArray(ch.operators) && userId !== null && ch.operators.includes(userId) ? 'operator' : 'member';
  }
  if (allowed !== null) return allowed[0] === userId ? 'operator' : 'member';
  if (!chatId) return 'member';
  if (chatId === ch?.maintainer_channel_id
    || (chatId === ch?.default_chat_id && config?.operator_profile !== 'non-technical')) return 'operator';
  return !!ch?.default_chat_id && String(ch.default_chat_id) === String(chatId) ? 'controller' : 'member';
}

// Home/maintainer rule has its prose twin in channel-responder §1c. A
// `members_only` channel has neither: every sender there is a plain member.
export function recallScope(config: Json, key: string, chatId: string, hermitDir: string): Json | null {
  const ch = channelEntry(config, key);
  const own = { source: key, chat_id: chatId };
  if (!ch) return { own, shared: [] };
  const elevated = ch.members_only !== true;
  const home = elevated ? ch.default_chat_id : undefined;
  const maintainer = elevated ? ch.maintainer_channel_id : undefined;
  if (chatId && (chatId === maintainer
    || (chatId === home && config.operator_profile !== 'non-technical'))) return null;
  const shared: { source: string; chat_id: string }[] = [];
  const chat = normalizeChannelSource(key) === 'discord' ? cachedChat(hermitDir, chatId) : null;
  if (chat && [10, 11, 12].includes(chat.type) && chat.parent_id) {
    if (chat.parent_id === maintainer
      || (chat.parent_id === home && config.operator_profile !== 'non-technical')) return null;
    shared.push({ source: key, chat_id: chat.parent_id });
  }
  for (const [source, entry] of iterChannelConfigs(config)) {
    if (!Array.isArray(entry.shared_chats)) continue; // a malformed value grants nothing
    for (const chat_id of entry.shared_chats) shared.push({ source, chat_id });
  }
  return { own, channel: ch.isolate_chats === false ? key : undefined, shared };
}

/**
 * Whether a compiled page's `audience` is visible to a recallScope result.
 * Absent / `shared` / an unscoped reader (null) are always visible. A tagged
 * page is visible only when the pair matches `scope.own`, the key equals
 * `scope.channel` (isolate_chats: false), or the pair is in `scope.shared`.
 */
export function audienceVisible(scope: Json | null | undefined, audience: unknown): boolean {
  if (audience == null || audience === 'shared') return true;
  if (scope == null) return true;
  if (typeof audience !== 'string') return false;
  const separator = audience.indexOf(':');
  if (separator < 0) return false;
  const key = audience.slice(0, separator);
  const chatId = audience.slice(separator + 1);
  if (!key || !chatId) return false;
  if (scope.own?.source === key && String(scope.own.chat_id) === chatId) return true;
  if (scope.channel && key === scope.channel) return true;
  if (Array.isArray(scope.shared)) {
    for (const entry of scope.shared) {
      if (entry.source === key && String(entry.chat_id) === chatId) return true;
    }
  }
  return false;
}

/** Brief-only public children supplement the answering chat's recall scope. */
export async function briefVisibility<T extends { id: string; audience: string }>(
  hermitDir: string, config: Json, selected: string | null, records: T[],
): Promise<{ scope: Json | null; visible: T[]; unresolved: string[] }> {
  if (selected === null) return { scope: null, visible: records, unresolved: [] };
  const { source, chat: chatId } = parseKey(selected);
  if (source === 'discord') await lookupChat(hermitDir, config, chatId, true);
  const scope = recallScope(config, source, chatId, hermitDir);
  const shown = new Set<T>();
  const indirect: { record: T; key: string }[] = [];
  for (const record of records) {
    if (audienceVisible(scope, record.audience) || record.audience.startsWith(`${source}:${chatId}~`)) shown.add(record);
    else if (record.audience !== 'operator') indirect.push({ record, key: baseChat(record.audience) });
  }
  const parents = new Map<string, ThreadParent>();
  await Promise.all([...new Set(indirect.map(row => row.key))].map(async key => {
    const { source: recordSource, chat: recordChat } = parseKey(key);
    parents.set(key, await threadParent(hermitDir, config, recordSource, recordChat));
  }));
  const unresolved: string[] = [];
  for (const { record, key } of indirect) {
    const parent = parents.get(key);
    if (parent?.status === 'unresolved') unresolved.push(record.id);
    else if (key.startsWith(`${source}:`) && parent?.status === 'public' && parent.parent === chatId) shown.add(record);
  }
  return { scope, visible: records.filter(record => shown.has(record)), unresolved };
}

function passiveChats(config: Json, sourceKey: string): string[] {
  const chats = channelEntry(config, sourceKey)?.passive_chats;
  return Array.isArray(chats) ? chats : [];
}

/** Exact chat policy wins; only Discord threads inherit their parent's policy. */
export async function chatInstructions(hermitDir: string, config: Json, sourceKey: string, chatId: string): Promise<{ text: string; chat_id: string } | null> {
  const entries = channelEntry(config, sourceKey)?.instructions;
  if (!Array.isArray(entries) || !entries.length) return null;
  const exact = entries.find(entry => entry?.chat_id === chatId);
  if (typeof exact?.text === 'string') return { text: exact.text, chat_id: exact.chat_id };
  if (normalizeChannelSource(sourceKey) !== 'discord') return null;
  const chat = await lookupChat(hermitDir, config, chatId);
  if (!chat || ![10, 11, 12].includes(chat.type) || !chat.parent_id) return null;
  const parent = entries.find(entry => entry?.chat_id === chat.parent_id);
  return typeof parent?.text === 'string' ? { text: parent.text, chat_id: parent.chat_id } : null;
}

/** Cache-only activity classification; an unseen thread is warmed by the reply stage. */
export function isPassiveChatSync(hermitDir: string, config: Json, sourceKey: string, chatId: string): boolean {
  const chats = passiveChats(config, sourceKey);
  if (chats.includes(chatId)) return true;
  if (!chats.length || normalizeChannelSource(sourceKey) !== 'discord') return false;
  const parent = cachedChat(hermitDir, chatId)?.parent_id;
  return !!parent && chats.includes(parent);
}

export async function isPassiveChat(hermitDir: string, config: Json, sourceKey: string, chatId: string): Promise<boolean> {
  const chats = passiveChats(config, sourceKey);
  if (chats.includes(chatId)) return true;
  if (!chats.length || normalizeChannelSource(sourceKey) !== 'discord') return false;
  const parent = (await lookupChat(hermitDir, config, chatId))?.parent_id;
  return !!parent && chats.includes(parent);
}

function directMention(config: Json, sourceKey: string, body: string): boolean {
  const { userId, username } = channelBotIdentity(config, sourceKey);
  if (normalizeChannelSource(sourceKey) === 'discord') {
    return [...body.matchAll(/<@!?(\d+)>/g)].some(match => match[1] === userId);
  }
  const handle = username?.replace(/^@/, '');
  return !!((handle && new RegExp(`(?<![\\w@])@${escapeRegExp(handle)}(?!\\w)`, 'i').test(body))
    || (userId && new RegExp(`(?<!\\d)${escapeRegExp(userId)}(?!\\d)`).test(body)));
}

function pluginMention(config: Json, sourceKey: string, envelope?: ChannelEnvelope | null): boolean {
  const marker = channelEntry(config, sourceKey)?.attributes?.mentioned;
  if (!marker || !envelope) return false;
  const at = marker.indexOf('=');
  const attribute = at === -1 ? marker : marker.slice(0, at);
  const expected = at === -1 ? 'true' : marker.slice(at + 1);
  return envelopeAttr(envelope, attribute) === expected;
}

export function isSelfMentionedSync(hermitDir: string, config: Json, sourceKey: string, chatId: string, body: string, envelope?: ChannelEnvelope | null): boolean {
  if (pluginMention(config, sourceKey, envelope) || directMention(config, sourceKey, body)) return true;
  if (normalizeChannelSource(sourceKey) !== 'discord') return false;
  const mentions = [...body.matchAll(/<@&(\d+)>/g)];
  if (!mentions.length) return false;
  const guild = cachedChat(hermitDir, chatId)?.guild_id;
  const roles = guild ? cachedGuildRoles(hermitDir, guild)?.role_ids : undefined;
  return mentions.some(match => roles?.includes(match[1]) === true);
}

export async function isSelfMentioned(hermitDir: string, config: Json, sourceKey: string, chatId: string, body: string, envelope?: ChannelEnvelope | null): Promise<boolean> {
  if (pluginMention(config, sourceKey, envelope) || directMention(config, sourceKey, body)) return true;
  if (normalizeChannelSource(sourceKey) !== 'discord') return false;
  const mentions = [...body.matchAll(/<@&(\d+)>/g)];
  if (!mentions.length) return false;
  const guild = (await lookupChat(hermitDir, config, chatId))?.guild_id;
  const roles = guild ? (await lookupGuildRoles(hermitDir, config, guild))?.role_ids : undefined;
  return mentions.some(match => roles?.includes(match[1]) === true);
}
