---
name: task
description: 'Tracks chat assignments, steering in a task thread, WORKER completions, and confirmations alongside task progress and results.'
---

# Tasks

Read `.hermit/TASKS.md` first for record threshold, wording and confirmation policy. Use `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts <verb> .hermit ...` for every record operation. Never edit `tasks/` directly. Consult `../../docs/task-records.md` for the command contract.

## Intake
Pending micro-proposal answers take precedence. Run `task.ts list .hermit --open --conversation <sourceKey>:<chat_id>` before interpreting task steering. An open task thread, an open handle, or continuation of the sole open task identifies the record. If multiple tasks are open without a handle or thread, ask one short question naming the handles. Plain questions create nothing.

Use `open --title ... --requester <sourceKey>:<user_id> --done ...` for assignments. Pass requester display name, origin message id, conversation, due date and explicitly named approver when available. A record's `--card` stays with the resident, which also hands it to a worker and takes it back with `note <id> --owner worker:<agentId>` / `--owner resident`; a worker never opens or closes a record itself. Resident readiness is handled by `/hermitd:resident-start`. Work whose definition of done the agent can observe gets a check, at `open` when the predicate is already known, otherwise with `note <id> --check` once the inputs have been read.

For work requested after the current work, open a resident record and state its queue position from the open-task ordering. After a close or cancel, continue with `next_queued` in the same turn when the digest names a record. Show the handle in cards and replies only when at least two tasks are open in that conversation; in DMs also require `config.tasks.handle_in_dm`.

### Complete a task turn

For a task assignment or update, follow this order once the caller's authorization check has passed (`channel-responder/SKILL.md` § 1c for a channel turn):

1. **Accept an assignment.** Send the short "On it" acknowledgement through the channel, then create its record using the route § Channel task procedures selects. Do this before reading task inputs or doing substantive work.
2. **Do the work.** Use `/hermitd:task` for progress and result operations on the selected record.
3. **Deliver and record the outcome.** Send the outcome through the channel. When it needs human acceptance, pipe that same outcome into `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <id> --result-stdin` before ending the turn. Require the returned digest to say `listing: "unconfirmed"` with a positive `result_rev`; this saves the result and waits on the named approver or requester.
4. **Acknowledge updates.** After a requested record change succeeds, acknowledge it through the channel, including short bookkeeping-only turns. A terminal summary does not complete this step. Confirmed results close through § Closure's revision and actor checks.

Finished recommendations, drafts and reviews awaiting acceptance require `--result-stdin`. The `--waiting-on` / `--status-line` / `--next` form records an unfinished-work stall, not a result. If a finished outcome returns a stall digest, run the result form before ending the turn.

Inspect each command's result. If delivery or recording fails, report what remains incomplete through the available channel; do not claim the failed step succeeded.

## Channel task procedures

