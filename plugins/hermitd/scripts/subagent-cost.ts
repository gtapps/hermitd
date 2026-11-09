import { dispatchTaskAttribution, readTaskCostRows } from './lib/tasks';
// SubagentStop hook — captures async-dispatched subagent token cost.
//
// Problem: async Agent dispatches complete via XML <task-notification> with no usage
// field in the main transcript. cost-tracker.ts (Stop hook) is structurally blind to them.
// This hook fires on SubagentStop (CC >= v2.1.143), reads the subagent transcript directly
// (payload.agent_transcript_path), and appends a subagent:true row to cost-log.jsonl —
// matching the shape cost-tracker.ts emits for sync subagent completions.
//
// Payload field semantics (verified live on CC 2.1.183):
//   payload.transcript_path        → PARENT (main session) transcript
//   payload.agent_transcript_path  → the SUBAGENT transcript (summed here)
//   payload.agent_id               → matches toolUseResult.agentId in the parent
//
// Only ASYNC dispatches are logged here; sync ones are already logged by cost-tracker.ts.
// We detect async POSITIVELY: the parent transcript carries a launch entry with
// toolUseResult.isAsync===true / status:"async_launched" for this agent_id, written at
// launch time and reliably present at SubagentStop. Sync dispatches never carry that
// marker (their completed+usage result is written AFTER SubagentStop fires), so they are
// skipped — no double-count. This is robust to parent-transcript write ordering.
process.stdout.on('error', () => {});

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine } from './lib/append-jsonl';

import {
  hermitDir, costLogPath, extractUsage, foldUsageByRequest, turnPromptText,
  transcriptPath as parentTranscriptPath, agentTranscriptPath, agentId as payloadAgentId,
  sessionId as payloadSessionId,
} from './lib/cc-compat';
import { calculateCost } from './lib/pricing';
import { resolveTurnSource } from './cost-tracker';
import { buildSubagentCostRow, appendCostRows, costIndexPath, updateCostIndex } from './lib/cost-log';
import { readSettledConfig } from './lib/config-read';

const HERMIT_DIR = hermitDir();
const COST_LOG = costLogPath(HERMIT_DIR);
function sumSubagentTranscript(transcriptPath: string): {
  model: string; inputTokens: number; cacheWriteTokens: number;
  cacheWrite1hTokens: number; cacheReadTokens: number; outputTokens: number;
  fast: boolean;
} | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  const collected: NonNullable<ReturnType<typeof extractUsage>>[] = [];
  for (const line of content.split('\n')) {
    try {
      const usage = extractUsage(JSON.parse(line));
      if (usage) collected.push(usage);
    } catch {}
  }
  if (collected.length === 0) return null;
  const folded = foldUsageByRequest(collected);
  let inputTokens = 0, cacheWriteTokens = 0, cacheWrite1hTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  let model = '';
  let fast = false;
  for (const usage of folded) {
    inputTokens += usage.inputTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    cacheWrite1hTokens += usage.cacheWrite1hTokens;
    cacheReadTokens += usage.cacheReadTokens;
    outputTokens += usage.outputTokens;
    if (usage.fast) fast = true;
    if (!model) model = usage.model;
  }
  return { model, inputTokens, cacheWriteTokens, cacheWrite1hTokens, cacheReadTokens, outputTokens, fast };
}

// Locate this agent's ASYNC launch entry in the parent transcript. Returns the scanned
// lines + the launch index (for resolveTurnSource source attribution), or null when no
// async-launch marker is present for this agentId → sync dispatch or untracked → don't log.
//
// Reads the whole parent (not a tail window): an async parent keeps working while the
// subagent runs in the background, so by SubagentStop the launch entry can be far back —
// a tail window would silently drop legitimate async rows. SubagentStop is infrequent, so
// the full read is cheap. The reverse scan early-exits, so the common recent-launch case
// is still fast.
function findAsyncLaunch(parentPath: string, agentId: string): { lines: string[]; index: number } | null {
  let lines: string[];
  try { lines = fs.readFileSync(parentPath, 'utf-8').split('\n'); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]).toolUseResult;
      if (!r || typeof r !== 'object' || r.agentId !== agentId) continue;
      // Positive async signal — written at launch, present at SubagentStop. Other entries
      // for this agentId (e.g. a later completion notification) are not disqualifying.
      if (r.isAsync === true || r.status === 'async_launched') return { lines, index: i };
    } catch {}
  }
  return null;
}

