// Updates alert-state.json after a heartbeat evaluation tick. Owns the full
// dedup/suppression/resolution/digest ladder (issue #594): the eval subagent
// returns only a firing set of {key,text} judgment items; this script derives
// the file-backed structured keys (micro-proposal-pending, proposal-pending)
// from their source-of-truth and runs the deterministic ladder over the union.
// Zero npm dependencies, Node stdlib only.
//
// Fail-safe contract: ANY validation failure or write failure leaves
// alert-state.json byte-identical and prints one stdout JSON line
// with heartbeat_result:"INDETERMINATE" and a reason. The caller (SKILL.md
// step 5) echoes HEARTBEAT_INDETERMINATE (<reason>) instead of HEARTBEAT_OK.
// Only a genuinely unparseable input payload exits 1; every other reject path
// exits 0 (unchanged from before this refactor).
//
// On success, prints notifications, self-evaluation proposals and the verdict.
// Sending stays with the caller after the durable state write.
//
// The eval JSON is read from stdin (not argv) so free-text alert content can't
// break shell quoting.
// Usage: bun heartbeat.ts alert-state <state-file-path>   # eval-json on stdin

import path from 'node:path';
import { runSelfEval, type SelfEvalProposal } from './self-eval';
import {
  readAlertState, defaultAlertState, quarantineAlertState, writeAlertState,
  classifyTick, deriveMicroPendingKeys, deriveProposalPendingKeys, FiringItem, DecisionRefresh,
  MICRO_PREFIX, PROPOSAL_PREFIX, DOCTOR_PREFIX, isStructuredKey, scrubInternalIds,
} from '../alert-state';
import { currentHHMM, todayYMD, resolveHermitNowMs } from '../time';
import { readSettledConfig } from '../config-read';
import { canonicalChecklistKeys, normalizeItemKey, normalizeCustomKey } from '../heartbeat-items';

type Json = any;

const stateFile = process.argv[2];

if (!stateFile) {
  console.error('Usage: bun heartbeat.ts alert-state <state-file-path>   # eval-json on stdin');
  process.exit(1);
}

// stateFile = <stateDir>/state/alert-state.json
const stateDir = path.dirname(path.dirname(stateFile));

// Keys backed by a filesystem source-of-truth — the model may never author
// these directly (see deriveMicroPendingKeys/deriveProposalPendingKeys). A
// model-injected entry under either prefix is a phantom and is dropped.
// MICRO_PREFIX/PROPOSAL_PREFIX/isStructuredKey are owned by alert-state.ts
// (co-located with the derivers and the channel-safe scrub).

type RawFiring = { key?: string; item?: string; text: string };

// Reject the whole tick (return null) rather than coerce a malformed shape to
// an empty set — an empty set would age every real alert toward resolution.
function validateFiring(raw: Json): RawFiring[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RawFiring[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.text !== 'string') return null;
    const key = typeof entry.key === 'string' && entry.key ? entry.key : undefined;
    const item = typeof entry.item === 'string' && entry.item ? entry.item : undefined;
    if (!key && !item) return null;
    out.push({ key, item, text: entry.text });
  }
  return out;
}

// Lenient, unlike validateFiring: `refresh` only rewords the digest, so a bad
// value degrades to no refresh instead of costing the tick. Only keys this
// script derived from their source of truth are accepted; `open` needs no
// entry because the queued text already stands.
const REFRESH_TEXT_MAX = 300;
function parseRefresh(raw: Json, derivedKeys: Set<string>): Map<string, DecisionRefresh> {
  const out = new Map<string, DecisionRefresh>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, status, text } = entry;
    if (typeof key !== 'string' || !derivedKeys.has(key) || out.has(key)) continue;
    if (status !== 'done' && status !== 'partial') continue;
    if (typeof text !== 'string') continue;
    // One line in the digest; text that is only an internal id would scrub to nothing.
    const line = text.replace(/\s+/g, ' ').trim();
    if (!scrubInternalIds(line).replace(/[.;\s]+$/, '')) continue;
    out.set(key, { status, text: line.slice(0, REFRESH_TEXT_MAX) });
  }
  return out;
}

// Keys the model may never author. Returned verbatim so the modelFiring filter
// below still recognises and drops them — minting a `custom:` key for one instead
// would smuggle a phantom past that guard, with its raw PROP-NNN/MP-… id
// un-scrubbed on the way to the channel.
const isReservedKey = (key: string): boolean =>
  isStructuredKey(key) || key.startsWith(DOCTOR_PREFIX);

