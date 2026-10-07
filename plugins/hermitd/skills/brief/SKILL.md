---
name: brief
description: Returns a 5-line executive summary of recent work. Checks open resident records first, then recent task outcomes. Activates on messages like "brief", "what happened", "morning update", "overnight summary", "progress", "what are you working on", "how's it going".
---
# Task Brief

Provide a concise executive summary of recent task activity. Designed for morning check-ins, phone/channel consumption, and quick status updates.

## Commands
- `duties-summary`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/duties.ts summary .hermit`
- `proposal-index`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts index .hermit`
- `task-list`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts list .hermit`
- `task-report`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-report.ts .hermit`
- `artifact-render`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts render <type> .hermit`

## Always-On Delivery Rule

If `config.always_on` is `true`, deliver all operator-facing output per `CLAUDE-APPEND.md § Operator Notification`. The terminal is unmonitored in always-on mode. For the push-fallback branch, condense the brief to a single line (per § Operator Notification push format): include whichever of open proposal count and active heartbeat alerts are present and non-zero; omit zero or unavailable fields. Example: `Brief: 16 proposals open, 1 alert — open CC to view`. In interactive mode, output to terminal. This applies to all flags below.

## Dispatch

Before composing any brief, determine the dispatch mode:

1. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts list .hermit --open --owner resident --json`.
2. Resolve the active flag (`--morning`, `--evening`, "brief today"/"daily summary", or no flag).
3. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/duties.ts summary .hermit` for requested and observed duty lines.

Read these bounded digests fresh each turn. With no flag and open resident records, summarize those records in main. Otherwise dispatch `hermitd:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/brief/reference.md`, passing `plugin_root` (resolved absolute path), `mode` (`morning`, `evening`, `daily`, or `default-no-session`), `today` (ISO date), and `context_recovery` for morning.

Copy this skill's Commands entries verbatim into the dispatch prompt (already absolute); the runner uses them with the reference's arguments.

Readers use `task-report.ts` for normalized task outcomes. Never open frozen session archives. If the runner fails or returns malformed JSON, use the current task list and duty digest; do not fall back to archives.

**Eval runner return schema** — the runner returns a JSON object conforming to this block. The schema is byte-identical in `reference.md` (producer) and here (consumer); a contract test asserts this.

<!-- brief-eval-schema:start -->
```json
{
  "report_summary": { "date": "<ISO>", "tags": ["<tag>"], "working_on": "<one-line>",
                       "status": "<completed|partial|blocked>", "next_start_point": "<text>" }|null,
  "sessions_today": [ { "session": "T-...", "summary": "<one-line>" } ],
  "findings": ["<text>"],
  "decisions": ["<text>"],
  "tomorrow": ["<text>"],
  "pending_proposals": ["<PROP-NNN: title>"],
  "operator_priorities": ["<text>"],
  "queued_work": ["<text>"],
  "waiting": ["<text>"]
}
```
<!-- brief-eval-schema:end -->

## Flags

### --morning (routine mode)

**Delivery:** Write the full composed brief text (before any push-fallback single-line condensing) to `.hermit/state/last-brief.json` as `{"kind":"morning","text":"<brief text>","generated_at":"<now, ISO>"}`, so the dashboard's "latest brief" section can pick it up. Then refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, append a final line `📎 <url>`. Then deliver the brief to the operator (see Always-On Delivery Rule above).

Emphasize forward-looking content. Compose from runner JSON (see Dispatch above) and live main-session data:
- **Pending proposals:** use `runner.pending_proposals`
- **Operator priorities:** use `runner.operator_priorities`
- **Queued work:** use `runner.queued_work`
- **Waiting:** use `runner.waiting` (records awaiting a reply or confirmation); omit the line when the array is empty
- **Context recovery:** if `runner.report_summary` is non-null, use it for task context
- If `config.always_on` is `true`: frame as "what happened overnight (activity since evening routine)"
- If `config.always_on` is `false`: frame as "here's where things stand"
- **Decisions:** use `runner.decisions` for what changed and why; omit the line when the array is empty
- If `config.always_on` is `true`: run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/check-upgrade.sh" "${CLAUDE_PLUGIN_ROOT}"` from the project root. If it emits an `---Upgrade Available---` section, append a final line to the brief: `⚠ Plugin update available: <the version line>` (pass the directive verbatim). If it emits `---Stale Plugin Runtime---` instead, append `⚠ Stale plugin install: <the notice>` — never label it an update, and never turn it into an evolve instruction (evolve cannot fix a stale install). Output nothing if the script is silent. (Interactive operators already see this notice at resident startup; the gate avoids double-notification.)

