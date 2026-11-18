---
name: hermit-update
description: Update the agent's plugins and apply the upgrade, typed by the operator in a terminal or the Claude app.
disable-model-invocation: true
---

Run exactly `.hermit/bin/hermitd-run self-update .hermit` once, with a Bash timeout of five minutes, then report the JSON result to the operator in their language:

- `done`: summarize `update` for someone reading on a phone: which plugins moved and to which version, which failed, and whether the upgrade and a restart were queued. A non-zero `exit_code` with an `update` row means part of the update applied; a null `update` means the updater stopped before recording anything. Once the upgrade has run, the agent restarts by itself when it is quiet.
- `refused` with `host_only`: this agent runs in a container; the update runs on its host with `hermitd update`.
- An `error`: relay it; nothing changed.
