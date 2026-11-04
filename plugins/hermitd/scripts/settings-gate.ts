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
import { isAllowedSender, isPrimaryOperator, canCompleteAuthentication } from './lib/channel-auth';
import { conversationKey } from './lib/conversation-key';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { hermitDir, readTailLines, transcriptPath, turnPromptText } from './lib/cc-compat';
import { resolveProjectScript } from './lib/routines/gate';

type Json = any;

/** settings-edit verbs that mutate config.json. */
const WRITE_VERBS = new Set(['set', 'append', 'unset', 'toggle', 'apply-known', 'migrate']);

/** Write verbs that take a value after the target; see settings-edit.ts's dispatch. */
const TAKES_VALUE = new Set(['set', 'append', 'apply-known']);

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

type RoutineOrigin = { kind: 'terminal'; proven: boolean } | { kind: 'unknown' }
  | { kind: 'channel'; key: string; primary: boolean; canCompleteAuthentication: boolean; proven: boolean };

/**
 * A terminal requires a readable turn boundary without a channel envelope, which a wake also has; all unproven origins ask.
 * `proven` says the reading holds for the whole turn: a person typed a terminal turn, and no wake or other sender joined either kind.
 */
export function turnConversation(payload: Json): RoutineOrigin {
  try {
    const tPath = transcriptPath(payload);
    if (!tPath) return { kind: 'unknown' };
    const { lines } = readTailLines(tPath, TURN_TAIL_BYTES);
    const prompt = turnPromptText(lines, lines.length);
    if (!prompt.boundaryFound) return { kind: 'unknown' };
    const config = readConfigRaw(hermitDir());
    const env = parseChannelEnvelope(prompt.text, config);
    if (!env) return { kind: 'terminal', proven: prompt.typed && !prompt.joined };
    if (!isAllowedSender(config, env.source, env.userId)) return { kind: 'unknown' };
    return { kind: 'channel', key: conversationKey(env.sourceKey, env.chatId, env.thread),
      primary: isPrimaryOperator(config, env.source, env.userId, env.chatId),
      canCompleteAuthentication: canCompleteAuthentication(config, env.source, env.userId, env.chatId),
      proven: !prompt.joined };
  } catch {
    return { kind: 'unknown' };
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
 * free index reaches no existing routine. Only a proven terminal adds no origin ask; unknown and non-primary senders ask.
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

/** `proposal.ts routine`, which upserts one routine by id from a heredoc entry. */
const PROPOSAL_ROUTINE = /proposal(?:\.ts)?["']?\s+routine\b/g;
const HEREDOC_BODY = /^[^\n]*<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)/;

/**
 * An accepted routine proposal is a routine write like any other, so it gets the
 * same origin, precheck, binding and scope rules at the index it lands on. An
 * entry the hook cannot read asks, as an opaque write does.
 */
function proposalRoutineAsks(rest: string, turn: () => string | null, originAsks: () => boolean): string | null {
  const body = HEREDOC_BODY.exec(rest)?.[3];
  const entry = body === undefined ? null : parseRoutineWrite(body);
  if (!entry || entry.length !== 1) return 'routines';
  const current = currentRoutines();
  const index = current.findIndex(r => r && r.id === entry[0].id);
  const dotted = `routines.${index >= 0 ? index : current.length}`;
  return originAsks() || precheckSetChanged(body!, current)
    || chatBindingChanged(entry, current, turn) || routineScopeAsks(dotted, turn) ? dotted : null;
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
  if (verb === 'migrate' && target === 'browser-default-on') return 'browser';
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

type ConfigScript = { path: string; setting: string; display: string };

function configScripts(): ConfigScript[] {
  const dir = hermitDir();
  const config = readConfigRaw(dir);
  if (!config) return [];
  let root: string;
  try { root = fs.realpathSync(path.dirname(dir)); } catch { return []; }
  const scripts: ConfigScript[] = [];
  const addScript = (value: unknown, setting: string) => {
    const resolved = resolveProjectScript(value, root);
    // A missing or non-executable configured path still runs once it is written and made executable.
    const real = resolved.kind === 'script' ? resolved.abs
      : resolved.detail === 'not-executable' ? resolvedTarget(String(value).trim(), root) : null;
    if (real?.startsWith(root + path.sep)) scripts.push({ path: real, setting, display: String(value).trim() });
  };
  if (Array.isArray(config.routines)) {
    config.routines.forEach((routine: Json, index: number) => addScript(routine?.precheck, `routines[${index}].precheck`));
  }
  if (config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)) {
    for (const [name, channel] of Object.entries(config.channels) as [string, Json][]) {
      addScript(channel?.send_script, `channels.${name}.send_script`);
    }
  }
  if (Array.isArray(config.monitors)) {
    config.monitors.forEach((monitor: Json, index: number) => {
      if (typeof monitor?.command !== 'string') return;
      for (const word of monitor.command.split(/\s+/)) {
        if (!word) continue;
        const expanded = stripQuotes(word).replaceAll('${CLAUDE_PROJECT_DIR}', root)
          .replaceAll('${CLAUDE_PLUGIN_ROOT}', process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(import.meta.dir, '..'));
        try {
          const real = fs.realpathSync(path.resolve(root, expanded));
          if (real.startsWith(root + path.sep) && fs.statSync(real).isFile()) {
            scripts.push({ path: real, setting: `monitors[${index}].command`, display: word });
          }
        } catch { /* Not an existing project file. */ }
      }
    });
  }
  return scripts;
}

function resolvedTarget(target: string, cwd: string): string {
  const absolute = path.resolve(cwd, target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    try { return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute)); }
    catch { return absolute; }
  }
}

