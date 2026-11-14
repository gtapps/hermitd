# Backup

A hermit accumulates state that exists nowhere else: session reports, proposals, compiled knowledge, its config, and the auto-memory Claude Code keeps outside the workspace entirely. `backup` commits that to git on a schedule and, if you configure a remote, pushes it there.

It runs from the watchdog tick, not from a session. No model turn, no tokens, and it keeps working when the hermit is rate-limited, wedged, or logged out — which is when you most want a snapshot. The only time a model is involved is the `/hermit-doctor` `backup` check, which tells you when something stopped working.

Ships off. Enable it from a terminal:

```
hermitd run backup setup
```

## Modes

**`workspace`** commits the workspace repo itself. Right when the hermit has its own dedicated repo (most standalone hermits). Setup rewrites `.gitignore` so hermit state stops being ignored, and marks the file so `/hatch` won't re-ignore it later.

**`mirror`** copies `.hermit/`, `.claude/`, `CLAUDE.md` and `CLAUDE.local.md` into a separate repo under your Claude config directory (`hermit-backups/<project key>/`) and commits there. Right when the hermit lives inside a real project repo: your project's history and remote are never touched. In Docker this path is on the `claude-config` volume, so it survives container rebuilds.

Either way the workspace repo's remote configuration is left alone. The push uses an explicit URL every time, so a manual `git push` on that box keeps whatever authentication it already had.

## What gets committed

Everything in scope for the mode, including files you would not think to ask for: runtime state, cost history, proposals, the lot. Restore treats runtime artifacts as stale rather than trying to be selective at backup time.

Auto-memory is copied in before each commit. Claude Code keeps it at `<config dir>/projects/<project key>/memory/`, outside every workspace, so a repo-only backup would miss the most valuable thing the hermit knows. It lands at `.hermit/memory-mirror/memory/`. Transcripts are excluded by default; add `"include": ["transcripts"]` to `config.backup` if you want them (they are large and grow fast).

### What gets refused

Some paths are never committed:

| Reason | What it covers |
|---|---|
| `secret-filename` | `.env` and every suffixed variant of it (timestamped backups, per-environment copies, samples), `*.pem`, `*.key`, `id_rsa*`, `.credentials.json`, anything under `.claude.local/` |
| `channel-log` | `state/channel-log.sqlite` and its journal files — your verbatim Discord/Telegram messages, documented as local-only in [security.md](security.md) |
| `credential-marker` | A file whose text contains a recognizable credential shape (Anthropic, AWS, GitHub, Slack), checked for files under 512 KiB |
| `too-large` | Anything over 95 MB, which most git remotes reject outright |
| `nested-repo` | A directory that is its own git repository |
| `transient` | Lock files, and the backup's own status and cursor files |

**This is a screen, not a boundary.** It catches the obvious shapes and nothing else. A credential in a file with an ordinary name, in a format the patterns don't know, or past the size cap, will be committed. It is also not retroactive: a refused path that is *already tracked* stays at its last committed version rather than being deleted from your tree, and anything already in history stays in history.

So before you enable this, look at what is already in the workspace. In particular `config.env` (and the resident launch overlay it produces) is free-form and will be committed — setup prints the key names and asks. Credentials belong in `.env`, which is refused.

The destination must be a private repository. This is the one part of the hermit that ships its whole footprint outward, and unlike telemetry — which builds an allowlisted bundle of named numbers — a backup is denylist-shaped by necessity. You cannot restore from an allowlist.

## Scheduling

`backup.schedule` is an ordinary 5-field cron expression, evaluated in `config.timezone`. The watchdog tick (every ~5 minutes) checks whether a scheduled minute has passed since the last one it consumed.

Semantics are plain cron, not anacron: **windows missed while the machine was off are skipped, not caught up.** A box that was down for three days does one backup at the next scheduled time, not three. There is also no retry between windows — if a push fails, the next scheduled run is the retry, and `/hermit-doctor` warns once two windows pass without a success.

