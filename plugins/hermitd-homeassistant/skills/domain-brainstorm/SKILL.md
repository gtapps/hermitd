---
name: domain-brainstorm
description: On-demand HA-voice brainstorm — reads entity inventory, automation/script listings, and operator intent to surface at most 2 capability-gap ideas, each gated by proposal-triage before becoming a PROP. Invoke when the operator asks "what automations am I missing?", "any coverage gaps?", or "brainstorm improvements". Never runs autonomously.
---

# Domain Brainstorm

## Kill criteria (read before running)

After ≥8 invocations, check the `capability-brainstorm` segment of core's proposal metrics: run `.hermit/bin/hermitd-run proposal metrics .hermit --source=capability-brainstorm` (the project-resident `bin/hermitd-run` resolves core's plugin root, which a path relative to this plugin can't reach). When its `status` is `kill`, treat it as a class-level signal that brainstorm output is noisy and raise it with the operator, naming the `kill_reasons` with their `triage_survival_pct` and `acceptance_pct`. The segment is shared with core's `capability-brainstorm` and the other domain brainstorm skills, so it cannot by itself say which skill to cut.

### Gate 0 — Gather inputs

Read these in parallel — all are cheap cached reads plus one lightweight listing. Do not run `ha refresh-context`, fetch individual automation configs in a loop, or actuate any device.

**Entity inventory**
Read `.hermit/raw/snapshot-ha-normalized-latest.json` → `entity_index` (the universe of areas, devices, and domains).
- If absent: stop immediately, emit-zero with reason "no context snapshot — run /hermitd-homeassistant:ha-refresh-context first". The entity universe is the required substrate.
- If mtime > 24h: note "stale snapshot", proceed — the `hermitd-homeassistant:daily-ha-context` and `hermitd-homeassistant:ha-integration-health` routines own scheduled refresh, do not refresh here.

**Automation/script inventory**
Run:
```bash
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-automations
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-scripts
```
These are live REST calls. On error or timeout: do not retry — note "automation inventory unavailable" and continue with cached artifacts only. With no inventory, `[coverage-asymmetry]` and `[unbuilt-intent]` are unsupportable; a degraded run will usually emit-zero.

**Operator intent**
Read the whole `.hermit/OPERATOR.md` and the auto-memory `MEMORY.md` index. Note any stated wants or preferences ("close garage at night", "welcome light when arriving") that no automation name clearly implements.

**Suppression filters** (read to *exclude* ideas — never to source them)
- `.hermit/state/integration-health-degraded-domains.json` — skip any idea whose target entity sits in a degraded domain.
- `.hermit/raw/snapshot-ha-pattern-analysis-latest.json` / `patterns-latest.md` — already-flagged silent/dead items are `ha-analyze-patterns`' territory; do not surface them as capability gaps.

### Gate 1 — Generate ideas (max 2)

Think across all four inputs. For each candidate, both constraints must pass before including it:

1. **Concrete friction** — state the operator pain in one sentence. What is the operator missing today because this automation or script doesn't exist? If no specific pain, discard.
2. **≥2 named grounding items** — cite at least two by name (e.g. `entity:binary_sensor.bedroom_motion`, `area:garage`, `script:bom_dia`, `operator:OPERATOR.md "close garage at night"`, `health:no degraded domains`). These support the friction; friction is the bar.

Map each passing idea to the closest HA capability-gap prefix:
- `[automation-gap]` — a device, sensor, or area present in the entity inventory but wired into zero automations.
- `[coverage-asymmetry]` — a paired-pattern gap (e.g. a `bom_dia` script exists but no `boa_noite`; a motion sensor turns lights on but nothing turns them off).
- `[unbuilt-intent]` — an operator-stated want (OPERATOR.md / auto-memory) that no automation or script name clearly implements.

**Important precision note for `[automation-gap]`:** a precise "wired into zero automations" coverage graph is not cheaply cached (`ha-safety-audit` persists entity references only for violating automations, not all). `[automation-gap]` therefore produces a **candidate** grounded in the alias inventory and entity_index — triage and the operator decision are the backstop. State this candidacy in the Evidence.

Drop any idea whose target entity/domain sits in a degraded integration (suppression filter). Cap at 2 ideas total. Emit-zero if none pass. Record discarded candidates (one line each) for Gate 4.

### Gate 2 — Create proposals

For each idea, invoke `/hermitd:proposal-create` once:

```
Title: [<prefix>] <short idea title>
Evidence Source: capability-brainstorm
Evidence: <one paragraph: friction sentence + named grounding items>
```

Set frontmatter: `source: auto-detected`, `category: improvement`, `tags: [capability-brainstorm]`.

Provenance is carried by those `tags`, which `proposal-create` writes onto both the `triage-verdict` row and the proposal frontmatter. The cost: these proposals share core `capability-brainstorm`'s kill-criteria segment, so the numbers are combined rather than per-skill.

`/hermitd:proposal-create` invokes `proposal-triage` internally. Parse its outcome:
- `CREATE: <title>`: PROP file written, note the assigned PROP-NNN.
- `SUPPRESS: <title> — <code>`: record the suppression code. Don't retry.
- `DUPLICATE: <title> — <PROP-ID>`: record the existing PROP-ID. Don't create.

Do NOT invoke `proposal-triage` directly — `/proposal-create` handles it.

### Gate 3 — Emit batch message

Send one message per the Operator Notification protocol. Use the session language for all user-facing text.

Zero-emit:
```
🏠 Domain brainstorm — 0 ideas emitted (<reason: thin context | automation inventory unavailable | all suppressed | all duplicates | stale snapshot>)
```

Non-zero:
```
🏠 Domain brainstorm (<N> idea(s))

1. **[prefix] <title>** — <one-line description>
   _Grounding: <item 1>, <item 2>_
   _Friction: <one-sentence pain>_
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

Body (150-line cap): ideas that passed (one paragraph each), discarded candidates (one line each), triage verdicts, inputs scanned (paths only, no content), note if inventory was degraded.

Do not tag `foundational` — this is a time-bounded ideation snapshot.

**Zero-emit runs:** skip the artifact entirely. Inside an open record's turn, pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>`; otherwise skip the note:
`domain-brainstorm: 0 ideas emitted (<reason>)`
