# Task records

A commitment lives in `.hermit/tasks/T-YYYYMMDD-HHMMSS[-x].md`. `scripts/task.ts` is the only writer. The record has a title, requester, definition of done (`summary`), owner, due date, conversation and optional approver. Status is `open` or `closed`; a closed record names its actor and `closed_by`: `check`, `confirmed` or `cancelled`. Passing time never closes a record.

## Record and CLI

Frontmatter contains scalars and flow arrays, with nullable fields set to `null`. Older records gain missing nullable fields on decode. The body contains Progress, Decisions, Approvals, Outcome and Lessons. Appending through the writer creates a missing section. Free text is normalized by the record codec.

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts <verb> .hermit ...`. State targets are pinned to the current project; writes are locked and atomic. A contract violation prints `{"error":"<code>"}` and exits 1. A refusal the record's state causes (`not_found`, `not_open`, `owner_busy`, `stale_result`, `approver_required`, `check_needs_evidence`) prints `{"status":"refused","reason":"<code>"}` and exits 0, as do `task-check.ts` (`stale_check`, `no_open_check`) and `duties.ts record` (`watch_not_found`).

| Verb | Contract |
| --- | --- |
| `open` | Requires `--title`, `--requester`, `--done`. Optional `--owner`, `--conversation`, `--card`, `--approver`, `--due`, `--claim`, `--dedupe-key`, `--check`. A matching open dedupe key returns the existing record. |
| `note <id>` | Appends stdin to Progress; handing a record back from a worker with `--owner` stores that worker's id as `last_worker`. Metadata flags include `--due`, `--card`, `--done`, `--check`, `--clear-waiting`; `--decision` and `--approval` target their sections. Decisions lines surface in task reports and routine briefs. A changed definition of done bumps `result_rev` and clears the result. `note --done` clears the check unless the same call sets one. |
| `lesson <id>` | Appends stdin under Lessons. |
| `block <id>` | Records `--waiting-on` with `--status-line` and `--next`, or posts a result with `--result-stdin`. A posted result increments `result_rev` and stays open as unconfirmed. |
| `close <id>` | `--local` acts as `operator` on a typed terminal turn. Confirmation requires an authorized actor, any named approver, and the matching result revision when a result was posted or a revision is passed; with no posted result, the requester's quoted word is enough. Check closure requires verified evidence from a held claim or the matching duty. A named approver blocks check closure. |
| `cancel <id>` | Requires actor and reason on stdin. Cancellation is separate from successful completion. |
| `decide [<id>] <token>` | Resolves `yes`, `no`, a positive option number, `close`, or `cancel` against current state under the task lock. `close` and `cancel` require an id. Only the matching typed `/hermitd:task-decide` authorizes this command. |
| `dismiss <id>` | Cancels an open proposal, pending or accepted, as the operator, with the reason on stdin; a pending one records `Consent declined: <reason>`. Refuses any other record with `not_proposal`. It can only cancel. |
| `list` | Supports `--open`, `--all`, `--owner`, `--conversation`, `--requester`, `--handle`, `--id`, `--dedupe-key`, `--with-check`, `--limit` (default 20), `--json`. JSON includes owner, last_worker, result (first line, at most 200 characters), result_len (full stored character length), waiting_on, closed_by, check, conversation, card_chat_id and card_message_id. |
| `standup` | Reports windowed costs and commitments by person, with closed records grouped by closure actor type. Supports `--days` and `--json`. |
| `check-snapshot <id>` | Returns check, result revision and status for the gated runner. |

A runnable record is open, resident-owned, without a result or waiting dependency. It is labelled queued only if an earlier runnable record exists. A record with a result, a check, no waiting dependency and no named approver is labelled finishing instead of unconfirmed: it was approved and closes by `check` once the daily run sees the outcome, or shows late after its due date. Close and cancel return `next_queued: {id, handle, title} | null`; continue with that record in the same turn. Heartbeat nudges a runnable record after `tasks.queue_nudge_minutes` (default 60). Its acknowledgement token hashes id, opened time and result revision; changing the record invalidates an old acknowledgement.

## Evidence commands

`bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-check.ts <id>` snapshots an open record with a check, scans the command for injection, then runs it from the project root with a 30-second default timeout and bounded output. It never holds the task lock across the subprocess. The internal result mutation rechecks command, status and result revision under the lock. Changed evidence returns `stale_check`. Exit 0 closes by `check`, actor `hermit`, reason `check:exit-0: <first 200 characters of output>` (or `check:exit-0` when the check printed nothing), with the full output in the Outcome section; on a record with a named approver it instead records progress and clears the check, leaving the record open; other exits append progress.

The result mutation is not exposed by the pre-approved task CLI. The command runner has no permission allow-list entry. The daily later check lists open records with checks and results and invokes the gated runner.

## Execution and context boundary

`state/execution.json` records `in_flight`, `idle` or `unknown`, with observation time and Claude session identity. Prompt admission marks a resident turn in flight; Stop and StopFailure mark idle; boot and automatic compaction mark unknown, while `/clear` and a manual `/compact` mark idle because they run only between turns. Stale in-flight observations become unknown. Guests do not write this state.

The safe boundary requires idle for at least 60 seconds, an identity matching runtime `cc_session_id`, no running task worker, and an idle or shell registry entry when the resident PID has one. A configured token floor must also be met. Unknown never becomes idle through registry fallback. List and standup can display `execution: unknown (registry: <status>[, <waitingFor>], live process)` to explain an unknown observation.

The standalone watchdog clear additionally requires operator quiet, context age or changed policy. Defaults are one quiet hour, maximum age 24 hours and 20,000 compactible tokens. Policy hashes cover OPERATOR.md, TASKS.md, CLAUDE.local.md, settings and configuration, excluding machine-maintained channel routing and version keys. Clears are locked and deduplicated per reset. Monitor rearming uses the same safe execution boundary.

## Cost and readers

Progress-bearing writes bind task ids to the current turn, except guest helper report submissions, which leave the resident’s task-turn binding untouched. Matching cost rows carry `bucket: tasks`; shared rows allocate cost and tokens equally across their task ids. Otherwise channel conversation work is `conversation`, while heartbeat and routine work is `duties`. A worker's rows match the record it was dispatched with. The version-4 cost index stores date-keyed `by_task` buckets for 90 days; wider windows fall back to a scan using the same allocator. This is attribution, not a separate provider bill.

`scripts/lib/task-report.ts` normalizes records for brief, reflect, weekly review, cost report, health, MCP, export and dashboard. `done` means check or confirmed, `cancelled` remains distinct, and a result on an open record is `unconfirmed`. Lessons and decisions come from the record body. Readers use task records only. Recall also searches retained historical archives.

`brief-digest` is the supported bounded input for custom briefs. Local skills call `.hermit/bin/hermitd-run brief-digest .hermit <mode>` from the project root, with `morning`, `evening` or `daily` as the mode. Choose exactly one selector. `--routine <id>` uses the routine's chat or the pinned home; `--chat <source:chat_id>` uses the answering message's conversation key (including `~<thread>` when applicable). `--agent` covers the whole agent for terminal and Remote Control callers. Without a selector it returns `needs_selector`. `context` in place of the mode returns exactly `scope` (`agent` or `chat`), `agent_steps` (true for a whole-agent brief or one to the home chat) and `destination` (the selected key or null), so a caller can resolve scope before any agent-wide steps. Each digest also includes `scope` and `agent_steps`. It returns data only: task outcomes, open work (including `delegated` helper/worker rows and results or waits they hold), recent decisions, duties and morning proposals, with `omitted` counts for clipped text or excluded items. Chat-scoped output follows recall scope plus the selected chat's public threads; duties and proposals are empty when `agent_steps` is false. Morning considers open records and the 20 most recently closed. Records whose chat cannot be resolved are excluded, and open ones are counted in `omitted.open`. Its JSON stdout, including the newline, stays at or under 25,000 bytes. Treat `result_truncated` as an excerpt, never complete evidence, and tell the operator when anything was left out. Other views remain available through `task-report` and `task.ts`.

SessionStart injects TASKS.md beside operator policy, with a pointer after compaction. Duty summaries combine requested schedules and effective heartbeat mode with observed liveness and verdicts. Effective forced mode applies only to the boot that issued it.

## Channel workflow

Before replying, the responder lists open records for the conversation and records operator activity. TASKS.md decides whether an assignment needs a record. In a guild text or announcement channel, the assignment opens its own thread first (a message explicitly requesting separate tasks gets one thread per task, the first started from the message and the rest standalone); the record's `conversation` key is that thread, and `owner` is one of `resident`, `worker:<agentId>`, or `helper:<name>`. A worker holds it until returning its report; a spawned session holds it until the record closes, and only when the requester explicitly asks for a session. At most one open record can belong to each non-resident owner. A real thread holds one open task. Continuations steer it; unrelated one-off answers open nothing. New work meeting TASKS.md’s threshold in a busy thread gets its own top-level card and thread. A Discord forum post cannot host a second task. Chats without threads share several records: the hook lists the newest five with totals, and the agent routes continuations or dispatches independent new work at once. Only explicit “after this” work queues. Replies name the task when several are open. The boundary reports `worker-running` while a worker owns an open record. A helper owner does not trigger that boundary. Replies in an open thread reach the resident; authorization still applies and unrelated passive chatter remains blocked. A message outside any task thread from a requester whose spawned sessions hold open records carries those records, and an assignment that continues one of them steers that session instead of opening a record.

A confirmed result closes only the matching revision. Any clear acceptance of a posted result, in any wording or language, confirms it; a named approver confirms in their own words and blocks check closure. The task skill runs a record's check when the result is recorded; the daily run is the fallback. Any authorized human in the conversation can steer a record; a named approver restricts confirmation. Duties may open deduplicated records for work requiring a person when `tasks.duties_open_records` is enabled.

A task thread with a bound session works like a Projects thread: follow-ups go to that session, which answers with its working context. Confirmations, parking and conversation commands stay with the resident. Authors choose `result`, `needs-input` or `note` when submitting; watched and unprompted reports use the same command and owner check. The resident updates the card on each report. Approvals are given directly in the session through `claude attach <id>` or Remote Control, never relayed through the task thread. The next phase can bind the same session to its new record.

## Learned-skill reviews

Records persist `delegated` (default `false`). Ownership by a worker or helper sets it permanently, as does opening a record with a `helper:` dedupe key. Successful closure, including a passing check, flags a best-effort review when `skills.learning` is enabled, `permission_mode` is `auto` or `bypassPermissions`, and the task was delegated or ten resident tool calls occurred while the record was open. Attempts, including failed or denied calls, and unrelated work count. Cancellation never triggers learning.

The close or check digest carries `next`, naming the absolute path of the review guide. The resident follows it once in the main session before replying. Nothing is persisted on the task, a lost review is not resumed, and the skill ledger alone records changes. Old review fields are ignored and dropped on the next record write. With `skills.notify: on`, the close reply mentions learning only when a skill changed; `verbose` adds a short preview and `off` adds nothing.

Helpers and workers submit once with the body on stdin:

```bash
.hermit/bin/hermitd-run task report .hermit <task-id> --as helper:<name> --kind result <<'REPORT'
The review is ready.

