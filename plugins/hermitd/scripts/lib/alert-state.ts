// Shared read/write helpers for the alert-state files. Atomic write mirrors
// lib/runtime.ts; the read splits the file read from the JSON parse so callers
// can tell a transient read error (healthy file — never destroy it) from genuine
// corruption (quarantine + rebuild). Path-parameterized: precheck derives the
// path from stateDir, update-alert-state takes argv.
//
// Alert entries are split across per-writer files so cross-process writers can't
// clobber each other's keys with a whole-file overwrite (the same reasoning that
// split pause.json out of runtime.json):
//   - alert-state.json     — skill/checklist alerts + self_eval + total_ticks
//                            (heartbeat-precheck, update-alert-state;
//                            within one heartbeat cycle, so merge-safe as before)
//   - budget-alerts.json   — budget-* alerts (cost-tracker, Stop hook — sole writer)
//   - telemetry-alert.json — the telemetry export-failed alert (report-export,
//                            watchdog tick — sole writer)
//   - doctor-alerts.json   — doctor:* finding episodes (doctor-check — sole writer).
//                            Split out because heartbeat's classifyTick rebuilds
//                            alerts{} from prevAlerts ∪ firing, so a doctor key
//                            parked in alert-state.json ages out after two clean
//                            ticks (issue #690).
// Each of the latter three has exactly one writer process, so the plain atomic
// tmp+rename write needs no lock. Generic readers that want "all alerts" call
// readMergedAlerts() to union the four files (keyspaces are disjoint by
// construction: checklist / budget-* / telemetry:* / doctor:*).

import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, listProposalFiles } from './frontmatter';
import { readMicroProposals } from './micro-proposals-io';
import { askedOutsideHome, homeChatKey } from './proposals/micro';
import { readSettledConfig } from './config-read';

type Json = any;

export function alertStatePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'alert-state.json');
}
export function budgetAlertsPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'budget-alerts.json');
}
export function telemetryAlertPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'telemetry-alert.json');
}
export function doctorAlertsPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'doctor-alerts.json');
}

export const defaultAlertState = (): Json =>
  ({ alerts: {}, last_digest_date: null, self_eval: {}, total_ticks: 0 });

export type AlertRead =
  | { kind: 'ok'; value: Json }
  | { kind: 'missing' }                  // ENOENT — first run, seed default
  | { kind: 'corrupt' }                  // bytes read, parse failed / not an object — quarantine
  | { kind: 'ioerror'; code?: string };  // EACCES/EMFILE/EIO/EISDIR — healthy file, DO NOT destroy

export function readAlertState(p: string): AlertRead {
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf-8'); }            // separate the read…
  catch (err: any) {
    return err?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'ioerror', code: err?.code };
  }
  try {
    const value = JSON.parse(raw);                       // …from the parse
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'corrupt' };
    return { kind: 'ok', value };
  } catch { return { kind: 'corrupt' }; }
}

export function quarantineAlertState(p: string, stamp: number): void {
  try { fs.renameSync(p, `${p}.corrupt-${stamp}`); } catch { /* fail-open */ }
}

// Returns whether the write actually landed — callers that derive side effects
// (monitoring lines, notifications) from a state change must gate on this and
// never emit for a change that didn't durably persist.
export function writeAlertState(p: string, obj: Json): boolean {
  try {
    const tmp = `${p}.${process.pid}.tmp`;
    // 0600 like doctor-check's writeReport: these files are rewritten on every tick, so a
    // default 0644 creation would undo any chmod the operator applies.
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // mode is only honored on create; a reused tmp path would keep its old bits
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; /* fail-open */ }
}

/**
 * Union of alert entries across the four per-writer files, for generic readers
 * (dashboard, telemetry bundle, the heartbeat budget scan) that
 * want the full alert view. Later files win on a key collision, but the keyspaces
 * are disjoint by construction. Unreadable/corrupt/missing files contribute nothing.
 */
export function readMergedAlerts(stateDir: string): Json {
  const merged: Json = {};
  for (const p of [alertStatePath(stateDir), budgetAlertsPath(stateDir), telemetryAlertPath(stateDir), doctorAlertsPath(stateDir)]) {
    const r = readAlertState(p);
    if (r.kind === 'ok' && r.value?.alerts && typeof r.value.alerts === 'object') {
      Object.assign(merged, r.value.alerts);
    }
  }
  return merged;
}