- **Task thread**: one open record owns a chat. An assignment that meets the TASKS.md threshold opens it; every later message in a chat whose context carries `[task thread <key>: …]` belongs to it, including an assignment-shaped one: that is steering, never a second record.
  - **Open the thread.** On a Discord chat of type 0 or 5, run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/conversation.ts .hermit chat-lookup --chat-id '<chat_id>'`, then `thread-create --chat-id '<chat_id>' --message-id '<message_id>' --name '<title>'` with a title of 1 to 100 characters, distinguishing detail (subject or id) first and shared details (model, effort) last. The `OK|<thread-id>` is the destination chat and `<key>` is `<sourceKey>:<thread-id>`; on `ERROR|`, report it and create no record. Every other chat is its own thread, so `<key>` is `<sourceKey>:<chat_id>`.
  - **Several assignments in one message.** Each gets its own record, thread, card and worker. Run `chat-lookup` once, batch the independent calls across assignments, and end the turn only after the last dispatch. Every `thread-create` passes the same `--message-id`; once the message holds a thread, the next opens standalone in the same chat.
  - **Acknowledge, then record.** Reply “On it: <summary>” with the channel's reply tool in the destination, with `reply_to` set to the incoming message when no thread was opened. That reply is the progress card. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts open .hermit --owner resident --conversation <key> --card '{"chat_id":"<destination-chat-id>","message_id":"<sent-id>"}' --requester <sourceKey>:<user_id> --origin-message-id <message_id> --title ... --done ...`. Omit `--card` when the channel returned no message id; do not invent one.
  - **Dispatch the worker.** Download the message's attachments first. Dispatch `hermitd:task-worker` with the `Agent` tool in the background, passing the record id, the brief, `<key>`, and the attachment paths. When the requester names an effort level for the work (`low`, `medium`, `high`, `xhigh` or `max`), pass it as the Agent call's `effort`; otherwise omit `effort` so the worker's default applies. Then run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id> --owner worker:<agentId>` with the id the dispatch returned, and end the turn.
  - **Steer the running worker.** For a message in a thread whose annotation says `owner=worker`, `SendMessage` the body to the id in the record's `owner`, including after a resident `/clear` (the worker survives it and delivery lands at its next tool round). On success pipe the steer into `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id>` and end the turn.
  - **Replace an unreachable worker.** Only when that send fails, write `bun ${CLAUDE_PLUGIN_ROOT}/scripts/conversation.ts .hermit history --source '<source>' --chat-id '<chat_id>' --limit 100` to `.hermit/helper-reports/<id>-history.md` (it may be `[]`), dispatch a fresh worker with the record's notes and that path, and run `task.ts note .hermit <id> --owner worker:<new-agentId>`.
  - **Take the worker's result.** A subagent completion ending in `WORKER <task-id> done <id>` or `WORKER <task-id> needs-input <id>` belongs to the named record; ignore it when the completing agent's id is not that record's `owner`. Otherwise run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <task-id> --owner resident` first. For `done`, reply in `<key>` with exactly `[[helper-report <id>]]` (the relay hook substitutes the file), then run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <task-id> --result-stdin < .hermit/helper-reports/<id>.md`, so the requester's confirmation closes it through § Closure; a check follows § Progress and results. For `needs-input`, post the same placeholder and run `task.ts block .hermit <task-id> --waiting-on <requester> --status-line ... --next ...`.
  - **Park the task.** A message asking to park, pause or hold the thread's task, on a thread annotated `owner=resident`, is a stall: run `task.ts block .hermit <id> --waiting-on <requester> --status-line ... --next ...` and confirm in the thread.
  - **Answer a waiting record.** For a non-command message on a thread annotated `owner=resident, waiting=true`, the resident may answer the waiting record itself when the work fits this turn, ending the turn with the applicable record commands on the injected `[waiting task ...]` line. Work that outlasts the turn dispatches a fresh worker with the record's notes plus that message, then `task.ts note .hermit <id> --owner worker:<agentId>` and `task.ts note .hermit <id> --clear-waiting`.
  - Terminal assignments never go through here; they follow § Complete a task turn.

