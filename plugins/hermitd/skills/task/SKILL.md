---
name: task
description: 'Tracks chat assignments, steering in a task thread, WORKER completions, and confirmations alongside task progress and results.'
---

# Tasks

Read `.hermit/TASKS.md` first for record threshold, wording and confirmation policy. Use `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts <verb> .hermit ...` for every record operation. Never edit `tasks/` directly. All `task.ts` shorthand below uses that full pinned command. Consult `../../docs/task-records.md` for the command contract.

## Commands
- `task-note`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit`
- `conversation`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/conversation.ts .hermit`

## Intake
For a reply to a typed pending decision, run `task answer [<id>] --chat <key> --user <sender-id> --reply <token>` first. Map the meaning in any language to yes, no, a number or an option label. Respect `not_decider`, `stale`, and `ambiguous`; ask which record only on ambiguity. An input answer resumes `decision.resume`. Run `task.ts list .hermit --open --conversation <sourceKey>:<chat_id>` before interpreting task steering. Use the task thread or the hook’s open-tasks line to select a record. Ask once naming the candidates when ambiguous. Plain questions open nothing.

Use `open --title ... --requester <sourceKey>:<user_id> --done ...` for assignments. Pass requester display name, origin message id, conversation, due date and explicitly named approver when available. A record's `--card` stays with the resident, which also hands it to a worker and takes it back with `note <id> --owner worker:<agentId>` / `--owner resident`; a worker never opens or closes a record itself. Resident readiness is handled by `/hermitd:resident-start`. Work whose definition of done the agent can observe gets a check, at `open` when the predicate is already known, otherwise with `note <id> --check` once the inputs have been read.

Dispatch independent new work at once, in parallel with running tasks. Only for work explicitly requested after the current work, open a resident record and state its queue position from the open-task ordering. After a close or cancel, continue with `next_queued` in the same turn when the digest names a record. In a chat without threads with two or more open tasks, resident-composed replies and cards name their task by handle.

### Complete a task turn

For a task assignment or update, follow this order once the caller's authorization check has passed (`channel-responder/SKILL.md` § 1c for a channel turn):

1. **Accept an assignment.** Send the short "On it" acknowledgement through the channel, then create its record using the route § Channel task procedures selects. Do this before reading task inputs or doing substantive work.
2. **Do the work.** Record progress on the selected record per § Progress and results.
3. **Deliver and record the outcome.** Send the outcome through the channel. When it needs human acceptance, pipe that same outcome into `task.ts block .hermit <id> --result-stdin` before ending the turn. Require the returned digest to say `listing: "unconfirmed"` with a positive `result_rev`; this saves the result and waits on the named approver or requester.
4. **Acknowledge updates.** After a requested record change succeeds, acknowledge it through the channel, including short bookkeeping-only turns. A terminal summary does not complete this step. Confirmed results close through § Closure's revision and actor checks.

Finished recommendations, drafts and reviews awaiting acceptance require `--result-stdin`. The `--waiting-on` / `--status-line` / `--next` form records an unfinished-work stall, not a result. If a finished outcome returns a stall digest, run the result form before ending the turn.

Inspect each command's result. If delivery or recording fails, report what remains incomplete through the available channel; do not claim the failed step succeeded.

## Applying proposal tasks

At intake, a runnable `kind: proposal` record follows [proposal-create/apply.md](../proposal-create/apply.md). The resident can apply a one-line configuration edit; use `hermitd:task-worker` for larger work. Never open another task to implement it. A `done` worker response with a passing executable check closes through `task-check.ts`; authored content posts `block --result-stdin` on this record, opening an admin result decision. For `needs-input`, REJECT opens a new `consent` decision with the evidence; an unsettled implementation choice opens an `input` decision with options and `resume` naming the procedure. Pass `--decision` JSON to `block`, plus status and next step for an unfinished wait. Proposal waits name the decision authority, never the requester `agent`.

