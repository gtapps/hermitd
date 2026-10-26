---
name: proposal-act
description: 'Accept, defer, dismiss, or resolve a proposal. For accepted proposals, asks how to proceed: start implementing now, queue a task, or note for manual implementation. Activates on messages like "accept PROP-", "dismiss PROP-", "defer PROP-", "resolve PROP-", "implement PROP-", "go ahead with PROP-", "implement suggestion #", or "go ahead with suggestion #"; implement and go-ahead requests use the accept flow.'
---

# Proposal Act

Take action on a proposal: accept, defer, dismiss, or resolve.

## Commands
- `artifact-render`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts render <type> .hermit`
- `proposal-quality-gate`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts quality-gate .hermit`
- `task-note`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit`
- `task-open`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts open .hermit`
- `conversation`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/conversation.ts .hermit`

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation. On a channel-tagged turn, step 4's bounded ask (below) also queues a durable micro-proposal entry via `proposal.ts queue-micro` — see `channel-responder` § Channel-safe ask bridge — so it survives compaction or a session restart.

## Usage

```
/hermitd:proposal-act accept PROP-019
/hermitd:proposal-act defer PROP-015
/hermitd:proposal-act dismiss PROP-012
/hermitd:proposal-act resolve PROP-008
/hermitd:proposal-act accept PROP-019 --answer "queued task"
/hermitd:proposal-act accept PROP-019 --no-artifacts
```

The `--answer` form is not typed by an operator — it's how a channel-safe resolution re-enters step 4 after an out-of-band reply (see `branches.md` § Channel re-entry (`--answer`)).

**Options:** `--no-artifacts` (alias `--no-artifact`) skips the dashboard and proposals-page refreshes. Patch, events, replies, and the micro-proposal queue are unaffected.

The accept options and channel re-entry live in `${CLAUDE_PLUGIN_ROOT}/skills/proposal-act/branches.md`. "Read branches.md § X" means: read that section now and follow it exactly. It is normative.

If no action or ID is provided, ask the operator which proposal and action.

## Resolving a Proposal ID

Before reading any proposal file, resolve the operator's input to a filename:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts resolve-id .hermit "<operator input>"
```
- `match`: proceed with `file`.
- `none`, reason `not_a_prop_id`: error "Not a PROP id."
- `none`, reason `no_match`: error "No proposal matches [input]. Use /proposal-list to see available proposals."
- `ambiguous`: show a disambiguation prompt from `matches` (`file`, `title`):
  ```
  Multiple proposals match PROP-NNN:
    PROP-NNN-capability-brainstorm-103612 — [title of first match]
    PROP-NNN-session-cost-tracking-104207 — [title of second match]
  Reply with the full ID to continue.
  ```
  Re-resolve with the operator's reply.

## Timestamp Convention

All timestamps in frontmatter and Operator Decision text use ISO 8601 with timezone offset (e.g., `2026-04-06T14:30:00+01:00`). Use the timezone from `config.json` if set, otherwise UTC. `@now` in a `proposal.ts patch` `--set` value or in a stdin `Decision:`/`Set:` line expands to this stamp — prefer it over composing the timestamp yourself.

## Dashboard Refresh

Every flow below (accept, defer, dismiss, resolve) changes a proposal's status. After its final "Respond" step, refresh the dashboard and the proposals page (`config.artifacts.proposals`) per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md` — both silently, no URL re-post (unlike `proposal-create`'s initial announcement, these status-change confirmations don't append the proposals-page URL). Skip both when `--no-artifacts` is set. When the accept flow resolves the proposal itself, the inner resolve is invoked with `--no-artifacts` and this outer flow still refreshes once at its end, so one operator turn publishes at most once per page.

## Accept Flow

When the operator accepts a proposal:

**Channel re-entry first.** When invoked as `accept PROP-NNN --answer "<label>"`, the proposal is already `accepted` from the original turn: skip steps 1-3a entirely (no second "Accepted on …" Decision, no second `responded` event, no routine re-upsert) and Read branches.md § Channel re-entry (`--answer`).

1. Resolve the proposal file using the resolution algorithm above, then read it.

