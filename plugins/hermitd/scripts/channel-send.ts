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
//
// Usage: bun channel-send.ts <hermit-dir> --notice [--routine <id>]
//   Reads a JSON payload on stdin: { client?, maintainer?, sensitive?, fallback? }.
//   This is the model-facing proactive-notify entry — it is the sole reachable
//   path to sendOperatorNotice()'s two-audience routing (dedup, Findings
//   fallback, tier disclosure). The model never resolves a channel itself; this
//   script does. `--routine <id>` names the routine whose fire is sending: when
//   that routine has a `chat`, the client leg goes there instead of the home
//   chat. Prints a normalized JSON result on stdout. Exit codes:
//     0  every requested leg landed where it was meant to
//     1  a leg failed to land (delivery problem — see the JSON on stdout)
//     2  the payload/usage was rejected (caller error — fix and retry; no JSON,
//        nothing was sent, and this is *not* evidence the channel is broken)

import { assertStateDir, hermitDir as ownStateDir } from './lib/cc-compat';
import { sendToChannel, sendOperatorNotice, type SendResult } from './lib/channel-send';

// The state dir is not caller-chosen. Reachable through a pre-approved
// `Bash(bun */scripts/channel-send.ts*)` grant that covers every argument, so an
// unvalidated root let one such call send with *another* project's bot token to
// *that* project's configured chat — the worst shape of this defect class, since
// this script is an egress path. See cc-compat.ts.
//
// Exits 2, not the shared pinStateDirOrExit()'s 1: this script documents 1 as
// "a leg failed to land" and 2 as "the caller got it wrong, nothing was sent".
// A foreign state dir is the latter, and reporting it as the former would read
// as a broken channel.
function pinOrExit(argvValue: string): string {
  const pinned = assertStateDir(argvValue);
  if (pinned) return pinned;
  process.stderr.write(`channel-send: state dir must be this project's (${ownStateDir()}); got ${argvValue}\n`);
  process.exit(2);
}

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
  | { mode: 'notice'; routine?: string; positionals: string[] }
  | { error: string } {
  const positionals: string[] = [];
  let tier: 'client' | 'maintainer' | null = null;
  let notice = false;
  let routine: string | undefined;
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
    } else {
      positionals.push(argv[i]);
    }
  }
  if (notice && tier !== null) return { error: '--notice and --tier are mutually exclusive' };
  if (routine !== undefined && !notice) return { error: '--routine requires --notice' };
  if (notice) return { mode: 'notice', routine, positionals };
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

async function runNotice(hermitDir: string, routine?: string): Promise<void> {
  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stderr.write('channel-send: empty --notice payload (the JSON goes on stdin)\n');
    process.exit(2);
  }
  const p = parseNotice(raw);
  if ('error' in p) {
    process.stderr.write(`channel-send: ${p.error}\n`);
    process.exit(2);
  }

  const out = await sendOperatorNotice(hermitDir, {
    client: p.client,
    maintainer: p.maintainer
      ? { text: p.maintainer, fallback: p.fallback ?? 'client', sensitive: p.sensitive }
      : undefined,
    routine,
  });

  const legs = [out.client, out.maintainer].filter((r): r is SendResult => !!r);
  // Every leg that survived dedup must have landed. `some` would report success
  // for a half-delivered notice — e.g. a typo'd maintainer_channel_id degrading
  // the maintainer leg to Findings while the client leg goes out — and the
  // caller's documented "exit 0 ⇒ done" branch would drop that content silently.
  const delivered = legs.length > 0 && legs.every(legDelivered);
  const degraded = out.maintainer?.route === 'findings' && out.maintainer?.delivered === false;
  const no_channel = legs.length > 0 && legs.every((r) => r.error === 'no_reachable_channel');
  process.stdout.write(JSON.stringify({ delivered, degraded, no_channel, result: out }) + '\n');
  process.exit(delivered ? 0 : 1);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    // Usage error, not a delivery failure — exit 2 so a caller can tell its own
    // malformed invocation apart from a channel that wouldn't take the message.
    process.stderr.write(`channel-send: ${parsed.error}\n`);
    process.exit(2);
  }

  if (parsed.mode === 'notice') {
    const [hermitDir] = parsed.positionals;
    // Reject a stray positional rather than ignoring it: the likely mistake is
    // passing the payload as an argument, which would otherwise leave the script
    // waiting on an stdin that never arrives.
    if (!hermitDir || parsed.positionals.length > 1) {
      process.stderr.write('Usage: bun channel-send.ts <hermit-dir> --notice   (JSON payload on stdin)\n');
      process.exit(2);
    }
    // Pinned after the arity check so a missing positional still prints this
    // mode's usage rather than the pin error.
    await runNotice(pinOrExit(hermitDir), parsed.routine);
    return;
  }

  const [hermitDir, textArg] = parsed.positionals;
  if (!hermitDir || !textArg) {
    process.stderr.write('Usage: bun channel-send.ts <hermit-dir> [--tier client|maintainer] <text|->\n');
    process.exit(2);
  }
  const stateDir = pinOrExit(hermitDir);

  const text = textArg === '-' ? (await readStdin()).trim() : textArg;
  if (!text) {
    process.stderr.write('channel-send: empty text\n');
    process.exit(1);
  }

  if (parsed.tier === 'maintainer') {
    const res = await sendOperatorNotice(stateDir, { maintainer: { text, fallback: 'client' } });
    const m = res.maintainer;
    if (!m || !m.ok) {
      process.stderr.write(`channel-send: ${m?.error ?? 'no_delivery'}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  const result = await sendToChannel(stateDir, text);
  if (!result.ok) {
    process.stderr.write(`channel-send: ${result.error}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) {
  main().catch((e: any) => {
    process.stderr.write(`channel-send: ${e?.message || e}\n`);
    process.exit(1);
  });
}
