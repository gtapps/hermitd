// Shared channel `allowed_users` allowlist gating — used by every
// UserPromptSubmit hook that reacts to an inbound <channel> envelope
// (the channel-reply-reminder, pause-keyword and channel-status-responder
// stages in lib/prompt-stages/).
// A single copy so the allowlist rule can't drift out of sync between callers.

import { iterChannelConfigs } from './channel-config';
import { normalizeChannelSource, envelopeAttr, type ChannelEnvelope } from './channel-envelope';
import { cachedChat, cachedGuildRoles, lookupChat, lookupGuildRoles } from './channel-chats';
import { escapeRegExp } from './md-write';

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
 * Stricter gate for state-mutating (pause/resume/snooze) and disclosure (status)
 * paths. An explicit allowed_users list still wins — but when none is configured
 * this does NOT fall back to accept-all (as isAllowedSender does). Instead it
 * trusts only the operator's pinned home chat (chat_id === default_chat_id). On
 * a no-allowlist channel a stranger in a group can't freeze the hermit or read its status,
 * while the operator's own chat keeps working with zero config.
 *
 * The anchor is the *pinned* home rather than the last-learned DM so control
 * authority can't be acquired by messaging from a new chat: default_chat_id is
 * seeded once by channel-hook and moved only from the terminal. Same home field
 * as resolve-outbound-channel's proactiveChatId (duplicated rather than imported — an auth gate shouldn't depend on the delivery module).
 *
 * Caveat: if the operator's home IS a group/server channel, its chat_id equals
 * the group's and every member matches — those installs must set allowed_users.
 * Pinning closes the acquisition path, not this standing exposure.
 * (Documented in docs/security.md + the CHANGELOG.)
 */
export function isTrustedController(
  config: Json, source: string, userId: string | null, chatId: string | null,
): boolean {
  const ch = channelEntry(config, source);
  if (Array.isArray(ch?.allowed_users)) {
    return isAllowedSender(config, source, userId); // explicit list (incl. [] lockdown) wins
  }
  const home = ch?.default_chat_id; // no list -> pinned-home binding
  return !!home && !!chatId && String(home) === String(chatId);
}

/** Primary-operator precedence mirrors channel-responder §1c; empty lists name nobody. */
export function isPrimaryOperator(config: Json, source: string, userId: string | null, chatId: string | null): boolean {
  const ch = channelEntry(config, source);
  if (ch?.operators !== undefined) return Array.isArray(ch.operators) && userId !== null && ch.operators.includes(userId);
  const allowed = allowedUserIds(config, source);
  if (allowed !== null) return userId !== null && allowed[0] === userId;
  return !!chatId && (chatId === ch?.maintainer_channel_id
    || (chatId === ch?.default_chat_id && config?.operator_profile !== 'non-technical'));
}

// Home/maintainer rule has its prose twin in channel-responder §1c.
export function recallScope(config: Json, key: string, chatId: string, hermitDir: string): Json | null {
  const ch = channelEntry(config, key);
  const own = { source: key, chat_id: chatId };
  if (!ch) return { own, shared: [] };
  const home = ch.default_chat_id;
  if (chatId && (chatId === ch.maintainer_channel_id
    || (chatId === home && config.operator_profile !== 'non-technical'))) return null;
  const shared: { source: string; chat_id: string }[] = [];
  const chat = normalizeChannelSource(key) === 'discord' ? cachedChat(hermitDir, chatId) : null;
  if (chat && [10, 11, 12].includes(chat.type) && chat.parent_id) {
    if (chat.parent_id === ch.maintainer_channel_id
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

function passiveChats(config: Json, sourceKey: string): string[] {
  const chats = channelEntry(config, sourceKey)?.passive_chats;
  return Array.isArray(chats) ? chats : [];
}

/** Exact chat policy wins; only Discord threads inherit their parent's policy. */
export async function chatInstructions(hermitDir: string, config: Json, sourceKey: string, chatId: string): Promise<string | null> {
  const entries = channelEntry(config, sourceKey)?.instructions;
  if (!Array.isArray(entries) || !entries.length) return null;
  const exact = entries.find(entry => entry?.chat_id === chatId);
  if (typeof exact?.text === 'string') return exact.text;
  if (normalizeChannelSource(sourceKey) !== 'discord') return null;
  const chat = await lookupChat(hermitDir, config, chatId);
  if (!chat || ![10, 11, 12].includes(chat.type) || !chat.parent_id) return null;
  const parent = entries.find(entry => entry?.chat_id === chat.parent_id);
  return typeof parent?.text === 'string' ? parent.text : null;
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
