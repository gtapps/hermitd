---
name: activity-deep-dive
description: Per-activity coaching analysis from Strava. Detects interval vs steady-state sessions and road vs trail terrain, branching the metrics accordingly. Computes zone breakdown and recovery estimate; saves a compiled artifact and returns a compact summary. Run after a workout or to retro-analyze a specific activity.
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(bun *fitness-lab.ts*)
---

# Activity Deep-Dive

Produces a standardised per-activity coaching note. All deterministic statistics (session-kind detection, terrain, zones, cadence, efficiency, cardiac drift, VAM/GAP, recovery estimate) are computed by `scripts/fitness-lab.ts` — this skill runs it once, interprets the JSON, and writes the coaching narrative. Raw Strava streams never enter context: the script fetches and reduces them; the skill only sees the reduced metrics.

Interval sessions get work-interval HR progression and between-bout recovery quality; steady sessions get pace/HR efficiency and cardiac drift. Trail sessions swap pace/HR efficiency for VAM and a grade-adjusted-pace estimate, reframe cardiac drift against the altitude profile, and extend the recovery window for descent load. Both get zone breakdown, recovery estimate, and a coaching note. Saves a compiled artifact and returns a compact summary.

## Usage

```
/hermitd-fitness:activity-deep-dive <activity-id>
/hermitd-fitness:activity-deep-dive latest
```

## Steps

1. **Resolve subjective RPE.** Read `.hermit/state/activity-notes.json`. If it exists and has an entry for the resolved activity ID (or, for `latest`, hold the check until step 2 returns the ID), keep `rpe` and `notes` for the output template and artifact frontmatter. The script does NOT read RPE — this is the skill's job.

