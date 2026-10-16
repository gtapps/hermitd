# Data contracts

This is the product's spine. Every skill in `hermitd-feed` reads or writes one of the
contracts below. They must not drift — `source-health`, `weekly-digest`, and session-context
injection all depend on the exact key names and semantics documented here.

All examples use PLACEHOLDER values. No real source names, categories, or operator data appear.

---

## 1. Registries (operator-owned, project root)

### `feed-sources.md`

The source registry. One markdown table with this exact header:

```markdown
| Name | URL | Category | Type | Notes |
| ---- | --- | -------- | ---- | ----- |
| Example Blog | https://example.com/news | Category A | web | first-party release notes |
| Example Feed | https://example.com/feed.xml | Category A | rss | Atom feed |
| Example Forum | https://example.com/board | Category B | chrome | blocks WebFetch |
| Example Subreddit | https://reddit.com/r/example | Category B | reddit | subreddit hot posts |
| Home Feed | https://reddit.com/ | Category B | reddit-home | personalized front page |
| Example Handle | https://x.com/example | Category C | x | account timeline |
```

**`Type` enum** — tells the pipeline how to fetch each source:

| Type          | Fetched by                         | Needs Chrome | What it is                                             |
| ------------- | ---------------------------------- | ------------ | ------------------------------------------------------ |
| `web`         | `WebFetch` (via `source-fetcher`)  | No           | Blogs, news sites, static listing pages                |
| `rss`         | `WebFetch` (via `source-fetcher`)  | No           | RSS/Atom feeds                                         |
| `chrome`      | Chrome (browser session)           | Yes          | Pages that block plain WebFetch (403/bot detection)    |
| `reddit`      | `reddit-fetch.ts` → Chrome → skip  | Optional     | A subreddit's hot posts (see `docs/reddit.md`)         |
| `reddit-home` | Chrome                             | Yes          | Personalized Reddit front page (logged-in view)        |
| `x`           | Chrome                             | Yes          | An X/Twitter account, timeline, or search              |

Only `web` and `rss` are handled by the `source-fetcher` agent. `chrome`/`reddit-home`/`x`
require a Chrome session; `reddit` tries `reddit-fetch.ts` first and falls back to Chrome, then skip.

### `feed-categories.md`

Operator's focus areas and priority tiers. One table, this exact header:

```markdown
| Category | Priority |
| -------- | -------- |
| Category A | 1 |
| Category B | 2 |
| Category C | 3 |
```

`Priority 1` = highest. Brief scoring surfaces P1 categories first. Category names used in
archive frontmatter (`top_categories`) must match a `Category` value here verbatim.

---

## 2. Daily archive frontmatter

Written by `feed-brief` (Phase 6) to
`.hermit/briefs/YYYY-MM-DD-<slot>.md` (`<slot>` = `morning`, `evening`, or a
custom slot name). Body is the full delivered brief text.

```yaml
---
date: 2026-01-15
type: morning                     # slot name: morning | evening | <custom>
title: "Morning Brief — 2026-01-15"
created: "2026-01-15T09:00:00+00:00"   # ISO 8601 with timezone
tags: [brief]
top_categories: [Category A, Category B]   # top 5 by item count, verbatim from feed-categories.md
item_count: 6                     # total items included in the brief
sources_used: [Example Blog, Example Feed]     # sources that contributed >=1 item
sources_skipped: [Example Forum]  # fetch FAILED (see below)
sources_quiet: [Home Feed]        # fetched clean, 0 items worth including (see below)
fetch_log:                        # optional per-source efficiency log; omit if unavailable
  - source: Example Feed
    type: rss
    tokens_approx: 3000
    items_yielded: 7
    items_scored_p1: 2
---
```

Key list (round-trippable): `date, type, title, created, tags, top_categories, item_count,
sources_used, sources_skipped, sources_quiet, fetch_log`.

**`sources_skipped` vs `sources_quiet` — never collapse these two.** This distinction powers
`source-health` and the weekly source-reliability signal:

- **`sources_skipped`** — the fetch itself FAILED: network error, Chrome unavailable/down, or
  a fetch script exited non-zero (e.g. `reddit-fetch.ts` exit 1). A reliability signal —
  repeated skips mean the source is broken.
