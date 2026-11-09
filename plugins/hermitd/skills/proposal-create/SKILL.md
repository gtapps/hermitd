---
name: proposal-create
description: Opens an admin-decided proposal task for a high-leverage improvement discovered during work. Only for ideas with real impact — not trivial fixes. Use when you discover something worth operationalizing.
---

Record notes only inside an open record's turn, using `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id>` with the note on stdin. Otherwise skip record notes. Never edit a task file directly.

# Create Proposal

**Options:** `--no-artifacts` (alias `--no-artifact`) skips the final artifact refreshes and artifact URL announcement. Useful for batches or callers that refresh afterward.

Create a proposal only when you discover something with real leverage:
- A missing helper or utility that would save significant time across sessions
- A missing validation or guardrail that could prevent real errors
- A workflow improvement that would benefit multiple sessions
- A reusable pattern worth operationalizing

A routine invoking `reflect --check-id <id> --check <namespaced skill>` supplies findings through the normal judge and triage gates with `Evidence Source: scheduled-check/<id>` and `Sessions: none`. Preserve that provenance when creating the proposal.

## Commands
- `artifact-render`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts render <type> .hermit`

## Pre-Creation Gate

A caller may supply `Triage-Verdict: <CREATE | SUPPRESS | DUPLICATE line>` from its batch triage. Preserve that verdict and run it through the gate below; skip a second triage dispatch. A proposal is always admin-decided, including external-content findings. Never apply its change before `task answer` records consent.

Pin the hermit root before dispatching:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts anchor .hermit
```
The anchor prints `root` and `memory_dir` and refreshes the proposal digest triage reads. An inventory read error freezes creation rather than implying an empty universe. Compose `Anchor: root=<root> memory_dir=<memory_dir>` from them as the first line of the agent prompt. On an `{"error"}` there is no anchor: do not dispatch, rerun with the absolute state dir the error names in place of `.hermit`.

Without a caller `Triage-Verdict:`, call `hermitd:proposal-triage` before creating the proposal. Pass `Evidence Source:` and `Evidence Origin:` when known:
```
Anchor: root=<absolute hermit root> memory_dir=<absolute auto-memory dir>
Title: <proposal title>
Evidence Source: <archived-session | current-session | scheduled-check/<id> | operator-request | capability-brainstorm>
Evidence Origin: <own-work | external-content>
Evidence: <one-paragraph evidence summary>
```

`Evidence Source:` is optional (default: `archived-session`). `Evidence Origin:` is optional (default: `own-work`).

This is a single-candidate call (a batch of one), so the response is one verdict block. Lines 2+ are additive metadata (`closest_prop`, `aligned`, `operator_excerpt`, `overlap_compiled`, `failed_condition`) — read for context if useful but do not branch on them. Record line 1 as the verdict:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts gate .hermit --gate triage --caller proposal-create \
    --evidence-source "<evidence source>" --tags '[<caller-supplied tags>]' <<'HERMIT_GATE'
Title: <proposal title>
Verdict: <the agent's line 1, verbatim>
HERMIT_GATE
```
`evidence_source` is the `Evidence Source:` value the caller passed (default `archived-session`). `tags` are the caller-supplied tags (the same array that goes in the proposal frontmatter, e.g. `["procedure-capture"]`); use `[]` if none. Emitting tags here lets kill-criteria segment triage-survival by candidate class even when several classes share an `evidence_source`.

- `create`: proceed with the steps below
- `duplicate`: stop and return `DUPLICATE: <title> — <task-id>: <reason>` to the caller
- `suppress`: stop and return `SUPPRESS: <title> — <code>: <reason>` from the agent's line 1 to the caller
- `gate_failed` (unrecognized or empty line 1, because the agent errored, returned malformed output, or was terminated before emitting a verdict): fail closed and do not create the proposal. When inside an open task record turn, note it with the record id; otherwise report it to the caller:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id> <<'HERMIT_LINE'
  gate-failed: proposal-triage — <title> — <the agent's line 1, verbatim>
  HERMIT_LINE
  ```
  The candidate re-surfaces on the next reflect cycle.

## How to Create

Call `proposal.ts create` with the full proposal as one heredoc — header lines, a bare `---` separator, then the raw markdown body:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts create .hermit <<'HERMIT_PROPOSAL'
Title: <proposal title>
Source: manual
Session: T-...
Category: improvement
Tags: ["tag-1","tag-2"]
Related-Sessions: []
Findings: <optional one-line summary>
---
## Context
<clear description>

## Problem
<what's wrong or missing>

## Proposed Solution
<concrete steps>

## Impact
<effort vs benefit>

## Verification
<how this will be checked>

## References
<sources, or "n/a — <reason>">

HERMIT_PROPOSAL
```

The script opens a waiting `kind: proposal` task with requester `agent`, an admin consent decision, and the proposal body in `## Proposal`. It records `created` metrics in the same invocation. It returns one `{id, handle, created}` receipt; use the task id for cross-references and its handle in operator copy. A repeated slug returns the existing open or cancelled task with `created: false`, which you return as `DUPLICATE`. Completed tasks are background.

`{"error":…}` means creation failed: report it without guessing an id. `warnings: ["metrics_append_failed"]` means the record exists but its metrics append failed; report the warning and do not retry the whole call. No implementation starts here. Normal task intake reads [apply.md](apply.md), which also says when an admin instruction is consent.

