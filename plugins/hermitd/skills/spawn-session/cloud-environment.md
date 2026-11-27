# Spawn a helper in a remote environment

| Helper standard | Local | Remote environment |
|---|---|---|
| Launch | `claude --bg` with the boot-written helper prompt | `cloud-session start` with the enrolled Remote Control environment and an inline task brief |
| Report submission | `task report` with `result`, `needs-input` or `note` | One SendMessage with a `TASK_REPORT` header and the same report kinds |
| Completion | Idle notice triggers the report receipt | `CLOUD_REPORT_STORED` triggers the report receipt |
| Steer | SendMessage to the bound helper by name with `notify_when_idle` | SendMessage to the bound helper by name |
| Idle check for reuse or status | Match the local helper row and idle status | Find the binding by task, then check the helper's ListAgents row |
| Local-only flags | `--cwd`, `--worktree`, `--strict-mcp-config`, `--background`, `--switch` | Refused |

1. Parse the environment name, optional `--name`, `--task`, `--model` and `--effort`, and the work request. Refuse before launch if any local-only flag appears. Derive a name as in [SKILL.md](SKILL.md) step 1 when absent. Read `remote` and `remote_environments` from config. If remote is off or the environment is unknown, say so and stop. Explicit model and effort win. Fill either omitted value from `delegation.model` or `delegation.effort` when set.
2. Resolve the hermit project root and bind a task before launch as in [SKILL.md](SKILL.md) § Plan. With `--task`, validate the open source task and open or reuse its helper-work record with `--dedupe-key "helper:<task-id>"` and the authorized requester. Otherwise bind the current open task or open a record with a title, requester and definition of done. For a new task with no source or conversation, use the local procedure's auto-close tags. Set `--owner helper:<n>` on the bound task and honor a refusal.
3. Say which helper will run on which environment. Write the requested work and operator language as plain text in a temporary brief file inside `.hermit/state/`. The launch command reads the task title and body itself. Include any additional material it needs inline. Keep resident file paths and `@` file mentions out of the brief.
4. From the project root, call this command with only the resolved optional flags. Pass each argument as one shell-quoted value.

   ```bash
   .hermit/bin/hermitd-run cloud-session start .hermit --environment <name> --task <T> --helper <n> [--model <m>] [--effort <e>] --prompt-file <file>
   ```

   Remove the temporary brief after the call finishes. If launch is declined or fails, restore the bound task to resident ownership and report the reason. On success, record the helper name and returned session id on the task. For `--task`, also note the handoff and the helper task id on its source record. Check the helper's ListAgents row once and report its placement as in § Status and follow-ups; an offline row this soon means that machine has not picked the session up yet. On a `cloud` row, also ask the operator to re-enroll the environment. Tell the operator which environment the task was sent to. The report hook supplies the completion notice. Skip watch registration.

## Status and follow-ups

Run `.hermit/bin/hermitd-run cloud-session lookup .hermit --task <T>` to find the helper's name, environment and session id. Consult the helper's ListAgents row on request. Report it as running or idle according to that row. A row of kind `cloud` means the environment id was wrong and the session launched on hosted Claude instead. If there is no row, report that its current state is unavailable.

An offline Remote Control row means that machine no longer runs the helper's session: a message to it is reported queued, but a restarted machine starts new sessions and never delivers it. For another request on the same open task, do not send to an offline helper: offer the operator a new helper on the same environment for this record (steps 1-4, with the request as its work) and say the stopped one can be resumed on that machine.

For another request to a helper that is not offline, send it to the bound helper by name with the task id, `helper:<n>` and operator language. An idle row indicates the helper is available for reuse. Omit `notify_when_idle` and let the report hook announce the next receipt.
