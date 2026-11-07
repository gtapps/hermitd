// UserPromptSubmit stage: deterministic status and scheduled-work replies.
//
// Exact, optionally bot-addressed /status and /scheduled commands from admitted
// channel senders read state and reply through lib/channel-send without a model
// turn. This also works while paused, when the model cannot Read current state.
//
// Send-then-block: only emits {"decision":"block"} after a confirmed
// successful send, so a failed send always falls through to a normal model
// turn — never "blocked prompt + failed send = silence".
//
// Near-miss bodies fall through untouched. Mid-turn channel arrivals are queued
// and run UserPromptSubmit individually (CC 2.1.263), including exact /status.

import fs from 'node:fs';
import path from 'node:path';
import { isAllowedSender, isTrustedController, isPrimaryOperator, channelBotIdentity } from '../channel-auth';
import { resolveSlashCommand } from '../channel-slash-address';
import { isPaused, pauseReasonLabel } from '../pause';
import { resolveTimezone, budgetLine } from '../spend-status';
import { friendlyBoundary, parseSimpleCronTime } from '../time';
import { wallMinutes } from '../cron-shift';
import { sendToChannel } from '../channel-send';
import { loadMessages, type Messages } from '../messages';
import { readTasks, currentWork, latestWaitIsStall, type Task } from '../tasks';
import { conversationKey } from '../conversation-key';
import { homeChatKey } from '../home-chat';
import { decodeDecision } from '../tasks';
import type { StageContext, StageResult } from './types';

type Json = any;

function readJson(p: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function pauseLine(dir: string, timezone: string, m: Messages): string | null {
  const status = isPaused(dir);
  if (!status.paused) return null;
  const label = pauseReasonLabel(status.reason, m);
  // Dated form (not bare HH:MM) so a resume days/weeks out isn't read as minutes away.
  const valid = status.until != null && !isNaN(new Date(status.until).getTime());
  if (!valid) return m.t('status_paused_until_resume', { label });
  return m.t('status_paused_until_date', { label, boundary: friendlyBoundary(status.until as string, timezone) });
}

// An unreadable store is treated as nothing to report rather than failing the reply.
function readRecords(dir: string): Task[] {
  try {
    return readTasks(dir);
  } catch {
    return [];
  }
}

// Only worth a line when something is actually pending — an empty queue
// shouldn't crowd out the "all quiet" fallback in composeStatusReply.
const AGE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400], ['month', 30 * 86400], ['week', 7 * 86400], ['day', 86400],
  ['hour', 3600], ['minute', 60], ['second', 1],
];

// How long ago `start` was, as locale relative time ("3 hours ago").
function relativeAge(start: number, m: Messages): string {
  const seconds = Math.max(0, (Date.now() - start) / 1000);
  const [unit, size] = AGE_UNITS.find(([, duration]) => seconds >= duration) ?? AGE_UNITS[AGE_UNITS.length - 1];
  return new Intl.RelativeTimeFormat(m.locale, { numeric: 'always' }).format(-Math.floor(seconds / size), unit);
}

// Open records whose wait is on this sender (or on 'operator' for the primary
// operator), oldest wait first, as localized board lines.
function waitingRecords(all: Task[], keys: Set<string>, m: Messages): string[] {
  const records = all.filter(task => task.status === 'open' && task.waiting_on !== null && keys.has(task.waiting_on));
  if (records.length === 0) return [];
  return records
    .map(task => {
      // A stall raised after a result is the current ask, so it wins the label and the age.
      const confirm = !!task.result && !latestWaitIsStall(task);
      return { task, confirm, start: Date.parse((confirm ? task.result_at : null) ?? task.waiting_since ?? task.opened_at) };
    })
    .sort((a, b) => a.start - b.start)
    .map(({ task, confirm, start }) =>
      m.t(confirm ? 'status_waiting_confirm' : 'status_waiting_answer', { task: task.title, age: relativeAge(start, m) }));
}

// Cron day-of-week matcher (0=Sun..6=Sat; 7 also Sun). Supports '*', comma
// lists, and 'a-b' ranges — enough for the routine schedules. Anything
// unparseable defaults to matching, so a routine is never wrongly hidden.
function cronDowMatches(field: string, weekday: number): boolean {
  if (field === '*') return true;
  for (const tok of field.split(',')) {
    const range = tok.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = parseInt(range[1], 10) % 7;
      const hi = parseInt(range[2], 10) % 7;
      if (lo <= hi ? weekday >= lo && weekday <= hi : weekday >= lo || weekday <= hi) return true;
      continue;
    }
    const n = parseInt(tok, 10);
    if (!isNaN(n) && n % 7 === weekday) return true;
  }
  return false;
}

// Weekday 0=Sun..6=Sat in `timezone`, or null on Intl failure.
function localWeekday(timezone: string): number | null {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(new Date());
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return wd in map ? map[wd] : null;
  } catch { return null; }
}

