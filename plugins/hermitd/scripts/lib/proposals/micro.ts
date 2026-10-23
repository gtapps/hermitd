// `proposal.ts micro <stateDir> …` — mutates state/micro-proposals.json for the
// micro-approval queue. Every mutation goes through here so the file is only ever
// written by JSON.stringify (issue 649: hand-edited JSON left a trailing comma, and
// every reader treats an unparseable file as an empty queue).
// Usage:
//   proposal.ts micro <hermit-state-dir> resolve <MP-id> --action approved|rejected|answered|expired [--answer "<label>"]
//   proposal.ts micro <hermit-state-dir> brief-cycle
//   proposal.ts micro <hermit-state-dir> match [<MP-id>] [--chat <sourceKey>:<chat_id>] --reply <token>
//   proposal.ts micro <hermit-state-dir> stamp-chat
// Output (stdout, one JSON line):
//   match: {"status":"match","id","question","answer","tier","on_resolve":<string|null>}
//          With --chat, only entries asked in that chat are visible; without it
//          (a terminal turn), every pending entry is.
//          {"status":"ambiguous","reason","choices":[{"id","options":[...]}]}
//          {"status":"none","reason":"no_pending"|"no_match"}
//   resolve: {"status":"resolved","id","action"} / {"status":"none","reason":"no_match"}
//   stamp-chat: {"status":"stamped","stamped":<n>}, giving each pending entry
//          without a `chat` the home chat; {"status":"skipped","reason":"no_home_chat"}
//          when no channel can be the home.
//   brief-cycle: {"new":[{id,tier,question,options}],
//                      "renudged":[{id,tier,question,options,follow_up_count}],
//                      "expired":[{id,question}],
//                      "dropped":[<id>]}
// brief-cycle ages the whole queue in one pass so the brief skills drive the
// count-0/1/2+ lifecycle through one call instead of one per entry: any entry
// whose status isn't "pending" (issue 676 - a caller resolved it elsewhere but
// left it in the array) is pruned into `dropped`, no ledger event (its
// resolution is already recorded). Of the rest: count-0 entries are reported
// for first display and bumped to 1, count-1 entries reported and re-nudged
// (bumped to 2), count>=2 entries expired. One atomic write (only when
// something changed), one micro-resolved ledger line per expiry.
// Failures print {"error":"<token>"} and exit 1: `usage`, `unknown_verb`,
// `missing_id` (absent or flag-shaped <MP-id>), `invalid_action`, `queue_corrupt`
// (micro-proposals.json unparseable, never overwritten), `invalid_options`, and
// `event_unrecorded:<MP-id>` (the queue write landed but its micro-resolved
// ledger line did not: do not re-run, append it by hand). Every malformed
// invocation fails loud rather than
// exiting 0 on `no_match`: a silent no-op is the failure mode this script
// exists to remove. (Targeted resolve keeps `no_match` exit 0 for a well-formed
// but absent id: channel-responder's benign double-resolve relies on it;
// brief-cycle never reports none.)
// Implements channel-responder/approvals.md § Micro-approval response and
// brief/SKILL.md's MP lifecycle step.

import path from 'node:path';
import { utcISOStamp } from '../time';
import { appendJsonlLine } from '../append-jsonl';
import { writeFileAtomic } from '../md-write';
import { emitJson, flagValue } from '../cli';
import { readMicroProposals } from '../micro-proposals-io';
import { listProposalFiles, readFrontmatter } from '../frontmatter';
import { readSettledConfig } from '../config-read';
import { resolve as resolveHomeTarget } from '../../resolve-outbound-channel';
import { conversationKey, isKey } from '../conversation-key';

type Json = any;

/** The `<sourceKey>:<chat_id>` key of the home chat unattended notices go to, or null. */
export function homeChatKey(channels: Json): string | null {
  const target = resolveHomeTarget(channels);
  return target ? conversationKey(target.id, target.chat_id) : null;
}

