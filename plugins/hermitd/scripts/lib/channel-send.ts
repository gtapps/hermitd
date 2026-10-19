// channel-send.ts — the first script-owned (non-model) channel send.
//
// Resolves the eligible outbound channel (resolve-outbound-channel.ts's
// {id, chat_id}), reads the bot token from that channel's state_dir/.env
// (nothing else in core reads these tokens today — the MCP channel plugins
// consume them directly from the process env), and POSTs directly to the
// platform API. Plain text only (no parse_mode/markdown — unescaped markdown
// 400s on Telegram). On a confirmed 2xx, appends an outbound row to the
// episodic channel log via lib/channel-log.ts so this new send path doesn't
// open a hole in episodic memory the way model-only outbound logging would.
//
// Never throws — every path returns a SendResult so callers (a fail-open
// hook, a single-shot watchdog tick, a fire-and-forget budget alert) can
// decide what "failed to notify the operator" means for them.

import path from 'node:path';
import { resolve as resolveOutboundChannel, resolveMaintainerTarget } from '../resolve-outbound-channel';
import { logMessage, isLoggingEnabled } from './channel-log';
import { settleConfig, readConfigRaw, readSettledConfig } from './config-read';
import { resolveProjectScript, projectRootOf } from './routines/gate';
import { readChannelToken, channelStateDir } from './channel-token';
import { recordChannelHealth } from './channel-health';
import { appendJsonlLine } from './append-jsonl';
import { readJson } from './cli';
import { isKey } from './conversation-key';
import { getEnabledChannels, isDict } from './channel-config';
import { logRoutineEvent } from './routines/event';
import { cachedChat, lookupChat, isGuildChannelType } from './channel-chats';

type Json = any;

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
  platform_code?: number;
  partial?: boolean;
  // Notice audience routing, or chat/parent routing for an owned send.
  // Absent on a plain sendToChannel call.
  route?: 'client' | 'maintainer_channel' | 'findings' | 'chat' | 'parent';
  // True only when route === 'findings' — the notice was written to state/watchdog-events.jsonl instead of crossing a channel.
  suppressed?: boolean;
  // Set by sendOperatorNotice on the maintainer leg: did the notice reach its
  // intended destination — a live chat, OR the intended Findings home
  // (non-technical profile / fallback:'findings' with no maintainer channel)?
  // False when Findings was a *degraded* fallback (a maintainer channel is
  // configured but unreachable): the append succeeded (ok:true) but nobody live
  // saw it. Callers gating a "notified" flag must read `delivered`, not `ok`,
  // so a degraded write still leaves the heartbeat re-announce fallback armed.
  delivered?: boolean;
  // Failed client notices remain undelivered even when saved for recovery.
  undelivered_saved?: boolean;
  persistence_error?: string;
}

/** Where and how to send. `target` overrides outbound resolution (used to reply
 * to the chat a message arrived on); `timeoutMs` bounds the HTTP attempts and any rate-limit wait.
 * `sensitive` keeps the message out of the episodic channel log (auth prompts,
 * technical detail); `recordHealth: false` skips the platform health write (used
 * for maintainer-chat sends, whose failures must not mark the client route
 * down). */
export interface SendOptions {
  target?: { id: string; chat_id: string; thread?: string | null };
  timeoutMs?: number;
  sensitive?: boolean;
  recordHealth?: boolean;
  // An already-loaded config snapshot (sendOperatorNotice passes its own down to
  // each leg) so a multi-leg notice reads config.json once, not per send.
  config?: Json;
}

const REQUEST_TIMEOUT_MS = 10_000;
const TELEGRAM_MAX_LEN = 4096;
const DISCORD_MAX_LEN = 2000;

/** Split `text` into ordered parts of at most `limit` chars, breaking at the last
 * blank line, then line break, then space, then a hard cut that never separates
 * a surrogate pair. The separator itself is dropped; indentation is kept. */
export function splitMessage(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = [rest.lastIndexOf('\n\n', limit), rest.lastIndexOf('\n', limit), rest.lastIndexOf(' ', limit)]
      .find((i) => i > 0) ?? limit;
    if (cut === limit && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^(\n+| )/, '');
  }
  if (rest || !parts.length) parts.push(rest);
  return parts;
}

