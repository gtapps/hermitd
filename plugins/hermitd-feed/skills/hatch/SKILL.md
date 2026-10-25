---
name: hatch
description: One-time feed hermit setup. Seeds the source registry and FEEDS.md tone spec, configures brief slots/tone/enrichments, drops routine prompts, and wires routines including source-scout into config.json. Run once per project after /hermitd:hatch.
disable-model-invocation: true
---

# Hatch — hermitd-feed

Idempotent setup wizard for the feed plugin. Run **after** `/hermitd:hatch` has already completed.

---

## Step 1 — Prerequisite check

Check whether `.hermit/config.json` exists.

If it does not:

Print this block and stop:

```markdown
## ▶ Next step — type this now

    /hermitd:hatch

I can't run setup wizards for you (they're operator-run by design).
After it finishes, come back and type `/hermitd-feed:hatch`.
```

If it does exist, run `.hermit/bin/hermitd-run domain-hatch preflight hermitd-feed` and parse the JSON verdict. Branch on `action`:

- **`bootstrap_core` / `upgrade_core_package` / `upgrade_core_applied`** → tell the operator to run the `next_steps` commands in order, then stop. An older core prints the dashed form of these with a `remedy` instead: relay `remedy` and stop.
- **`verify`** → say:

  > "hermitd-feed {self_version} is already installed. Skip to Step 4 to re-verify, or reply 'full' to re-run the full wizard."

  Use `AskUserQuestion`: "(verify / full)" — **verify** → skip to Step 4; **full** → continue from Step 2.
- **`full`** → continue from Step 2.
- **`error`**, or any `domain-hatch` command in this skill that prints `error` → tell the operator in plain words what its token means, then stop.

---

## Step 2 — Seed the registries and tone spec

The operator owns three files at the **project root**: `feed-sources.md`, `feed-categories.md`, `FEEDS.md`. Seed each from the plugin template **only if it does not already exist** (never overwrite operator content).

For each of:
- `${CLAUDE_PLUGIN_ROOT}/state-templates/feed-sources.md` → `feed-sources.md`
- `${CLAUDE_PLUGIN_ROOT}/state-templates/feed-categories.md` → `feed-categories.md`
- `${CLAUDE_PLUGIN_ROOT}/state-templates/FEEDS.md` → `FEEDS.md`

Read the destination first: if it exists, skip (report `⊘ skipped <file> (already present)`); if not, Read the template and Write it to the root (report `✓ seeded <file>`).

**Starter pack (opt-in).** If `feed-sources.md` and `feed-categories.md` were freshly seeded (both empty), offer the starter pack with `AskUserQuestion` (header: "Starter sources"): **Start empty** (recommended — add your own with `/hermitd-feed:add-source`) / **Seed a small generic tech/AI starter pack**. If the operator opts in, Read `${CLAUDE_PLUGIN_ROOT}/state-templates/starter-pack.md` and merge its Categories rows into `feed-categories.md` and its Sources rows into the `## Active Sources` table in `feed-sources.md`. Never seed the starter pack over a non-empty registry.

**gitignore.** Read the project `.gitignore`. Ensure `tmp/` is present (the fetch scratch dir); append it if missing. (`feed-sources.md`/`feed-categories.md`/`FEEDS.md` are operator content — do NOT gitignore them.)

---

## Step 3 — Brief configuration wizard

Ask the operator (use `AskUserQuestion`, one prompt per decision or batched):