/** True when the entry belongs to a chat other than the home chat, so a home-chat reply cannot answer it. */
export function askedOutsideHome(entry: Json, home: string | null): boolean {
  return typeof entry?.chat === 'string' && entry.chat !== home;
}

const ACTIONS = ['approved', 'rejected', 'answered', 'expired'];

// A proposal in one of these states can no longer consume an "how should I
// implement this?" answer, so the ask it parked is moot. Re-accepting a
// deferred proposal queues a fresh entry, so sweeping it loses nothing.
export const MOOT_STATUSES = ['resolved', 'dismissed', 'deferred'];

function none(reason: string): never {
  return emitJson({ status: 'none', reason });
}

function fail(error: string): never {
  return emitJson({ error });
}

// Age the whole pending queue in one pass. Bucketing mirrors the per-entry rules
// the brief skills used to issue one call at a time: any non-"pending" status is
// pruned first (issue 676), then count 0 -> report + bump to 1, count 1 ->
// report + bump to 2, count >=2 -> expire. Ledger lines are appended only after
// the queue write lands (same ordering as the resolve path).
function briefCycle(dir: string): never {
  const mp = path.join(dir, 'state', 'micro-proposals.json');
  const r = readMicroProposals(mp);
  if (r.status === 'corrupt') fail('queue_corrupt');
  const data: Json = r.status === 'missing' ? { pending: [] } : r.data;
  // readMicroProposals guarantees data.pending is an array on 'ok' (non-array is
  // 'corrupt', bailed above; undefined/null is healed to []), and 'missing' set [].
  const pending: Json[] = data.pending;

  const fresh: Json[] = [];
  const renudged: Json[] = [];
  const expired: Json[] = [];
  const dropped: Json[] = [];
  const kept: Json[] = [];
  // The brief posts in the home chat, where only home-chat entries can be
  // answered; entries asked elsewhere still age and expire but are not listed.
  const home = homeChatKey(readSettledConfig(dir).channels);

  for (const e of pending) {
    // Whitelist, not blacklist — the wild holds accepted/dismissed/rejected/
    // approved/resolved, none of which the script itself ever writes. The `!e`
    // guard mirrors every other reader (generate-summary, startup-context,
    // channel-status-responder): a hand-edited `null` element must not throw
    // and take the whole brief step down with it.
    if (!e || e.status !== 'pending') {
      dropped.push(e?.id ?? null);
      continue; // already resolved elsewhere; no ledger event, no re-report
    }
    const c = typeof e.follow_up_count === 'number' ? e.follow_up_count : 0;
    if (c >= 2) {
      expired.push({ id: e.id, question: e.question });
      continue; // dropped from the queue
    }
    // `tier` rides along: the brief skills render "MP-… (tier N): <question>" and
    // are told not to re-read the queue file, so the verdict is their only source.
    if (c === 1) {
      e.follow_up_count = 2;
      if (!askedOutsideHome(e, home)) renudged.push({ id: e.id, tier: e.tier, question: e.question, options: e.options, follow_up_count: 2 });
    } else {
      // Bump 0 -> 1 on first display so the documented lifecycle actually ages
      // the entry (issue 676: nothing else ever bumped it).
      e.follow_up_count = 1;
      if (!askedOutsideHome(e, home)) fresh.push({ id: e.id, tier: e.tier, question: e.question, options: e.options });
    }
    kept.push(e);
  }

  // Every entry lands in exactly one of dropped/expired/renudged/fresh, so a
  // non-empty queue always changes something on this pass.
  if (pending.length > 0) {
    data.pending = kept;
    writeFileAtomic(mp, JSON.stringify(data, null, 2) + '\n');
    const ledger = path.join(dir, 'state', 'proposal-metrics.jsonl');
    for (const e of expired) {
      const event: Json = { ts: utcISOStamp(), type: 'micro-resolved', micro_id: e.id, action: 'expired', question: e.question };
      const err = appendJsonlLine(ledger, JSON.stringify(event));
      if (err) fail(`event_unrecorded:${e.id}`);
    }
  }

  emitJson({ new: fresh, renudged, expired, dropped });
}