2. **Run the analysis script.** Issue a single Bash call:

   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/fitness-lab.ts analyze <activity-id|latest>
   ```

   The script fetches details, laps, streams, athlete zones, and the recent summary activities (for the efficiency baseline), then emits one JSON object. Handle the error contract:
   - `{"error":"strava_auth:<message>"}` (exit 1) → the token is missing or expired. Relay `<message>` verbatim to the operator and stop. Do not compute anything.
   - Any other `{"error":"<token>:<detail>"}` (exit 1, e.g. `fetch` or `invalid_activity_id`) → report it and stop.
   - Success (exit 0) → parse the JSON and continue.

3. **Interpret the JSON.** The object has these fields (see `thresholds` in the payload for the exact cutoffs behind each classification — cite them in coaching prose without hardcoding a second copy):

   - `meta` — `name, date, sport_type, distance_km, moving_time_s, avg_hr, max_hr, total_elevation_gain_m, elev_gain_per_km`.
   - `session_kind` — `"interval"` or `"steady"`. `session_detail` carries `cycles`, `differential_bpm`, `work_bouts`, `avg_bout_min` for the `Interval (N×~Xmin)` header, plus `work_segment_hrs` — the ordered per-work-bout average HR (from laps when there were ≥3, else from the HR-stream windows the classifier used). This is the authoritative source for the `I1 → IN` progression, so it renders even on lap-sparse activities.
   - `terrain` — `"road"` or `"trail"`.
   - `zones` — `[{zone, pct}]` (Z1–Z5), or `null` when HR/zone data is absent (render "HR data unavailable").
   - `cadence` — `{avg, sd, cv, flags}` or `null`. `flags` is `["over-striding"]` and/or `["high-variability"]`; it is empty on trail (road-calibrated thresholds are suppressed). Omit the cadence line entirely when `null`.
   - `efficiency` — `{current, prior_mean, delta_pct, priors_used}`. Cite on **steady + road** only. `delta_pct` is the signed % vs the prior mean (negative = more efficient). Skip the line when `priors_used` is 0.
   - `cardiac_drift_bpm` / `cardiac_drift_flagged` — signed int (rising HR = positive), and whether it cleared the flag threshold. Cite on **steady** sessions only — on an interval session the first-20%/last-20% split straddles work and recovery bouts, so the figure is noise; skip the drift line. `null` on trail (use the `hr_altitude` field instead — see below). `flagged` is already pace-guarded (a negative split won't trip it), so relay it as-is.
   - `hr_altitude` — trail only (`null` on road, and `null` on trail when HR/altitude streams are too short or flat to correlate). `{corr, tracks}`: `corr` is the Pearson r of HR vs altitude (rounded); `tracks` is `"tracks"` (r ≥ 0.3 — HR broadly rose on climbs / fell on descents, expected) or `"decoupled"` (HR did not follow the terrain — worth flagging). Render the `HR/altitude:` line from this; when `null`, state the coupling couldn't be assessed rather than inventing one.
   - `vam` (m/h) and `gap_per_km` (seconds/km) — trail only; `null` on road. Render GAP as `M:SS/km`.
   - `laps` — `[{index, avg_hr, max_hr, distance_km, moving_time_s}]`. For **interval** sessions, build the `I1 → IN` progression from `session_detail.work_segment_hrs` (above), not the raw laps — it already sequences the work bouts whether laps or HR-windows fed the classifier. Use `laps` (and `meta.max_hr` as HRmax, never a zone floor) for the between-bout recovery note and the peak-bout callout; when `laps` is empty, ground those from the progression alone.
   - `recovery` — `{band, hours, window, trail_extended}`. `band` is 1–5; `window` is the rendered rest recommendation (already includes any `(+trail vert)` extension).
   - `warnings` — degraded-metric notes (short/absent streams). Surface anything material in the coaching note rather than silently dropping it.

4. **Write the coaching note** — 2–3 sentences grounded in the numbers. Highlight what was executed well and one concrete thing to monitor or adjust next time. Reference specific metrics (e.g. "cardiac drift of +14 bpm suggests pacing started too hot").

5. Format output (8–10 lines):

   **Steady session (road):**
   ```
   Activity: <name> | <date> | <distance>km in <duration>
   Session type: Steady
   Zones: Z1 N% / Z2 N% / Z3 N% / Z4 N% / Z5 N%
   Cadence: N spm avg (CV: X%) [⚠ over-striding | ⚠ high variability]   ← omit line when cadence absent or non-running; show ⚠ only on a tripped flag
   Pace/HR efficiency: X.XX min·km⁻¹·bpm⁻¹ (vs prior 4: ±X%)
   Cardiac drift: +N bpm (flag if > 10 bpm)
   Recovery: N/5 — recommended rest: Xh
   Subjective: RPE N/10 — <notes>          ← include only when RPE data exists from step 1
   Coaching: <2–3 sentences>
   ```

   **Steady session (trail):**
   ```
   Activity: <name> | <date> | <distance>km in <duration> | <elevation>m gain
   Session type: Steady · Trail
   Zones: Z1 N% / Z2 N% / Z3 N% / Z4 N% / Z5 N%
   Cadence: N spm avg (CV: X%)   ← reference only on trail (no ⚠ flags); omit line when cadence absent or non-running
   Trail: VAM N m/h | GAP ~M:SS/km (est, vs actual P:SS/km)
   HR/altitude: HR <tracked / decoupled from> the climb/descent profile (r=X.XX)   ← from hr_altitude; if null, "coupling not assessable (stream too short)"
   Recovery: N/5 — recommended rest: Xh[(+trail vert)]
   Subjective: RPE N/10 — <notes>          ← include only when RPE data exists from step 1
   Coaching: <2–3 sentences>
   ```

   **Interval session (road):**
   ```
   Activity: <name> | <date> | <distance>km in <duration>
   Session type: Interval (N×~Xmin)
   Zones: Z1 N% / Z2 N% / Z3 N% / Z4 N% / Z5 N%
   Cadence: N spm avg (CV: X%) [⚠ over-striding | ⚠ high variability]   ← omit line when cadence absent or non-running; show ⚠ only on a tripped flag
   Intervals: I1 NNNbpm → IN NNNbpm — <progressive ✓ / regressive / flat>; peaked at NNNbpm on IN
   Between-bout recovery: HR to ~NNNbpm — <adequate / incomplete>
   Recovery: N/5 — recommended rest: Xh
   Subjective: RPE N/10 — <notes>          ← include only when RPE data exists from step 1
   Coaching: <2–3 sentences>
   ```

   **Interval session (trail):**
   ```
   Activity: <name> | <date> | <distance>km in <duration> | <elevation>m gain
   Session type: Interval (N×~Xmin) · Trail
   Zones: Z1 N% / Z2 N% / Z3 N% / Z4 N% / Z5 N%
   Cadence: N spm avg (CV: X%)   ← reference only on trail (no ⚠ flags); omit line when cadence absent or non-running
   Trail: VAM N m/h | GAP ~M:SS/km (est, vs actual P:SS/km)
   Intervals: I1 NNNbpm → IN NNNbpm — <progressive ✓ / regressive / flat>; peaked at NNNbpm on IN
   Between-bout recovery: HR to ~NNNbpm — <adequate / incomplete>
   Recovery: N/5 — recommended rest: Xh[(+trail vert)]
   Subjective: RPE N/10 — <notes>          ← include only when RPE data exists from step 1
   Coaching: <2–3 sentences>
   ```

6. Save compiled artifact to `.hermit/compiled/activity-<id>-<YYYY-MM-DD>.md`:
```yaml
---
title: "Activity Note — <name> <date>"
type: activity-note
created: <ISO 8601>
task: <T-... for the open record in this turn; omit this field otherwise>
source: manual
tags: [activity-analysis]
activity_id: <id>
sport_type: <Run|TrailRun|Ride|WeightTraining|…>
terrain: <road|trail>
session_kind: <interval|steady>
rpe: <int>                               # include only when RPE data exists from step 1
subjective_notes: "<string>"             # include only when notes exist from step 1
cardiac_drift_bpm: <int>                 # include only when drift was computed from step 3
cardiac_drift_flagged: <bool>            # include only when drift was computed from step 3
---
```
Body: the full output above.

**CRITICAL — `cardiac_drift_bpm` must be a bare signed integer** (`6`, `-5`), not a formatted value like `+6 bpm`. `weekly-coaching-patterns` reads this field to build its trend series; renaming the key or writing a non-numeric value breaks the trend detector. It falls back to parsing the body's `Cardiac drift:` line only for notes written before this field existed.

7. Inside an open record's turn, pipe signal-only coaching observations into `.hermit/bin/hermitd-run task note .hermit <task-id>`. Otherwise skip this step.

   From the computed metrics and coaching note, derive 0–N observations that carry a coaching signal worth tracking across sessions: a flagged cardiac drift, a zone-distribution anomaly, a recovery estimate that conflicts with subjective RPE, an efficiency regression vs the prior mean, a flagged cadence (low average or high within-run variability), a notable VAM value, or a trail recovery extension. Do NOT write routine confirmations ("session completed normally") unless they represent a pattern break. If nothing clears the signal bar, skip this step.

   Read only the current record at `.hermit/tasks/<task-id>.md` to deduplicate; writes go through the note command. For each qualifying observation, pipe one line through the note command:

   ```
   Coaching observation [<label>] (activity <id>): <one-line description grounded in a specific metric>
   ```

   Skip a line with the same `[<label>] (activity <id>)` already in the record; rerunning the deep-dive must not duplicate observations.

   Labels are kebab-case and reused across sessions for consistency. Prefer an existing label over inventing a synonym. Seed vocabulary: `cooldown-hr-elevated`, `vo2max-stimulus-confirmed`, `cardiac-drift-high`, `interval-pacing-inconsistent`, `recovery-insufficient`, `efficiency-regression`, `cadence-low`, `cadence-variability-high`, `trail-recovery-extended`, `vam-notable`. Add a new kebab-case label only when none fit.

   These lines provide task-record evidence; the label convention lets reflect recognize recurrence across records, and recurring observations graduate to proposals through the normal `reflection-judge` / `proposal-triage` gates.

8. Return the formatted output to the caller.
