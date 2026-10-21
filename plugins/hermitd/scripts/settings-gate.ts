// PreToolUse hook (matcher "Bash|Edit|Write"): raises Claude Code's native
// permission prompt for execution-adjacent hermit settings, channel enrollment,
// and direct config.json edits. Everyday settings apply without a prompt.
//
// A matching write prints one permissionDecision: "ask" line and exits 0;
// everything else prints nothing and exits 0. The dialog is delivered to the
// channel plugin's allowFrom DMs, or shown in the terminal pane. A No is the
// operator's answer: never retry or route around it, and never edit
// config.json directly. The authoritative list is this file.
//
// This is a policy guard over the command text, not a filesystem boundary: a
// write staged through `bash -c`, `eval`, or a script the hook cannot read is
// invisible here and stays classifier-watched (docs/security.md § Settings from
// chat). What the text does show is judged strictly: a target the shell would
// expand at run time is asked, because the hook cannot know what it names.

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getPath } from './settings-edit';
import { readConfigRaw } from './lib/config-read';
import { byArg } from './lib/settings/registry';
import { askPathRegex } from './lib/settings/protected-paths';
import { runHook } from './lib/hook-input';
import { isSecretPath } from './lib/config-audit';
import { isAllowedSender } from './lib/channel-auth';
import { conversationKey } from './lib/conversation-key';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { hermitDir, readTailLines, transcriptPath, turnPromptText } from './lib/cc-compat';

type Json = any;

/** settings-edit verbs that mutate config.json. */
const WRITE_VERBS = new Set(['set', 'unset', 'toggle', 'apply-known']);

/** Write verbs that take a value after the target; see settings-edit.ts's dispatch. */
const TAKES_VALUE = new Set(['set', 'apply-known']);

/** Static protected subtrees. Parent replacements compare only this content. */
const ASK_PATH = askPathRegex();

/** Only these unprotected parents can replace protected content. */
const ASK_CONTAINER = /^(voice|channels|telemetry_export|artifacts|docker)$|^channels\.[^.]+$/;

/** One channel entry, whose existence is itself enrollment. */
const CHANNEL_ENTRY = /^channels\.[^.]+$/;

function protectedChanges(before: Json, after: Json, dotted: string): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (ASK_PATH.test(dotted)) return [dotted];
  if (!ASK_CONTAINER.test(dotted)) return [];
  // A new channel entry enrolls a channel whatever keys it carries: absent
  // `enabled` means enabled and absent `allowed_users` means accept-all, so a
  // bare `{}` names no protected key and would otherwise apply silently.
  // Dropping an entry is de-escalation and keeps naming what it removes.
  if (before == null && after != null && CHANNEL_ENTRY.test(dotted)) return [dotted];
  const keys = new Set([
    ...Object.keys(before && typeof before === 'object' ? before : {}),
    ...Object.keys(after && typeof after === 'object' ? after : {}),
  ]);
  return [...keys].flatMap(key => protectedChanges(before?.[key], after?.[key], `${dotted}.${key}`));
}