// Minutes from now until this routine's next fire, honoring its DOW field:
// scans today (offset 0) through the next week for the first matching weekday
// whose fire time hasn't already passed.
function minutesUntilNextFire(dowField: string, fireMin: number, nowMin: number, todayWeekday: number): number | null {
  for (let offset = 0; offset < 8; offset++) {
    const weekday = (todayWeekday + offset) % 7;
    if (!cronDowMatches(dowField, weekday)) continue;
    const delta = offset * 24 * 60 + fireMin - nowMin;
    if (delta >= 0) return delta;
  }
  return null;
}

// Standing work (routines, saved watches, approvals) belongs to the chat; a thread
// suffix on either key is ignored, so a thread lists its whole chat's entries.
function belongsToChat(entry: Json, chatKey: string | undefined, home: string | null): boolean {
  if (chatKey === undefined) return false;
  const chat = chatKey.split('~')[0];
  if (typeof entry?.chat === 'string') return entry.chat.split('~')[0] === chat;
  return home !== null && home === chat;
}

function nextRoutineLine(config: Json, chatKey: string | undefined, timezone: string, m: Messages): string | null {
  const routines = Array.isArray(config?.routines) ? config.routines : [];
  const now = wallMinutes(timezone, new Date());
  if (now === null) return null;
  const weekday = localWeekday(timezone);
  if (weekday === null) return null;

  let best: { id: string; hour: number; minute: number; delta: number } | null = null;
  for (const r of routines) {
    if (!r || r.enabled === false || typeof r.schedule !== 'string' || !belongsToChat(r, chatKey, homeChatKey(config?.channels))) continue;
    const fireTime = parseSimpleCronTime(r.schedule);
    if (!fireTime) continue;
    const dowField = String(r.schedule).trim().split(/\s+/)[4] ?? '*';
    const delta = minutesUntilNextFire(dowField, fireTime.hour * 60 + fireTime.minute, now, weekday);
    if (delta === null) continue;
    if (!best || delta < best.delta) best = { id: String(r.id ?? 'routine'), hour: fireTime.hour, minute: fireTime.minute, delta };
  }
  if (!best) return null;
  const hh = String(best.hour).padStart(2, '0');
  const mm = String(best.minute).padStart(2, '0');
  return m.t('status_next_routine', { hh, mm, id: best.id });
}

export function composeStatusReply(dir: string, config: Json, opts: {
  redact?: boolean;
  senderKey?: string | null;
  chatKey?: string;
  primary?: boolean;
} = {}): string {
  const timezone = resolveTimezone(config);
  const m = loadMessages(dir, config?.language);
  const records = readRecords(dir);
  const scoped = records.filter(task => task.conversation === opts.chatKey || (opts.primary && task.conversation === null && task.decision && decodeDecision(task.decision).authority === 'admin'));
  const current = currentWork(opts.redact ? records : scoped);
  const lines: string[] = [];

  const pause = pauseLine(dir, timezone, m);
  if (pause) lines.push(pause);

  if (opts.redact) {
    // Unauthenticated sender on a no-allowlist channel: coarse state only — never
    // spend figures, task text, pending-approval IDs, or the routine schedule.
    lines.push(m.t(current ? 'status_working' : 'status_idle'));
    return lines.join(' ');
  }

  // The age lets the operator judge whether long-running work has stalled.
  if (current) lines.push(m.t('status_working_on', { task: current.title, age: relativeAge(Date.parse(current.opened_at), m) }));

  const budget = budgetLine(dir, config, timezone, m);
  if (budget) lines.push(budget);

  const routine = nextRoutineLine(config, opts.chatKey, timezone, m);
  if (routine) lines.push(routine);

  const keys = new Set<string>();
  if (opts.senderKey) keys.add(opts.senderKey);
  if (opts.primary) keys.add('operator');
  const waiting = waitingRecords(scoped.filter(task => !task.decision), keys, m);
  const counts = new Map<string, number>();
  for (const task of scoped) {
    if (task.status !== 'open' || !task.waiting_on || !task.decision) continue;
    const decision = decodeDecision(task.decision);
    if (!opts.primary && decision.authority === 'admin') continue;
    if (!opts.primary && decision.authority === 'requester' && task.requester !== opts.senderKey) continue;
    counts.set(decision.authority, (counts.get(decision.authority) ?? 0) + 1);
  }
  for (const [decider, n] of counts) waiting.push(m.t('status_decisions_count', { n, decider }));
  const head = lines.join(' ');
  if (waiting.length === 0) return head || m.t('status_all_quiet');
  const block = [m.t('status_waiting_header'), ...waiting.slice(0, 5).map(item => `• ${item}`)];
  if (waiting.length > 5) block.push(m.t('status_waiting_more', { n: waiting.length - 5 }));
  return [head, ...block].filter(Boolean).join('\n');
}