/** Map a fetch rejection to a stable error string (timeouts read as 'request timeout'). */
function fetchError(e: any): string {
  return e?.name === 'TimeoutError' ? 'request timeout' : e?.message || String(e);
}

/** Retry metadata is seconds; JSON values must be numbers, headers numeric strings. */
function retryDelayMs(platform: 'telegram' | 'discord', resp: Response, body: Json): number | null {
  const values: unknown[] = [platform === 'telegram' ? body?.parameters?.retry_after : body?.retry_after];
  const header = resp.headers.get('Retry-After');
  if (platform === 'discord' && header?.trim()) values.push(Number(header));
  const delays = values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return delays.length ? Math.ceil(Math.max(...delays) * 1000) : null;
}

async function sendPlatform(
  platform: 'telegram' | 'discord', url: string, request: RequestInit, timeoutMs: number,
): Promise<SendResult> {
  try {
    const deadline = performance.now() + timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(url, { ...request, signal });
      if (resp.ok) return { ok: true, status: resp.status };
      let body: Json;
      try { body = await resp.json(); } catch { signal.throwIfAborted(); }
      const error = (platform === 'telegram' ? body?.description : body?.message) || `${platform}_http_${resp.status}`;
      const failure: SendResult = { ok: false, status: resp.status, error };
      if (platform === 'discord' && typeof body?.code === 'number') failure.platform_code = body.code;
      if (resp.status !== 429 || attempt > 0) return failure;
      const delayMs = retryDelayMs(platform, resp, body);
      if (delayMs === null || delayMs >= deadline - performance.now()) return failure;
      // Never shorten the platform's wait, and never give the retry a fresh budget.
      const retryAt = performance.now() + delayMs;
      while (performance.now() < retryAt) {
        await Bun.sleep(Math.ceil(retryAt - performance.now()));
      }
      if (signal.aborted || performance.now() >= deadline) return failure;
    }
  } catch (e: any) {
    return { ok: false, error: fetchError(e) };
  }
}

async function sendTelegram(token: string, chatId: string, text: string, timeoutMs: number): Promise<SendResult> {
  const base = process.env.HERMIT_TELEGRAM_API_URL || 'https://api.telegram.org';
  return sendPlatform('telegram', `${base}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }, timeoutMs);
}

async function sendDiscord(token: string, chatId: string, text: string, timeoutMs: number): Promise<SendResult> {
  const base = process.env.HERMIT_DISCORD_API_URL || 'https://discord.com/api/v10';
  return sendPlatform('discord', `${base}/channels/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: JSON.stringify({ content: text }),
  }, timeoutMs);
}

// Keep in step with DIRECT_SEND_CHANNELS in lib/channel-config.ts.
const SENDERS: Record<string, {
  send: (token: string, chatId: string, text: string, timeoutMs: number) => Promise<SendResult>;
  maxLen: number;
}> = {
  telegram: { send: sendTelegram, maxLen: TELEGRAM_MAX_LEN },
  discord: { send: sendDiscord, maxLen: DISCORD_MAX_LEN },
};

