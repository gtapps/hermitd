---
name: set-rpe
description: Manually record RPE and subjective notes for a specific Strava activity. Use for backfilling, correcting entries, or rating a non-latest activity that the auto-capture skill skipped.
allowed-tools:
  - Bash(bun *fitness-lab.ts*)
---

# Set RPE

Records perceived effort and subjective notes for any Strava activity. Thin wrapper over `scripts/fitness-lab.ts rpe`, which validates the RPE, resolves `latest` if needed, and does the atomic upsert into `state/activity-notes.json`.

## Usage

```
/hermitd-fitness:set-rpe <activity-id|latest> <rpe> [notes...]
```

## Steps

1. Parse arguments:
   - First arg: activity ID (integer) or the literal string `latest`.
   - Second arg: RPE (must be an integer 1–10).
   - Remaining args: optional free-text notes.
   - If any required arg is missing, respond with the usage line and stop (the script also rejects an out-of-range RPE with a `usage` error and exit 1).

2. Run the script:

   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/fitness-lab.ts rpe <activity-id|latest> <rpe> [notes...]
   ```

   The script writes `{rpe, notes, recorded_at}` keyed by activity ID (`notes` is `null` when none were provided) and emits `{activity_id, written:true, previous:{…}|null}`. On `{"error":"strava_auth:<message>"}` (only reachable via `latest`, which resolves the ID from Strava) relay `<message>` verbatim; on any other `{"error":…}` report it and stop.

3. Confirm from the returned JSON:
   - If `previous` is `null`: `"Saved RPE <rpe>/10 for activity <activity_id>."`
   - If `previous` is present: `"Updated RPE for activity <activity_id>. (was: RPE <previous.rpe>/10 — <previous.notes>)"`
