# Answering task waits

## Already-done items

A clear reply applies only to records explicitly named by this chat's preceding already-done message. Never guess targets from the store. Use the record's normal `close` or `cancel` command with `--chat <key> --user <sender-id>` and reason `already done`. A refusal is final for this turn: do not bypass pending consent or a decider check. No approval is implied by clearing a stale reminder. Reply once without internal ids.

## Answering a wait

Map the reply by its meaning, in any language; do not match keywords. Pass yes, no, a number or an option label to `task answer [<task-id>] --chat <key> --user <sender-id> --reply '<token>'`. Omit id when the sender did not identify a record; the script owns matching and cross-chat isolation.

On `match`, use the recorded answer and `resume` to continue the owning procedure. Input "no" is an answer, not cancellation. Consent "no" dismisses the proposal. Result acceptance closes only the matching revision. On `ambiguous`, ask once using returned choices; change nothing. On `refused` (`not_decider`), explain that this decision waits for its decider or an admin, and leave it open. On `stale`, reload the current record; do not replay against the new generation. On `none/no_pending`, continue normal classification; `none/no_match` leaves state unchanged. Never clear a typed wait or act on its answer through a different verb.
