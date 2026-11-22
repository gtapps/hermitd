# Reuse a spawned helper

Use the eligible helper and bg id returned by intake, or the latest `Handed to helper <n> (<sid>)` note on the bound record, to locate the helper already working on this area. For a new assignment, use its new task record and conversation. Read [watch/session-watch.md](../watch/session-watch.md) and use the Commands from the calling skill. It is one helper, never a second implementation task.

Resolve `<n>` through `claude agents --json`. Bind the current record to `helper:<n>` before sending or resuming. On a successful handoff append `Handed to helper <n> (<sid>).` to this record with the full session id, when available. Read `task list --id <T> --json` before sending or resuming and pass its `report_id` as `prior_report` (explicit null when absent). A listed helper, idle or busy, receives the current record id, its helper name for `--as`, the operator language, bounded re-check evidence and the operator’s follow-up verbatim through SendMessage to its session name with `notify_when_idle: true`. Do not resume a running session: resume starts a copy. On a successful send, record the steer with `task-note` (Commands) and register its existing idle subscription using `--id <bg-id> --record <task-id> --prior-report <id|null>`.

## No row

If the row is gone and the note contains a full session id, run `claude --bg --resume <sid> '<instructions>'` from the project root, with no other flag; saved options carry its system prompt, name, permission mode and folder. An instruction argument is single-quoted with each apostrophe escaped as `'\''`. Never use the short bg id as a resume handle. The instructions carry the task id, `helper:<n>` and operator language. After resume, re-read the resulting session row, record its new full id and register the watch with the pre-resume baseline. A missing full id or failed resume returns the record to normal task intake.

The instructions require re-checking current References and Proposed Solution before editing, then the shared proposal apply procedure only for `kind: proposal`. Ordinary helper work follows the task brief. Worktree-bound edits keep the existing pull request and merge-check workflow. No permissions are relayed from chat.

A failed send or resume reached no helper: normal intake can dispatch a worker. Once a send succeeds or a resume launches, never also dispatch. An operator-only relay or declined watch leaves the helper running; record that it is unwatched and report that fact.

The helper follows [the helper prompt](../../prompts/helper.md) and ends on the same report it submits. The resident handles the idle notice per [watch/notices.md](../watch/notices.md). A passing executable merge check closes a proposal task; authored output opens an admin result decision. Route later work on a closed record as a new record bound to the helper.
