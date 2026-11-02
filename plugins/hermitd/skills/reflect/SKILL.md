---
name: reflect
description: Reflect on recent work and propose improvements if patterns are noticed.
---

Record notes only inside an open record's turn, using `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id>` with the note on stdin. Otherwise skip record notes. Never edit a task file directly.

# Reflect

Pause and think about your recent work.

**Silent by default.** Only notify the operator (per § Operator Notification) if reflect produces an outcome: a proposal candidate, a micro-approval, a resolved proposal, a graduated observation, or a cost spike.

Rare-branch procedures live in `${CLAUDE_PLUGIN_ROOT}/skills/reflect/branches.md`. "Read branches.md § X" means: read that section now and follow it exactly — it is normative.

## Commands
- `reflect-precheck`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/reflect-precheck.ts .hermit ${CLAUDE_PLUGIN_ROOT}`
- `update-reflection-state`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts .hermit/state/reflection-state.json`
- `proposal-success-signal`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts success-signal .hermit`
- `routines-health`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/routines.ts health .hermit`
- `task-report`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-report.ts .hermit --recent --limit 3`
- `observations-patterns`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts patterns .hermit`
- `observations-observe`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts observe .hermit`
- `proposal-anchor`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts anchor .hermit`
- `proposal-gate`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts gate .hermit`
- `proposal-queue-micro`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts queue-micro .hermit`
- `task-note`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit`

Before writing a `quick-deferral` or `reflect-noticed` row, run `observations-patterns` (Commands) once per run. Reuse an existing label that names the same component and failure; create a short stable label only when none matches. Use that exact label on stdin for each observation.

## Quick mode

If `$ARGUMENTS` contains `--quick`, read `${CLAUDE_PLUGIN_ROOT}/skills/reflect/quick.md`, follow it, and stop afterward.

## Single-check mode

If `$ARGUMENTS` contains `--check-id` or `--check`, read branches.md § Scheduled checks and follow it exactly, then **stop** (no precheck or numbered steps below). The invocation is `reflect --check-id <id> --check <cmd…>`: everything after `--check` is the skill command, including its arguments, verbatim. A routine owns the cadence and may pin the model for this invocation.

## Judge evidence handoff

For every `hermitd:reflection-judge` call, include `Task records:` with the fresh
normalized adapter rows already read, preserving their `source_path`, outcome, title, lessons,
and waiting reason. Candidate `Sessions:` identifiers for record evidence are task IDs from those
source paths. A candidate
outside that bounded evidence set needs another targeted adapter read, not an archive fallback.

## Scheduled reflect

1. Determine whether a full run is warranted. With `--precheck-verdict '<verdict>'`: the reflect routine already ran the precheck in bash; use `<verdict>` directly, do **not** re-run it (always status `run`; the routine stops on `empty` without loading this skill). Otherwise run it yourself and read its JSON:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/reflect-precheck.ts .hermit ${CLAUDE_PLUGIN_ROOT}
   ```
   - status `empty` → nothing due; the precheck already updated `reflection-state.json`. Emit `reflect: no candidates` and stop.
   - status `run` → continue. `phases` lists due phases (`cost_spike`, `behavior`, `resolution_check`, `compute`, `digest`, `newborn`, `observations_fresh`); skip sections for phases not listed. `observations_fresh` means the ledger has rows newer than `last_run_at`; run step 3b even if `compute` is absent.
2. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-report.ts .hermit --recent --limit 3` for the three most recent done, cancelled or unconfirmed records. Read `task.ts list .hermit --open --json` for the execution observation. Read fresh; never fall back to session archives.
3. If `cost_spike` is listed: the precheck already detected the spike and wrote the row (`cost-spike:<YYYY-MM-DD>` — the measured day, which is **yesterday**, carrying `day_total` and `median_7d` as fields), so there is nothing to read or record here — it graduates via step 3b like any other observation. Do **not** re-read cost-log.jsonl to restate a number the precheck already computed.

3a. **Behavioral digest** — if `behavior` is listed: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/transcript-digest.ts .hermit --record-observation` (bounded ~20-line JSON of ground-truth counters — tool failures, tool_rejections by kind, wakes vs productive_wakes, compaction_events, subagent_dispatches; never `Read` a transcript directly). Two uses of the counters:
   - **Defer-loop auto-row**: `--record-observation` makes the script write the `defer-loop` row itself when its own counters cross the threshold, citing the observed `window.from→to` span. Nothing to record here. (The flag is opt-in so an ad-hoc digest run stays a pure read.)
   - **Anomaly checklist** — carry the JSON as inherited context to the think-hard step and form one candidate per hit, citing the digest JSON (machine-written-state evidence class): any `tool_rejections.automode-blocked > 0`; any single tool with `tool_failures[tool] ≥ 5`; `compaction_events ≥ 3`. A hit is a **question for the gates** (triage → judge), never a verdict — a quiet week with mostly unproductive wakes is legitimate, so the gates own false-positive pruning.

