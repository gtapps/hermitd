#!/usr/bin/env bun
// CLI wrapper around lib/channel-send.ts's sendToChannel/sendOperatorNotice — the
// seam synchronous callers (hermitd-watchdog.ts, single-shot, no async conversion)
// reach the deterministic channel send through via spawnSync, instead of
// importing the lib directly the way async callers (cost-tracker.ts,
// lib/prompt-stages/channel-status-responder.ts) do.
//
// Usage: bun channel-send.ts <hermit-dir> [--tier client|maintainer] <text|- >
//   --tier     client (default) sends to the primary chat as today; maintainer
//              routes through sendOperatorNotice to channels.<p>.maintainer_channel_id,
//              falling back to the primary chat when none is configured.
//   <text|- >  literal text, or "-" to read the message from stdin (avoids
//              argv length/newline edges — the form spawnSync callers use).
//   Prints `OK` once sent, else {"error":"<token>"} at exit 1.
//
// Usage: bun channel-send.ts <hermit-dir> --notice [--routine <id> | --watch <id>]
//   Reads a JSON payload on stdin: { client?, maintainer?, sensitive?, fallback? }.
//   This is the model-facing proactive-notify entry — it is the sole reachable
//   path to sendOperatorNotice()'s two-audience routing (same-chat merge, Findings
//   fallback, tier disclosure). The model never resolves a channel itself; this
//   script does. `--routine <id>` names the routine whose fire is sending: when
//   that routine has a `chat`, the client leg goes there instead of the home
//   chat. `--watch <id>` does the same with the config watch’s `chat`, or an
//   ad-hoc watch’s runtime registry entry `chat`.
//   Prints {"status","reason"?,"result"} at exit 0 whether or not it landed:
//     delivered    every requested leg landed where it was meant to
//     degraded     every leg was accepted, but maintainer detail fell back to Findings
//     undelivered  a leg failed to land (`reason: no_reachable_channel` when none could)
//   A rejected payload prints {"error":"invalid_payload:<detail>"} at exit 1: nothing
//   was sent, and it is not evidence the channel is broken.

import { pinStateDirOrExit } from './lib/cc-compat';
import { sendToChannel, sendOperatorNotice, type SendResult } from './lib/channel-send';
import { emit, emitJson, exitError, failJson } from './lib/cli';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Pull `--tier <value>` / `--notice` out from anywhere in argv (position-independent),
// leaving the hermit-dir (and text, for --tier mode) positionals in order.
function parseArgs(
  argv: string[],
): { mode: 'tier'; tier: 'client' | 'maintainer'; positionals: string[] }
  | { mode: 'notice'; routine?: string; watch?: string; positionals: string[] }
  | { error: string } {
  const positionals: string[] = [];
  let tier: 'client' | 'maintainer' | null = null;
  let notice = false;
  let routine: string | undefined;
  let watch: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tier') {
      const v = argv[i + 1];
      if (v !== 'client' && v !== 'maintainer') return { error: `invalid --tier value: ${v ?? '(missing)'}` };
      tier = v;
      i++;
    } else if (argv[i] === '--notice') {
      notice = true;
    } else if (argv[i] === '--routine') {
      routine = argv[i + 1];
      if (!routine || routine.startsWith('--')) return { error: 'missing --routine value' };
      i++;
    } else if (argv[i] === '--watch') {
      watch = argv[i + 1];
      if (!watch || watch.startsWith('--')) return { error: 'missing --watch value' };
      i++;
    } else {
      positionals.push(argv[i]);
    }
  }
  if (notice && tier !== null) return { error: '--notice and --tier are mutually exclusive' };
  if (routine !== undefined && watch !== undefined) return { error: '--routine and --watch are mutually exclusive' };
  if (watch !== undefined && !notice) return { error: '--watch requires --notice' };
  if (routine !== undefined && !notice) return { error: '--routine requires --notice' };
  if (notice) return { mode: 'notice', routine, watch, positionals };
  return { mode: 'tier', tier: tier ?? 'client', positionals };
}

interface NoticePayload {
  client?: string;
  maintainer?: string;
  sensitive?: boolean;
  fallback?: 'client' | 'primary' | 'findings';
}

const NOTICE_KEYS = new Set(['client', 'maintainer', 'sensitive', 'fallback']);

