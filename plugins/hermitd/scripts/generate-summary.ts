// Regenerates state-summary.md from state files. Zero npm dependencies, Node stdlib only.
// CLI mode:  bun generate-summary.ts <state-dir-path>
// Hook mode: PostToolUse on Edit|Write — fires automatically when a state/ file is edited
//
// The output is a human-facing snapshot and is refreshed only when something triggers this
// script (the hook above, or proposal.ts in-process). State written by scripts rather than
// tool calls therefore lands here late — accepted by design: nothing branches on this file.
// Readers that need current alerts call readMergedAlerts() directly (lib/dashboard.ts,
// lib/heartbeat/precheck.ts, report-export.ts), following the rebuild-at-read-time pattern.

import fs from 'node:fs';
import path from 'node:path';
import { rebuildIndex } from './lib/proposals/index-rebuild';
import { readMergedAlerts } from './lib/alert-state';
import { pinUnderStateDirOrExit } from './lib/cc-compat';
import { shortProposalId } from './lib/prop-id';

type Json = any;

const MAX_STDIN = 64 * 1024;
const STATE_SUBDIR = '.hermit/state';
const PROPOSALS_SUBDIR = '.hermit/proposals';
const HERMIT_SUBDIR = '.hermit';

function run(stateDir: string): void {

const ALERT_STATE = path.join(stateDir, 'alert-state.json');
const REFLECTION_STATE = path.join(stateDir, 'reflection-state.json');
const METRICS_FILE = path.join(stateDir, 'proposal-metrics.jsonl');
const MICRO_FILE = path.join(stateDir, 'micro-proposals.json');
const OUTPUT = path.join(stateDir, 'state-summary.md');

// Skip entirely if alert-state.json does not exist (not initialized)
if (!fs.existsSync(ALERT_STATE)) return;

// No mtime fast path here on purpose (#691). Any stat-based gate has to enumerate the
// inputs by hand, and that list silently rots: the previous one missed all three of the
// files readMergedAlerts() unions in besides alert-state.json (budget-alerts.json,
// telemetry-alert.json, doctor-alerts.json), so a change confined to any of them left
// stale counts on disk even on a run that did reach this point.
// Redundant writes are suppressed by the content-equality check before the write instead —
// it compares the rendered output, so it cannot drift out of sync with the inputs.

// Union alerts across the per-writer files (skill/checklist + budget + telemetry).
const alerts = readMergedAlerts(path.dirname(stateDir));
let activeAlerts = 0;
let suppressedAlerts = 0;
for (const key of Object.keys(alerts)) {
  if (alerts[key].suppressed) {
    suppressedAlerts++;
  } else {
    activeAlerts++;
  }
}

// Read reflection state
let lastReflection: string | null = null;
try {
  const rs = JSON.parse(fs.readFileSync(REFLECTION_STATE, 'utf-8'));
  lastReflection = rs.last_reflection || null;
} catch {}

// Read proposal metrics
let proposalsCreated = 0;
let proposalsResponded = 0;
let proposalsResolved = 0;
let microQueued = 0;
let microApproved = 0;
let microAnswered = 0;
const proposalSource: Record<string, string> = {}; // proposal_id -> source (for cross-referencing accepts by source)
const createdBySource: Record<string, number> = {}; // source -> count
const acceptedBySource: Record<string, number> = {}; // source -> count
try {
  const lines = fs.readFileSync(METRICS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'created') {
        proposalsCreated++;
        const src = event.source || 'unknown';
        if (event.proposal_id) proposalSource[shortProposalId(event.proposal_id)] = src;
        createdBySource[src] = (createdBySource[src] || 0) + 1;
      }
      if (event.type === 'responded') {
        proposalsResponded++;
        if (event.action === 'accept' && event.proposal_id) {
          const src = proposalSource[shortProposalId(event.proposal_id)] || 'unknown';
          acceptedBySource[src] = (acceptedBySource[src] || 0) + 1;
        }
      }
      if (event.type === 'resolved') proposalsResolved++;
      // Bridged asks (kind:"ask") are bounded 2-4-way asks, not yes/no approval
      // decisions — exclude them from the approval-rate denominator. They still
      // emit micro-queued so reflect's per-day ID counter stays correct.
      if (event.type === 'micro-queued' && event.kind !== 'ask') microQueued++;
      if (event.type === 'micro-resolved' && event.action === 'approved') microApproved++;
      if (event.type === 'micro-resolved' && event.action === 'answered') microAnswered++;
    } catch {}
  }
} catch (err: any) {
  if (err.code !== 'ENOENT') process.stderr.write(`generate-summary: failed to read metrics: ${err.message}\n`);
}

// Acceptance rate per source
function srcAcceptRate(src: string): number | null {
  const created = createdBySource[src] || 0;
  const accepted = acceptedBySource[src] || 0;
  return created > 0 ? Math.round((accepted / created) * 100) : null;
}
const autoDetectAcceptRate = srcAcceptRate('auto-detected');
const manualAcceptRate = srcAcceptRate('manual');

