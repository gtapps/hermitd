# Reuse a spawned helper

Read from proposal-act's "Start implementing now" branch, before the
falsification gate and Dispatch, when the proposal's `## Operator Decision`
carries a `spawn-session --proposal` hand-off line:
`Handed to helper <n> (<sid>) on <date>; record <T-id>`. The latest such line
names the helper and its session id. It already paid for reading the
proposal and its cited files, so the implementation tail goes to it. Claude
Code fences a helper's edits in the main checkout until it enters a worktree,
so what it implements lands as a pull request from that branch.

**Instructions.** The numbered instructions of the Dispatch prompt, spelled as
message text with the absolute proposal path written out (an `@` path attaches
nothing across sessions), with two changes:

- Step 1 adds: before editing, re-verify every cited path and symbol against
  the current code, since the investigation may predate later commits. If the
  proposal is already done, its paths are stale, it is too vague to act on, or
  a file it must change is gitignored (`git check-ignore`) and so cannot land
  through a pull request, stop and report that as the verdict instead of
  implementing.
- After verification: commit on the worktree branch and open a pull request
  from it; never merge. Name the pull request link on the `Evidence:` line of
  the `GUEST_REPORT:`.

**Delivery.**

First read `.hermit/state/monitors.runtime.json`. A `peer-idle`
entry whose `target` is `<n>` means the helper is still on an earlier turn:
triage without `purpose`, or implementation with `purpose: "implement"`.
Send nothing: no `SendMessage`, no resume, and no Fallback. Keep the record from step (a) open. Tell the operator which of the two the helper is still doing and that
they can ask again to implement once its report lands (that re-entry is
`accept PROP-NNN --answer "implement now"`); `/hermitd:watch stop <id>` clears the entry if it is stale.
With no such entry, continue below. After a successful send or resume to `<n>`,
bind the record step (a) opened with
run `task-note` (Commands) with arguments `<record> --owner helper:<n>`.
On `invalid-owner` or `owner-busy`, leave it resident-owned and note why.

- `<n>` has a `ListAgents` row: run spawn-session
  § Follow-ups, "Resume with new instructions" with the instructions, note
  "Implement PROP-NNN", and `--record <id> --proposal PROP-NNN --implement`,
  where `<id>` is the record step (a) opened. No `followup` is stored for a
  resume. A launched resume counts as reached for the no-double-Dispatch rule;
  launch failure or unexpected output goes straight to the Fallback. If still
  listed after the stop, use the next bullet's checks and Fallback before any
  resume. If not ready (busy, blocked, background or scheduled work) or it has
  no bg row, a listed session is messaged, not resumed, because resuming a
  running session starts a copy: `SendMessage` it the
  instructions with `notify_when_idle: true` on that same send. Then read
  [watch/SKILL.md](../watch/SKILL.md) for its shared rules and
  [watch/session-watch.md](../watch/session-watch.md#registering-an-existing-idle-subscription)
  § Registering an existing idle subscription with this send's result and sent
  text. Set `record` to the record step (a) opened, `proposal` to PROP-NNN and
  `purpose` to `implement`, so the relay records implementation and can retry
  a blocked follow-up once.
- No row ([watch/SKILL.md](../watch/SKILL.md) § Branch instructions leaves an idle helper for the
  supervisor to reclaim): a line with no `(<sid>)` has no resume handle, so
  take the Fallback. `ListAgents` omits a helper stalled at boot or still starting, so first run
  `claude agents --json | jq -r --arg sid <sid> '.[] | select(.id==($sid|.[0:8])) | .id'`
  (the bg id is the sid's first 8 characters and survives a `/clear`, which
  changes the listed `sessionId`): any line means it is still running but unreachable, and resuming it would
  start a copy, so take the Fallback. Otherwise its transcript still resumes
  by the line's `<sid>`. From the project root run
  `claude --bg --resume <sid> '<the instructions>'` with no other flag: the
  saved options include the helper system prompt, and any extra flag starts a
  copy that drops them all, name, permission mode and folder included. A
  running session must not be resumed because that starts a copy. The instructions are one single-quoted
  argument, so replace every `'` in them with `'\''` first, as spawn-session's
  limits require. Then invoke
  `/hermitd:watch session <n> "Implement PROP-NNN" --record <id> --proposal PROP-NNN --implement --id <bg-id>`,
  where `<id>` is the record step (a) opened, not the hand-off line's helper
  record. Use the first 8 characters of `<sid>` as `<bg-id>`.

**Fallback.** A send that errors or a resume that fails to launch never reached
the helper: run the falsification gate, then Dispatch. Once they have reached
it (the send succeeded or the resume launched), never also Dispatch, or two
agents implement the same proposal. If the relay is operator-only or the watch
declines, note on the record that `<n>` is implementing unwatched and tell the
operator.

**After the report.** The relay files it on the record and notes the pull
request on the proposal, which stays `accepted`. Run
`/proposal-act resolve PROP-NNN` once the pull request merges, as the Dispatch
path does on `Status: implemented`. A report saying the change cannot land
through a pull request takes the fallback: falsification gate, then Dispatch.
