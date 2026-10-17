---
name: rc-gate
description: Open, close, or check the Remote Control spawn gate — the hermit-managed `claude remote-control` server that lets a phone spawn new sessions into this project.
disable-model-invocation: true
---
# RC Gate

The spawn gate is a `claude remote-control` server the hermit runs as its own
tmux child. While it is open, the operator can spawn **new** sessions into this
project from claude.ai/code or the mobile app; each spawn lands in its own git
worktree, so this folder stays single-session and the hermit keeps its own state.

This is a different leg from `config.remote`, which makes *the hermit itself*
reachable. Both can be on; neither implies the other.

## Verbs

All four are `.hermit/bin/hermitd-run rc-server <verb>`:

| Verb | What it does | `status` |
|---|---|---|
| `start` | opens the gate (tmux session `hermit-rc-gate`), waits for the server | `ready` with `url`, or `refused` |
| `status` | one pane read | `down`, `starting` (not serving yet), `ready`, or `connected` (`connected`/`capacity`); `live_spawns` when spawn worktrees exist |
| `stop` | closes the gate, then sweeps | `closed` / `down`, with any sweep under `gc` |
| `gc` | sweeps worktrees left by archived spawns | `skip` if liveness is unknown; else lists `removed`, `kept` (uncommitted work), `failed` |

The `url` (`claude.ai/code?environment=…`) is what the operator
opens or scans. Hand it over as a link, not as a command.

Run each verb bare. The grant for these four is an exact command match, so a
pipe, a redirect, or a `timeout`/`cd` wrapper falls outside it and re-prompts.

## Behavior

Report state, not mechanics — whether the operator can spawn from their phone,
and the link if so. Never the tmux session name, the flags, or the pane text.

A spawned session is visible only to the claude.ai account signed in here, and
the server refuses to start without that login. Anyone with access to that
account can spawn while the gate is open.

When `start` is `refused` (`login_required`), that is final. Say it once,
don't retry, don't propose workarounds.

Leftover worktrees are swept automatically while the routine monitor runs. Run
`gc` for an on-demand sweep that reports `kept`; `stop` already sweeps. A `kept`
entry means that worktree holds uncommitted work: say it is there and let the
operator decide, never delete it for them.
