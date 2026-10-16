// Resident-owned state for the native chat command executor. No tmux fallback.
import fs from 'node:fs';
import path from 'node:path';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { ARG_RE, COMMAND_MARKER_TTL_SECS, type ParsedCommand } from './harness-command';

export type ReplyTarget = { source: string; chat_id: string; thread?: string | null };
export type HarnessRequest = {
  commands: ParsedCommand[];
  by: string;
  reply_to?: ReplyTarget;
  dir: string;
  requested_at?: string;
};
export type HarnessDecision =
  | { decision: 'pass' }
  | { decision: 'refuse'; reason: string; reply_to?: ReplyTarget; silent?: boolean }
  | ({ decision: 'run' } & HarnessRequest);
export type HarnessOutcome = ParsedCommand & { status: 'ok' | 'failed' | 'unknown'; text: string };
export const DEFERRED_SWITCH_FILE = 'pending-harness-switch.json';
export const MOD_LOADED_FILE = 'harness-mod-loaded.json';

export function writeModState(dir: string, file: string, value: unknown): void {
  const target = path.join(dir, 'state', file);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n');
    fs.renameSync(tmp, target);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function readDeferredSwitch(dir: string): HarnessRequest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'state', DEFERRED_SWITCH_FILE), 'utf8'));
    // A request is a moment, not a standing order: one that outlived a restart or wedge expires.
    if (!value || typeof value.requested_at !== 'string' || !Number.isFinite(Date.parse(value.requested_at))
      || Date.now() - Date.parse(value.requested_at) > COMMAND_MARKER_TTL_SECS * 1000
      || !Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 2
      || !value.commands.every((c: ParsedCommand) => c && ['/model', '/effort'].includes(c.command)
        && typeof c.arg === 'string' && ARG_RE.test(c.arg))) return null;
    return { ...value, dir };
  } catch { return null; }
}

// The writer and acknowledgement share this lock: comparing identity and then
// unlinking without it could delete a newer request renamed into place between.
function withDeferredSwitchLock(dir: string, mutate: () => void): void {
  const lock = path.join(dir, 'state', '.harness-switch.lock');
  if (!acquireLockWithWait(lock, 2000)) throw new Error('Deferred switch state is locked or unwritable');
  try { mutate(); } finally { releaseLock(lock); }
}

export function writeDeferredSwitch(dir: string, request: HarnessRequest): void {
  withDeferredSwitchLock(dir, () => writeModState(dir, DEFERRED_SWITCH_FILE, request));
}

export function ackDeferredSwitch(dir: string, identity: string): void {
  withDeferredSwitchLock(dir, () => {
    if (readDeferredSwitch(dir)?.requested_at === identity) {
      fs.unlinkSync(path.join(dir, 'state', DEFERRED_SWITCH_FILE));
    }
  });
}
