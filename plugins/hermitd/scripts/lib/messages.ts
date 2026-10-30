// Operator-facing message catalog for script-owned channel sends.
//
// Every deterministic (non-model) sender composes its operator prose here. `EN`
// is the only shipped language: flat keys, `{placeholder}` tokens for anything
// code fills in. Other languages are written once by the model into
// `state/messages.json` (hatch, `hermit-settings language`, `hermit-evolve`) via
// the `messages.ts` CLI, and read here with plain file IO, so a send never needs
// the model (the watchdog speaks while the model may be wedged).
//
// File shape: { language, locale, strings: { key: { text, en_hash } }, overrides: { key: text } }.
//   strings   model-owned translations; an entry counts only while its en_hash
//             matches the shipped English and `language` matches config.language.
//   overrides operator-owned wording; never regenerated, used in any language.
// Per key: a valid override, else a valid translation, else English. "Valid" means
// the exact English placeholder set, so a bad entry can't drop a value or a
// locked token (`{keyword}` is the literal the mint ack matcher looks for).

import path from 'node:path';
import { sha256 } from './hash';
import { readJson } from './cli';

export const EN = {
  // Pause reason, fills {label} in the paused lines below.
  pause_reason_budget: 'a budget cap',
  pause_reason_watchdog: 'the watchdog',
  pause_reason_request: 'your request',

  // Status reply (lib/prompt-stages/channel-status-responder.ts)
  status_paused_until_resume: 'Paused ({label}) until you resume it.',
  status_paused_until_date: 'Paused ({label}) until {boundary}.',
  status_working_on: 'Working on {task}.',
  status_working: 'Working.',
  status_idle: 'Idle.',
  status_one_approval: '1 approval waiting (reply "{id} yes/no").',
  status_n_approvals: '{n} approvals waiting.',
  status_next_routine: 'Next routine: {hh}:{mm} ({id}).',
  status_all_quiet: 'All quiet — nothing in progress, nothing waiting.',

  // Spend cap line in the status reply (lib/spend-status.ts)
  spend_label_daily: 'Today',
  spend_label_weekly: 'This week',
  spend_label_monthly: 'This month',
  spend_cap_status: '{label}: {spend} of {cap} cap.',

  // Budget push (cost-tracker.ts), joined in code
  budget_period_daily: "today's",
  budget_period_weekly: "this week's",
  budget_period_monthly: "this month's",
  budget_clause: '{period} spend is ${spend} of your ${cap} cap ({pct}%)',
  budget_cap_reached_prefix: 'Budget cap reached — ',
  budget_also_approaching: '. Also approaching: ',
  budget_paused_until_suffix: ". I've paused until {boundary}",
  budget_heads_up_prefix: 'Heads up — ',
  budget_client_paused: "I've paused work until {boundary} to stay within the plan you set. I'll pick it back up then.",

  // Auto-mode denial (permission-denied-notify.ts), joined in code
  deny_base: 'Auto-mode denied: {tool}',
  deny_suppressed: ' (+{count} more in the previous 30 min)',
  deny_tail: '. Session continues; the agent will try another way. If it was intended, tell the agent in chat.',

  // Token mint (setup-token-mint.ts)
  mint_ack_prompt:
    "Your agent's Claude login has expired, so it can't work until it's renewed. " +
    "Reply '{keyword}' in the chat where you normally talk to me and I'll send you a one-time sign-in link.",
  mint_open_link: 'Open this link to sign in, then send me the code it gives you:\n{url}',
  mint_failed: "That sign-in didn't complete. Nothing changed — we can try again whenever you're ready.",
  mint_signed_in: "You're signed back in. Nothing else to do — the next renewal is due {date}, and I'll ask you then.",
  mint_signed_in_undated: "You're signed back in. Nothing else to do — I'll ask you again when the next renewal is due.",
  mint_date_unknown: 'in about a year',

  // Watchdog lifecycle pushes (hermitd-watchdog.ts)
  watchdog_restart_resumed: 'Attempting to restart your agent at {time}: {cause}. Its conversation is restored where possible, but work in flight since the last save may not have carried over, so it will re-check its work before continuing.',
  watchdog_restart_fresh: 'Attempting to restart your agent at {time}: {cause}. It starts a fresh conversation, so work in flight since the last save is lost and it picks up from its saved work.',
  watchdog_cause_not_running: "it wasn't running",
  watchdog_cause_frozen: 'it had frozen',
  watchdog_cause_upgrade: 'it needs to finish an upgrade',
  watchdog_cause_requested: 'a restart was requested',
  watchdog_wedge: "Your agent hasn't responded in a while — checking on it now ({time}). If it has to be restarted, work in flight may be lost.",
  watchdog_wedge_recovered: 'Your agent is responding again, nothing to do ({time}).',
  watchdog_paused_until_resume: 'Your agent is paused ({label}) until you resume it.',
  watchdog_paused_until_date: 'Your agent is paused ({label}) until {boundary}.',
  watchdog_stall_question: "Your agent is waiting on a question it can't ask over chat — open the terminal or Claude app to answer ({time}).",
  watchdog_stall_permission: 'The agent asked for permission to continue and is waiting for an answer ({time}). It will pick up where it left off once someone approves.',
  watchdog_session_wedged: 'Your agent has stopped picking up its scheduled work — something on screen is holding it. Open the terminal or Claude app and clear whatever is waiting there ({time}).',
  watchdog_orphan: "Your agent's session ended but a process may still be running ({time}). If it keeps replying, stop it from the terminal: run {command} and kill that PID.",
  watchdog_lapsed_login: "Your Claude login has expired, so your agent can't do any work until you sign in again ({time}). {fix}",
  watchdog_lapsed_login_fix_docker: 'This one needs the machine it runs on: {login}, then {restart}.',
  watchdog_lapsed_login_fix_host: 'This one needs the machine it runs on: run {claude} in its project folder, type {login}, then restart it with {stop} and {start}.',
  watchdog_env_auth_failure: "Your agent's API credential is being rejected, so it can't do any work until that key is valid again ({time}). This isn't a sign-in you can renew from chat — check the key where you set it: it may have been revoked or rotated, or the account may be out of credit. I've left the session alone rather than restarting it, because a restart would lose the key entirely.",
  watchdog_usage_limit: "Your agent has reached Claude's usage limit for now ({time}). It will resume on its own at {reset}.",
  watchdog_usage_limit_no_reset: "Your agent has reached Claude's usage limit for now ({time}). It will resume on its own once the limit resets.",
  watchdog_api_unavailable: 'Your agent is affected by a temporary Claude service outage ({time}). It will resume on its own. {url}',

  // Deterministic shutdown gate (lib/prompt-stages/shutdown-gate.ts)
  shutdown_in_progress: "Shutting down — I'll be back once the restart completes.",

  // Owned-chat parent fallback (lib/channel-send.ts)
  owned_chat_thread_unreachable: '(the original thread is no longer reachable)',
} as const;