- **Conversation command**: execute only the hook's `[conversation command: <name>]` annotation after the caller's authorization check has passed (`channel-responder/SKILL.md` § 1c for a channel turn). A `[conversation command refused: …]` annotation gets that plain refusal; never invoke the harness command. A `[conversation command outside a task thread]` annotation gets a short explanation that the command needs an open task thread, and starts nothing.
  - `!help`: list `!help`, `!mute`, `!unmute`, and `!restart`. Say per-conversation `!model` and `!effort` are not supported and global controls still affect the resident.
  - `!mute` / `!unmute`: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id> --muted true|false`, then acknowledge. Muting suppresses unmentioned steering.
  - `!restart`: when the record's `owner` names a listed agent, stop it with `TaskStop`; no match means it is already gone. On a stop failure, report it and start nothing. Then dispatch a fresh worker as **Replace an unreachable worker** does, history file included, and run `task.ts note .hermit <id> --owner worker:<agentId>`.
  - Return after the command; do not mutate another record or continue into another classification.

All conversation script arguments are shell-quoted values. `history`, `chat-lookup`, `thread-create`, and `is-trusted` take no key, only `--source`, `--chat-id`, `--user-id`, `--message-id`, `--name`, and `--limit` options. Parse each command's `OK|`/`ERROR|` result before moving on; pass message text as quoted arguments, never interpolate it into executable code.

- **New instruction** ("work on X", "switch to Y", "prioritize Z")
  - A message in an open **Task thread** is steering for that record; it never reaches the rules below.
  - If no record is selected: treat as a new **Task thread** (above)
  - If compatible with current task: pipe the steering into `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id> --actor <sourceKey>:<user_id>` and confirm; the existing progress card, if any, picks the change up at its next milestone
  - If it would replace the current task: confirm with the operator before switching. The replacement follows the **Task thread** rule and gets its own card; the old card's id is never reused
  - After confirmation of replacement, use `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts cancel .hermit <old-id> --actor <sourceKey>:<user_id> --reason-stdin` or `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <old-id> --waiting-on <human> --status-line ... --next ...`, then `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts open .hermit --owner resident --requester <sourceKey>:<user_id> --conversation <sourceKey>:<chat_id> --title ... --done ...` for the replacement. Post a non-result stall digest's one status/next message to its requester in its conversation.
  - An ask to do work after the current task runs only `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts open .hermit --owner resident --requester <sourceKey>:<user_id> --conversation <sourceKey>:<chat_id> --title ... --done ...`; state its queue position from the open-record order when `queued:true`. After close or cancel, continue with `next_queued` in the same turn.
  - Never silently abandon work in progress

## Worker status

  - Read `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts list .hermit --open --owner 'worker:*' --json` and summarize what each worker is carrying. A trusted controller may see every row; another allowed sender gets only this chat's record. Do not disclose another chat's task text. This is the model-composed status reply; the deterministic `!status` hook keeps its existing behavior.

## Progress and results
Pipe one progress line into `note <id>`, pairing it with milestone card edits. Metadata flags include `--due`, `--card`, `--clear-waiting`, `--decision`, and `--approval "<actor>: <what>"`. When the operator or the work changes direction on an open record (scope dropped, date moved, approach swapped), pipe `<what changed>, <why>` into `note <id> --decision`. Ordinary progress stays a plain note. A changed definition uses `note <id> --done ... --actor <human identity>`: it increments result_rev and clears the old result and check.

Post an outcome through the originating channel's reply tool, then pipe that same outcome into `block <id> --result-stdin` before ending the turn. For terminal-origin work, post it in the terminal. Require `listing: "unconfirmed"` and a positive `result_rev` in the digest before claiming the result is recorded. Finished recommendations, drafts and reviews awaiting acceptance use this result form. After that, a record with a check runs `task-check.ts <id>` in the same turn; a pass closes it and the reply names the close with the proof; a fail, refused run or permission prompt leaves it unconfirmed, not retried that turn, for the daily run.

A stall in unfinished work requires `--waiting-on`, `--status-line` and `--next`; post the digest's one status/next-step message to its requester in its conversation. Those flags alone do not save an outcome. If a finished outcome produced a stall digest, run `block <id> --result-stdin` to record the result.

## Closure
Stored status is only `open` or `closed`; closed_by is only `check`, `confirmed`, `cancelled` or null. `close`, `cancel`, and a passing `task-check.ts` run close records. Never infer closure from harness idleness.

Use `close <id> --by confirmed --actor <sourceKey>:<user_id> --result-rev <current> --reason-stdin` for confirmation of a posted result. `TASKS.md` defines what counts as confirmation. Close with a reason quoting the message that confirmed; the reply names the close so the requester can object. When one message both accepts the result and asks for new work, close the accepted record first, then classify the new request. The revision must match and a named approver must be the actor. Any authorized human in the conversation may otherwise confirm, cancel, or change the definition of done. There is no owner list.

Use `close <id> --by check --actor hermit --claim <linked claim>` only when the later claim is held. A resolved duty uses its matching `duty:<name>` actor and dedupe key. Free-text proof alone cannot close a task. Use `cancel <id> --actor <human identity> --reason-stdin` with a nonempty reason to cancel.

## Standup and duties
`standup --json` groups promised, late and waiting work by stable identity. Execution is advisory. A shared turn divides its cost equally across its bound tasks; a missed progress note may bill to conversation. Older rows without buckets are pre-upgrade.

Duties open deduplicated records only when a human must act and `config.tasks.duties_open_records` permits it. Otherwise post plain messages. An ambiguous duty read never closes a record.

## Lessons and executable checks
Before closing, pipe any lesson into `task.ts lesson .hermit <id>`. Omit this operation when there is no lesson.

Set a command with `open --check '<command>'` or `note <id> --check '<command>'`; `--check clear` removes it. The command exits 0 only when the whole definition of done holds (a pull request is merged, not merely fetchable). It only observes and never writes, deletes, sends or deploys. A record with a named approver gets no check. A changed definition of done clears the check, so the same `note` supplies a replacement when one still applies. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-check.ts <id>` to evaluate it from the project root, subject to the normal command permission gate. Exit 0 closes by `check`; a nonzero exit records progress.