// Strict validation: the model is a fuzzy boundary, and rejecting an unknown key
// (e.g. a typo'd "maintainter") is what stops a silently-dropped audience leg.
function parseNotice(raw: string): NoticePayload | { error: string } {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (e: any) {
    return { error: `invalid JSON: ${e.message}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'payload must be a JSON object' };
  }
  for (const k of Object.keys(obj)) {
    if (!NOTICE_KEYS.has(k)) return { error: `unknown field: ${k}` };
  }
  const { client, maintainer, sensitive, fallback } = obj;
  for (const [name, v] of [['client', client], ['maintainer', maintainer]] as const) {
    if (v !== undefined && (typeof v !== 'string' || v.trim() === '')) {
      return { error: `${name} must be a non-empty string` };
    }
  }
  if (client === undefined && maintainer === undefined) {
    return { error: 'at least one of client/maintainer is required' };
  }
  if (sensitive !== undefined && typeof sensitive !== 'boolean') {
    return { error: 'sensitive must be a boolean' };
  }
  if (fallback !== undefined && fallback !== 'client' && fallback !== 'primary' && fallback !== 'findings') {
    return { error: `invalid fallback: ${fallback}` };
  }
  // Both modifiers apply to the maintainer leg only. Accepting them without one
  // would silently drop the caller's intent (notably `sensitive`, whose whole
  // job is keeping text out of the searchable channel log).
  if (maintainer === undefined && (sensitive !== undefined || fallback !== undefined)) {
    return { error: 'sensitive/fallback apply to the maintainer leg and require maintainer' };
  }
  return { client, maintainer, sensitive, fallback };
}

// A leg counts delivered when the send succeeded and didn't degrade to Findings.
// The client leg never carries `delivered` (lib/channel-send.ts's sendToChannel
// returns only {ok, status}), so `r.delivered !== false` is vacuously true there
// and `ok` alone decides — this one helper is correct for both legs.
function legDelivered(r: SendResult): boolean {
  return r.ok === true && r.delivered !== false;
}

async function runNotice(hermitDir: string, routine?: string, watch?: string): Promise<void> {
  const raw = (await readStdin()).trim();
  if (!raw) exitError('invalid_payload:empty');
  const p = parseNotice(raw);
  if ('error' in p) exitError(`invalid_payload:${p.error}`);

  const out = await sendOperatorNotice(hermitDir, {
    client: p.client,
    maintainer: p.maintainer
      ? { text: p.maintainer, fallback: p.fallback ?? 'client', sensitive: p.sensitive }
      : undefined,
    routine,
    watch,
  });

  const legs = [out.client, out.maintainer].filter((r): r is SendResult => !!r);
  // Every leg, including both legs of a merged send, must have landed. `some` would report success
  // for a half-delivered notice — e.g. a typo'd maintainer_channel_id degrading
  // the maintainer leg to Findings while the client leg goes out — and the
  // caller's documented "delivered ⇒ done" branch would drop that content silently.
  // Accepted-but-not-delivered can only be the maintainer leg's Findings fallback.
  const status = legs.every(legDelivered) ? 'delivered' : legs.every((r) => r.ok) ? 'degraded' : 'undelivered';
  const no_channel = legs.every((r) => r.error === 'no_reachable_channel');
  emitJson(status === 'undelivered' && no_channel
    ? { status, reason: 'no_reachable_channel', result: out }
    : { status, result: out });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) exitError(`usage:${parsed.error}`);

  if (parsed.mode === 'notice') {
    const [hermitDir] = parsed.positionals;
    // Reject a stray positional rather than ignoring it: the likely mistake is
    // passing the payload as an argument, which would otherwise leave the script
    // waiting on an stdin that never arrives.
    if (!hermitDir || parsed.positionals.length > 1) exitError();
    // Pinned after the arity check so a missing positional still prints the
    // usage error rather than the pin error.
    await runNotice(pinStateDirOrExit(hermitDir), parsed.routine, parsed.watch);
    return;
  }

  const [hermitDir, textArg] = parsed.positionals;
  if (!hermitDir || !textArg) exitError();
  const stateDir = pinStateDirOrExit(hermitDir);

  const text = textArg === '-' ? (await readStdin()).trim() : textArg;
  if (!text) exitError('empty_text');

  if (parsed.tier === 'maintainer') {
    const res = await sendOperatorNotice(stateDir, { maintainer: { text, fallback: 'client' } });
    const m = res.maintainer;
    if (m?.ok) emit('OK');
    // A send error can be free text (a fetch message); failJson keeps only a token.
    failJson(m?.error ?? 'no_delivery', 'send_failed');
    return;
  }

  const result = await sendToChannel(stateDir, text);
  if (result.ok) emit('OK');
  failJson(result.error, 'send_failed');
}

if (import.meta.main) {
  main().catch((e) => failJson(e, 'send_failed'));
}
