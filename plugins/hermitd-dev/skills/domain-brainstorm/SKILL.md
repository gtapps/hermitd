---
name: domain-brainstorm
description: On-demand dev-voice brainstorm: reads codebase friction signals (git churn, manifest drift, README coverage) and emits at most 2 improvement ideas, each gated by proposal-triage before becoming a PROP. Invoke when the operator asks "what should I be fixing?", "anything wrong with X?", or "brainstorm improvements". Never runs autonomously.
---

# Domain Brainstorm

## Kill criteria (read before running)

After ≥8 invocations, check the `capability-brainstorm` segment of core's proposal metrics: run `.hermit/bin/hermitd-run proposal metrics .hermit --source=capability-brainstorm` (the project-resident `bin/hermitd-run` resolves core's plugin root, which a path relative to this plugin can't reach). When its `status` is `kill`, treat it as a class-level signal that brainstorm output is noisy and raise it with the operator, naming the `kill_reasons` with their `triage_survival_pct` and `acceptance_pct`. The segment is shared with core's `capability-brainstorm` and the other domain brainstorm skills, so it cannot by itself say which skill to cut.

### Gate 0 — Gather inputs

Read these in parallel — all are cheap working-tree reads. Do not run the test suite or install tools.

**Git activity**
```bash
git log --oneline -50
git log --format= --name-only -50 | sort | uniq -c | sort -rn | head -20
```
Note the 5 most-churned files and any subsystem clusters.

**Manifest drift**
`ls` for `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`. For each found, check its lockfile (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `go.sum`) exists alongside it. Flag any mismatch.

**README coverage**
Read `README.md` and a one-level `ls` of the repo root. Note features or modules claimed in the README with no corresponding directory or file visible.

### Gate 1 — Generate ideas (max 2)

Think across all three inputs. For each candidate, both constraints must pass before including it:

1. **Concrete friction** — state the operator pain in one sentence. What breaks, slows, or misleads today without this fix? If no specific pain, discard.
2. **≥2 named grounding items**: cite at least two by name (e.g. `git:cli/index.js`, `file:package-lock.json missing`, `readme:§Feature X`). These support the friction; friction is the bar.

Map each passing idea to the closest dev prefix: `[missing-tests]`, `[tech-debt]`, `[dependency]`, `[tooling]`, or `[architecture]`.

Cap at 2 ideas. Emit-zero if none pass. Record discarded candidates (one line each) for Gate 4.

### Gate 2 — Create proposals

For each idea, invoke `/hermitd:proposal-create` once:

```
Title: [<prefix>] <short idea title>
Evidence Source: capability-brainstorm
Evidence: <one paragraph: friction sentence + named grounding items>
```

Set frontmatter: `source: auto-detected`, `category: improvement`, `tags: [capability-brainstorm]`.

> `Evidence Source: capability-brainstorm` is reused intentionally: it is the only source `proposal-triage` recognizes for the single-pass recurrence bypass, and adding a dedicated `domain-brainstorm` source is a core edit this skill deliberately avoids. Provenance is carried by the `tags` above, which `proposal-create` writes onto both the `triage-verdict` row and the proposal frontmatter. The cost: these proposals share core `capability-brainstorm`'s kill-criteria segment, so the numbers are combined rather than per-skill.

Parse the verdict:
- `CREATE: <title>`: PROP file written, note the assigned PROP-NNN.
- `SUPPRESS: <title> — <code>`: record the suppression code. Don't retry.
- `DUPLICATE: <title> — <PROP-ID>`: record the existing PROP-ID. Don't create.

Do NOT invoke `proposal-triage` directly — `/proposal-create` handles it.

### Gate 3 — Emit batch message

Send one message per the Operator Notification protocol.

Zero-emit:
```
🔧 Domain brainstorm — 0 ideas emitted (<reason: thin context | all suppressed | all duplicates>)
```

Non-zero:
```
🔧 Domain brainstorm (<N> idea(s))

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

Body (150-line cap): ideas that passed (one paragraph each), discarded candidates (one line each), triage verdicts, inputs scanned (paths only, no content).

Do not tag `foundational` — this is a time-bounded ideation snapshot.

**Zero-emit runs:** skip the artifact entirely. Inside an open record's turn, pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>`; otherwise skip the note:
`domain-brainstorm: 0 ideas emitted (<reason>)`