function resolveEntryKey(entry: RawFiring, canonical: Set<string>): string | null {
  if (entry.key === 'waiting-timeout' || (entry.key && entry.key.startsWith('custom:'))) {
    return entry.key;
  }
  if (entry.key && isReservedKey(entry.key)) return entry.key;
  if (entry.item) {
    const derived = normalizeItemKey(entry.item);
    if (derived && canonical.has(derived)) return derived;
  }
  if (entry.key && canonical.has(entry.key)) return entry.key;
  // `key` before `text`: text is a channel-voice one-liner the eval subagent
  // rewords tick to tick, so deriving the fallback from it would mint a fresh
  // key every tick — the entry would never age to suppression or resolution and
  // would re-notify the operator forever.
  return normalizeCustomKey(entry.item || entry.key || entry.text || '');
}

function resolveFiring(entries: RawFiring[], canonical: Set<string> | null): FiringItem[] | null {
  if (canonical === null) {
    if (entries.some(e => !e.key)) return null;
  }
  const seen = new Set<string>();
  const out: FiringItem[] = [];
  for (const entry of entries) {
    const key = canonical === null ? entry.key! : resolveEntryKey(entry, canonical);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, text: entry.text });
  }
  return out;
}

// Reject path: prints the INDETERMINATE contract without touching alert-state.json. Exit code matches
// today's contract: 1 only for invalid-json (unparseable payload), 0 for
// every other reason.
function indeterminate(reason: string, exitCode: 0 | 1 = 0): never {
  process.stdout.write(JSON.stringify({
    notifications: [],
    self_eval_proposals: [],
    heartbeat_result: 'INDETERMINATE',
    reason,
  }) + '\n');
  process.exit(exitCode);
}

