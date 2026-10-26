---
name: stale-proposals
description: Audits the local proposal queue for proposals that have gone stale — work that already shipped (visible in a plugin CHANGELOG or merged PR) but is still sitting at status `proposed`/`deferred`/`accepted`, plus proposals old enough to be inert. Auto-resolves only unambiguous matches and asks before anything else. Use this whenever the operator says "check for stale proposals", "which proposals are stale", "are any proposals already done", "reconcile the proposal queue", "clean up the proposals", "prune proposals", "did we already ship any of these", or notices the heartbeat re-firing the same proposal-pending items every wake. Also trigger proactively when the operator is confused about why an old PROP is still open, or before a release when the queue is about to be reviewed. Monorepo-internal — assumes plugins/*/CHANGELOG.md.
---

# Stale Proposals

An open proposal is a claim that something still needs doing. That claim decays two ways: the work quietly shipped under a different name and nobody flipped the status, or the idea simply stopped mattering. Both leave the queue lying, and the lie is expensive here — the heartbeat re-fires every open proposal on each wake, so a stale entry costs tokens forever and trains the operator to ignore the whole list.

This skill reconciles the queue against what actually shipped. It is deliberately asymmetric about trust: **shipping evidence can close a proposal automatically, age cannot.** Evidence is checkable and a wrong flip is recoverable by reading the changelog; "this feels inert" is a judgement about the operator's intentions, and getting it wrong silently buries live work.

## Usage

`/stale-proposals [--no-apply] [--from PROP-NNN] [--status proposed,deferred]`

- **No arg** — full audit; auto-resolves unambiguous matches, asks about everything else.
- **`--no-apply`** — report only, write nothing. Use when you want to see the verdicts before trusting them.
- **`--from PROP-NNN`** — only proposals numbered NNN and up. Operator phrasings like "just PROP-100+" or "the newer ones" mean this flag.
- **`--status <list>`** — only the listed open statuses. "Only the proposed ones" means `--status proposed`.

Scope flags go to the collector in Step 1, so the bundle itself is narrowed and the evidence floor moves with it. Never scope by prose in the subagent contract: a hint the subagent may or may not honour is how an in-scope proposal goes unreviewed.

Natural companion to `/release-status` when the queue has drifted, and worth a run before any release where proposals get reviewed.

## Step 1 — Collect the evidence

```bash
bun .claude/skills/stale-proposals/scripts/collect-evidence.ts [--from PROP-NNN] [--status <list>]
```

This writes a bundle containing every in-scope open proposal (with an excerpt of its Problem section) alongside every CHANGELOG bullet and first-parent commit dated after the oldest open proposal — nothing can have shipped before the proposal that asked for it existed, so that date is a sound floor.

Output is `OK|<bundle-path>|<open>|<bullets>|<commits>|<cutoff>`, or `NONE|no-open-proposals` (report "Queue is clean — no open proposals." and stop).

**Do not read the bundle.** It is on the order of 40k tokens and belongs in a subagent, not in the operator's session. You only need its path.

## Step 2 — Match, in a subagent

Dispatch one `general-purpose` subagent. Its whole job is to turn that bundle into verdicts, so the corpus stays in its context and only the conclusions come back.

Give it the bundle path and this contract verbatim:

> Read the evidence bundle at `<path>`. It lists open proposals, then CHANGELOG bullets, then first-parent commits.
>
> For each open proposal, decide whether the thing it asked for has already shipped. Emit exactly one line per proposal, and nothing else:
>
> - `SHIPPED-STRONG|<PROP-ID>|<plugin> <version> / <commit or "changelog">|<one sentence: what the evidence says, in the changelog's own words>`
> - `SHIPPED-WEAK|<PROP-ID>|<evidence ref>|<one sentence: what matches and what you could not confirm>`
> - `AGED|<PROP-ID>|<age in days>|<one sentence: why nothing has moved on this>`
> - `OPEN|<PROP-ID>`
>
> **STRONG requires all three:** the evidence names the same component the proposal targets; it describes the same behavior change the proposal asked for; and no distinct part of the proposal's ask is left unaddressed. A proposal asking for three things where the changelog delivers two is **WEAK**, not strong — partial delivery is the single most likely way this audit closes live work by mistake, so when you notice yourself arguing for why a gap "probably doesn't matter," that is WEAK.
>
> Ignore date order at your peril: evidence dated before a proposal was created cannot be that proposal shipping. It is usually the prior art the proposal was written against. Changelog dates have day granularity while proposals carry a timestamp, so same-day evidence cannot be ordered at all — treat it as at most `SHIPPED-WEAK` and say so.
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
grep -o '^### PROP-[0-9]*' <bundle-path> | cut -c5-
```

Compare that set against the IDs in the verdict lines. For any ID with no verdict, re-dispatch the Step 2 contract once, scoped to exactly those IDs ("emit a line for each of these IDs and no others"), and merge the result. Anything still missing after the retry is reported in Step 5 under **No verdict** — it is never treated as `OPEN`, because `OPEN` claims the proposal was reviewed and this one was not.

## Step 3 — Apply the strong matches

Skip this entire step under `--no-apply`.

For each `SHIPPED-STRONG` verdict, resolve the ID to a filename, then close it the same way `/hermitd:proposal-act` does: the `resolve` verb writes the metrics rows and the patch together, recording the accept first when the proposal was still `proposed`:

```bash
bun plugins/hermitd/scripts/proposal.ts resolve-id .hermit "<PROP-ID>"

bun plugins/hermitd/scripts/proposal.ts resolve .hermit <filename> --stdin <<'HERMIT_PATCH'
Decision: Resolved on @now — shipped in <plugin> <version>. <evidence sentence>
HERMIT_PATCH
```

Writing the evidence into the Decision line is what makes an automatic flip auditable: the operator can later see exactly which bullet closed the proposal and reopen it if the match was wrong.

`resolve-id` prints `{"status":"match","file":...}`; pass that `file` as `<filename>`. Status `ambiguous` or `none` means don't guess: move that proposal into the Step 4 list instead. `{"error":...}` from `proposal.ts` means nothing was patched; report it and continue with the rest.

## Step 4 — Ask about the rest

Present `SHIPPED-WEAK` and `AGED` together in one `AskUserQuestion` round, weak matches first (they carry evidence; aged ones carry only silence). Offer per group: resolve them, dismiss them, defer them, or leave them open. Where a group's members clearly want different answers, ask about them separately rather than forcing one verdict onto all.

Apply confirmed answers with the same `proposal.ts patch` call, following `/hermitd:proposal-act`'s flow for whichever status the operator picked rather than improvising the fields — the flows differ in ways that are easy to get wrong:

- **dismiss** — `--set status=dismissed --set dismissed_date=@now --set resolved_date=@now`. A dismissal is also a *first response*: if the proposal's `responded` field is still `false`, fire a `{"type":"responded","action":"dismiss"}` metrics event before the patch and add `--set responded=true` to it, or the proposal never counts as answered.
- **defer** — no date fields.
- **resolve** — as Step 3.

Say what the operator chose, and their reason, in the Decision line. If a dismissal reason states a durable preference that would apply to a whole *family* of future proposals rather than just this one, that is worth remembering as feedback — see proposal-act's dismissal-learning step. A proposal-specific "this doesn't apply here" is not.

## Step 5 — Refresh the artifact pages

Skip if Step 3 resolved nothing and Step 4 changed nothing (queue is unchanged). Otherwise, refresh the dashboard and the proposals page (`config.artifacts.proposals`) per `plugins/hermitd/docs/artifacts.md` — both silently, no URL re-post.

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

Omit the **No verdict** block when Step 2b came back complete. Keep it to what changed. The queue's remaining contents are already one `/proposal-list` away, and re-listing them here is the same noise this skill exists to remove.