- **`sources_quiet`** — the source fetched cleanly but contributed 0 items worth including (a
  quiet day). NOT a reliability signal — a quiet day must never count against a source.

`fetch_log` is optional: omit the key entirely if fetch-stat data wasn't produced (pipeline
aborted early / fewer than 3 sources). See §4 for the entry shape.

---

## 3. Weekly archive frontmatter

Written by `weekly-digest` to `.hermit/briefs/weekly/YYYY-WNN.md` (ISO week
number). Synthesizes the past 7 days of daily archives — never re-fetches.

```yaml
---
date: 2026-01-18                  # Sunday of the week
week: 2026-W03
title: "Weekly Digest — 2026-W03"
created: "2026-01-18T10:30:00+00:00"   # ISO 8601 with timezone
tags: [brief]
brief_count: 7                 # actual number of daily archives read
top_categories: [Category A, Category B]   # top 3 from the full body tally
sources_used: [Example Blog, Example Feed]     # union of all sources_used across the week
sources_skipped: [Example Forum]  # union of all sources_skipped across the week
---
```

Key list: `date, week, title, created, tags, brief_count, top_categories, sources_used,
sources_skipped`. (Weekly has no `sources_quiet`, `item_count`, or `fetch_log`.)

---

## 4. fetch_log entry

Each element of the daily `fetch_log[]` array — one per source that had a fetch attempt.

```json
{ "source": "Example Feed", "type": "rss", "tokens_approx": 3000, "items_yielded": 7, "items_scored_p1": 2 }
```

- `source` — source `Name` from `feed-sources.md`.
- `type` — the source's `Type`.
- `tokens_approx` — approximate fetch cost, by type default:
  - **3000** for `web`, `rss`, and `reddit` served via `reddit-fetch.ts`.
  - **20000** for `chrome`, `reddit-home`, `x`, and any `reddit` that required a Chrome fetch.
- `items_yielded` — raw items the source produced this run.
- `items_scored_p1` — how many of those survived the P1 relevance threshold into the final brief.

Skipped sources are included with `items_yielded: 0, items_scored_p1: 0` and their type-default
`tokens_approx`, so `source-health` can separate skipped vs quiet vs efficient.

---

## 5. source-items JSON (fetch scratch)

Written by the `source-fetcher` agent to `tmp/feed-source-items-<slot>.json` (project root,
NOT `/tmp/`). Read by `feed-brief` Phase 1 (item collection + source reconciliation); the items
it carries are scored in Phase 3. Raw scratch — 3-day retention (§10).

```json
{
  "run_id": "<caller-supplied-run-id>",
  "fetch_date": "2026-01-15T09:00:00+00:00",
  "sources": [
    {
      "name": "Example Blog",
      "type": "web",
      "url": "https://example.com/news",
      "status": "ok",
      "items": [
        {
          "title": "Example headline text",
          "summary": "Short source-derived excerpt.",
          "url": "https://example.com/news/example-item",
          "published_at": "2026-01-14",
          "source": "Example Blog",
          "section": "",
          "author": ""
        }
      ]
    },
    {
      "name": "Example Feed",
      "type": "rss",
      "url": "https://example.com/feed.xml",
      "status": "failed",
      "error": "timeout"
    }
  ]
}
```

- `run_id` is required and copied exactly from the caller, which generates a fresh UUID before dispatch.
- Only `web` and `rss` sources appear (the agent skips `chrome`/`reddit`/`reddit-home`/`x`).
- Per-source: `name`, `type`, `url`, `status` (`ok`|`failed`). `ok` carries `items[]`;
  `failed` carries `error` and omits items.
- Per item, exactly: `title`, `summary`, `url`, `published_at`, `source`, `section`, `author`.
- Caps/rules: <=20 items per source; `summary` is source-derived or `""`; URLs absolute and
  deduped within a source; continue-on-failure.