function apply(payloadJson: string): void {
  let payload: Json;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err: any) {
    console.error(`update-alert-state: invalid payload JSON: ${err.message}`);
    indeterminate('invalid-json', 1);
  }

  // `JSON.parse('null')` parses fine but has no properties — reading `.firing`
  // off it throws, which would bypass the reject contract entirely (no stdout,
  // no monitoring line, a stack trace on exit 1).
  if (!payload || typeof payload !== 'object') indeterminate('missing-or-malformed-firing');

  const validated = validateFiring(payload.firing);
  if (validated === null) indeterminate('missing-or-malformed-firing'); // malformed firing shape — reject the tick, no write
  const canonical = canonicalChecklistKeys(stateDir);
  const resolved = resolveFiring(validated, canonical);
  if (resolved === null) indeterminate('unresolvable-firing');
  const modelFiring = resolved.filter(f => !isReservedKey(f.key));

  // Split read from parse: a transient read error (ioerror) must not clobber a healthy
  // file. ENOENT = first run → seed default. corrupt = bytes read but unparseable →
  // quarantine for forensics, then merge onto a default. ioerror = bail without writing.
  let state: Json;
  const r = readAlertState(stateFile);
  if (r.kind === 'ok') {
    state = r.value;
  } else if (r.kind === 'missing') {
    state = defaultAlertState();
  } else if (r.kind === 'corrupt') {
    quarantineAlertState(stateFile, Date.now());
    state = defaultAlertState();
  } else {
    console.error(`update-alert-state: read failed (${r.code ?? 'unknown'}); skipping write`);
    indeterminate(`read-failed:${r.code ?? 'unknown'}`);
  }

  const prevAlerts: Json = state.alerts && typeof state.alerts === 'object' ? state.alerts : {};

  const config = readSettledConfig(stateDir);
  const timezone = config.timezone ?? 'UTC';
  const nowDate = new Date(resolveHermitNowMs());
  const nowIso = nowDate.toISOString();
  const today = todayYMD(timezone, nowDate);
  const hhmm = currentHHMM(timezone, nowDate) ?? nowIso.slice(11, 16);

  const micro = deriveMicroPendingKeys(stateDir);
  const proposal = deriveProposalPendingKeys(stateDir);

  // Fail-safe: an ambiguous source-of-truth read must never age or resolve
  // that prefix's existing entries this tick (the exact #594 harm this
  // refactor exists to prevent) — freeze them untouched instead.
  const frozen: Json = {};
  const classifiable: Json = { ...prevAlerts };

  // Retire doctor:* residue left in alert-state.json by v1.2.17–v1.2.24, when
  // doctor's escalation payload was still honoured by this writer (issue #690).
  // Dropped silently — no monitoring line, no notification, no resolution ping:
  // those entries carry `detail` but neither `text` nor `suppressed`, so aging
  // them through classifyTick emits a literal "resolved — undefined" into
  // alert state. doctor-check.ts owns this prefix now, in its own file.
  for (const k of Object.keys(classifiable)) {
    if (k.startsWith(DOCTOR_PREFIX)) delete classifiable[k];
  }
  const freezePrefix = (prefix: string) => {
    for (const k of Object.keys(classifiable)) {
      if (k.startsWith(prefix)) { frozen[k] = classifiable[k]; delete classifiable[k]; }
    }
  };
  if (!micro.ok) freezePrefix(MICRO_PREFIX);
  if (!proposal.ok) freezePrefix(PROPOSAL_PREFIX);

  // An ambiguous structured read means this tick's view is partial: never report
  // a verified-clean eval (would arm the precheck damper over an unverifiable
  // pending decision) and never emit/advance the digest on a partial view.
  const hasStructuredReadFailure = !micro.ok || !proposal.ok;

  const structuredItems = [...(micro.ok ? micro.items : []), ...(proposal.ok ? proposal.items : [])];
  const firing: FiringItem[] = [...modelFiring, ...structuredItems];

  // Structured keys' text bakes in a raw PROP-NNN/MP-… id, which must never
  // reach the operator channel (house channel-voice rule) — silence their
  // first-observation notification. Internal diagnostic lines are unaffected.
  const silentOnNewKeys = new Set(structuredItems.map(i => i.key));

  const result = classifyTick({
    prevAlerts: classifiable,
    firing,
    nowIso,
    today,
    hhmm,
    prevLastDigestDate: typeof state.last_digest_date === 'string' ? state.last_digest_date : null,
    silentOnNewKeys,
    structuredReadOk: !hasStructuredReadFailure,
    refresh: parseRefresh(payload.refresh, silentOnNewKeys),
  });

  const alerts: Json = { ...result.alerts, ...frozen };

  // The freeze above keeps a corrupt source-of-truth from resolving real pending
  // decisions, but on its own it is silent: frozen entries produce no firing item,
  // so classifyTick emits nothing and the digest gate is off by design — the operator
  // is never told their pending questions became unreadable (#764). Notify directly,
  // once per day, for as long as the read keeps failing. Channel-voice split: the
  // operator gets plain language; parser details stay in internal diagnostic lines.
  const shouldNotifyStructuredFailure =
    hasStructuredReadFailure && state.structured_read_failure_notified_date !== today;
  if (shouldNotifyStructuredFailure) {
    const failedSources = [
      !micro.ok && 'micro-proposals.json',
      !proposal.ok && 'proposals/',
    ].filter(Boolean) as string[];
    result.notifications.push(
      "I can't read the record of decisions waiting on you — some may be pending without showing up. It needs a repair before I can see them again.",
    );
    result.monitoringLines.push(
      `[${hhmm}] Heartbeat: structured read failure (${failedSources.join(', ')})` +
      (micro.error ? ` — ${micro.error}` : '') + '. Pending-decision alerts frozen.');
  }
  // Clear the stamp the moment the read recovers: a file repaired and re-broken later
  // the same day is a NEW incident, and carrying the old stamp would silence it.
  let structuredFailureNotifiedDate: string | null;
  if (!hasStructuredReadFailure) {
    structuredFailureNotifiedDate = null;
  } else if (shouldNotifyStructuredFailure) {
    structuredFailureNotifiedDate = today;
  } else {
    structuredFailureNotifiedDate = typeof state.structured_read_failure_notified_date === 'string'
      ? state.structured_read_failure_notified_date
      : null;
  }

  // Retain checklist firing evidence until the every-20-ticks self-evaluation.
  // Recovery can remove an alert before that boundary; suppression only changes
  // notifications, so record the firing set rather than monitoring output.
  let self_eval: Json = { ...(state.self_eval && typeof state.self_eval === 'object' ? state.self_eval : {}) };
  for (const { key } of modelFiring) {
    if (!canonical?.has(key)) continue;
    self_eval[key] = { ...self_eval[key], fired_since_self_eval: true };
  }
  let selfEvalProposals: SelfEvalProposal[] = [];
  if (typeof state.total_ticks === 'number' && state.total_ticks % 20 === 0) {
    try {
      const evaluated = runSelfEval({
        stateDir,
        prevSelfEval: self_eval,
        alerts,
        today,
      });
      self_eval = evaluated.self_eval;
      selfEvalProposals = evaluated.proposals;
    } catch { /* fail-open: the tick's alert bookkeeping still lands */ }
  }

  // Spread state first so precheck-owned fields (total_ticks, last_micro_corrupt_wake_at) are preserved.
  const updated = {
    ...state,
    alerts,
    self_eval,
    // null on an ambiguous read disables the precheck clean-recheck damper, so
    // the next tick re-derives the moment the source file is readable again.
    last_clean_eval_at: hasStructuredReadFailure ? null : result.lastCleanEvalAt,
    last_digest_date: result.lastDigestDate,
    structured_read_failure_notified_date: structuredFailureNotifiedDate,
  };

  const wrote = writeAlertState(stateFile, updated);
  if (!wrote) indeterminate('write-failed'); // fail-safe: no durable write → emit no side effects

  process.stdout.write(JSON.stringify({
    notifications: result.notifications,
    self_eval_proposals: selfEvalProposals,
    // Never OK when a structured pending decision couldn't be verified this tick.
    heartbeat_result: hasStructuredReadFailure ? 'ALERT' : result.heartbeatResult,
    ...(result.digestDoneKeys.length > 0 ? { digest_done: result.digestDoneKeys } : {}),
  }) + '\n');

  process.exit(0);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buf += chunk; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => { apply(buf.trim()); });
