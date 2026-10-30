// One deterministic heartbeat tick: verdict, budget notifications and queued records.
// The skill delivers notifications and acknowledges successful delivery; composing
// a notice never consumes it or changes the resident's execution state.

import { runPrecheck } from './precheck';
import { pendingQueue, type QueueNotice } from './queue';
export { acknowledgeQueue } from './queue';
import { readSettledConfig } from '../config-read';
import { readMergedAlerts, readAlertState, alertStatePath, activeSuppressedEntries, isStructuredKey } from '../alert-state';
import { isPaused } from '../pause';
import { resolveHermitNowMs, todayYMD } from '../time';
import { loadMessages } from '../messages';

type Json = any;

type Notification = { text: string; mark_key?: string };

type Notifications = { budget: Notification[]; queue?: QueueNotice };

type DecisionItem = { key: string; text: string };

type TickResult = {
  status: string;
  reason?: string;
  hash?: string;
  detail?: string;
  notifications: Notifications;
  model: string | null;
  effort: string | null;
  decision_refresh?: DecisionItem[];
};

const DECISION_REFRESH_LIMIT = 5;

/**
 * Pending decisions today's digest will repeat, oldest first, for the evaluator to
 * re-check before they are asked again. Same selection as the digest itself, so the
 * list cannot drift from it; `text` keeps the internal id the check needs.
 */
function dueDecisionItems(hermitDir: string, timezone: string, nowMs: number): DecisionItem[] {
  const r = readAlertState(alertStatePath(hermitDir));
  if (r.kind !== 'ok') return [];
  if (r.value.last_digest_date === todayYMD(timezone, new Date(nowMs))) return [];
  return activeSuppressedEntries(r.value.alerts)
    .filter(([k]) => isStructuredKey(k))
    .sort(([, a], [, b]) => String(a.first_seen ?? '').localeCompare(String(b.first_seen ?? '')))
    .slice(0, DECISION_REFRESH_LIMIT)
    .map(([key, e]) => ({ key, text: typeof e.text === 'string' ? e.text : '' }));
}

/** The snake_case token for a precheck reason, e.g. `HEARTBEAT.md missing` → `heartbeat_md_missing`. */
const reasonToken = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Split the precheck's one-line grammar into the JSON fields the skill branches on.
 * The only ALERT is `injection-suspect:<hash>|<detail>`, so it splits into fields.
 */
function parseVerdict(raw: string): Omit<TickResult, 'model' | 'effort'> {
  const notifications = { budget: [] };
  if (raw.startsWith('SKIP|')) return { status: 'skip', reason: reasonToken(raw.slice(5)), notifications };
  const alert = raw.match(/^ALERT\|([^:|]+):([^|]*)\|(.*)$/);
  if (alert) return { status: 'alert', reason: reasonToken(alert[1]), hash: alert[2], detail: alert[3], notifications };
  return { status: raw.toLowerCase(), notifications };
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
  const messages = loadMessages(hermitDir, config.language);
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
    out.push({ text: composeBudgetMessage([entry], action, until, timezone, messages), mark_key: key });
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

    if (result.status === 'evaluate' || result.status === 'alert') {
      await composeBudgetAlerts(hermitDir, config, result.notifications.budget);
      if (result.status === 'evaluate') {
        const queue = pendingQueue(hermitDir, nowMs);
        if (queue) result.notifications.queue = queue;
        const due = dueDecisionItems(hermitDir, config.timezone ?? 'UTC', nowMs);
        if (due.length > 0) result.decision_refresh = due;
      }
    }
  } catch { /* fail-open: the status still ships, minus the bookkeeping */ }

  process.stdout.write(JSON.stringify(result) + '\n');
}
