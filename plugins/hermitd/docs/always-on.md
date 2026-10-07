# Always-On Setup

Docker is the guided way to run your hermit autonomously, and the rest of this page is that workflow. It is not the only one: tmux runs the same hermit with the same heartbeat, monitors, and channels, and which one fits depends on the machine more than on the hermit. See [Always-On Operations](always-on-ops.md) for the tmux setup and the lifecycle internals both share, and [Security](security.md) for hardening.

---

## Docker vs tmux

Both run your hermit unattended between tasks with heartbeat, monitors, and channels live. Docker adds config isolation, a reproducible environment, and kernel-enforced hardening, and it is what `/docker-setup` walks you through. tmux skips the image build and reaches host services natively. The tmux setup lives in [Always-On Operations](always-on-ops.md); the rest of this page is the Docker workflow.

| Dimension        | Docker                                                        | tmux                                                        |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Isolation        | Container sees only what you mount                            | Full host access as your user                              |
| Crash recovery   | Container restarts itself (`restart: unless-stopped`) as long as Docker is running | Watchdog scheduler auto-installed on first tmux boot (systemd timer / LaunchAgent); restarts dead sessions |
| Environment      | Pinned, reproducible image (Node, Bun, project packages)      | Whatever is installed on the host                          |
| Host services    | Reach localhost DBs/dev servers via mounts or `network_mode`  | Native, no networking setup                                |
| Hardening        | Opt-in `/docker-security` overlay (LAN containment, sysctls)  | Deny patterns and hooks only                               |
| Setup cost       | Image build on first `up` (slower first run)                  | `hermitd start`, no build                               |

Isolation is a spectrum rather than a Docker-or-nothing choice, and Claude Code's own [sandbox environments](https://code.claude.com/docs/en/sandbox-environments) page compares the options — the bash sandbox, the sandbox runtime, containers, VMs. A boundary is required for `bypassPermissions` and is defense in depth under the default `auto` mode.

**Choose Docker when** the hermit runs on a shared or long-lived host, you want it to survive reboots unattended, or you want the container to only see the project you mount.

**Choose tmux when** you're on a trusted single-user box, Docker isn't available, or you need the hermit to reach host services with no networking setup.

**Either way, "always-on" is bounded by the machine.** Sleep pauses everything, on both paths. Logout depends on the host: a Linux system Docker daemon keeps running, while Docker Desktop, systemd *user* timers, and macOS LaunchAgents stop with your session — on Linux, `loginctl enable-linger` is what keeps a user timer alive across a reboot before anyone logs in. A hermit that has to be up at 4am belongs on a machine that is up at 4am.

Either way, the first launch needs one attended step to clear the trust gate, then subsequent boots are headless. On Docker the default `auto` mode (classifier-reviewed autonomy) requires the same one-time Screen 2 acknowledgement as `bypassPermissions`; both persist in the named volume after you click through once. If your workload cannot tolerate any action-level confirmation at all, opt into `bypassPermissions` via `/hermit-settings permissions`.

---

## Prerequisites

