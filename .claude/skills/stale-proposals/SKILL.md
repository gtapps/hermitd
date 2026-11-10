---
name: stale-proposals
description: Audits the local proposal queue for proposals that have gone stale — work that already shipped (visible in a plugin CHANGELOG or merged PR) but is still open as a proposal task (awaiting consent or approved), plus proposals old enough to be inert. Auto-resolves only unambiguous matches and asks before anything else. Use this whenever the operator says "check for stale proposals", "which proposals are stale", "are any proposals already done", "reconcile the proposal queue", "clean up the proposals", "prune proposals", "did we already ship any of these", or notices the heartbeat re-firing the same proposal-pending items every wake. Also trigger proactively when the operator is confused about why an old PROP is still open, or before a release when the queue is about to be reviewed. Monorepo-internal — assumes plugins/*/CHANGELOG.md.
---

# Stale Proposals

An open proposal is a claim that something still needs doing. That claim decays two ways: the work quietly shipped under a different name and nobody flipped the status, or the idea simply stopped mattering. Both leave the queue lying, and the lie is expensive here — the heartbeat re-fires every open proposal on each wake, so a stale entry costs tokens forever and trains the operator to ignore the whole list.

This skill reconciles the queue against what actually shipped. It is deliberately asymmetric about trust: **shipping evidence can close a proposal automatically, age cannot.** Evidence is checkable and a wrong flip is recoverable by reading the changelog; "this feels inert" is a judgement about the operator's intentions, and getting it wrong silently buries live work.

## Usage

`/stale-proposals [--no-apply] [--from PROP-NNN] [--status proposed,accepted]`

- **No arg** — full audit; auto-resolves unambiguous matches, asks about everything else.
- **`--no-apply`** — report only, write nothing. Use when you want to see the verdicts before trusting them.
- **`--from PROP-NNN`** — only proposals numbered NNN and up. Operator phrasings like "just PROP-100+" or "the newer ones" mean this flag.
- **`--status <list>`** — `proposed` (awaiting consent) and/or `accepted` (approved, not closed). "Only the proposed ones" means `--status proposed`. `--from` filters legacy `PROP-NNN` ids only; proposals opened since the task-record change are identified by their `T-` id and are always in scope.

Scope flags go to the collector in Step 1, so the bundle itself is narrowed and the evidence floor moves with it. Never scope by prose in the subagent contract: a hint the subagent may or may not honour is how an in-scope proposal goes unreviewed.

Natural companion to `/release-status` when the queue has drifted, and worth a run before any release where proposals get reviewed.

## Step 1 — Collect the evidence

```bash
bun .claude/skills/stale-proposals/scripts/collect-evidence.ts [--hermit-dir <hermit-dir>] [--from PROP-NNN] [--status <list>]
```

`<hermit-dir>` is the state folder that holds `tasks/`; a proposal is a task record with `kind: proposal` (see `plugins/hermitd/docs/task-records.md`), and migrated ones keep their `PROP-NNN` id as dedupe key `proposal:PROP-NNN`. It defaults to `<repo>/.hermit`, which is only right in the resident's own checkout. In a checkout whose `.hermit` is a projection (a core checkout under a resident workspace, a worktree), pass the resident's absolute `.hermit` path. Use that same path in Steps 3 and 4.

This writes a bundle containing every in-scope open proposal (with an excerpt of its Problem section) alongside every CHANGELOG bullet, closed task record naming a PROP id, and first-parent commit dated after the oldest open proposal — nothing can have shipped before the proposal that asked for it existed, so that date is a sound floor.

Output is `OK|<bundle-path>|<open>|<bullets>|<commits>|<cutoff>|<tasks>`, or `NONE|no-open-proposals` (report "Queue is clean — no open proposals." and stop). A non-zero exit means a wrong path or an unmigrated state folder: report the stderr message and stop, never treat it as a clean queue. Unmigrated means `proposals/*.md` still exist; the operator runs `proposal.ts migrate <hermit-dir>` once, this skill does not.

**Do not read the bundle.** It is on the order of 40k tokens and belongs in a subagent, not in the operator's session. You only need its path.

## Step 2 — Match, in a subagent

Dispatch one `general-purpose` subagent. Its whole job is to turn that bundle into verdicts, so the corpus stays in its context and only the conclusions come back.

Give it the bundle path and this contract verbatim:

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
>
> Emit the lines in the bundle's order, and finish with a final `DONE|<count>` line so a truncated reply is visible as one.

## Step 2b — Check completeness

A subagent enumerating dozens of items can drop one and still look finished — its reply ends in a tidy list and nothing downstream notices. The bundle is the source of truth for what was in scope, so diff against it, never against the subagent's own count.

List the in-scope IDs without reading the bundle (one short line per proposal, so this stays bounded):

```bash
grep -oE '^### (PROP-[0-9]+|T-[0-9]{8}-[0-9]{6}(-[a-z0-9])?)' <bundle-path> | cut -c5-
```

Compare that set against the IDs in the verdict lines. For any ID with no verdict, re-dispatch the Step 2 contract once, scoped to exactly those IDs ("emit a line for each of these IDs and no others"), and merge the result. Anything still missing after the retry is reported in Step 5 under **No verdict** — it is never treated as `OPEN`, because `OPEN` claims the proposal was reviewed and this one was not.

## Step 3 — Apply the strong matches

Skip this entire step under `--no-apply`.

Only a proposal still awaiting consent (`status: proposed` in the bundle) is auto-resolved: closing an approved one needs a named operator identity, so a `SHIPPED-STRONG` on an `accepted` proposal joins the Step 4 list.

The bundle's `task:` line gives the task id. Record the evidence, then decline consent through the local answer path, which is how `task.ts` closes a pending proposal from the terminal (`plugins/hermitd/docs/task-records.md` § Proposals and durable questions):

```bash
bun plugins/hermitd/scripts/task.ts note <hermit-dir> <task-id> --decision <<'HERMIT_NOTE'
Resolved @now: shipped in <plugin> <version>. <evidence sentence>
HERMIT_NOTE

echo "Shipped in <plugin> <version>." | bun plugins/hermitd/scripts/task.ts dismiss <hermit-dir> <task-id> --reason-stdin
```

Replace `@now` with the current date. The note is what makes an automatic flip auditable: the operator can later see which bullet closed the proposal. A shipped proposal closes as cancelled (the record's own closed reason reads "Consent declined"), because a pending proposal has no resolved outcome; the Decisions note says why. `dismiss` closes only a proposal still waiting for consent and runs without a prompt when the operator typed the turn in the terminal; anywhere else it asks for Claude Code's permission, and bypass mode refuses it there, so a refusal means leave it for Step 4 and say so.

`dismiss` prints `{"id":...,"closed_by":"cancelled",...}` on success. A `{"status":"refused",...}` or `{"error":...}` means nothing was closed: report it, move that proposal into the Step 4 list, and continue with the rest. A `note` already written stays as a harmless record.

## Step 4 — Ask about the rest

Present `SHIPPED-WEAK` and `AGED` together in one `AskUserQuestion` round, weak matches first (they carry evidence; aged ones carry only silence), then any `accepted` `SHIPPED-STRONG`. Offer per group: resolve them, dismiss them, or leave them open. Where a group's members clearly want different answers, ask about them separately rather than forcing one verdict onto all.

Apply confirmed answers with `task.ts` (same `<hermit-dir>` as Step 1). Both "resolve" and "dismiss" close the record as cancelled; the Decision note carries the difference:

- **awaiting consent** — `note --decision` with the operator's choice and reason (for resolve, as Step 3), then `dismiss <task-id> --reason-stdin` with the reason on stdin.
- **accepted** — `cancel <task-id> --actor <source>:<user-id> --chat <chat-key> --user <user-id> --reason-stdin` with the reason on stdin, using the operator's own identity from this conversation. A terminal-only session has none: report the task id and leave it open.
- **leave open** — nothing to write.

If a dismissal reason states a durable preference that would apply to a whole *family* of future proposals rather than just this one, save it as feedback memory. A proposal-specific "this doesn't apply here" is not.

## Step 5 — Refresh the artifact pages

Skip if Step 3 resolved nothing and Step 4 changed nothing (queue is unchanged). Otherwise, refresh the dashboard per `plugins/hermitd/docs/artifacts.md`, silently, no URL re-post.

## Step 6 — Report

```
Proposal queue: <N> open → <M> open

Resolved automatically (<n>)
  PROP-056 — shipped in hermitd [Unreleased]: proposal.ts replaces Write/Edit state writes

Confirmed with you (<n>)
  PROP-006 — dismissed

Still open (<n>)

No verdict (<n>) — left untouched, re-run to audit
  PROP-155
```

Omit the **No verdict** block when Step 2b came back complete. Keep it to what changed. The queue's remaining contents are already one `task.ts list` away, and re-listing them here is the same noise this skill exists to remove.