// --- Moot-ask reconciliation -----------------------------------------------
// An ask parked by proposal-act's accept flow can be settled elsewhere: the
// hermit implements it in-session, the operator resolves/dismisses/defers the
// proposal, or reflect auto-resolves it. Nothing then cleared the queue entry,
// so the heartbeat kept deriving a pending-decision alert from a question that
// no longer meant anything. The proposal-status writers call sweepMoot() on
// every moot-status write.

const PROPOSAL_ID_RE = /^PROP-(\d+)$/;
// Legacy entries (queued before `proposal_id` existed) carry the link only
// inside the accept callback. Match that documented shape alone: `on_resolve`
// is free-form — channel-responder lets any skill set it — so a bare PROP-NNN
// occurring anywhere in an arbitrary command is not a declared link.
const LEGACY_LINK_RE = /proposal-act accept (PROP-\d+)/;

// Canonical ids are zero-padded to 3 digits (proposals/resolve.ts does the same
// on operator input). Normalizing both sides keeps an unpadded `PROP-19` in a
// legacy on_resolve from silently missing `PROP-019-*.md`.
export function normalizeProposalId(id: string): string | null {
  const m = PROPOSAL_ID_RE.exec(id);
  return m ? `PROP-${m[1].padStart(3, '0')}` : null;
}

export function linkedProposalId(entry: Json): string | null {
  if (typeof entry.proposal_id === 'string') {
    const norm = normalizeProposalId(entry.proposal_id);
    if (norm) return norm;
  }
  if (typeof entry.on_resolve === 'string') {
    const m = LEGACY_LINK_RE.exec(entry.on_resolve);
    if (m) return normalizeProposalId(m[1]);
  }
  return null;
}

// Boundary-safe: `PROP-1` must never match `PROP-12` (same rule as
// apply-reflection-actions.ts), and the legacy slug-less `PROP-NNN.md` form
// still counts. Zero or multiple matches are ambiguous — never destructive.
function proposalStatus(proposalsDir: string, files: string[], id: string): string | null {
  const matches = files.filter(f => f.startsWith(`${id}-`) || f === `${id}.md`);
  if (matches.length !== 1) return null;
  const fm = readFrontmatter(path.join(proposalsDir, matches[0]));
  return fm && typeof fm.status === 'string' ? fm.status : null;
}

export type SweepResult = { ok: boolean; swept: string[]; error?: string };

/**
 * Remove pending asks linked to `proposalId` once that proposal has reached a
 * moot status. Called by the proposal-status writers.
 * Never throws: an unreadable queue or proposals dir returns ok:false and
 * leaves both untouched, so a caller that already wrote a proposal can report
 * the miss without pretending its own write failed.
 */