/**
 * Read-modify-write of a single-owner alert file (budget-alerts.json owned by
 * cost-tracker, telemetry-alert.json by report-export). One writer process per
 * file means the plain read → mutate → atomic write needs no lock. Corrupt →
 * quarantine + start fresh; ioerror (healthy-but-unreadable) → skip and return
 * false so the caller can decline to act on a state it couldn't read.
 */
export function mutateOwnedAlerts(p: string, mutator: (alerts: Json) => void): boolean {
  const read = readAlertState(p);
  if (read.kind === 'ioerror') return false;
  let state: Json = read.kind === 'ok' ? read.value : defaultAlertState();
  if (read.kind === 'corrupt') { quarantineAlertState(p, Date.now()); state = defaultAlertState(); }
  if (!state.alerts || typeof state.alerts !== 'object') state.alerts = {};
  mutator(state.alerts);
  return writeAlertState(p, state);
}

// ---------------------------------------------------------------------------
// Deterministic dedup/suppression/resolution/digest ladder (issue #594).
//
// Previously this bookkeeping was authored by the heartbeat eval subagent
// (a small model) directly into its JSON return — which intermittently
// invented schema fields, garbled keys, and could mark a still-pending
// micro-proposal `suppressed:true` (silencing a genuine Tier-1 operator
// decision). None of this needs judgment: it's a deterministic function of
// the prior alerts{} and the set of keys firing this tick. The subagent now
// returns only `{key, text}` pairs for items that need semantic judgment
// (checklist/custom/waiting-timeout); this ladder is prefix-agnostic — the
// caller (lib/heartbeat/alert-update.ts) is responsible for only including keys it
// trusts in `firing` (model judgment keys plus script-derived keys — see
// deriveMicroPendingKeys / deriveProposalPendingKeys below).
// ---------------------------------------------------------------------------

// `text` is an internal diagnostic label and may carry an id. `channelText` is the id-free operator-channel label; absent when `text`
// is already channel-safe (model-authored keys), read with `?? text`.
export interface FiringItem { key: string; text: string; channelText?: string; }

// Keys backed by a filesystem source-of-truth (see deriveMicroPendingKeys /
// deriveProposalPendingKeys). These are the ONLY code path that bakes a raw
// internal id into an alert's text, so channel-safety scrubbing is scoped to
// them. Shared with lib/heartbeat/alert-update.ts (phantom-key filter, freeze).
export const MICRO_PREFIX = 'micro-proposal-pending:';
export const PROPOSAL_PREFIX = 'proposal-pending:';
export const STRUCTURED_PREFIXES = [MICRO_PREFIX, PROPOSAL_PREFIX];
export const isStructuredKey = (key: string): boolean =>
  STRUCTURED_PREFIXES.some(p => key.startsWith(p));

// doctor:* episodes live in doctor-alerts.json, written by doctor-check.ts alone.
// Deliberately NOT in STRUCTURED_PREFIXES: those get id-scrubbing and first-fire
// channel silencing, neither of which applies here. Heartbeat's only relationship
// to this prefix is to purge v1.2.17–v1.2.24 residue out of alert-state.json
// (see lib/heartbeat/alert-update.ts) — it never fires or resolves a doctor key.
export const DOCTOR_PREFIX = 'doctor:';

