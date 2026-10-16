---
name: reflect
description: Reflect on recent work and propose improvements if patterns are noticed.
---

Record notes only inside an open record's turn, using `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id>` with the note on stdin. Otherwise skip record notes. Never edit a task file directly.

# Reflect

Pause and think about your recent work.

**Silent by default.** Only notify the operator (per CLAUDE.md § Operator Notification) if reflect produces an outcome: a proposal candidate, a micro-approval, a resolved proposal, a graduated observation, or a cost spike.

Rare-branch procedures live in `${CLAUDE_PLUGIN_ROOT}/skills/reflect/branches.md`. "Read branches.md § X" means: read that section now and follow it exactly — it is normative.

## Commands
- `proposal-success-signal`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts success-signal .hermit`
- `routines-health`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/routines.ts health .hermit`
- `task-report`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-report.ts .hermit --recent --limit 3`
- `observations-observe`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts observe .hermit`
- `proposal-anchor`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts anchor .hermit`
- `proposal-gate`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts gate .hermit`
- `proposal-metrics`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts metrics .hermit`
- `proposal-queue-micro`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts queue-micro .hermit`
- `task-note`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit`

## Quick mode

If `$ARGUMENTS` contains `--quick`:

- **Obtain the quick-hash verdict.** With `--precheck-verdict '<verdict>'`: the `reflect_after` routine already ran the hash-gate precheck; `<verdict>` is always a run verdict (the routine stops on `empty` without loading this skill). Take its `hash`; do **not** re-run the precheck. Otherwise (manual invocation) run it in force mode (no gate to skip once this skill is loaded; always returns a `hash`):
  ```
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/reflect-precheck.ts .hermit ${CLAUDE_PLUGIN_ROOT} --quick --force
  ```
- **Skip** the cadence precheck (the hash-gate is separate and narrower), cost_spike read, proposal scan, Resolution Check, and Component Health. Bind `$PHASE = adult`. Only the fresh task-record digest + judge + outcomes path runs.
- Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-report.ts .hermit --recent --limit 3`; use titles, lessons and waiting reasons for actionable patterns. **Only Tier-1 + `Evidence Source: current-session` candidates are eligible.** Candidates needing archived-session evidence or Tier 2/3 defer to the next scheduled reflect — append one ledger row each so the signal survives archival and can graduate:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts observe .hermit quick-deferral <<'HERMIT_OBSERVATION'
  <candidate-title-slug>
  HERMIT_OBSERVATION
  ```
  **Exception:** a `current-session` candidate with `Evidence Origin: external-content` is **not** deferred — send it to the judge; Tier-3 escalation routes it to `proposal-create`.
- If any eligible candidate remains: Read branches.md § Candidate processing. Triage all candidates passing the evidence integrity rule in one `hermitd:proposal-triage` batch call, judge the `create` survivors in one `hermitd:reflection-judge` call, route ACCEPT/DOWNGRADE through branches.md § Outcomes; unrecognized gate output fails closed per branches.md § Gate failure handling. **Track whether anything hit the gate_failed/suppress path**: it gates the cursor write.
- Append one Progress Log line: `[HH:MM] reflect (quick, post-routine) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`; when suppress>0 add the `; suppressed:` suffix (§ Progress Log Entry).
- **Advance the quick-hash cursor only on a clean run** (no gate_failed/suppress); otherwise skip this call: an unchanged `last_quick_hash` makes the next `reflect_after` fire re-read the same Findings/Blockers (the "re-surfaces next cycle" contract; deferred candidates are already durable in the ledger):
  ```
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/update-reflection-state.ts .hermit/state/reflection-state.json --quick-hash '<hash>'
  ```
- **Never call the counter-incrementing `update-reflection-state.ts <path> '<json-payload>'` form here** — quick runs are event-driven; mutating `last_run_at` would suppress the next scheduled reflect (`--quick-hash` is an isolated write).
- Stop. Do not continue below.

## Single-check mode

If `$ARGUMENTS` contains `--check-id` or `--check`, read branches.md § Scheduled checks and follow it exactly, then **stop** (no precheck or numbered steps below). The invocation is `reflect --check-id <id> --check <cmd…>`: everything after `--check` is the skill command, including its arguments, verbatim. A routine owns the cadence and may pin the model for this invocation.

## Judge evidence handoff

For every `hermitd:reflection-judge` call, include `Task records:` with the fresh
normalized adapter rows already read, preserving their `source_path`, outcome, title, lessons,
and waiting reason. Candidate `Sessions:` identifiers for record evidence are task IDs from those
source paths; the existing evidence-source and return-field names stay compatible. A candidate
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
   - Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts graduate .hermit`. It prints one JSON line — the patterns that cleared the session threshold and the graduation cursor this run: `[{"pattern", "sessions": [...], "origin": "own-work"|"external-content", "rows": N}]`. An empty array means nothing graduated; continue.
   - Build one candidate per entry: `Evidence Source: archived-session`, `Evidence Origin: <origin>`, `Sessions: <sessions>`, `Artifact: state/observations.jsonl — pattern "<pattern>" in <sessions.length> sessions`; route via § Candidate processing.
   - When a graduated label matches `skill-correction:<name>`: Read branches.md § `skill-correction:*` routing and follow it (brief resolution → Tier 2 Skill Improvement candidate).
   - When a graduated label matches `procedure-noticed:<slug>`: Read branches.md § Procedure capture, evaluate its **Kill criteria** block, then follow it from the **Dedup guard** onward (skip the runner-entry paragraph — that describes `procedure_candidates` shape only). Carry `Artifact: state/observations.jsonl` like every ledger graduation, and keep the slug: step 7 drops the runner candidate carrying it, which is the same procedure arriving by its second route.
   - When a label matches `skill-preference:<name>`: Read branches.md § `skill-preference:*` routing and follow it.
   - After the grouping above, **record the current UTC timestamp** as `$GRAD_CURSOR` (`date -u +%Y-%m-%dT%H:%M:%SZ`) and carry it to State Update. Do not write it yet: the cursor is written there, only on a clean run (§ State Update). Capture it here and write it in § State Update: rows Candidate processing appends *after* this point stay fresh for the next run, and a `gate_failed` graduation re-surfaces instead of waiting for a brand-new row.
