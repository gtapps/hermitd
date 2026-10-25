# Leftover check

## Queue the question

The `question` opens with `leftover-check:`, so a chat answer reaches the Fix procedure below, then has one line per subject from `Findings`: old name to replacement, hit count, up to three file:line locations, `[shared]` after tracked files. Shape the payload like this example:

```json
{"tier":1,"question":"leftover-check: old routine names left in your files:\nmorning-brief -> hermitd-fitness:morning-brief, 3 hits: CLAUDE.md:9, .claude/skills/tidy/SKILL.md:4 [shared], .hermit/config.json:41\n\"Fix them\" re-checks and updates these files and leaves the changes uncommitted.","options":["Fix them","Leave them"],"key":"leftover-check"}
```

## Fix procedure

First run `leftover-check` (Commands) with argument `--saved` and no stdin. It re-checks the subjects Step 7b recorded and returns the release's `declarations`, each `text` verbatim; take every replacement and rule from those texts, a startup rule included. On `no_saved_subjects`, change nothing and tell the operator no check is recorded. Never fix from session context or an earlier search. Re-find each reference in that output by matched text rather than stale line numbers. Skip references already gone and report those already fixed. Update the working tree only, never commit. Leave ambiguous references with multiple live replacements for the operator.

- Read `.hermit/config.json` hits with `.hermit/bin/hermitd-run settings-edit .hermit/config.json get <dotted.path>`, then change them with `.hermit/bin/hermitd-run settings-edit .hermit/config.json set <dotted.path> <json-value>`, preserving unrelated values and the settings ledger.
- In a channel session, list `.claude/settings*.json` hits for manual fixing in an interactive session. Interactively, apply them behind the native permission prompt.
- If auto mode blocks an edit to `.claude/skills`, `.claude/commands` or `.claude/agents`, apply the rest, then ask once in plain words for explicit go-ahead, naming every file and old-to-new change. Retry once only after the explicit reply.
- Report changed files, marking shared (tracked) files, and say that changes are uncommitted.