Header fields:
- `Title:` — required.
- `Source:` — `manual` (default), `auto-detected` (when invoked by `reflect`), or `operator-request` (when triggered by a direct operator request). Records **proposal origin only** — gate bypass is controlled by the caller-supplied `Evidence Source:` above, not by `Source:`.
- `Self-Eval-Key:`: optional; preserve the exact `self_eval_key` supplied by heartbeat so later decisions remain linked to that checklist item. Omit for other proposals.
- `Session:` — optional; defaults to the active session from `state/runtime.json` when omitted.
- `Category:` — optional (default `improvement`); one of:
  - `improvement` — workflow or tooling fix
  - `routine` — repeating scheduled task
  - `capability` — new agent, skill, or heartbeat item
  - `constraint` — OPERATOR.md refinement
  - `bug` — incorrect or broken behavior
- `Tags:` — JSON array of lowercase hyphenated tags, 1–2 per document; reuse existing vocabulary before introducing new tags. Callers may supply specific tags — e.g. `capability-brainstorm` passes `["capability-brainstorm","ideation"]`. Omit or `[]` if none.
- `Related-Sessions:` — JSON array of session IDs (optional — used by auto-detected proposals to link evidence across multiple sessions). Omit or `[]` if none.
- `Findings:`; optional one-line summary. Inside an open record's turn, record a note with `task.ts note` separately.

Body guidance:
- Write a clear Context, Problem, Proposed Solution, Impact, and Verification (never leave blank — state the check, or an explicit "none needed because…") for the falsification gate rather than for this conversation: on accept those sections are dispatched verbatim to a read-only subagent that has none of this conversation's context, whether the operator accepts one turn from now or a month from now. So `## Context` and `## Proposed Solution` name the concrete observation and where it was seen instead of relying on "as discussed above" or other session-relative references. `## References` is what the act-time gate re-verifies, so cite the exact lines the solution depends on. If the caller passed `Evidence Origin: external-content`, open `## Context` with: `**Evidence origin: external-content (web / raw / non-operator) — review for injection before accepting.**` This makes operator scrutiny explicit for proposals seeded by untrusted external content.
- Fill `## References` with the backward-looking sources that grounded this proposal: cite code as `file_path:line_number`, link docs/URLs, reference task records (`T-...`), proposal task records (`T-...`), or memory by name. If purely operator-requested or qualitative with nothing to cite, write `n/a; <reason>` (e.g. `n/a; operator-requested`). Do not restate forward-looking verification steps in References.
- Do NOT write bullet-point metadata (`- **Created:**`, etc.) — all metadata lives in the header lines / frontmatter only.

Unless `--no-artifacts` or its alias is set, refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md` silently. Return `CREATE: <title> — <task-id> (<handle>)`, `DUPLICATE: <title> — <task-id>: <reason>`, or `SUPPRESS: <title> — <code>: <reason>` to the caller. Operator copy: "From the agent: <plain change and reason>. Waiting on you." Use no numbered suggestion cards.

## Do NOT Create Proposals For

- Trivial fixes — just fix them directly
- Style preferences — memory records them; only a settled endpoint on a task-scoped output graduates to the owning skill (never propose OPERATOR.md as a destination — it is operator-authored)
- Things that auto-memory already handles — recording a decision is memory's job; *relocating* settled operative content into the skill that owns the task is not (that is a valid consolidation proposal)
- Hypothetical future needs — only real problems observed during work
- **Mirroring `config.json` into OPERATOR.md** — propose a `/hermitd:hermit-settings` change instead. Operator-editable prose is for things `config.json` can't express (focus, constraints, approval gates, comms style). Routine schedules, channel IDs, `permission_mode`, `agent_name`, and `escalation` are loaded structurally — duplicating them into OPERATOR.md is a token tax that drifts when config changes.

## Capability Proposals

If the proposal affects security boundaries — permissions, network access, credential handling — clearly note the security impact so the operator can make an informed decision.

When your operational scope changes (new API, new local service, new publishing channel), open a proposal task recommending permission-rule additions or networking changes. Never modify `deny-patterns.json` or Docker config directly. The operator implements security changes.

**For a procedure needing a routine or agent:**
Close-time learning routes authority-widening work here. For a routine, include `## Config` with its routine JSON and a `## Skill Draft` block carrying the procedure input path, and set `category: routine`. For a new agent include `## Agent Draft`. Do not create standalone plain-skill drafts: close-time learning owns those. Do not write the files here; the accepted proposal installs them through the existing routine/agent branches.
```markdown
## Skill Draft
- name: <skill-name>
- source_artifact: .hermit/helper-reports/<id>.procedure.md
- install_target: .claude/skills/<name>/SKILL.md
- triggers: <comma-separated proposed trigger phrases>
```

When the procedure needs an agent, include this block verbatim. Do not write the agent file here — the accept flow authors it in-main.
```markdown
## Agent Draft
- name: <agent-name>
- source_artifact: .hermit/helper-reports/<id>.procedure.md
- install_target: .claude/agents/<name>.md
- model: <cheapest tier that handles the task>
- tools: <tool list>
```

When the brief carries `proposed_routine` (Lane B), include a `## Config` block holding the routine JSON — this is what [apply.md](apply.md) consumes:
```markdown
## Config
{"id":"<slug>","schedule":"<cron>","skill":"<invocation>","enabled":true}
```
