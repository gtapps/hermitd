# Knowledge Schema

What this plugin writes to `.hermit/raw/` and `.hermit/compiled/`, and when.

For the canonical four-bucket convention (`raw/`, `compiled/`, `state/`, `proposals/`) and general frontmatter requirements, see `docs/artifact-naming.md` in `hermitd`.

## Frontmatter

Markdown artifacts use these fields in order. Include `task` only when the skill runs inside an open record's turn; omit it otherwise:

```yaml
title: <human-readable title>
type: <see tables below>
created: <ISO 8601 with offset, e.g. 2026-04-25T09:00:00+00:00>
task: <T-... for the open record in this turn; omit this field otherwise>
tags: [<comma-separated list>]
```

JSON artifacts do not carry frontmatter.

## raw/

Ephemeral Strava data pulls. Aged out per `knowledge.raw_retention_days`.

| Filename pattern | type | Produced by | When | Retention |
|---|---|---|---|---|
| `activity-fetch-<date>.json` | `activity-fetch` | weekly-load-review, monday-planning | Each data pull | 3 days |
| `activity-streams-<id>-<date>.json` | `activity-streams` | activity-deep-dive, recovery assessment | Each streams fetch | 7 days |

## compiled/

Durable outputs. Injected into session context at startup within `compiled_budget_chars`.

| Filename pattern | type | foundational | Produced by | When |
|---|---|---|---|---|
| `brief-morning-<date>.md` | `brief` | no | fitness-brief skill (`--morning`) | Daily, morning-brief routine |
| `brief-evening-<date>.md` | `brief` | no | fitness-brief skill (`--evening`) | Daily, evening-brief routine |
| `weekly-plan-<date>.md` | `weekly-plan` | no | monday-planning routine | Monday 09:30 |
| `weekly-summary-<date>.md` | `weekly-summary` | no | weekly-load-review routine | Sunday 18:00 |
| `recovery-assessment-<date>.md` | `recovery-assessment` | no | Operator request or evening-brief flag | On demand |
| `fitness-snapshot-<date>.md` | `fitness-snapshot` | yes | Operator request | On demand |
| `activity-<id>-<date>.md` | `activity-note` | no | activity-deep-dive skill | After each analyzed workout |
| `domain-brainstorm-<YYYY-MM-DD-HHMM>.md` | `domain-brainstorm` | no | domain-brainstorm skill | Operator request, only when a proposal was created |

## state/

Machine-written state files produced by routines. Not compiled artifacts — not loaded into session context.

| File | Written by | Read by | Retention |
|---|---|---|---|
| `strava-last-activity-id.txt` | fitness-brief skill (evening) | fitness-brief skill (evening, dedup cursor) | permanent |
| `strava-weekly-baselines.json` | weekly-load-review routine | monday-planning routine | rolling 8 weeks |
| `activity-notes.json` | capture-activity-rpe skill, set-rpe skill | activity-deep-dive skill, weekly-load-review routine | permanent |
| `strava-pending-rpe.json` | fitness-brief skill (evening, after successful send) | capture-activity-rpe skill (deleted on success) | 24h TTL (freshness-gated, not pruned) |

### activity-notes.json shape

Keyed by Strava activity ID. The `notes` field is always present: `null` when no notes were captured, never a missing key. Readers (`activity-deep-dive`, `weekly-load-review`) can rely on this invariant.

```json
{
  "<activity_id>": {
    "rpe": <int 1-10>,
    "notes": <string|null>,
    "recorded_at": "<ISO 8601 with offset>"
  }
}
```

### strava-pending-rpe.json shape

Single record overwritten on each successful `fitness-brief` evening channel send.

```json
{
  "activity_id": <int>,
  "name": "<string>",
  "sport": "<Run|Ride|WeightTraining|…>",
  "synced_at": "<ISO 8601 with offset>"
}
```

## Retention

- `activity-fetch`: 3 days (superseded by next sync)
- `activity-streams`: 7 days
- Default for other raw types: 14 days (`config.json knowledge.raw_retention_days`)

## Notes

- `fitness-snapshot` is marked `foundational: true` — loaded at every session start regardless of age. The operator may clear old ones manually.
- `activity-note` artifacts accumulate over time; the operator may consider retiring old ones to `raw/.archive/`.
- JSON artifacts (`activity-fetch-*.json`, `activity-streams-*.json`) do not carry frontmatter — they are raw API responses.