2. **Determine what to set.** Use the current task record id when this turn belongs to an open record. From the file already read in step 1:
   - `responded`: if currently `false`, plan `--set responded=true` for the patch call below and fire the first-response event now, **before** that patch call, so its summary regen already reflects it:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts event .hermit responded --id=PROP-NNN --action=accept
     ```
     If `responded` is already `true`, skip both (prevents double-counting).
   - `accepted_in_session`: this retained provenance field takes the current task record id, when one exists, via `--set accepted_in_session=<task_id>`. Without a current record, leave it unset.
   - `success_signal` (optional): check whether the body has a `## Success Signal` section with a non-empty predicate line (ignore comment lines starting with `<!--`). If found, validate it:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts success-signal --validate "<predicate line>"
     ```
     `OK` → plan a stdin `Set: success_signal=<predicate line>` line for the patch call (free text — never argv `--set`). Status `invalid` → plan a `task.ts note .hermit <id>` warning when running inside an open record, otherwise report the warning: `PROP-NNN success_signal ignored: <reason>`. No section, or empty/comment-only → leave `success_signal` unset. Never block accept regardless of outcome.

3. **Patch.** One call applies the frontmatter flip, session tracking, success signal, and the Operator Decision timestamp — assembled from what step 2 determined:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .hermit <filename> \
       --set status=accepted --set accepted_date=@now \
       [--set responded=true] [--set accepted_in_session=<task_id>] --stdin <<'HERMIT_PATCH'
   Decision: Accepted on @now.
   [Set: success_signal=<predicate line>]
   HERMIT_PATCH
   ```
   Do NOT set `resolved_date`: resolution happens when reflect confirms the pattern is gone. `{"id":…}` confirms the write; `{"error":…}` means nothing was patched; report it to the caller/operator and stop.

3a. **Routine proposals.** If the proposal's frontmatter `category: routine` (or a `Type: routine` line) **and** a `## Config` section with a JSON block: upsert into `config.json` after any skill/agent install below.

   **When the body also carries `## Skill Draft` and/or `## Agent Draft`:** Read branches.md § Start implementing now for the Routine-bound install flow, the `## Agent Draft` install branch, e.5 and e.6, and run them in that order (install flow first, then e.5 and e.6), then the upsert below; do not enter step 4's implementation ask. Before authoring, confirm each draft's `source_artifact` exists and is readable (a `.hermit/helper-reports/` procedure file in place; a legacy brief in `compiled/`, then `compiled/.archive/`) — a missing or unreadable brief is the `stale-paths` rejection the step-4 gate would have raised: stop, leave `status: accepted`, write no routine, and tell the operator to refresh the proposal input. The routine-bound branch needs no second full-artifact confirmation: intent was already approved through the bridged accept/dismiss ask; the skill is routine-bound, not chat-fired; the operator reverts by disabling the routine. Keep the collision guard, e.5 quality gate, and e.6 verification. A collision guard answered **Cancel** installs nothing — stop before the upsert too, so no routine is left scheduled against a skill that was never written. A standalone `## Skill Draft` with no `## Config` is obsolete: install nothing and use close-time learning instead.

   Then upsert:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts routine .hermit <<'HERMIT_ROUTINE'
   <the ## Config JSON block, verbatim>
   HERMIT_ROUTINE
   ```
   The script validates `id`/`schedule`/`skill`/`enabled` are present and upserts by `id`: `status` `added` or `updated`, or `{"error":…}` (nothing written; report it and stop).
   - Notify the operator with one plain notice: saved (skill, and agent if any), first run time from the cron, how to stop (disable the routine).
   - Do not enter step 4 — the routine branch is complete.

4. Ask: **"How should this be implemented?"**

   **Already answered:** when the request named this proposal and asked to implement it or go ahead with it, in any language, take **"Start implementing now"** below without asking or queueing an entry. A plain accept or approve still asks.

   **Channel-tagged turn:** do not wait interactively for a reply in this turn. Send the question via the channel reply tool in plain voice with the three options numbered — "Suggestion #N — start now, queue it as a task, or leave it to you?" (derive `#N` per `proposal-list` §4a). AND queue a pending micro-proposal entry:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts queue-micro .hermit <<'HERMIT_MP'
   {"tier":1,"question":"Suggestion #N accepted — how should it be implemented?","options":["implement now","queued task","manual"],"on_resolve":"/hermitd:proposal-act accept PROP-NNN --answer {answer}","proposal_id":"PROP-NNN","chat":"<sourceKey>:<chat_id>"}
   HERMIT_MP
   ```
   When this accept carries `--no-artifacts`, append the flag to `on_resolve` (`... --answer {answer} --no-artifacts`) so the re-entry skips the refreshes too.
   (the `on_resolve` and `proposal_id` ids stay `PROP-NNN` — internal, never shown; `proposal_id` is what retires this ask automatically if the proposal is resolved, dismissed, or deferred before the operator answers). Then stop — steps 1-3a already ran, so `status: accepted` is a safe resting state until the operator answers (immediately in this same conversational turn, or later via `branches.md` § Channel re-entry (`--answer`)). The interactive terminal path below is unchanged.

   - **"Start implementing now"** (default, typical answer): Read branches.md § Start implementing now. If a compaction lands mid-implementation, re-read it but resume at the first step not yet on record: a gate verdict already in `## Operator Decision` means the gate ran, and an existing `proposal:PROP-NNN` task record means (a) ran, so check its notes before dispatching again.
   - **"Queue a task"** → Read branches.md § Queue a task.

   - **"I'll handle it manually"** → Just mark accepted. Respond: "Marked as accepted. No further action taken."