4. **Phase**: bind `$PHASE` to the precheck verdict's `phase` field (missing → `adult`, never block). `$PHASE` gates sub-threshold surfacing and the Progress Log annotation.
5. Rebuild and read the proposals index (metadata only, no file bodies): run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts index .hermit`, then read `state/proposals-index.json` for each proposal's `id`, `status`, `title`, `source`, `created`, `accepted_date`, `related_sessions` (rows flagged `unparseable` have no frontmatter block; skip them). Also tail the last 100 lines of `state/proposal-metrics.jsonl` (inline, single read): count `responded` and `micro-resolved` events by `action`, `triage-verdict` events by `verdict` — feeds the operator-value and Component Health checks.

6. **Dispatch the eval runner.** Dispatch `hermitd:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/reflect/reference.md`. The dispatch prompt carries: this run's `Anchor:` line as its first line (`bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts anchor .hermit`; non-zero exit → rerun with the absolute state dir the error names in place of `.hermit`, do not dispatch), `plugin_root` (resolved absolute path; `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md`), the precheck's `phases` as `phases_json`, the `last_resolution_check` cursor (from `state/reflection-state.json`), and the execution observation from `task.ts list` (controls the routine check). The `Anchor:` line's `memory_dir` is the auto-memory directory `reference.md` expects under the name `memory-dir`.

   Copy this skill's Commands entries verbatim into the dispatch prompt (already absolute); the runner uses them with the reference's arguments.

   **Failure policy:** null/malformed runner JSON → fail open: skip the apply steps, carry forward empty candidate lists, do not advance the cursor, append `[HH:MM] reflect — analysis-runner failed; introspection-only` to the Progress Log, continue.

**Eval runner return schema** — byte-identical in `reference.md` (producer) and here; contract-tested.

<!-- reflect-eval-schema:start -->
```json
{
  "resolution_actions": [ { "proposal_id": "PROP-NNN", "action": "auto-resolve|nudge|skip",
                            "frontmatter_patch": {"status":"resolved","resolved_date":"<ISO>"}|null,
                            "shell_findings_line": "<pre-rendered finding text>"|null } ],
  "routine_candidates": [ { "routine_id": "<id>", "action": "disable|retime|diagnostic",
                            "tier": 1, "schedule": "<new-cron>"|null,
                            "evidence": "<text>", "sessions": ["<T-...>"],
                            "shell_findings_line": "<pre-rendered>"|null } ],
  "procedure_candidates": [ { "slug": "<slug>", "title": "<title>", "tier": 3,
                              "evidence_source": "archived-session", "evidence_origin": "own-work",
                              "evidence": "<text>", "sessions": ["<T-...>"]|"none",
                              "artifact": "<file — value>"|null } ],
  "last_resolution_check": "PROP-NNN|null",
  "last_sparse_nudge": { "PROP-NNN": "<ISO>" }
}
```
<!-- reflect-eval-schema:end -->

   **Apply `resolution_actions`** (housekeeping; exempt from the evidence integrity rule): pipe the runner's `resolution_actions` via a quoted heredoc (model-authored JSON may contain apostrophes) to the transactional apply script; it validates the whole batch before any write (a malformed batch writes nothing), then performs the frontmatter patches, `state/proposal-metrics.jsonl` appends itself (nudge debounce handled in the runner):
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-reflection-actions.ts .hermit <<'HERMIT_REFLECT_ACTIONS'
   {"resolution_actions": <the runner's resolution_actions array>}
   HERMIT_REFLECT_ACTIONS
   ```
   Parse its single JSON line: `ok === false` or empty stdout → treat as the step-6 failure policy (skip apply, append `[HH:MM] reflect — apply-reflection-actions failed; introspection-only` to the Progress Log, continue). Carry the other four return fields to Candidate processing and State Update.

