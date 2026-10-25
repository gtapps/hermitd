// `proposal.ts metrics [<stateDir>] [--source=<arg>]`: triage-survival and acceptance
// rates per autonomous proposal source; the state dir defaults to `.hermit`.

import fs from 'node:fs';
import path from 'node:path';
import { emitJson, exitError } from '../cli';

type Json = any;

// Kill thresholds (match the values documented in capability-brainstorm and reflect kill criteria)
const MIN_SAMPLE = 8;
const KILL_SURVIVAL_PCT = 25;
const KILL_ACCEPT_PCT = 30;

// Segment registry: discriminators for triage-survival and acceptance by autonomous source.
// triage: filter applied to `triage-verdict` events.
// accept: filter applied to `created` events (source, tags). null = not separately trackable.
// This is the single source of truth for segmentation; kill-criteria skills invoke this script
// and contract tests verify these discriminators match what the emitters write.
// `key` is the stdout `source`; `arg` is the kebab spelling `--source=` matches.
const SEGMENTS: { key: string; arg: string; triage: (e: Json) => boolean; accept: ((src: string, tags: string[]) => boolean) | null }[] = [
  {
    key: 'reflect',
    arg: 'reflect',
    triage: e => e.caller === 'reflect',
    // Ordinary reflect proposals: auto-detected but not tagged as a sub-segment
    accept: (src, tags) =>
      src === 'auto-detected' &&
      !tags.includes('capability-brainstorm') &&
      !tags.includes('procedure-capture'),
  },
  {
    key: 'capability_brainstorm',
    arg: 'capability-brainstorm',
    triage: e => e.evidence_source === 'capability-brainstorm',
    accept: (src, tags) => tags.includes('capability-brainstorm'),
  },
  {
    key: 'scheduled_check',
    arg: 'scheduled-check',
    triage: e => e.caller === 'scheduled-checks',
    accept: null, // not separately tagged on created events
  },
];

function report(rawArgs: string[]): object {
  const posArgs = rawArgs.filter(a => !a.startsWith('--'));
  const stateDir = posArgs[0] || '.hermit';
  const sourceArg = (rawArgs.find(a => a.startsWith('--source=')) || '').slice('--source='.length) || null;
  const picked = sourceArg ? SEGMENTS.find(s => s.arg === sourceArg) : null;
  if (sourceArg && !picked) return { error: `unknown_source:${sourceArg}` };

  const metricsFile = path.join(stateDir, 'state', 'proposal-metrics.jsonl');
  let content: string;
  try {
    content = fs.readFileSync(metricsFile, 'utf-8').trim();
  } catch (err: any) {
    if (err.code === 'ENOENT') return { status: 'none', reason: 'no_metrics' };
    throw err;
  }
  if (!content) return { status: 'none', reason: 'no_metrics' };

  // Accumulators
  const proposalSource: Record<string, string> = {};          // proposal_id -> source string
  const proposalTags: Record<string, string[]> = {};            // proposal_id -> tags array
  const accepted = new Set<string>();         // proposal_ids with action=accept
  const triageCount: Record<string, { create: number; total: number }> = {};             // key -> { create: n, total: n }
  const createdCount: Record<string, number> = {};            // key -> n
  const acceptedCount: Record<string, number> = {};           // key -> n
  for (const seg of SEGMENTS) {
    triageCount[seg.key] = { create: 0, total: 0 };
    createdCount[seg.key] = 0;
    acceptedCount[seg.key] = 0;
  }

  // Single pass over the JSONL
  for (const line of content.split('\n')) {
    let e: Json;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;

    if (e.type === 'created' && e.proposal_id) {
      const src = e.source || 'unknown';
      const tags = Array.isArray(e.tags) ? e.tags : [];
      proposalSource[e.proposal_id] = src;
      proposalTags[e.proposal_id] = tags;
      for (const seg of SEGMENTS) {
        if (seg.accept && seg.accept(src, tags)) createdCount[seg.key]++;
      }
    }

    if (e.type === 'responded' && e.action === 'accept' && e.proposal_id) {
      accepted.add(e.proposal_id);
    }

    if (e.type === 'triage-verdict') {
      for (const seg of SEGMENTS) {
        if (seg.triage(e)) {
          triageCount[seg.key].total++;
          if (e.verdict === 'CREATE') triageCount[seg.key].create++;
        }
      }
    }
  }

  // Tally accepted per segment (after full pass so proposalSource/Tags are populated)
  for (const id of accepted) {
    const src = proposalSource[id] || 'unknown';
    const tags = proposalTags[id] || [];
    for (const seg of SEGMENTS) {
      if (seg.accept && seg.accept(src, tags)) acceptedCount[seg.key]++;
    }
  }

  // One segment object: whole-percent rates (null on a zero denominator) next to
  // the thresholds they are judged against. The scheduled-check segment has no
  // acceptance side, so its acceptance keys are omitted rather than nulled.
  function segmentFor(seg: (typeof SEGMENTS)[number]) {
    const t = triageCount[seg.key];
    const c = createdCount[seg.key];
    const a = acceptedCount[seg.key];
    const survivalPct = t.total > 0 ? Math.round((t.create / t.total) * 100) : null;
    const acceptPct = c > 0 ? Math.round((a / c) * 100) : null;
    const killReasons: string[] = [];
    if (survivalPct !== null && survivalPct < KILL_SURVIVAL_PCT) killReasons.push('triage_survival');
    if (seg.accept && acceptPct !== null && acceptPct < KILL_ACCEPT_PCT) killReasons.push('acceptance');
    const status = t.total < MIN_SAMPLE ? 'insufficient_data' : killReasons.length ? 'kill' : 'ok';
    return {
      source: seg.key,
      status,
      ...(status === 'kill' ? { kill_reasons: killReasons } : {}),
      sample: t.total,
      min_sample: MIN_SAMPLE,
      triage_survival_pct: survivalPct,
      triage_created: t.create,
      triage_total: t.total,
      kill_survival_pct: KILL_SURVIVAL_PCT,
      ...(seg.accept
        ? { acceptance_pct: acceptPct, accepted: a, created: c, kill_acceptance_pct: KILL_ACCEPT_PCT }
        : {}),
    };
  }

  return picked ? segmentFor(picked) : { segments: SEGMENTS.map(segmentFor) };
}

// process.exit inside emitJson ends the process without throwing, so the catch sees only report() failures.
export function run(args: string[]): never {
  try { emitJson(report(args)); } catch { exitError('metrics_failed'); }
}
