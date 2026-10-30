// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// PermissionDenied hook (matcher "*") — fires after Claude Code's own auto-mode
// classifier (or the permissions system) has already denied a tool call. The
// payload carries tool_name, tool_input, tool_use_id, and reason (usually the
// fixed text "Blocked by classifier"). This hook cannot block or retry the call;
// it records a deduped maintainer-tier diagnostic, routed by tier: the maintainer chat
// when one is configured, the primary chat on a technical profile without one,
// and state/watchdog-events.jsonl on a non-technical profile (fail-closed on disclosure)
// or whenever the channel is absent or unreachable.
//
// Gating mirrors ask-gate.ts: only the managed unattended session
// (HERMIT_MANAGED, stamped into the tmux env-file by hermitd-start) with
// always_on config records anything — an attended session sees the denial
// natively in its own transcript. Channel reachability gates the POST only;
// the record itself always happens.
//
// Fail-open and side-effect-only: every path exits 0. The harness ignores
// this hook's stdout/stderr and its exit code; it never emits
// hookSpecificOutput.retry (auto-retrying a classifier denial is exactly the
// bypass the security model forbids).

import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { channelLikelyDown } from './lib/channel-health';
import { resolve as resolveOutboundChannel, resolveMaintainerTarget } from './resolve-outbound-channel';
import { sendOperatorNotice, appendMaintainerFindings } from './lib/channel-send';
import { readAlertState, writeAlertState } from './lib/alert-state';
import { acquireLock, releaseLock } from './lib/lockfile';
import { appendDenial } from './lib/denial-log';
import { safe } from './lib/sanitize';
import { localISOStamp } from './lib/time';
import { loadMessages } from './lib/messages';

type Json = any;

const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — carry-over cap
// Bounded for the same reason TOOL_NAME_MAX_LEN below bounds tool_name: the
// program name is model-supplied and is rendered into doctor's detail line. Real
// program names are far shorter.
const PROGRAM_MAX_LEN = 32;
// A peer hook process's read-modify-write of the alerts file takes a few ms. Long
// enough to wait out, short enough that a denied tool call never stalls on it —
// the same posture (and constants) as bounded lock handling.
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const MESSAGE_MAX_LEN = 300;
// The reason is bounded on its own so a long one (permission-rule denials are
// far wordier than the classifier's fixed string) cannot crowd out the tool name
// and suppressed count; the trailing guidance is always kept whole.
const REASON_MAX_LEN = 150;
// tool_name is model-supplied and is now a state-file key, so bound it. Plain
// truncation would be wrong: long MCP names share a prefix (`mcp__<server>__`),
// so two distinct tools on a verbose server could truncate to the same key and
// silently share one dedup window. Overflow keeps a hash tail instead, which
// stays distinct.
const TOOL_NAME_MAX_LEN = 60;
const TOOL_NAME_HASH_LEN = 6;

// One open window per tool: when it opened, and how many further denials of the
// same tool it has absorbed since. The 7-day record lives in lib/denial-log.ts.
interface DenyWindow {
  at: string;
  suppressed: number;
}

function alertsPath(dir: string): string {
  return path.join(dir, 'state', 'permission-denied-alerts.json');
}

// Reuse lib/alert-state.ts's atomic read/write — the same single-writer
// alert-file pattern cost-tracker.ts and report-export.ts already use for
// budget-alerts.json / telemetry-alert.json, instead of a hand-rolled
// tmp+rename write. This file's shape is a flat tool->window map, so only
// the generic readAlertState/writeAlertState pair applies (not
// mutateOwnedAlerts/readMergedAlerts, which assume the `{alerts: {...}}` shape).
function readAlerts(dir: string): Record<string, DenyWindow> {
  const read = readAlertState(alertsPath(dir));
  if (read.kind !== 'ok' || !read.value || typeof read.value !== 'object') return {};
  const out: Record<string, DenyWindow> = {};
  // Anything not shaped like a window is dropped — which is also what happens to
  // the pre-upgrade entries, keyed by a tool+input hash no new key can match.
  for (const [k, v] of Object.entries(read.value as Record<string, unknown>)) {
    if (v && typeof v === 'object' && typeof (v as Json).at === 'string') {
      out[k] = { at: (v as Json).at, suppressed: Number((v as Json).suppressed) || 0 };
    }
  }
  return out;
}

// First word of a Bash command, never anything after it. Env assignments
// (`TOKEN=abc curl …`) become the sentinel rather than looking at word two.
function bashProgram(payload: Json): string | null {
  if (payload.tool_name !== 'Bash') return null;
  const command = payload.tool_input?.command;
  if (typeof command !== 'string') return null;
  const first = command.trim().split(/\s+/, 1)[0];
  if (!first) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return 'env-prefixed';
  const token = safe(path.basename(first)).slice(0, PROGRAM_MAX_LEN);
  return token || null;
}

function writeAlerts(dir: string, alerts: Record<string, DenyWindow>): void {
  fs.mkdirSync(path.dirname(alertsPath(dir)), { recursive: true });
  writeAlertState(alertsPath(dir), alerts);
}

/**
 * Advisory lock over both of this hook's writes — the alerts file's
 * read-modify-write and the event-log append. Claude Code does not serialise hook
 * invocations, so two denials in one assistant turn can otherwise each overwrite
 * the whole alerts map with its own stale copy, dropping a peer tool's open
 * window. Best-effort by design, the same posture as bounded lock handling: waiting out a contended lock is not worth stalling a denied tool
 * call inside a 12s hook timeout, so we proceed unlocked instead.
 *
 * The lock file is named for the alerts file though it now guards both; renaming
 * it would leave an upgrading install with one process on each name, briefly
 * unprotected, for no functional gain.
 */