The hermit writes state while the backup runs, so an occasional file can be captured half-written. The next window fixes it. A torn line in a restored ledger is that, not corruption.

## Authentication

Local paths and `file://` remotes push with no credentials. For an https remote (including a `git@github.com:` or `ssh://` one, which are converted — the hermit Docker image has git but no ssh client), the token is read at push time from, in order:

1. `HERMIT_BACKUP_TOKEN`
2. `GH_TOKEN`
3. a `HERMIT_BACKUP_TOKEN=` line in the project-root `.env`

For GitHub, a fine-grained personal access token with **Contents: write** on that one repository is enough. Use the agent's own identity for that token, a dedicated bot account or a current GitHub App installation token, as in [GitHub CLI authentication](docker-security.md#gh-cli-authentication). Backup commits are authored as the agent name. The account that accepts the push is whoever owns this token.

The token is passed to git through a credential helper that reads it from the environment. It never appears in a command line, in `.git/config`, or in any file the backup writes.

**On a host install, use the `.env` route.** A systemd user timer or launchd agent runs with a nearly empty environment, so an exported shell variable will not be there. Docker already loads the project `.env` through compose, so the same line works in both places; add it, then `hermitd-docker update`.

If a mounted `~/.gitconfig` carries a `url.<base>.insteadOf` rule rewriting https to ssh, pushes from the container will fail — there is no ssh client in the image. The push error will mention `ssh:`. Remove the rewrite or drop the gitconfig mount.

## When something goes wrong

`/hermit-doctor` reports a `backup` row, and `hermitd-run backup status` prints the last run's digest at any time. The results worth knowing:

- **`diverged`** — the remote has commits this hermit does not. The backup never pulls, rebases, merges, or force-pushes; a live hermit tree is not a thing a scheduled job should rewrite. Reconcile it yourself at a terminal (usually because you also work on that repo from another machine), and the next run pushes cleanly. Until then each run still commits locally and reports the same push error.
- **`dirty-index`** — something left staged changes in the repo. The backup will not commit them, because `git commit` takes the whole index and that would fold your half-finished work into a snapshot. Commit or unstage, and the next run proceeds.
- **`unsafe-tree`** — detached HEAD, or a merge or rebase in progress. Finish it.
- **`error` naming `backup setup`** — the hermit state is gitignored again and the backup marker is gone. Re-run setup.

Note that the push carries every commit on the current branch, not only the backup's own. If you work in that repo and have unpushed commits, they go too.

Repository size is not bounded. Text state compresses well; large binaries in `raw/` do not. If the repo grows uncomfortably, prune `raw/` rather than expecting the backup to.

## Restoring

There is no restore command yet — do it by hand, and read what you are copying as you go.

1. Clone the backup repository.
2. **Workspace mode:** copy the clone's contents over a freshly hatched project directory. **Mirror mode:** copy `.hermit/`, `.claude/`, `CLAUDE.md` and `CLAUDE.local.md` back into the project.
3. Copy `.hermit/memory-mirror/memory/` to the directory `hermitd run memory-dir` prints for the restored project. The path is keyed off the project's absolute path, so **restoring to a different path means a different directory** — run the verb from the new location rather than reusing the old path.
4. Delete the runtime leftovers, which describe a machine that no longer exists: `state/*.lock`, `state/runtime.json`, `state/.heartbeat`, and any `*-liveness.json`.
5. Restore the secrets the backup refused: `.env`, `.claude.local/`, and anything else you keep outside the repo.
6. Run `/hermitd:hermit-evolve` to reconcile the plugin version, then `/hermitd:hermit-doctor`.

## Configuration

See the [`backup` section of the config reference](config-reference.md#backup). Every key raises Claude Code's native permission prompt, because a remote set from something the hermit merely read would be a standing exfiltration path. `backup setup` still runs from a terminal.
