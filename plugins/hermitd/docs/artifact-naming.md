# Artifact Naming Convention

Reference for anyone adding a new domain, skill, or script that writes files into a
hermitd install. Covers the full four-bucket layout (`raw/`, `compiled/`, `state/`,
`proposals/`) so contributors know which bucket a new artifact belongs in and how to
name it.

For the raw-vs-compiled philosophy and plugin-hermit compliance rules, see
[Plugin Hermit Storage](plugin-hermit-storage.md) — this doc complements it rather
than repeating it.

## The four buckets

| Bucket | Purpose | Session-injected? | GC'd? |
|---|---|---|---|
| `raw/` | Ephemeral domain inputs (snapshots, fetches, logs) | No | Yes — `archive-raw.ts` on `knowledge.raw_retention_days` |
| `compiled/` | Durable domain outputs (briefings, digests, audits) | Yes, at session start | No — lives forever unless manually removed |
| `state/` | Runtime ledgers for hooks and skills to coordinate | No | No |
| `proposals/` | Operator-actionable improvement suggestions | No | No |

Mixing these up — putting a runtime ledger in `raw/`, or a domain snapshot in `state/` —
breaks readers that assume bucket semantics (session injection, retention sweep,
validators). Pick the bucket first; name second.

## raw/ — domain inputs

- **Layout:** flat. No subdirectories (except the automatic `raw/.archive/`).
- **Naming:** `<type>-<slug>-<YYYY-MM-DD>.md` (lowercase type, hyphenated date).
- **Required frontmatter:** `title:`, `type:`, `created:` (ISO timestamp), `tags: [...]`.
- **Retention:** archived after `knowledge.raw_retention_days` (default 14) via
  `scripts/archive-raw.ts`. Retained past TTL if any file in `compiled/` mentions the
  filename — the archive sweep honors cross-references.
- **Example:** `raw/snapshot-home-2026-04-17.md`

See `docs/plugin-hermit-storage.md` for the full contract and the compliant-vs-non-
compliant path table.

## compiled/ — durable domain outputs

- **Layout:** flat.
- **Naming:** `<type>-<slug>-<YYYY-MM-DD>.md`. Same shape as `raw/` — the `type` field
  in frontmatter is the discriminator. Exception: living topic pages are undated —
  `topic-<slug>.md` — because they are updated in place (bump `updated:` in frontmatter)
  rather than rewritten as dated copies.
- **Required frontmatter:** `title:`, `type:`, `created:`, `tags:`, and a `source:`
  line pointing to the raw artifact(s) the compiled was derived from. Topic pages add
  `updated:` and a one-line `summary:` (shown in the startup catalog).
- **Session injection:** surfaced at session start via `scripts/startup-context.ts`.
  `foundational`-tagged files inject full bodies; everything else gets a one-line
  catalog entry (stem, type, date, tags + summary). Shared budget —
  `knowledge.compiled_budget_chars` (default 2500, range 500–6000) applies across
  **all** compiled files, not per-file. `/hermit-doctor` and `scripts/knowledge-lint.ts`
  surface oversize. For deep retrieval of specific past content by keyword, use `/recall`.
- **Foundational pinning:** tag a compiled artifact `foundational` to pin it to every
  session regardless of age.
- **Example:** `compiled/audit-kitchen-2026-04-17.md`
- **Procedure briefs** are a special `compiled/` type (`type: procedure-brief`, filename `procedure-brief-<slug>-<YYYY-MM-DD>.md`). They are legacy reflect audit records still readable by routine/agent proposals; not domain outputs meant for startup injection. Do not tag them `foundational`. See [frontmatter-contract.md](frontmatter-contract.md) for the required fields.

## state/ — runtime ledgers

Not a domain artifact. Never session-injected. Not GC'd by `archive-raw.ts`. Hooks and
skills use this bucket to coordinate across invocations.

- **Structured state:** `*.json`, read-modify-write. Examples: `alert-state.json`,
  `reflection-state.json`, `runtime.json`, `doctor-report.json`.
- **Append-only logs:** `*.jsonl`, one JSON object per line, each line < 4 KB (POSIX
  PIPE_BUF safety lets multiple writers append concurrently without corruption).
  Examples: `proposal-metrics.jsonl`, `routine-metrics.jsonl`, `update-history.jsonl`.