Now reflect using **inherited context only** (normalized task records from step 2, cost shape from step 3, behavior digest from step 3a, metrics summary from step 5; the runner handled cross-session file analysis — do not re-read session reports or proposal bodies). Signals: anything recurring or worked around instead of fixed? Spending proportional to the work — could a cheaper model tier have handled it; was context bloat avoidable? Something done manually that a skill covers, or a repeating subtask within the session a subagent could have handled? Value the operator actually uses — high `dismiss`/`rejected` rates from step 5 signal noise (Tier 1 micro-proposal to pare back); a high `expired` rate means poor question timing, not unwanted questions (`moot` is not that signal — it means the linked proposal was resolved, dismissed, or deferred before the answer arrived, so the question stopped applying). The same multi-step procedure in ≥2 sessions with no covering skill (procedure-capture candidate)? If the execution observation is `idle`, think broader: a recurring check for HEARTBEAT.md, a missing operator preference (memory, or the skill owning the output), a skill/subagent to formalize repeating work, a manual request repeating on a schedule (routine-type candidate; branches.md § Candidate processing has the `Type: routine` Config-block format).

## Component Health

Is any skill, agent, or hook underperforming? **Skills:** output consistently corrected after use (answered from the `skill-correction:*` ledger graduation in step 3b, not re-derived from prose)? Avoided for manual steps? Missed something it should catch? Disproportionate tokens for its value? **Agents:** flag `reflection-judge` when `counters.judge_window.suppress` > 2× `counters.judge_window.accept` and `counters.judge_window.verdicts` ≥ 5: the window holds the last 20 judge verdicts, so the flag clears on its own once the judge recovers. Read the ratio only from `counters.judge_window`, and when it is absent or unreadable do not flag; never fall back to the cumulative `counters.judge_suppress`/`judge_accept` tallies. This flag is audit-only: append `; component-health: reflection-judge suppress-ratio` to the Progress Log line and nothing else. Flag `proposal-triage` when step 5's `suppress` > 2× `create` (≥5 verdicts): the gate may be over-strict. **Hooks:** out of scope (no telemetry): do not infer from side-effects; note as a known gap if suspected. Other Component Health findings become candidates (signal ladder + `## Skill Improvement` format: branches.md § Candidate processing).

