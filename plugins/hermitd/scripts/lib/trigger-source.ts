// trigger-source.ts — classify a turn's trigger source from its scanned text.
//
// Pure, side-effect-free (no module-level state): both cost-tracker.ts and
// transcript-digest.ts import it, and it must be safe to load in-process from any
// cwd without freezing paths the way cost-tracker's own module init does.
// channel-envelope.ts (the sole import) is likewise pure — a regex normalizer
// with no module-level state — so the load-anywhere guarantee holds.

import { normalizeChannelSource } from './channel-envelope';

type Json = any;

// Reduce a prompt to the sentinel line a wake actually delivered. Three frames carry
// one, and nothing else does:
//   Monitor event      <task-notification>…<event>SENTINEL</event>…</task-notification>
//                      (heartbeat-monitor.sh, lib/routines/due.ts)
//   Peer socket post   "Another Claude session sent a message:\n<cross-session-message …>
//                      SENTINEL</cross-session-message>…" ("Message from @<name>" for a
//                      named peer; the watchdog's wedge wake arrives this way,
//                      hermitd-watchdog.ts WEDGE_WAKE_TOKEN)
//   CronCreate prompt  the bare prompt itself, "[hermit-routine:<id>] Run: …"
//                      (lib/routines/arm.ts renderAnchorPrompt)
// Everything else — an operator prompt, a compaction-continuation summary, a subagent
// completion quoting its own output — reduces to its own trimmed text, where an
// anchored match then fails. A subagent completion has no <event> body at all, so it
// reduces to '' and can never be claimed by a sentinel rule; the channel and peer rules
// below are frame-anchored for the same reason (a completion whose <result> quotes a
// peer frame, or a compaction summary quoting a <channel> envelope, is not a delivery).
function sentinelLine(text: string): string {
  const t = text.trim();
  if (t.startsWith('<task-notification')) {
    const event = t.match(/<event>([\s\S]*?)<\/event>/);
    return event ? event[1].trim() : '';
  }
  if (t.startsWith('Another Claude session sent a message') || t.startsWith('Message from @')) {
    const nl = t.indexOf('\n');
    const body = nl === -1 ? '' : t.slice(nl + 1).trim();
    // The harness wraps a socket post in <cross-session-message from=… from-name=…
    // from-mode=…> and appends a trailer after the close tag (verified against live
    // transcripts). The sentinel is that element's body, so unwrap it — otherwise the
    // watchdog's wedge wake reads as the wrapper text and never matches.
    const inner = body.match(/^<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/);
    return inner ? inner[1].trim() : body;
  }
  return t;
}

// Classify a turn's trigger source from the text of its triggering entry. Only the
// marker-driven sources below are claimed; everything else is 'other' (the
// non-scheduled bucket, typically the largest in practice).
//
// Anchored on the delivered sentinel line, never containment: an operator prompt that
// merely discusses the heartbeat, or a compaction summary that quotes a routine id,
// was billed as a wake under the old containment rules, and the prose fallback minted
// buckets like `routine:has` from ordinary sentences. record-operator-action.ts matches
// the same sentinels anchored at the live input boundary; this is that grammar applied
// to retrospective cost attribution.
//
// Routine ids are validated only for presence/uniqueness in config — the strict charset
// here ([A-Za-z0-9._-]+) is the classifier's own gate, and it rejects skill-template
// noise ([hermit-routine:*], <id> placeholders).
function classifySource(triggerText: string): string {
  if (!triggerText) return 'other';
  const t = triggerText.trim();
  const line = sentinelLine(t);
  if (line === 'HEARTBEAT_EVALUATE') return 'heartbeat';
  const watchMatch = line.match(/^WATCH_EVENT \[hermit-watch:([A-Za-z0-9._-]+)\]/)
    ?? line.match(/^WATCH_MONITOR_ERROR: ([A-Za-z0-9._-]+)(?:\s|$)/);
  if (watchMatch) return `watch:${watchMatch[1].slice(0, 64)}`;
  // Monitor co-fire: a ROUTINE_DUE line naming ≥2 distinct routine ids means one wake turn
  // ran multiple routines. Attribute the shared turn to a synthetic `routine:multi` bucket
  // rather than mis-charging the whole turn to the first id (which would inflate that
  // routine's per-run cost and mask the others in the doctor's routine-cost check).
  const routineDue = line.match(/^ROUTINE_DUE((?:\s+\[hermit-routine:[A-Za-z0-9._-]+\])+)/);
  if (routineDue) {
    const ids = new Set([...routineDue[1].matchAll(/\[hermit-routine:([A-Za-z0-9._-]+)\]/g)].map((m) => m[1]));
    if (ids.size >= 2) return 'routine:multi';
    if (ids.size === 1) return `routine:${[...ids][0].slice(0, 64)}`;
  }
  // CronCreate-delivered routine: the id opens the prompt. Strict charset — must match a
  // real routine id, never a placeholder or glob.
  const routineMatch = line.match(/^\[hermit-routine:([A-Za-z0-9._-]+)\]/);
  // Length-cap to 64 chars so ids can't overflow markdown table cells
  if (routineMatch) return `routine:${routineMatch[1].slice(0, 64)}`;
  // Inbound-channel envelope (see lib/channel-envelope.ts): source is plugin-qualified
  // on the wire (e.g. `plugin:discord:discord`, `plugin:voice:voice`). Bucket by the
  // bare server name via normalizeChannelSource — the same normalizer the auth/config
  // path uses, so cost attribution and config lookup can't drift apart on the wire
  // shape. Strict charset — like the routine regex above, the value must match the
  // allowed charset to be captured at all (not captured loosely then sanitized), so
  // `<id>`/`*` placeholder noise fails the match entirely rather than surviving as a
  // truncated false positive. Frame-anchored like the sentinels above: a delivered
  // channel turn OPENS with the envelope (record-operator-action.ts gates on the same
  // `startsWith('<channel')`), so a compaction-continuation summary that quotes one
  // mid-text is prose, not a delivery.
  const channelMatch = t.startsWith('<channel')
    ? t.match(/<channel\b[^>]*\bsource="([A-Za-z0-9._:-]+)"/)
    : null;
  const channelKind = channelMatch ? normalizeChannelSource(channelMatch[1]) : '';
  // Only a source that normalizes to a clean bare server name is a real channel;
  // anything still containing ':' (a malformed or unrecognized 3+-segment shape)
  // is bucketed as `other` rather than leaking a `channel:plugin:…` garbage bucket
  // — same fail-closed stance normalizeChannelSource takes for config lookup.
  if (channelKind && !channelKind.includes(':')) return `channel:${channelKind.slice(0, 64)}`;
  // Another local Claude Code session posted into this one's inbox socket. The
  // frame is the harness's own wording: a raw post renders as "Another Claude
  // session sent a message:", a named peer as "Message from @<name>".
  //
  // LAST on purpose. The watchdog's own wedge wake arrives inside that same
  // frame carrying HEARTBEAT_EVALUATE, and it is a heartbeat, not a peer — the
  // matchers above already claimed it, so ordering alone keeps the wake out of
  // this bucket without a second copy of their grammar here.
  //
  // Anchored, matching sentinelLine's own guard: a subagent completion whose <result>
  // quotes this frame is not a peer post, and billing it 'peer' would also suppress
  // cost-tracker's dispatch hop (which only runs on 'other') and lose the turn's cost
  // for the routine that dispatched it.
  if (t.startsWith('Another Claude session sent a message') || t.startsWith('Message from @')) {
    return 'peer';
  }
  return 'other';
}

export { classifySource };