After composing the morning brief, age the micro-proposal queue in one pass: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts micro .hermit brief-cycle`. It reads `state/micro-proposals.json`, runs the whole lifecycle atomically (re-nudges `follow_up_count` 1 entries, expires `follow_up_count` ≥2 entries and records each expiry, prunes any entry whose `status` isn't `"pending"`), and prints one JSON line `{"new":[…],"renudged":[…],"expired":[…],"dropped":[…]}` — never hand-edit the file or read it separately. Render straight from that verdict:
- Each `new` entry (first display): append as a final line. Without `options`: `MP-YYYYMMDD-N (tier N): [question]` — Reply `"MP-YYYYMMDD-N yes"` or `"MP-YYYYMMDD-N no"`. (Bare `yes`/`no` accepted when only one pending.) With `options`: render them numbered under the question and reply hint `Reply "MP-YYYYMMDD-N <number or label>"` (bare accepted when only one pending).
- Each `renudged` entry: append with softer framing: "Still waiting on MP-YYYYMMDD-N: [question] — ignore again to drop it" (if it carries `options`, re-render them numbered beneath it so the choices aren't lost on the re-nudge).
- `expired` entries were dropped this cycle — do not surface them, and do not resurrect unless fresh evidence accumulates from scratch.
- `dropped` entries were resolved elsewhere: never surface them, never count them.
- If `new` and `renudged` are both empty: brief ends without a decision prompt.

### --evening (routine mode)

**Delivery:** Write the full composed brief text (before any push-fallback single-line condensing) to `.hermit/state/last-brief.json` as `{"kind":"evening","text":"<brief text>","generated_at":"<now, ISO>"}`, so the dashboard's "latest brief" section can pick it up. Then refresh the dashboard per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; if it returns a URL, append a final line `📎 <url>`. Then deliver the brief to the operator (see Always-On Delivery Rule above).

Emphasize backward-looking content. Compose from runner JSON (see Dispatch above) and live main-session data:
- **Tasks today:** use `runner.sessions_today` (the compatibility key contains task IDs and outcomes).
- **Key findings:** use `runner.findings` from record lessons.
- **Decisions:** use `runner.decisions` for what changed and why; omit the line when the array is empty.
- **Tomorrow:** use `runner.tomorrow` from runnable open records.
- **Waiting:** use `runner.waiting`; omit the line when the array is empty.
- **Duties:** append the requested and observed duty digest. Unconfirmed results remain open until checked, confirmed, or cancelled; report them without prompting for a session close.

### No flag (default)

Current behavior — general purpose summary as described below.

## Plan

1. If open resident records exist, summarize their titles, results, and waiting reasons. Read normalized outcomes with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-report.ts .hermit --limit 20` when needed.
2. Otherwise use `runner.report_summary`. If there is no record history, say "No task history yet." An empty record list never falls back to archived reports.
3. Include the duty digest in routine briefs; for a default brief, surface only a duty whose requested and observed state disagree.

## Output Format

One line per field below, plus an optional line for pending proposals (see Rules below):

```
[Brief] YYYY-MM-DD | [tags if present]
Working on: one-line description
Status: completed/partial/blocked
Done: step1, step2, step3
Next: description of next action (or "No next action" if all done)
```

## Rules

- One line per field; a reader on a phone should get the whole brief without scrolling. Extra lines only for the alert count, the proposal count, and the decisions line in routine briefs
- When delivered over a channel, replace every slash-command pointer in the template with the plain reply the operator can send (e.g. 'reply "start" to begin', 'ask me for a health check'); command names stay in terminal output
- Use the record's date, not today's date
- Include tags in the header only if they exist
- For "Done", list only records with outcome `done`. Label cancelled and unconfirmed outcomes explicitly.
- For "Next", name an open record or its waiting reason; do not infer success from a result awaiting confirmation.
- Open, waiting and queued items come only from records read this turn (runner JSON or the dispatch task list). Earlier briefs (`state/last-brief.json`, `compiled/brief-*`) and earlier conversation are never sources for them; a closed record never appears.
- After composing the 5-line output: scan `.hermit/proposals/` for files with `source: auto-detected` and `status: proposed` (read `status:` and `source:` from the **leading `---` YAML frontmatter block only** — do not count files where those phrases appear in the proposal body text; skip files with no frontmatter block). If any exist, append a 6th line: `Proposals: N auto-detected proposal(s) pending review`

## Daily Summary Format

When invoked with "brief today", "daily summary", or "what happened today":

Compose from runner JSON (mode: `daily`). Use `runner.sessions_today`, `runner.findings`, `runner.decisions`, `runner.tomorrow`, and `runner.waiting` for the day narrative. Format as a day-level summary covering: work done, decisions (what changed and why; omit the line when the array is empty), and proposals created/resolved.
