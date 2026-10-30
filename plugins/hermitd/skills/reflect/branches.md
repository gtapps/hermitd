Record notes only inside an open record's turn, using `task-note` (Commands) with arguments `<id>` with the note on stdin. Otherwise skip record notes. Never edit a task file directly.

# Reflect — Branch Procedures

Main-session procedures for reflect branches that fire rarely. `SKILL.md` names the section to read at each branch point — read that section and follow it exactly; each section is self-contained. (This file is for the main session. The eval-runner subagent's spec is `reference.md` — do not dispatch this file to it.)

## Scheduled checks

Invoked from SKILL.md § Single-check mode. Evaluate exactly one supplied skill, then stop.

1. **Validate.** Require `--check-id <id> --check <cmd…>`, with a nonempty id and command. Everything after `--check` is the command verbatim, including arguments; do not parse shell quoting. If either flag or its value is missing, append one Progress Log line `[HH:MM] reflect (check): invalid-invocation; expected --check-id <id> --check <cmd…>` and stop without invoking a skill.
2. **Invoke.** Invoke exactly `<cmd…>` via the `Skill` tool once. Availability is decided only by the harness's available-skills list; do not probe the filesystem. Skill absent or rejected as unknown → `unavailable`; errors or times out → `error`; completes → evaluate its findings.
3. **Evaluate.** Actionable improvement found → `actionable`; context improvement (such as a CLAUDE.md fix) → `contextual`; nothing found → `empty`. Do not apply findings directly before the gates.
4. **Gate findings.** For `actionable` or `contextual`, build one candidate:
   ```
   Candidate: <title derived from finding>
   Tier: <classify under Candidate processing>
   Evidence Source: scheduled-check/<id>
   Evidence: <one-paragraph summary>
   Sessions: none
   ```
   Follow § Candidate processing → Evidence Validation (`hermitd:reflection-judge`), then the Proposal triage gate (`hermitd:proposal-triage`, a batch of one; pass `--caller scheduled-checks` to the `gate` verb). Obtain this run's `Anchor:` line as described in § Candidate processing and paste it as the first line of both dispatches. On judge `accept` or `downgrade`, continue to triage. On triage `create`, route Tier 1/2 to Micro-approval queuing, sending that section's operator notice at queue time before stopping in step 5, and Tier 3 to `/hermitd:proposal-create`. A `suppress` or `duplicate` status drops the candidate. A `gate_failed` status from either gate fails closed per § Gate failure handling: do not queue, create, or apply anything. For `empty`, `unavailable`, or `error`, no candidate or proposal is produced.
5. **Task note (when a record is open).** Append exactly one line to the open task record through `task.ts note`: `[HH:MM] reflect (check): <id>: <classification>; verdicts: accept=A downgrade=D suppress=S; outcome: <none|dropped|gate-failed|micro-queued|proposal-created>`. Then stop. Routine scheduling owns future invocations; this mode does not read or write per-check scheduling state.

## `skill-correction:*` routing

Invoked from SKILL.md step 3b when a graduated pattern's label matches `skill-correction:<name>`. Classify it as a skill-improvement candidate and resolve the procedure brief deterministically: glob `.hermit/compiled/procedure-brief-*.md` first, then `.hermit/compiled/.archive/procedure-brief-*.md`; match `proposed_skill_name:` frontmatter against `<name>`; prefer a live `compiled/` match over an archived one; among same-location matches pick the one with the newest `created:` frontmatter date. Then branch:

- **Brief found (self-authored, strong signal):** read the `## Lessons` section from each session listed in the graduated ledger rows' `session_id` fields to recover the correction what/why (the ledger row is a bare counter; the Lessons line carries the reason). If a cited session report is missing or unreadable, proceed with the behaviors recovered from the sessions that are available — the candidate still stands on its component name plus whatever Lessons survive. Build a candidate with a `## Skill Improvement` section listing the component name, those corrected behaviors, and `source_artifact: <brief path>` as a body line. The candidate carries `Artifact: state/observations.jsonl` (judge §1.4 validates recurrence) and is Tier 2 (Component Health finding, meaningful but non-critical). Proceed via § Candidate processing — Tier 2 routes through triage then micro-approval queue, not directly to proposal-create.
- **No brief found (human/plugin or brief fully gone, moderate signal):** read the `## Lessons` section from each session listed in the graduated ledger rows' `session_id` fields to recover the corrected behaviors, as in the brief-found branch. Build a Tier 2 candidate with a `## Skill Improvement` section listing the component name and those corrected behaviors. Do not add an anchor line; state `moderate signal` as the confidence note. The candidate carries `Artifact: state/observations.jsonl`. Do not classify `<name>` here: whether it is an editable override, a plugin skill, or gone is resolved once at accept by `proposal-act`'s falsification gate and step (e), which read the live filesystem and available-skills list at the moment the operator acts. Both branches proceed via § Candidate processing.

## `skill-preference:*` routing

Invoked from SKILL.md step 3b when a graduated pattern's label matches `skill-preference:<name>`, and from § Candidate processing for a runner `procedure_candidates` entry carrying `evidence_source: "settled-memory"`. On the ledger path only rows with source `skill-preference` reach this section — they are **pending placements**: operator settlements ("from now on, always X") recorded when no editable owning skill existed or the in-conversation edit failed. (`skill-preference-applied` rows are telemetry of settlements already applied and are excluded at step 3b.) `<name>` is the owning skill's canonical bare name when one exists, otherwise the settled output's slug.

**Resolution check (ledger path only, before anything else):** if the pattern also carries a `skill-preference-applied` row whose `ts` is newer than the newest remaining `skill-preference` row, the settlement has since been placed — drop the candidate and stop. Nothing retracts a pending row, and `prune-observations` keeps a pattern's whole history alive as long as any row in it is fresh, so without this check a resolved placement re-proposes on every reflect run (triage's consolidation exception means the gate will not suppress it either).

