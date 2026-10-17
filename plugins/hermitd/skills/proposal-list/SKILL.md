---
name: proposal-list
description: Lists all proposals with their status, source, and age. Shows auto-detected proposals prominently. Activates on messages like "what have you noticed", "any improvements", "any proposals", "show proposals".
---
# Proposal List

Lists all proposals with status, source, and age. Auto-detected proposals (from the learning loop) are listed first.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool and render as **Suggestion cards** (§4a) instead of the table (§4). Otherwise emit the table to conversation as usual.

## Plan

### 1. Read the proposals index

Rebuild the index:
```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts index .hermit
```
Then read `.hermit/state/proposals-index.json` — a derived cache of every proposal's frontmatter (`id`, `status`, `source`, `category`, `title`, `created`, `session`, `responded`, plus an `unparseable` flag), refreshed on every proposal write by the `generate-summary` PostToolUse hook. **(fresh read — re-read the file now; do not reuse a value cached in context from before compaction.)**

The rebuild reads frontmatter off disk (idempotent, no LLM/token cost), so run it unconditionally. It also catches out-of-band proposal writes and **deletions** that the `generate-summary` hook (which fires only on `Edit`/`Write` tool payloads) never sees. When the script prints `status` `skip` or `count` 0, respond "No proposals found." and stop.

**Do not read proposal bodies.** Every field the table needs is in the index row; this is the whole point of the index (reading a dozen full bodies costs ~22K tokens for a table that needs only frontmatter). Read a specific body only if the operator asks to see one proposal's detail.

### 2. (metadata is already parsed)

The index rows are the parsed metadata — use them directly. A file whose frontmatter can't be read (unreadable, or no `---` block) appears with `unparseable: true` and every field null, counting as status `unknown` — the lifecycle can't act on it, since proposal.ts only writes frontmatter.

### 3. Calculate age

Calculate age in days since the proposal's `created` timestamp. Display as "N days ago".

### 4. Display as table (terminal path)

```
| ID                                       | Status   | Source        | Category    | Age          | Summary                          |
|------------------------------------------|----------|---------------|-------------|--------------|----------------------------------|
| PROP-020-tag-correlation-103612          | proposed | auto-detected | improvement | 1 session    | [tag-correlation] Frontend blocked |
| PROP-019-test-env-recurring-091455       | proposed | auto-detected | routine     | 3 sessions   | [blocker] Test env recurring     |
| PROP-015-refactor-auth-module-142233     | proposed | manual        | improvement | 12 sessions  | ⚠ Refactor auth module           |
| PROP-012                                 | accepted | manual        | capability  | 20 sessions  | Add retry logic (legacy ID)      |
```

Ordering:
1. Auto-detected proposals first (Source: auto-detected), then manual
2. Within each group: open (proposed) first, then accepted, then deferred
3. Within each status: newest first

Stale proposals (open for 10+ sessions) get a ⚠ prefix on the summary line.

### 4a. Suggestion cards (channel path)

Never surface `PROP-NNN`, the slug/timestamp, `category`, or tier in channel text — the operator sees a plain suggestion number and a summary. Derive `#N` by stripping leading zeros from the proposal's `PROP-(\d+)` integer (e.g. `PROP-014-tag-correlation-103612` → `#14`); this is a deterministic reverse-lookup (`proposal-act`'s resolution algorithm already accepts an unpadded `PROP-N`), not a separate stored counter.

For each `status: proposed` proposal (same ordering as §4), render one card:

```
Suggestion #14 — Frontend blocked on tag correlation.
Reply YES to go ahead, LATER to hold, NO to drop it.
```

Derive the summary from the title with any `[category]`/`[blocker]` bracket prefix stripped. Drop the stale-⚠ marker; if a card is stale, fold it into the summary in plain words instead ("been waiting a while").

Non-open proposals (`accepted`/`deferred`, plus `dismissed`/`resolved` when "show all" was asked — §5) that the operator explicitly asked to see render as one plain line each, no reply prompt, stating the status in plain words:

```
Suggestion #12 — Add retry logic (already accepted).
```

If more than one Suggestion card is shown, add one footer line: "Reply with the number if you mean a specific one, e.g. 'YES #14'." Omit the footer when only one card is shown — a bare YES/LATER/NO is unambiguous.

### 5. Default filtering

By default, **hide** proposals with status `dismissed` or `resolved`.

If the operator asks to "show all", "include dismissed", "show everything", or similar: include all proposals regardless of status. Dismissed and resolved proposals appear at the bottom of the table with their status visible.

### 6. Offer actions (terminal path only)

After displaying the table, offer:

```
Actions: /proposal-act accept [ID] | /proposal-act defer [ID] | /proposal-act dismiss [ID]
```

If there are stale proposals, add: "⚠ N proposal(s) have been open for 10+ sessions. Consider reviewing or dismissing."

On the channel path (§4a), the card's own YES/LATER/NO prompt is the action offer — no slash-command footer.