process.stdin.on('error', () => {});
const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    const payload = raw ? JSON.parse(raw) : {};

    // Dream completion includes synchronous workers too, before async cost gating.
    if (typeof payload.agent_type === 'string' && payload.agent_type.startsWith('hermitd:dream-')) {
      try {
        const dream = JSON.parse(fs.readFileSync(path.join(HERMIT_DIR, 'state/dream.json'), 'utf8'));
        const id = payloadAgentId(payload);
        if (dream.running?.run_dir && id) appendJsonlLine(path.join(dream.running.run_dir, 'agents.jsonl'), JSON.stringify({
          agent_id: id, agent_type: payload.agent_type, at: new Date().toISOString(),
        }));
      } catch { /* Completion recording must never change cost-hook failure behavior. */ }
    }

    if (payload.stop_hook_active) { process.exit(0); return; }

    const subPath = agentTranscriptPath(payload);
    const parentPath = parentTranscriptPath(payload);
    const aid = payloadAgentId(payload);
    if (!subPath || !aid) { process.exit(0); return; }

    // Only async dispatches are ours; sync ones are logged by cost-tracker.ts. The launch
    // entry also yields source attribution for the row.
    const launch = parentPath ? findAsyncLaunch(parentPath, aid) : null;
    if (!launch) { process.exit(0); return; }

    const usage = sumSubagentTranscript(subPath);
    if (!usage) { process.exit(0); return; }

    const { model: rawModel, inputTokens, cacheWriteTokens, cacheWrite1hTokens, cacheReadTokens, outputTokens, fast } = usage;
    const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    if (totalTokens === 0) { process.exit(0); return; }

    // Source attribution from the launch entry's turn (best-effort, falls back to 'other').
    // findAsyncLaunch reads the whole parent transcript (no tail window), so a missed
    // boundary here just means the launch is in the genuine first turn — no truncation
    // guard needed like cost-tracker.ts's tail-windowed scan.
    let source = 'other';
    try { source = resolveTurnSource(launch.lines, launch.index).source; } catch {}

    const model = rawModel || '';
    // Clamped: the 1h split and the cache-write total are folded per request as
    // independent maxima, so a disagreeing pair could otherwise yield a negative 5m
    // component and a cost below the real figure.
    const cacheWrite1h = Math.min(cacheWrite1hTokens, cacheWriteTokens);
    const priced = calculateCost(model, {
      input: inputTokens,
      cacheWrite5m: cacheWriteTokens - cacheWrite1h,
      cacheWrite1h,
      cacheRead: cacheReadTokens,
      output: outputTokens,
      fast,
    });
    const round4 = (n: number) => Math.round(n * 10000) / 10000;
    const estimatedCost = round4(priced.total);
    const costByType = {
      input: round4(priced.byType.input),
      cache_write: round4(priced.byType.cacheWrite),
      cache_read: round4(priced.byType.cacheRead),
      output: round4(priced.byType.output),
    };

    const boundary = turnPromptText(launch.lines, launch.index);
    let boundaryAt = '';
    try { boundaryAt = JSON.parse(launch.lines[boundary.index]).timestamp ?? ''; } catch {}
    const taskAttribution = dispatchTaskAttribution(HERMIT_DIR, readTaskCostRows(HERMIT_DIR), payloadSessionId(payload) ?? '', boundaryAt);
    const entry = buildSubagentCostRow({
      taskAttribution,
      source,
      model,
      inputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      agentType: payload.agent_type || '',
      modelResolved: !!rawModel,   // subagent transcript always carries a model → effectively always true
      estimatedCostUsd: estimatedCost,
      costByType,
    });

    try { appendCostRows(COST_LOG, [entry]); } catch { process.exit(0); return; }

    // Fold the row into cost-index.json here rather than leaving it for the next
    // Stop hook. readCostIndex validates only the schema version, so a present-but-
    // lagging index is trusted verbatim by the dashboard, the telemetry export,
    // spend-status and the doctor — and an async dispatch that finishes as the
    // hermit goes idle can leave it lagging indefinitely. updateCostIndex folds
    // only the bytes past its own offset and rebuilds if the log shrank, so racing
    // the Stop hook here is last-writer-wins over the same derived total, not a
    // double-count. Budget enforcement is unaffected either way: cost-tracker
    // checks caps against the index it just updated itself.
    try {
      const timezone = readSettledConfig(HERMIT_DIR).timezone ?? 'UTC';
      updateCostIndex(COST_LOG, costIndexPath(HERMIT_DIR), timezone);
    } catch { /* index refresh is best-effort; the row is already durable */ }
  } catch {}
  process.exit(0);
});