function withAlertsLock<T>(dir: string, fn: () => T): T {
  const lockPath = `${alertsPath(dir)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held && Date.now() < deadline) {
    try {
      held = acquireLock(lockPath, LOCK_STALE_MS);
    } catch {
      break; // the lock path is unwritable — the write below may still succeed
    }
    if (!held) Bun.sleepSync(20);
  }
  try {
    return fn();
  } finally {
    if (held) releaseLock(lockPath);
  }
}

/**
 * Record the denial and open or extend this tool's 30-minute window, in one
 * critical section. Returns whether this denial opens a window (and so sends),
 * plus how many the previous window absorbed — the only place that count can be
 * truthful, since a burst's size isn't known when the window opens.
 *
 * The append rides inside the lock rather than outside it so the record does not
 * depend on the filesystem serializing concurrent `O_APPEND` writes. Linux does;
 * a FUSE-backed mount (a bind-mounted project tree under Docker Desktop for macOS)
 * is not guaranteed to, and an interleaved line is a denial silently lost.
 */
function recordDenial(dir: string, key: string, prog: string | null, now: number): { send: boolean; suppressed: number } {
  return withAlertsLock(dir, () => {
    appendDenial(dir, key, prog); // swallows its own errors — never breaks the claim below
    const alerts = readAlerts(dir);

    // Prune before reading this tool's window, so a stale one can neither hold the
    // window open nor contribute a day-old suppressed count.
    for (const [k, w] of Object.entries(alerts)) {
      const t = Date.parse(w.at);
      if (Number.isNaN(t) || now - t > PRUNE_AGE_MS) delete alerts[k];
    }

    // Pruning above guarantees a surviving entry's `at` parses.
    const entry = alerts[key];
    if (entry && now - Date.parse(entry.at) < DEDUP_WINDOW_MS) {
      alerts[key] = { at: entry.at, suppressed: entry.suppressed + 1 };
      writeAlerts(dir, alerts);
      return { send: false, suppressed: 0 };
    }

    const suppressed = entry?.suppressed ?? 0;
    alerts[key] = { at: localISOStamp(), suppressed: 0 };
    writeAlerts(dir, alerts);
    return { send: true, suppressed };
  });
}

// Bounded, distinct identity for one tool: itself when short enough, otherwise
// a truncation carrying a hash tail of the full name. Bun.hash is 64-bit wyhash
// — non-cryptographic on purpose, since this only has to keep two tool names
// apart, not resist an adversary (lib/hash.ts's sha256 is for the
// template-manifest baseline, where the digest is the security property).
function toolKey(rawName: unknown): string {
  const name = safe(typeof rawName === 'string' ? rawName : '');
  if (!name) return 'unknown_tool';
  if (name.length <= TOOL_NAME_MAX_LEN) return name;
  const tail = Bun.hash(name).toString(16).slice(0, TOOL_NAME_HASH_LEN);
  return `${name.slice(0, TOOL_NAME_MAX_LEN - TOOL_NAME_HASH_LEN - 1)}~${tail}`;
}

async function main(raw: string): Promise<void> {
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed stdin
  }
  if (!payload || typeof payload !== 'object') return;

  if (process.env.HERMIT_DENY_NOTIFY === 'off') return; // explicit per-session escape hatch
  if (process.env.HERMIT_MANAGED !== '1') return; // attended session sees the denial natively

  const dir = hermitDir();
  const config = readSettledConfig(dir); // settled: absent/malformed -> defaults (always_on false -> no-op)
  if (config.always_on !== true) return;

  // Dedup is keyed on the tool alone. Keying it on tool + input made a burst of
  // N distinct commands N separate keys, so the window collapsed nothing: the
  // incident this hook exists to report (four denials in nine minutes) produced
  // four messages. One message per tool per window, carrying how many further
  // denials it stood in for, is the signal worth having — whether the session
  // hit one wall or twelve.
  const key = toolKey(payload.tool_name);
  // PermissionDenied normally supplies the fixed reason "Blocked by classifier";
  // keep it optional so older or synthetic payloads remain fail-open.
  const reason = typeof payload.reason === 'string' ? safe(payload.reason).slice(0, REASON_MAX_LEN) : '';

  const now = Date.now();
  const claim = recordDenial(dir, key, bashProgram(payload), now);
  if (!claim.send) return; // inside an open window — counted, and stays quiet

  const m = loadMessages(dir, config.language);
  let maintainerText = m.t('deny_base', { tool: key });
  if (reason) maintainerText += ` — ${reason}`;
  if (claim.suppressed > 0) maintainerText += m.t('deny_suppressed', { count: claim.suppressed });
  const tail = m.t('deny_tail');
  maintainerText = maintainerText.slice(0, Math.max(0, MESSAGE_MAX_LEN - tail.length)) + tail;

  // The diagnostic is recorded whatever the channel is doing. An absent or dead
  // channel is a reason not to POST, never a reason to lose the record: with no
  // client leg left, Findings (injected into the next session by
  // startup-context.ts) is the only surface some installs have.
  const target = resolveMaintainerTarget(config.channels) ?? resolveOutboundChannel(config.channels);
  if (target && !channelLikelyDown(dir, target.id)) {
    // 'client', not 'findings': routing follows the general tiered-disclosure
    // policy instead of making this diagnostic an exception to it. Maintainer
    // chat when configured; primary chat on a technical profile without one;
    // Findings on a non-technical profile, which stays fail-closed.
    await sendOperatorNotice(dir, {
      maintainer: { text: maintainerText, fallback: 'client', sensitive: true },
    });
    return;
  }
  appendMaintainerFindings(dir, maintainerText);
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    main(buf)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
} catch {
  process.exit(0);
}