- **Never rename existing state files** — they're referenced by absolute path
  throughout the codebase. Add a new file; don't rebrand an old one.
- **No subdirectories** by convention. If runtime data naturally clusters, use a
  filename prefix (`monitors.runtime.json`, not `monitors/runtime.json`).
- **Schema enforcement:** if a new JSON state file needs a guaranteed shape, add a
  check to `scripts/validate-config.ts` or a contract test in `tests/contracts.test.ts`.

## proposals/ — improvement suggestions

- **Naming:** `PROP-NNN.md` (legacy) or `PROP-NNN-<slug>-HHMMSS.md` (current: kebab-cased slug + creation-time `HHMMSS`, optional `a`/`b`/… collision suffix). NNN is a sequential zero-padded 3-digit integer, never renumbered. The full filename stem equals the proposal's `id` in frontmatter.
- **Lifecycle:** driven by frontmatter `status:` (one of `open`, `resolved`,
  `dismissed`, `deferred`, `reverted`).
- **Required frontmatter:** `title:`, `status:`, `tier:`, `category:`, `source:`,
  `created:`. See `state-templates/PROPOSAL.md.template` for the full shape.
- **Creation rules:** see `skills/proposal-create/SKILL.md` — the three-condition rule
  gates what is and isn't proposal-worthy.

## Adding a new domain — checklist

When a new skill, routine, or plugin hermit introduces a new artifact type:

1. **Pick a short lowercase slug** (e.g. `deploy-health`, `kitchen`, `ingest-errors`).
   One-to-three hyphen-separated words.
2. **Decide the ingestion path** — what writes `raw/<type>-<slug>-<date>.md`? A
   scheduled check, a skill invoked on demand, or a routine?
3. **Decide the promotion path** — what reads `raw/` and produces
   `compiled/<type>-<slug>-<date>.md`? Typically a skill invoked via routine.
4. **Declare the types in `knowledge-schema.md`** — every artifact type must appear
   there with `Produces:`, `When:`, and `Format:` lines. This is the behavioral
   contract operators read.
5. **No code changes required** in `archive-raw.ts` or `knowledge-lint.ts` — both are
   convention-driven and pick up new artifacts automatically as long as the frontmatter
   contract is respected.
6. **If runtime coordination is needed** (a queue, a dedup table, a counter), add a
   file to `state/`, not `raw/`. Document it in this file or in the relevant skill.

## Naming anti-patterns

- **Subdirectories inside `raw/` or `compiled/`.** Breaks the flat-layout invariant
  in CLAUDE.md. `archive-raw.ts` and session injection both assume flat.
- **Day-only timestamps for high-frequency artifacts.** Use ISO date
  (`YYYY-MM-DD`) for human-written content. If you have multiple artifacts per day of
  the same type, add ISO-second precision to the slug (e.g.
  `raw/snapshot-home-20260417T143055.md`) — don't invent a per-day counter that
  needs an allocator.
- **Uppercase or mixed-case type prefixes.** Convention is lowercase (`snapshot-…`,
  `audit-…`, `briefing-…`). Uppercase (`SNAPSHOT-…`) works against grep-ability and
  reader expectations.
- **Mixing `state/` concerns into `raw/` or `compiled/`.** Domain artifacts are the
  knowledge graph for the model; state files are the coordination layer for the
  plumbing. Different readers, different GC rules — don't conflate them.
- **New top-level directories under `.hermit/`.** Base-hermit infra only
  recognizes the four buckets above plus `sessions/`, `templates/`, `bin/`, `docker/`.
  A new top-level directory will be invisible to every existing reader and scanner.
- **Schema-typed JSON state files without a validator.** If a hook depends on a
  specific shape in `state/foo.json`, the shape needs a test in `tests/contracts.test.ts`.
  Silent schema drift is a recurring bug class; the contract tests are cheap insurance.

## Where this fits

- `docs/plugin-hermit-storage.md` is the authoritative reference for plugin hermits
  that add new domain types. Read that first if you're building a plugin hermit.
- `state-templates/knowledge-schema.md.template` is the per-project declaration of
  what a given hermit produces and when. Every artifact type the hermit writes should
  appear there.
- This document (`artifact-naming.md`) is the cross-bucket reference for anyone
  touching any of the four buckets, whether they're in a plugin hermit or the base.
