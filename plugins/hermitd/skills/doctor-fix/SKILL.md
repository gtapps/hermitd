---
name: doctor-fix
description: Run the agent's health check and apply its safe repairs, typed by the operator in a terminal or the Claude app.
disable-model-invocation: true
---

Run exactly `.hermit/bin/hermitd-run doctor-fix .hermit` once, with a Bash timeout of five minutes, then report the JSON result to the operator in their language:

- `done`: relay what `lines` says was repaired, queued or skipped, and what still needs attention, for someone reading on a phone. `exit_code` reflects the findings left after the repairs, not whether the command worked.
- `refused` with `host_only`: this agent runs in a container; the repair runs on its host with `hermitd doctor --fix`.
- An `error`: relay it; nothing was repaired.
