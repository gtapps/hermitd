// observations.ts — the one model-facing writer for state/observations.jsonl.
//
// Usage: bun observations.ts observe <hermit-state-dir> <source> [--origin=<own-work|external-content>]
//        <free-text label on stdin, via a quoted heredoc>
//    or: bun observations.ts graduate <hermit-state-dir> [--cursor <iso>]
//        prints `{"candidates":[...]}`, the patterns reflect promotes to candidates this run.
//    or: bun observations.ts patterns <hermit-state-dir>
//        prints the 50 most recently seen distinct quick-deferral and reflect-noticed labels, read-only.
//
// Replaces append-metrics.ts, which took an arbitrary path and arbitrary JSON and
// so granted every holder of its unattended permission strictly more authority
// than any caller needed.
//
// Stdin-only by design. The label is the only free-text field, and a free-text
// value in single-quoted argv breaks the moment it contains an apostrophe — the
// hazard the old script's dual argv/stdin mode existed to work around. Once the
// computed sources moved to the scripts that compute them (reflect-precheck,
// transcript-digest), every remaining caller passes model-authored prose, so
// there is no argv case left to serve and no quoting rule to document.
//
// observe prints `OK`, or `{"error":"<token>"}` with exit 1. A metrics row is telemetry:
// the calling skill reports a rejected row and carries on with its step.

import { emit, emitJson, exitError, failJson, flagEq as flag, flagValue, readStdin } from './lib/cli';
import { pinStateDirOrExit } from './lib/cc-compat';
import { CLI_SOURCES, appendObservation, graduateObservations, observationPatterns, resolveSessionId, type CliSource, type Origin } from './lib/observations';

async function main(): Promise<void> {
  const [verb, stateDirArg, ...args] = process.argv.slice(2);

  // A mis-invocation is not a resolved verdict — exit 1 so a broken call site is
  // loud in tests and CI rather than silently recording nothing.
  if ((verb !== 'observe' && verb !== 'graduate' && verb !== 'patterns') || !stateDirArg) exitError();

  // The state dir is not caller-chosen. Reachable through a pre-approved
  // `Bash(bun */scripts/observations.ts observe*)` grant that covers every
  // argument after the verb, so an unvalidated root let one such call append
  // model-authored rows to another project's observations ledger — the same
  // mis-invocation class, and refused the same way. See cc-compat.ts.
  const stateDir = pinStateDirOrExit(stateDirArg);

  // The graduation set is a pure read over the ledger; one JSON object, never prose.
  if (verb === 'patterns') emitJson({ patterns: observationPatterns(stateDir) });
  if (verb === 'graduate') emitJson({ candidates: graduateObservations(stateDir, flagValue(args, '--cursor')) });

  const [source, ...rest] = args;
  if (!source) exitError();

  // Rejecting the computed sources here is what keeps ownership honest: cost-spike,
  // behavior-digest and startup-drift are derived from data the model does not hold,
  // so a prose-authored row for one of them would be a guess wearing a fact's label.
  if (!(CLI_SOURCES as readonly string[]).includes(source)) {
    emitJson({ error: `invalid_source:${source}` });
  }

  const origin = flag(rest, 'origin') as Origin | undefined;
  const pattern = (await readStdin()).trim();

  const err = appendObservation(stateDir, {
    source: source as CliSource,
    pattern,
    sessionId: resolveSessionId(stateDir),
    origin,
  });
  if (err) emitJson(err); else emit('OK');
}

main().catch((e: any) => failJson(`unexpected:${e?.message ?? 'unknown'}`));
