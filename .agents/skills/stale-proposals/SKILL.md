---
name: stale-proposals
description: "Audit this repository's local proposal queue for stale entries: proposals still open as a proposal task (awaiting consent or approved) even though the work already shipped, plus old proposals whose subject has become inert. Reconcile proposals against plugin changelogs and first-parent Git history, automatically resolve only unambiguous shipped matches, and ask before any weak-match, aged, or dismissal decision. Use when the user asks to check, reconcile, clean up, prune, or find stale proposals; asks whether proposal work already shipped; is confused why an old PROP remains open; or wants to stop heartbeat from repeatedly surfacing obsolete proposal-pending items. Supports a report-only no-apply mode."
---

# Stale Proposals

Reconcile the open proposal queue against what actually shipped.

Trust shipping evidence more than age. An unambiguous shipped match can close automatically because the evidence is inspectable and the decision is reversible. Age or silence alone requires the user's judgment.

## Invocation

- `$stale-proposals` — audit the queue, auto-resolve strong shipped matches, and ask about everything else.
- `$stale-proposals` with `no apply` or `report only` — write nothing and report all verdicts.

## Step 1 — Collect bounded evidence

From the repository root, run:

```bash
bun .agents/skills/stale-proposals/scripts/collect-evidence.ts [--hermit-dir <hermit-dir>]
```

`<hermit-dir>` is the state folder that holds `tasks/`; a proposal is a task record with `kind: proposal` (see `plugins/hermitd/docs/task-records.md`), and migrated ones keep their `PROP-NNN` id as dedupe key `proposal:PROP-NNN`. It defaults to `<repo>/.hermit`, which is only right in the resident's own checkout. In a checkout whose `.hermit` is a projection (a core checkout under a resident workspace, a worktree), pass the resident's absolute `.hermit` path. Use that same path in Steps 3 and 4.

The script prints one of:

- `OK|<bundle-path>|<open>|<bullets>|<commits>|<cutoff>|<tasks>`
- `NONE|no-open-proposals`

For `NONE|no-open-proposals`, report `Queue is clean — no open proposals.` and stop. A non-zero exit means a wrong path or an unmigrated state folder: report the stderr message and stop, never treat it as a clean queue. Unmigrated means `proposals/*.md` still exist; the user runs `proposal.ts migrate <hermit-dir>` once, this skill does not. The bundle also lists closed task records that name a PROP id.

Do not read the evidence bundle in the main session. It can be tens of thousands of tokens and exists specifically to keep that corpus isolated.

## Step 2 — Match in one isolated worker

Spawn one worker agent with a fresh context (`fork_turns: "none"` when supported). Give it only the repository root, evidence-bundle path, and the contract below. Wait for its result before continuing. If agent spawning is unavailable, stop and explain that this audit requires one isolated worker; do not load the bundle into the main session as a fallback.

Use this contract verbatim, substituting the real path:

