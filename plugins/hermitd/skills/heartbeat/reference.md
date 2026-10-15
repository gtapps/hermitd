# Heartbeat — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md `run` step 4.
The subagent reads only files (no inherited session context) and returns **judgment only** — which items
are currently firing, and a human-readable label for each. All bookkeeping (dedup, suppression,
resolution, the daily digest, monitoring lines, operator notifications, `last_clean_eval_at`, and
`heartbeat_result`) is derived deterministically by `heartbeat.ts alert-state` from the returned firing set —
the subagent never authors any of it. This split exists because a small model (`heartbeat.model`
set to haiku) asked to author that bookkeeping fabricates fields and flips pending flags.
`heartbeat_result` is `OK`, `ALERT`, or `INDETERMINATE` (this return was rejected — nothing written).

This file is read only on the EVALUATE path, once the precheck determines a full LLM tick is warranted.

## Evaluation Steps

**1. Read inputs fresh** — do not reuse values cached from prior reads in this session.
- `.hermit/HEARTBEAT.md` — the checklist items
- The tick's local date (`today`), used for distinct-day self-evaluation counts

**2. Per-item evaluation.** For each item in HEARTBEAT.md:
- **Default proposals item** (text references `proposals/` and `status: proposed`): skip it entirely.
  `heartbeat.ts alert-state` derives its live state directly from `proposals/` frontmatter every tick,
  independent of anything returned here — there is nothing for you to evaluate or report.
- **Custom items** (disk thresholds, SQL checks, file patterns, etc.): apply LLM judgment using
  available project files and context needed to evaluate the condition. Return `item` or `key` per
  the taxonomy table below.
- Collect all firing items with a short human-readable `text` label for each — see
  § Firing Item Text below for the required style. Items with no matching condition produce nothing.

**3. Return JSON** — see § Return Schema below for the required fields and exact format.

## Semantic Key Taxonomy

Produce one firing entry per true item:

| Situation | Return |
|-----------|--------|
| Checklist item | `item`: the HEARTBEAT.md line, verbatim. `checklist:<…>` is owned by the writer, not the model. |
| Waiting timeout | `key`: `waiting-timeout` |
| Custom / freeform | `key`: `custom:<first-100-chars-normalized>` — fallback only; also receives an unresolvable checklist entry |

Normalise: strip the list marker and any checkbox first, then lowercase, remove non-alphanumeric characters, truncate at the listed limit.

**Never** emit a `micro-proposal-pending:*` or `proposal-pending:*` key in `firing`.
Those are derived and owned entirely by `heartbeat.ts alert-state` from
`state/micro-proposals.json` and `proposals/*.md` frontmatter — an entry you emit under either
prefix is dropped as a phantom and has no effect.

## Firing Item Text

Each firing item's `text` is a channel-voice one-liner: plain language, the concrete condition first, no
internal IDs (no `PROP-NNN`, no session IDs, no file paths unless the item itself is about a file). It is
used for a brand-new or newly-suppressed alert in the
operator notification — write it for that audience, not as a debug note to yourself.

## Return Schema

Return exactly this JSON object — no prose, no markdown fences:

`{"firing": [{"item": "<HEARTBEAT.md line, verbatim>", "text": "<channel-voice one-liner>"} or {"key": "custom:<…>"|"waiting-timeout", "text": "<channel-voice one-liner>"}, ...]}`

`firing` is required and is `[]` when nothing is currently true — this is the normal "clean tick"
case; do not omit the key or return anything else in its place. Any other key you add is ignored.

**Report only; any fix is the main session's.**
