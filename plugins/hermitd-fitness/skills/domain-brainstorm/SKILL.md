---
name: domain-brainstorm
description: On-demand fitness-voice brainstorm — reads Strava history and training-goal signals to surface at most 2 coverage-gap or imbalance ideas, each gated by proposal-triage before becoming a PROP. Invoke when the operator asks "what am I neglecting?", "anything off with my training?", or "brainstorm training gaps". Never runs autonomously.
---

# Domain Brainstorm

## Kill criteria (read before running)

After ≥8 invocations, check the `capability-brainstorm` segment of core's proposal metrics: run `.hermit/bin/hermitd-run proposal metrics .hermit --source=capability-brainstorm` (the project-resident `bin/hermitd-run` resolves core's plugin root, which a path relative to this plugin can't reach). When its `status` is `kill`, treat it as a class-level signal that brainstorm output is noisy and raise it with the operator, naming the `kill_reasons` with their `triage_survival_pct` and `acceptance_pct`. The segment is shared with core's `capability-brainstorm` and the other domain brainstorm skills, so it cannot by itself say which skill to cut.

### Gate 0 — Gather inputs

Start with the connection check; then read the remaining sources in parallel. Do not run tests or install tools.

**Connection check**
Call `mcp__strava__check-strava-connection`. If disconnected, stop immediately:
```
Domain brainstorm aborted — Strava disconnected. Reconnect and retry.
```

**Stated goals**
Read `MEMORY.md` (the index). For each entry whose title or description suggests goals, training preferences, or athlete profile, read that topic file. Extract stated goals and named disciplines (e.g. "marathon training", "strength 2×/week", "sleep 8h target"). If no goals are parseable from MEMORY.md, derive implicit goals from the Strava activity mix gathered below — note in every grounding citation that the goal is inferred, not stated.

**What's been logged**
Delegate bulk aggregation to `@hermitd-fitness:strava-data-cruncher`:
```
Last 8 weeks of activities. Return: per-week count + total minutes by sport/activity type. Flag any sport with zero sessions in the last 4 weeks.
```
This keeps heavy multi-page fetching off the main context and respects rate limits.

**Logged subjective and coverage signals**
Glob `.hermit/compiled/activity-*.md` and any `.hermit/compiled/weekly-*.md` files modified within the last 30 days — read the first 15 lines of each (frontmatter + opening paragraph). Read `state/activity-notes.json` to check which signal dimensions (RPE, sleep, macros) actually have entries vs gaps.

### Gate 1 — Generate ideas (max 2)

Think across all inputs simultaneously. For each candidate, both constraints must pass before including it:

1. **Concrete gap** — state the coverage or imbalance in one sentence: what goal or discipline has no recent supporting data, or what mix is visibly wrong vs stated goals? If no specific gap can be named, discard.
2. **≥2 named grounding items** — cite at least two by name (e.g. `memory:athlete-profile`, `strava:8wk strength=0sessions`, `notes:sleep last=21d ago`, `compiled:activity-2026-05-12`). These support the gap; the gap is the bar.

Map each passing idea to the closest fitness prefix:
- `[goal-gap]` — a stated or inferred goal with no recent supporting data. Covers: a discipline not logged in N weeks, sleep or macro dimensions the operator tracks but hasn't entered recently, a race/event goal with no recent specificity work.
- `[imbalance]` — training mix wrong vs stated or inferred goals. Covers: cardio/strength ratio skew, the same workout type repeated across multiple weeks with no progression toward a stated goal.

**Scoping guard:** never emit ideas about cardiac-drift trends, HR/pace efficiency slope, recovery-score trends, or week-over-week load changes — those signals are owned by `weekly-coaching-patterns` and `activity-deep-dive`. This skill emits coverage and imbalance gaps only.

Cap at 2 ideas. Emit-zero if none pass. Record discarded candidates (one line each) for Gate 4.

### Gate 2 — Create proposals

For each idea, invoke `/hermitd:proposal-create` once:

```
Title: [<prefix>] <short idea title>
Evidence Source: capability-brainstorm
Evidence: <one paragraph: gap sentence + named grounding items>
```

`Evidence Source: capability-brainstorm` is intentional, not a copy-paste: it is the recurrence-bypass token recognized by `proposal-create`'s three-condition rule (a brainstorm pass establishes the candidate, so condition 1 is waived). There is no separate `domain-brainstorm` token. Provenance is carried by the `tags` below, which `proposal-create` writes onto both the `triage-verdict` row and the proposal frontmatter. The cost: these proposals share core `capability-brainstorm`'s kill-criteria segment, so the numbers are combined rather than per-skill.

Set frontmatter: `source: auto-detected`, `category: improvement`, `tags: [capability-brainstorm]`.

Parse the outcome `/hermitd:proposal-create` returns:
- `CREATE: <title>`: PROP file written, note the assigned PROP-NNN.
- `SUPPRESS: <title> — <code>`: record the suppression code. Don't retry.
- `DUPLICATE: <title> — <PROP-ID>`: record the existing PROP-ID. Don't create.

Do NOT invoke `proposal-triage` directly — `/hermitd:proposal-create` handles it.

### Gate 3 — Emit batch message

Send one message per the Operator Notification protocol.

Zero-emit:
```
🏋️ Domain brainstorm — 0 ideas emitted (<reason: thin context | all suppressed | all duplicates>)
```

Non-zero:
```
🏋️ Domain brainstorm (<N> idea(s))

1. **[prefix] <title>** — <one-line description>
   _Grounding: <item 1>, <item 2>_
   _Gap: <one-sentence friction>_
   PROP-NNN created  ·  (or: suppressed — <code>  ·  or: duplicate of PROP-NNN)
```

### Gate 4 — Compiled artifact (non-empty runs only)

If ≥1 PROP was created (not suppressed or duplicate), write:

`.hermit/compiled/domain-brainstorm-YYYY-MM-DD-HHMM.md`

```yaml
---
title: Domain brainstorm — <ISO timestamp>
type: domain-brainstorm
created: <ISO timestamp with timezone>
tags: [domain-brainstorm, ideation]
source: interactive
proposals_created: [PROP-NNN, ...]
---
```

Body (150-line cap): ideas that passed (one paragraph each), discarded candidates (one line each), triage verdicts, inputs scanned (paths only, no content).

Do not tag `foundational` — this is a time-bounded ideation snapshot.

**Zero-emit runs:** skip the artifact entirely. Inside an open record's turn, pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>`; otherwise skip the note:
`domain-brainstorm: 0 ideas emitted (<reason>)`
