---
name: hermit-restart
description: Restart the agent once it is quiet, typed by the operator in a terminal or the Claude app.
disable-model-invocation: true
---

Run exactly `.hermit/bin/hermitd-run request-restart .hermit --when-quiet` once, then report the JSON result to the operator in their language:

- `requested`: the restart happens once the agent has been quiet for about a minute, and the conversation resumes afterwards. If the agent stays busy for 15 minutes, the restart is dropped and the agent says so.
- `refused` with `interactive`: this session is not run by the watchdog; the operator restarts it by closing it and starting it again.
- `refused` with `not_running`: the agent has no running session record; `hermitd start` on its machine starts it.
- An `error`: relay it; nothing was restarted.
