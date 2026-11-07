---
name: brief
description: Returns a 5-line executive summary of recent work. Checks open records first, then recent task outcomes. Activates on messages like "brief", "what happened", "morning update", "overnight summary", "progress", "what are you working on", "how's it going".
---
# Task Brief

Provide a concise executive summary of recent task activity. Designed for morning check-ins, phone/channel consumption, and quick status updates.

## Commands
- `brief-digest`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/brief-digest.ts .hermit`
- `artifact-render`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts render <type> .hermit`

## Always-On Delivery Rule

If `config.always_on` is `true`, deliver all operator-facing output per `prompts/resident.md § Operator Notification`. The terminal is unmonitored in always-on mode. For the push-fallback branch, condense the brief to a single line (per § Operator Notification push format): include whichever of waiting decision count and active heartbeat alerts are present and non-zero; omit zero or unavailable fields. Example: `Brief: 16 decisions waiting, 1 alert — open CC to view`. In interactive mode, output to terminal. This applies to all flags below.

## Dispatch

Resolve scope before composing or dispatching any brief:

1. Build `<selector>`: when told `This is routine <id>.`, use `--routine <id>`; otherwise, when asked in a chat, use `--chat <source>:<chat_id>` from that message's conversation key, including its `~<thread>` suffix when the channel maps threads; otherwise use no selector.
2. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/brief-digest.ts .hermit context <selector>` before any other step. Its `scope` decides which records the brief covers. When its `agent_steps` is `false`, skip agent-wide admin decisions, duties, the upgrade check, `last-brief.json` writes, dashboard refresh and `OPERATOR.md` priorities. Deliver to the answering chat; a routine uses its resolved `destination`.
3. Resolve the active flag (`--morning`, `--evening`, "brief today"/"daily summary"/"what happened today", or no flag).
4. For morning, evening and daily, always dispatch `hermitd:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/brief/reference.md`. Do not compose the brief before the runner returns. After context, dispatch before any other read or mutation.
5. For a no-flag brief, read only `bun ${CLAUDE_PLUGIN_ROOT}/scripts/brief-digest.ts .hermit morning <selector>`, compose in main, and never dispatch.

Read the digest fresh each turn. Pass the runner `plugin_root` (resolved absolute path), `mode` (`morning`, `evening`, or `daily`) and the exact selector arguments (or none). The digest already enforces `agent_steps` and chat scope for `decisions_pending`; never age a queue or make a separate decision read.

Copy this skill's Commands entries verbatim into the dispatch prompt (already absolute); the runner uses them with the reference's arguments.

Every mode uses `brief-digest` for bounded task, duty and pending-decision data. Keep the project root as the working directory, including in the runner; do not change into `plugin_root`. Never open frozen session archives. If the runner fails or returns malformed JSON, read `${CLAUDE_PLUGIN_ROOT}/skills/brief/reference.md` and follow it for the active mode with the same selector.

**Eval runner return schema** — the runner returns a JSON object conforming to this block. The schema is byte-identical in `reference.md` (producer) and here (consumer); a contract test asserts this.

<!-- brief-eval-schema:start -->
```json
{
  "report_summary": { "date": "<ISO>", "tags": ["<tag>"], "working_on": "<one-line>",
                       "status": "<completed|partial|blocked>", "next_start_point": "<text>" }|null,
  "tasks_today": [ { "task": "T-...", "summary": "<one-line>" } ],
  "findings": ["<text>"],
  "decisions": ["<text>"],
  "tomorrow": ["<text>"],
  "decisions_pending": ["<title and waiting authority>"],
  "operator_priorities": ["<text>"],
  "queued_work": ["<text>"],
  "waiting": [ { "title": "<text>", "state": "<finishing|unconfirmed|waiting>", "waiting_on": "<key>"|null } ],
  "duties": ["<one line: name, requested, observed>"],
  "omitted": { "clipped": 0, "lessons": 0, "records": 0, "decisions": 0, "open": 0, "decisions_pending": 0, "duties": 0 }
}
```
<!-- brief-eval-schema:end -->

Compose `runner.waiting` entries in the operator's language from `title`, `state` and `waiting_on`: `finishing` means nothing is needed from the operator; `unconfirmed` means a result awaits confirmation, from `waiting_on` when set; `waiting` means work needs the named party. For every routine brief, say plainly when `runner.omitted` has non-zero counts, including clipped text and items left out.

## Flags

### --morning (routine mode)

**Delivery:** For `agent_steps: false`, skip the `last-brief.json` write and dashboard refresh and deliver per the Always-On Delivery Rule. For `agent_steps: true`, write the full composed brief text (before any push-fallback single-line condensing) to `.hermit/state/last-brief.json` as `{"kind":"morning","text":"<brief text>","generated_at":"<now, ISO>"}`, so the dashboard's "latest brief" section can pick it up. Then refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, append a final line `📎 <url>`. Then deliver the brief to the operator (see Always-On Delivery Rule above).

Emphasize forward-looking content. Compose from runner JSON (see Dispatch above) and live main-session data:
- **Waiting decisions:** use `runner.decisions_pending`
- **Operator priorities:** use `runner.operator_priorities`
- **Queued work:** use `runner.queued_work`
- **Waiting:** use `runner.waiting` (records awaiting a reply or confirmation); omit the line when the array is empty
- **Duties:** use `runner.duties` for requested and observed duties
- **Task context:** if `runner.report_summary` is non-null, include it as the latest record with its date; it can predate last night, so the framing below does not make it overnight activity
- If `config.always_on` is `true`: frame as "what happened overnight (activity since evening routine)"
- If `config.always_on` is `false`: frame as "here's where things stand"
- **Decisions:** use `runner.decisions` for what changed and why; omit the line when the array is empty
- If `agent_steps` is `true` and `config.always_on` is `true`: run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/check-upgrade.sh" "${CLAUDE_PLUGIN_ROOT}"` from the project root; output nothing for `OK`. For `status: "upgrade_available"`, append `⚠ Plugin update available: v<config_version> → v<plugin_version>, run /hermitd:hermit-evolve`. For `"stale_plugin_runtime"`, append `⚠ Stale plugin install` with both versions and the fix: update the `claude plugin list` entry loaded from `plugin_root` with `claude plugin update hermitd@hermitd --scope <its scope>`, then restart. Never call it an update or suggest evolve: it cannot help. (Interactive operators see it at resident startup.)