3b. **Observations ledger** — prune, then graduate recurring patterns.
   - Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/prune-observations.ts .hermit` (fail-open).
   - Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts graduate .hermit`. It prints the patterns that cleared the session threshold and the graduation cursor this run: `{"candidates":[{"pattern", "sessions": [...], "origin": "own-work"|"external-content", "rows": N}]}`. Empty `candidates` means nothing graduated; continue.
   - Build one candidate per entry: `Evidence Source: archived-session`, `Evidence Origin: <origin>`, `Sessions: <sessions>`, `Artifact: state/observations.jsonl — pattern "<pattern>" in <sessions.length> sessions`; route via § Candidate processing.
   - When a label matches `skill-preference:<name>`: Read branches.md § `skill-preference:*` routing and follow it.
   - After the grouping above, **record the current UTC timestamp** as `$GRAD_CURSOR` (`date -u +%Y-%m-%dT%H:%M:%SZ`) and carry it to State Update. Do not write it yet: the cursor is written there, only on a clean run (§ State Update). Capture it here and write it in § State Update: rows Candidate processing appends *after* this point stay fresh for the next run, and a `gate_failed` graduation re-surfaces instead of waiting for a brand-new row.
4. **Phase**: bind `$PHASE` to the precheck verdict's `phase` field (missing → `adult`, never block). `$PHASE` gates sub-threshold surfacing and the Progress Log annotation.
5. Tail the last 100 lines of `state/proposal-metrics.jsonl` (inline, single read): count `responded` and `micro-resolved` events by `action`, `triage-verdict` events by `verdict` — feeds the operator-value and Component Health checks.

6. **Dispatch the eval runner.** Dispatch `hermitd:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/reflect/reference.md`. The dispatch prompt carries: this run's `Anchor:` line as its first line (fields: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts anchor .hermit`; non-zero exit → rerun with the absolute state dir the error names in place of `.hermit`, do not dispatch), `plugin_root` (resolved absolute path; `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md`), the precheck's `phases` as `phases_json`, the `last_resolution_check` cursor (from `state/reflection-state.json`), and the execution observation from `task.ts list` (controls the routine check). The `Anchor:` line's `memory_dir` is the auto-memory directory `reference.md` expects under the name `memory-dir`.

   Copy this skill's Commands entries verbatim into the dispatch prompt (already absolute); the runner uses them with the reference's arguments.

   **Failure policy:** null/malformed runner JSON → fail open: skip the apply steps, carry forward empty candidate lists, do not advance the cursor, append `[HH:MM] reflect — analysis-runner failed; introspection-only` to the Progress Log, continue.