/** An uncertain parent write must not silently discard protected content. */
function containerChanges(file: string, cwd: string, dotted: string, verb: string, token: string): string[] {
  const raw = stripQuotes(token);
  // An unquoted `{…,…}` is brace-expanded before settings-edit sees it, so the
  // value it writes is not the JSON this text shows: opaque, like a `$`.
  const braceExpands = !/^['"]/.test(token) && /\{[^{}]*,/.test(raw);
  if (/[$`~\\*?\[\]{}]/.test(file) || /[$`\\]/.test(raw) || braceExpands) return [dotted];
  try {
    let config: Json = {};
    try {
      const text = fs.readFileSync(path.resolve(cwd, file), 'utf8');
      config = text.trim() ? JSON.parse(text) : {};
    } catch (err: any) {
      if (err.code !== 'ENOENT') return [dotted];
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return [dotted];
    let after: Json;
    if (verb === 'set') {
      if (raw === '') return [dotted];
      after = raw === 'none' || raw === 'clear' ? null : JSON.parse(raw);
      if (after !== null && (typeof after !== 'object' || Array.isArray(after))) return [dotted];
    } else if (verb !== 'unset') {
      return [dotted];
    }
    return protectedChanges(getPath(config, dotted), after, dotted);
  } catch {
    return [dotted];
  }
}

/**
 * The container spellings judged by value: the whole array, and one indexed entry.
 * `setPath` splits on `.` and indexes arrays, so `set routines.0 '<object>'`
 * replaces a whole routine, precheck included, without ever naming the field, which
 * a leaf-only rule would wave through without a prompt.
 */
const ROUTINES_CONTAINER = /^routines(\.\d+)?$/;

/**
 * Does this `set routines[.<n>] <json>` add or change any `precheck`?
 *
 * The add/edit flow in hermit-settings writes the entire array back, so a
 * field-level rule alone would be bypassed by every legitimate-looking array
 * write. Compared by id: a reordered array with the same gates is not a change.
 * Unparseable input counts as changed: an opaque write must not skip the ask
 * a legible one would raise.
 */
export function precheckSetChanged(value: string, current: Json[]): boolean {
  const gateOf = (r: Json) => (r && r.precheck != null ? `${String(r.precheck)}\u0000${r.precheck_timeout_s ?? ''}` : null);
  const before = new Map<string, string | null>();
  for (const r of Array.isArray(current) ? current : []) {
    if (r && r.id) before.set(String(r.id), gateOf(r));
  }
  const next = parseRoutineWrite(value);
  if (!next) return true;
  for (const r of next) {
    const gate = gateOf(r);
    if (gate === null) continue; // dropping a gate is a de-escalation, not an arming
    if (!r || !r.id || before.get(String(r.id)) !== gate) return true;
  }
  return false;
}

/**
 * A routines container value as an array of routine objects, or null when it is
 * not one. A lone routine object (the `routines.<n>` spelling) is judged as an
 * array of one. It has to carry an `id` to be read that way: anything else is not
 * a routine write the value rules can reason about, so they take the strict answer.
 */
function parseRoutineWrite(value: string): Json[] | null {
  let parsed: Json;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === 'object' && parsed.id) ? [parsed]
    : null;
}

/** `routines.<n>.chat`: a direct write of one routine's owning chat. */
const ROUTINE_CHAT_LEAF = /^routines\.(\d+)\.chat$/;

/**
 * Does this write point any routine at a chat other than the one asking?
 *
 * Silent only when each added or changed `chat` equals `turn`, the conversation
 * the current turn arrived from, and its routine is new. A member may have a
 * routine post back into the chat they are in, but never pull an existing
 * routine (the operator's own brief, another chat's digest) into it. Removing a
 * binding sends output home, which exposes nothing, so it stays silent.
 */
export function chatBindingChanged(next: Json[], current: Json[], turn: () => string | null): boolean {
  const before = new Map<string, Json>();
  for (const r of Array.isArray(current) ? current : []) {
    if (r && r.id) before.set(String(r.id), r.chat ?? null);
  }
  for (const r of next) {
    const chat = r?.chat ?? null;
    if (chat === null) continue;
    const prior = r?.id ? before.get(String(r.id)) : undefined;
    if (prior === chat) continue;
    if (prior !== undefined) return true;
    const asking = turn();
    if (asking === null || chat !== asking) return true;
  }
  return false;
}

const TURN_TAIL_BYTES = 512 * 1024;

/**
 * The conversation key (`<sourceKey>:<chat_id>`) of the allowed channel message
 * that opened the current turn, or null for a terminal, Claude app, routine or
 * heartbeat turn. Fail-closed: anything unreadable is null, and null asks.
 */
function turnConversation(payload: Json): string | null {
  try {
    const tPath = transcriptPath(payload);
    if (!tPath) return null;
    const { lines } = readTailLines(tPath, TURN_TAIL_BYTES);
    const prompt = turnPromptText(lines, lines.length);
    if (!prompt.boundaryFound) return null;
    const config = readConfigRaw(hermitDir());
    const env = parseChannelEnvelope(prompt.text, config);
    if (!env || !isAllowedSender(config, env.source, env.userId)) return null;
    return conversationKey(env.sourceKey, env.chatId, env.thread);
  } catch {
    return null;
  }
}

/** `routines`, or one routine and any of its fields: `routines.<n>[.<field>]`. */
const ROUTINE_PATH = /^routines(?:\.(\d+)(?:\..+)?)?$/;

/** Is `key` the home or maintainer chat of its channel, where the operator talks? */
function operatorChat(key: string): boolean {
  const at = key.indexOf(':');
  const ch = readConfigRaw(hermitDir())?.channels?.[key.slice(0, at)];
  const chatId = key.slice(at + 1);
  return [ch?.default_chat_id, ch?.maintainer_channel_id]
    .some(id => id != null && String(id) === chatId);
}

/**
 * From a channel turn, does this write reach a routine the asking chat does not
 * own? A chat changes only the routines bound to it. Routines with no `chat` are
 * the operator's and change silently only from the home or maintainer chat; so
 * does a whole-array write, which can touch any routine. Appending at the first
 * free index reaches no existing routine. A turn with no channel message is the
 * operator's own write and adds no ask.
 */
function routineScopeAsks(dotted: string, turn: () => string | null): boolean {
  const m = ROUTINE_PATH.exec(dotted);
  if (!m) return false;
  const asking = turn();
  if (asking === null) return false;
  if (m[1] === undefined) return !operatorChat(asking);
  const routine = currentRoutines()[Number(m[1])];
  if (!routine) return false;
  const owner = routine.chat ?? null;
  return owner === null ? !operatorChat(asking) : owner !== asking;
}

/** A routines container write that arms a precheck or binds a chat. Reads the baseline once. */
function routinesWriteAsks(value: string, turn: () => string | null): boolean {
  const current = currentRoutines();
  return precheckSetChanged(value, current)
    || chatBindingChanged(parseRoutineWrite(value) ?? [], current, turn);
}

/** `set routines.<n>.chat <value>`, judged against that routine as it stands on disk. */
function chatLeafChanged(dotted: string, value: string, turn: () => string | null): boolean {
  if (value === 'none' || value === 'clear') return false;
  const routine = currentRoutines()[Number(ROUTINE_CHAT_LEAF.exec(dotted)![1])];
  if (!routine) return true;
  let chat: Json;
  try {
    chat = JSON.parse(value);
  } catch {
    chat = value;
  }
  return chatBindingChanged([{ ...routine, chat }], [routine], turn);
}

/**
 * `apply-known`'s registry arg name resolved to its dotted config path; every
 * other verb's target is already dotted and passes through so ASK_PATH matches.
 */
function resolveTarget(verb: string, target: string): string {
  return verb === 'apply-known' ? (byArg(target)?.path ?? target) : target;
}

/** The hermit-dir files a shell write must raise the native prompt for. */
export const PROTECTED_FILES = ['config.json', 'claude-settings.json', 'resident-prompt.md', 'helper-prompt.md', 'state/helper-system-prompt.md', 'state/resident-system-prompt.md'];
// A nested file's directory is optional so `$STATE/<basename>` matches the way
// `$DIR/config.json` does: the hook cannot tell which directory a variable names.
const PROTECTED_FILE_ALT = PROTECTED_FILES
  .map((n) => n.replace(/\./g, String.raw`\.`).replace(/^(.+\/)/, '(?:$1)?'))
  .join('|');

function targetsConfigFile(p: string): string | undefined {
  const normalized = p.replace(/\\/g, '/');
  return PROTECTED_FILES.find((name) => normalized.endsWith(`.hermit/${name}`));
}

/**
 * The routines array as it stands on disk, for the value-aware precheck rule.
 * An unreadable config yields an empty baseline, which makes every declared gate
 * in the incoming write look new: the strict direction.
 */
function currentRoutines(): Json[] {
  let config: Json = null;
  try {
    config = readConfigRaw(hermitDir());
  } catch {
    config = null;
  }
  const routines = config?.routines;
  return Array.isArray(routines) ? routines : [];
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Display stand-in for a credential value: what it became, never what it was.
 * The same two words as the audit ledger's marker (`presence` in
 * lib/config-audit.ts, keyed on the on-disk null) so a settings-history line and
 * a permission prompt read alike; `none` and `clear` are settings-edit's
 * spellings for a null write.
 */
function presenceOf(value: string): string {
  const v = stripQuotes(value);
  return v === '' || v === 'none' || v === 'clear' ? '[cleared]' : '[set]';
}

/**
 * A bare integer is not a credential, and the env knobs this plugin ships and
 * documents (`MAX_THINKING_TOKENS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) are all
 * integers. Withholding those would cost the operator the only thing the ask is
 * for (`=[set]` reads identically for `20000` and `200`) and buy nothing, since
 * the redaction exists to keep secrets out of the chat, not numbers.
 */
const BARE_INTEGER = /^\d+$/;

/**
 * What the operator is shown for one write, with any value config-audit refuses
 * to log withheld.
 *
 * A container write (`set env '{"A":"x"}'`) is expanded to one marker per key it
 * sets: redacting it whole yields a bare `env=[set]`, which names no key at all.
 */
function displayFor(dotted: string, value: string): string {
  if (!isSecretPath(dotted)) return `${dotted}=${value}`;
  const bare = stripQuotes(value);
  if (BARE_INTEGER.test(bare)) return `${dotted}=${bare}`;
  let parsed: Json;
  try {
    parsed = JSON.parse(bare);
  } catch {
    return `${dotted}=${presenceOf(value)}`;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `${dotted}=${presenceOf(value)}`;
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) return `${dotted}=[cleared]`;
  return keys.map((k) => `${dotted}.${k}=${presenceOf(String(parsed[k] ?? ''))}`).join(', ');
}

function ask(reason: string): void {
  fs.writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }) + '\n');
}