1. Confirm the proposed name.

The existing configuration supports it.
REPORT
```

Workers use `--as worker`; `needs-input` records a requester wait without setting a result, and `note` records progress tagged with the author. Results reuse `block --result-stdin`, including consent checks, decision generations and `result_rev`. A multiline result is stored as a JSON-quoted scalar and round-trips exactly; Progress, Decisions and Outcome notes stay on one line. Without a task, a helper uses `task report .hermit --no-task --as helper:<name>` and the ordinary operator-notice client route.

The script chooses a ten-character report id and writes immutable `helper-reports/<id>.md`, with task and author binding in `<id>.json`. No operator-authored path selects the file. Empty or over-64-KB input, a closed task, or an owner mismatch is refused before storage or delivery. Proposal consent refusals also store and send nothing.

The JSON receipt is `{report, task, recorded, result_rev, delivery}`. Delivery is `sent`, `partial`, `failed`, `relay` (no script send path) or `no_channel`. Expected outcomes exit 0. Delivery follows the record’s conversation and thread after recording; shared-chat reports receive the task handle and title. A capped Discord send counts as sent, and the complete report remains stored. The resident handles cards, checks and closure from the receipt, reading the body only for `relay`. A failed or partial send gets a one-line operator notice; authors never resubmit.

## Proposals and durable questions

A proposal is a task the agent opened, waiting on a decider. It has `kind: proposal`, requester `agent`, an admin consent decision and no named approver. Its body is under `## Proposal`. `proposal.ts create` returns `{id, handle}` and records creation metrics in one invocation. Open and cancelled proposals latch their dedupe key; completed ones do not block a new proposal.