Recover the settled content from the pointer memory: read the operator's MEMORY.md index and the topic file whose title or body matches `<name>`. Derive the candidate title from that memory topic filename — a pending row and a sweep-emitted candidate for the same settlement then dedup by title-slug in § Candidate processing. Branch:

- **A skill named `<name>` exists** — `.claude/skills/<name>/SKILL.md` is present, or the harness's available-skills list carries a **namespaced** entry `<plugin>:<name>` (a bare `<name>` entry with no file is a user-scope or bundled skill, which `proposal-act`'s gate rejects as `stale-paths`, so it does not satisfy this branch): Tier 2 `## Skill Improvement` candidate naming `<name>` and the settled content recovered from the memory, no anchor line. Carries `Artifact: state/observations.jsonl`. Do not test whether the skill is operator-editable or plugin-shipped: an override does not shadow the plugin skill it overrides, both surface in the list, and `proposal-act` resolves the class once at accept against the filesystem and list as they are then.
- **No skill covers the output** (list readable, no file at that name, and no namespaced `<plugin>:<name>` entry — a bare `<name>` entry with no file lands here too: it is a user-scope or bundled skill this hermit cannot edit or own the settlement in): extend an adjacent owning skill as a Tier 2 `## Skill Improvement` candidate when one exists. Otherwise preserve the settled content in memory; do not propose a plain skill. Close-time learning owns reusable procedure creation.
- **Neither is established** — no file, and the available-skills list is not in context (after a compaction no `skill_listing` is re-injected, so its absence is unknown, not empty): plain Tier 2 improvement candidate naming `<name>` and the settled content, asserting neither that a skill owns the output nor that none does, and noting that re-running reflect with the list in context settles it. Carries `Artifact: state/observations.jsonl`. Never a `## Skill Improvement` here: on a `<name>` that is an output slug rather than a skill, that marker would reach accept as an authoring instruction and create a skill at that name, bypassing the Preference ladder's extend-before-create rule.

All branches proceed via § Candidate processing.

## Candidate processing

Invoked from SKILL.md (quick mode and scheduled reflect) whenever ≥1 candidate exists. The Three-Condition Rule, evidence integrity rule, gate sequence, tier routing, and queuing procedures below are normative.