function deny(reason: string): void {
  fs.writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n');
}

/**
 * A shell write that lands on config.json without going through settings-edit:
 * a redirect, `cp`/`mv` with it as the destination (the last argument), `tee`
 * onto it, or `sed -i` over it. The path is matched by its
 * `.hermit/config.json` tail, or by a `$`-expanded prefix ending in
 * `config.json`, since the hook cannot resolve the variable.
 */
const CONFIG_FILE_PATH = String.raw`(?:\S*\.hermit\/|\$\S*\/)(?:${PROTECTED_FILE_ALT})["']?`;
const CONFIG_FILE_WRITE = new RegExp(
  String.raw`>\s*["']?${CONFIG_FILE_PATH}`
  + String.raw`|\b(?:cp|mv)\s[^|;&\n]*?\s["']?${CONFIG_FILE_PATH}(?=\s*(?:[|;&]|$))`
  + String.raw`|\b(?:tee|sed\s+(?:-\S+\s+)*-i\S*)\s[^|;&\n]*?["']?${CONFIG_FILE_PATH}`,
  'm',
);

/** A token the shell would still expand: the hook cannot know what it names. */
const SHELL_EXPANDS = /[$`]/;

/** Label recognized channel writes; shell expansions remain opaque. */
function channelAccessAsks(command: string): string[] {
  const at = command.search(/channel-access(?:\.ts)?\b/);
  if (at < 0) return [];
  const tail = command.slice(at);
  // Single-quoted text is literal, so a nickname regex's `$` anchor stays readable.
  if (SHELL_EXPANDS.test(tail.replace(/'[^']*'/g, ''))) return ['channel-access'];
  // Separate shell commands before stripping quotes: nickname regexes can contain pipes.
  const commands = tail.match(/(?:'[^']*'|"[^"]*"|\\[\s\S]|[^;&|\n])+/g) ?? [];
  return commands.flatMap(command => {
    const rest = command.replace(/['"\\]/g, '');
    return [...rest.matchAll(/(?:^|\s)(pair|policy|group-add)\s+(\S+)\s+(\S+)(.*)/g)].map(m => {
      const [, verb, channel, value, flags] = m;
      if (verb === 'pair') return `pair ${channel} code ${value}`;
      if (verb === 'policy') return `policy ${channel} ${value}`;
      const option = (name: string) => flags.match(new RegExp(`(?:^|\\s)--${name}\\s+(\\S+)`))?.[1] ?? '?';
      const allow = option('allow');
      return `listen in ${channel} chat ${value}: mention=${option('mention')} allow=${allow === 'none' ? 'anyone' : allow === '?' ? '?' : `${allow.split(',').length} ids`} shared=${option('shared')} passive=${option('passive')}`
        + (/--nicknames(?:\s|$)/.test(flags) ? ' + nickname triggers (channel-wide)' : '')
        + (/--ack-off(?:\s|$)/.test(flags) ? ' + seen-emoji off (channel-wide)' : '');
    });
  });
}

/**
 * Does this Bash command mutate an asked hermit setting?
 *
 * Matches both invocation forms, the script path
 * (`bun .../scripts/settings-edit.ts <file> set permission_mode auto`) and the
 * resolver (`.hermit/bin/hermitd-run settings-edit <file> set ...`),
 * plus direct shell writes onto config.json. Returns null when the command
 * isn't a settings mutation at all, or when every write is off the ask list.
 *
 * EVERY settings-edit invocation in the command is judged, not just the first:
 * one Bash call can chain several (`... set model haiku && ... set
 * permission_mode bypassPermissions`), and a leading safe write must not
 * launder a protected one behind it.
 */
function protectedMutation(command: string, cwd: string, turn: () => string | null = () => null): string[] | null {
  const listen = channelAccessAsks(command);

  // An opaque write of the whole file can replace any asked path, so it
  // raises the native prompt regardless of what it happens to contain.
  const fileWrite = CONFIG_FILE_WRITE.exec(command);
  if (fileWrite) {
    // The file being WRITTEN is the last path in the match — `cp <src> <dest>`
    // and `tee`/`sed -i <file>` both put it at the end, and the redirect
    // alternative starts at `>` so it holds only one. Taking the first would
    // name the source of `cp .../config.json .../claude-settings.json` in the prompt.
    const names = fileWrite[0].match(new RegExp(PROTECTED_FILE_ALT, 'g'));
    return [...listen, names ? names[names.length - 1] : 'config.json'];
  }

  // The script path and the config path may each be quoted (a plugin root or
  // project under a directory with a space), so both accept a quoted token
  // before the bare-word form. The value alternation does the same: a routines
  // write carries a JSON array, which has spaces in it, and a bare `\S+` would
  // capture only up to the first one. That truncation is not merely cosmetic
  // for the prompt label: precheckSetChanged() would then parse a fragment, fail,
  // and raise a prompt for every routine add. A single-quoted value may splice
  // apostrophes as `'\''`, so the label keeps the text after one.
  const matches = [...command.matchAll(
    /(?:settings-edit(?:\.ts)?)["']?\s+('[^']*'|"[^"]*"|\S+)\s+([a-z-]+)(?:\s+(\S+))?(?:\s+('(?:[^']|'\\'')*'|"[^"]*"|\S+))?/g
  )];
  if (matches.length === 0) return listen.length ? listen : null;

  const shown: string[] = [...listen];
  for (const m of matches) {
    const verb = m[2];
    if (!WRITE_VERBS.has(verb)) continue;
    const t = stripQuotes(m[3] ?? '');
    // `unset` and `toggle` take a path and nothing else, so the token after
    // theirs belongs to the shell (a `&&`, a redirect), not to the setting.
    const token = TAKES_VALUE.has(verb) ? (m[4] ?? '') : '';
    const value = stripQuotes(token);
    if (SHELL_EXPANDS.test(t)) {
      if (!shown.includes(t)) shown.push(t);
      continue;
    }
    const dotted = resolveTarget(verb, t);
    if (!ASK_PATH.test(dotted) && ASK_CONTAINER.test(dotted)) {
      // A preceding shell command can change cwd or the comparison baseline.
      // Keep such parent writes opaque rather than interpreting shell programs.
      const changed = command.slice(0, m.index).match(/[;&|\n]/)
        ? [dotted]
        : containerChanges(stripQuotes(m[1]), cwd, dotted, verb, token);
      for (const field of changed) if (!shown.includes(field)) shown.push(field);
      continue;
    }
    const needsAsk = ASK_PATH.test(dotted)
      || (ROUTINES_CONTAINER.test(dotted) && value !== ''
        && routinesWriteAsks(value, turn))
      || (verb === 'set' && ROUTINE_CHAT_LEAF.test(dotted) && chatLeafChanged(dotted, value, turn))
      || routineScopeAsks(dotted, turn);
    if (!needsAsk) continue;
    const label = value ? displayFor(dotted, value) : dotted;
    if (!shown.includes(label)) shown.push(label);
  }
  if (shown.length === 0) return null;
  return shown.sort();
}

function main(payload: any): void {
  const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
  if (tool !== 'Bash' && tool !== 'Edit' && tool !== 'Write') return; // defensive

  // Pure string matching first, no I/O: this hook fires on every Bash, Edit
  // and Write, and almost none of them are settings mutations.
  const input = payload?.tool_input ?? {};
  let asked: string[] | null = null;

  if (tool === 'Bash') {
    if (payload.permission_mode === 'bypassPermissions'
      && channelAccessAsks(typeof input.command === 'string' ? input.command : '').length > 0) {
      deny('Channel pairing and group enrolment are refused in bypass mode; run /hermitd:channel-setup from a normal session.');
      return;
    }
    // Read lazily: only a routines write needs the transcript.
    let turn: string | null | undefined;
    asked = protectedMutation(typeof input.command === 'string' ? input.command : '',
      typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
      () => (turn === undefined ? (turn = turnConversation(payload)) : turn));
  } else {
    const fp = typeof input.file_path === 'string' ? input.file_path : '';
    const match = targetsConfigFile(fp);
    asked = match ? [match] : null;
  }

  if (!asked) return;
  ask(`Hermit setting: ${asked.join(', ')}`);
}

if (import.meta.main) runHook(main, () => {
  ask('Hermit setting: tool call too large to inspect');
});
