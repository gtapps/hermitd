---
name: proposal-list
description: Lists all proposals with their status, source, and age. Shows auto-detected proposals prominently. Activates on messages like "what have you noticed", "any improvements", "any proposals", "show proposals".
---
# Proposal List

Lists all proposals with status, source, and age. Auto-detected proposals (from the learning loop) are listed first.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool and render as **Suggestion cards** (§4a) instead of the table (§4). Otherwise emit the table to conversation as usual.

## Plan

### 1. List proposals

Run the bounded list verb fresh:
```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts list .hermit
```
Use `--all` when the operator asks to show all or include dismissed/resolved proposals; otherwise those statuses are hidden, even with `--status`. Optional `--status=<csv>` and `--source=<value>` narrow the results; `--limit=<n>` changes the default limit of 50.

The JSON object contains `total`, `shown`, and `proposals`, sorted with auto-detected first, then proposed, accepted, deferred and other statuses, newest first within each group. Display the returned `age_days` as "N days ago". Unparseable proposals have status `unknown` and null metadata. When `total` is 0, respond "No proposals found." and stop. When `shown` is below `total`, state how many are shown and offer a larger limit or narrower filter.

Do not read proposal bodies unless the operator asks for a specific proposal's detail.

### 4. Display as table (terminal path)

```
| ID                                       | Status   | Source        | Category    | Age          | Summary                          |
|------------------------------------------|----------|---------------|-------------|--------------|----------------------------------|
| PROP-020-tag-correlation-103612          | proposed | auto-detected | improvement | 1 session    | [tag-correlation] Frontend blocked |
| PROP-019-test-env-recurring-091455       | proposed | auto-detected | routine     | 3 sessions   | [blocker] Test env recurring     |
| PROP-015-refactor-auth-module-142233     | proposed | manual        | improvement | 12 sessions  | ⚠ Refactor auth module           |
| PROP-012                                 | accepted | manual        | capability  | 20 sessions  | Add retry logic (legacy ID)      |
```

Stale proposals (open for 10+ sessions) get a ⚠ prefix on the summary line.

### 4a. Suggestion cards (channel path)

Never surface `PROP-NNN`, the slug/timestamp, `category`, or tier in channel text — the operator sees a plain suggestion number and a summary. Derive `#N` by stripping leading zeros from the proposal's `PROP-(\d+)` integer (e.g. `PROP-014-tag-correlation-103612` → `#14`); this is a deterministic reverse-lookup (`proposal-act`'s resolution algorithm already accepts an unpadded `PROP-N`), not a separate stored counter.

For each `status: proposed` proposal (same ordering as §4), render one card:

```
Suggestion #14 — Frontend blocked on tag correlation.
Reply YES to go ahead, LATER to hold, NO to drop it.
```

Derive the summary from the title with any `[category]`/`[blocker]` bracket prefix stripped. Drop the stale-⚠ marker; if a card is stale, fold it into the summary in plain words instead ("been waiting a while").

Non-open proposals (`accepted`/`deferred`, plus `dismissed`/`resolved` when "show all" was asked — step 1) that the operator explicitly asked to see render as one plain line each, no reply prompt, stating the status in plain words:

```
Suggestion #12 — Add retry logic (already accepted).
```

If more than one Suggestion card is shown, add one footer line: "Reply with the number if you mean a specific one, e.g. 'YES #14'." Omit the footer when only one card is shown — a bare YES/LATER/NO is unambiguous.

### 6. Offer actions (terminal path only)

After displaying the table, offer:

```
Actions: /proposal-act accept [ID] | /proposal-act defer [ID] | /proposal-act dismiss [ID]
```

If there are stale proposals, add: "⚠ N proposal(s) have been open for 10+ sessions. Consider reviewing or dismissing."

On the channel path (§4a), the card's own YES/LATER/NO prompt is the action offer — no slash-command footer.
