# Apply an approved proposal task

Inputs: the existing task id, its `## Proposal`, recorded consent, current project state and any answered input decision. The resident and `hermitd:task-worker` use this same procedure. Implement nothing while a consent decision is pending. A worker performs the reads itself and returns its report to the resident, which owns record transitions.

## When an instruction is consent

An admin's instruction to implement or ship a pending proposal, or approval of a plan for it, is its consent. Record it in that turn with `task answer <id> --chat <key> --user <sender-id> --reply yes`, or `--local` from the terminal, before applying. A request to investigate, evaluate, brainstorm or plan it is not consent: stay read-only and end the report asking whether to build it. `not_decider` means the admin has to say it. `consent_required` on a check, close or block means no consent is recorded: record it when the admin already committed, otherwise ask the admin.

## Re-check before editing

Read the proposal's Context, Proposed Solution, References and Verification, then bounded ranges around the cited paths and symbols. Missing raw/ or compiled/ citations may have the same basename under that directory's `.archive/`; verify the archived copy. URLs, memory names, task ids and `n/a` are background, not file paths. Rewording is already done only when the requested wording exists.

Return `PROCEED` and the verified scope, or `REJECT: <already-done | partially-done | stale-paths | nonexistent-symbols | too-vague>; <file:line evidence>`. On REJECT implement nothing, record evidence in the task and open a new admin consent decision; do not close by an unsupported assertion. The worker returns `WORKER <task-id> needs-input <report-id>`.

A missing source artifact for a draft is `stale-paths`; search compiled archives before rejecting. For Skill Improvement, distinguish an absent operator override from a still-installed namespaced plugin skill. Never write a plugin cache or resurrect an absent skill silently.

## Apply within the consented scope

Follow a named sibling skill in the proposal body, such as `/hermitd-homeassistant:ha-apply-update`, after confirming it is installed. Resume an answered `input` decision through its `decision.resume` procedure and recorded answer. Unsettled choices return an input decision with options, authority and resume procedure. Never guess an answer or use an interactive question from a worker.

Configuration changes use `settings-edit.ts` and its native gate. Resolve array targets such as `monitors[]` by stable id before editing; do not trust a stored index. Routine JSON uses the idempotent `proposal.ts routine` upsert. Never bypass a native permission prompt or the settings gate, widen permissions, or edit generated launch settings to make an apply succeed.

### Routine-bound Skill Draft

Require both `## Config` and `## Skill Draft`. Read `name`, `source_artifact`, `install_target` and `triggers`; author a complete skill from that procedure. A standalone Skill Draft uses close-time learning instead and installs nothing here. Keep the source artifact as the audit trail.

If `.claude/skills/<name>/SKILL.md` exists, overwrite nothing: return an input decision with Overwrite / Rename / Cancel, default Cancel. Cancel installs nothing and performs no routine upsert. After an authorized choice, write only the chosen operator-space path, run quality and verification, then upsert the routine. Report its first run and how to disable it. Never stage or commit automatically.

### Agent Draft

Read `name`, `source_artifact`, `install_target`, `model` and `tools`. Author the complete agent file. Existing `.claude/agents/<name>.md` uses the same collision guard. Outside a routine-bound draft, present the authored file for an admin result decision before installation; a declined or unanswered decision writes nothing. Preserve component privacy and the source artifact.

### Skill Improvement

Read the current `.claude/skills/<name>/SKILL.md` and change only the requested behavior or wording. If the skill is plugin-shipped, author a complete operator-space override, never a fragment or cache edit. Present the authored override through an admin result decision before installing it. An absent, uninstalled target is a rejected stale path. Preserve operator edits and run verification even when the requested change already exists.

## Quality, verification and closure

Run `proposal.ts quality-gate .hermit .hermit/tasks/<task-id>.md`, passing `--files-json` with the known touched files when reliable. A `run` verdict invokes `/simplify` over `focus_files`; record cleanup errors and continue to correctness verification. A worker unable to invoke that skill returns the need to the resident. Cleanup is not verification.

Run every real step in `## Verification` after cleanup. A failed check leaves the task open with evidence. Missing verification is recorded explicitly; it never proves success.

Where an executable observation can establish the whole definition of done, set `task note --check '<command>'` and run `task-check.ts <id>`. The first check on an approved proposal keeps consent; replacing or clearing an existing check or changing `--done` starts new consent. A passing stored check closes in one touch when no result decision is pending. A check observes only; it never writes, sends, deletes or deploys.

Authored content requires human acceptance: post the result with `task block <id> --result-stdin`, opening a result decision with the record's authority. The admin answers through `task answer` for the current generation and result revision. Never name `agent` as the waiter. Only the resident writes transitions from a worker report; a worker ends with `WORKER <task-id> done <report-id>` or `WORKER <task-id> needs-input <report-id>`.
