// `proposal.ts queue-micro <stateDir>` — generates an MP-id, dedups, appends a
// pending entry to state/micro-proposals.json, and logs the micro-queued event.
// Usage: proposal.ts queue-micro <hermit-state-dir> <<'HERMIT_MP'
//        {"tier":1,"question":"<full question text>","options":["..."],"on_resolve":"...","chat":"<sourceKey>:<chat_id>"}
//        HERMIT_MP
//   — stdin only (question is free text and may contain apostrophes/quotes; no argv mode).
// Output (stdout, one JSON line):
//   {"status":"queued","id":"<MP-id>"}
//   {"status":"duplicate","id":"<existing-id>"}
//   {"error":"invalid_input"|"missing_question"|"queue_corrupt"|"event_unrecorded:<MP-id>"}, exit 1
// A silent queue-drop would strand the candidate, so every failure exits 1.
// Implements reflect/branches.md § Micro-approval queuing steps 1-3. `options`/
// `on_resolve` are optional per the channel-bridged-ask extension (branches.md:
// 205-207); when `on_resolve` is present, tier is forced to 1 and the metrics
// event carries "kind":"ask" (branches.md:207,214) regardless of the caller's tier.
// Dedup is by exact `question` match against existing `pending` entries, or by
// `proposal_id` when the payload declares one (that link also lets `sweepMoot`
// retire the ask once its proposal reaches a terminal status).

import fs from 'node:fs';
import path from 'node:path';
import { todayYMD, utcISOStamp } from '../time';
import { appendJsonlLine } from '../append-jsonl';
import { emitJson, readStdin } from '../cli';
import { readSettledConfig } from '../config-read';
import { writeFileAtomic } from '../md-write';
import { readMicroProposals } from '../micro-proposals-io';
import { homeChatKey, linkedProposalId, normalizeProposalId } from './micro';
import { isKey } from '../conversation-key';

type Json = any;

export async function run(stateDir: string): Promise<void> {
  const raw = (await readStdin()).trim();
  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    emitJson({ error: 'invalid_input' });
  }

  const question: string = payload.question;
  if (!question) emitJson({ error: 'missing_question' });
  const onResolve: string | undefined = payload.on_resolve;
  const isBridged = onResolve !== undefined;
  const tier = isBridged ? 1 : (payload.tier ?? 1);
  const options: string[] | undefined = payload.options;
  // Declared link to the proposal this ask belongs to. Malformed values are
  // dropped rather than fatal: the ask still deserves to be queued, it just
  // falls back to the legacy on_resolve link that `sweepMoot` also reads.
  const proposalId: string | undefined =
    typeof payload.proposal_id === 'string' && normalizeProposalId(payload.proposal_id)
      ? payload.proposal_id
      : undefined;

  // The chat the question was asked in; only a reply there can answer it.
  // Callers asking outside a channel turn omit it and get the home chat.
  if (payload.chat !== undefined && !isKey(payload.chat)) emitJson({ error: 'invalid_input' });
  const chat: string | null = payload.chat ?? homeChatKey(stateDir);

  const stateSubdir = path.join(stateDir, 'state');
  const microPath = path.join(stateSubdir, 'micro-proposals.json');
  // Absent file: start empty. Present but unparseable: refuse — defaulting to
  // {pending:[]} here would silently destroy the whole backlog on the next
  // queue (issue 649).
  const read = readMicroProposals(microPath);
  if (read.status === 'corrupt') emitJson({ error: 'queue_corrupt' });
  const micro: Json = read.status === 'missing' ? { pending: [] } : read.data;

  // Dedup against live entries only (issue 676): a stale non-"pending" row left
  // in the array is invisible to every reader and will be pruned by the next
  // brief-cycle, so matching it here would silently swallow a fresh candidate.
  // A linked ask ALSO dedups on the proposal it belongs to, not only on wording:
  // the question embeds a display index ("Suggestion #3") that shifts with list
  // order, so exact-text matching alone would queue a second ask for the same
  // proposal. The link is read through `linkedProposalId` (normalized padding,
  // plus the legacy on_resolve form) so an entry queued before `proposal_id`
  // existed is still recognized; exact-question dedup stays as the fallback for
  // unlinked asks and for that same legacy window.
  const wanted = proposalId ? normalizeProposalId(proposalId) : null;
  const existing = micro.pending.find((e: Json) => e && e.status === 'pending'
    && ((wanted !== null && linkedProposalId(e) === wanted) || e.question === question));
  if (existing) {
    emitJson({ status: 'duplicate', id: existing.id });
  }

  const config = readSettledConfig(stateDir);
  const timezone = config.timezone || 'UTC';
  const today = todayYMD(timezone).replace(/-/g, '');

  const ledger = path.join(stateSubdir, 'proposal-metrics.jsonl');
  const prefix = `MP-${today}-`;
  let maxN = -1;
  try {
    const lines = fs.readFileSync(ledger, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'micro-queued' && typeof ev.micro_id === 'string' && ev.micro_id.startsWith(prefix)) {
          const n = parseInt(ev.micro_id.slice(prefix.length), 10);
          if (!isNaN(n)) maxN = Math.max(maxN, n);
        }
      } catch { /* skip unparseable line */ }
    }
  } catch { /* no ledger yet -> N starts at 0 */ }

  const id = `${prefix}${maxN + 1}`;

  const entry: Json = { id, tier, status: 'pending', follow_up_count: 0, ts: utcISOStamp(), question };
  if (options) entry.options = options;
  if (onResolve) entry.on_resolve = onResolve;
  if (proposalId) entry.proposal_id = proposalId;
  if (chat) entry.chat = chat;
  micro.pending.push(entry);

  fs.mkdirSync(stateSubdir, { recursive: true });
  writeFileAtomic(microPath, JSON.stringify(micro, null, 2) + '\n');

  const event: Json = { ts: utcISOStamp(), type: 'micro-queued', micro_id: id, tier, question };
  if (isBridged) event.kind = 'ask';
  const err = appendJsonlLine(ledger, JSON.stringify(event));
  if (err) emitJson({ error: `event_unrecorded:${id}` });

  emitJson({ status: 'queued', id });
}