export type MessageKey = keyof typeof EN;
export type Vars = Record<string, string | number>;

/** Translator context for keys that are fragments of a longer message. Printed by
 *  `messages.ts scaffold`; never sent. */
export const NOTES: Partial<Record<MessageKey, string>> = {
  pause_reason_budget: 'Fills {label} in "Paused ({label}) until you resume it."',
  pause_reason_watchdog: 'Fills {label} in "Paused ({label}) until you resume it."',
  pause_reason_request: 'Fills {label} in "Paused ({label}) until you resume it."',
  status_one_approval: 'The operator answers with the id and yes or no in their own words; translate yes/no.',
  spend_label_daily: 'Fills {label} in spend_cap_status.',
  spend_label_weekly: 'Fills {label} in spend_cap_status.',
  spend_label_monthly: 'Fills {label} in spend_cap_status.',
  budget_period_daily: 'Fills {period} at the start of budget_clause.',
  budget_period_weekly: 'Fills {period} at the start of budget_clause.',
  budget_period_monthly: 'Fills {period} at the start of budget_clause.',
  budget_clause: 'Joined as: <cap_reached_prefix or heads_up_prefix><clause>[; <clause>][<also_approaching><clause>][<paused_until_suffix>].',
  budget_cap_reached_prefix: 'Starts a budget alert; budget_clause follows directly. Keep the trailing space.',
  budget_also_approaching: 'Between clauses of a budget alert. Keep the leading period and trailing space.',
  budget_paused_until_suffix: 'Ends a budget alert; a final period is added after it.',
  budget_heads_up_prefix: 'Starts a budget warning; budget_clause follows directly. Keep the trailing space.',
  deny_base: 'Joined as: <deny_base>[ — <reason>][<deny_suppressed>]<deny_tail>.',
  deny_suppressed: 'Follows deny_base. Keep the leading space.',
  deny_tail: 'Ends the denial notice. Keep the leading period.',
  mint_ack_prompt: '{keyword} is the literal word the operator must type back.',
  mint_date_unknown: 'Fills {date} in mint_signed_in when the exact date is unknown.',
  watchdog_cause_not_running: 'Fills {cause} in watchdog_restart_resumed and watchdog_restart_fresh.',
  watchdog_cause_frozen: 'Fills {cause} in watchdog_restart_resumed and watchdog_restart_fresh.',
  watchdog_cause_upgrade: 'Fills {cause} in watchdog_restart_resumed and watchdog_restart_fresh.',
  watchdog_cause_requested: 'Fills {cause} in watchdog_restart_resumed and watchdog_restart_fresh.',
  watchdog_lapsed_login_fix_docker: 'Fills {fix} at the end of watchdog_lapsed_login. The placeholders are commands.',
  watchdog_lapsed_login_fix_host: 'Fills {fix} at the end of watchdog_lapsed_login. The placeholders are commands.',
  watchdog_orphan: '{command} is a shell command.',
};

