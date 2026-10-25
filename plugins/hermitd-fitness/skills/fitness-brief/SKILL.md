---
name: fitness-brief
description: Composes and delivers the daily fitness brief — a forward-looking morning read (readiness + today's plan) or a backward-looking evening read (today's training, or an earned-rest note, + tomorrow's setup) — in the operator's configured voice. Invoke with /hermitd-fitness:fitness-brief --morning|--evening|--slot <name>. Becomes the plugin's two daily beats — the morning Strava connectivity check and the evening activity sync, RPE binding, and Run deep-dive.
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(bun *fitness-lab.ts*)
  - mcp__strava__check-strava-connection
  - mcp__strava__get-recent-activities
---

# Fitness Brief

One skill, two lenses on the same athlete's training state. Composition is intent-driven,
not scripted: gather a bounded digest, then write the brief toward the goal below in the
operator's configured voice — there is no fixed section order, no hardcoded tone, and no
mandatory rest-day copy.

## Flags

- `--morning`: slot `morning`. Forward-looking.
- `--evening`: slot `evening`. Backward-looking.
- `--slot <name>`: custom slot label; orientation defaults to forward-looking unless the
  operator's own conventions say otherwise.

Resolve `<slot>` from the flag before starting. Filenames below use that resolved value.
Steps below say "Morning"/"Evening" as shorthand for forward-looking/backward-looking
orientation — a custom `--slot` follows whichever branch matches its resolved orientation.

## Steps

1. **Connectivity + sync mechanics.** These fold in what `strava-health-check` and
   `strava-sync` used to run on their own crons — this brief now owns that beat.
   - Call `mcp__strava__check-strava-connection`. If disconnected: say so plainly in the
     brief and skip the data-dependent parts below rather than fabricating figures.
   - **Evening only:** call `mcp__strava__get-recent-activities` (`perPage: 5`), compare
     against `state/strava-last-activity-id.txt` (treat missing as "none"), and for any
     new activity whose Strava `type` is `Run`, invoke
     `/hermitd-fitness:activity-deep-dive <id>` (cap 3; inside an open record's turn, pipe skipped IDs into
     `.hermit/bin/hermitd-run task note .hermit <task-id>`, otherwise skip the note). Advance the cursor file to the highest new ID.
     Hold the newest new activity's id/name/sport for step 4 — do **not** write
     `state/strava-pending-rpe.json` here. That file's writer contract (see `${CLAUDE_PLUGIN_ROOT}/docs/knowledge-schema.md`) is
     write-only-after-confirmed-delivery, precisely so a failed or push-only send can't bind
     a future RPE reply to an activity the operator was never actually told about.

2. **Gather (bounded).** Raw Strava streams must never enter context — `fitness-lab.ts`
   reduces them first.
   - **Morning:** `bun ${CLAUDE_PLUGIN_ROOT}/scripts/fitness-lab.ts weekly-load` — a
     rolling per-week load digest (km, moving time, zone %, `tss_proxy`). Read
     `state/strava-weekly-baselines.json` if present for trend context.
   - **Evening:** if a new activity was found in step 1 **and it was not a `Run`** (step 1
     only deep-dives Run activities), `bun ${CLAUDE_PLUGIN_ROOT}/scripts/fitness-lab.ts
     analyze <the non-Run activity's id from step 1>` for today's session — pass the id
     explicitly, not `latest`: `latest` resolves the globally most-recent Strava activity,
     which on a mixed-type day (a Run uploaded after the non-Run) would analyze the wrong
     session. If the new activity *was* a `Run`, step 1's
     `activity-deep-dive` call already ran this same analysis and wrote
     `compiled/activity-<id>-<date>.md` — read that artifact instead of re-running the
     analysis, which would redo the same Strava fetch and computation. Either way,
     also read whatever `state/activity-notes.json` already holds for it. No new activity
     is itself the input — there's nothing to analyze.

   Handle the script's error contract as `activity-deep-dive` does: `{"error":"strava_auth:<message>"}`
   or `{"error":"fetch:<message>"}` (both exit 1) → relay the `<message>` to the operator and stop
   gathering further data; compose from whatever was already gathered.

3. **Compose.** You have the digest from steps 1–2, the operator's voice (`agent_name`,
   `voice`, `operator_profile`, `language` in `config.json` — the same voice every other
   channel message uses), and the goal below. Write toward the goal; there is no required
   template.
   - **Morning goal:** give the operator what's worth knowing and doing today — recent
     load/trend, anything worth flagging, a plan or nudge for today.
   - **Evening goal:** reflect on what today's training meant. On a day with nothing
     logged, the rest itself is the information — an earned-recovery day reads very
     differently from a third silent day in a row; use judgment, don't force a script.
     Set up tomorrow. If step 1 captured a new activity, invite an RPE reply.
   - The single most recent prior brief lives in `compiled/brief-fitness-morning-<date>.md` /
     `compiled/brief-fitness-evening-<date>.md` if continuity would genuinely add something —
     reading just that one file is optional judgment, not a required step. These briefs
     accumulate daily with no retention cap (per `${CLAUDE_PLUGIN_ROOT}/docs/knowledge-schema.md`), so never
     glob-read the whole `brief-fitness-*.md` set.

4. **Deliver** per the Operator Notification protocol (core resolves the
   channel and falls back to push when no channel is reachable). Routines can fire while the terminal is unmonitored.
   Push-fallback: a single line per § Operator Notification push format, leading with
   the thing most worth knowing.
   - **Evening only, after a confirmed successful channel send** (not a push fallback, not
     a logged-only send): write `state/strava-pending-rpe.json` with the activity held
     from step 1:
     ```json
     {"activity_id": <id>, "name": "<name>", "sport": "<Run|Ride|WeightTraining|…>", "synced_at": "<ISO 8601>"}
     ```
     so a channel RPE reply binds correctly (`capture-activity-rpe` reads and deletes it) —
     the same write-after-confirmed-send guard documented in `${CLAUDE_PLUGIN_ROOT}/docs/knowledge-schema.md`.

5. **Archive.** Write `.hermit/compiled/brief-fitness-<slot>-<date>.md`:
   ```yaml
   ---
   title: "<Morning|Evening> Brief — <YYYY-MM-DD>"
   type: brief
   created: <ISO 8601 with offset>
   task: <T-... for the open record in this turn; omit this field otherwise>
   tags: [<slot>-brief, fitness]
   ---
   ```
   Body: the brief as delivered. Inside an open record's turn, pipe the artifact citation
   `[[compiled/brief-fitness-<slot>-<date>]]` into `.hermit/bin/hermitd-run task note .hermit <task-id>`. Otherwise skip the note.

## Security

Never include Strava tokens, credentials, or raw athlete IDs in the brief or its archive.
