import { BOOTSTRAP_PREFIX } from './lib/bootstrap-prompt';
process.stdout.on('error', () => {});

// UserPromptSubmit + SessionStart hook — records when an operator prompt is received.
// Writes state/last-operator-action.json so the watchdog can gate context clearing
// on genuine operator silence rather than state-file mtime (which routine writes reset).
// The pipeline opens state/operator-turn-open.json at hook exit for kept, non-blocked prompts;
// direct invocation and --force open it immediately. `routines.ts due` then defers monitor-mode
// routines only while a real operator turn is in flight; stop-pipeline.ts clears it at Stop
// The open-turn marker expires so routines cannot remain starved indefinitely.
//
// Invocation modes:
//   (stdin) UserPromptSubmit — JSON payload with `prompt`. Filter applied, write if kept.
//   (stdin) SessionStart     — no `prompt` field. Seeds file only if absent (cold start).
//                              Avoids unattended restarts masking a vanished operator.
//   --force                  — unconditional write, prints `OK`. Used by skills that know
//                              they're handling a genuine operator action (e.g.
//                              channel-responder after the allowlist check passes). The
//                              stdin modes are hooks and print nothing.
//
// Filtered prompts (not operator activity):
//   [hermit-routine:…   — cron-delivered routine prompts (hermit-routines/SKILL.md:43-54)
//   <channel…           — only when the sender fails the channel's `allowed_users` gate;
//                          recording those would let stranger/bot traffic suppress
//                          context clearing. An allowlisted sender IS operator activity and is
//                          recorded here (issue #835 — a channel-only conversation left
//                          the clock frozen, so /clear fired
//                          mid-exchange). This hook is the mechanical write site;
//                          channel-responder/SKILL.md 1d's --force is a fallback.
//   GUEST_REPORT:…      — a guest session in this folder reporting finished work over the
//                          inbox socket. Another local session is not the operator.
//   HEARTBEAT_EVALUATE/HEARTBEAT_ERROR/ROUTINE_DUE/ROUTINE_MONITOR_ERROR — Monitor-delivered
//                          scheduler wake notifications (heartbeat-monitor.sh, routines.ts due,
//                          routine-monitor.sh) — see isRoutinePrompt below
//   hermit's own slash commands: the core mod's in-flight request (see
//   isInflightCommand) and the boot skill (INJECTED_EXACT). Every other bare `/…`
//   prompt counts as operator activity (see isRoutinePrompt).

import fs from 'node:fs';
import path from 'node:path';
import { isGuest } from './lib/guest-marker';
import { hermitDir, sessionId } from './lib/cc-compat';
import { isAllowedSender, isPassiveChatSync, isSelfMentionedSync } from './lib/channel-auth';
import { parseChannelEnvelope, type ChannelEnvelope } from './lib/channel-envelope';
import { readConfigRaw } from './lib/config-read';
import { emit } from './lib/cli';
import { renderCommand } from './lib/harness-command';

type Json = any;

// What the channel allowlist gate needs, supplied by a caller that already has
// it. The pipeline hands over the envelope it parsed and the raw config it
// memoizes, so neither is computed twice per prompt; omitted (direct-script
// path) they are derived here, and only for a `<channel` prompt — the one
// shape whose verdict depends on them.
export interface ChannelGateInputs {
  envelope: ChannelEnvelope | null;
  config: Json;
}

const AGENT_DIR = hermitDir();
const STATE_PATH = path.join(AGENT_DIR, 'state', 'last-operator-action.json');
const TMP_PATH   = path.join(AGENT_DIR, 'state', '.last-operator-action.json.tmp');
const TURN_PATH  = path.join(AGENT_DIR, 'state', 'operator-turn-open.json');
const TURN_TMP   = path.join(AGENT_DIR, 'state', '.operator-turn-open.json.tmp');

function writeMarker(tmpPath: string, finalPath: string, atMs = Date.now()) {
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ at: new Date(atMs).toISOString() }) + '\n', 'utf-8');
    fs.renameSync(tmpPath, finalPath);
  } catch { /* fail-open */ }
}