export function sweepMoot(stateDir: string, proposalId: string): SweepResult {
  const target = normalizeProposalId(proposalId);
  if (!target) return { ok: false, swept: [], error: `not a proposal id: ${proposalId}` };

  const microPath = path.join(stateDir, 'state', 'micro-proposals.json');
  const read = readMicroProposals(microPath);
  if (read.status === 'missing') return { ok: true, swept: [] };
  if (read.status === 'corrupt') return { ok: false, swept: [], error: read.error };
  const micro: Json = read.data;
  // Same `!e` tolerance as every other reader: a hand-edited null element must not
  // throw. Non-pending rows are brief-cycle's to prune, not ours.
  const linked = (e: Json) => !!e && e.status === 'pending' && linkedProposalId(e) === target;
  // No ask to sweep means the proposal's status is moot too: skip reading it.
  if (!micro.pending.some(linked)) return { ok: true, swept: [] };

  const proposalsDir = path.join(stateDir, 'proposals');
  const listed = listProposalFiles(proposalsDir);
  if (!listed.ok) return { ok: false, swept: [], error: 'proposals/ is unreadable — nothing swept' };

  const status = proposalStatus(proposalsDir, listed.files, target);
  if (status === null || !MOOT_STATUSES.includes(status)) return { ok: true, swept: [] };
  const kept: Json[] = [];
  const removed: Json[] = [];

  for (const e of micro.pending) {
    if (!linked(e)) { kept.push(e); continue; }
    removed.push({ id: e.id, question: e.question, proposal_id: target, proposal_status: status });
  }

  micro.pending = kept;
  try { writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n'); }
  catch (err: any) { return { ok: false, swept: [], error: `micro-proposals.json write failed (${err.message})` }; }

  // Ledger after the write lands, matching the resolve path's ordering.
  // `moot` is its own action: reflect reads a high `expired` rate as poor
  // question timing, which a settled proposal says nothing about.
  const ledger = path.join(stateDir, 'state', 'proposal-metrics.jsonl');
  // Keep appending past a failure and name every id that went unrecorded: the
  // queue write already landed for all of them, so bailing on the first error
  // would leave the later removals silently absent from the ledger AND absent
  // from the message the caller reports.
  const unrecorded: string[] = [];
  let ledgerError: string | null = null;
  for (const r of removed) {
    const event: Json = {
      ts: utcISOStamp(), type: 'micro-resolved', micro_id: r.id, action: 'moot',
      question: r.question, proposal_id: r.proposal_id, proposal_status: r.proposal_status,
    };
    const err = appendJsonlLine(ledger, JSON.stringify(event));
    if (err) { unrecorded.push(r.id); ledgerError = err; }
  }
  if (unrecorded.length > 0) {
    return {
      ok: false,
      swept: removed.map(x => x.id),
      error: `${ledgerError} — ${unrecorded.join(', ')} removed from pending but the micro-resolved event was NOT recorded.`,
    };
  }

  return { ok: true, swept: removed.map(r => r.id) };
}

// Read-only matching leaves resolution and its write ordering with resolve.
function matchReply(stateDir: string, args: string[]): never {
  let id: string | undefined;
  let chat: string | undefined;
  let rawReply: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--reply' || arg === '--chat') {
      const value = args[++i];
      if (value === undefined || (arg === '--reply' ? rawReply : chat) !== undefined) fail('usage');
      if (arg === '--reply') rawReply = value;
      else chat = value;
    } else if (i === 1 && !arg.startsWith('-')) {
      id = arg;
    } else {
      fail('usage');
    }
  }
  if (rawReply === undefined || (chat !== undefined && !isKey(chat))) fail('usage');
  const reply = rawReply.trim().toLowerCase();
  const read = readMicroProposals(path.join(stateDir, 'state', 'micro-proposals.json'));
  if (read.status === 'corrupt') fail('queue_corrupt');
  const pending: Json[] = read.status === 'missing' ? []
    : read.data.pending.filter((entry: Json) => entry?.status === 'pending'
      && (chat === undefined || entry.chat === chat));
  if (!pending.length) none('no_pending');
  const entry = id ? pending.find(entry => entry.id === id) : pending[0];
  if (!entry) none('no_match');

  const ambiguous = (reason: string, entries: Json[]): never => emitJson({
    status: 'ambiguous', reason,
    choices: entries.map(entry => ({ id: entry.id, options: entry.options ?? ['yes', 'no'] })),
  });
  if (!id && pending.length > 1) ambiguous('multiple_pending', pending);
  let answer: string;
  if (entry.options === undefined) {
    if (reply !== 'yes' && reply !== 'no') none('no_match');
    answer = reply;
  } else {
    if (!Array.isArray(entry.options) || !entry.options.every((label: unknown) => typeof label === 'string')) {
      fail('invalid_options');
    }
    const options: string[] = entry.options;
    if (reply === 'yes' || reply === 'no') ambiguous('options_require_choice', [entry]);
    if (/^[+-]?\d+$/.test(reply)) {
      const index = Number(reply) - 1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= options.length) {
        ambiguous('number_out_of_range', [entry]);
      }
      answer = options[index];
    } else {
      const matches = reply ? options.filter(label => label.toLowerCase().startsWith(reply)) : [];
      if (!matches.length) none('no_match');
      if (matches.length > 1) ambiguous('multiple_labels', [entry]);
      answer = matches[0];
    }
  }
  emitJson({ status: 'match', id: entry.id, question: entry.question, answer, tier: entry.tier, on_resolve: entry.on_resolve ?? null });
}

