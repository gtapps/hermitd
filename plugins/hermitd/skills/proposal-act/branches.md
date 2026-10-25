# Proposal Act branches

Rare-branch procedures for `proposal-act/SKILL.md`. Read only the section the dispatch names; each one is normative. Bare "step N" means `SKILL.md` § Accept Flow. The lettered steps (a), (b), (e), e.5, e.6, (f) and the install flows' numbered steps are local to § Start implementing now. "The resolution algorithm" is `SKILL.md` § Resolving a Proposal ID.

## Start implementing now

Run the falsification gate, then handle session lifecycle, then execute in this turn.
**Falsification gate (runs first, before any session transition).** Verify the proposal is actionable as written with a read-only pass. Skip when the body contains `## Skill Improvement` or `## Skill Draft` — both are skill-authoring, handled in-main (step (e) / the routine-bound install flow), not a code-edit plan. Skip too when `## Operator Decision` carries a `Handed to helper <n>` line and [reuse-spawned-helper.md](reuse-spawned-helper.md) takes it: that helper re-checks the cited files as its first step, and the fallback there runs this gate before Dispatch. For `## Skill Draft`, first check that the `source_artifact` path exists and is readable: read a `.hermit/helper-reports/` procedure file in place; for a legacy brief, search `compiled/` then `compiled/.archive/` for the same basename and reading the archived copy on a match (if the file is missing from both locations or unreadable, REJECT with code `stale-paths` — the procedure brief was removed; the operator should refresh the proposal input). For `## Skill Improvement`, first resolve the component name to `.claude/skills/<name>/SKILL.md`. `stale-paths` fires only when the target is provably gone: that file is missing **and** `<name>` is not an installed plugin skill (a namespaced `<plugin>:<name>` entry in the available-skills list; a bare `<name>` entry is operator-space or bundled, not a plugin one). A missing file for a name that is still an installed plugin skill is a plugin-shipped-skill improvement, not a stale path: let it through, step (e) routes it to operator space. If the available-skills list is not in context, proceed; step (e)'s operator confirmation guards the override path.

  For any other body, use the native `Plan` agent as the read-only subagent. Read only the returned text; ignore any file it writes under `~/.claude/plans/`. If the agent errors → record a one-line warning with `task.ts note .hermit <id>` when working inside an open record, otherwise report it and continue to the record branch. Never block.

  Invoke with the proposal's `## Context`, `## Proposed Solution`, and `## References` sections plus this fixed instruction:
  > "You are a read-only falsification gate. Verify every cited path and symbol against the current code. For a cited compiled/ or raw/ doc missing at its original path, search for the same basename under that directory's .archive/ and, on a match, treat the citation as present and verify against the archived copy; a doc absent from both locations is a real stale-paths. `## References` also carries non-code citations (session reports `T-...`, `PROP-NNN`, memory names, URLs, or `n/a; <reason>`); read those as background context only; never REJECT because one of them is not a file. Return line 1 as exactly: `REJECT: <already-done | partially-done | stale-paths | nonexistent-symbols | too-vague>; <one-line evidence>` or `PROCEED` (+ complete file list to modify). If REJECT, give file:line evidence. Do not produce a build plan for a rejected proposal. Do not write any files."

  Append the returned line-1 verdict to the proposal's `## Operator Decision` section as provenance, then branch:
  - `PROCEED` → continue to the record branch below (step (a)). Use the agent's complete file list over any files mentioned in the proposal body.
  - `REJECT` (stop before opening a task record):
    - **Interactive mode** → surface to the operator: *"Falsification gate: [verdict] — [evidence]. Proceed anyway? Y to override / N to re-scope the proposal first."* Y → continue to the record branch below (step (a)). N → stop; status stays `accepted`. Operator re-scopes and re-runs `/proposal-act accept PROP-NNN`.
    - **Autonomous mode** → do not implement; notify via channel: *"PROP-NNN: falsification check — [evidence]. Reply 'override PROP-NNN' to implement anyway."*