> Read the evidence bundle at `<path>`. It lists open proposals (each headed by its `PROP-NNN` or `T-` id), then CHANGELOG bullets, closed task records, then first-parent commits.
>
> For each open proposal, decide whether the thing it asked for has already shipped. Emit exactly one line per proposal, and nothing else:
>
> - `SHIPPED-STRONG|<ID>|<plugin> <version> / <commit or "changelog">|<one sentence: what the evidence says, in the changelog's own words>`
> - `SHIPPED-WEAK|<ID>|<evidence ref>|<one sentence: what matches and what you could not confirm>`
> - `AGED|<ID>|<age in days>|<one sentence: why nothing has moved on this>`
> - `OPEN|<ID>`
>
> **STRONG requires all three:** the evidence names the same component the proposal targets; it describes the same behavior change the proposal asked for; and no distinct part of the proposal's ask is left unaddressed. A proposal asking for three things where the changelog delivers two is **WEAK**, not strong — partial delivery is the single most likely way this audit closes live work by mistake, so when you notice yourself arguing for why a gap "probably doesn't matter," that is WEAK.
>
> Ignore date order at your peril: evidence dated before a proposal was created cannot be that proposal shipping. It is usually the prior art the proposal was written against. Changelog dates have day granularity while proposals carry a timestamp, so same-day changelog or commit evidence cannot be ordered at all — treat it as at most `SHIPPED-WEAK` and say so.
>
> **Closed task records** (the bundle's task section) are stronger evidence. A record whose title or `closed_reason` names the proposal, closed `done`, with a `closed_reason` saying its PR or PRs all merged, counts as `SHIPPED-STRONG` evidence even when it is the only evidence and even on the same day as the proposal: the record was opened and closed after the proposal existed. It must still cover the whole ask; a record for one of several parts is `SHIPPED-WEAK`. A cancelled record, or one that only records a helper report or investigation, is not shipping evidence.
>
> A proposal can ship under a different name than it asked for. Match on substance — the component, the behavior, the problem being closed — not on the proposal's chosen identifier.
>
> Use `AGED` only when there is no shipping evidence at all AND no commit in the history touches the proposal's subject area since it was created — an untouched subject is what "inert" actually means. Age alone is not staleness; a good idea nobody got to yet is `OPEN`.
>
> Be conservative. `OPEN` is the correct answer for most proposals and costs nothing; a wrong `SHIPPED-STRONG` silently closes live work.

Reject malformed lines or missing proposal IDs instead of guessing.

## Step 3 — Apply strong matches

Skip this step in report-only mode.

Only a proposal still awaiting consent (`status: proposed` in the bundle) is auto-resolved: closing an approved one needs a named user identity, so a `SHIPPED-STRONG` on an `accepted` proposal joins the Step 4 list.

The bundle's `task:` line gives the task id. Record the evidence, then decline consent through the local answer path, which is how `task.ts` closes a pending proposal from the terminal (`plugins/hermitd/docs/task-records.md` § Proposals and durable questions):

```bash
bun plugins/hermitd/scripts/task.ts note <hermit-dir> <task-id> --decision <<'HERMIT_NOTE'
Resolved @now: shipped in <plugin> <version>. <evidence sentence>
HERMIT_NOTE

echo "Shipped in <plugin> <version>." | bun plugins/hermitd/scripts/task.ts dismiss <hermit-dir> <task-id> --reason-stdin
```

Replace `@now` with the current date. The note makes the automatic resolution auditable. A shipped proposal closes as cancelled (the record's closed reason reads "Consent declined"), because a pending proposal has no resolved outcome; the Decisions note says why. `dismiss` closes only a proposal still waiting for consent; outside an operator-typed Claude Code terminal turn it may need the harness permission prompt, and bypass mode refuses it there, so a refusal means leave it for Step 4 and say so.

`dismiss` prints `{"id":...,"closed_by":"cancelled",...}` on success. A `{"status":"refused",...}` or `{"error":...}` means nothing was closed: report it, move that proposal to Step 4, and continue. A `note` already written stays as a harmless record.

## Step 4 — Ask about the rest

Present `SHIPPED-WEAK` first, then `AGED`, then any `accepted` `SHIPPED-STRONG`. Ask the user in one concise round whether to resolve, dismiss, or leave each item open. Separate items when one group clearly needs different decisions.

Stop and wait for the response. Do not interpret the original audit request as approval for these mutations.

Apply confirmed choices with `task.ts` against the same `<hermit-dir>` as Step 1. Both resolve and dismiss close the record as cancelled; the Decision note carries the difference:

- **Awaiting consent:** `note --decision` with the user's choice and reason (for resolve, as Step 3), then `dismiss <task-id> --reason-stdin` with the reason on stdin.
- **Accepted:** `cancel <task-id> --actor <source>:<user-id> --chat <chat-key> --user <user-id> --reason-stdin` with the reason on stdin, using the user's own identity from this conversation. A terminal-only session has none: report the task id and leave it open.
- **Leave open:** make no changes.

Treat only family-wide dismissal preferences as durable feedback; proposal-specific reasons are not standing policy.

## Step 5 — Report the delta

Use this compact shape:

```text
Proposal queue: <N> open → <M> open

Resolved automatically (<n>)
  PROP-056 — shipped in hermitd [Unreleased]: <evidence>

Confirmed with you (<n>)
  PROP-006 — dismissed

Still open (<n>)
```

Report what changed and any failed mutations. Do not re-list the whole remaining queue.