1. **Slots** — morning brief time and evening brief time (24h `HH:MM`, operator's local timezone). Defaults: morning `09:00`, evening `21:30`. Either slot can be disabled.
2. **Weekly digest** — day + time. Default: Sunday `10:30`. Can be disabled.
3. **Tone preset** — free-form label stored for the `feed-brief` skill (e.g. `default`, `concise`, `deep`). Default `default`. (The full voice lives in `FEEDS.md`; this is a coarse dial.)
4. **Enrichments** — `story_arcs` (cross-reference developing stories into briefs) on/off; `follow_up_cta` (append a `/deep-dive` reply prompt to top-tier items) on/off. Defaults: both off.
5. **Reaction feedback** — track 👍/👎 reactions on delivered briefs for the weekly source signal, on/off. Default off. (Note: the reaction→feedback-line producer is a channel-layer concern; enabling this only turns on the message-registry write and weekly aggregation — see `docs/schema.md`.)

Convert each `HH:MM` to a cron expression for Step 4 (`M H * * *` for daily slots; `M H * * 0` for a Sunday weekly). Hold the answers in context.

---

## Step 4 — Stamp and register in config.json

Re-read `.hermit/config.json` now — the wizard has been running since Step 1 and the on-disk file may have changed. Apply the merges below to that fresh copy.

### 4a — Stamp version

Set `_hermit_versions["hermitd-feed"]` to `self_version` from Step 1's preflight.

### 4b — Write the feed config block

Set `config.feed` from the Step 3 answers:

```json
{
  "slots": [
    {"name": "morning", "cron": "<morning cron>", "enabled": <bool>},
    {"name": "evening", "cron": "<evening cron>", "enabled": <bool>}
  ],
  "weekly": {"cron": "<weekly cron>", "enabled": <bool>},
  "tone_preset": "<preset>",
  "enrichments": {"story_arcs": <bool>, "follow_up_cta": <bool>},
  "reaction_feedback": <bool>
}
```

If `config.feed` already exists, merge (keep operator edits; only fill absent keys).

### 4c — Merge routines

In the `routines` array: A row matches a seeded entry when its full skill string (including arguments) or its `id` equals the seeded one's; preserve every field on a matching row. Add a new row only when no row matches, using the crons from Step 3 and `enabled` from the slot/weekly enable answers.

```json
{
  "id": "hermitd-feed:feed-brief-morning",
  "schedule": "<morning cron>",
  "skill": "hermitd-feed:feed-brief --morning",
  "enabled": <morning enabled>
},
{
  "id": "hermitd-feed:feed-brief-evening",
  "schedule": "<evening cron>",
  "skill": "hermitd-feed:feed-brief --evening",
  "enabled": <evening enabled>
},
{
  "id": "hermitd-feed:weekly-digest",
  "schedule": "<weekly cron>",
  "skill": "hermitd-feed:weekly-digest",
  "enabled": <weekly enabled>
}
```

### 4d: Merge the source-scout routine

Merge these entries into `config.routines` by the same matching rule. Create the array if absent. Append each entry with no matching row and leave all other config fields unchanged. No prompt is needed for these read-only analyses.

```json
{"id": "hermitd-feed:source-scout", "schedule": "5 9 1 * *", "skill": "hermitd-feed:source-scout --scheduled", "enabled": true}
```

The monthly routine invokes unattended source discovery directly; candidates remain unverified for operator review.

### 4e — Register the brief archive

Ensure `config.storage_drift` is an object and `config.storage_drift.ignore` is an array. If either is
absent or malformed, normalize it while preserving any valid sibling keys and existing array entries.
Append the bare directory name `"briefs"` when it is absent; if already present, leave the array
unchanged. This registers hermitd-feed's plugin-owned archive without teaching core about a
domain-specific directory.

Write the updated `config.json` using the Write tool (full-file replacement to keep valid JSON).

---

## Step 5 — Knowledge-schema extension

Read `.hermit/knowledge-schema.md`. If the string `brief-summary:` is absent, append under `## Work Products` (create the header if only a stub exists):

```
- brief: a delivered morning/evening brief. Triggered by hermitd-feed:feed-brief-morning/evening routines. location: briefs/YYYY-MM-DD-<slot>.md
- weekly-brief: weekly synthesis over the week's briefs. Triggered by hermitd-feed:weekly-digest routine. location: briefs/weekly/YYYY-WNN.md
- brief-summary: one-line last-brief summary injected at session start. Triggered by feed-brief. location: compiled/brief-summary-last-<YYYY-MM-DD>.md
- story-arcs: developing-story tracker. Triggered by story-arcs skill. location: compiled/story-arcs-<YYYY-MM-DD>.md
- pending-delivery: queued brief awaiting redelivery. Triggered by feed-brief on send failure. location: compiled/pending-delivery.md
```

And under `## Raw Captures` (create if absent):

```
- source-items: raw fetched items from the source-fetcher agent. Feeds feed-brief scoring. Retention: 3 days. location: tmp/feed-source-items-<slot>.json
```

If already present: skip. Use Edit.

---

## Step 6 — Final report

Print a structured summary:

```
hermitd-feed {version} setup complete.

Installation summary:
  ✓ Prerequisite: hermitd {base_version} confirmed
  ✓ Registries: feed-sources.md / feed-categories.md / FEEDS.md seeded (or already present){; starter pack applied if opted in}
  ✓ .gitignore: tmp/ covered
  ✓ config.json: feed block written, _hermit_versions stamped, {K}/3 routines added, hermitd-feed:source-scout routine registered, briefs archive registered in storage_drift.ignore
  ✓ knowledge-schema.md: brief types added (or already present)

Next steps:
  - Add your sources:    /hermitd-feed:add-source   (or edit feed-sources.md directly)
  - Run a brief now:     /hermitd-feed:feed-brief --morning
  - Optional Chrome:     chrome/reddit-home/x sources need a running Chrome; they skip gracefully when it's down.
  - Optional reddit auth: see docs/reddit.md (works unauthenticated by default).

Suggested HEARTBEAT check (add to HEARTBEAT.md if you run heartbeats):
  - If .hermit/compiled/pending-delivery.md exists and is older than 30 min, a brief failed to deliver — retry or alert.

Go always-on (recommended):
  - Docker:     /hermitd:docker-setup
  - Bare tmux:  hermitd start
  Interactive test drive: /hermitd:hermit-routines load

Installed skills:
  /hermitd-feed:feed-brief      — the 7-phase brief pipeline (--morning|--evening|--slot)
  /hermitd-feed:weekly-digest   — weekly synthesis + source performance
  /hermitd-feed:add-source      — add a source (type inference + validation)
  /hermitd-feed:source-scout    — gap-driven source discovery (monthly routine)
  /hermitd-feed:source-health   — dead-source + cost-efficiency audit
  /hermitd-feed:story-arcs      — track developing stories
  /hermitd-feed:deep-dive       — follow-up analysis on a briefed item

Installed subagent:
  @hermitd-feed:source-fetcher  — Haiku web/RSS raw-collection fetcher
```

---

## Docker network requirements

Read by `/hermitd:docker-security` when the operator enables LAN containment + DNS policy. Each entry is surfaced as a per-entry confirmation prompt; nothing here is auto-applied.

### Domains (DNS allowlist)

- Every domain the operator lists in `feed-sources.md` (the fetch targets). Re-run `/docker-security` after adding sources so new domains are allowlisted.
- `reddit.com` and `oauth.reddit.com` — only if any `reddit`-typed source uses the bundled `reddit-fetch.ts`.

### LAN allowlist suggestions

(none — all sources are public cloud endpoints)
