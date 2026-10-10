# Switch a running helper

Inputs: `--switch <n> --record <T-id>` and `--model <m>` and/or `--effort <e>`.
The record must be owned by `helper:<n>`; otherwise refuse without switching.
Use the Commands from the parent skill. Never ask the operator a question.

1. Read the helper's `claude agents --json` row by `name`, taking `id`,
   `status`, `state` and `cwd`. Apply the readiness rule in § Follow-ups,
   "Resume with new instructions" step 1 to a listed row. A listed helper
   that is not ready is queued: read `.hermit/state/monitors.runtime.json`
   and take the live `peer-idle` entry whose `target` is `<n>`. With none,
   first run `/hermitd:watch session <n> "<note>" --id <bg-id> --record <T-id>`;
   if no live entry results, report that outcome and end. Set the entry's
   `switch` to an object containing the supplied `model` and/or `effort`,
   merging into any queued value so a newer value for the same key wins.
   Write the registry, post one line in the thread:
   `<n> switches to <value> when its current turn ends.`, and end.
   For both values, render `<value>` as `<model>/<effort>`; for one, use that
   value. An unlisted helper continues below using its saved job state.
2. Run `helper-switch` (Commands) with `<bg-id>` and the supplied `--model`
   and/or `--effort`. Use the row's `id`; without a row, use the 8-character
   prefix of the sid in the latest `Handed to helper <n> (<sid>)` note on the
   record. On `refuse`, post the reason and end. On `ok`, retain `sid`,
   `name`, `cwd` and the shell-quoted `flags`. Read the resulting model and
   effort from these flags for the acknowledgement; an absent value is
   `default`, never a guessed config value.
3. Remove any live `peer-idle` entry whose `target` is `<n>` and write the
   registry as in `/hermitd:watch` § Stopping a watch.
4. If listed, run `claude stop <bg-id>` and the bounded stop-and-poll from
   § Follow-ups, "Resume with new instructions" step 2. Still listed at the
   deadline: report that outcome and end. `cd` to the row's `cwd` (unlisted:
   the script's `cwd`) as its own Bash call. As the next call, run
   `claude --bg --resume <sid> <flags> '<continuation>'`, then `cd` back to
   the project root as the next call whatever the launch returned.
   The continuation says the model or effort was switched, to reply only
   `ok`, and to send no message or report. Apply the launch limits'
   apostrophe quoting rule to the continuation and folder paths; the script's
   flags are already quoted. A "started a copy" note is the expected output.
   On launch failure, report it and end without retrying. Never type `/model`,
   `/effort` or `/advisor` into the helper, and never `claude rm` the stopped
   original, whose worktree the copy may still use.
5. Read the new row by `name` for its new bg id and `sessionId`. If no new
   session id is available, report that outcome and end without inventing one.
   Via `task-note` (Commands) with `<T-id>` and stdin, note:
   `Switched helper <n> to <model>/<effort>. Handed to helper <n> (<new sid>).`
   When `task-list` (Commands) with `--id <T-id> --json` shows `dedupe_key`
   `helper:PROP-NNN`, resolve that proposal through `/hermitd:proposal-act`
   § Resolving a Proposal ID. On MATCH, append via `proposal-patch` (Commands)
   with `<filename> --stdin` and no `--set`:
   `Decision: Handed to helper <n> (<new sid>) on @now; record <T-id>.`
   On a non-MATCH, report the resolver's reason and leave the proposal untouched.
6. Arm no watch. Post one line in the thread:
   `Switched <n> to <model>/<effort>.`
