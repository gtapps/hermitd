// Pending harness-command marker — written by the UserPromptSubmit hook
// (lib/prompt-stages/harness-command.ts), consumed by the Stop hook (stop-pipeline.ts).
//
// Singleton by design, matching the existing marker files in state/. Two commands
// arriving inside one turn therefore collapse to the last one; that is accepted rather
// than queued, because an operator sending two harness commands back to back almost
// always means the second one.

import fs from 'node:fs';
import path from 'node:path';
import { PERMISSION_MODE } from './settings/enums';

type PermissionMode = (typeof PERMISSION_MODE)[number];

// Args are NOT validated against a fixed value list: Claude Code rejects an unknown
// model or effort level itself, and any list hard-coded here would go stale on the next
// model release (Fable already breaks the repo's VALID_ROUTINE_MODEL). What IS enforced
// is shape — no whitespace, no control characters, bounded length — because the arg is
// typed into a live pane and a newline would submit early, turning the remainder into
// its own prompt. Brackets are allowed: `opus[1m]` is a valid alias.
export const ARG_RE = /^[A-Za-z0-9._[\]-]{1,64}$/;

/** Commands taking no argument. */
const BARE_COMMANDS = new Set(['/compact', '/clear', '/doctor', '/checkup']);
// The exactly-two-token rule enforced below is load-bearing for /advisor specifically:
// a bare `/advisor` opens Claude Code's interactive advisor picker (a real blocking
// dialog, "Enter to confirm · Esc to cancel" — probe-verified, CC 2.1.240) that no one
// unattended could ever answer. Keeping it out of ARG_COMMANDS' bare form is what stops
// that picker from ever being deliverable; do not add a bare `/advisor` acceptance path.
/** Commands requiring exactly one argument. */
const ARG_COMMANDS = new Set(['/model', '/effort', '/permission-mode', '/advisor']);

export type ParsedCommand = { command: string; arg: string | null };

/**
 * Strict slash grammar, exact whole-body match.
 *
 * Deliberately does NOT accept a bare `compact`/`clear` — an operator decision: the
 * slash makes the intent explicit.
 *
 * Stays a pure harness parser that knows nothing about channels. A Telegram group's
 * `@botname` suffix is resolved upstream by prompt-stages/harness-command.ts via
 * channel-slash-address.ts, so `/clear@thebot` reaches here as plain `/clear` when it
 * names this bot, and never reaches here at all when it names another.
 */
export function parseHarnessCommand(body: string): ParsedCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('/')) return null;

  // A multi-line body is never one command: rejected before the split so that
  // splitting on whitespace below cannot fold an embedded `\n/clear` into an argument.
  if (/[\r\n]/.test(trimmed)) return null;

  // Split on any whitespace run, not a literal space: `/model  opus`, a tab-separated
  // form, and a mobile keyboard's non-breaking space must all reach the same grammar as
  // the single-spaced one. Splitting on ' ' left an empty (or whitespace-bearing) token
  // that failed the arg shape, so the whole command parsed as null — and a null here is
  // not a refusal, it is a fallthrough to the model.
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();

  if (BARE_COMMANDS.has(command)) {
    if (parts.length !== 1) return null;
    return { command: command === '/checkup' ? '/doctor' : command, arg: null };
  }
  if (ARG_COMMANDS.has(command)) {
    if (parts.length !== 2) return null;
    const arg = parts[1];
    return ARG_RE.test(arg) ? { command, arg } : null;
  }
  return null;
}

// --- Permission-mode targets ----------------------------------------------
//
// The one place a value list is unavoidable. Every other arg is shape-checked and handed
// to Claude Code, which rejects what it does not know — but there is no native command to
// hand a permission mode to. Claude Code exposes no absolute setter at all (confirmed
// against the permission-modes and keybindings docs): the only mid-session control is the
// relative Shift+Tab cycle, so the hermit has to know which modes exist, which of them it
// may steer the session into, and what each looks like once it lands.

const MODE_ALIASES: Record<string, PermissionMode> = {
  default: 'default',
  manual: 'default',
  acceptedits: 'acceptEdits',
  auto: 'auto',
  plan: 'plan',
  bypasspermissions: 'bypassPermissions',
  dontask: 'dontAsk',
};

