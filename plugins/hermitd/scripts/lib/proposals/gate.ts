// `proposal.ts gate <stateDir> …` — parses one proposal/reflect gate-agent verdict
// line, appends the corresponding metric event, and returns a routing verdict.
// Usage: proposal.ts gate <hermit-state-dir> --gate <triage|judge> --caller <caller>
//        [--evidence-source <value>] [--tags <json-array>] <<'HERMIT_GATE'
//        Title: <candidate title>
//        Verdict: <the gate agent's verdict line, verbatim>
//        HERMIT_GATE
// Output (stdout, one JSON line):
//   {"status":"create"}                       (triage)
//   {"status":"suppress","code":"<code>"}     (triage or judge)
//   {"status":"duplicate","id":"<PROP-ID>"}   (triage)
//   {"status":"accept"}                       (judge)
//   {"status":"downgrade","tier":<N>}         (judge)
//   {"status":"gate_failed"}                  (either gate: unrecognized/empty verdict)
// Exit 0 for every verdict, gate_failed included.
//
// Fail-closed by design — the opposite stance from the fail-open *-precheck.ts
// scripts: an unrecognized verdict never proceeds. Recognized triage verdicts
// append a `triage-verdict` event to state/proposal-metrics.jsonl (matches the
// existing prose contract in proposal-create/SKILL.md and reflect/branches.md).
// Judge verdicts are not separately logged today — only a judge gate *failure*
// appends `gate-failed`; this script preserves that rather than introducing a
// new judge-verdict metric type. A `gate-failed` row carries the rejected line,
// capped at 200 chars, as `verdict`. Verdict grammars: agents/proposal-triage.md
// § Output, agents/reflection-judge.md § Verdicts.

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine } from '../append-jsonl';
import { utcISOStamp } from '../time';
import { emitJson, readStdin } from '../cli';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

export async function run(stateDir: string, args: string[]): Promise<void> {
  const flags = parseArgs(args);
  const gate = flags.gate; // 'triage' | 'judge'
  const caller = flags.caller ?? 'unknown';
  const evidenceSource = flags['evidence-source'] ?? 'archived-session';
  let tags: string[] = [];
  if (flags.tags) {
    try { tags = JSON.parse(flags.tags); } catch { tags = []; }
  }

  const input = await readStdin();
  const titleMatch = input.match(/^Title:\s*(.*)$/m);
  const verdictMatch = input.match(/^Verdict:\s*(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const verdictLine = verdictMatch ? verdictMatch[1].trim() : '';

  const agent = gate === 'judge' ? 'reflection-judge' : 'proposal-triage';

  try { fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true }); } catch { /* appendJsonlLine below reports the real failure */ }

  function failClosed(): never {
    appendJsonlLine(
      path.join(stateDir, 'state', 'proposal-metrics.jsonl'),
      JSON.stringify({ ts: utcISOStamp(), type: 'gate-failed', agent, title, verdict: verdictLine.slice(0, 200) }),
    );
    emitJson({ status: 'gate_failed' });
  }

  if ((gate !== 'triage' && gate !== 'judge') || !verdictLine) failClosed();

  const ledger = path.join(stateDir, 'state', 'proposal-metrics.jsonl');

  if (gate === 'triage') {
    const create = verdictLine.match(/^CREATE:\s*.+$/);
    const suppress = verdictLine.match(/^SUPPRESS:\s*.+?—\s*([a-z-]+):/);
    const duplicate = verdictLine.match(/^DUPLICATE:\s*.+?—\s*(PROP-[\w-]+):/);

    if (create) {
      appendJsonlLine(ledger, JSON.stringify({ ts: utcISOStamp(), type: 'triage-verdict', verdict: 'CREATE', caller, evidence_source: evidenceSource, tags }));
      emitJson({ status: 'create' });
    }
    if (suppress) {
      appendJsonlLine(ledger, JSON.stringify({ ts: utcISOStamp(), type: 'triage-verdict', verdict: 'SUPPRESS', caller, evidence_source: evidenceSource, tags }));
      emitJson({ status: 'suppress', code: suppress[1] });
    }
    if (duplicate) {
      appendJsonlLine(ledger, JSON.stringify({ ts: utcISOStamp(), type: 'triage-verdict', verdict: 'DUPLICATE', caller, evidence_source: evidenceSource, tags }));
      emitJson({ status: 'duplicate', id: duplicate[1] });
    }
    failClosed();
  }

  // gate === 'judge'
  const accept = verdictLine.match(/^ACCEPT(?:\s*\([^)]+\))?:/);
  const downgrade = verdictLine.match(/^DOWNGRADE:(\d+)(?:\s*\([^)]+\))?:/);
  const suppress = verdictLine.match(/^SUPPRESS(?:\s*\([^)]+\))?:\s*.+?—\s*([a-z-]+):/);

  if (accept) emitJson({ status: 'accept' });
  if (downgrade) emitJson({ status: 'downgrade', tier: Number(downgrade[1]) });
  if (suppress) emitJson({ status: 'suppress', code: suppress[1] });
  failClosed();
}