`task answer [<id>] --chat <key> --user <sender-id> --reply '<token>'` is the only typed-decision answer path. The model maps meaning in any language to yes, no, a number or an option label; the script matches tokens and checks authority. Consent yes records approval and makes the task runnable; consent no cancels with a reason. Input records the answer and resumes its procedure, so input no is not cancellation. Result acceptance closes the matching result revision. Ambiguous, refused and stale verdicts change nothing. Candidates are isolated to the asking conversation, with unbound admin decisions available to a primary sender outside threads. An id-less answer in a thread matches only that thread; for an unbound decision in a thread, name the id.

A proposal is accepted at the admin's first instruction to implement or ship it, or approval of a plan for it, in any language; the agent records that consent in the same turn. Investigating, evaluating or planning it never accepts it. Checks, closes, cancels, clear-waits and blocks that would bypass missing consent refuse with `consent_required`.

Attaching the first check to an approved proposal keeps consent. Replacing or clearing an existing check, or changing `--done`, opens a new consent generation. A result block opens a result decision and an input block keeps consent; a consent block reopens consent. Proposal waits always name decision authority, never agent. Passing checks close approved proposals unless a result decision is pending; authored content returns for admin acceptance.

Each decision generation receives at most two confirmed deliveries. The send script owns counting. Failed or degraded sends consume none. Admin decisions use the maintainer chat, else the home chat on every profile; other decisions use their record's chat. After two deliveries, scoped briefs, status and the dashboard list the wait quietly. Questions never expire.

From the terminal use `task answer <id> --local --reply <token>`, `task close <id> --local --by confirmed --reason-stdin` to confirm a close, and `task dismiss <id> --reason-stdin` to drop a proposal. These act as admin (`operator`). On a turn the operator typed in the terminal they run without a permission prompt, except that bypass mode refuses a local answer. On a chat turn the settings hook denies them and points the agent to the sender-attributed `--chat`/`--user` path. Any other turn (a wake, a peer session, a turn another sender joined, or one whose transcript cannot be read) asks for Claude Code's permission, and bypass mode refuses it. Never combine `--local` with `--chat` or `--user`.

The operator can type `/hermitd:task-decide [<id>] yes|no|<n>|close|cancel` instead, including in bypass mode. The typed command acts on the record's current state when run, with no stale check. `close` keeps the named-approver rule; a result `yes` follows `task answer`'s decider-or-admin rule. Protected closes and cancels derive the actor from the verified sender's `--chat` and `--user`; a different explicit actor is refused. A no-sender protected close or cancel reports `needs:"chat,user"` with `not_decider` when consent is already satisfied.