export function seedOperatorActivity(): void {
  if (!fs.existsSync(STATE_PATH)) write();
}

function write() {
  writeMarker(TMP_PATH, STATE_PATH);
}

// Stop that closed an operator turn: the turn's end is operator activity too, so quiet
// clocks (context clearing, watchdog operator-recent) run from when the work
// the operator asked for finished, not from when the prompt arrived.
export function recordOperatorTurnEnd(nowMs: number): void {
  writeMarker(TMP_PATH, STATE_PATH, nowMs);
}

// Marks "an operator turn is in flight" for `routines.ts due`'s defer gate. The pipeline
// calls this at hook exit for kept, non-blocked prompts; stop-pipeline.ts clears it at Stop,
// with a 60-min TTL as a backstop so a failed Stop cannot starve routines forever.
export function openTurnMarker() {
  writeMarker(TURN_TMP, TURN_PATH);
}

// Hermit-issued slash prompts arrive at this hook as bare text, byte-identical to
// operator typing: a command the core mod runs with `$.command.run` reaches
// UserPromptSubmit as exactly `/<command> <args>` with no origin field. So the
// signal is state, not the prompt: a prompt equal to a command of the mod's
// in-flight request is the hermit's own, and every other prompt counts as operator
// activity. Missing the operator is the destructive direction (mid-session /clear,
// context clearing); counting a stray programmatic prompt only delays cleanup.
// INJECTED_EXACT keeps the commands hermit launches outside the queue.
const INJECTED_EXACT = new Set([
  '/hermitd:resident-start',
  '/hermitd:heartbeat stop',
]);

// lib/harness-mod.ts INFLIGHT_DIR: read here directly so this per-prompt hook does not
// load the queue library and everything it imports.
const INFLIGHT_PATH = path.join(AGENT_DIR, 'state', 'harness-inflight');

/** True when the prompt is a command of the core mod's in-flight request. */
function isInflightCommand(prompt: string): boolean {
  let names: string[];
  try { names = fs.readdirSync(INFLIGHT_PATH); } catch { return false; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(INFLIGHT_PATH, name), 'utf-8'));
      for (const command of Array.isArray(entry?.commands) ? entry.commands : []) {
        if (typeof command?.command === 'string' && prompt === renderCommand(command)) return true;
      }
    } catch { /* unreadable entry: count the prompt */ }
  }
  return false;
}