**Waiting decisions.** List `runner.decisions_pending` quietly in this brief. Admin decisions appear only with `agent_steps: true`; requester and chat inputs follow the digest's visibility scope, including `agent_steps: false`. Give the current question and options, in plain language, without ids. No queue aging, expiry, delivery-count write or extra push occurs here. Replies use the normal `task answer` route.

### --evening (routine mode)

**Delivery:** For `agent_steps: false`, skip the `last-brief.json` write and dashboard refresh and deliver per the Always-On Delivery Rule. For `agent_steps: true`, write the full composed brief text (before any push-fallback single-line condensing) to `.hermit/state/last-brief.json` as `{"kind":"evening","text":"<brief text>","generated_at":"<now, ISO>"}`, so the dashboard's "latest brief" section can pick it up. Then refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, append a final line `📎 <url>`. Then deliver the brief to the operator (see Always-On Delivery Rule above).

Emphasize backward-looking content. Compose from runner JSON (see Dispatch above) and live main-session data:
- **Tasks today:** use `runner.tasks_today`.
- **Key findings:** use `runner.findings` from record lessons. Keep every distinct finding, and merge only findings that say the same thing.
- **Decisions:** use `runner.decisions` for what changed and why; omit the line when the array is empty.
- **Tomorrow:** use `runner.tomorrow` from runnable open records.
- **Waiting:** use `runner.waiting`; omit the line when the array is empty.
- **Duties:** use `runner.duties` for the requested and observed duty digest. Unconfirmed results remain open until checked, confirmed, or cancelled; report them without prompting for a session close.

### No flag (default)

Current behavior — general purpose summary as described below.

## Plan

1. Use only the morning digest read in Dispatch. If `open` rows exist, summarize their titles, states and waiting reasons. Name a `delegated` row as work a helper or worker is running. Never describe it as queued work or an operator wait.
2. Otherwise summarize `latest`. Map `done` to `completed`, waiting work to `blocked`, and other outcomes to `partial`, naming the actual outcome in the summary. Use `closed_at`, else `opened_at`, for the date, empty tags, the title for working on, and the waiting reason or open work for next. If `latest` is null, say "No task history yet." Never fall back to archived reports.
3. Surface only a duty from `duties` whose requested and observed state disagree. Before surfacing one, check it against the duty rule in `${CLAUDE_PLUGIN_ROOT}/skills/brief/reference.md` § Inputs.
4. When `decisions_pending` is nonempty, append `Waiting: N decisions` using its row count. Make no extra data reads.

## Output Format

One line per field below, plus an optional line for waiting decisions (see Plan step 4):

```
[Brief] YYYY-MM-DD | [tags if present]
Working on: one-line description
Status: completed/partial/blocked
Done: step1, step2, step3
Next: description of next action (or "No next action" if all done)
```

## Rules

- One line per field; a reader on a phone should get the whole brief without scrolling. Extra lines only for the alert count, the waiting-decision count, and the decisions and waiting lines in routine briefs
- When delivered over a channel, replace every slash-command pointer in the template with the plain reply the operator can send (e.g. 'reply "start" to begin', 'ask me for a health check'); command names stay in terminal output
- Use the record's date, not today's date
- Include tags in the header only if they exist
- For "Done", list only records with outcome `done`. Label cancelled and unconfirmed outcomes explicitly.
- For "Next", name an open record or its waiting reason; do not infer success from a result awaiting confirmation.
- Open, waiting and queued items come only from records read this turn (runner JSON or the plain brief digest). Earlier briefs (`state/last-brief.json`, `compiled/brief-*`) and earlier conversation are never sources for them; a closed record is never listed as open, waiting or queued.

## Daily Summary Format

When invoked with "brief today", "daily summary", or "what happened today":

Compose from runner JSON (mode: `daily`). Use `runner.tasks_today`, `runner.findings`, `runner.decisions`, `runner.tomorrow`, `runner.waiting`, and `runner.duties` for the day narrative. Keep every distinct finding, and merge only findings that say the same thing. Say plainly when `runner.omitted` reports clipped text or items left out. Format as a day-level summary covering: work done, decisions (what changed and why; omit the line when the array is empty), and proposal tasks opened/completed.
