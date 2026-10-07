// One deterministic heartbeat tick: verdict, budget notifications and queued records.
// The skill delivers notifications and acknowledges successful delivery; composing
// a notice never consumes it or changes the resident's execution state.

import { runPrecheck } from './precheck';
import { pendingQueue, type QueueNotice } from './queue';
export { acknowledgeQueue } from './queue';
import { readSettledConfig } from '../config-read';
import { readMergedAlerts } from '../alert-state';
import { isPaused } from '../pause';
import { resolveHermitNowMs } from '../time';
import { resolveLocale } from '../messages';

type Json = any;

type Notification = { text: string; mark_key?: string };

type Notifications = { budget: Notification[]; queue?: QueueNotice };

type TickResult = {
  verdict: string;
  reason?: string;
  alert?: string;
  notifications: Notifications;
  model: string | null;
  effort: string | null;
};

/** Split the precheck's one-line grammar into the JSON fields the skill branches on. */
function parseVerdict(raw: string): Omit<TickResult, 'model' | 'effort'> {
  if (raw.startsWith('SKIP|')) return { verdict: 'SKIP', reason: raw.slice(5), notifications: { budget: [] } };
  if (raw.startsWith('ALERT|')) return { verdict: 'ALERT', alert: raw.slice(6), notifications: { budget: [] } };
  return { verdict: raw, notifications: { budget: [] } };
}

/**
 * One notification per un-notified budget entry, composed with cost-tracker's own
 * wording so the heartbeat path and the Stop-hook push read identically. `mark_key`
 * is the alert key the skill hands back to `--mark-budget-notified`; cost-tracker
 * stays the sole writer of that flag.
 */
async function composeBudgetAlerts(hermitDir: string, config: Json, out: Notification[]): Promise<void> {
  const merged = readMergedAlerts(hermitDir);
  const pending = Object.keys(merged).sort()
    .filter(k => merged[k]?.kind === 'budget' && merged[k].notified === false);
  if (pending.length === 0) return;

  // Lazy, for the reason the dispatchers are: cost-tracker pulls in pricing, the
  // cost log and the channel sender, and a breach is rare. The common tick pays
  // nothing for a branch it does not take.
  const { composeBudgetMessage } = await import('../../cost-tracker');
  const timezone = config.timezone ?? 'UTC';
  const locale = resolveLocale(config.language);
  for (const key of pending) {
    const entry = merged[key];
    const action = entry.action === 'pause' ? 'pause' : 'alert';
    // The auto-resume boundary is only quotable while the pause it describes is
    // actually in force — a lapsed one would promise a resume that already happened.
    let until: string | null = null;
    if (action === 'pause' && entry.level === 'breach') {
      const status = isPaused(hermitDir);
      if (status.paused && status.reason === 'budget') until = status.until ?? null;
    }
    out.push({ text: composeBudgetMessage([entry], action, until, timezone, locale), mark_key: key });
  }
}

export async function run(args: string[]): Promise<void> {
  const hermitDir = args[0];
  // Settled once, shared by the model and effort fields and the bookkeeping below.
  // Settling preserves an explicit `heartbeat.model: null` (the skill reads it as
  // "inherit the session model") or `heartbeat.effort: null` ("use the subagent's
  // own effort") while folding absent/""/wrong-typed to 'haiku' and 'high'; the
  // reader never writes and never throws.
  const config = readSettledConfig(hermitDir);
  // Mutating precheck, exactly once — before anything below can throw, so a tick
  // is never double-counted by a retry.
  const result: TickResult = {
    ...parseVerdict(runPrecheck(hermitDir, false)),
    model: config.heartbeat.model,
    effort: config.heartbeat.effort,
  };

  try {
    const nowMs = resolveHermitNowMs();

    if (result.verdict === 'EVALUATE' || result.verdict === 'ALERT') {
      await composeBudgetAlerts(hermitDir, config, result.notifications.budget);
      if (result.verdict === 'EVALUATE') {
        const queue = pendingQueue(hermitDir, nowMs);
        if (queue) result.notifications.queue = queue;
      }
    }
  } catch { /* fail-open: the verdict still ships, minus the bookkeeping */ }

  process.stdout.write(JSON.stringify(result) + '\n');
}