/** Values for placeholders that are never translated: commands, URLs, keywords. */
export const LOCKED = {
  keyword: 'reauth',
  orphan_command: '`pgrep -af "claude --channels"`',
  docker_login: '`hermitd docker login`',
  docker_restart: '`hermitd restart`',
  host_claude: '`claude`',
  host_login: '`/login`',
  host_stop: '`hermitd stop`',
  host_start: '`hermitd start`',
  status_url: 'https://status.claude.com',
} as const;

const MESSAGES_FILE = 'messages.json';
const DEFAULT_LOCALE = 'en-GB';
const PLACEHOLDER = /\{([a-z_]+)\}/g;

export function messagesPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', MESSAGES_FILE);
}

function placeholderSig(text: string): string {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort().join(',');
}

// EN is constant, so its hashes and placeholder sets are computed once.
const EN_HASH = new Map((Object.keys(EN) as MessageKey[]).map((k) => [k, sha256(EN[k]).slice(0, 12)]));
const EN_SIG = new Map((Object.keys(EN) as MessageKey[]).map((k) => [k, placeholderSig(EN[k])]));

export function enHash(key: MessageKey): string {
  return EN_HASH.get(key)!;
}

export function isMessageKey(k: string): k is MessageKey {
  return Object.prototype.hasOwnProperty.call(EN, k);
}

export function expectedPlaceholders(key: MessageKey): string[] {
  const sig = EN_SIG.get(key)!;
  return sig ? sig.split(',') : [];
}

/** A candidate wording for `key` is usable when it is non-empty text carrying
 *  exactly the English placeholder set. */
export function validText(key: MessageKey, text: unknown): text is string {
  return typeof text === 'string' && text.trim() !== '' && placeholderSig(text) === EN_SIG.get(key);
}

