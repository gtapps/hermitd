// Shared per-platform bot-identity probe — one token-authed GET that returns
// the bot's *own* account. Used by doctor-check.ts's liveness check (does the
// token still work?) and channel-bot-id.ts (what is this bot's id?), so the
// endpoints, the env overrides and the response shapes can't drift apart
// between them.
//
// Never log a probe URL or an error message from these fetches: Telegram
// embeds the bot token in the request path.

export type ChannelProbe = { url: string; headers?: Record<string, string> };

/** The bot's own account, as far as a platform will tell us. */
export type BotIdentity = { id: string | null; username: string | null };

/**
 * Platform → probe builder. The env overrides keep their original
 * `HERMIT_DOCTOR_*` names: they predate this lib and are what the doctor's
 * tests and any operator runbook already set.
 */
export const CHANNEL_PROBES: Record<string, (token: string) => ChannelProbe> = {
  telegram: (token) => ({
    url: `${process.env.HERMIT_DOCTOR_TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/getMe`,
  }),
  discord: (token) => ({
    url: `${discordApi()}/users/@me`,
    headers: { Authorization: `Bot ${token}` },
  }),
};

function discordApi(): string {
  return process.env.HERMIT_DOCTOR_DISCORD_API || 'https://discord.com/api/v10';
}

// View Channels, Send Messages, Send Messages in Threads, Read Message History,
// Attach Files and Add Reactions: the set the official Discord plugin documents.
const DISCORD_INVITE_PERMISSIONS = 274878008384;

export type PreflightFindings = {
  failure?: { reason: string; fix: string };
  warnings?: string[];
  invite?: string;
};

/**
 * Platform → setup preflight, for channel-preflight.ts. `rejected` lists the
 * statuses that mean the token is bad; `inspect` reads a successful response.
 * A platform absent here reports `not_checked`.
 */
export const CHANNEL_PREFLIGHTS: Record<string, {
  probe: (token: string) => ChannelProbe;
  rejected: number[];
  inspect: (body: any) => PreflightFindings;
}> = {
  telegram: {
    probe: CHANNEL_PROBES.telegram,
    // Telegram answers 404, not 401, to a token it cannot parse.
    rejected: [401, 403, 404],
    inspect: (body) => body.ok === true ? {} : { failure: { reason: 'token_rejected', fix: 'replace_token' } },
  },
  discord: {
    probe: (token) => ({ url: `${discordApi()}/applications/@me`, headers: { Authorization: `Bot ${token}` } }),
    rejected: [401, 403],
    inspect: (body) => {
      if (!body.id || !/^\d+$/.test(String(body.id))) return { failure: { reason: 'invalid_response', fix: 'retry_check' } };
      const invite = `https://discord.com/oauth2/authorize?client_id=${body.id}&scope=bot&permissions=${DISCORD_INVITE_PERMISSIONS}`;
      const warnings = [
        ...(body.bot_public ? ['bot_public'] : []),
        ...(body.approximate_guild_count > 0 ? [] : ['no_guilds']),
      ];
      const messageContent = (Number(body.flags) || 0) & ((1 << 18) | (1 << 19));
      const failure = messageContent ? undefined : { reason: 'message_content_intent_off', fix: 'enable_message_content_intent' };
      return { failure, warnings, invite };
    },
  },
};

/**
 * Pulls the bot's own id/username out of a probe response body.
 * Telegram wraps its payload in `result`; Discord returns the user object flat.
 * Anything unrecognized yields nulls — callers treat that as "not captured"
 * rather than guessing.
 */
export function extractBotIdentity(platform: string, body: any): BotIdentity {
  const u = platform === 'telegram' ? body?.result : body;
  const id = u?.id == null ? null : String(u.id);
  const username = typeof u?.username === 'string' && u.username ? u.username : null;
  return { id, username };
}