// Rate formatting helpers
const fmtRate = (rate: number | null) => rate !== null ? (rate / 100).toFixed(2) : 'null';
const fmtRateStr = (rate: number | null) => rate !== null ? `${rate}%` : 'no data';

// Read micro-proposals state
let microPendingCount = 0;
let microQuestion: string | null = null;
try {
  const mp = JSON.parse(fs.readFileSync(MICRO_FILE, 'utf-8'));
  const pending: Json[] = Array.isArray(mp.pending) ? mp.pending : [];
  const activePending = pending.filter(e => e && e.status === 'pending');
  const count = activePending.length;
  microPendingCount = count;
  microQuestion = count === 1 ? (activePending[0].question || null) : null;
} catch {}

const responseRate = proposalsCreated > 0
  ? Math.round((proposalsResponded / proposalsCreated) * 100)
  : null;

const lastReflectionStr = lastReflection
  ? new Date(lastReflection).toISOString().replace('T', ' ').slice(0, 16)
  : 'never';

const responseRateStr = fmtRateStr(responseRate);

const microApprovalRate = microQueued > 0
  ? Math.round((microApproved / microQueued) * 100)
  : null;
const microApprovalRateStr = fmtRateStr(microApprovalRate);

const content = `---
updated: ${new Date().toISOString()}
active_alerts: ${activeAlerts}
suppressed_alerts: ${suppressedAlerts}
proposals_created: ${proposalsCreated}
proposals_responded: ${proposalsResponded}
proposals_resolved: ${proposalsResolved}
response_rate: ${fmtRate(responseRate)}
auto_detect_accept_rate: ${fmtRate(autoDetectAcceptRate)}
manual_accept_rate: ${fmtRate(manualAcceptRate)}
micro_pending: ${microPendingCount}
micro_approval_rate: ${fmtRate(microApprovalRate)}
last_reflection: ${lastReflection || 'null'}
---
# Agent State

## Alerts
Active: ${activeAlerts}
Suppressed: ${suppressedAlerts}

## Proposals
Created: ${proposalsCreated} (auto-detected: ${createdBySource['auto-detected'] || 0}, manual: ${createdBySource['manual'] || 0})
Responded: ${proposalsResponded}
Resolved: ${proposalsResolved}
Response rate: ${responseRateStr}
Auto-detected accept rate: ${fmtRateStr(autoDetectAcceptRate)}
Manual accept rate: ${fmtRateStr(manualAcceptRate)}

## Micro-Proposals
Pending: ${microPendingCount}
Question: ${microQuestion || (microPendingCount > 1 ? `${microPendingCount} questions pending` : 'none')}
Approval rate: ${microApprovalRateStr}
Bridged asks answered: ${microAnswered}

## Reflection
Last: ${lastReflectionStr}
`;

// Skip the write when only the `updated:` timestamp differs. Must drop both the opening
// `---` fence and the `updated:` line (content starts with `---\n`) — dropping only one
// line leaves the timestamp in the comparison and the guard never matches.
try {
  const existing = fs.readFileSync(OUTPUT, 'utf-8');
  const skipUpdated = (s: string) => s.split('\n').slice(2).join('\n');
  if (skipUpdated(content) === skipUpdated(existing)) return;
} catch {}

fs.writeFileSync(OUTPUT, content, 'utf-8');
}

// CLI mode: bun generate-summary.ts <state-dir-path>
if (import.meta.main) {
  if (process.argv[2]) {
    // The state dir is not caller-chosen. CLI mode is reachable through a
    // pre-approved `Bash(bun */scripts/generate-summary.ts*)` grant that
    // covers every argument; hook mode below is unaffected — it derives its
    // path from a PostToolUse payload for a write that already happened, and
    // a hook is not reachable through that Bash grant. Containment, not
    // equality: argv here is <hermit>/state, and the bound is that branch
    // alone — nothing this mode writes lives outside it.
    run(pinUnderStateDirOrExit(process.argv[2], 'state'));
    process.exit(0);
  }

  // Hook mode: PostToolUse on Edit|Write — fire only when a state/ file was edited
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      if (!raw.includes(STATE_SUBDIR) && !raw.includes(PROPOSALS_SUBDIR)) process.exit(0);
      const event = JSON.parse(raw);
      const filePath = (event.tool_input || {}).file_path || (event.tool_input || {}).path || '';
      // Anchor on the absolute path from the payload — immune to cwd drift (#384)
      // Proposal write → rebuild the derived proposals index (any writer: create/act/reflect).
      const pIdx = filePath.indexOf(PROPOSALS_SUBDIR);
      if (pIdx !== -1) rebuildIndex(filePath.slice(0, pIdx) + HERMIT_SUBDIR);
      // State write → regenerate state-summary.md.
      const sIdx = filePath.indexOf(STATE_SUBDIR);
      if (sIdx !== -1) run(filePath.slice(0, sIdx + STATE_SUBDIR.length));
    } catch {
      // Never block the agent
    }
  });
}

export { run };