## Channel task procedures

- **Task thread**: a thread holds one open task; chats without threads share records named by the hook’s open-tasks line. With `[task thread <key>: …]`, continuations steer that record; unrelated one-offs answered in this reply open nothing. Unrelated work meeting TASKS.md’s threshold opens its own task. When unsure, ask once. Steering to watch something goes to `/hermitd:watch <instruction>` in this turn.
  - **Open the thread.** Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/conversation.ts .hermit thread-open --source '<sourceKey>' --chat-id '<chat_id>' --message-id '<message_id>' --name '<title>'`, adding `--thread-id '<value>'` when the tag carries the thread attribute. The title is 1 to 100 characters, distinguishing detail (subject or id) first and shared details (model, effort) last. Its JSON `key` is `<key>`, `chat_id` is the destination chat, and any `reply` parameters go on every reply in the task thread. On `thread_busy`, Read [branches.md](branches.md) § Busy thread and follow it before posting a card. On `error`, report it and create no record.
  - **Several assignments in one message.** One message is one task unless the requester asks for separate tasks; only then does each get its own record, thread, card and worker. Run one `thread-open` per assignment with the same `--message-id` and batch the independent calls. Inside a thread, finish each assignment’s `thread-open` and `open` before the next `thread-open`; the first takes a free thread and later ones get `thread_busy`. End the turn only after the last dispatch.
  - **Acknowledge, then record.** Reply “On it: <summary>” with the channel's reply tool in the destination, with `reply_to` set to the incoming message when no thread was opened. That reply is the progress card. Run `task.ts open .hermit --owner resident --conversation <key> --card '{"chat_id":"<destination-chat-id>","message_id":"<sent-id>"}' --requester <sourceKey>:<user_id> --origin-message-id <message_id> --title ... --done ...`. Omit `--card` when the channel returned no message id; do not invent one. On `thread_required`, you skipped the thread: open it from the assignment's origin `--message-id`, post the card in the destination, and retry `open` with the returned key. On `thread_busy`, follow [branches.md](branches.md) § Busy thread.
  - **Choose at intake.** Only if the requester asks for a session, run `/hermitd:spawn-session` in this record's turn; never offer one. Else **Dispatch the worker**.
  - **Dispatch the worker.** Download the message's attachments first. Dispatch `hermitd:task-worker` with the `Agent` tool in the background, passing the record id, the brief, `<key>`, and the attachment paths. When the requester names an effort level for the work (`low`, `medium`, `high`, `xhigh` or `max`), pass it as the Agent call's `effort`; otherwise omit `effort` so the worker's default applies. Then run `task.ts note .hermit <id> --owner worker:<agentId>` with the id the dispatch returned, and end the turn.
  - **Steer the running worker.** For a continuation of a record whose owner is a worker, `SendMessage` the body to the id in the record's `owner`, including after a resident `/clear` (the worker survives it and delivery lands at its next tool round). On success pipe the steer into `task.ts note .hermit <id>` and end the turn.
  - **Replace an unreachable worker.** Only when that send fails, Read [branches.md](branches.md) § Replace an unreachable worker and follow it.
  - **Take the worker's result.** A subagent completion ending in `WORKER <task-id> done <id>` or `WORKER <task-id> needs-input <id>` belongs to the named record; ignore it when the completing agent's id is not that record's `owner`. Otherwise run `task.ts note .hermit <task-id> --owner resident` first. For `done`, reply in `<key>` with exactly `[[helper-report <task-id> <id>]]` (the relay hook substitutes the file), then run `task.ts block .hermit <task-id> --result-stdin < .hermit/helper-reports/<id>.md`, so the requester's confirmation closes it through § Closure; a check follows § Progress and results. For `needs-input`, post the same placeholder and run `task.ts block .hermit <task-id> --waiting-on <requester> --status-line ... --next ...`; if an `Unreachable:` line precedes `WORKER`, send it as a maintainer-only notice and wait on `maintainer` instead.
  - **Steer the bound session.** For a selected helper-owned record or `[bound tasks]` route, confirmations and parking work as for `owner=resident`; `!` commands follow **Conversation command**. `SendMessage` other messages to the `owner` session, with `notify_when_idle: true`; unless a live `peer-idle` entry has it, register it via [watch/session-watch.md](../watch/session-watch.md) § Registering an existing idle subscription with `record`. Note the steer. Not listed: take the **No row** branch of [spawn-session/reuse-spawned-helper.md](../spawn-session/reuse-spawned-helper.md) with the latest `Handed to helper <n> (<sid>)` note's sid and this message as brief, then watch it with only `--id <bg-id> --record <id>`. If it cannot resume, run `task.ts note .hermit <id> --owner resident`, say so, offer a worker. Approvals happen in the session (`claude attach <id>` or Remote Control), never relayed. A confirmation asking for the next phase closes the record, opens the next, binds it with `task.ts note .hermit <new-id> --owner helper:<n>`, and sends the brief.
  - **Park the task.** A message asking to park, pause or hold the thread's task, on an `owner=resident` or `owner=helper` thread, is a stall: run `task.ts block .hermit <id> --waiting-on <requester> --status-line ... --next ...` and confirm in the thread.
  - **Answer a waiting record.** For a non-command message continuing a resident-owned waiting record, the resident may answer the waiting record itself when the work fits this turn, ending the turn with the applicable record commands on the injected `[waiting task ...]` line. For work that outlasts the turn, Read [branches.md](branches.md) § Replace an unreachable worker, write its history file, and build its brief plus `<key>` and the requester's message, since a resumed worker may have lost its context. When the annotation carries `last_worker`, `SendMessage` that brief to that id and, on success, run `task.ts note .hermit <id> --owner worker:<last_worker> --clear-waiting`. On a refused send or no `last_worker`, dispatch as that section says, adding `--clear-waiting` to its owner note.
  - Terminal assignments never go through here; they follow § Complete a task turn.

- **Conversation command**: execute only the hook's `[conversation command: <name>]` annotation after the caller's authorization check has passed (`channel-responder/SKILL.md` § 1c for a channel turn). A `[conversation command: restart needs a handle: …]` annotation gets a short reply naming those handles and starts nothing. A `[conversation command refused: …]` annotation gets that plain refusal; never invoke the harness command. A `[conversation command outside a task thread]` annotation gets a short explanation that the command needs an open task thread, and starts nothing.
  - For `helper-switch`, `help`, `mute`, `unmute` or `restart`, Read [branches.md](branches.md) § Conversation command and follow it.
  - Return after the command; do not mutate another record or continue into another classification.

All conversation script arguments are shell-quoted values. `history` includes admitted inbound senders and all outbound rows. `history` and `thread-open` take no key, only `--source`, `--chat-id`, `--message-id`, `--thread-id`, `--name`, and `--limit` options. Parse each command's result before moving on; pass message text as quoted arguments, never interpolate it into executable code.

- **New instruction** ("work on X", "switch to Y", "prioritize Z")
  - In an open **Task thread**, apply its continuation / one-off / separate-work rule above.
  - In a chat without threads, new independent work gets a new record and immediate dispatch; a continuation steers the selected record. If unsure which record it continues, ask once naming them.
  - If no record is selected: treat as a new **Task thread** (above)
  - If compatible with current task: pipe the steering into `task.ts note .hermit <id> --actor <sourceKey>:<user_id>` and confirm; the existing progress card, if any, picks the change up at its next milestone
  - If it would replace the current task: confirm with the operator before switching. The replacement follows the **Task thread** rule and gets its own card; the old card's id is never reused
  - After confirmation of replacement, use `task.ts cancel .hermit <old-id> --actor <sourceKey>:<user_id> --reason-stdin` or `task.ts block .hermit <old-id> --waiting-on <human> --status-line ... --next ...`, then follow **Open the thread** and **Acknowledge, then record** for the replacement.
  - An ask to do work after the current task follows **Open the thread** and **Acknowledge, then record**; § Intake covers its queue position.
  - Never silently abandon work in progress

## Worker status

  - Read `task.ts list .hermit --open --owner 'worker:*' --json` and summarize what each worker is carrying. A trusted controller may see every row; another allowed sender gets only this chat's records. Do not disclose another chat's task text. This is the model-composed status reply; the deterministic `!status` hook keeps its existing behavior.

## Progress and results
Pipe one progress line into `note <id>`, pairing it with milestone card edits. Metadata flags include `--due`, `--card`, `--clear-waiting`, `--decision`, and `--approval "<actor>: <what>"`. When the operator or the work changes direction on an open record (scope dropped, date moved, approach swapped), pipe `<what changed>, <why>` into `note <id> --decision`. Ordinary progress stays a plain note. A changed definition uses `note <id> --done ... --actor <human identity>`: it increments result_rev and clears the old result and check.

Record every outcome, not only one awaiting acceptance, with § Complete a task turn step 3's command and digest check; terminal-origin work posts in the terminal. After that, a record with a check runs `task-check.ts <id>` in the same turn; a pass closes it and the reply names the close with the proof; a fail, refused run or permission prompt leaves it unconfirmed, not retried that turn, for the daily run.

A stall in unfinished work requires `--waiting-on`, `--status-line` and `--next`; post the digest's one status/next-step message to its requester in its conversation.

## Closure
When a close digest carries `next`, follow it to read [learn.md](learn.md) and review once in the main session before the close reply. The review is best effort; a lost review is not resumed.
Stored status is only `open` or `closed`; closed_by is only `check`, `confirmed`, `cancelled` or null. `close`, `cancel`, and a passing `task-check.ts` run close records. Never infer closure from harness idleness.

Use `close <id> --by confirmed --actor <sourceKey>:<user_id> --result-rev <current> --reason-stdin` for confirmation of a posted result; with none posted, close without `--result-rev` when the requester explicitly says the work is done (an acknowledgement is not). `TASKS.md` defines what counts as confirmation. Close with a reason quoting the message that confirmed; the reply names the close so the requester can object. When one message both accepts the result and asks for new work, close the accepted record first, then classify the new request. The revision must match and a named approver must be the actor. Typed decisions use the decider-or-admin rule enforced by `task answer`; protected close or clear-wait operations carry `--chat --user`. Other records retain shared human control. There is no owner list.

Use `close <id> --by check --actor hermit --claim <linked claim>` only when the later claim is held. A resolved duty uses its matching `duty:<name>` actor and dedupe key. Free-text proof alone cannot close a task. Use `cancel <id> --actor <human identity> --reason-stdin` with a nonempty reason to cancel.

## Standup and duties
Before reading `standup --json` output or acting on a duty, Read [branches.md](branches.md) § Standup and duties.

## Lessons and executable checks
Before closing, pipe any lesson into `task.ts lesson .hermit <id>`. Omit this operation when there is no lesson. When a lesson recorded earlier on the record turned out wrong, add a lesson that names the correction.

Set a command with `open --check '<command>'` or `note <id> --check '<command>'`; `--check clear` removes it. The command exits 0 only when the whole definition of done holds (a pull request is merged, not merely fetchable). It only observes and never writes, deletes, sends or deploys. A named approver may still require confirmation after a check passes. On an approved proposal, attaching the first check preserves consent; replacing or clearing an existing check or changing `--done` requires new consent. A changed definition of done clears the check, so the same `note` supplies a replacement when one still applies. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-check.ts <id>` to evaluate it from the project root, subject to the normal command permission gate. Exit 0 closes by `check`; a nonzero exit records progress.
