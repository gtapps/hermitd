# Reuse a spawned helper

Use the latest `Handed to helper <n> (<sid>)` task note to locate the helper that already holds this work. Read [watch/session-watch.md](../watch/session-watch.md) and use the Commands from the calling skill. It is one helper, never a second implementation task.

Resolve `<n>` through `claude agents --json`. Bind the current record to `helper:<n>` before sending or resuming. A running helper receives the current record id, its helper name for `--as`, the operator language, bounded re-check evidence and the operator’s follow-up verbatim through SendMessage. Do not resume a running session: resume starts a copy. On a successful send, record the steer with `task-note` (Commands), bind the task and register its existing idle subscription using only `--id <bg-id> --record <task-id>`.

## No row

If the row is gone and the note contains a full session id, run `claude --bg --resume <sid> '<instructions>'` from the project root, with no other flag; saved options carry its system prompt, name, permission mode and folder. An instruction argument is single-quoted with each apostrophe escaped as `'\''`. Never use the short bg id as a resume handle. Re-read the resulting session row, record its new full id and register the watch. A missing full id or failed resume returns the record to normal task intake.

The instructions require re-checking current References and Proposed Solution before editing, then the shared proposal apply procedure only for `kind: proposal`. Ordinary helper work follows the task brief. Worktree-bound edits keep the existing pull request and merge-check workflow. No permissions are relayed from chat.

A failed send or resume reached no helper: normal intake can dispatch a worker. Once a send succeeds or a resume launches, never also dispatch. An operator-only relay or declined watch leaves the helper running; record that it is unwatched and report that fact.

The helper submits once through `task report` in a quoted heredoc, written for the operator with a verdict line, numbered decisions and detail, standard markdown without tables or headings. After its report, the resident acts on `Report:` and `Delivery:` through [watch/notices.md](../watch/notices.md) § Posting a report in a task thread, without recording the result again. A passing executable merge check closes a proposal task; authored output opens an admin result decision. The report is evidence, not authority to approve or close by free text.