// One-time upgrade step: entries queued before `chat` existed were asked in the home chat.
function stampChat(stateDir: string, args: string[]): never {
  if (args.length !== 1) fail('usage');
  const microPath = path.join(stateDir, 'state', 'micro-proposals.json');
  const read = readMicroProposals(microPath);
  if (read.status === 'corrupt') fail('queue_corrupt');
  const micro: Json = read.status === 'missing' ? { pending: [] } : read.data;
  const unstamped = micro.pending.filter((e: Json) => e?.status === 'pending' && typeof e.chat !== 'string');
  if (!unstamped.length) emitJson({ status: 'stamped', stamped: 0 });
  const home = homeChatKey(readSettledConfig(stateDir).channels);
  if (!home) emitJson({ status: 'skipped', reason: 'no_home_chat' });
  for (const entry of unstamped) entry.chat = home;
  writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n');
  emitJson({ status: 'stamped', stamped: unstamped.length });
}

export function run(stateDir: string, args: string[]): never {
  const verb = args[0];
  const id = args[1];

  if (!verb) fail('usage');

  // brief-cycle and match take no required <MP-id>, so dispatch before the id requirement.
  if (verb === 'brief-cycle') briefCycle(stateDir);
  if (verb === 'match') matchReply(stateDir, args);
  if (verb === 'stamp-chat') stampChat(stateDir, args);

  if (!id) fail('usage');

  // Validate the whole invocation before touching disk. Otherwise a dropped id
  // (`resolve --action approved`) makes `--action` the id, misses, and exits 0 on
  // no_match: the entry stays pending and the caller believes it resolved.
  if (verb !== 'resolve') fail('unknown_verb');
  if (id.startsWith('-')) fail('missing_id');

  const action = flagValue(args, '--action');
  if (!action || !ACTIONS.includes(action)) {
    fail('invalid_action');
  }
  const answer = flagValue(args, '--answer');

  const microPath = path.join(stateDir, 'state', 'micro-proposals.json');

  // Deliberately NOT lib/cli.ts's readJson — it flattens "missing" and "corrupt"
  // to null. Corrupt must fail loud so the file is never silently replaced.
  const read = readMicroProposals(microPath);
  if (read.status === 'missing') none('no_match'); // nothing queued, nothing to mutate
  if (read.status === 'corrupt') fail('queue_corrupt');
  const micro: Json = read.data;

  const idx = micro.pending.findIndex((e: Json) => e.id === id);
  if (idx === -1) none('no_match');
  const entry = micro.pending[idx];

  // Capture the question before removal — the ledger event carries it.
  const question = entry.question;
  micro.pending.splice(idx, 1);
  writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n');

  const event: Json = { ts: utcISOStamp(), type: 'micro-resolved', micro_id: id, action, question };
  if (answer !== undefined) event.answer = answer;
  const err = appendJsonlLine(path.join(stateDir, 'state', 'proposal-metrics.jsonl'), JSON.stringify(event));
  // The queue write already landed, so re-running this command would only report
  // no_match: say so, or the caller retries and loses the event for good.
  if (err) fail(`event_unrecorded:${id}`);

  emitJson({ status: 'resolved', id, action });
}