**Pin the root.** Once per reflect run, before any judge, triage, or eval-runner dispatch. If this run already has the `Anchor:` line, reuse it. Otherwise:
Run `proposal-anchor` (Commands).
It prints `{"root","memory_dir"}`. Compose `Anchor: root=<root> memory_dir=<memory_dir>` from them and paste that line as the first line of every subsequent judge, triage, scheduled-checks gate, and eval-runner dispatch this run. On an `{"error"}` there is no anchor: do not dispatch, rerun with the absolute state dir the error names in place of `.hermit`.

### Three-Condition Rule

Only create a proposal if all three are true:
1. **Repeated pattern** — tier-aware recurrence:
   - **Tier 1 + `Evidence Source: current-session`**: 1+ session acceptable. Cite `Sessions: current` when the pattern is present in the open task record's Progress or Lessons (judge returns `ACCEPT (current-session)`). Phase is irrelevant for this path.
   - **Tier 1 + `Evidence Source: archived-session`**: requires 2+ archived sessions, identical to Tier 2/3. The loosening above is specific to the `current-session` path, not to Tier 1 generally.
   - **Tier 2 / Tier 3**: 2+ archived sessions required at every phase (baseline: observed more than once, across archived sessions). Ledger-graduated candidates (step 3b's mechanical promotion at `graduation_min_sessions`) satisfy recurrence via the `Artifact: state/observations.jsonl` rule (triage's condition-1 ledger clause; judge §1.4) regardless of this baseline.
   - **Artifact-cited efficiency/cost candidates**: recurrence is satisfied by the cited measurements themselves — the same waste measured ≥2 times in a machine-written state file (`Sessions: none` + `Artifact:` line; the judge verifies the file contains the cited values).
2. **Meaningful consequence** — something goes wrong without fixing it
3. **Operator-actionable change** — something the operator can concretely approve

If any of the three cannot be stated concretely, do not create the proposal. Sub-threshold observations (interesting but failing the rule) go to the observations ledger (see § Outcomes) so they can graduate on later recurrence.

**Recurring operator requests (idle broadening):** a manual request repeating on a schedule (e.g. "operator asked for dependency check 3 of last 4 Mondays") becomes a proposal with `Type: routine` and a `## Config` block containing the routine JSON:
```markdown
## Config
{"id":"weekly-deps","schedule":"0 9 * * 1","skill":"hermitd:task list","enabled":true}
```
When accepted via `proposal-act`, this JSON is parsed and added to `config.json` routines automatically.

### Evidence integrity rule (applies before calling reflection-judge)

For any candidate with `Evidence Source: current-session`, reflect must **not** add or rewrite evidence-bearing lines in the Progress or Lessons of the open task record before `reflection-judge` runs. The judge validates against pre-existing session content; injecting the pattern text immediately before the judge reads it would make the system self-certifying.

**Exempt** (always allowed, any time): the mandatory `## Progress Log` append and housekeeping notes that do not describe the candidate's pattern (e.g. skipped-scheduled-check lines, resolved-proposal notes; applying `resolution_actions` from the eval runner is housekeeping).

If the pattern is only visible to reflect via inference (cost log, token counters, timing), the candidate is not eligible for `Evidence Source: current-session` prose evidence in that run; reflect must never write the pattern into the open task record to certify itself. Two paths exist instead:
- **Artifact-cited (efficiency/cost-class only):** when a machine-written state file already contains the measurement, raise the candidate immediately with `Sessions: none` plus an `Artifact:` line citing the file and the value — the judge verifies the artifact directly (judge §0.5/§1.4) instead of suppressing `no-sessions`.
- **No qualifying artifact:** keep it sub-threshold — append it to the observations ledger and let it graduate by recurrence (SKILL.md step 3b).

Reflect-generated inferences **never** use bypass Evidence Sources (`scheduled-check/*` or `operator-request`). **One sanctioned exception:** eval-runner ownership-signal candidates carry `Evidence Source: settled-memory` — recurrence-skipping like `operator-request`, but the judge accepts only after verifying the quoted endpoint line exists in the cited memory file (judge § settled-memory quote check).

