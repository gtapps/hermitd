---
name: docker-customize
description: Route a request to install a tool, binary, package, env var, persistent directory, side service, or personal/third-party skill in the hermit Docker container to the first channel that can carry it. Apt packages go in the Dockerfile operator block; boot-time shell work goes in docker-entrypoint.hermit-local.sh; compose and Dockerfile only when nothing else fits. Activates on messages like "install skills in the container", "install gog in the container", "add an apt package", "download a binary into the container", "set a container env var", "add a volume or port to compose".
---

# Docker Customize

Land a container change in the first channel that can carry it, in the order below. Files sit on the project bind mount, so this skill runs from inside the container or on the host. Rebuild, restart, and compose validation are host-only (the image has no Docker CLI): name the command for the operator, do not run it from inside the container.

For installing or importing personal and third-party skills, read only the "Personal and third-party skills in Docker" section in `${CLAUDE_PLUGIN_ROOT}/docs/creating-your-own-hermit.md` ([guide](../../docs/creating-your-own-hermit.md#personal-and-third-party-skills-in-docker)). Use the sections below for any required dependencies or container configuration.

When deployment context is needed, read `runtime_mode` from `.hermit/state/runtime.json`. Before environment-dependent commands, locate the current shell with `[ -f /.dockerenv ] || [ -f /run/.containerenv ] && echo container || echo host`, the check used by `docker-setup`. Recorded deployment mode does not locate the current shell: a host session can manage a Docker Hermit's shared project. Do not use `$TMUX` to distinguish them; Docker also runs Claude inside tmux. Keep rebuild, restart, and compose validation on the host as above.

## 1. Apt package

The container runs as `USER claude` with `cap_drop: ALL` and `no-new-privileges`, so nothing installs a package at runtime. It has to be in the image.

Add it inside the operator block of `Dockerfile.hermit` (between `# --- operator:` and `# --- end operator ---`):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      <pkg> <pkg> && \
    rm -rf /var/lib/apt/lists/*
```

A Dockerfile rendered before the operator block existed has no such markers. Add the block yourself, between the `gh` install layer and the `# Match host UID` comment, then put the `RUN` inside it:

```dockerfile
# --- operator: root-context installs go here; upgrades merge around this block ---
#
# --- end operator ---
```

Then rebuild on the host: `hermitd restart --build` (it needs the container running; from stopped, `hermitd start --build`).

Tell the operator: `docker.packages` in `config.json` is read only when the templates are rendered, so setting it installs nothing on its own. Re-check the file after an upgrade.

## 2. Boot-time shell

If a shell can do it at boot, put it in `<project-root>/docker-entrypoint.hermit-local.sh`. Persist files under `.claude.local/` (bind-mounted, gitignored). Upgrades never touch the sidecar.

The managed entrypoint sources the sidecar twice, with `HERMIT_ENTRY_PHASE` naming which:

- `pre-boot`: channel dirs exist, env resolved, before plugins install. Env, directories, downloads, `pip` / `npm -g`, pre-session checks.
- `pre-launch`: immediately before `hermitd-start`. Side services, last-second overrides.

It inherits `set -euo pipefail`. Guard optional commands with `|| true`. Anchor every path to `${PROJECT_DIR}`, which the managed entrypoint exports: the sidecar is sourced into that shell, so a bare relative path lands in the wrong tree as soon as an earlier block has `cd`'d, and it cannot be replayed from a session with a different cwd. Create the file with `#!/usr/bin/env bash` if absent (it is sourced, so no `chmod +x`). Append; never overwrite existing content. Run `bash -n` on the file after writing it. Run the same commands once now so they take effect this session.

Applies on `hermitd restart`. No rebuild.

Shape of an appended block:

```bash
# --- operator: <what> ---
if [ "$HERMIT_ENTRY_PHASE" = pre-boot ]; then
  mkdir -p "${PROJECT_DIR}/.claude.local/<name>"
  curl -fsSL <url> -o "${PROJECT_DIR}/.claude.local/<name>/<bin>"
  chmod +x "${PROJECT_DIR}/.claude.local/<name>/<bin>"
  export PATH="${PROJECT_DIR}/.claude.local/<name>:${PATH}"
fi
```

## 3. Compose or Dockerfile only

If only `docker-compose.hermit.yml` or `Dockerfile.hermit` can carry it (volumes, ports, capabilities, base image), edit as one contiguous block with a leading comment — in `Dockerfile.hermit` that block is the operator block from § 1. Validate a compose edit on the host with `docker compose -f docker-compose.hermit.yml config -q`, adding `-f docker-compose.security.yml` when that file exists so the check covers what the wrapper actually builds: the host wrapper refuses every `up` and `build` on a file that does not parse.

`hermit-evolve` reconciles the file against the baseline `docker-setup` recorded: with a baseline and an upstream move `evolve-apply` script-applies clean merges and only overlapping lines are resolved by the hermit; with no baseline the file is kept, the upstream copy parked under `.hermit/state/`, and the operator told; with no upstream move the file is left alone. Re-check the block after every evolve.


### Merge a parked upstream copy

When the operator asks to merge a parked `Dockerfile.hermit` or `docker-compose.hermit.yml`:

1. Select that file's newest `.hermit/state/<name>.<timestamp>.upstream` and keep its adjacent `.upstream.json` receipt. Read [hermit-evolve reference §5d](../hermit-evolve/reference.md#5d-merge-compose-and-dockerfile-template-changes-in-place) for the merge procedure and structural checks.
2. Save the current project file to a timestamped `.bak` under `.hermit/state/`. With a verified `base_path`, follow §5d's `git merge-file` procedure and resolve only conflict regions. Without a verified base, merge the parked upstream changes into a scratch copy while preserving operator edits, including the Dockerfile operator block and custom git identity mount. Never treat the whole parked file as a replacement for a customized project file.
3. Run §5d's checks on the scratch copy: no conflict markers; compose parses as one document with `services.hermit` and `volumes`; Dockerfile retains `FROM`, build arguments, entrypoint copy and a final non-root `USER`. Install only a checked merge. On the host, validate compose with the security overlay when present.
4. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/evolve-plan.ts .hermit adopt <file>`, where `<file>` is exactly `Dockerfile.hermit` or `docker-compose.hermit.yml`. It validates the parked candidate and project merge, then records the current upstream baseline and removes the parked copies. If refused, report the reason; never bypass it by seeding a baseline manually.
5. After `status: "adopted"`, ask the host operator to run `hermitd update`. Later upgrades can merge against the recorded baseline.