/** Keep the English edge whitespace: fragments are joined in code, and a
 *  translator trimming a trailing space would glue two words together. */
function edges(key: MessageKey, text: string): string {
  const en = EN[key];
  return en.match(/^\s*/)![0] + text.trim() + en.match(/\s*$/)![0];
}

function normLanguage(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = v.trim().toLowerCase().replace(/_/g, '-');
  return n === '' || n === 'en' || n.startsWith('en-') || n === 'english' ? null : n;
}

/** English (or unset) needs no messages file translations. */
export function isEnglish(v: unknown): boolean {
  return normLanguage(v) === null;
}

export function sameLanguage(a: unknown, b: unknown): boolean {
  const na = normLanguage(a);
  return na !== null && na === normLanguage(b);
}

/** A BCP 47 tag Intl can format dates in, trimmed; null otherwise. */
export function validLocale(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([v.trim()]).length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

export function readMessagesFile(hermitDir: string): any | null {
  const data = readJson(messagesPath(hermitDir));
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/** The parts of a messages file that apply under `language`: translations only
 *  when the file's language matches, overrides always. */
function sections(file: any, language: unknown) {
  const live = !!file && sameLanguage(file.language, language);
  const strings = live && file.strings && typeof file.strings === 'object' ? file.strings : {};
  const overrides = file?.overrides && typeof file.overrides === 'object' ? file.overrides : {};
  return { live, strings, overrides };
}

type EntryState = 'translated' | 'stale' | 'invalid' | 'missing';

function entryState(key: MessageKey, e: any): EntryState {
  if (!e) return 'missing';
  if (!validText(key, e.text)) return 'invalid';
  return e.en_hash === enHash(key) ? 'translated' : 'stale';
}

/** Per-key state of a messages file against the shipped English and `language`. */
export function auditMessages(file: any, language: unknown) {
  const { live, strings, overrides } = sections(file, language);
  const by: Record<EntryState, MessageKey[]> = { translated: [], stale: [], invalid: [], missing: [] };
  for (const key of Object.keys(EN) as MessageKey[]) by[entryState(key, strings[key])].push(key);
  const overridden: MessageKey[] = [], invalidOverrides: string[] = [];
  for (const k of Object.keys(overrides)) {
    if (isMessageKey(k) && validText(k, overrides[k])) overridden.push(k);
    else invalidOverrides.push(k);
  }
  return { live, ...by, overridden, invalidOverrides };
}

export interface Messages {
  /** Operator wording for `key` with `vars` filled in. */
  t(key: MessageKey, vars?: Vars): string;
  /** BCP 47 tag for Intl date formatting. */
  locale: string;
}

/** Pure resolver over an already-read messages file (null = English only). */
export function buildMessages(file: any, language: unknown): Messages {
  const { live, strings, overrides } = sections(file, language);
  const pick = (key: MessageKey): string => {
    if (validText(key, overrides[key])) return edges(key, overrides[key]);
    if (entryState(key, strings[key]) === 'translated') return edges(key, strings[key].text);
    return EN[key];
  };
  return {
    t: (key, vars = {}) => pick(key).replace(PLACEHOLDER, (m, name) => (name in vars ? String(vars[name]) : m)),
    locale: (live && validLocale(file.locale)) || DEFAULT_LOCALE,
  };
}

/** Reads `state/messages.json` under `hermitDir` and resolves against `language`
 *  (config.language). Never throws: any read problem means English. */
export function loadMessages(hermitDir: string | null | undefined, language: unknown): Messages {
  return buildMessages(hermitDir ? readMessagesFile(hermitDir) : null, language);
}

export const EN_MESSAGES: Messages = buildMessages(null, null);

/** Long friendly date for the mint success line, in the messages' locale. Invalid
 *  input → the "about a year" fallback. */
export function friendlyDate(m: Messages, iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return m.t('mint_date_unknown');
  return d.toLocaleDateString(m.locale, { day: 'numeric', month: 'long', year: 'numeric' });
}