function composeScheduledReply(dir: string, config: Json, chatKey: string, trusted: boolean): string {
  const m = loadMessages(dir, config?.language);
  const home = homeChatKey(config?.channels);
  const routines = (Array.isArray(config?.routines) ? config.routines : [])
    .filter((entry: Json) => entry && belongsToChat(entry, chatKey, home));
  const watches = (Array.isArray(config?.monitors) ? config.monitors : [])
    .filter((entry: Json) => entry && belongsToChat(entry, chatKey, home));
  const count = routines.length + watches.length;
  if (count === 0) return m.t('scheduled_empty');
  if (!trusted) return m.t('scheduled_count', { n: count });

  const timezone = resolveTimezone(config);
  const pending = new Set(readRecords(dir).filter(task => task.status === 'open' && task.waiting_on && task.decision &&
    (task.conversation === chatKey || task.conversation === null)).map(task => task.dedupe_key));
  const rows: string[] = [];
  // Saved watches first, so a home chat's built-in routines cannot push them past the cap.
  for (const watch of watches.slice(0, 10)) {
    const command = String(watch.command ?? '');
    const poll = /(?:^|\s)watch-poll\s+\S+(?:\s+--every\s+(\S+))?(?:\s+--timeout\s+\S+)?\s+--\s+([\s\S]*)$/.exec(command);
    const state = m.t(watch.enabled !== false ? 'scheduled_on'
      : pending.has(`watch-enable:${watch.id}`) ? 'scheduled_pending' : 'scheduled_off');
    const description = String(watch.description ?? '');
    rows.push(poll
      ? m.t('scheduled_watch', { id: String(watch.id), description, every: poll[1] ?? '5m', state, check: poll[2].slice(0, 200) })
      : m.t('scheduled_stream', { id: String(watch.id), description, state, check: command.slice(0, 200) }));
  }
  for (const routine of routines.slice(0, 10 - rows.length)) {
    // HH:MM only for a fixed daily time; any other cron keeps its day fields visible.
    const daily = /^\d+\s+\d+\s+\*\s+\*\s+\*$/.test(String(routine.schedule ?? '').trim());
    const time = daily ? parseSimpleCronTime(routine.schedule) : null;
    const schedule = time ? `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}` : String(routine.schedule ?? '');
    rows.push(m.t('scheduled_routine', {
      id: String(routine.id), schedule, timezone,
      state: m.t(routine.enabled === false ? 'scheduled_off' : 'scheduled_on'),
    }));
  }
  if (count > rows.length) rows.push(m.t('status_waiting_more', { n: count - rows.length }));
  return rows.join('\n');
}

export async function run(ctx: StageContext): Promise<StageResult | void> {
  const envelope = ctx.envelope;
  if (!envelope) return;

  const dir = ctx.dir;
  const config = ctx.config();
  if (!config) return;

  // Slash-only exact match, same rule as the pause and harness commands — a bare
  // "status" now falls through to the model, as every near-miss already did.
  const addressed = resolveSlashCommand(envelope.body, channelBotIdentity(config, envelope.source));
  if (!addressed || !['/status', '/scheduled'].includes(addressed.command) || addressed.rest.length > 0) return;

  if (!isAllowedSender(config, envelope.source, envelope.userId)) return;

  // Full status only for the trusted operator (explicit allowlist, or the DM chat
  // when no list is set); any other accepted sender gets a redacted, coarse reply.
  const trusted = isTrustedController(config, envelope.source, envelope.userId, envelope.chatId);
  const chatKey = conversationKey(envelope.sourceKey, envelope.chatId, envelope.thread);
  const scheduled = addressed.command === '/scheduled';
  const reply = scheduled ? composeScheduledReply(dir, config, chatKey, trusted) : composeStatusReply(dir, config, {
    redact: !trusted,
    senderKey: envelope.userId === null ? null : `${envelope.sourceKey}:${envelope.userId}`,
    chatKey,
    primary: isPrimaryOperator(config, envelope.source, envelope.userId, envelope.chatId),
  });
  // Reply to the chat the request arrived on — not the globally-resolved
  // outbound channel — so a status asked in a group or a non-primary channel is
  // answered where it was asked. This also keeps the destination aligned with the
  // allowed_users gate above. A tight timeout bounds this hook's blocking.
  const result = await sendToChannel(dir, reply, {
    target: { id: envelope.sourceKey, chat_id: envelope.chatId, thread: envelope.thread },
    timeoutMs: 6000,
    config, // already loaded by the pipeline — don't make the sender re-read it
  });
  if (result.ok) {
    return { block: `${scheduled ? 'scheduled' : 'status'} answered deterministically` };
  }

  // Deterministic delivery failed — an unsupported platform (iMessage/webhook aren't
  // in lib/channel-send's SENDERS) or a transient send error. Rather than fall through
  // to a blind model turn — which, while paused, can't Read state and would answer from
  // nothing — inject the already-composed (and redaction-correct) status as context and
  // have the model relay it verbatim via its channel reply tool (pause-gate exempts that
  // tool). Not a block, so the model's turn proceeds. Probe-verified that a
  // UserPromptSubmit hook's stdout reaches the model on the same turn
  // (compiled/spike-userprompt-additionalcontext-probe-2026-07-05.md) — the same
  // mechanism channel-reply-reminder.ts relies on.
  return {
    context:
      `[${scheduled ? 'scheduled' : 'status'}] Deterministic delivery is unavailable on this channel. Relay the ` +
      `following reply to the operator verbatim via the channel reply tool (to the chat ` +
      `this message arrived on), then stop — add no commentary:\n${reply}\n`,
  };
}
