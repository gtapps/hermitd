---
name: hermit-doctor
description: Runs the hermit's read-only health checks (runtime, config, hooks, state integrity, cost and spend, scheduling and watchdog, channels, credentials, permissions, docker, backup) and reports the summary. Use when diagnosing an install, before a release, or after suspicious behavior. Activates on messages like "/hermit-doctor", "health check", "diagnose the hermit", "what's wrong", "run diagnostic".
---

Record notes only inside an open record's turn, using `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id>` with the note on stdin. Otherwise skip record notes. Never edit a task file directly.

# Hermit Doctor

Runs read-only health checks against the current hermitd install (`channel-liveness`
is the only one that performs outbound API calls — see Notes) and surfaces the summary. Safe
to run at any time. Produces no side effects beyond writing
`.hermit/state/doctor-report.json` and `.hermit/state/doctor-alerts.json`,
and appending a summary block to the open task record.

## Commands
- `task-note`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit`

## Notification route

A finding gets one notification per unresolved episode: the check script records it, you send it
once, and it stays silent until it resolves. A send that never reached the operator is re-offered
on the next run rather than counted as delivered.
Every run sends the same two-leg notice and `channel-send.ts` resolves each leg against this
install's own config: the maintainer leg reaches the configured `maintainer_channel_id`, else the
primary chat on a `technical` profile (both parts arrive together there), else `state/watchdog-events.jsonl` on a `non-technical` one. A configured maintainer destination that
is unreachable fails closed to `state/watchdog-events.jsonl` and never spills into the primary chat.

`--maintainer` is accepted and ignored (routine strings may still pass it): audience is decided by
the row's own tier and the operator's config, not by the flag.

## Steps

1. Run the check script:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/doctor-check.ts .hermit
   ```
   The script writes `.hermit/state/doctor-report.json` and prints the same
   JSON to stdout. It exits 0 unconditionally — on any internal failure the failing
   check reports `status: "fail"` in its own entry rather than crashing the report.

2. Parse the JSON. For each check in the report (one entry per id), emit one line using this format:
   - `✓ <id> — <detail>` when `status: ok`
   - `⚠ <id> — <detail>` when `status: warn`
   - `✗ <id> — <detail>` when `status: fail`

3. Inside an open record's turn, record the per-check summary with `task.ts note .hermit <id>`. Otherwise skip the note.

4. Return the per-check lines to the caller and nothing else.

5. **Escalation.** The script already computed this — do not recompute it, and do not write alert
   state yourself. Read the `escalation` object from the step-1 JSON:

   - `escalation.new` — findings owed to the operator, each `{id, status, detail}` plus an
     optional `tier`. Empty means everything currently failing has already been announced; say
     nothing.
   - `escalation.resolved` — check ids whose finding cleared. Recorded, never announced: there is
     no "recovered" ping.
   - `escalation.persisted: false` — the ledger could not be written. `prior_state_known: false` —
     the ledger was unreadable and had to be rebuilt, so what was already announced is unknown.
     **On either, send nothing** and let the maintainer fallback record the findings in `state/watchdog-events.jsonl` instead;
     a notification you cannot dedup would repeat every run.

   **When `escalation.new` is non-empty.** Compose one complete, concise summary covering every
   listed check, its detail, and a named next action, in the operator's configured language.
   When the finding is `classifier-denials`, name what was blocked by kind: a `bun` block is
   usually a hermit script, a call-shape/upstream matter the hermit reports; interpreter heredocs
   (`python3`, `node`) are something the hermit stops doing itself; an operator's own host needs an
   `autoMode.environment` entry naming it, added to `~/.claude/settings.json` from the terminal.
   Never offer to add classifier context on a chat reply.

   **Rows carrying `tier: "maintainer"` go on the maintainer leg only.** Their content is what the
   `PermissionDenied` hook already keeps off a client chat, so the payload splits by audience and
   `channel-send.ts` decides where each leg lands (§ Notification route).

   **Before sending, check the completed payload.** Use the configured language already in
   context (including the worker's language instruction); if unavailable, read only
   `config.language`. When unset, match the operator's conversation language. Check both
   `client` and `maintainer` prose and correct any language mismatch before sending. Only literal
   diagnostic excerpts may stay quoted in their original language; explanations and next actions
   must use the target language. Preserve identifiers, commands and paths. Keep a concrete next
   action for each finding; a `warn` status alone does not establish that it is minor or causes no blockage.
   Do this in the current turn, without another agent or model call.

   Deliver it once through the canonical notice path:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .hermit --notice
   ```
   One payload, whatever the invocation:
   `{"client": "<plain headline for the rows without a tier, plus the one next step>", "maintainer": "<technical rows only>"}`.
   The client leg is the only part of this notice that can land in a client chat, so write it to the
   channel voice rule — no check ids, file paths, USD or token figures; what is wrong in plain words
   and what the operator should do about it. The maintainer leg carries only technical rows
   (IDs, paths, spend, diagnostics and errors). When both audiences share a chat the script sends
   both parts together, so neither repeats the other. Omit `client` when every new row is tiered. Send no `fallback`
   key: its default is what routes a maintainer leg to `state/watchdog-events.jsonl` on a `non-technical` install.

   When doctor was invoked from a channel, do not quote a tiered row back into your reply; say a
   maintainer diagnostic was recorded and leave it at that.

   **Then confirm delivery**, so those findings stop being re-offered — only when the send actually
   landed (exit 0):
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/doctor-check.ts .hermit --mark-notified <id> [<id>…]
   ```
   Pass every `escalation.new[].id` you just announced, tiered rows included. If the send failed
   or degraded, skip this step: an id left unconfirmed keeps `escalation.new` non-empty, so the
   next run retries it instead of dropping it, and the doctor routine keeps waking on it.
   For exit-code handling and the event-log fallback, follow
   `skills/channel-responder/outbound.md`.

## Silence policy

- If every check is `ok`, return only: `All checks passed.` Do not notify via
  channel (Tier 0). Still append to the open task record so the run is traceable. Clearing the stale
  `doctor:*` entries is the script's job, not yours — it happens on every run.
- If any check is `warn` or `fail`, return the full per-check summary. Notification is
  governed by `escalation.new` (step 5), not a blanket per-run ping: only findings not yet
  confirmed delivered notify the selected route.

## What each check looks at

Per-check semantics and status rules: `${CLAUDE_SKILL_DIR}/reference.md`, read only when a row
needs interpreting.

No automatic fixes. Doctor reports; the operator acts.

## Notes

- The check logic lives in `scripts/doctor-check.ts` so it can be unit-tested without
  invoking the model.
- Re-runs are cheap. No locking needed.
- `permission-rules` never writes. It reports which seeded `ask` entries are inert and names the
  `apply-settings.ts <file> deny hardened` command; converting them to hard blocks is the operator's
  call, from a terminal.
- `channel-liveness` is the only check that leaves the machine: one token-authed liveness
  call per already-configured, enabled channel, 5s timeout, fail-soft. Disabling a channel
  disables its probe. Every other check is a local filesystem read.