function isRoutinePrompt(prompt: string, channel?: ChannelGateInputs): boolean {
  if (prompt.startsWith('[hermit-routine:')) return true;
  const t = prompt.trim();
  // A channel turn is operator activity exactly when its sender clears the same
  // `allowed_users` gate channel-responder applies (lib/channel-auth.ts owns the
  // semantics: absent list → accept all, [] → lockdown, unverifiable id → closed).
  // An unparseable `<channel` prefix keeps the old blanket skip — it carries no
  // identity to check, so it cannot be attributed to the operator.
  if (t.startsWith('<channel')) {
    const config = channel ? channel.config : readConfigRaw(AGENT_DIR);
    const envelope = channel ? channel.envelope : parseChannelEnvelope(t, config);
    if (!envelope) return true;
    // Presence of `channel`, not truthiness of its config: an unreadable config
    // is a legitimate null the caller already resolved (fail-open → accept-all),
    // and re-reading it here would just repeat that read.
    if (isPassiveChatSync(AGENT_DIR, config, envelope.sourceKey, envelope.chatId)
      && !isSelfMentionedSync(AGENT_DIR, config, envelope.sourceKey, envelope.chatId, envelope.body, envelope)) return true;
    return !isAllowedSender(config, envelope.source, envelope.userId);
  }
  if (t.startsWith(BOOTSTRAP_PREFIX)) return true;
  if (INJECTED_EXACT.has(t)) return true;
  if (t.startsWith('/') && isInflightCommand(t)) return true;
  // Peer delivery passes only the message body to this hook, not the
  // `Message from @...` frame shown in the session transcript.
  if (t.startsWith('GUEST_REPORT:')) return true;
  // Harness task notifications — Monitor events AND subagent/background-task
  // completions. Live-probed 2026-08-19 (CC 2.1.235): the harness wraps the
  // emitter's stdout in an envelope before it reaches this hook —
  //   <task-notification>\n<task-id>…</task-id>
  //   \n<summary>Monitor event: "routine-monitor"</summary>
  //   \n<event>ROUTINE_DUE [hermit-routine:daily-brief]</event>\n…</task-notification>
  // — so the anchored sentinel rules below never match a delivered one. This is
  // also the ONLY coverage for subagent/background completions, which carry no
  // hermit sentinel at all. Mid-turn arrivals are queued and run the hook
  // individually (CC 2.1.263); notifications still do not count as activity.
  if (t.startsWith('<task-notification')) return true;
  // Monitor emissions in bare form. Deliberately anchored, NOT containment: this
  // is a live input boundary where a false positive silences an context clearing, so an
  // operator prompt that merely quotes a sentinel must still count as activity
  // (pinned in tests/heartbeat-monitor-emissions.test.ts). lib/trigger-source.ts anchors the same
  // grammar too, on the sentinel line a wake delivered; it stays a separate boundary
  // (retrospective cost attribution over stored transcripts, different failure cost),
  // so keep both in sync deliberately rather than treating either as precedent.
  //   heartbeat-monitor.sh:38-43 → "HEARTBEAT_EVALUATE" (bare) | "HEARTBEAT_ERROR: <detail>"
  //   lib/routines/due.ts        → "ROUTINE_DUE [hermit-routine:<id>] ..."
  //   routine-monitor.sh:36      → "ROUTINE_MONITOR_ERROR: <detail>"
  // tests/heartbeat-monitor-emissions.test.ts monitor-emission drift guard re-derives this list
  // from the emitters' source, bare AND envelope-wrapped — extend both together.
  if (t === 'HEARTBEAT_EVALUATE') return true;
  if (t.startsWith('HEARTBEAT_ERROR: ')) return true;
  if (t.startsWith('ROUTINE_DUE [hermit-routine:')) return true;
  if (t.startsWith('ROUTINE_MONITOR_ERROR: ')) return true;
  if (t.startsWith('WATCH_EVENT [hermit-watch:')) return true;
  if (t.startsWith('WATCH_MONITOR_ERROR: ')) return true;
  return false;
}

// The UserPromptSubmit half, callable in-process by user-prompt-pipeline.ts.
// `channel` feeds the channel allowlist gate only — see ChannelGateInputs.
export function run(prompt: string, channel?: ChannelGateInputs, opts: { openTurn?: boolean; sessionId?: string | null } = {}): boolean {
  if (isRoutinePrompt(prompt, channel)) return false;

  if (isGuest(path.join(AGENT_DIR, 'state'), opts.sessionId)) return false;
  write();
  if (opts.openTurn !== false) openTurnMarker();
  return true;
}

function main(raw: string): void {
  let prompt: string | null = null;
  let id: string | null = null;
  try {
    const payload = JSON.parse(raw);
    id = sessionId(payload);
    if (payload && typeof payload.prompt === 'string') prompt = payload.prompt;
  } catch { /* not JSON or empty — SessionStart path */ }

  if (prompt === null) {
    if (!isGuest(path.join(AGENT_DIR, 'state'), id)) seedOperatorActivity();
    return;
  }

  // Direct-script path: no caller-supplied envelope or config, so isRoutinePrompt
  // derives both itself — for a `<channel` prompt only.
  run(prompt, undefined, { sessionId: id });
}

// Entry shell only when executed directly — importing this module (the pipeline
// does, for run()) must not consume stdin or act on the caller's argv.
if (import.meta.main) {
  if (process.argv.includes('--force')) {
    write();
    openTurnMarker();
    emit('OK');
  }

  try {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('error', () => {});
    process.stdin.on('end', () => {
      try { main(buf); } catch { /* fail-open */ }
      process.exit(0);
    });
  } catch {
    process.exit(0);
  }
}