### Evidence Validation

Before acting on any proposal candidate, delegate to `hermitd:reflection-judge`. Collect **all** candidates first — including `routine_candidates` and `procedure_candidates` from the eval runner alongside think-hard candidates — then make a **single** invocation. Dedup by title-slug before passing (reflection-judge matches verdicts by title; duplicates would produce ambiguous routing). A single candidate is still passed as a batch of one. (Quick mode's stated order — one batched triage call first, then one judge batch for the CREATE survivors — is the exception in ordering only, not batching; follow the order the calling mode specifies.)

Pass candidates as a sequence of blocks separated by a blank line:
```
Anchor: root=<absolute hermit root> memory_dir=<absolute auto-memory dir>
Candidate: <title>
Tier: <1|2|3>
Evidence Source: archived-session | current-session | scheduled-check/<id> | operator-request
Evidence Origin: own-work | external-content
Evidence: <summary>
Sessions: <S-001, S-002, ...> (or "none")
Artifact: <machine-written state file> — <cited value/pattern>   (optional)
```

`Artifact:` is optional. A valid artifact is a **machine-written state file** only (`.claude/cost-log.jsonl`, `state/proposal-metrics.jsonl`, `state/observations.jsonl`); the open task record, session reports, and `compiled/` prose are never artifacts. Ledger-graduated candidates always carry it.

`Evidence Source:` defaults to `archived-session` if omitted. Plugin-check candidates use `scheduled-check/<id>` with `Sessions: none`. Tier-1 candidates with the open task record evidence use `current-session` with `Sessions: current`. Efficiency/cost artifact candidates use the default `archived-session` with `Sessions: none` plus an `Artifact:` line; judge §0.5 routes them to §1.4 artifact verification instead of suppressing `no-sessions`.

`Evidence Origin:` defaults to `own-work` if omitted. Set to `external-content` when the evidence derives from web fetches, `raw/` third-party captures, or a channel finding with an `[origin: external]` marker. The two fields are orthogonal: a candidate can be `archived-session` + `external-content`.

`scheduled-check/<id>` and `operator-request` share the same bypass policy at every gate (skip recurrence, enforce consequence + actionability). They are **kept distinct on purpose**: `scheduled-check/<id>` carries the check identifier for telemetry and debugging; `operator-request` marks human-initiated flows (a proposal the operator asked for directly).

The judge returns one verdict line per candidate, matched by `<title>`. For each candidate, record its line:
Run `proposal-gate` (Commands) with arguments `--gate judge --caller reflect` and the following stdin payload:
```text
Title: <title>
Verdict: <the judge's line for this candidate, verbatim>
```
- `accept`: proceed with the candidate at its original tier.
- `downgrade`: proceed at the revised `tier`. When the judge's reason contains `quarantine: external origin`, the judge itself already forced the tier to 3, so route to `proposal-create` and pass `Evidence Origin: external-content` through so proposal-create can write the operator-visible provenance line in the PROP body. reflect does not write the PROP body itself.
- `suppress`: if `code` is `no-sessions`, note the candidate in open record notes for future revisit. Otherwise drop silently.
- `gate_failed`: see § Gate failure handling.

### Gate failure handling

The `gate` verb fails closed by construction: an unrecognized, malformed, or empty verdict line always returns `gate_failed` and appends the `gate-failed` metric itself (agent tagged via `--gate triage|judge`); no separate append needed at the call site. On `gate_failed`: do not create or queue the candidate. Note `gate-failed: <agent>; <title>; <the agent's line, verbatim>` in open record notes. The candidate re-surfaces on the next reflect cycle.

### Component Health signal ladder

For Component Health findings (SKILL.md § Component Health): a finding whose **subject** is `reflection-judge` is not a candidate and is not sent through the judge — Progress Log only (SKILL.md). Weak signal (one-off or ambiguous) → no action. Moderate (pattern across 2-3 sessions) → create a proposal via `/hermitd:proposal-create` with the evidence (subject to the Three-Condition Rule). Strong (clear, repeated pattern) → create a proposal via `/hermitd:proposal-create` whose body carries a `## Skill Improvement` (or `## Agent Improvement`) section listing the component name, observed failures, and suggested eval criteria; when accepted via `proposal-act`, the revised skill is authored in-main from that section, or the changes are applied to the component's definition file directly for an agent improvement.

### Proposal Tier Classification

Classify every candidate into a tier before creating a proposal or acting:

- **Tier 1 — reversible, routine, low-scope:** queue micro-approval, do NOT create PROP-NNN. Example: "For 3 weeks I've added the same 5 hashtags manually. Proposing to automate that step."
- **Tier 2 — meaningful but non-critical:** queue micro-approval, create PROP-NNN only after operator says yes. Example: "Morning brief is consistently ignored on weekdays before 9am. Proposing to shift it to 9:30am."
- **Tier 3 — safety-critical, irreversible, or cross-hermit scope:** create PROP-NNN immediately via `/hermitd:proposal-create`, skip micro-approval entirely.
- **External-origin override:** any candidate with `Evidence Origin: external-content` is **Tier 3 regardless of apparent reversibility** — route to `proposal-create`, never to the micro-approval queue. External content can carry crafted patterns aimed at injecting learned habits into the agent; forcing full operator review closes that path.

`routine_candidates` from the eval runner are Tier 1; any pre-rendered `shell_findings_line` (diagnostic entries) goes to the open task record's Progress directly; no judge/triage needed for diagnostics, only for disable/retime action candidates.

### Proposal triage gate

Before queuing micro-approvals or calling `proposal-create`, gate **all** candidates reaching this step with `hermitd:proposal-triage` in a **single batched call** (a single candidate is still passed as a batch of one). Pass `Evidence Source:`, `Evidence Origin:` and `Artifact:` when known, as a sequence of blocks separated by a blank line:
```
Anchor: root=<absolute hermit root> memory_dir=<absolute auto-memory dir>
Title: <title>
Evidence Source: <value from the candidate, or omit to default to archived-session>
Evidence Origin: <own-work | external-content, or omit to default to own-work>
Evidence: <one-paragraph evidence summary>
Artifact: <the candidate's Artifact: line, verbatim, when it has one>
```

The gate returns one verdict block per candidate, matched by `<title>`. Line 1 of each block is that candidate's verdict; lines 2+ are additive metadata (`closest_prop`, `aligned`, `operator_excerpt`, `overlap_compiled`, `failed_condition`) — read for context if useful, but do not treat as part of the verdict for branching. For each candidate, record its verdict line (use `"caller":"reflect"` on a normal reflect run, or `"caller":"scheduled-checks"` when invoked via § Scheduled checks):
Run `proposal-gate` (Commands) with arguments `--gate triage --caller reflect` and the following stdin payload:
```text
Title: <title>
Verdict: <that candidate's line 1, verbatim>
```
- `create`: proceed
- `duplicate`: link to the existing proposal `id` in open record notes instead, do not create
- `suppress`: drop silently
- `gate_failed`: see § Gate failure handling, for that candidate only; the rest of the batch proceeds on its own verdicts.

### Outcomes

After validating with `hermitd:reflection-judge`, choose exactly one outcome per observation:

1. **No action** — pattern not strong enough, already handled, or already addressed by the Resolution Check.
2. **Memory update** — for **durable lessons** worth remembering for future sessions: operator-stated rules, preferences that recurred, decision rationales that may apply later, workflow patterns that worked (subject to the placement rule — settled task-scoped or multi-step content belongs to the skill owning the task, with memory as the pointer). Issue the standard "remember it" reflection — the trained auto-memory flow handles the write, with its own discipline (concise, MEMORY.md ≤ 200 lines / 25KB, topic files for detail, respect WHAT_NOT_TO_SAVE). Save nothing if nothing rises above noise. Sub-threshold *patterns* do NOT go to memory — they go to the observations ledger; keeping the recurrence store separate from operator memory is what prevents triage's `covered-by-memory` check from suppressing a pattern at the moment it graduates.
3. **Proposal candidate**: classify tier (§ Proposal Tier Classification) for every candidate reaching this outcome, batch them all through the Proposal triage gate together, then per candidate on its own verdict: Tier 1/2 `create` → queue micro-approval in `state/micro-proposals.json`; Tier 3 `create` → call `/hermitd:proposal-create`.

Sub-threshold observations do not surface to the operator in steady state. Before appending, follow SKILL.md's once-per-run `observations-patterns` lookup and reuse the label for the same component and failure. The label goes on stdin, so apostrophes in it are safe:
Run `observations-observe` (Commands) with arguments `reflect-noticed --origin=own-work` and the following stdin payload:
```text
<short pattern label>
```
They graduate via SKILL.md step 3b. Pass `--origin=external-content` instead of `own-work` when the observation derives from an open task record note carrying an `[origin: external]` marker (copy the marker deterministically, don't infer from content). Reuse the exact label when re-observing a known pattern; grouping is by string equality. Only append when a genuine pattern is noticed.

**Phase-aware surfacing exception:**
- `newborn`: also log each sub-threshold observation inline to a task note as `Noticed: <pattern>` (single line, no ceremony).
- `juvenile`: emit a weekly digest instead of per-observation lines. Read `last_digest_at` from `state/reflection-state.json` (top-level, may be absent). If absent or older than 7 days, write a single `Noticed (digest): <N> observations; <top 3 pattern labels>` line to open record notes, and include `"last_digest_at": "<now ISO>"` in the State Update payload so it persists.
- `adult`: silent (baseline).

### Micro-approval queuing

Every micro-proposal question must include: **[observed pattern + duration] + [consequence] + [exact proposed change] + "Yes / No"** (or the exact option labels, for an `options` entry). Do not queue vague questions like "Found a pattern. Want me to improve it?" — all three components must be present.

Queuing procedure:

Run `proposal-queue-micro` (Commands) and the following stdin payload:
```text
{"tier":<1|2>,"question":"<full question text>","options":["<label>", ...],"on_resolve":"<full skill invocation with an {answer} placeholder>","chat":"<sourceKey>:<chat_id>","key":"<stable ask name>"}
```
`key` is optional: a stable name for an ask that may be queued again in new words.
Set `chat` to the normalized key of the chat the question is sent to: the current chat on a channel-tagged turn, or `<sourceKey>:<maintainer_channel_id>` for a maintainer-only notice that reaches a maintainer chat. Only a reply there can answer the entry. Omit it when the question goes to the home chat: the script records the home chat. `options` and `on_resolve` are optional — used by channel-bridged asks from other skills (see `channel-responder` § Channel-safe ask bridge) as well as reflect's own future N-way candidates. When `on_resolve` is present, the script forces `tier: 1` regardless of the caller-supplied tier (so tier-1 readers like heartbeat keep working unchanged) and tags the metrics event `"kind":"ask"` (a bounded ask is not a yes/no approval, so `generate-summary.ts`/`weekly-review.ts` exclude it from approval-rate calculations).

- `queued`: the script generates the day-scoped `id` (`MP-YYYYMMDD-N`), appends the `pending` entry to `state/micro-proposals.json`, and logs the `micro-queued` metric event.
- `duplicate`: a pending entry with the same `question`, `key` or linked proposal already exists (its `id` is returned); the script keeps that entry and gives it the new `question`.

Notify the operator with the question (using the returned or existing id). Entries without `options`: `MP-YYYYMMDD-N (tier <N>): <question>` — Reply `"MP-YYYYMMDD-N yes"` or `"MP-YYYYMMDD-N no"` (bare `yes`/`no` accepted when only one entry is pending). Entries with `options`: render them numbered (`1. <label>`, `2. <label>`, ...) under the question and hint `Reply "MP-YYYYMMDD-N <number or label>"` (bare number/label accepted when only one entry is pending).
