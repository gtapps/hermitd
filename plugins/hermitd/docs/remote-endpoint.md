# Always-Reachable Remote Endpoint (Linux/systemd)

Turn a machine into a **phone-spawnable endpoint**: a supervised
`claude remote-control` server per project, so you can start new sessions from
the Claude app without anyone at the keyboard.

This is the unattended sibling of the hermit's own spawn gate
(`/hermitd:rc-gate`, backed by `hermitd-run rc-server`). The gate is
better when you want to open and close it yourself, per session; this recipe is
better when nothing is running and you still want the machine reachable after a
reboot or a network flap.

## Prerequisites

- **A claude.ai `/login` on this machine, and `auth_mode: login` on the hermit.**
  Remote Control rejects setup-token auth outright ("must be logged in… only
  available with claude.ai subscriptions"). A credential is an either/or per
  machine, not an addition, so the hermit has to be told which one it runs on:
  set it with `/hermitd:hermit-settings auth-mode login` (or
  `hermitd-run settings-edit .hermit/config.json set auth_mode login`),
  then sign in with `hermitd-docker login` — under Docker that switches a running
  token hermit through the staged relay and restarts it. A hermit left on
  `auth_mode: token` keeps hydrating `CLAUDE_CODE_OAUTH_TOKEN` at boot, and
  `remote: true` stays inert on it with no error.
- Linux with systemd user units. macOS/launchd is unwritten; the unit below does
  not translate directly.
- A machine that stays awake. Laptops sleep; this recipe assumes a box that
  doesn't.

## The unit

`~/.config/systemd/user/claude-rc@.service` — a template unit, one instance per
project. Keep it installed with no instances enabled until you enroll a folder.

```ini
[Unit]
Description=Claude Remote Control gate for %I
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/%I
ExecStart=/usr/bin/script -qfc "/usr/local/bin/claude remote-control --spawn worktree --no-create-session-in-dir" /dev/null
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

Four details are load-bearing, each of which failed before being fixed:

- **`WorkingDirectory=/%I`** — the leading slash is required. `%I` unescapes the
  path without it and systemd refuses with "path is not absolute".
- **Absolute `claude` path.** User units get no shell PATH. Substitute the output
  of `which claude`.
- **`/usr/bin/script -qfc "…" /dev/null`.** The server wants a pty; under bare
  systemd it never reaches Ready. The `script` wrapper supplies one.
- **`Restart=on-failure` + `RestartSec=15`.** The server self-exits after ~10
  minutes of failed reconnects, so without supervision the endpoint is reachable
  only until the first network flap. Verified: `kill -9` of MainPID → scheduled
  restart → active with a new PID, and a quick restart stays inside the ~4h
  session-resume window.

## Enroll a project

```sh
systemctl --user enable --now claude-rc@$(systemd-escape -p /path/to/project)
loginctl enable-linger "$USER"   # only needed for reboot-before-login
```

One enroll line per project. Instances run side by side: two projects were
verified active simultaneously, each reaching Ready with its own environment id,
each appearing as a separate environment in the app picker with its own
32-session capacity. No account-level cap was observed at n=2; larger n is
untested.

Check with `systemctl --user status 'claude-rc@*'`. Don't tail the journal for
status — the server's TUI redraws continuously and floods any follower.

## Flags

- `--spawn worktree` puts every phone-spawned session in its own git worktree,
  so spawns never collide with each other or with work in the folder.
- `--no-create-session-in-dir` suppresses the session the server otherwise
  pre-creates in the project directory (the default exists so a device has
  somewhere to type immediately). For an endpoint it prevents a second session
  squatting in the folder. Trade: with that flag the server's sessions archive
  when it stops.

## Caveats

- **No worktree GC here.** Archiving a spawned session from the Claude app reads
  as a crash to the server and leaves a *locked* worktree behind. The recipe does
  not clean those up; run `hermitd run rc-server gc` in
  the project, or unlock/remove/prune by hand.
- **Anyone who can reach your Claude account can spawn sessions into an enrolled
  folder** while its instance is running. Enroll deliberately, and
  `systemctl --user disable --now` the instance when you don't need it.
- **This recipe is disposable by design.** Server mode, capacity limits and
  resume flags all point at Anthropic shipping a supervised daemon; when that
  lands, delete the unit and keep using the CLI.

## Use it as a helper environment

On the machine that will run the helper, open a trusted project folder with a
committed checkout and start the Remote Control spawn server:

```bash
claude remote-control --spawn worktree --permission-mode auto
```

Copy the environment link and enroll it on the resident with
`/hermitd:hermit-settings remote-environments <name> <link>`. The resident
needs `remote: true` and a claude.ai login. Ask the resident to spawn a helper
on that environment with `/hermitd:spawn-session <work> --environment <name>`.

Work queues while the machine is offline. Anyone signed into the account can
start sessions in the enrolled folder. A wrong environment ID behaves like
`claude --cloud`: a hosted session in the operator's account receives the
committed repo from the resident's launch folder. Check the helper's placement
when reporting status.