// Strip internal ids that must never reach the operator channel. The banned set
// is the closed list in prompts/resident.md § Channel voice:
// "No internal IDs (PROP-NNN, task, MP-…)". Applied only to structured-keyed
// notifications (the sole id-injection path); model text is id-free by the
// reference.md contract, so it is never scrubbed (no false positives on legit
// operator text like "S-5 partition"). Collapse the whitespace the removal leaves.
export function scrubInternalIds(s: string): string {
  return s.replace(/\bPROP-\d+|\bMP-[\w-]+|\bS-\d+\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

export interface ClassifyTickResult {
  alerts: Json;
  monitoringLines: string[];
  notifications: string[];
  lastCleanEvalAt: string | null;
  lastDigestDate: string | null;
  heartbeatResult: 'ok' | 'alert';
  // Structured keys the digest batched under "Looks already done"; a 'clear'
  // reply resolves exactly these.
  digestDoneKeys: string[];
}

// Evaluator's re-check of a pending decision before the digest repeats it.
// Wording only: it never changes which keys the digest lists.
export interface DecisionRefresh { status: 'done' | 'partial'; text: string; }

// Suppressed rows still firing: exactly what the daily digest lists. The tick
// uses the same rule to pick which decision items the evaluator re-checks.
export function activeSuppressedEntries(alerts: Json): [string, Json][] {
  if (!alerts || typeof alerts !== 'object') return [];
  return Object.entries(alerts).filter(([, e]: [string, Json]) =>
    e?.suppressed === true && (e.consecutive_clean ?? 0) === 0);
}

export function classifyTick(opts: {
  prevAlerts: Json;
  firing: FiringItem[];
  nowIso: string;              // full ISO instant — for last_clean_eval_at
  today: string;                // tz-local YYYY-MM-DD — for first_seen/last_seen/last_digest_date
  hhmm: string;                  // tz-local HH:MM — for monitoring-line stamps
  prevLastDigestDate: string | null;
  // Keys whose `text` bakes in a raw internal id (PROP-NNN, MP-…) that must
  // never reach the operator channel (house channel-voice rule) — their
  // first-observation notification is suppressed. Returned diagnostic lines
  // retain ids; the caller does not persist them to task records.
  silentOnNewKeys: Set<string>;
  // False when a structured source-of-truth read was ambiguous this tick: the
  // digest is built over a partial view (frozen entries are excluded upstream),
  // so skip emitting it AND advancing last_digest_date — it re-fires next tick
  // once the read succeeds, rather than consuming the day's digest on a partial
  // view. Defaults to true (a normal tick).
  structuredReadOk?: boolean;
  // Fresh wording for structured keys the digest lists this tick. `partial`
  // relabels an item; `done` moves it into one trailing "Looks already done"
  // sentence. Every active key is still listed exactly once.
  refresh?: Map<string, DecisionRefresh>;
}): ClassifyTickResult {
  const { firing, nowIso, today, hhmm, silentOnNewKeys } = opts;
  const structuredReadOk = opts.structuredReadOk !== false;
  // Persist channelText on an entry only when it differs from text — model-key
  // entries thus gain no new field and stay byte-identical to pre-change state.
  const withChannel = (entry: Json, item: FiringItem): Json =>
    item.channelText && item.channelText !== item.text
      ? { ...entry, channelText: item.channelText } : entry;
  // Channel-safe label for a key: prefer the id-free channelText over text, then
  // scrub any embedded internal id for structured (filesystem-backed) keys.
  const channelLabel = (key: string, source: { text: string; channelText?: string }): string => {
    const label = source.channelText ?? source.text;
    return isStructuredKey(key) ? scrubInternalIds(label) : label;
  };
  const prevAlerts: Json = opts.prevAlerts && typeof opts.prevAlerts === 'object' ? opts.prevAlerts : {};
  const firingByKey = new Map(firing.map(f => [f.key, f]));
  const alerts: Json = {};
  const monitoringLines: string[] = [];
  const notifications: string[] = [];

  const allKeys = new Set([...Object.keys(prevAlerts), ...firingByKey.keys()]);
  for (const key of allKeys) {
    const item = firingByKey.get(key);
    const prev = prevAlerts[key];
    if (item) {
      if (!prev) {
        // Brand-new alert — notify once, on first observation (never repeated
        // on ticks 2-4; the operator already knows once told) — except keys
        // in silentOnNewKeys, whose text is not channel-safe.
        alerts[key] = withChannel({ count: 1, consecutive_clean: 0, suppressed: false, first_seen: today, last_seen: today, text: item.text }, item);
        monitoringLines.push(`[${hhmm}] Heartbeat: ${item.text}`);
        if (!silentOnNewKeys.has(key)) notifications.push(item.text);
      } else {
        // Stored `count` reflects observations BEFORE this fire, so the sixth
        // observation (prev.count===5) is what produces count:6 and trips
        // suppression — not the fifth. (#594 review: off-by-one in an earlier
        // draft of this ladder.)
        const count = (typeof prev.count === 'number' ? prev.count : 0) + 1;
        if (count <= 5) {
          alerts[key] = withChannel({ ...prev, count, consecutive_clean: 0, last_seen: today, text: item.text, suppressed: false }, item);
          monitoringLines.push(`[${hhmm}] Heartbeat: ${item.text}`);
        } else if (count === 6) {
          alerts[key] = withChannel({ ...prev, count, consecutive_clean: 0, last_seen: today, text: item.text, suppressed: true }, item);
          // The returned diagnostic follows the alert's own line in this result. The channel
          // notification names the alert id-free instead ("above" has no
          // referent in a channel message).
          monitoringLines.push(`[${hhmm}] Heartbeat: above alert suppressed after 5 fires (first: ${prev.first_seen}). Daily digest only.`);
          notifications.push(`Heartbeat: "${channelLabel(key, item)}" suppressed after 5 fires — daily digest only.`);
        } else {
          // count > 6 — silent; visible only via the daily digest below.
          alerts[key] = withChannel({ ...prev, count, consecutive_clean: 0, last_seen: today, text: item.text, suppressed: true }, item);
        }
      }
    } else if (prev) {
      const consecutive_clean = (typeof prev.consecutive_clean === 'number' ? prev.consecutive_clean : 0) + 1;
      if (consecutive_clean >= 2) {
        if (prev.suppressed !== true) monitoringLines.push(`[${hhmm}] Heartbeat: resolved — ${prev.text}`);
        // Suppressed → resolve silently, omit from the next digest. Entry dropped either way.
      } else {
        alerts[key] = { ...prev, consecutive_clean };
      }
    }
  }

  const suppressedEntries = Object.entries(alerts).filter(([, e]: [string, Json]) => e?.suppressed === true);
  // Only what is still firing belongs in the digest. A suppressed row whose
  // source went quiet is retained one extra tick for hysteresis (above), and
  // listing it re-announces something already settled — the operator reads the
  // digest as "these still need you".
  const activeEntries = activeSuppressedEntries(alerts);
  let lastDigestDate = opts.prevLastDigestDate ?? null;
  const digestDoneKeys: string[] = [];
  // structuredReadOk gate: don't emit or advance the digest on a partial view.
  if (structuredReadOk && suppressedEntries.length > 0 && lastDigestDate !== today) {
    if (activeEntries.length > 0) {
      // Age, not tick count: `count` counts evaluations, so rendering it invites
      // reading "8x" as eight messages sent when the ladder sent two.
      const doneTexts: string[] = [];
      const listed: string[] = [];
      for (const [k, e] of activeEntries) {
        const r = opts.refresh?.get(k);
        if (r?.status === 'done') {
          // Trailing punctuation would double up against the sentence's own.
          doneTexts.push(channelLabel(k, r).replace(/[.;\s]+$/, ''));
          digestDoneKeys.push(k);
        } else {
          listed.push(`${channelLabel(k, r ?? e)} (first seen ${e.first_seen})`);
        }
      }
      const done = doneTexts.length > 0
        ? `Looks already done: ${doneTexts.join('; ')}. Reply 'clear' to drop these.`
        : '';
      // A queued question can itself end in "Yes / No", so the done sentence
      // needs a hard stop before it to read as separate.
      notifications.push(`Suppressed alert digest: ${[listed.join('; '), done].filter(Boolean).join('. ')}`);
    }
    // Stamp the day even when nothing was active. precheck's digest gate wakes
    // on ANY suppressed entry, so an unstamped date would re-fire a paid
    // EVALUATE every poll until the hysteresis rows finally drop.
    lastDigestDate = today;
  }

  // "Clean" means nothing the operator has not already been told about, not nothing
  // fired (#783). A key with a prior entry re-fires on every tick for as long as its
  // source-of-truth says so (a proposal sitting at `status: proposed` re-derives its
  // key forever), and the ladder above sends nothing on repeats until count===6 —
  // whatever the text says. Counting those repeats as un-clean starved
  // last_clean_eval_at, leaving precheck's clean-recheck damper disarmed for the
  // first five fires: every poll became a paid EVALUATE for news already delivered.
  // Only a brand-new key reads as actionable.
  const isClean = firing.every(f => !!prevAlerts[f.key]);

  return {
    alerts,
    monitoringLines,
    notifications,
    lastCleanEvalAt: isClean ? nowIso : null,
    lastDigestDate,
    heartbeatResult: isClean ? 'ok' : 'alert',
    digestDoneKeys,
  };
}

// ---------------------------------------------------------------------------
// Structured-key derivation (issue #594, scope A′).
//
// `micro-proposal-pending:<id>` and `proposal-pending:<PROP-NNN>` are backed
// by a filesystem source-of-truth (micro-proposals.json / proposals/*.md
// frontmatter), and each silences a still-pending operator decision when
// suppressed. Leaving these to the model means a single garbled/omitted key
// can silently resolve a real pending decision two ticks later (the
// demonstrated #594 failure). Deriving them here means the model never
// authors them — omission or garbling by the model is simply impossible,
// because the model's `firing` entries for these prefixes are ignored
// (see lib/heartbeat/alert-update.ts's phantom-key filter).
//
// `ok:false` signals an ambiguous read (not "nothing pending") — the caller
// must not let an unreadable source-of-truth file age or resolve that
// prefix's existing alerts; it must freeze them untouched for the tick.
// ---------------------------------------------------------------------------

export function deriveMicroPendingKeys(stateDir: string): { ok: boolean; items: FiringItem[]; error?: string } {
  const read = readMicroProposals(path.join(stateDir, 'state', 'micro-proposals.json'));
  if (read.status === 'corrupt') return { ok: false, items: [], error: read.error };
  if (read.status === 'missing') return { ok: true, items: [] };
  const pending = read.data.pending;
  // Heartbeat alerts reach the home chat, which cannot answer another chat's entry.
  const home = homeChatKey(readSettledConfig(stateDir).channels);
  const items: FiringItem[] = [];
  for (const entry of pending) {
    if (!entry || entry.status !== 'pending' || entry.tier !== 1 || typeof entry.id !== 'string') continue;
    if (askedOutsideHome(entry, home)) continue;
    const question = typeof entry.question === 'string' ? entry.question : '';
    let text = `micro-proposal '${entry.id}' awaiting operator input — ${question}`;
    // channelText omits the raw MP- id (channel-voice rule); keeps question + options.
    let channelText = `a decision awaiting your input — ${question}`;
    if (Array.isArray(entry.options) && entry.options.length > 0) {
      const opts = ' [' + entry.options.map((o: any, i: number) => `${i + 1}: ${o}`).join(', ') + ']';
      text += opts;
      channelText += opts;
    }
    items.push({ key: `micro-proposal-pending:${entry.id}`, text, channelText });
  }
  return { ok: true, items };
}

export function deriveProposalPendingKeys(stateDir: string): { ok: boolean; items: FiringItem[] } {
  const dir = path.join(stateDir, 'proposals');
  const listed = listProposalFiles(dir);
  if (!listed.ok) return { ok: false, items: [] };
  const items: FiringItem[] = [];
  for (const f of listed.files) {
    // Match deriveMicroPendingKeys' fail-safe: an ambiguous per-file read
    // (EACCES/EIO/EISDIR — realistic under the Docker runtime) must freeze the
    // whole prefix, never silently drop a `status: proposed` file (which would
    // age its pending alert toward resolution — the exact #594 harm). ENOENT
    // (file vanished mid-scan) is unambiguous → skip it and let its alert resolve.
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      return { ok: false, items: [] };
    }
    const fm = parseFrontmatter(raw);
    if (!fm || fm.status !== 'proposed') continue; // legacy/no-frontmatter/malformed/not-proposed — skip this file only
    const m = f.match(/^(PROP-\d+)/);
    if (!m) continue;
    const id = m[1];
    const title = typeof fm.title === 'string' && fm.title ? fm.title : null;
    // Pre-rendered so the daily digest needs no second frontmatter read: falls
    // back to the bare id on zero/multiple-match (no title found), never blocks.
    // channelText omits the raw PROP- id (channel-voice rule); title-only.
    items.push({
      key: `proposal-pending:${id}`,
      text: title ? `${id} "${title}"` : id,
      channelText: title ? `proposal "${title}" awaiting review` : 'a proposal awaiting review',
    });
  }
  return { ok: true, items };
}
