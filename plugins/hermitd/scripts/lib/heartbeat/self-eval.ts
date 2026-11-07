// The heartbeat's every-20-ticks self-evaluation: does each HEARTBEAT.md item
// still earn its place, and is the checklist itself getting too heavy?
//
// Every input is a file this process already reads — the checklist, the alert
// state, local date, and `proposals/*.md`
// frontmatter — so none of it needs judgment. It runs inside `heartbeat.ts
// alert-state`, which owns `self_eval{}`; the counters it produces are written
// with the rest of the tick's state, and the entries that cross a threshold are
// handed back for the skill to turn into proposals.
//
// Two counters, mirror images, both advanced once per pass (not per tick):
//   clean_ticks: intervals in which the item raised nothing. Twenty of those with
//                 three distinct local dates behind them means the item is dead weight.
//   noise_ticks — passes in which an item whose proposal the operator already
//                 dismissed fired anyway. Same threshold, opposite conclusion.

import fs from 'node:fs';
import path from 'node:path';
import { readTaskInventory } from '../tasks';
import { normalizeItemKey, parseChecklistItems } from '../heartbeat-items';

type Json = any;

export const WEIGHT_KEY = 'checklist-weight';
const TICK_THRESHOLD = 20;
const SESSIONS_THRESHOLD = 3;
const MAX_CHECKLIST_ITEMS = 10;

export interface SelfEvalProposal {
  key: string;
  kind: 'clean' | 'noisy' | 'weight';
  clean_ticks: number;
  noise_ticks: number;
  sessions_seen: number;
}

const num = (v: Json): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The checklist items, in file order. Absent or unreadable HEARTBEAT.md → none. */
function readChecklist(stateDir: string): string[] {
  try {
    return parseChecklistItems(fs.readFileSync(path.join(stateDir, 'HEARTBEAT.md'), 'utf-8'));
  } catch { return []; }
}

/**
 * Compute this pass's `self_eval{}` and the entries that crossed a proposal
 * threshold. Pure over its inputs apart from the two file reads it owns
 * (HEARTBEAT.md, proposals/). Never throws: a read it cannot make contributes
 * nothing rather than aborting the tick.
 */
export function runSelfEval(opts: {
  stateDir: string;
  prevSelfEval: Json;
  alerts: Json;          // this tick's classified alerts, keyed like the checklist
  today: string;         // tz-local YYYY-MM-DD, for first_observed
}): { self_eval: Json; proposals: SelfEvalProposal[] } {
  const { stateDir, alerts, today } = opts;
  const self_eval: Json = { ...(opts.prevSelfEval && typeof opts.prevSelfEval === 'object' ? opts.prevSelfEval : {}) };
  const items = readChecklist(stateDir);
  const sessionId = today;

  const upsert = (key: string, text: string): Json => {
    const entry = { ...(self_eval[key] && typeof self_eval[key] === 'object' ? self_eval[key] : {}) };
    entry.text = text;
    if (typeof entry.first_observed !== 'string') entry.first_observed = today;
    entry.clean_ticks = num(entry.clean_ticks);
    entry.noise_ticks = num(entry.noise_ticks);
    entry.sessions_seen = num(entry.sessions_seen);
    entry.proposed = entry.proposed === true;
    self_eval[key] = entry;
    return entry;
  };

  // `sessions_seen` counts the distinct local dates an entry has been evaluated in, so it
  // advances on every pass — a firing one included. Tying it to clean passes alone would
  // make the noisy threshold (noise_ticks AND sessions_seen) unreachable for exactly the
  // item it exists for: one that fires on every pass never has a clean pass to count.
  const markSession = (entry: Json): void => {
    if (sessionId && sessionId !== entry.last_session_id) {
      entry.sessions_seen += 1;
      entry.last_session_id = sessionId;
    }
  };

  // A pass with nothing to report for an entry advances its clean streak too. Shared by
  // the per-item loop and the checklist-weight entry, which accrues clean passes on the
  // same terms without ever firing.
  const markCleanPass = (entry: Json): void => {
    entry.clean_ticks += 1;
    markSession(entry);
  };

  // Count any firing since the previous pass, including suppressed alerts that
  // recovered before this boundary. Consume the evidence for the next interval.
  const fired = new Set<string>();
  for (const item of items) {
    const key = normalizeItemKey(item);
    if (!key) continue;
    const entry = upsert(key, item);
    delete entry.alert_text;
    const alert = alerts?.[key];
    const firedInInterval = entry.fired_since_self_eval === true;
    delete entry.fired_since_self_eval;
    if (firedInInterval || (alert && (alert.consecutive_clean ?? 0) === 0)) {
      fired.add(key);
      entry.clean_ticks = 0;
      markSession(entry);
    } else {
      markCleanPass(entry);
    }
  }

  // A checklist past its recommended size is its own self-eval entry: it never
  // fires an alert, so it accrues clean passes until it reaches the threshold.
  if (items.length > MAX_CHECKLIST_ITEMS) {
    markCleanPass(upsert(WEIGHT_KEY, `Checklist weight: ${items.length} items`));
  } else {
    delete self_eval[WEIGHT_KEY];
  }

  // One pass over the proposals this hermit raised about its own checklist:
  // a dismissal re-opens the item for observation, and an item that keeps firing
  // after its proposal was dismissed accrues noise instead.
  const inventory = readTaskInventory(stateDir);
  for (const record of inventory.ok ? inventory.records : []) {
    const key = record.kind === 'proposal' && record.dedupe_key?.startsWith('self-eval:') ? record.dedupe_key.slice('self-eval:'.length) : null;
    const entry = key ? self_eval[key] : null;
    if (!entry) continue;
    if (record.closed_by === 'cancelled' && entry.proposed === true) { entry.proposed = false; entry.clean_ticks = 0; }
    if (!fired.has(key!)) continue;
    if (record.approved_rev !== null || record.closed_by === 'check' || record.closed_by === 'confirmed') entry.noise_ticks = 0;
    else if (record.closed_by === 'cancelled') entry.noise_ticks += 1;
  }

  const proposals: SelfEvalProposal[] = [];
  for (const [key, entry] of Object.entries(self_eval) as Array<[string, Json]>) {
    if (!entry || entry.proposed === true || entry.sessions_seen < SESSIONS_THRESHOLD) continue;
    let kind: SelfEvalProposal['kind'] | null = null;
    if (entry.noise_ticks >= TICK_THRESHOLD) kind = 'noisy';
    else if (entry.clean_ticks >= TICK_THRESHOLD) kind = key === WEIGHT_KEY ? 'weight' : 'clean';
    if (!kind) continue;
    entry.proposed = true;
    proposals.push({
      key,
      kind,
      clean_ticks: entry.clean_ticks,
      noise_ticks: entry.noise_ticks,
      sessions_seen: entry.sessions_seen,
    });
  }

  return { self_eval, proposals };
}
