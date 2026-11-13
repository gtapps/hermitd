---
name: pricing-refresh
description: Refresh or verify the hermit cost rate table against Anthropic's live pricing. Use when the operator says "refresh pricing", "verify pricing", "is the rate table current", "new model pricing", or asks whether `scripts/lib/pricing.ts` matches current Claude rates. Maintainer-only; never autonomous, never a routine, never touches operator installs.
---

# Pricing refresh

Compare `plugins/hermitd/scripts/lib/pricing.ts` to Anthropic's live
docs and, **only after explicit confirmation**, edit the table. Do not run this
on a schedule. Do not write anything under an operator's `.hermit/`.

## Step 1 — Read the table

Read `plugins/hermitd/scripts/lib/pricing.ts`. Record every `PRICING`
key, its `{ input, output, cacheReadMult?, fast? }` rates, the `CACHE_WRITE_5M` /
`CACHE_WRITE_1H` / `CACHE_READ` multipliers, and `PRICING_VERIFIED`.

## Step 2 — Fetch live sources

Load the bundled `claude-api` skill. From its `shared/live-sources.md`, WebFetch
these three URLs:

- Models Overview
- Pricing
- Prompt Caching

Extract current model ids, per-MTok input/output, cache write (5m and 1h) and
read multipliers, any per-model cache-read rate, and fast-mode rates. Store a
per-model cache-read rate as `cacheReadMult` (that rate divided by the model's
standard input rate), never as an absolute $/MTok figure.

## Step 3 — Unknown ids in the log

From `.hermit/cost-log.jsonl` (this repo's own hermit dir, last 30
days of `timestamp`), list distinct `model` values that are not exact
`PRICING` keys (dated `<key>-YYYYMMDD` snapshots of an existing key count as
exact). Print them. Do not edit operator installs.

## Step 4 — Diff

Print a rate-diff table: id, live input/output/cache/fast vs the file. Flag
missing ids, stale rates, and a `PRICING_VERIFIED` date that is not today.

Stop here unless the operator confirms an edit.

## Step 5 — Edit on confirmation only

If the operator explicitly confirms:

1. Edit `plugins/hermitd/scripts/lib/pricing.ts` rates and keys to
   match the live table. Set `PRICING_VERIFIED` to today's date (`YYYY-MM-DD`).
2. Add a `### Fixed` bullet under `plugins/hermitd/CHANGELOG.md`
   `[Unreleased]`: rate table refreshed for the current generations.
3. Run `cd plugins/hermitd && bun test tests/pricing.test.ts`.

Do not commit. Do not bump `engines["claude-code"]`. Do not add a hook, a
routine, or a `config.json` entry.
