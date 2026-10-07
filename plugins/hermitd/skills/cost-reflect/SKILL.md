---
name: cost-reflect
description: "The 'why is my bill high' skill: audits where spend goes across token categories (cache_read, cache_write, output, input) and per-session attribution. Invoke for questions like 'cost breakdown', 'which sessions are expensive', 'what's driving spend', or 'cold start costs'. Not for week-over-week trend lines (use hermit-evolution) or simple total-spend summaries."
---
# Cost Reflect

Runs a structural cost audit over the last 7 days of `cost-log.jsonl` and delivers the result to the operator. The math is done by a script — your job is to run it and deliver the output through the right channel.

## Invocation mode

- **Manual (no arguments):** reply only to the invoking terminal or channel conversation.
- **Automated (`--maintainer`, or any routine/proactive invocation):** produce the full technical
  report and send it as a maintainer-tier notice.

## Step 1 — Run the analyzer

On a channel-tagged turn without `--maintainer` (the inbound prompt contains a `<channel source="...">` tag), run
the plain-language mode instead of the full breakdown — a channel operator asking "why is my bill
high" shouldn't get raw token-category jargon:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/cost-report.ts reflect .hermit --plain
```

Otherwise (terminal/dev use or `--maintainer`), run the full breakdown:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/cost-report.ts reflect .hermit
```

Capture stdout. If the output starts with "No cost data" or "No spend recorded yet", report that message and stop — there's nothing to send.

## Step 2 — Relay the report

**Terminal:** the script output is already formatted and capped at 1500 characters. Relay it verbatim. Don't summarize, reformat, or add commentary — the output is the report.

**Channel (`--plain` output):** reply through that channel's reply tool. The script output is already plain language and jargon-free; no `cache_read`/`cache_write`/token-type labels, no session IDs, no `PROP-`/`T-...`, no slash commands. Relay it **translated into the operator's language** if the inbound message wasn't in English. Translation only; add no commentary and don't reintroduce token-category detail.

## Step 3 — Channel delivery

When `$ARGUMENTS` contains `--maintainer` (or the invocation is a routine/proactive prompt rather than
a direct operator conversation), deliver the report through the operator's channel. Spend detail is
maintainer-tier by definition, so send it as the `maintainer` leg only (no `client` leg):

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .hermit --notice
```
with `{"maintainer": "<report>"}` on stdin. On a technical install with no maintainer chat configured, `sendOperatorNotice`'s default `fallback: "client"` puts it in the primary chat. On a `non-technical` install with no maintainer chat, the report goes to `state/watchdog-events.jsonl` and no chat sees it (fail-closed on spend disclosure). If nothing was delivered, follow § Operator Notification's fallback (push if enabled, log to Findings).

To set a preferred channel, add `"primary": "<channel-name>"` inside `channels` in `config.json`.

## Notes

- **Scheduling:** this skill doesn't self-register a routine. To run it on a schedule, add
  `hermitd:cost-reflect --maintainer` as a routine via `/hermitd:hermit-settings`.
- **What it measures:** token-type cost composition (cache_read / cache_write / output / input), per-model breakdown (shown when ≥2 models appear, e.g. Opus main + Haiku heartbeat), cold-start turns (context warm-ups with no prior cache hit), and per-session cost attribution. For week-over-week totals, use `/hermitd:hermit-evolution` instead.
- **`--plain` mode** (channel-tagged turns only): today's spend vs. a trailing-7-day typical day, drivers named by work (not token type), spend-cap status, and a one-line notional-dollars caveat. No token categories, session IDs, or internal IDs.
- **Non-technical installs** (`config.operator_profile === 'non-technical'`): a client-chat spend question never reaches this skill, since `channel-responder` deflects it with a plain "handled by your provider" reply. Spend figures stay maintainer-side (terminal, maintainer chat, weekly review), so a channel-tagged run here is expected only from a maintainer-audience surface.