/** Modes a trusted channel sender may steer the session into. */
export const CHANNEL_SETTABLE_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'auto']);

/**
 * Why the remaining modes are refused rather than delivered.
 *
 * `plan` is the interesting one: it is harness-enforced read-only, so the hermit could
 * still READ channel messages but every reply it tried to send would be refused — and the
 * harness pushes a plan-mode turn toward an ExitPlanMode approval dialog that nobody is at
 * the terminal to answer. Since delivery only ever happens on the Stop hook, a session
 * wedged mid-turn can never receive the channel command that would undo it. Tightening
 * that IS recoverable is what `default` is for.
 */
const MODE_REFUSALS: Partial<Record<PermissionMode, string>> = {
  plan: 'plan mode blocks the hermit from replying on this channel and can leave the session waiting at a plan-approval prompt nobody is there to answer, with no way to switch back from chat. Ask for `default` to make it check with you before acting, or just say what it should plan before executing.',
  bypassPermissions: 'switching into bypassPermissions from a chat message would widen what this session may do without asking, which is a decision for the terminal (and for containerised hermits, the boot config).',
  dontAsk: "dontAsk is not reachable mid-session — Claude Code never puts it in the mode cycle, so it can only be set when the session starts.",
};

/** Canonical mode name for an operator-typed argument, or null when unrecognised. */
export function normalizePermissionMode(arg: string): PermissionMode | null {
  return MODE_ALIASES[arg.toLowerCase().replaceAll('-', '').replaceAll('_', '')] ?? null;
}

/** Why this target cannot be delivered, or null when it is settable from a channel. */
export function permissionModeRefusal(arg: string): string | null {
  const mode = normalizePermissionMode(arg);
  if (!mode) {
    return `"${arg}" is not a permission mode. This session can be switched to default, acceptEdits, or auto.`;
  }
  if (CHANNEL_SETTABLE_MODES.has(mode)) return null;
  return MODE_REFUSALS[mode] ?? `${mode} cannot be set from a channel.`;
}

export type PendingCommand = {
  command: string;
  arg: string | null;
  by: string;
  requested_at: string;
};

/**
 * A marker older than this is dropped unconsumed. Mirrors COMPACT_MARKER_TTL_SECS in
 * hermitd-watchdog.ts: a request is a moment, not a standing order, and a hermit that was
 * wedged for an hour should not suddenly clear its context when it recovers.
 */
export const COMMAND_MARKER_TTL_SECS = 3600;

/**
 * The switch-verify marker records an already-delivered switch to OBSERVE, not a
 * command to retry — it does not go stale the way a pending command does, and it
 * self-clears the moment the switch is observed. Reusing the 1-hour delivery TTL
 * silently reproduced the original stale-answer bug whenever no prompt arrived
 * within the hour (idle overnight, heartbeat paused). A day covers any realistic
 * gap; the TTL only remains as a backstop against a marker that can never be
 * observed (e.g. no transcript_path on this harness) injecting its hold-warning
 * forever.
 */
export const SWITCH_VERIFY_TTL_SECS = 86_400;
export const SKILL_RELAY_TTL_SECS = 600;
function markerPath(hermitRoot: string): string {
  return path.join(hermitRoot, 'state', 'pending-harness-command.json');
}