| Requirement              | For          | Notes                                          |
| ------------------------ | ------------ | ---------------------------------------------- |
| **Docker**               | Container    | `docker compose` v2 (Docker Desktop or modern Docker Engine) — see [Install Docker Compose](https://docs.docker.com/compose/install/) |
| **Node.js 22+**          | Hooks        | Inside the container — handled by the Dockerfile |
| **Bun**                  | Plugins      | Inside the container — always included          |
| **Claude Code v2.1.292+** | Channels, sandbox | Minimum supported version |

---

## Setup

Run after `/hermitd:hatch`:

```
/hermitd:docker-setup
```

**Already running this hermit in tmux on this box?** Stop it first with `hermitd stop`. Both instances share the same `.hermit/` state dir, so the container's entrypoint refuses to boot beside a live host instance and goes inert instead. The wizard checks for this before it builds anything and will tell you to stop the host hermit.

The resident launch overlay carries `pause-gate`, `ask-gate`, `component-privacy`, and `permission-denied-notify` instead of the plugin manifest. It is read at launch only, so restart the resident after an upgrade to load the rewritten overlay.

The wizard scans your project for dependencies, asks about auth, and generates four hermit-namespaced files (so they don't clash with your own Docker setup):

| File                          | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `Dockerfile.hermit`           | Ubuntu 26.04, Node 24, Bun, Claude Code, project packages, host UID matching |
| `docker-entrypoint.hermit.sh` | Onboarding bypass, workspace trust seed, channel MCP enable, permission patch, channel symlinks, graceful SIGTERM handling, PID 1 keepalive |
| `docker-compose.hermit.yml`   | Named volume, bind mounts, env vars, healthcheck, restart policy, kernel-enforced hardening (`no-new-privileges`, `cap_drop: ALL`, `pids_limit`) |
| `.env`                        | Auth token (appended if file already exists)           |

### Customizing the container

| Need | Where it lives | How it takes effect | Upgrade guarantee |
| ---- | -------------- | ------------------- | ----------------- |
| apt package | inside the operator block of `Dockerfile.hermit` (`docker.packages` in `config.json` is read only at render time, so setting it installs nothing on its own) | rebuild on the host: `hermitd restart --build` | with a baseline and an upstream move the merge is mechanical and only overlapping lines are resolved by the hermit; with no baseline the file is kept, the upstream copy parked under `.hermit/state/`, and the operator told; with no upstream move the file is left alone. Re-check it after an upgrade |
| release binary, `pip`/`npm -g`, env export, directory, side service, pre-session check | `<project-root>/docker-entrypoint.hermit-local.sh` (`HERMIT_ENTRY_PHASE` `pre-boot` / `pre-launch`; persist under `.claude.local/`) | `hermitd restart` (no rebuild); `set -euo pipefail`, failures abort boot | upgrades never touch the sidecar |
| volume, port, capability, base image | one contiguous commented block in `docker-compose.hermit.yml`, or the operator block of `Dockerfile.hermit` | `hermitd restart --build` or `hermitd restart`, as the change requires | with a baseline and an upstream move the merge is mechanical and only overlapping lines are resolved by the hermit; with no baseline the file is kept, the upstream copy parked under `.hermit/state/`, and the operator told; with no upstream move the file is left alone. Re-check the block after every evolve |

The hermit routes this through `/hermitd:docker-customize` when asked in chat.

The wizard also checks `.claude/settings.json` permissions to detect tools your project needs in the container.

---

## First Run

```bash
hermitd start
```

This builds the image, starts the container, and prints the tmux attach command.

`hermitd-start` seeds workspace trust for the project before launching Claude Code, including the first boot. The trust state persists in the `claude-config` named volume. If the seed warns that it could not read or write that state, use the printed attach command to accept trust manually, then detach with Ctrl+B, D. `hermit-doctor` checks the trust configuration with `overlay-hooks`.

> **First run is slower** — the named volume starts empty, so the entrypoint runs onboarding bypass and installs channel plugins. Subsequent restarts are fast.

---

## Advanced Hardening (opt-in)

Once the container is up and stable, consider running the advanced hardening wizard:

```
/hermitd:docker-security
```

It applies a `docker-compose.security.yml` overlay that the `hermitd-docker` wrapper auto-detects on the next `up`. Each toggle is opt-in with honest cost/benefit framing, fully reversible, and verified live against your container:

| Toggle | What it adds | Honest limitation |
| --- | --- | --- |
| LAN containment + DNS policy | nftables firewall + dnsmasq sidecar sharing hermit's netns; blocks RFC1918, cloud metadata; port-53 redirect for actual DNS-policy enforcement | Direct-IP egress to a hardcoded public IP is **not** blocked (no DNS lookup to intercept) |
| Resource bounds + sysctls | `mem_limit`, `cpus`, ICMP-redirect / source-route hardening | Network sysctls auto-skip when `network_mode: host` |
| Plugin install audit log | One JSONL line per boot-time `claude plugin install` to `state/plugin-installs.jsonl` | Post-boot installs run via tmux are not captured |

The wizard is fleet-aware: it scans installed sibling plugins whose names contain `hermit` (for example `hermitd-homeassistant` and `hermitd-fitness`) for a `## Docker network requirements` section and offers their domains and LAN suggestions for per-entry confirmation. The LAN containment toggle is **hard-skipped** when `docker.network_mode: "host"` — host mode and bridge-based netns sharing are mutually exclusive.

Reverse anytime: re-run `/docker-security` and answer No to every prompt, or `rm docker-compose.security.yml` and `hermitd-docker up`. See [Security](security.md#advanced-hardening--docker-security) for the deeper treatment of what each toggle protects against and the documented limitations.

---

## Fleet mesh (opt-in)

Fleet mesh lets Docker hermits on the same host discover and message each other with Claude Code's native `ListAgents` and `SendMessage` tools. Each hermit appears in `ListAgents` under its configured `agent_name`.

Create the shared volumes and PID namespace holder once on the host:

```bash
docker volume create hermit-fleet-sessions
docker volume create hermit-fleet-socks
docker run -d --name hermit-fleet-pidns --restart unless-stopped --init alpine sleep infinity
```

Set `docker.fleet_mesh` to `true` in each hermit's `.hermit/config.json`, re-run `/docker-setup`, then apply the rendered files:

```bash
hermitd update
```

Every hermit in the mesh must run as the **same host UID**. The shared socket directory is `0700` and the shared `sessions/` volume is owned by whichever hermit mounted it first, so a hermit started by a different host user cannot read either: Claude Code silently falls back to `/tmp` for its inbox socket and the hermit stays invisible to its peers, with only a `[hermit] Cannot secure socket directory` line in `hermitd-docker logs` to say so. Compose reads the UID from `${UID:-1000}` in the launching shell.

The generated Compose file uses `pid: "container:hermit-fleet-pidns"` so peer registry filenames use unique PIDs without exposing host processes. The holder is a hard dependency: if it is removed or recreated, every mesh hermit must be recreated too (`hermitd-docker update`), since a container cannot rejoin a namespace that went away. As a manual alternative, replace that line with `pid: host`. Host PID mode removes the holder dependency, but every hermit can then see and signal every process on the host, not only other hermits.

---

## Managing Your Hermit

| Action    | Command                                                       |
| --------- | ------------------------------------------------------------- |
| Start     | `hermitd start`                    |
| Stop      | `hermitd stop`                  |
| Force stop| `hermitd stop --force`          |
| Attach    | `hermitd attach`                |
| Shell     | `hermitd docker bash`                  |
| Logs      | `hermitd docker logs -f`               |
| Restart   | `hermitd restart`               |
| Status    | `hermitd status`                       |

`hermitd-docker up` starts the container and prints the attach command.
`hermitd-docker attach` connects to the hermit's tmux session. Detach with Ctrl+B, D.
`hermitd-docker down` sends a graceful session close before stopping. Use `--force` to skip.
`hermitd-docker bash` opens a shell inside the container. Use `hermitd-docker bash -c "cmd"` for one-off commands.
All bin scripts are pure bash — no Claude Code process, no tokens burned.

---

## Auth

**OAuth login (recommended for Pro/Max):** After the container starts for the first time, run `claude /login` inside it:

```bash
hermitd docker login
```

This opens a browser URL for OAuth. Complete the login and credentials are saved to the container's named volume — they persist across restarts. The entrypoint waits for credentials on first boot, then starts automatically.

**API key:** For pay-per-token billing, set `ANTHROPIC_API_KEY` in `.env` instead. No container login needed.

The docker-setup wizard walks you through the right auth method and ensures `.env` is gitignored.

---

## MCP servers

See the [access model](access-model.md#connections) for connection ownership and revocation.

The Docker entrypoint seeds workspace trust but does not approve servers declared in the project's `.mcp.json`. To enroll a server, add its name to `enabledMcpjsonServers` in the project's `.claude/settings.json`, preserving the file's other settings:

```json
{
  "enabledMcpjsonServers": ["my-server"]
}
```

A project server loads only when approved through native settings. Use the list above for individual servers, or set `enableAllProjectMcpServers: true` in the same file to approve all project servers. A server listed in `disabledMcpjsonServers` remains excluded. An unlisted server stays pending without stalling boot or prompting in chat. To revoke enrollment at the next restart, remove its name from the approval list (and turn off blanket approval if enabled), or add it to `disabledMcpjsonServers` in the same file. Approval in other native settings scopes must also be removed. Toggling a server off in `/mcp` records the change in the config volume's `.claude.json`, which the harness does not consult for `.mcp.json` approval, so a server left listed in settings comes back on the next boot.

A hermit using `auth_mode: login` loads every connector on the operator's claude.ai account by default. To turn them all off for this project, add this setting to the same `.claude/settings.json` file:

```json
{
  "disableClaudeAiConnectors": true
}
```

Hermits using `setup-token` fetch no claude.ai connectors. See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for native server and connector settings.

---

## Channels

Channel tokens live in `.claude.local/channels/<name>/.env` (project-local scope). `hermitd-start` derives `DISCORD_STATE_DIR` / `TELEGRAM_STATE_DIR` from `channels.<name>.state_dir` in config.json (relative paths resolved against project root); on a bare-host boot, an omitted value defaults to `.claude.local/channels/<name>`. It writes the derived paths into the resident launch overlay and shell env so MCP servers can find them.

### Docker

The docker-setup wizard pairs during first run. Afterwards `/hermitd:channel-setup` from the host pairs or re-pairs. A channel or token added later needs `hermitd-docker restart` first (the bot is offline until then). Inside the container, use the two native `/<channel>:access` commands in the attached REPL; pair carries the "save access.json to `<state_dir>/` not `~/.claude`" hint.

The docker-compose file bind-mounts `.claude.local/channels/<plugin>/` into `~/.claude/channels/<plugin>/` inside the container — channel skill commands write to the right place automatically, and state persists across container restarts.

### Local / tmux

Run the guided activation wizard — it picks up the channel preference from `hatch`, or adds one if you skipped that step:

```
/hermitd:channel-setup
```

It installs the plugin (requires [Bun](https://bun.sh)), writes the bot token to `.claude.local/channels/<plugin>/.env`, and walks through pairing. It can also re-enable a channel you previously turned off. `hermitd-start` passes `--channels` automatically — no manual flag needed. If bun is missing or the token file isn't present, `hermitd-start` prints a clear warning and skips the channel.

---

## Pausing the Hermit

```bash
hermitd stop   # graceful close + stop
# ... do your thing ...
hermitd start     # hermit recovers and resumes
```

`down` waits for a graceful execution boundary before stopping (see [Graceful Shutdown](#graceful-shutdown) below for the exact sequence). On `up`, the resident reads execution state and open task records.

To queue work for the hermit to pick up next, use `/hermitd:proposal-create` followed by `/hermitd:proposal-act accept <id>`. Accept opens a queued task record. A close or cancel returns the next runnable record; heartbeat nudges work left queued.

---

## Quick Status

```bash
hermitd status
```

No tokens burned. Prints transport, execution and its age in seconds, open and waiting task counts, and the first runnable task:

```
NAME       RUNTIME  TRANSPORT  EXECUTION  AGE  OPEN  WAITING  WORKING ON
myproject  docker   up         idle       10   1     0        Add input validation
```

Use `hermitd attach` to connect, `hermitd status --json` for one JSON document, and `hermitd list` for all registered or discovered hermits. A running sidecar without the `hermit` service reports transport `down`; a failed Docker inspection reports `unknown`.

---

## Graceful Shutdown

For complete removal rather than a graceful stop, see [How do I uninstall a hermit?](faq.md#how-do-i-uninstall-a-hermit).

The entrypoint traps SIGTERM. It sends the configured `shutdown_skill`, if any, then waits within its 30-second timeout until `state/execution.json` is no longer `in_flight`. When a skill was sent, the observation must be newer than that send. `hermitd-docker down` uses the same boundary with its existing 60-second timeout before removing the container.

## Context clear

The watchdog clears context at a safe execution boundary when the operator has been quiet for an hour, the context is a day old, or policy changed. The token floor and two-tick quiescence guard still apply. Records never close because time passed.

## Crash Recovery

Container restarts trigger recovery automatically:

1. Entrypoint re-seeds onboarding bypass and channel symlinks
2. `hermitd-start` launches tmux with Claude Code
3. The resident reads execution state and open task records
4. Hermit offers to resume where it left off

`restart: unless-stopped` handles crashes and host reboots. Session state is on disk via the project bind mount, config state persists in the `claude-config` named volume — nothing is lost.

---

## Cost Management

**Spend caps:** set daily, weekly, and monthly USD caps in the `budget` block of `.hermit/config.json`, through `/hermitd:hermit-settings`. They cover the whole installation, not one session: every session's Stop in the folder counts toward them, background helpers included. A cap warns once at 80%; at 100% it writes a breach alert, or pauses the resident until the window resets, depending on `budget.action`. Ships inert, so nothing is capped until you set one. See [Budget](config-reference.md#budget).

**Token optimization** (managed in `config.json` `env`):

| Setting                            | Value   | Effect                           |
| ---------------------------------- | ------- | -------------------------------- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`  | `65`    | Compacts at 65% context          |
| `MAX_THINKING_TOKENS`              | `10000` | Prevents runaway reasoning costs |

Adjust with `/hermit-settings env`.

---

## Gotchas

| Issue | Fix |
| --- | --- |
| Ubuntu 26.04 default user conflicts at UID 1000 | `userdel -r ubuntu` before `useradd` — handled by Dockerfile |
| Volume paths must match host | `${PWD}:${PWD}`, not `/app` or `/project` |
| OAuth credentials expired | Re-run `hermitd docker login` and restart with `hermitd-docker restart` |
| Entrypoint exits after tmux spawns | Entrypoint polls `tmux has-session` to keep PID 1 alive. SIGTERM trap handles graceful close. |
| `.local` mDNS hostnames don't resolve | Use IP addresses in service URLs, even with `network_mode: host` |
| Workspace trust prompt on first run | Attach once, press Enter, detach |
| `permission_mode` shows `bypassPermissions` or `auto` causing unexpected pauses in fully unattended ops | Change via `/hermit-settings permissions` — use `bypassPermissions` for zero-prompt unattended Docker, `auto` for classifier-reviewed autonomy |
| Windows paths break config | Must run from WSL2 — clone inside WSL2 (`/home/you/project`) |
| Docker not available | Channels still work — see [Always-On Operations](always-on-ops.md) for bare tmux |

---

## Moving to a new host

See [How do I move my hermit to another machine?](faq.md#how-do-i-move-my-hermit-to-another-machine) for the base steps, then handle these Docker-specific additions:

1. **Stop the container before leaving the source:** `hermitd stop`
2. **Auth credentials are in the named volume** (`claude-config`) — they do not migrate with the project. Re-authenticate on the destination with `hermitd-docker login` after the container is up
3. **Rebuild the image on the destination:** run `/hermitd:docker-setup` (or bring up the existing compose file if the host environment is identical)

The named volume is the main Docker-specific gotcha — it holds OAuth credentials and Claude Code's internal config. There's no way to transfer it cleanly across hosts. Plan to re-authenticate on the destination.