5. Notify the operator: "PROP-NNN accepted: [title]". On a channel-tagged turn (Step 0), use plain voice instead, matching the step-4 branch actually taken: **start now** → "Got it — starting on Suggestion #N."; **queued task** → "Queued Suggestion #N as a task."; **manual** → "Marked Suggestion #N as accepted — leaving it to you." (`#N` per `proposal-list` §4a.)

## Defer Flow

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. **First-response tracking:** check the `responded` field. If `false`, fire the event now — before the patch call below, so its summary regen reflects it:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts event .hermit responded --id=PROP-NNN --action=defer
   ```
   Skip if already `true`.
3. Ask: "Any note on why it's deferred or when to revisit?" (optional — operator can skip)
4. Patch:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .hermit <filename> \
       --set status=deferred --set deferred_date=@now [--set responded=true] --stdin <<'HERMIT_PATCH'
   Decision: Deferred on @now. Reason: [operator's note]
   HERMIT_PATCH
   ```
   Do NOT set `resolved_date`: deferral is not a terminal state. Omit the `Decision:` line entirely if no note was given. `{"id":…}` confirms; `{"error":…}` means nothing was patched; report it and stop.
5. Respond: "PROP-NNN deferred." On a channel-tagged turn (Step 0), use plain voice instead: "Held Suggestion #N for later."

Deferred proposals still appear in `/proposal-list` but are sorted below open proposals.

## Dismiss Flow

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. **First-response tracking:** check the `responded` field. If `false`, fire the event now — before the patch call below, so its summary regen reflects it:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts event .hermit responded --id=PROP-NNN --action=dismiss
   ```
   Skip if already `true`.
3. Ask: "Reason for dismissal?" (optional — operator can skip)
4. Patch:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .hermit <filename> \
       --set status=dismissed --set dismissed_date=@now --set resolved_date=@now [--set responded=true] --stdin <<'HERMIT_PATCH'
   Decision: Dismissed on @now. Reason: [operator's reason]
   HERMIT_PATCH
   ```
   Omit the `Decision:` line entirely if no reason was given. `{"id":…}` confirms; `{"error":…}` means nothing was patched; report it and stop.
4b. **Dismissal learning** — only when a reason was provided in step 3. Judge whether the reason states a durable preference, rule, or taste that applies to a *family* of future proposals (e.g. "don't propose process changes for things I do twice a year", "stop suggesting test-coverage proposals on docs-only changes") versus a one-off or proposal-specific response ("not now", "already did this manually", "the analysis is wrong", "duplicate of last week"). If generalizable, save it through the normal auto-memory flow as a `feedback` entry: the rule, a brief `Why:`, and `How to apply:` so proposal-triage and reflection-judge can match it in their memory cross-check. One-off or sub-threshold: save nothing.
5. Respond: "PROP-NNN dismissed." If step 4b saved a preference, add: "Remembered that as a standing preference (future similar proposals may be filtered)." On a channel-tagged turn (Step 0), use plain voice instead: "Dropped Suggestion #N." (same preference-remembered addendum, in plain voice, if step 4b saved one).

Dismissed proposals are hidden from the default `/proposal-list` view. Use "show all" with `/proposal-list` to see them.

## Resolve Flow

Used when reflect has surfaced a sparse-cadence proposal as a resolution candidate (pattern absent from recent sessions but cadence too infrequent to auto-resolve). Also available directly: `/hermitd:proposal-act resolve PROP-NNN`.

1. Resolve the proposal file using the resolution algorithm above, then read it.
2. Resolve: metrics rows, frontmatter flip, Operator Decision timestamp, and the compaction-boundary marker in one call:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts resolve .hermit <filename> --stdin <<'HERMIT_PATCH'
   Decision: Resolved on @now.
   HERMIT_PATCH
   ```
   When reflect's auto-resolve flow triggered this (pattern absent from recent sessions), the caller may append "Pattern confirmed absent." to the Decision line.

   A proposal still `proposed` was never accepted, so the verb records that accept first (`accepted_date`, plus the first-response `accept` event when `responded` is false). Any other status gets only the `resolved` event.

   The verb writes `state/compact-requested.json` (`{"requested_at": <now>, "reason": "proposal-resolve"}`, singleton, overwritten unconditionally). A resolved proposal's implementation is fully committed, so this is a safe moment for the watchdog's routine-hygiene compactor (`maybeContextCompact`) to waive its interval cooldown on the next tick. Both the dispatched-path post-return handling and the in-main path (f) route through this Resolve Flow, so one call here covers both; batched overwrites of the same singleton coalesce into a single compaction (existing operator-silence and execution-boundary guards).

   `{"id":…}` confirms; `{"error":…}` means nothing was patched; report it and stop.
3. Respond: "PROP-NNN resolved."
