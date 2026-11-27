// Shared slash-command *addressing* for inbound channel messages — used by the
// pause-keyword, harness-command and channel-status-responder stages in
// lib/prompt-stages/.
//
// Deliberately NOT a tokenizer. It answers two questions only — "is this a slash
// command?" and "is it addressed to us?" — and hands the remainder back
// untouched. Each command family keeps its own argument grammar downstream:
// harness-command.ts splits on a single space and enforces exact token counts,
// while pause-keyword accepts `\s+` before a snooze duration. Centralizing the
// split too would force both through one rule and silently narrow `/snooze  2h`.
//
// Two address forms, both transport-neutral — a channel gets whichever its
// stored identity supports, not whichever platform it happens to be:
//
//   suffix   `/pause@thebot`   Telegram's group convention, where a client
//                              rewrites a command picked from the bot menu.
//   prefix   `<@id> /pause`    a leading self-mention. Mention-gated channels
//            `@thebot /pause`  are the default for a server channel, and the
//                              plugin hands the mention through verbatim, so
//                              without this every command there is inert.
//
// Both fail closed the same way: the address must name THIS bot. A command
// aimed at another bot in a shared group is not ours to act on, an unknown
// identity can never authorize its own form, and either way the body reaches
// the model as ordinary prose instead of being acted on.
//
// Addressing only — never authorization. Who may actually pause, resume or
// interrogate the hermit is decided downstream by channel-auth.ts's
// senderRole/isAllowedSender, which this layer does not consult and
// cannot widen.

import type { ChannelBotIdentity } from './channel-auth';

/** Strip one optional leading `@`. `channel-bot-id.ts` writes `bot_username`
 *  bare (channel-reply-reminder.ts prepends the `@` itself when matching
 *  mentions), but the same file documents that an operator may set the key by
 *  hand for a channel with no identity probe — so tolerate `@handle` there
 *  rather than silently never matching. */
function bareHandle(handle: string): string {
  return (handle.startsWith('@') ? handle.slice(1) : handle).toLowerCase();
}

/** Discord renders a user mention as `<@id>`, and older clients as `<@!id>`.
 *  The delimiters already bound the token, so the inner text is compared
 *  whole — tighter than channel-reply-reminder.ts's digit-lookaround, which has
 *  to find the id loose in a sentence. A role mention (`<@&id>`) never matches
 *  here even when it carries our digits, because `&id` is not all digits. */
const DISCORD_MENTION = /^<@!?(\d+)>/;

/** A leading `@handle` — how Telegram carries a mention, as plain text rather
 *  than an id. Full-token compare, so `@ourbotx` never matches `@ourbot`. */
const HANDLE_MENTION = /^@(\S+)/;

/**
 * Removes ONE leading self-mention, or returns the body untouched.
 *
 * Exactly one, deliberately: `<@us> <@them> /pause` is left for the model
 * rather than guessed at, since which bot a two-mention message addresses is
 * not ours to decide. Anything that is not our own mention — another account's,
 * a mention we have no stored identity to recognize, one that isn't leading —
 * is left in place, where it fails the caller's slash test on its own.
 */
function stripSelfMention(trimmed: string, identity: ChannelBotIdentity): string {
  const mention = DISCORD_MENTION.exec(trimmed);
  if (mention) {
    if (!identity.userId || mention[1] !== identity.userId) return trimmed;
    return trimmed.slice(mention[0].length).trimStart();
  }

  const handle = HANDLE_MENTION.exec(trimmed);
  if (handle) {
    if (!identity.username || bareHandle(handle[1]) !== bareHandle(identity.username)) return trimmed;
    return trimmed.slice(handle[0].length).trimStart();
  }

  return trimmed;
}

export interface AddressedSlashCommand {
  /** First token, lowercased, with any `@botname` suffix removed. Keeps its leading `/`. */
  command: string;
  /** Everything after the first token, byte-for-byte — leading whitespace included. */
  rest: string;
}

/**
 * Resolves an inbound body's slash command and address.
 *
 * Returns null when the body is not a slash command once any self-mention is
 * removed, or when it carries an `@suffix` that does not name this bot —
 * including every suffixed command when the handle is unknown. Null means "not
 * ours": callers return silently, the same no-op an unauthorized sender gets,
 * so the mechanism can't be probed.
 */
export function resolveSlashCommand(
  body: string, identity: ChannelBotIdentity,
): AddressedSlashCommand | null {
  // The mention comes off first, so the slash test below sees the command the
  // operator typed rather than the wrapper their client put in front of it.
  const trimmed = stripSelfMention(body.trim(), identity);
  if (!trimmed.startsWith('!')) return null;

  // First token is everything up to the first whitespace; `rest` keeps the
  // whitespace that follows, so a family whose grammar cares about it still sees it.
  const ws = trimmed.search(/\s/);
  let command = ws === -1 ? trimmed : trimmed.slice(0, ws);
  const rest = ws === -1 ? '' : trimmed.slice(ws);

  const at = command.indexOf('@');
  if (at !== -1) {
    const suffix = bareHandle(command.slice(at + 1));
    const own = identity.username == null ? '' : bareHandle(identity.username);
    // Compared in full, never truncated: two long handles sharing a prefix must
    // not compare equal. Empty suffix (`/pause@`) can never match a real handle,
    // and an unknown handle can never authorize one — both fall out here.
    if (!own || suffix !== own) return null;
    command = command.slice(0, at);
  }

  return { command: '/' + command.slice(1).toLowerCase(), rest };
}