function scriptWriteLabel(target: string, cwd: string, scripts: ConfigScript[]): string | undefined {
  const real = resolvedTarget(target, cwd);
  const script = scripts.find(entry => entry.path === real);
  return script && `script run by ${script.setting} (${script.display})`;
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

function watchShape(entry: Json): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)
    || typeof entry.command !== 'string') return false;
  const command = /^\.hermit\/bin\/hermitd-run watch-poll ([a-z0-9][a-z0-9-]*)(?: --every \S+)?(?: --timeout \S+)? -- (\S[\s\S]*)$/.exec(entry.command);
  return command !== null && command[1] === entry.id;
}

const WATCH_EDIT_PREFIX = /^(?:\.hermit\/bin\/hermitd-run settings-edit|bun (?:\/[^\s'"]+|[^\s'"]+)\/scripts\/settings-edit\.ts) \.hermit\/config\.json /;

/** Only literal, isolated settings-edit invocations are eligible for a silent watch write. */
function silentWatchWrite(
  command: string, verb: string, dotted: string, token: string,
  mode: string, turnOrigin: () => RoutineOrigin,
): boolean {
  if (mode !== 'auto') return false;
  const match = WATCH_EDIT_PREFIX.exec(command);
  if (!match) return false;
  const origin = turnOrigin();
  if (origin.kind === 'unknown' || !origin.proven) return false;
  const tail = command.slice(match[0].length);
  const config = readConfigRaw(hermitDir());
  if (!config || (config.monitors !== undefined && !Array.isArray(config.monitors))) return false;
  const monitors: Json[] = config.monitors ?? [];
  const isPrimary = origin.kind === 'terminal' || origin.primary;
  // Saved watches store their chat without a thread, so a turn in one of its threads is that chat.
  const inChat = (chat: unknown) => origin.kind === 'channel' && typeof chat === 'string'
    && (chat === origin.key || (!chat.includes('~') && origin.key.startsWith(`${chat}~`)));
  const owning = (entry: Json) => entry.chat == null
    ? origin.kind === 'terminal' || operatorChat(origin.key)
    : inChat(entry.chat);

  if (verb === 'append' && dotted === 'monitors') {
    if (!/^'[^']*'$/.test(token) || tail !== `append monitors ${token}`) return false;
    let entry: Json;
    try { entry = JSON.parse(token.slice(1, -1)); } catch { return false; }
    if (!watchShape(entry) || typeof entry.description !== 'string'
      || (entry.chat !== undefined && typeof entry.chat !== 'string')
      || monitors.some(item => item?.id === entry.id)) return false;
    if (entry.enabled === false) return inChat(entry.chat);
    return entry.enabled === true && isPrimary && owning(entry);
  }
  const indexed = /^monitors\.(0|[1-9]\d*)(?:\.enabled)?$/.exec(dotted);
  if (!indexed) return false;
  const entry = monitors[Number(indexed[1])];
  if (!entry || !owning(entry)) return false;
  if (verb === 'unset' && dotted === `monitors.${indexed[1]}`) return tail === `unset ${dotted}`;
  if (verb !== 'set' || dotted !== `monitors.${indexed[1]}.enabled`) return false;
  if (tail === `set ${dotted} false`) return true;
  return tail === `set ${dotted} true` && isPrimary && watchShape(entry);
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

/** Command substitution, which still runs inside double quotes and unquoted-tag heredocs. */
const COMMAND_SUBSTITUTION = /\$\(|`/;
/** Text that re-runs quoted or heredoc text as code: a shell, an interpreter, or a command runner. */
const RUNS_SHELL_TEXT = /\b(?:(?:ba|z|da|k|c|tc|a|mk|ya|pw)?sh|fish|eval|source|[gnm]?awk|perl|python[\d.]*|ruby|php|node|deno|tmux|screen|watch|ssh|su|script|parallel)\b|\bbun\s+(?:-\S+\s+)*(?:-e|--eval|-p|--print)\b|(?:^|[;&|]\s*)\.\s/m;

/**
 * The command with literal text blanked so CONFIG_FILE_WRITE sees only real
 * redirects: `>` inside single quotes, `>` inside double quotes with no command
 * substitution, and heredoc bodies (an unquoted tag keeps a body that substitutes).
 * One left-to-right pass, so a quoted `<<` opens no heredoc and a heredoc body
 * pairs no quotes. A comment pairs no quotes either. An unterminated heredoc, a
 * heredoc tag the scan cannot read exactly, or text a shell would run, keeps the
 * raw command.
 */
function literalShellText(command: string, conservative = true): string {
  let out = '';
  let i = 0;
  let escaped = -1;
  const pending: { tag: string; tabs: boolean; quoted: boolean }[] = [];
  while (i < command.length) {
    const ch = command[i];
    if (ch === '\\') { out += command.slice(i, i + 2); escaped = i + 1; i += 2; continue; }
    if (ch === '#' && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) {
      const eol = command.indexOf('\n', i);
      const end = eol < 0 ? command.length : eol;
      out += command.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let end = i + 1;
      if (ch === "'" && command[i - 1] === '$' && escaped !== i - 1) {
        // ANSI-C quoting: a backslash escapes the next character, `\'` included.
        while (end < command.length && command[end] !== "'") end += command[end] === '\\' ? 2 : 1;
        if (end >= command.length) end = -1;
      } else if (ch === "'") end = command.indexOf("'", end);
      else {
        while (end < command.length && command[end] !== '"') end += command[end] === '\\' ? 2 : 1;
        if (end >= command.length) end = -1;
      }
      if (end < 0) return command;
      const span = command.slice(i, end + 1);
      out += ch === "'" || !COMMAND_SUBSTITUTION.test(span) ? span.replaceAll('>', ' ') : span;
      i = end + 1;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<' && command[i - 1] !== '<' && command[i + 2] !== '<') {
      // The tag must end where the shell's delimiter word ends (`<<EOF-1`, `<<E"OF"` do not).
      const heredoc = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2(?![^\s;&|<>()])/.exec(command.slice(i));
      if (!heredoc) return command;
      pending.push({ tag: heredoc[3], tabs: heredoc[1] === '-', quoted: heredoc[2] !== '' });
      out += heredoc[0];
      i += heredoc[0].length;
      continue;
    }
    out += ch;
    i++;
    if (ch !== '\n') continue;
    for (const { tag, tabs, quoted } of pending.splice(0)) {
      const close = new RegExp(`^${tabs ? String.raw`\t*` : ''}${tag}$`, 'm').exec(command.slice(i));
      if (!close) return command;
      const body = command.slice(i, i + close.index);
      out += (quoted || !COMMAND_SUBSTITUTION.test(body) ? body.replace(/[^\n]/g, ' ') : body) + close[0];
      i += close.index + close[0].length;
    }
  }
  return conservative && RUNS_SHELL_TEXT.test(out) ? command : out;
}

function shellWriteTargets(command: string): string[] {
  if (!/>|\b(?:cp|mv|tee|sed)\s/.test(command)) return [];
  const targets: string[] = [];
  const text = literalShellText(command, false);
  const writes = />\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)|\b(cp|mv|tee|sed)\s+([^|;&<>\n]*)/g;
  for (const match of text.matchAll(writes)) {
    if (match[1]) {
      targets.push(stripQuotes(match[1]));
      continue;
    }
    const words = (match[3].match(/(?:[^\s"'\\]+|\\.|"[^"]*"|'[^']*')+/g) ?? []).map(stripQuotes);
    if (match[2] === 'cp' || match[2] === 'mv') {
      if (words.length >= 2) targets.push(words[words.length - 1]);
    } else if (match[2] === 'tee') {
      targets.push(...words.filter(word => !word.startsWith('-')));
    } else if (words.some(word => /^-.*i/.test(word))) {
      targets.push(...words.filter(word => !word.startsWith('-')));
    }
  }
  return targets;
}

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
      if (verb === 'pair') return `pair ${channel} code ${value} (home chat if unset)`;
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
 * plus direct shell writes onto config.json and `proposal.ts routine` upserts. Returns null when the command
 * isn't a settings mutation at all, or when every write is off the ask list.
 *
 * EVERY settings-edit invocation in the command is judged, not just the first:
 * one Bash call can chain several (`... set model haiku && ... set
 * permission_mode bypassPermissions`), and a leading safe write must not
 * launder a protected one behind it.
 */
function protectedMutation(command: string, cwd: string, origin: () => RoutineOrigin, mode: string): string[] | null {
  const turn = () => { const value = origin(); return value.kind === 'channel' ? value.key : null; };
  const originAsks = () => {
    const value = origin();
    return value.kind === 'unknown' || (value.kind === 'channel' && !value.primary);
  };
  const listen = channelAccessAsks(command);

  // An opaque write of the whole file can replace any asked path, so it
  // raises the native prompt regardless of what it happens to contain.
  // Blanking only removes matches, so a command the raw scan clears needs no second pass.
  const fileWrite = CONFIG_FILE_WRITE.test(command) ? CONFIG_FILE_WRITE.exec(literalShellText(command)) : null;
  if (fileWrite) {
    // The file being WRITTEN is the last path in the match — `cp <src> <dest>`
    // and `tee`/`sed -i <file>` both put it at the end, and the redirect
    // alternative starts at `>` so it holds only one. Taking the first would
    // name the source of `cp .../config.json .../claude-settings.json` in the prompt.
    const names = fileWrite[0].match(new RegExp(PROTECTED_FILE_ALT, 'g'));
    return [...listen, names ? names[names.length - 1] : 'config.json'];
  }

  const shown: string[] = [...listen];
  const targets = shellWriteTargets(command);
  if (targets.length) {
    const scripts = configScripts();
    for (const target of targets) {
      const label = scriptWriteLabel(target, cwd, scripts);
      if (label && !shown.includes(label)) shown.push(label);
    }
  }

  // The script path and the config path may each be quoted (a plugin root or
  // project under a directory with a space), so both accept a quoted token
  // before the bare-word form. The value alternation does the same: a routines
  // write carries a JSON array, which has spaces in it, and a bare `\S+` would
  // capture only up to the first one. That truncation is not merely cosmetic
  // for the prompt label: precheckSetChanged() would then parse a fragment, fail,
  // and raise a prompt for every routine add. A single-quoted value may splice
  // apostrophes as `'\''`, so the label keeps the text after one.
  for (const m of command.matchAll(PROPOSAL_ROUTINE)) {
    const asked = proposalRoutineAsks(command.slice(m.index + m[0].length), turn, originAsks);
    if (asked && !shown.includes(asked)) shown.push(asked);
  }

  const matches = [...command.matchAll(
    /(?:settings-edit(?:\.ts)?)["']?\s+('[^']*'|"[^"]*"|\S+)\s+([a-z-]+)(?:\s+(\S+))?(?:\s+('(?:[^']|'\\'')*'|"[^"]*"|\S+))?/g
  )];
  if (matches.length === 0) return shown.length ? shown : null;

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
    if ((dotted === 'monitors' || dotted.startsWith('monitors.'))
      && silentWatchWrite(command, verb, dotted, token, mode, origin)) continue;
    if (!ASK_PATH.test(dotted) && ASK_CONTAINER.test(dotted)) {
      // A preceding shell command can change cwd or the comparison baseline.
      // Keep such parent writes opaque rather than interpreting shell programs.
      const changed = command.slice(0, m.index).match(/[;&|\n]/)
        ? [dotted]
        : containerChanges(stripQuotes(m[1]), cwd, dotted, verb, token);
      for (const field of changed) if (!shown.includes(field)) shown.push(field);
      continue;
    }
    const scopePath = verb === 'append' && dotted === 'routines'
      ? `routines.${currentRoutines().length}` : dotted;
    const needsAsk = (ROUTINE_PATH.test(dotted) && originAsks())
      || ASK_PATH.test(dotted)
      || (ROUTINES_CONTAINER.test(dotted) && value !== ''
        && routinesWriteAsks(value, turn))
      || (verb === 'set' && ROUTINE_CHAT_LEAF.test(dotted) && chatLeafChanged(dotted, value, turn))
      || routineScopeAsks(scopePath, turn);
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
    let turn: RoutineOrigin | undefined;
    asked = protectedMutation(typeof input.command === 'string' ? input.command : '',
      typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
      () => (turn === undefined ? (turn = turnConversation(payload)) : turn),
      payload.permission_mode);
  } else {
    const fp = typeof input.file_path === 'string' ? input.file_path : '';
    const match = targetsConfigFile(fp);
    const nativePermissions = /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/i.test(fp.replace(/\\/g, '/'));
    let turn: RoutineOrigin | undefined;
    const origin = () => (turn === undefined ? (turn = turnConversation(payload)) : turn);
    // Only a proven terminal turn is the operator; a wake, a joined sender or an unreadable turn is not.
    const notOperator = () => { const value = origin(); return !(value.kind === 'terminal' && value.proven); };
    if (payload.permission_mode === 'bypassPermissions'
      && (match === 'claude-settings.json' || nativePermissions) && notOperator()) {
      deny('Permission settings changes from chat are refused in bypass mode; use a normal session or edit from the terminal.');
      return;
    }
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    const script = fp && !match ? scriptWriteLabel(fp, cwd, configScripts()) : undefined;
    asked = match ? [match] : script ? [script] : null;
    if (nativePermissions && notOperator()) asked = [...(asked ?? []), 'native permissions'];
  }

  if (!asked) return;
  ask(`Hermit setting: ${asked.join(', ')}`);
}

if (import.meta.main) runHook(main, () => {
  ask('Hermit setting: tool call too large to inspect');
});
