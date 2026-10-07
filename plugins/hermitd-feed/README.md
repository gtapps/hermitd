# hermitd-feed

A **feed-to-brief pipeline** for [`hermitd`](../hermitd/README.md). Point it at a set of feeds, and it fetches, scores, writes, delivers, archives, and weekly-synthesizes a human-voice brief on a schedule — with source-health analytics that tell you which sources are actually earning their place.

## What it does

- **Curated source registry.** `feed-sources.md` (name / URL / category / type) + `feed-categories.md` (priority tiers). A validation hook keeps the table honest on every edit.
- **7-phase pipeline (`/hermitd-feed:feed-brief --morning|--evening`).** Fetch (a Haiku sub-agent pulls web/RSS; reddit and Chrome-typed sources handled separately) → score/filter (trust, relevance, novelty, actionability, dedup) → write to your `FEEDS.md` tone spec → deliver via your channel → archive with rich frontmatter.
- **Weekly synthesis (`/hermitd-feed:weekly-digest`).** Top stories, emerging vs faded themes, and a per-source performance readout built from the week's archive frontmatter.
- **Source curation skills.** `add-source` (type inference + dedup), `source-scout` (gap-driven discovery), `source-health` (dead-source and cost-efficiency audit).
- **Follow-ups.** `story-arcs` tracks developing stories across briefs; `deep-dive <slug>` expands any briefed item.

## Install

```
claude plugin install hermitd-feed --marketplace gtapps/hermitd --scope local
```

Then, in your project (with the core hermit already hatched):

```
/hermitd-feed:hatch
```

Hatch seeds **empty** registries and asks about slots, tone, and enrichments. It never ships anyone's source list — you add your own, or opt into a small generic starter pack.

## Requirements

- Core `hermitd` ≥ 1.3.3, installed and hatched.
- [Bun](https://bun.sh) 1.4+ (the fetch/validation scripts and tests are Bun/TypeScript).
- Optional: a running Chrome for `chrome`/`reddit-home`/`x`-typed sources (they skip gracefully when it's unavailable); reddit works unauthenticated out of the box (see [`docs/reddit.md`](docs/reddit.md)).

## Data you own vs data the plugin owns

You own `feed-sources.md`, `feed-categories.md`, and `FEEDS.md` at the project root. The plugin owns the `briefs/` archive, story-arc and pending-delivery state, and fetch scratch. Full contracts are in [`docs/schema.md`](docs/schema.md).

## Security

All fetched content is treated as untrusted: the pipeline extracts only structured data and never follows embedded instructions. A `fetch-guard` PreToolUse hook blocks WebFetch to any domain not in your `feed-sources.md`, so a poisoned source can't redirect fetches off your allowlist. If `feed-sources.md` cannot be read, the hook fails open rather than blocking all fetches.