The eval runner return schema is in `reference.md` § Return Value.

   **Apply `resolution_actions`** (housekeeping; exempt from the evidence integrity rule): pipe the runner's `resolution_actions` via a quoted heredoc (model-authored JSON may contain apostrophes) to the transactional apply script; it validates the whole batch before any write (a malformed batch writes nothing), then performs the frontmatter patches, `state/proposal-metrics.jsonl` appends itself (nudge debounce handled in the runner):
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-reflection-actions.ts .hermit <<'HERMIT_REFLECT_ACTIONS'
   {"resolution_actions": <the runner's resolution_actions array>}
   HERMIT_REFLECT_ACTIONS
   ```
   An `{"error"}` (nothing written) or empty stdout → treat as the step-6 failure policy (skip apply, append `[HH:MM] reflect — apply-reflection-actions failed; introspection-only` to the Progress Log, continue). Carry the other four return fields to Candidate processing and State Update.

Now reflect using **inherited context only** (normalized task records from step 2, cost shape from step 3, behavior digest from step 3a, metrics summary from step 5; the runner handled cross-session file analysis — do not re-read task records or proposal bodies). Signals: anything recurring or worked around instead of fixed? Spending proportional to the work — could a cheaper model tier have handled it; was context bloat avoidable? Something done manually that a skill covers (see branches.md § Learning-shape check), or a repeating subtask within the session a subagent could have handled? Value the operator actually uses — high `dismiss`/`rejected` rates from step 5 signal noise (Tier 1 micro-proposal to pare back); a high `expired` rate means poor question timing, not unwanted questions (`moot` is not that signal — it means the linked proposal was resolved, dismissed, or deferred before the answer arrived, so the question stopped applying). If the execution observation is `idle`, think broader: a recurring check for HEARTBEAT.md, a missing operator preference (memory, or the skill owning the output), an agent to formalize a context-heavy sub-step, a manual request repeating on a schedule (routine-type candidate; branches.md § Candidate processing has the `Type: routine` Config-block format).

## Component Health

Is any skill, agent, or hook underperforming? **Skills:** output consistently corrected after use (answered from the lessons in the task records read in step 2)? Avoided for manual steps? Missed something it should catch? Disproportionate tokens for its value? **Agents:** flag `reflection-judge` when `counters.judge_window.suppress` > 2× `counters.judge_window.accept` and `counters.judge_window.verdicts` ≥ 5: the window holds the last 20 judge verdicts, so the flag clears on its own once the judge recovers. Read the ratio only from `counters.judge_window`, and when it is absent or unreadable do not flag; never fall back to the cumulative `counters.judge_suppress`/`judge_accept` tallies. This flag is audit-only: append `; component-health: reflection-judge suppress-ratio` to the Progress Log line and nothing else. Flag `proposal-triage` when step 5's `suppress` > 2× `create` (≥5 verdicts): the gate may be over-strict. **Hooks:** out of scope (no telemetry): do not infer from side-effects; note as a known gap if suspected. Other Component Health findings become candidates (signal ladder + `## Skill Improvement` format: branches.md § Candidate processing).

## Candidate processing

Collect **all** candidates first — think-hard observations, step-3b graduations, `routine_candidates` and `procedure_candidates` from the runner, Component Health findings. None → skip to State Update. Any → follow branches.md § Candidate processing exactly — read the file now only if step 3b's `skill-preference:*` branch didn't already load it earlier this run.

## State Update

After each reflection run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts \
  .hermit/state/reflection-state.json \
  '{"last_resolution_check":"<last-PROP-NNN-or-null>","ran_with_candidates":<true|false>,"judge_accept":<N>,"judge_downgrade":<N>,"judge_suppress":<N>,"judge_suppress_by_code":{"no-evidence":<N>,"no-sessions":<N>,"covered-by-memory":<N>},"proposals_created":<N>,"micro_proposals_queued":<N>}'
```

**Then advance the step-3b graduation cursor: only on a clean run** (nothing hit the gate_failed path this run), passing the `$GRAD_CURSOR` captured in step 3b. Skip the call otherwise: an unchanged `last_graduation_at` is what makes a graduated pattern whose candidate failed a gate re-surface on the next cycle (branches.md § Gate failure handling), and its rows are already durable in the ledger. Same rule as the quick-hash cursor. Omit the call entirely when step 3b did not run.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts \
  .hermit/state/reflection-state.json --graduation-cursor '<$GRAD_CURSOR>'
```

`judge_suppress_by_code` counts judge `suppress` verdicts by canonical code; omit zero-count codes, omit the key when `judge_suppress` is 0. Add `"last_digest_at":"<now ISO>"` only when a juvenile digest fired. Add `"last_behavior_digest_at":"<now ISO>"` whenever the `behavior` phase fired (step 3a): this advances its weekly cursor; omit it otherwise. Add `"last_sparse_nudge":{"<PROP-NNN>":"<now ISO>"}` when the runner returned a non-empty `last_sparse_nudge` map (the script merges it). The script handles counters, timestamps, `since` preservation, and atomic write. Counters are diagnostic, not audit-grade.

## Progress Log Entry (non-empty runs)

On every run reaching this point (not an `empty` verdict), append to the open task record through `task.ts note`:

`[HH:MM] reflect (<phase>) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`

When suppress>0, append `; suppressed: [<slug>: <code>, ...]`; canonical codes from the judge/triage verdicts (`no-evidence`, `no-sessions`, `weak-recurrence`, `weak-consequence`, `not-actionable`), capped at 3 with `+N more`. When the Component Health `reflection-judge` 2× flag tripped, append `; component-health: reflection-judge suppress-ratio`. `<phase>` is `newborn`/`juvenile`/`adult` (step 4; a missing `phase` field annotates `adult` silently). This is the audit trail; the silent-by-default rule governs operator pings only; record the log line only inside an open record's turn.
