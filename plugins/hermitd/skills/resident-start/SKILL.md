---
name: resident-start
description: Orient a resident after boot, resume or context refresh, reconcile recovery and report readiness without choosing work.
---
# Resident Start

## Inputs and goal

Use the startup hook context, `.hermit/config.json`, `state/runtime.json`, `state/execution.json`, and open task records to establish resident readiness. OPERATOR.md and TASKS.md are injected by SessionStart; use their policy and read them only when absent from context. Startup does not select a task or ask what to work on next.

## Workflow

1. **Upgrade classification.** When the hook emits `---Upgrade Available---` with `REQUIRED:`, run `/hermitd:hermit-evolve unattended` before continuing. An advisory upgrade is a notification only. If it emits `---Stale Plugin Runtime---`, relay the stale-install notice and do not run evolve: evolve cannot replace the plugin copy loaded by this process.
2. **Boot classification.** Freshly read runtime and execution state. A missing runtime is a first boot. `context_cleared === true` identifies a context refresh: consume it by setting only that runtime field to false and suppress the startup ping. A resumed process is still a new boot for process-scoped watches; a context refresh preserves existing native monitors. Observe execution without writing its state: hook observations own `execution.json`, and `unknown` is not evidence that work finished. If the lifecycle lock is held, report that the boot operation is still in progress and stop this readiness flow.
3. **Record inventory and recovery.** Also run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts list .hermit --skill-review pending` and resume each pending review through `/hermitd:task` § Closure, including closed records. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts list .hermit --open`. Use the returned execution observation and each open record's result or waiting state. For `last_error` of `unclean_shutdown` or `dead_process`, report the interruption and the open records, including `watchdog_restart_reason` when present. Preserve records and pending results; an interrupted process neither completes nor cancels a commitment. Report readiness with the recovery facts, without an archive-or-resume question. After reporting, clear only the acknowledged `last_error` and `watchdog_restart_reason`. If `orphaned_process` is recorded, alert the operator that the prior process may still exist and needs verification before treating the resident as ready; do not start duplicate work.
4. **Duty and worker recovery.** On a genuine boot, run `/hermitd:watch start` unconditionally. List the open task threads with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts list .hermit --open --owner 'worker:*' --json` and report them: the next reply in each thread goes to the worker id the record names, and only a failed send starts a fresh worker. Load `/hermitd:hermit-routines load` and start `/hermitd:heartbeat start` when enabled and not already running. On a context refresh keep surviving monitors; do not clear their registry or re-arm them simply because context changed.
5. **Readiness report.** If `.hermit/state/first-chat.json` exists, send no readiness notice; the first eligible operator turn opens the first chat. Otherwise follow this report policy. Use the configured identity and language, and notify per CLAUDE.md Operator Notification policy. Give one brief report of readiness, interrupted or waiting records, and duty availability. Recovery notification is the boot notification, so do not send a second ping. Suppress a normal online ping on context refresh. In always-on mode never ask for a task. Leave task selection to an operator assignment, a routine or the queued-record workflow.

## Result

A ready resident with reconciled duties and an accurate open-record inventory. This skill does not open, close, cancel or select a task. There is no task argument path. Task mutations and lessons belong to `task.ts` and `/hermitd:task`.