**Maps to daily-archive `sources_skipped`/`sources_quiet` (§2), for `web`/`rss` sources only:**
`status: "failed"` (or any status other than `"ok"`), or such a source absent from `sources[]`
entirely, → `sources_skipped`; `status: "ok"` with empty `items[]` → `sources_quiet`.
`chrome`/`reddit`/`reddit-home`/`x` sources never appear here and are classified by
`feed-brief` Phase 2 instead. A source that yielded items but lost all of them to Phase 3
scoring is also `sources_quiet` per §2.
`feed-brief` Phase 1 first verifies the file with `scripts/source-fetch-result.ts verify`
using the ID it generated before dispatch. The helper reads once and prints the accepted
JSON only when the top-level object has the matching `run_id` and a `sources` array.
The caller reconciles that returned payload, not a second file read or the agent's reply.
Run ID generation or verification failure sends every web/RSS source to `sources_skipped`,
then Phase 2 continues without redispatch. Run ID generation deletes the previous output
file before dispatch, so a stale or oversized file never outlives the next run; no migration
is needed.

Matching run identity permits unchanged articles, quiet sources, and partial failures.
It does not prove network fetching or enforce the model's invocation of the verifier.
See `skills/feed-brief/SKILL.md`.

Full contract lives in `agents/source-fetcher.md`.

---

## 6. brief-feedback

Monthly reaction log at `.hermit/compiled/brief-feedback-YYYY-MM.md`. One line per reaction event:

```
2026-01-15 morning | 👍 | source: Example Blog | topic: example-topic-slug
```

Line grammar: `YYYY-MM-DD <slot> | <emoji> | source: <name> | topic: <topic>`.

**Producer vs consumer.** The PRODUCER of these lines (a Discord reaction → feedback line) is a
channel-layer concern and is NOT shipped in this plugin. `weekly-digest` is the CONSUMER: it
counts 👍/👎 per source over the week window and folds a note into the digest's source section.
It degrades gracefully — when no `brief-feedback-*.md` file exists, the aggregation step is
skipped silently.

---

## 7. brief-message-registry

`state/brief-message-registry.json`. Maps a delivered message ID to the brief it carried, so a
later reaction on that message can be attributed. Written by `feed-brief` after a successful send.

```json
{
  "message-id-placeholder": {
    "date": "2026-01-15",
    "slot": "morning",
    "sources_used": ["Example Blog", "Example Feed"]
  }
}
```

Cap: 60 entries. At the limit, evict the oldest by `date` before inserting. Multi-part briefs
give every part's message ID the same metadata.

---

## 8. pending-delivery

`.hermit/compiled/pending-delivery.md` — a singleton holding a brief whose send failed, so it can be
delivered on the operator's next inbound message. Overwritten on each failure; cleared once
delivered.

```yaml
---
title: Pending Brief Delivery
type: pending-delivery
created: "2026-01-15T09:00:00+00:00"   # ISO 8601 with timezone
brief_path: .hermit/briefs/2026-01-15-morning.md
---
<full brief text as delivered>
```

Frontmatter keys: `title, type, created, brief_path`.

---

## 9. brief-summary

`.hermit/compiled/brief-summary-last-<date>.md` — a compact one-line summary of the last
delivered brief, injected at every session start. Accumulates; the newest is chosen for injection.

```yaml
---
title: Last Brief
type: brief-summary
created: "2026-01-15T09:00:00+00:00"   # ISO 8601 with timezone
tags: [brief, foundational]
---
**morning brief · 2026-01-15** — one-sentence lead story. 6 items across 8 sources.
```

Frontmatter keys: `title, type, created, tags`. The `foundational` tag forces startup
injection. Body: <=250 chars, one line.

---

## 10. Retention

- **source-items** (`tmp/feed-source-items-<slot>.json`): 3-day retention. The pipeline is
  daily, so items older than 3 days are stale scratch.
- **All other compiled artifacts**: default 14-day retention (core `knowledge.raw_retention_days`
  in `config.json`). Living pages are exempt from rotation per core knowledge rules.
- **`briefs/`**: never rotated. It is a plugin-owned archive registered in
  `config.storage_drift.ignore` (by hatch step 6e), so core neither injects nor rotates it —
  hermitd-feed owns its retention, and the retention policy is "keep everything". Its
  session-facing projection is `compiled/brief-summary-last-*.md`; its readers are
  `weekly-digest`, `story-arcs`, and `source-health`.
