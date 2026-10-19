// UserPromptSubmit stage — deterministic pause/resume/snooze keyword writer
// (PROP-015). Writes state/pause.json directly from an inbound <channel>
// envelope, before any model involvement, so pause/resume never depends on
// model cooperation or on a tool call the pause-gate itself might deny.
//
// Mid-turn channel arrivals are queued and run UserPromptSubmit individually
// (CC 2.1.263), so these keywords are handled when each queued prompt is delivered.
//
// Gated by the same allowed_users allowlist as channel-reply-reminder.ts
// (lib/channel-auth.ts's isAllowedSender, shared by both; also see
// channel-responder/SKILL.md 1c) — an unauthorized sender's message is a
// silent no-op: no state change, no stdout, so the mechanism can't be probed
// by an unauthorized prompt.

import { safeForLLM } from '../sanitize';
import { senderLabel } from '../channel-envelope';
import { setPause, clearPause, parseSnoozeDuration } from '../pause';
import { isTrustedController, channelBotIdentity } from '../channel-auth';
import { resolveSlashCommand } from '../channel-slash-address';
import type { StageContext, StageResult } from './types';

const MAX_BY_LEN = 64;
const MAX_DURATION_LEN = 32;

export function run(ctx: StageContext): StageResult | void {
  // Shared envelope parser (also used by channel-reply-reminder/status-responder),
  // so the grammar can't drift. Requires a chat_id — which the DM-binding gate
  // below needs anyway, and every real inbound envelope carries.
  const env = ctx.envelope;
  if (!env) return;
  const sourceRaw = env.source;
  const userId = env.userId;
  const body = env.body;
  if (!body) return;

  const dir = ctx.dir;
  // Read before the match, not after: the bot's own identity is needed to resolve
  // both address forms. config() is memoized per prompt (user-prompt-pipeline.ts),
  // and channel-reply-reminder has already loaded it, so this costs nothing. A null
  // config resolves to an empty identity AND fails isTrustedController below, so an
  // unreadable config still means no control command works at all — unchanged.
  const config = ctx.config();
  const identity = channelBotIdentity(config, sourceRaw);

  // Slash-only, exact-match: the same rule the harness commands (`/compact`,
  // `/clear`) already follow. A bare `pause`/`stop` is deliberately inert — a word
  // an operator might type in ordinary conversation must not freeze the hermit —
  // and so is prose that merely mentions one ("please pause and think about this").
  const addressed = resolveSlashCommand(body, identity);
  if (!addressed) return;

  // Argument grammar stays here, with its owner: `\s+` before a snooze duration
  // is this family's rule, not a shared one (resolveSlashCommand hands `rest`
  // back byte-for-byte precisely so it survives).
  const snoozeMatch = /^\s+(\S+)$/.exec(addressed.rest);

  let action: 'pause' | 'resume' | 'snooze' | null = null;
  let durationRaw: string | null = null;
  const bare = addressed.rest.length === 0;
  if (bare && (addressed.command === '/pause' || addressed.command === '/stop')) action = 'pause';
  else if (bare && addressed.command === '/resume') action = 'resume';
  else if (addressed.command === '/snooze' && snoozeMatch) { action = 'snooze'; durationRaw = snoozeMatch[1]; }
  if (!action) return;

  // Stricter gate than a plain reply: pausing is state-mutating, so an unconfigured
  // channel trusts only the operator's pinned home chat (chat_id === default_chat_id).
  if (!isTrustedController(config, sourceRaw, userId, env.chatId)) return; // unauthorized — silent no-op

  const by = safeForLLM(senderLabel(env).slice(0, MAX_BY_LEN));

  if (action === 'pause') {
    setPause(dir, { reason: 'operator', by });
    ctx.suppressResponderInvoke = true;
    return {
      context: `[pause] Hermit paused by ${by} (indefinite). Only the channel reply tool works until resumed.\n`,
    };
  } else if (action === 'resume') {
    clearPause(dir);
    return { context: `[pause] Hermit resumed by ${by}. Normal operation restored.\n` };
  } else {
    const durationSafe = safeForLLM((durationRaw ?? '').slice(0, MAX_DURATION_LEN));
    const ms = durationRaw ? parseSnoozeDuration(durationRaw) : null;
    if (ms === null) {
      return {
        context: `[pause] Could not parse snooze duration "${durationSafe}" — expected e.g. "30m", "2h", "1d". No change made.\n`,
      };
    }
    const until = new Date(Date.now() + ms).toISOString();
    setPause(dir, { reason: 'operator', by, until });
    ctx.suppressResponderInvoke = true;
    return { context: `[pause] Hermit paused by ${by} until ${until}. Only the channel reply tool works until resumed.\n` };
  }
}