async function sendScript(
  hermitDir: string, channelId: string, channel: Json,
  target: { chat_id: string; thread?: string | null }, text: string, deadline: number,
): Promise<SendResult> {
  try {
    const root = projectRootOf(hermitDir);
    const script = resolveProjectScript(channel.send_script, root);
    if (script.kind === 'invalid') return { ok: false, error: script.detail };
    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HERMIT_DIR: path.resolve(hermitDir),
      HERMIT_CHAT_ID: target.chat_id,
      CHANNEL_STATE_DIR: path.resolve(channelStateDir(hermitDir, channelId, channel)),
    };
    if (target.thread != null) env.HERMIT_THREAD_ID = target.thread;
    const child = Bun.spawn([script.abs], {
      cwd: root, env, stdin: new Blob([text]), stdout: 'ignore', stderr: 'ignore',
      timeout: Math.max(1, Math.ceil(deadline - performance.now())), killSignal: 'SIGKILL',
    });
    const code = await child.exited;
    return code === 0 ? { ok: true } : { ok: false, error: `exit:${code}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * POST `text` to a channel and log the send (direction:'out') on success. By
 * default resolves the eligible outbound channel (for unsolicited pushes);
 * pass `opts.target` to reply to a specific channel/chat (e.g. the one an
 * inbound message arrived on). Never throws.
 */
export async function sendToChannel(hermitDir: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
  try {
    // Raw gate first so an unreadable config keeps its distinct error code,
    // then settle so downstream shape access is uniform.
    const rawCfg = opts.config ?? readConfigRaw(hermitDir);
    if (!rawCfg) return { ok: false, error: 'config_read_failed' };
    const config = settleConfig(rawCfg);

    const target = opts.target ?? resolveOutboundChannel(config.channels);
    if (!target) return { ok: false, error: 'no_reachable_channel' };
    const { id: channelId, chat_id: chatId } = target;

    const sender = SENDERS[channelId];
    const channel = config.channels?.[channelId];
    const deadline = performance.now() + (opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let result: SendResult;
    if (!sender) {
      if (!isDict(channel)) {
        result = { ok: false, error: 'unsupported_platform' };
      } else if (!channel.send_script) {
        result = { ok: false, error: 'no_send_path' };
      } else {
        result = await sendScript(hermitDir, channelId, channel, target, text, deadline);
      }
    } else {
      const token = readChannelToken(hermitDir, channelId, channel || {});
      if (!token) return { ok: false, error: 'missing_token' };
      // Ordered parts share one timeout budget; stop at the first failed part.
      result = { ok: false };
      let accepted = false;
      for (const part of splitMessage(text, sender.maxLen)) {
        result = await sender.send(token, chatId, part, Math.max(1, Math.ceil(deadline - performance.now())));
        if (!result.ok) {
          if (accepted) result.partial = true;
          break;
        }
        accepted = true;
      }
    }
    // Record reachability for ask-gate's redirect-target check (advisory, never
    // throws). Skipped for maintainer-chat sends: a failure there must not flip
    // the platform-keyed health that ask-gate/permission-denied read for the
    // client route.
    if (opts.recordHealth !== false) recordChannelHealth(hermitDir, channelId, result.ok);
    if (!result.ok) return result;

    // Sensitive sends (auth prompts, technical maintainer detail) never enter the
    // episodic channel log — that corpus is searchable via recall and distilled
    // into weekly knowledge artifacts.
    if (!opts.sensitive && isLoggingEnabled(config, channelId)) {
      const logResult = logMessage(hermitDir, {
        source: channelId,
        chat_id: chatId,
        direction: 'out',
        text,
      });
      if (!logResult.ok) {
        process.stderr.write(`[channel-log] outbound capture failed: ${logResult.error}\n`);
      }
    }

    return { ok: true, status: result.status };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

type OwnedSendResult = SendResult & { route: 'chat' | 'parent' };

/** Only a confirmed rejection of a public thread can move content to its parent. */
async function fallbackToParent(
  hermitDir: string, target: { id: string; chat_id: string }, text: string,
  result: SendResult, opts: SendOptions,
): Promise<OwnedSendResult> {
  const unchanged: OwnedSendResult = { ...result, route: 'chat' };
  if (result.ok || target.id !== 'discord' || result.partial
    || ![10003, 50083, 160005].includes(result.platform_code ?? 0)
    || !getEnabledChannels(opts.config).includes(target.id)) return unchanged;
  const chat = cachedChat(hermitDir, target.chat_id);
  if (!chat || (chat.type !== 10 && chat.type !== 11) || !chat.parent_id) return unchanged;
  const parent = await lookupChat(hermitDir, opts.config, chat.parent_id);
  if (!isGuildChannelType(parent)) return unchanged;
  const sent = await sendToChannel(hermitDir, `(the original thread is no longer reachable)\n${text}`, {
    ...opts, target: { id: target.id, chat_id: chat.parent_id }, recordHealth: false,
  });
  return { ...sent, route: 'parent' };
}

/** Deliver unattended output to its owning chat, preserving a safe public parent fallback. */
export async function sendToOwnedChat(
  hermitDir: string, chatKey: string, text: string, opts: Omit<SendOptions, 'target'> = {},
): Promise<OwnedSendResult> {
  if (!isKey(chatKey)) return { ok: false, error: 'invalid_chat', route: 'chat' };
  const at = chatKey.indexOf(':');
  const target = { id: chatKey.slice(0, at), chat_id: chatKey.slice(at + 1) };
  const config = opts.config ?? readSettledConfig(hermitDir);
  if (!getEnabledChannels(config).includes(target.id)) return { ok: false, error: 'channel_disabled', route: 'chat' };
  if (target.id === 'discord') await lookupChat(hermitDir, config, target.chat_id);
  const options = { ...opts, config, recordHealth: false };
  const result = await sendToChannel(hermitDir, text, { ...options, target });
  return fallbackToParent(hermitDir, target, text, result, options);
}

/**
 * A two-audience operator notice. `client` is plain, localized copy for the
 * primary chat; `maintainer` carries technical/spend/ops detail whose `fallback`
 * decides where it goes when no `maintainer_channel_id` is configured
 * (`'client'` = the primary chat for technical profiles, `'primary'` = the
 * primary chat for every profile, `'findings'` = suppressed to state/watchdog-events.jsonl).
 * A configured but unreachable maintainer destination always fails closed to
 * Findings. `sensitive` keeps the maintainer text out of the episodic channel log.
 */
export interface OperatorNotice {
  client?: string;
  maintainer?: { text: string; fallback: 'client' | 'primary' | 'findings'; sensitive?: boolean };
  timeoutMs?: number;
  /** The routine whose fire sends this notice; its `chat`, when set, takes the client leg. */
  routine?: string;
  /** The watch whose events send this notice; its registry `chat` takes the client leg. */
  watch?: string;
}

/** The `chat` of entry `id` in `entries` as a send target, or null when it has none. */
function ownedChat(entries: Json, id: string | undefined): { id: string; chat_id: string } | null {
  if (!id || !Array.isArray(entries)) return null;
  const chat = entries.find((e: Json) => e?.id === id)?.chat;
  if (!isKey(chat)) return null;
  const at = chat.indexOf(':');
  return { id: chat.slice(0, at), chat_id: chat.slice(at + 1) };
}

function sameChat(a: { id: string; chat_id: Json } | null, b: { id: string; chat_id: Json } | null): boolean {
  return !!a && !!b && a.id === b.id && String(a.chat_id) === String(b.chat_id);
}

export interface OperatorNoticeResult {
  client?: SendResult;
  maintainer?: SendResult;
}

/** Append one notice row to Findings. Returns null on success, else the error. */
export function appendMaintainerFindings(
  hermitDir: string, text: string, action = 'maintainer-notice',
): string | null {
  try {
    return appendJsonlLine(path.join(hermitDir, 'state', 'watchdog-events.jsonl'), JSON.stringify({
      ts: new Date().toISOString(),
      action,
      reason: text,
    }));
  } catch (error: any) {
    return error?.message || String(error);
  }
}

/**
 * Deliver a two-audience notice, owning all audience policy so callers never
 * inspect routing: one config snapshot, client + maintainer target resolution,
 * physical-target merge (same chat ⇒ both texts together), missing/failed
 * maintainer fallback, sensitive-log handling, and Findings append. Never throws.
 */
export async function sendOperatorNotice(hermitDir: string, notice: OperatorNotice): Promise<OperatorNoticeResult> {
  const out: OperatorNoticeResult = {};
  const config: Json = readSettledConfig(hermitDir);
  const channels = config.channels;
  const clientTarget = resolveOutboundChannel(channels);
  const maintainerTarget = resolveMaintainerTarget(channels);
  const nonTechnical = config.operator_profile === 'non-technical';
  // A routine's or watch's own chat takes the client leg; the maintainer leg keeps
  // the home routing, so technical detail never reaches a team chat.
  const owned = notice.routine
    ? ownedChat(config.routines, notice.routine)
    : notice.watch
      // A config watch's chat is read live from config.json, like a routine's;
      // an ad-hoc watch's lives on its registry entry.
      ? ownedChat(
        Array.isArray(config.monitors) && config.monitors.some((m: Json) => m?.id === notice.watch)
          ? config.monitors
          : readJson(path.join(hermitDir, 'state/monitors.runtime.json'))?.monitors,
        notice.watch)
      : null;
  const target = owned ?? clientTarget;
  let mergedResult: SendResult | undefined;

  if (notice.maintainer) {
    const m = notice.maintainer;
    // `degraded` = Findings was a fallback because a configured maintainer
    // channel was unreachable (nobody live saw it), vs. Findings being the
    // intended home (non-technical / fallback:'findings'). Only the intended
    // case counts as delivered.
    const toFindings = (degraded: boolean): SendResult => {
      const err = appendMaintainerFindings(hermitDir, m.text);
      return err
        ? { ok: false, error: `findings_append_failed: ${err}`, route: 'findings', suppressed: true, delivered: false }
        : { ok: true, route: 'findings', suppressed: true, delivered: !degraded };
    };
    if (maintainerTarget) {
      const merged = !!notice.client && sameChat(maintainerTarget, target);
      if (merged && owned?.id === 'discord') await lookupChat(hermitDir, config, owned.chat_id);
      const r = await sendToChannel(hermitDir, merged ? `${notice.client}\n\n${m.text}` : m.text, {
        target: maintainerTarget, sensitive: m.sensitive, recordHealth: false, timeoutMs: notice.timeoutMs, config,
      });
      if (merged) mergedResult = r;
      // Configured but unreachable → Findings. Configured routing intent wins
      // over the fallback: a bad chat id must never spill technical/spend
      // detail into the client chat.
      out.maintainer = r.ok ? { ...r, route: 'maintainer_channel', delivered: true } : toFindings(true);
    } else if (m.fallback === 'findings' || (m.fallback === 'client' && nonTechnical)) {
      out.maintainer = toFindings(false);
    } else {
      // fallback 'client' on a technical profile, or explicit 'primary' on any
      // profile, with no maintainer channel: send to the primary chat.
      const merged = !!notice.client && sameChat(clientTarget, target);
      if (merged && owned?.id === 'discord') await lookupChat(hermitDir, config, owned.chat_id);
      const r = await sendToChannel(hermitDir, merged ? `${notice.client}\n\n${m.text}` : m.text, {
        target: clientTarget ?? undefined, timeoutMs: notice.timeoutMs, config,
      });
      if (merged) mergedResult = r;
      out.maintainer = { ...r, route: 'client', delivered: r.ok };
    }
  }

  if (notice.client) {
    const options = { timeoutMs: notice.timeoutMs, config, recordHealth: false };
    if (mergedResult) {
      // A failed merged send may retry only the client text in a safe parent.
      out.client = owned
        ? await fallbackToParent(hermitDir, owned, notice.client, mergedResult, options)
        : { ...mergedResult };
    } else if (owned) {
      out.client = await sendToOwnedChat(hermitDir, `${owned.id}:${owned.chat_id}`, notice.client, options);
    } else {
      out.client = await sendToChannel(hermitDir, notice.client, {
        target: target ?? undefined, timeoutMs: notice.timeoutMs, config,
      });
    }
    // A parent success still records that the routine's original chat failed.
    if (owned && notice.routine && (!out.client.ok || out.client.route === 'parent')) {
      const failure = `${owned.id}:${owned.chat_id}: ${out.client.error ?? 'original thread unreachable'}`;
      logRoutineEvent(notice.routine, 'chat-undelivered', hermitDir, 'channel-send', failure);
    }
    if (!out.client.ok) {
      const error = appendMaintainerFindings(hermitDir, notice.client, 'undelivered-client-notice');
      out.client.undelivered_saved = error === null;
      if (error !== null) out.client.persistence_error = error;
      if (owned) {
        // No safe parent delivered it. Tell the operator the owning chat failed.
        const failure = `${owned.id}:${owned.chat_id}: ${out.client.error ?? 'send failed'}`;
        const owner = notice.routine ? `Routine ${notice.routine}` : `Watch ${notice.watch}`;
        await sendOperatorNotice(hermitDir, {
          maintainer: { text: `${owner} could not post to its chat ${failure}`, fallback: 'client' },
          timeoutMs: notice.timeoutMs,
        });
      }
    }
  }

  return out;
}
