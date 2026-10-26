---
name: stale-proposals
description: "Audit this repository's local proposal queue for stale entries: proposals still marked proposed, deferred, or accepted even though the work already shipped, plus old proposals whose subject has become inert. Reconcile proposals against plugin changelogs and first-parent Git history, automatically resolve only unambiguous shipped matches, and ask before any weak-match, aged, dismissal, or deferral decision. Use when the user asks to check, reconcile, clean up, prune, or find stale proposals; asks whether proposal work already shipped; is confused why an old PROP remains open; or wants to stop heartbeat from repeatedly surfacing obsolete proposal-pending items. Supports a report-only no-apply mode."
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
bun .agents/skills/stale-proposals/scripts/collect-evidence.ts
```

The script prints one of:

- `OK|<bundle-path>|<open>|<bullets>|<commits>|<cutoff>`
- `NONE|no-open-proposals`
- `NONE|no-proposals-dir`

For `NONE|no-open-proposals`, report `Queue is clean — no open proposals.` and stop. For a missing proposals directory, report the missing queue and stop.

Do not read the evidence bundle in the main session. It can be tens of thousands of tokens and exists specifically to keep that corpus isolated.

## Step 2 — Match in one isolated worker

Spawn one worker agent with a fresh context (`fork_turns: "none"` when supported). Give it only the repository root, evidence-bundle path, and the contract below. Wait for its result before continuing. If agent spawning is unavailable, stop and explain that this audit requires one isolated worker; do not load the bundle into the main session as a fallback.

Use this contract verbatim, substituting the real path:

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

Reject malformed lines or missing proposal IDs instead of guessing.

## Step 3 — Apply strong matches

Skip this step in report-only mode.

For each `SHIPPED-STRONG` verdict, resolve the proposal ID to a filename. The filename lookup happens before mutation; an ambiguous or missing ID moves into Step 4.

```bash
bun plugins/hermitd/scripts/proposal.ts resolve-id .hermit "<PROP-ID>"
```

For an unambiguous filename, resolve it with the `resolve` verb, which writes the metrics rows and the patch together and records the accept first when the proposal was still `proposed`:

```bash
bun plugins/hermitd/scripts/proposal.ts resolve .hermit <filename> --stdin <<'HERMIT_PATCH'
Decision: Resolved on @now — shipped in <plugin> <version>. <evidence sentence>
HERMIT_PATCH
```

The evidence in the Decision line makes the automatic resolution auditable.

- `proposal.ts resolve-id` returning `AMBIGUOUS` or `NONE`: do not guess; move the item to Step 4.
- `proposal.ts` returning `ERROR|<reason>`: nothing was patched; report the failure and continue.

## Step 4 — Ask about weak and aged proposals

Present `SHIPPED-WEAK` first, then `AGED`. Ask the user in one concise round whether to resolve, dismiss, defer, or leave each item open. Separate items when one group clearly needs different decisions.

Stop and wait for the response. Do not interpret the original audit request as approval for these mutations.

Before applying a confirmed choice, read the current matching flow in `plugins/hermitd/skills/proposal-act/SKILL.md`; that file is the repository contract for proposal status fields, metrics ordering, decision text, and dashboard refresh behavior.

At minimum, preserve these invariants:

- **Resolve:** append a `resolved` metrics event before patching; set `status=resolved` and `resolved_date=@now`; do not set `dismissed_date`.
- **Dismiss:** if `responded` is false, append the first-response `responded` event before patching and set `responded=true`; set `status=dismissed`, `dismissed_date=@now`, and `resolved_date=@now`.
- **Defer:** if `responded` is false, append the first-response `responded` event before patching and set `responded=true`; set `status=deferred` and `deferred_date=@now`; do not set `resolved_date`.
- **Leave open:** make no changes.

Record the user's choice and reason in the Decision line where the current contract calls for one. Treat only family-wide dismissal preferences as durable feedback; proposal-specific reasons are not standing policy.

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