/** Atomic tmp+rename write. Returns false on any failure — callers must not ack a failed write. */
function writeMarker(target: string, entry: unknown): boolean {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

export function writePendingCommand(hermitRoot: string, entry: PendingCommand): boolean {
  return writeMarker(markerPath(hermitRoot), entry);
}

/** Read the marker, or null when absent, malformed, or past its TTL. */
export function readPendingCommand(hermitRoot: string): PendingCommand | null {
  try {
    const raw = fs.readFileSync(markerPath(hermitRoot), 'utf-8');
    const parsed = JSON.parse(raw) as PendingCommand;
    if (!parsed || parsed.command !== '/permission-mode') return null;

    const ts = Date.parse(parsed.requested_at);
    if (Number.isNaN(ts)) return null;
    if ((Date.now() - ts) / 1000 > COMMAND_MARKER_TTL_SECS) return null;

    return parsed;
  } catch {
    return null;
  }
}

/** Delete the marker. Call ONLY after a confirmed send — a failed send must leave it. */
export function clearPendingCommand(hermitRoot: string): void {
  try { fs.unlinkSync(markerPath(hermitRoot)); } catch {}
}

/** Render a marker back to the literal text typed into the pane. */
export function renderCommand(entry: { command: string; arg: string | null }): string {
  return entry.arg ? `${entry.command} ${entry.arg}` : entry.command;
}

// --- Relayed skill delivery -----------------------------------------------

export type SkillRelay = {
  command: string;
  arg: string | null;
  by: string;
  reply_to: { source: string; chat_id: string };
  delivered_at: string;
};

function skillRelayPath(hermitRoot: string): string {
  return path.join(hermitRoot, 'state', 'pending-skill-relay.json');
}

/** Atomic tmp+rename write. Returns false on any failure. */
export function writeSkillRelay(hermitRoot: string, entry: SkillRelay): boolean {
  return writeMarker(skillRelayPath(hermitRoot), entry);
}

/** Read the delivered skill relay, or null when absent, malformed, or expired. */
export function readSkillRelay(hermitRoot: string): SkillRelay | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(skillRelayPath(hermitRoot), 'utf-8')) as SkillRelay;
    if (!parsed || typeof parsed.command !== 'string' || !parsed.reply_to) return null;

    const ts = Date.parse(parsed.delivered_at);
    if (Number.isNaN(ts)) return null;
    if ((Date.now() - ts) / 1000 > SKILL_RELAY_TTL_SECS) {
      clearSkillRelay(hermitRoot);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** Delete the relay once its matching pane turn has claimed it. */
export function clearSkillRelay(hermitRoot: string): void {
  try { fs.unlinkSync(skillRelayPath(hermitRoot)); } catch {}
}

// --- Post-delivery verification -------------------------------------------
//
// A delivered /model or /effort switch applies to the session, but the model's own
// sense of which model it runs is fixed at session start and does not follow the
// switch — live-verified on two hermits, where an Opus-served turn reported itself
// as Sonnet. Asked "did it work?", the session answered from that stale
// self-perception and reported a working switch as a silent failure.
//
// So the delivery leaves this marker behind and the prompt path answers the
// question from the transcript instead, which carries the serving model per
// assistant message. Separate from the pending marker on purpose: that one is
// consumed by the Stop hook to DO the switch, this one by the UserPromptSubmit
// path to OBSERVE it, and a delivery writes the second exactly when it clears the
// first.

export type SwitchVerifyMarker = {
  command: string;
  arg: string | null;
  by: string;
  delivered_at: string;
};

function switchVerifyPath(hermitRoot: string): string {
  return path.join(hermitRoot, 'state', 'harness-switch-verify.json');
}

/** Atomic tmp+rename write. Returns false on any failure. */
export function writeSwitchVerify(hermitRoot: string, entry: SwitchVerifyMarker): boolean {
  return writeMarker(switchVerifyPath(hermitRoot), entry);
}

/**
 * Read the marker, or null when absent, malformed, or past its TTL.
 *
 * Self-cleaning, unlike readPendingCommand: nothing else ever consumes this file, so
 * an expired one left on disk would sit there until the next switch overwrote it.
 */
export function readSwitchVerify(hermitRoot: string): SwitchVerifyMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(switchVerifyPath(hermitRoot), 'utf-8')) as SwitchVerifyMarker;
    if (!parsed || typeof parsed.command !== 'string') return null;

    const ts = Date.parse(parsed.delivered_at);
    if (Number.isNaN(ts)) return null;
    if ((Date.now() - ts) / 1000 > SWITCH_VERIFY_TTL_SECS) {
      clearSwitchVerify(hermitRoot);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** Delete the marker. Call once the switch has been observed in the transcript. */
export function clearSwitchVerify(hermitRoot: string): void {
  try { fs.unlinkSync(switchVerifyPath(hermitRoot)); } catch {}
}
