# Apply a proactive offer

For a matching `task answer` verdict passed through `resume`, branch on `answer` first. On `no`, acknowledge the decline in one line and stop before reading the task, writing the job, or running a check. On `yes`, use the verdict's `id`. Consent is already recorded, so skip `task answer`.

For `apply <id>` from normal task intake, proceed only with an approved proposal. Read `.hermit/tasks/<id>.md` on either yes path. Verify it is an open `proactive:` proposal with `approved_rev` set and no `waiting_on`. Use the stored kind and recipe from `## Proposal`, and the current task id when the body's apply line names this task. A closed record or a missing approval ends the apply without a write.

## Set up the job and save its receipt

Use an existing receipt from the task's Progress notes if present and skip the owner write in that case. Otherwise use the owner below. Preserve the offer's destination and timing. Quote shell arguments and send data as literal inputs.

- **Later reminder or check.** Use the `/hermitd:later` owner. Resolve the recipe's claim and due time, and scan `.hermit/bin/hermitd-run later list .hermit` for a pending row with that claim and due time. Reuse its id if found. Otherwise run `later add` through the same wrapper with the recipe's `--claim`, `--due`, and approved chat if applicable, and `--remind` for a reminder or the recipe's check command for a check. The returned row id is the receipt.
- **Saved watch.** Use the `/hermitd:watch` saved-watch owner. Build its monitor entry from the recipe with a stable id and use `settings-edit .hermit/config.json append monitors` to save it. On `duplicate_id`, read the matching entry and use its id as the receipt if it already implements the recipe. A conflicting entry leaves the offer open for retry.
- **Routine.** Read `routines` through `settings-edit .hermit/config.json get routines`. For an existing id, resolve its current index and use `settings-edit .hermit/config.json set routines.<index>.enabled true` if needed. For a missing id, use `settings-edit .hermit/config.json append routines '<entry>'` with `id`, `schedule`, `skill` and `enabled: true`, only for the new routine shapes in [reference.md](reference.md). Use the routine id as the receipt. Skip the generic `proposal.ts routine` upsert.
- **Heartbeat.** Pass the recipe's checklist line on stdin to `add-item` (Commands). Both `added` and `none` with `reason: exists` return the receipt in `key`.

After a successful owner operation or recovery of an existing job, record `Proactive receipt: <kind> <id or key>` on stdin to `task-note` (Commands) before adding the check.

## Verify and close

Record the matching read-only command by appending `--check '<command>'` to `task-note` (Commands). If resuming with the same check already stored, use it as-is. Substitute the actual receipt value and quote it literally.

- Later uses `.hermit/bin/hermitd-run later list .hermit | grep -q '<row id>'`.
- Watch uses `grep -q '"id": "<watch id>"' .hermit/config.json`.
- Routine uses `jq -e '.routines[] | select(.id=="<id>" and .enabled==true)' .hermit/config.json`.
- Heartbeat uses `grep -qF '<line>' .hermit/HEARTBEAT.md`.

Run `task-check` (Commands), which invokes `task-check.ts <id>` without sender flags. A passing check closes the proposal. Reply in plain words with what was set up. A failed check leaves the task open with its receipt. Report the verification failure without repeating the owner write.

## Renew consent if setup fails

If the owner command errors or its permission prompt is denied or still pending, keep the proposal open. Record what failed on stdin via `task-note` (Commands), then append these arguments to `task-block` (Commands) to renew consent:

```bash
--decision '{"purpose":"consent","authority":"admin","generation":<next>}' --waiting-on admin --status-line '<what failed>' --next 'A new yes retries it'
```

Use the next generation from the task's current decision. The renewal preserves `resume`. Tell the operator setup is incomplete and a new yes retries it. Wait for that answer before retrying.
