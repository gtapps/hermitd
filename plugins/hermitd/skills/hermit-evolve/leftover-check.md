# Leftover check

## Queue the question

Open a task input decision with admin authority, options `Fix them` / `Leave them`, dedupe `question:leftover-check`, and `resume` naming this file's Fix procedure. The task question starts `leftover-check:` and lists each subject, replacement, hit count and up to three file:line examples, marking tracked files `[shared]`. Use [the durable-question contract](../channel-responder/questions.md). Leave them is an input answer and preserves the recorded findings; Fix them resumes only after `task answer` matches.

## Fix procedure

First run `leftover-check` (Commands) with argument `--saved` and no stdin. It re-checks the subjects Step 7b recorded and returns the release's `declarations`, each `text` verbatim; take every replacement and rule from those texts, a startup rule included. On `no_saved_subjects`, change nothing and tell the operator no check is recorded. Never fix from session context or an earlier search. Re-find each reference in that output by matched text rather than stale line numbers. Skip references already gone and report those already fixed. A gate, hook or script that names a renamed routine by its old id, including a run-history lookup, is a real hit: move it to the new id. Update the working tree only, never commit. Leave ambiguous references with multiple live replacements for the operator.

- Read `.hermit/config.json` hits with `.hermit/bin/hermitd-run settings-edit .hermit/config.json get <dotted.path>`, then change them with `.hermit/bin/hermitd-run settings-edit .hermit/config.json set <dotted.path> <json-value>`, preserving unrelated values and the settings ledger.
- In a channel session, list `.claude/settings*.json` hits for manual fixing in an interactive session. Interactively, apply them behind the native permission prompt.
- If auto mode blocks an edit to `.claude/skills`, `.claude/commands` or `.claude/agents`, apply the rest, then ask once in plain words for explicit go-ahead, naming every file and old-to-new change. Retry once only after the explicit reply.
- Report changed files, marking shared (tracked) files, and say that changes are uncommitted.
