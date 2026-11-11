---
name: task-decide
description: Record the operator's typed task decision.
disable-model-invocation: true
argument-hint: "[<id>] yes|no|<n>|close|cancel"
---

When the `ARGUMENTS:` line contains an optional task id (`T-YYYYMMDD-HHMMSS`, optionally followed by a hyphen and one lowercase letter or digit), then exactly one of `yes`, `no`, a positive integer, `close`, or `cancel`, run exactly `.hermit/bin/hermitd-run task decide .hermit <those tokens>` once. `close` and `cancel` require the id.
Otherwise, including when there is no `ARGUMENTS:` line, run nothing and show usage: `/hermitd:task-decide [<id>] yes|no|<n>|close|cancel`.
Report the outcome in the operator's language. When the result carries `resume`, `next`, or `next_queued`, follow it as the task skill describes.
A refusal or usage result means nothing changed.