## Candidate processing

Collect **all** candidates first — think-hard observations, step-3b graduations, `routine_candidates` and `procedure_candidates` from the runner, Component Health findings. None → skip to State Update. Any → follow branches.md § Candidate processing exactly (it is normative; this summary is orientation) — read the file now only if step 3b's `skill-correction:*` branch didn't already load it earlier this run:

- **Three-Condition Rule** (repeated pattern + meaningful consequence + operator-actionable change): recurrence is tier-aware — Tier-1 `current-session` needs 1 session; Tier-1 archived and Tier 2/3 need 2+ distinct archived sessions; artifact-cited efficiency/cost candidates cite a **machine-written state file** (`Artifact:` line, `Sessions: none`); procedure capture has an ephemerality exception. Failing candidates go sub-threshold to the ledger.
- **Gates and routing**: never write a candidate's pattern into the open task record before the judge reads it (no self-certification). One `hermitd:reflection-judge` batch (dedup by title-slug first), then one batched `hermitd:proposal-triage` call before any queue/create; unrecognized gate output fails closed (`gate-failed` metric + Progress Log note; re-surfaces next cycle). **Track whether anything hit the gate_failed path**; it gates the graduation-cursor write in § State Update. Tier 1/2 → micro-approval queue (`state/micro-proposals.json`); Tier 3 → `/hermitd:proposal-create`; **`Evidence Origin: external-content` is always Tier 3** (quarantine). Runner `routine_candidates` are Tier 1 (pre-rendered diagnostic `shell_findings_line` entries are recorded through `task.ts note` when a record is open, no gates); `procedure_candidates` route through branches.md § Procedure capture (dedup guard, brief, `## Skill Draft`, kill criteria), minus any whose `slug` a `procedure-noticed:<slug>` graduation already carried through that section in step 3b; **except** entries carrying `evidence_source: "settled-memory"` (the runner's ownership signal), which route through branches.md § `skill-preference:*` routing instead: they relocate settled content into a skill that usually already exists, so Procedure capture's dedup guard would suppress them, and they take no procedure brief, no forced Tier 3, and no place in the procedure-capture kill-criteria sample.
- **Sub-threshold observations** → ledger append with a short stable `pattern` label, `"source":"reflect-noticed"`, `"origin":"own-work"` — or `"origin":"external-content"` when the finding carries an `[origin: external]` marker (copy, never infer). Reuse exact labels; grouping is string equality. Phase surfacing: `newborn` logs `Noticed:` lines, `juvenile` emits a weekly digest (sets `last_digest_at`), `adult` is silent.

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

`judge_suppress_by_code` counts judge `suppress` verdicts by canonical code; omit zero-count codes, omit the key when `judge_suppress` is 0. Add `"last_digest_at":"<now ISO>"` only when a juvenile digest fired. Add `"last_behavior_digest_at":"<now ISO>"` whenever the `behavior` phase fired (step 3a): this advances its weekly cursor; omit it otherwise. Add `"last_sparse_nudge":{"<PROP-NNN>":"<now ISO>"}` when the runner returned a non-empty `last_sparse_nudge` map (the script merges it). The script handles counters, timestamps, `since` preservation, and atomic write; always exits 0. Counters are diagnostic, not audit-grade.

## Progress Log Entry (non-empty runs)

On every run reaching this point (not an `empty` verdict), append to the open task record through `task.ts note`:

`[HH:MM] reflect (<phase>) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`

When suppress>0, append `; suppressed: [<slug>: <code>, ...]`; canonical codes from the judge/triage verdicts (`no-evidence`, `no-sessions`, `weak-recurrence`, `weak-consequence`, `not-actionable`), capped at 3 with `+N more`. When the Component Health `reflection-judge` 2× flag tripped, append `; component-health: reflection-judge suppress-ratio`. `<phase>` is `newborn`/`juvenile`/`adult` (step 4; a missing `phase` field annotates `adult` silently). This is the audit trail; the silent-by-default rule governs operator pings only; record the log line only inside an open record's turn.