a. Open a resident-owned task with `task-open` (Commands) with arguments `--title "Implement PROP-NNN: <title>" --requester <requester> --done "<proposal verification>" --dedupe-key "proposal:PROP-NNN"`. Use the current operator or channel requester identity and retain the returned record id for notes and results. Existing records remain intact.
b. If another runnable record precedes it, leave this record queued and report its handle. Continue immediately only within the operator's instruction to implement now; do not silently replace another commitment.
e. Implement the proposal. Hermit-only native settings go in operator-owned `.hermit/claude-settings.json`; generated launch settings remain config-derived. Hooks and project-wide permissions go in the hatch-resolved settings file — read `target` from `.hermit/state/hatch-options.json` (`local` → `.claude/settings.local.json`, `committed` → `.claude/settings.json`); when it is absent, ask `.hermit/bin/hermitd-run domain-hatch preflight hermitd` for `target`, or `target_default` when that is null, and map it the same way rather than re-deriving it. Write those entries there with `Edit`/`Write`, never a shell redirect, or the seeded ask never fires. That native ask is the operator's approval and relays to chat, so the bundled `update-config` skill is not needed for it; a hardened install has the same globs as denies, so report the block instead of routing around it. If the body contains `## Skill Improvement`, resolve the component name to `.claude/skills/<name>/SKILL.md` and author in-main (continues to e.5), branching on whether that file exists. **It exists:** read it before writing, compare each corrected behavior in the body against its current content, and author only behaviors not already present. If every listed behavior is already present, skip e.5 (nothing was written, so there is no diff to clean) but still run e.6 — a defined verification step is the only check on the already-present judgement, and a failure there means the behaviors are not actually present, so do not resolve — then run `/proposal-act resolve PROP-NNN --no-artifacts` and tell the operator or channel that the skill was already fixed, writing nothing. **It does not exist** (the gate let it through): never write into the plugin cache and never resurrect a deleted skill — author the improvement as an operator-space override at that path and require the operator's explicit confirmation on the authored file before installing it, by presenting the complete authored SKILL.md and requiring an explicit yes/no. That confirmation is what authorizes creating a file at a name the operator may have deliberately deleted — declined, or unanswered, means nothing is written. An override is a standalone skill that sits alongside the plugin one rather than merging into it, so author a complete SKILL.md (frontmatter plus the whole behavior it has to carry), not just the corrected fragment. Parse the `source_artifact:` line from the `## Skill Improvement` body; if it is present and the path is readable (search `compiled/` then `compiled/.archive/`), read the brief and use its content as input context for the revision — this anchors the improvement to the skill's original spec. Missing or unreadable anchor: proceed without it (no REJECT — an improve proposal is still actionable without the brief, unlike `## Skill Draft` which hard-rejects stale paths). If the body contains both `## Config` and `## Skill Draft`, follow the routine-bound install flow below (in-main; continues to e.5). A standalone `## Skill Draft` is obsolete: install nothing and use close-time learning instead. Otherwise, when `## Operator Decision` carries a `Handed to helper <n>` line, follow [reuse-spawned-helper.md](reuse-spawned-helper.md) first: the helper already holds the proposal's context, so the tail goes to it, lands as a pull request from its worktree, and Dispatch is the fallback. With no such line, dispatch the full implementation tail to the native `general-purpose` agent:

   **Dispatch (falsification gate returned PROCEED, no in-main skill handler):**
   Invoke `general-purpose` via the Agent tool with this prompt (fill in the bracketed value and copy the already absolute `proposal-quality-gate` (Commands) entry into the prompt with the arguments below). The subagent inherits `CLAUDE.md`/`CLAUDE.local.md`, can invoke skills, and can spawn nested subagents — so it runs the whole tail (implement → quality gate → verification) in its own isolated context and returns one report.

   > Implement the accepted proposal at `<absolute path to PROP-NNN-*.md>`, then run its quality gate and verification. Work entirely in this context; your final message is the only thing returned to the caller.
   >
   > 1. Read the proposal file. The `## Operator Decision` section contains a `PROCEED` line from the falsification gate with the authoritative file list — use that list as your scope (over any files mentioned in the proposal body).
   > 2. Do the edits and any test/fix loops yourself. You may spawn a nested Explore subagent if the proposal warrants a search. Hermit-only native settings go in operator-owned `.hermit/claude-settings.json`; generated launch settings remain config-derived. Hooks and project-wide permissions go in the hatch-resolved settings file — read `target` from `.hermit/state/hatch-options.json` (`local` → `.claude/settings.local.json`, `committed` → `.claude/settings.json`); when it is absent, ask `.hermit/bin/hermitd-run domain-hatch preflight hermitd` for `target`, or `target_default` when that is null, and map it the same way rather than re-deriving it. Write those entries there with `Edit`/`Write`, never a shell redirect, or the seeded ask never fires. That native ask is the operator's approval and relays to chat, so the bundled `update-config` skill is not needed for it; a hardened install has the same globs as denies, so report the block instead of routing around it.
   > 3. **Quality gate.** Ask the gate; do not judge the tier or the files yourself:
   >    [Copy the absolute command from `proposal-quality-gate` (Commands) here, with arguments `<absolute path to the PROP file> --files-json '<JSON array of the files you touched, repo-root-relative>'`.]
   >    One JSON object back with `status` and `focus_files`. `skip` → no cleanup. `run` → invoke `/simplify` with `focus_files` as the target, and briefly summarize the cleanup result. Best-effort: if the gate or `/simplify` errors, note it and continue — never block on this step.
   > 4. **Verification.** Read the proposal's `## Verification` section. If it has real steps (more than the HTML-comment placeholder), perform them. If a step fails, attempt **one** fix and re-verify; if it still fails, set `Verification: failed` with the output and stop (do not loop further). If the section is empty or placeholder-only, set `Verification: none defined`.
   > 5. You cannot prompt the operator — if you hit an ambiguous spec or an undecidable/destructive choice at any step, **stop and return an escalation block** rather than guessing.
   >
   > Before filling in `Status`, `Tests run` and `Verification`, audit each claim against a tool result from this run; report only what you can point to, and say plainly what is unverified.
   >
   > Return exactly this structure as your final message (nothing else):
   > ```
   > Status: implemented | escalated | blocked: <reason>
   > Touched files: <relative paths, space-separated | none>
   > Tests run: <commands + pass/fail summary | none>
   > Quality gate: <tier> — simplify <cleanup outcome> | skipped: <reason> | n/a
   > Verification: passed | failed: <output> | none defined
   > Deferred for operator: <none | what was ambiguous and the safe no-op you took>
   > ```

   **After the subagent returns** (the dispatched path ran its own quality gate + verification, so it skips main's e.5/e.6 and is handled here):
   - `Status: implemented` **and** `Verification:` is `passed` or `none defined` → run `/proposal-act resolve PROP-NNN --no-artifacts`, then notify the operator (interactive) or channel (autonomous), building the message from the `Quality gate` field: if cleanup ran, append its brief outcome; if it is `skipped:` or `n/a`, report "PROP-NNN implemented and resolved."
   - `Verification: failed: <output>` → do **not** resolve. Surface the failure output to the operator (interactive) or channel (autonomous). Proposal status stays `accepted`.
   - `Status: escalated` or `Status: blocked: <reason>` → do **not** resolve. Surface the `Deferred for operator` block to the operator (interactive) or channel (autonomous). Proposal status stays `accepted`.

**Routine-bound install flow (when body contains `## Config` and `## Skill Draft`):**
1. Parse `name`, `source_artifact`, `install_target`, and `triggers` from the `## Skill Draft` block.
2. **Collision guard:** if `install_target` (`.claude/skills/<name>/SKILL.md`) already exists, do **not** overwrite. Ask the operator: "Skill `<name>` already exists at `<install_target>`. Overwrite / Rename / Cancel?" Default = **Cancel**.
3. Read `source_artifact` (the procedure file under `.hermit/helper-reports/`, or a legacy brief in `compiled/` or the same basename under `compiled/.archive/` when it has rotated) and author the SKILL.md: frontmatter (`name`, a `description` carrying the trigger phrases from `triggers`) plus a body distilled from the brief's procedure.
4. The routine-bound branch already has operator approval of the routine intent; keep the collision guard, quality gate and verification, then install.
5. Create `.claude/skills/<name>/` and write the authored SKILL.md there. The `source_artifact` file stays as the permanent audit trail — do not move or delete it.
6. **Do not auto-stage or commit** the new skill file. Notify the operator: "Skill `<name>` installed at `<install_target>`. Commit it if you want it tracked in version control."

**`## Agent Draft` install branch (when body contains `## Agent Draft`):**
1. Parse `name`, `source_artifact`, `install_target`, `model`, and `tools` from the `## Agent Draft` block.
2. **Collision guard:** if `.claude/agents/<name>.md` already exists, do **not** overwrite. Ask the operator: "Agent `<name>` already exists at `<install_target>`. Overwrite / Rename / Cancel?" Default = **Cancel**.
3. Read `source_artifact` (the procedure file or legacy brief) and author the agent file: frontmatter (`name`, `description`, `model`, `tools`) plus a body distilled from the brief's worker sub-step. Same privacy handling as a new skill (`component-privacy` covers `.claude/agents/<name>.md` on the managed resident). It rides the resident launch overlay with `pause-gate`, `ask-gate`, and `permission-denied-notify`, rather than the plugin manifest; the overlay is read at launch only.
4. Outside step 3a's routine-bound branch, present the full authored agent file for confirmation and require the same explicit yes/no — an installed agent is dispatchable from every future session, so the operator approves the artifact, not just the intent. Declined: write nothing.
5. Write `.claude/agents/<name>.md`. The `source_artifact` file stays as the permanent audit trail — do not move or delete it.
6. **Do not auto-stage or commit** the new agent file.

**Verification for routine-bound drafts (e.6 note):** the `## Verification` section of a routine-bound proposal should instruct reading the installed file's frontmatter (`name`/`description` parse) rather than checking the live available-skills list — a skill written in this turn is unknown to the `Skill` tool and absent from the live list until the next user turn, so the live list is unreliable in the turn that installed it. A missing or malformed installed file blocks resolution per the normal e.6 contract.
e.5. **Quality gate.** Applies to **in-main** implementations only (the `## Skill Improvement` and `## Skill Draft` in-main authoring branches). Dispatched implementations ran the same gate inside the subagent (step (e)) and are resolved there.

    Build a touched-files list from the writes made during the in-main implementation, written repo-root-relative (the frame `git diff --name-only` uses). If you can't reliably enumerate it (multi-turn work), omit `--files-json` and the gate falls back to the working-tree diff.

    Run `proposal-quality-gate` (Commands) with arguments `<path to the PROP file> [--files-json '["path/a","path/b"]']`.

    One JSON object back: `{"tier","status","reason","detail","focus_files"}`. The script owns tier resolution, the session-bookkeeping filter, and the run/skip call — the same code the dispatched path runs, so the two cannot disagree. Act on `status`:

    - **`skip`** → no cleanup. Proceed to (f). Notification: "PROP-NNN implemented and resolved." (add `Skipped cleanup: <detail>` when `reason` is not `budget_tier`).
    - **`run`** → invoke `/simplify` with `focus_files` as the target:
      ```
      /simplify path/a path/b
      ```
      Wait for completion and briefly summarize the cleanup result in the resolution notification.

    **The quality gate is cleanup, not correctness** — `/simplify` does not check that the proposal works. Correctness is the `## Verification` gate in step (e.6); proposals with no defined verification still resolve, but the skip is recorded.

    Best-effort throughout: if the gate or `/simplify` errors, record a one-line warning with `task.ts note .hermit <id>` when working inside an open record, otherwise report it and fall back to skip.
e.6. **Verification gate** (in-main implementations only — dispatched implementations verify inside the subagent). Read the proposal's `## Verification` section.
    - If it contains real steps (more than the HTML-comment placeholder), perform them now — after the quality gate has applied any `/simplify` edits — before resolving. If a defined step fails, **do not resolve**: report the failure to the operator (or channel in autonomous mode) and stop.
    - If the section is empty, missing, or contains only its placeholder comment, append `Verification: none defined for PROP-NNN: skipped.` with `task.ts note .hermit <id>` and proceed. The omission is recorded, not blocked.

f. **(in-main path)** When verifiably done: run `/proposal-act resolve PROP-NNN --no-artifacts`, then notify the operator (or channel in autonomous mode) with the tier-appropriate message from (e.5). (Dispatched implementations resolve + notify in the step (e) post-return handling.)

## Queue a task

Assemble a record note (Task/Context/Suggested Plan derived from the proposal). The `(always, first step)` bullet below is step `1.` of the Suggested Plan, ahead of the steps derived from the proposal (it gates them, so it is worthless after them) — the derived steps are numbered from `2.`. The remaining bullets append to the end of the Suggested Plan, in order, numbered sequentially after the derived steps (quality-gate bullet is last so `/simplify` reviews any authored skill output):
  - **(always, first step)** `Read the proposal file at .hermit/proposals/PROP-NNN-*.md and re-verify its ## References and ## Proposed Solution against the current tree with bounded reads of the cited file:line ranges, before any edit; delegate only when the citations span more than a handful of files. If the work is already done, run /hermitd:proposal-act resolve PROP-NNN and implement nothing. For a cited compiled/ or raw/ doc missing at its original path, search for the same basename under that directory's .archive/ and, on a match, treat the citation as present and verify against the archived copy; a doc absent from both locations is a real stale-paths. If the cited paths or symbols no longer exist, report the mismatch to the operator or channel and implement nothing. Either way no implementation was performed: report the finding on the record and use its ordinary evidence or confirmation close path.`
  - **(if the proposal contains `## Skill Improvement`)** `Resolve the component name to .claude/skills/<name>/SKILL.md. If it exists, read it before writing and author only the behaviors from the ## Skill Improvement body that are not already present; if all of them are already present, change nothing and say so. If it does not exist, never write into the plugin cache, and create a file at that name only after the operator explicitly confirms the authored SKILL.md, which must be complete rather than the corrected fragment alone. Use the source_artifact brief only when present, and validate the result.`
    The guards travel in the bullet because the queued-record workflow picks up the task as ordinary work, so step (e) never runs again.
  - **(if the proposal contains both `## Config` and `## Skill Draft`)** `Follow the routine-bound install flow, including its collision guard, quality gate and verification. A standalone Skill Draft installs nothing; use close-time learning.`
  - **(if `quality_gate.tier` in `.hermit/config.json` is not `"budget"` — i.e. `"balanced"` or `"quality"`)** Copy `proposal-quality-gate` (Commands) into the note as an absolute command with `<this PROP file>` as its argument, followed by: `On "status":"run", run /simplify with its focus_files as the target, then commit.`
    The bullet defers the call rather than making it here: at queue time the implementation hasn't happened, so there is no diff to classify. The future task turn runs the same verb the other two paths run, with no `--files-json` — the working-tree diff is the evidence by then. Copy the Commands entry verbatim with its absolute path: the future task turn has no Commands block.

Open the record and then append the prepared note through `task.ts`; never write `tasks/*.md` directly:
Run `task-open` (Commands) with arguments `--owner resident --requester <requester> --title "Implement PROP-NNN: <title>" --done "<proposal verification>" --dedupe-key "proposal:PROP-NNN"`.
Run `task-note` (Commands) with arguments `<returned-id>` and the following stdin payload:
```text
## Task
[One-line task derived from the proposal's Proposed Solution]

## Context
[Summary of the pattern/problem and proposal references]

## Suggested Plan
1. [the (always, first step) re-verify bullet from above]
2. [Step derived from Proposed Solution]
3. [Step derived from Proposed Solution]
4. Verify the fix resolves the pattern
[any remaining appended bullets from above, numbered from 5.]
```
Confirm the returned handle and title. Earlier runnable records keep their order; the close/cancel digest and heartbeat handle pickup. On a command failure, report it and leave the proposal accepted without claiming a queued record was created. If open returned an existing record, reuse it without appending a duplicate plan.

## Channel re-entry (`--answer`)

When invoked as `accept PROP-NNN --answer "<label>"` (channel-responder resolving the micro-proposal entry queued by step 4's channel branch, either later in the same turn or in a fresh session): steps 1-3a were already skipped per `SKILL.md` § Accept Flow. A re-entry refreshes artifacts unless its `on_resolve` carries `--no-artifacts` (step 4 adds it when the original accept had the flag). Match `<label>` case-insensitively by prefix against the three step-4 options and jump straight into the matching branch:

- `implement now` → **"Start implementing now"** (falsification gate onward; the autonomous-mode channel notifies specified in that branch apply as usual).
- `queued task` → **"Queue a task"**.
- `manual` → **"I'll handle it manually"**.
