---
name: docker-setup
description: Host-only, operator-invoked. Generates Docker scaffolding and walks the operator through token setup, build, start, MCP plugin configuration, workspace trust, and verification. Offers to back up and overwrite existing Docker files. Run after /hatch.
disable-model-invocation: true
---

# Docker Setup

Generate Docker scaffolding for running hermit as an always-on autonomous agent in a container. Docker provides isolation, crash recovery, and a reproducible environment. The default `auto` mode (classifier-reviewed autonomy) works well for most Docker hermits. Operators who need zero prompts for fully unattended operation can opt into `bypassPermissions` via `/hermit-settings permissions`.

**Tone:** Friendly guided wizard. Celebrate progress. When something fails, help fix it.

**Important:** Step 0's container check is a hard short-circuit — run it first and abort on `container` before anything else. After confirming host execution, run `docker-preflight.ts` once (Step 1) — it gathers all the read-only signals (docker presence, config existence, WSL path, existing docker files, host `~/.gitconfig`, auto-memory seed, a live non-Docker owner of the state dir) as a single JSON blob, so don't fan those probes out into separate Bash calls. Reuse its result for the git-identity (Step 4) and auto-memory (Step 5) decisions rather than re-probing. Step 2's project-dependency scan stays normal file reads (Read tool) plus analysis. Everything that mutates state or drives the container (file backups, `docker compose`, `tmux`, `mkdir`/`touch` setup-mode, status polls, channel `send-keys`) must run strictly sequentially in its documented order — never batch those.

Templates live in `${CLAUDE_SKILL_DIR}/../../state-templates/docker/`.

## Commands
- `channel-group-add`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" group-add`

## Plan

### 0. Refuse to run inside the hermit container

This skill is host-only — it generates Docker scaffolding on the host filesystem and drives `docker compose up`.

Run: `[ -f /.dockerenv ] || [ -f /run/.containerenv ] && echo container || echo host`

If the output is `container`, **stop immediately** — do not proceed to step 1. Print:

> This skill generates host-side Docker scaffolding and then drives `docker compose up`. Run it from your host shell in the project root. To pair a channel later, run `/hermitd:channel-setup` from the host. To check what's already configured *inside* the running container, run `/hermitd:hermit-doctor`.

### 1. Prerequisites

Run the pre-flight probe once and parse its JSON: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/docker-preflight.ts "$(pwd)"` — pass `"$(pwd)"` so the auto-memory path key is keyed off the shell's logical path, matching Claude Code even through a symlinked project root. It returns `{ dockerVersion, configExists, isWSL, existing: {dockerfile, entrypoint, compose}, gitconfigExists, memory: {pathKey, seedExists}, liveOwner }`. Hold the result — Steps 4 and 5 reuse `gitconfigExists` and `memory` instead of re-probing. Apply these gates:

1. If `dockerVersion` is null: "Docker isn't installed — grab it from https://docs.docker.com/get-docker/ and come back!"
2. If `configExists` is false: "Run `/hermitd:hatch` first, then come back."
3. If `isWSL` is true: abort — "Clone inside WSL2 (e.g. `/home/you/project`) and run from there."
4. If `liveOwner` is non-null (`{ mode, ageSecs }`): abort: "A live `<mode>` hermit owns this project's state (activity `<ageSecs>`s ago). Stop it first with `hermitd stop` (run it from a separate terminal if this session *is* that hermit), then re-run this skill." Drop the parenthetical when `ageSecs` is null. The container's entrypoint refuses to boot beside it and goes inert, so this must abort before anything is backed up, written, or built. Do not offer to stop it for the operator, and do not suggest `HERMIT_FORCE_BOOT=1`: that override is for split-state recovery, not for a hermit that is simply still running. If the operator reports that `hermitd-stop` itself refused ("No tmux session … but state activity Ns ago"), the recorded owner is a stale record, not a live hermit — the liveness it sees is this session's own; have them follow the `pgrep -af "claude --channels"` line `hermitd-stop` prints, kill any orphan it names, and re-run `hermitd-stop` once nothing is left.
5. If any of `existing.dockerfile` / `existing.entrypoint` / `existing.compose` is true:
   - List them, then ask with `AskUserQuestion` (header: "Docker files"): **No — keep existing** (abort; remove or rename manually, then re-run) / **Yes — back up** (move to docker-backup/ and regenerate).
   - "Yes — back up" → move to `docker-backup/`, continue
   - "No — keep existing" → abort
   - Never overwrite `.env` — only append missing vars (step 5).

### 1.5. Setup mode gate

Determine whether to run in **Quick** or **Advanced** mode.

**Argument-driven**: if invoked with the positional argument `quick` (e.g. `/hermitd:docker-setup quick`), skip the question below and run Quick directly. The operator can always re-invoke `/hermitd:docker-setup` without the arg later to drop into Advanced.

**Otherwise, ask:**

```
questions: [
  {
    header: "Setup mode",
    question: "How would you like to configure Docker?",
    options: [
      { label: "Quick", description: "OAuth + bridge networking, auto-mirror trusted plugins, build immediately" },
      { label: "Advanced", description: "Full wizard — pick auth, networking, every plugin, every package" }
    ]
  }
]
```

**Quick-mode contract — security non-negotiables.** Quick mode never bulk-accepts third-party plugins, never weakens the safelist, never skips the public-repo pre-flight, and never bypasses the write-time assertion. Those gates exist because that's the line where defaults stop being safe. Quick only auto-defaults the choices that have one obviously-correct answer (auth, networking, build-now) and the SAFE plugin batch (claude-plugins-official + gtapps/* — already vetted by the safelist). Minting the long-lived setup token is never one of those auto-defaulted choices — in both Quick and Advanced it's a post-login question at Step 8.

Branch on the choice for the rest of the skill:
- **Advanced** → continue at Step 2, asking every question.
- **Quick** → apply Quick defaults silently throughout (Step 2 auth+network, Step 7b SAFE mirror, Step 7b.packages safelisted-source auto-accept, Step 8 build-now). The Quick-specific behavior is called out inline at each downstream step.

### 2. Ask operator and analyze project

**Quick:** silently apply `auth = oauth-token`, `docker.network_mode = "bridge"`. Skip the `AskUserQuestion` below. Continue at the project-dependencies scan below.

**Advanced:** ask auth method and networking in a single `AskUserQuestion` call:

```
questions: [
  {
    header: "Auth",
    question: "Authentication method for the container?",
    options: [
      { label: "Subscription", description: "Log in inside the container — the long-lived setup token is offered right after login (recommended)" },
      { label: "API Key", description: "Set ANTHROPIC_API_KEY in .env — bills per token instead of using a subscription" }
    ],
  },
  {
    header: "Networking",
    question: "Container network mode?",
    options: [
      { label: "Bridge", description: "Isolated from host-local services (default)" },
      { label: "Host", description: "Direct access to localhost services — use if hermit needs host-bound services" }
    ]
  }
]
```

Record auth choice as `auth = oauth-token` for Subscription, `auth = api-key` for API Key. Record networking choice as `docker.network_mode` (`"bridge"` or `"host"`).

**Project dependencies scan:** Scan for signals that suggest extra system packages:
   - `package.json` native addons (sqlite3, sharp, canvas, bcrypt, etc.)
   - Python files (`requirements.txt`, `pyproject.toml`, `Pipfile`)
   - Build files (`Makefile`, `CMakeLists.txt`), version managers (`.tool-versions`)
   - Database config (prisma, knex, sequelize)
   - OPERATOR.md mentions of tools/stack
   - `.claude/settings.json` and `.claude/settings.local.json` `permissions.allow` entries — allowed Bash commands reveal tools the project expects (e.g. `Bash(docker *)` → docker CLI, `Bash(python *)` → python3, `Bash(psql *)` → postgresql-client). Check for commands that need system packages not in the base image.

   Present findings conversationally with reasoning. If nothing found, say so. Collect as provisional candidates — confirmation is deferred to step 7b.packages after plugin selection, where plugin-declared deps are unioned in.

### 3. Read config and prepare

Read `.hermit/config.json` and extract:
- `tmux_session_name` — resolve `{project_name}` with actual directory name
- `agent_name`
- Detect project path from `pwd`

Do NOT set `AGENT_HOOK_PROFILE` in `config.json` `env` — leave it unset. The strict profile is rendered into the docker-compose environment block at Step 7b.6 via the `agentHookProfile` render input, which the launcher treats as an ambient value and honors over anything in config. Setting it in config as well only creates a second source to keep in sync.

### 4. Template inputs (rendering deferred to Step 7b.6)

> `scripts/render-docker-templates.ts` renders the three base files at Step 7b.6, after plugin resolution (Step 7b) and the apt-package union (Step 7b.packages) have finalized `docker.packages` and Step 7 has configured channels. Here, only collect the semantic inputs the render call needs; do not read or write template files yet.

The render script derives every `{{PLACEHOLDER}}` internally and fails loud (writes nothing) if any survives. Assemble this input object as choices resolve, to be piped on stdin at Step 7b.6:

- `packages` — the finalized `docker.packages` array (Step 7b.packages). Empty array → no project-package layer.
- `auth` — `"oauth-token"` for subscription, or `"api-key"` (Step 2). The mint-or-keep decision at Step 8 does not affect rendering — both subscription outcomes render as `oauth-token` and add no auth env line, since their credential lives on the named volume (`.hermit-setup-token` if minted, `.credentials.json` otherwise). The setup-token deliberately never goes in `.env`: compose applies `env_file` only at container creation, so an `.env`-stored token would force a host-side recreate on every renewal.
- `channels` — `{ envLines: [...], volumeLines: [...] }`, one entry per enabled channel (Step 7). Pass the line **bodies** (the script owns the `      - ` indent):
  - env body: `<VAR>_STATE_DIR=${PWD}/.claude.local/channels/<plugin>` (VAR = `DISCORD` / `TELEGRAM`)
  - volume body: `${PWD}/.claude.local/channels/<plugin>:/home/claude/.claude/channels/<plugin>` (keeps channel writes inside the project tree — no permission prompts under `bypassPermissions`)
  - No channels → both arrays empty.
- `agentHookProfile` — always `"strict"` for Docker (the profile the remaining hooks read; permission rules are native `permissions.deny` / `permissions.ask`, not profile-gated).
- `networkMode` — `docker.network_mode` (`"bridge"` or `"host"`, Step 2).
- `gitIdentityMount` — the Step 1 preflight `gitconfigExists`. When **false**, the `.gitconfig` bind-mount is dropped and you must add to the summary: "No ~/.gitconfig found — git commits inside the container will have no author identity. Create one on the host and re-run docker-setup, or set git config manually inside the container."
- `fleetMesh` - read `docker.fleet_mesh` from the project's `.hermit/config.json`; absent means `false`. Never ask interactively. When true, tell the operator that the two external volumes and the `hermit-fleet-pidns` holder in `docs/always-on.md` must exist before `hermitd-docker up`.

### 5. Auto-memory seed

The Step 1 preflight already resolved `memory.pathKey` (Claude Code's own scheme: every non-alphanumeric character becomes `-`, dots included, leading dash kept — e.g. `-home-user-myproject`) and `memory.seedExists` (whether `MEMORY.md` exists under `<config-dir>/projects/<pathKey>/memory/`, where `<config-dir>` is `CLAUDE_CONFIG_DIR` when set and `~/.claude` otherwise). Reuse those:

- **If `memory.seedExists` is true:** Copy `MEMORY.md` from that same `<config-dir>/projects/<memory.pathKey>/memory/` to `.hermit/MEMORY-SEED.md`. Tell the operator: "Found existing Claude Code memory for this project — seeding it into the container so your hermit starts with full context." Then ensure `.hermit/MEMORY-SEED.md` is in `.gitignore` (append if missing).
- **If false:** Do nothing. No message, no prompt.

Only the top-level project memory is seeded — not agent-scoped memories at `<path-key>/<agent-name>/`.

### 6. Environment and protection

1. If `.env` doesn't exist, create it. If it does, read it first.
2. **If apikey:** Check if `ANTHROPIC_API_KEY=` is present in `.env`. If missing, append:
   ```
   # --- hermitd ---
   ANTHROPIC_API_KEY=your-api-key-here
   ```
   If already present, leave it — note for step 8.
   **If subscription (oauth):** No auth var needed in `.env`. Check whether `ANTHROPIC_API_KEY` is set (non-empty) in `.env`. If so, warn and ask with `AskUserQuestion` (header: "API key"): **Yes — comment out** (prefix with # to disable it) / **No — keep** (container will run in API key mode).
   Also remove any `CLAUDE_CODE_OAUTH_TOKEN` line you find in `.env` — this is not a preference. A token stored there is baked in at container creation, so renewing it would require recreating the container from the host, which is exactly the manual access token mode exists to remove. The hermit stores it on the config volume and exports it at process start instead.
3. Ensure `.env` is listed in both `.gitignore` and `.dockerignore` (create the files if needed, append if missing).
4. **Sandbox note:** Hermit does not configure the Claude Code bash sandbox for container deployments — that's the operator's call via `/sandbox`. `bubblewrap`/`socat` are installed in the image so it's available if wanted. The container boundary (`cap_drop:ALL`, `no-new-privileges`, network policy) is the isolation layer here, per Anthropic recommendation for unattended runs (https://code.claude.com/docs/en/sandbox-environments), so the nested bwrap sandbox is optional rather than required. Note: on Ubuntu 24.04+/26.04 hosts (and any host with `kernel.apparmor_restrict_unprivileged_userns=1`) the AppArmor `docker-default` policy blocks `bwrap` from creating user-namespaces in-container, so an in-container sandbox may not start there and could kill heartbeat and `/watch` monitors if forced on regardless.

### 7. Channel setup

Skip if no enabled channels in `config.json`. Read `.hermit/config.json` from the project root (same root verified in Step 1 — do not rely on cwd). A channel counts as present when `config.channels[<name>].enabled !== false` (missing `enabled` is treated as enabled). Empty `channels: {}` skips.

**Token locations in Docker:** Always use `.claude.local/channels/<plugin>/.env` (project-local scope). Never read or copy from global `~/.claude/channels/`.

| Plugin   | Token var            | Docker compatible |
|----------|----------------------|-------------------|
| discord  | `DISCORD_BOT_TOKEN`  | Yes               |
| telegram | `TELEGRAM_BOT_TOKEN` | Yes               |
| imessage | —                    | No (macOS only)   |

If iMessage detected, note it won't work in Docker and skip.

For each configured channel:

1. **Install plugin locally** (if not already): `claude plugin install <plugin>@claude-plugins-official --scope local`
2. **Ensure state dir:** Record `channels.<channel>.state_dir` as a relative path (e.g. `.claude.local/channels/discord`). `hermitd-start` resolves it against the project root at boot and derives the `*_STATE_DIR` env var — no need to add it to `env`. Absolute paths also work.
3. **Check local token file** (`.claude.local/channels/<plugin>/.env`):
   - Already configured → "Discord is ready — connects automatically on start."
   - Not configured → ask with `AskUserQuestion` (header: "Bot token"): **Skip** (write the token to `.claude.local/channels/{channel}/.env` later and restart) / **Enter now** (paste token via Other).
     - If "Enter now" and a token was typed via Other: `mkdir -p`, write `.env`, `chmod 600`, ensure `.claude.local/` in `.gitignore`, clean stale token from `.claude/settings.local.json` `env` if present. Confirm saved.
     - If "Skip": "Write it to `.claude.local/channels/<plugin>/.env` later and restart."

### 7b. Recommended plugins

Mirror host-installed plugins into the container so the container starts with the same plugin set the operator already curated — including any domain hermit (e.g. `hermitd-homeassistant`) that may have triggered this setup flow.

> **SECURITY-CRITICAL STEP.** Every plugin written here is auto-installed on container boot with whatever `permission_mode` the operator chose — for `bypassPermissions` hermits, this means full unrestricted execution.

1. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-siblings.ts "$(pwd)" --dedupe` to enumerate plugins. It emits a JSON array of the project-or-local + enabled entries (each carrying `plugin`, `id`, `marketplace_name`, `scope`, `installPath`), with user-scope, managed, disabled, and cross-project entries already dropped, and deduped by `(plugin, marketplace_name)` keeping the `local` entry over `project` (local is the override scope in Claude Code's overlay model). Different marketplaces remain distinct entries.

   If the operator wants a user-scope plugin in the container, they install it at `project` scope on the host first and re-run this skill.
2. Filter out additionally:
   - `hermitd@hermitd` — the entrypoint already handles it unconditionally.
   - Any channel plugins already picked up via `config.channels` (they flow through the entrypoint's channel branch).
3. Run `claude plugin marketplace list --json` and build a `marketplace_name → repo` map from each entry's `name` and `repo` fields. Split each plugin `id` as `<plugin>@<marketplace_name>` and look up `marketplace_name` in the map to get the `org/repo`. Only the `org/repo` is recorded on each `docker.recommended_plugins` entry — the entrypoint resolves the canonical marketplace name at boot via the same `marketplace list --json` lookup, so storing it twice would just duplicate the source of truth.
   - If a marketplace entry has `source != "github"` or no `repo` field (e.g. a locally-added marketplace), ask: "What's the GitHub source for the `<marketplace_name>` marketplace? (e.g. `org/repo`)" before presenting the plugin list.

4. **Validation gate — apply to every `org/repo` before it reaches the plugin list or `config.json`:**
   - Regex: `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$`
   - Applies to: `repo` values read from the marketplace JSON AND values typed by the operator.
   - If a value does not match: reject, explain why, re-prompt. Never write a failing value to config.
   - Purpose: defense-in-depth against malformed JSON, typos, or injected strings landing in `config.json` and being passed to `claude plugin install --marketplace` on boot.

5. **Partition the filtered list using the safelist:**

   ```
   def is_safelisted(marketplace):
       # marketplace is always org/repo after the step 7b.3 lookup — no literal-name shortcut.
       return (
           marketplace == "anthropics/claude-plugins-official"
           or marketplace.startswith("gtapps/")
       )
   ```

   The `marketplace` value passed to `is_safelisted` is always the `org/repo` resolved in step 7b.3 — never the marketplace name and never the slug from the `<plugin>@<name>` id.

   Split into two groups:
   - **SAFE** — `is_safelisted(marketplace)` is `True`. Examples: `anthropics/claude-plugins-official`, `gtapps/hermitd-homeassistant`.
   - **THIRD-PARTY** — everything else. Examples: `obra/superpowers-marketplace`, any non-`gtapps` `org/repo`, any locally-added marketplace without a GitHub source.

   The SAFE group can be accepted as a batch. The THIRD-PARTY group **must be confirmed one-by-one** — the host list is the **candidate** set, not the trusted set.

6. **Present the choices in plain text first**, so the operator sees the full list before any prompt (`AskUserQuestion` caps options at 4, so we cannot enumerate plugins in a single question):

   ```
   Host-installed plugins detected (project + local scope only):

   Safelisted (trusted sources):
     - context7 @ anthropics/claude-plugins-official (project)
     - hermitd-homeassistant @ gtapps/hermitd-homeassistant (project)

   Third-party (require individual opt-in):
     - superpowers @ obra/superpowers-marketplace (local)
   ```

7. **If the SAFE group is non-empty**:

   **Quick:** silently treat as if `"Mirror all"` was chosen — add every SAFE plugin to `docker.recommended_plugins` with `enabled: true`. No prompt.

   **Advanced:** ask once with `AskUserQuestion` (header: `"Plugins"`):
   - Options: `"Mirror all"` (Recommended) / `"Pick each"` / `"Skip all"`.
   - On `Mirror all`: add every SAFE plugin to `docker.recommended_plugins` with `enabled: true`.
   - On `Pick each`: loop through the SAFE plugins; for each, ask a 2-option yes/no (`"Include"` / `"Skip"`). Only include the ones the operator confirms.
   - On `Skip all`: add nothing from this group.

8. **For the THIRD-PARTY group**, loop through each plugin individually. For each, ask a 2-option `AskUserQuestion` (header: `"Third-party"`) — `"Include"` / `"Skip"`. Include only when the operator explicitly confirms.

8b. **Public-repo pre-flight (for every non-`claude-plugins-official` entry that the operator has tentatively confirmed in steps 7 or 8).** From the host, run an unauthenticated check against `https://github.com/<org>/<repo>` (e.g. `curl -fsI -o /dev/null -w '%{http_code}' https://github.com/<org>/<repo>`). If the response is not `200` (i.e. `404`, redirect-to-login, or network error), the repo is private or unreachable. Tell the operator:

   > `<org>/<repo>` appears private or unreachable. The container cannot clone private repos automatically.

   Then ask with `AskUserQuestion` (header: `"Private repo"`) — `"Include anyway"` / `"Skip"`. On `Skip`: drop the entry. On `Include anyway`: keep it. Do not suggest remediations.

9. After both groups are processed: any plugin not explicitly confirmed must **not** be written to `docker.recommended_plugins`. Write only confirmed entries with `enabled: true`.

10. **Write-time assertion — run this before handing entries to step 7c.** For each confirmed entry:
    - Assert `marketplace` matches `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$` (has a slash; is `org/repo`). Uniform across official and third-party entries — official stores `anthropics/claude-plugins-official`.
    - If any entry fails: **stop, do not write config.** Re-derive the failing entry's `org/repo` from the `claude plugin marketplace list --json` output (look up the marketplace name from the plugin's `id` to get the `repo`). If the lookup cannot produce a valid `org/repo`, prompt the operator (same prompt as step 3). Re-run the assertion. Only proceed to step 7c once every entry passes.

11. If the filtered list is **empty** (no extras installed on the host), skip silently — no prompt, no entries written.

Record the confirmed selection as `docker.recommended_plugins`. Each entry has:
```json
{"plugin": "<plugin-name>", "marketplace": "<org/repo>", "scope": "<scope>", "enabled": true}
```
The entrypoint installs every enabled entry on first boot with `claude plugin install <plugin> --marketplace <org/repo>`, which adds the marketplace if missing, so the entry needs no marketplace name. See [Recommended Plugins](../../docs/recommended-plugins.md) for the full policy.

This step always rebuilds `docker.recommended_plugins` from the current host plugin list; existing entries are replaced, not merged. The entrypoint warns and skips any entry whose `marketplace` is not an `org/repo` until this skill is re-run.

**On container-side `claude plugin install` failure (either in entrypoint logs or when re-running the command manually after boot):** if the error mentions SSH auth, HTTPS credentials, `gh` not found, or `.gitconfig` read-only, **stop immediately — do not attempt workarounds inside the container.** The container has no SSH client, no `gh` CLI, and `.gitconfig` is bind-mounted read-only by design. Iterating on `GIT_CONFIG_NOSYSTEM`, `git config --global url...insteadOf`, or similar is guaranteed to fail and wastes the operator's time. Surface the error to the operator verbatim and move on — no retry unless the operator changes something host-side (makes the repo public, mirrors it, etc.) and asks to retry.

### 7b.packages: Plugin-declared apt dependencies

After plugin selection is finalized, union the two sources of apt package candidates before writing to config:

1. **Project candidates** (from step 2.3 scan) — project-owned signals (native addons, Python stack, build tools, etc.). Live-scanned from project files each run.

2. **Plugin declarations** — for each confirmed entry in `docker.recommended_plugins`, locate the plugin's installed root via `claude plugin list --json` (inspect path fields). In the plugin root:
   - Check for a `## Docker apt dependencies` section in `skills/hatch/SKILL.md`.
   - Also check for a `DOCKER.md` file at the plugin root with the same section.
   - Extract the bullet-list entries under that heading (stop at the next `##` heading). Ignore lines starting with `#`.
   - **Validate every extracted package name** against `^[a-z0-9][a-z0-9+\-.]+$`. Entries that fail are dropped with a clear warning to the operator — never passed to Dockerfile rendering.
   - Track provenance: `<package-name> — declared by <plugin-name>`.
   - If no section is found for a plugin, skip silently (backward-compatible with plugins that predate this convention).

3. **Unified confirmation prompt** — present the combined deduped list with origin labels:
   ```
   Proposed image packages:
     libsqlite3-dev       — project signal (package.json sqlite3)
     <package-a>          — declared by <plugin-name>
     <package-b>          — declared by <plugin-name>
   ```
   Operator approves, removes, or adds entries. Write the approved set as the final `docker.packages` (passed to step 7c for config.json write).

   **Quick mode auto-accept**: if every entry in the combined list (a) passed the validator regex and (b) came from a safelisted source — meaning project-signal entries OR entries declared by plugins where `is_safelisted(marketplace)` is true (claude-plugins-official + gtapps/*) — skip the prompt and accept the list silently. Print a one-line summary so the operator sees what landed: `Quick auto-accepted N image packages (all from safelisted sources). Configure later via /hermit-settings docker.` If ANY entry came from a third-party plugin (operator-confirmed in Step 7b), fall through to the prompt — defaults stop applying once a third-party source contributed apt deps.

### 7b.6. Render templates (deferred from Step 4)

Now that `docker.packages` (Step 7b.packages), channel state dirs (Step 7), and the auth/network choices (Step 2) are finalized, render the three base files in **one** call. `render-docker-templates.ts` derives every `{{PLACEHOLDER}}`, renders `Dockerfile.hermit` + `docker-compose.hermit.yml`, `cp`-copies the entrypoint verbatim, and fails loud (exit 1, nothing written) if any placeholder survives. Anchor the argv to the **absolute** `<PROJECT_ROOT>` (Step 1) — cwd can drift after earlier `docker compose` / `tmux` calls. Pipe the Step 4 input object on stdin:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/render-docker-templates.ts <PROJECT_ROOT> <<'HERMIT_RENDER_JSON'
{
  "packages": [...],
  "auth": "oauth-token" | "api-key",
  "channels": { "envLines": [...], "volumeLines": [...] },
  "agentHookProfile": "strict",
  "networkMode": "bridge" | "host",
  "gitIdentityMount": true | false,
  "fleetMesh": true | false
}
HERMIT_RENDER_JSON
```

The script prints `{ "written": [...], "entrypointCopied": true, "manifestSeed": {...} }`. If `gitIdentityMount` was false, surface the summary note from Step 4.

**Record the template baselines in the manifest** (arms the `hermit-evolve` drift signals) by piping `report.manifestSeed` — emitted with absolute paths and the current plugin version — straight into `manifest-seed.ts`. **Do not hand-compute the hashes.**

Pipe **only the value of the `manifestSeed` field** (the `{ "pluginVersion", "entries" }` object): NOT the whole render stdout envelope. `manifest-seed.ts` expects a top-level `{pluginVersion, entries}`; handing it the full `{written, entrypointCopied, manifestSeed}` object seeds no baselines (the drift signals silently never arm).

```bash
echo '<the manifestSeed object only: {"pluginVersion":...,"entries":[...]}>' | bun ${CLAUDE_PLUGIN_ROOT}/scripts/manifest-seed.ts <PROJECT_ROOT>/.hermit
```

The `manifestSeed` payload deliberately hashes the **on-disk rendered** entrypoint (copied verbatim, so its hash equals the upstream template's — lets `hermit-evolve` Step 5c manage it as a boot-critical file) and the two **upstream** `.template` files (never the rendered output, which differs from upstream forever due to substitution — lets Step 10 report upstream drift without false positives). `manifest-seed.ts` preserves every other manifest key (`templates/`/`bin/` baselines, sibling-hermit keys) and refuses to overwrite a present-but-corrupt manifest.

### 7c. Write Docker settings to config.json

**Pre-write gate for `docker.recommended_plugins`:** Re-run the step 7b.10 assertion on every entry. If any fails, do **not** write — return to step 7b.3 to re-resolve.

Write all collected Docker settings to config.json in a single update:
- `docker.network_mode` (from Step 2)
- `docker.packages` (from Step 7b.packages)
- `docker.recommended_plugins` (from Step 7b, post-gate)
- `channels.<channel>.state_dir` (from Step 7, if applicable)

Merge into existing config — never remove existing keys.

### 8. Guided deployment

Print generated files summary:
```
Dockerfile.hermit              — container image definition
docker-entrypoint.hermit.sh    — startup script
docker-compose.hermit.yml      — orchestration config
.env                           — auth credentials
```

**Auth token (apikey only):** If operator chose apikey and `.env` already has a real key (not placeholder), skip. Otherwise ask with `AskUserQuestion` (header: "API key"): **Skip** (add `ANTHROPIC_API_KEY` to `.env` manually before starting) / **Enter now** (paste key via Other). If "Enter now" and a key was typed via Other: update `.env`.

**Build and start:**

Install the host operator command from the project root before either deployment path:

```bash
.hermit/bin/hermitd-run hermitd-cli install
```

**Quick:** silently treat as `Yes — build now` and proceed directly to the build sub-section below. No prompt.

**Advanced:** ask with `AskUserQuestion` (header: "Deploy"): **Yes — build now** (run hermitd-docker up immediately) / **No — manual** (print commands to run later).

**If "No — manual":** Print the full manual deployment guide below, then skip directly to Step 9 (do not attempt Login, Workspace trust, or Channel pairing — the container is not running yet):

```
Manual deployment guide
──────────────────────
1. Start the container:
   hermitd start

2. (Subscription auth only) From a second terminal, complete login:
   hermitd docker login

   Then, optionally (recommended), mint the long-lived token so future renewals need only a browser tap and no server access — skip it and you'll re-run `hermitd-docker login` from a terminal when the `/login` credentials expire:
   hermitd docker setup-token

3. Accept first-run prompts (press Ctrl+B D to detach when done):
   hermitd attach

   Screen 1 — Workspace trust: press Enter to accept.
   Screen 2 — Permission mode acknowledgement (appears for bypassPermissions AND auto; skip for acceptEdits/default/dontAsk):
     - bypassPermissions: arrow keys → "Yes, I accept" → Enter.
     - auto: "Enable auto mode?" → press 1 then Enter (persists in the named volume).

4. (Channels only) From a normal host session, pair each bot:
   /hermitd:channel-setup

5. Verify everything is healthy:
   hermitd status

Re-run /hermitd:docker-setup any time you want guided help.
```

**If "Yes — build now":**
1. Pre-create all channel state directories on the host so Docker doesn't create them as root on first mount — if a bind-mount source doesn't exist, `docker compose up` creates it owned by root, making it unwritable by the `claude` user inside the container. For each configured channel run `mkdir -p .claude.local/channels/<plugin>`. Then run `mkdir -p .hermit/state && touch .hermit/state/.setup-mode` to put the container in setup mode (suppresses the bootstrap prompt so channel pairing commands land on an idle REPL, not a busy session turn), and `rm -f .hermit/state/.boot-conflict` — the entrypoint only clears that marker at its own §4b guard, minutes into the boot, so a marker left by an earlier inert container would otherwise read as this boot's verdict. Then run `docker compose -f docker-compose.hermit.yml up -d --build` — builds and starts. Help fix errors (daemon not running, network, disk). Use `docker compose` directly here rather than `.hermit/bin/hermitd-docker up`: its trailing attach/detach echo is operator hand-off text, which step 9 delivers at the right moment.
2. **Verify the container stayed running:** Poll `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Service}}'` every 2s for up to 10s, checking `.hermit/state/.boot-conflict` on each tick. If the marker exists, the container is up but **inert**: the entrypoint found a live non-Docker instance owning this project's state and is holding PID 1 without starting claude, so `ps --status running` reports it healthy and every later step (login, trust, pairing) would run against a container with no tmux session. Show the marker's contents, then stop with: "Container is up but inert. Stop the other instance (`hermitd stop`), then `hermitd restart`." (Step 1's `liveOwner` gate catches this before the build; this poll covers a host hermit restarted mid-wizard.) An absent marker at this point is **not** an all-clear: the entrypoint writes it at §4b, after the credential wait and the first-run plugin install, so on a first boot it cannot exist yet — the first-run acceptance poll below re-checks it once the container has had time to get there. If the service appears and no marker exists — continue to the next sub-section. If it never appears after 10s, run `docker compose -f docker-compose.hermit.yml logs --tail=30 hermit` and show the output. Suggest a targeted fix based on the log:
   - **Daemon not running** → `docker info` errors → start Docker Desktop or `sudo systemctl start docker`, then re-run this skill
   - **Build failure** → read the build error line in the log above; fix the Dockerfile or missing dependency
   - **Missing `.env` var** → `docker compose -f docker-compose.hermit.yml config 2>&1 | grep -i error` names it
   - **Port conflict** → `ss -tlnp | grep <port>` finds what's using the published port
   **Do not continue to Login / Workspace trust / Channel pairing while the container is down or inert — stop here and ask the operator to fix and re-run the skill.**

**Login (subscription auth only):** If operator chose subscription auth, proceed only once the container is confirmed running. Guide them through login:
1. Tell them: "The container is waiting for you to log in. Run this from another terminal:"
   ```
   hermitd docker login
   ```
   This opens a claude REPL inside the container. Type `/login`, follow the URL in a browser, then paste the code back when prompted. Type `/exit` when done — the hermit starts automatically.
2. Ask with `AskUserQuestion` (header: `"Login"`) — `"Done — login succeeded"` / `"Failed — couldn't complete login"`. Do **not** poll logs in a loop. Do **not** rebuild or restart the container. `hermitd-docker login` already verifies `.credentials.json` and exits non-zero if absent, so a "Done" answer means creds are present.
3. On `"Failed"`: run `docker compose -f docker-compose.hermit.yml logs --tail=30 hermit` and show output. Suggest the targeted fix:
   - **OAuth URL unreachable** → copy the URL from the log and open it manually in a browser
   - **Code expired / rejected** → re-run `hermitd-docker login` (codes expire in ~10 min)
   - **Credentials not written** → `docker compose exec -T hermit ls /home/claude/.claude/.credentials.json` (should exist after login); missing = named volume not mounted — check `docker-compose.hermit.yml` volume entry
   Then **stop** — operator re-runs `/hermitd:docker-setup` after resolving the issue.

**Post-login decision — which credential this hermit runs on:** ask immediately after the login above succeeds. The attended login is still required first — the first-launch wizard demands an interactive login and will not accept the env token (confirmed live), and initial setup is attended anyway.

Both options renew from chat with no server access; they differ in cadence and in what the credential can do. Present them neutrally, with no recommendation — background on the two credential types is at `https://code.claude.com/docs/en/authentication`.

Ask with `AskUserQuestion` (header: `"Auth method"`) — **Sign in with claude.ai** (the credential you just created; renewed about every 30 days from chat, and Remote Control works on it, so you can reach this hermit from claude.ai/code or your phone) / **Long-lived token** (a one-year token stored only on the container's config volume, never printed or written to `.env`; renewed yearly from chat, and Remote Control does not work on this credential today).

**Sign in with claude.ai:**
1. Record the choice — the hermit is already running on this credential, so nothing else has to happen:
   ```
   .hermit/bin/hermitd-run settings-edit .hermit/config.json set auth_mode login
   ```
2. Note for the summary: renewal is due in about 30 days, the hermit asks over the channel 3 days ahead, and it takes one browser tap with no server access — it stages the new sign-in and applies it on its own restart. Remote Control is available on this credential; converting to a long-lived token any time is `hermitd docker setup-token`. Continue to first-run acceptance.

**Long-lived token:**
1. Tell them: "One more step and this hermit never needs server access again. Run:"
   ```
   hermitd docker setup-token
   ```
   It prints a sign-in link, takes the code back, writes the token to the container's config volume, and restarts the hermit. The token is never printed and never stored in `.env`.
2. Ask with `AskUserQuestion` (header: `"Token"`) — `"Done"` / `"Failed"`. On `"Failed"`, the hermit still works on the `/login` credentials from the previous step; tell the operator that plainly and that they can retry `hermitd-docker setup-token` any time. Do not block setup on it.
3. On success, note for the summary: renewal is due in a year, the hermit will ask over the channel 3 days ahead, and it takes one browser tap with no server access. Remote Control does not work on this credential today — switching back is `hermitd docker login`. Continue to first-run acceptance.

**First-run acceptance (workspace trust + bypass mode):** Before asking the operator to attach, verify the tmux session exists inside the container (the entrypoint may still be installing plugins):
```
docker compose -f docker-compose.hermit.yml exec -T hermit tmux has-session -t <TMUX_SESSION_NAME>
```
If the session is not ready, retry every 5s until one of two **outcomes** lands: the tmux session appears (continue), or `.hermit/state/.boot-conflict` appears (stop). This is where an inert container actually surfaces, since the entrypoint reaches its §4b guard only after the credential wait and the first-run plugin install, well past step 8.2's poll. On the marker, show its contents and stop with the same message step 8.2 uses ("Container is up but inert. Stop the other instance (`hermitd stop`), then `hermitd restart`."); do not continue to workspace trust or channel pairing. A first run installs plugins over the network, so a slow boot here is normal: give up only after 10 minutes with neither outcome, then show the last 30 lines of entrypoint logs (`docker compose logs --tail=30 hermit`) and stop.

Note: a running tmux session does **not** mean claude has finished booting — it may still be sitting on an acceptance screen waiting for input.

Once the session exists, tell the operator:

> "Attach now and accept two prompts in order — claude will look frozen until you do, and later steps will misdiagnose it as a crash if you skip this:"
> ```
> hermitd attach
> ```
> **Screen 1 — Workspace trust** (always): You'll see "Accessing workspace … Quick safety check: Is this a project you created or one you trust?" — press **Enter** to accept.
>
> **Screen 2 — Permission mode acknowledgement** (only if `permission_mode` is `bypassPermissions` OR `auto`):
> - If `bypassPermissions`: you'll see the `--dangerously-skip-permissions` acknowledgement. Use the **arrow keys** to select **"Yes, I accept"**, then press **Enter**.
> - If `auto`: you'll see "Enable auto mode?" with three options. Press **1** then **Enter** ("Yes, and make it my default mode") so the acknowledgement persists in the named volume and won't re-prompt on future restarts.
>
> After accepting, you'll see a **blank claude prompt** — that's expected during setup. The skill will send pair commands from here; don't type a command yourself.
>
> Then press **Ctrl+B, D** to detach.

Read `config.permission_mode` from `.hermit/config.json`. If it is NOT `bypassPermissions` AND NOT `auto`, omit the "Screen 2" paragraph entirely. Otherwise emit it, and inside the paragraph keep only the branch matching the resolved mode (drop the other bullet).

Wait for the operator to confirm they have detached before continuing.

**Channel pairing** (skip if no channels or no tokens configured):

For each channel, **first verify the token is configured** — check that `.claude.local/channels/<plugin>/.env` exists and contains the expected `*_BOT_TOKEN` var. If missing, skip pairing for this channel and tell the operator: "No token configured for `<channel>` — write it to `.claude.local/channels/<plugin>/.env`, restart the container, then re-run `/hermitd:channel-setup` to pair." Move to the next channel.

If the token is present, ask if already paired. If not:
1. Ask with `AskUserQuestion` (header: `"<channel> pairing"`) — `"I have the code"` / `"Skip this channel"`. On `"I have the code"`: ask for the 6-char code via `Other` (header: `"Bot code"`).
2. Pair against the host-visible Hermit state directory:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<project_path>/.hermit" pair <plugin> <code>
   ```
   `OK|pair|...|file=state` confirms the access write and approval marker. If `file=home` or `file=home+state`, retain that result for sub-step 5. On `ERROR|`, report the token and stop this channel. The native permission prompt names the code; bypass-mode callers are refused.
3. Set policy after successful pairing:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<project_path>/.hermit" policy <plugin> allowlist
   ```
   Relay the `OK|policy|` result or stop on `ERROR|`.
4. Ask with `AskUserQuestion` (header: `"Pair result"`) — `"Bot confirmed paired"` / `"No response"` (description: `Still nothing after waiting up to 1 min`). On `"No response"`: run `docker compose -f docker-compose.hermit.yml exec -T hermit tmux capture-pane -t <session> -p`, show output, and skip `access.json` verification for this channel — don't fail the whole setup.
5. **Verify the host-side pairing and policy results** (only on "Bot confirmed paired"): use the `channel-access.ts` results from sub-steps 2 and 3 and read the configured channel's `access.json` under `<project_path>`. If pairing reported `file=home` (not `file=home+state`, which already updated the state file), the bot that issued the code is using the host's Claude home directory; run `/hermitd:channel-setup` from the host to complete its home-to-state location check before proceeding.
6. **Default delivery settings** (skip if pairing was skipped this run):
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<project_path>/.hermit" ensure-defaults <plugin>
   ```
   Relay `OK|ack=set` or `OK|ack=kept`; an empty string or custom reaction stays unchanged. Stop this channel on `ERROR|`.
7. **Server channel / group chat (optional)** (run even if "Already paired" was chosen; skip only if `imessage`, if "Skip this channel" was chosen, or if pairing returned "No response"):
   Run [the group questionnaire](../channel-setup/references/group-enrollment.md) with the channel key, absolute `<project_path>/.hermit` state directory, and native `AskUserQuestion` prompts. Then continue to sub-step 8.
8. **Capture the bot's own identity** (host-side, like `channel-access.ts` — `config.json` and the channel `.env` are both on the host):
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-bot-id.ts <project_path>/.hermit <plugin> --write
   ```
   Records `bot_user_id` (and `bot_username`) so the hermit reads a mention of itself as addressed to it, rather than as third-party traffic. A `SKIP …` line is a non-event — report it and continue.
9. Confirm: "Paired and locked down. If the bot doesn't respond to your first message, give it up to 2 minutes — the hermit may still be booting or running initial checks (plugin installs, workspace trust, auto-memory seeding)."

If "skip": tell them to DM the bot later and run the commands manually.

### 8b. Finalize — clean restart

**Skip this step entirely if the operator chose "No — manual" at step 8.** The container isn't running, so there's nothing to restart.

Tell the operator (set expectations — this step takes ~30-60s and otherwise looks like a hang):

> "Finalizing setup with a clean restart so the first real hermit session starts with everything configured and plugins fully loaded."

Then run, in sequence:

1. `.hermit/bin/hermitd-docker down`; sends the configured shutdown skill, if any, and polls for a fresh execution boundary up to 60s before removing the container. If it prints "Timed out waiting for graceful close; forcing stop", flag it in the final summary (session that witnessed setup didn't close cleanly; not blocking but worth noting).

2. `docker compose -f docker-compose.hermit.yml up -d` — recreates the container. Use `docker compose` directly, as in step 8, not `hermitd-docker up`. Docker's named volume preserves credentials, plugins, workspace trust. Bind-mounts preserve `.claude.local/channels/<plugin>/access.json` and `.hermit/`.

3. Re-verify the container stayed running (same poll as step 8.2). If it failed to come back up, run `docker compose -f docker-compose.hermit.yml logs --tail=30 hermit`, show the output, and apply the same targeted hints as step 8.2 (daemon down, build failure, port conflict). Stop — don't proceed to step 9.

Why this step exists: mid-setup, claude REPL starts before plugins are fully enabled and channel pairing completes. The session it was running is a "bootstrap session" full of setup chatter. A clean restart gives the operator a first *real* session with correctly-loaded plugins, fresh tmux state, and no config-time noise.

Why `down` + `up` rather than `hermitd-docker restart`: a recreated container clears ephemeral container-layer state and re-runs the entrypoint from a clean slate.

### 8c. Seed permission rules

Runs whether or not steps 8/8b were skipped. This step sits after the deployment steps on purpose: it seeds `Bash(docker *)` / `Bash(ssh *)` / `Bash(kubectl *)` into `permissions.ask`, and ask rules hot-reload — seeding earlier would make every `docker compose` call in steps 8/8b raise its own approval prompt mid-wizard.

**Resolve `hatch_target`** using the same fallback chain as `hermit-evolve` SKILL.md §2a (`.hermit/state/hatch-options.json` `"target"` field → marker scan of `CLAUDE.local.md` / `CLAUDE.md` → `claude plugin list --json` scope detection). Do not silently default to committed when the state file is absent — that can leak operator-personal hardening into the repo. Map: `hatch_target == "local"` → `.claude/settings.local.json`; `hatch_target == "committed"` → `.claude/settings.json`.

Run: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> deny standard`
(Reads canonical `deny` + `ask` from `state-templates/deny-patterns.json`. Purely additive and idempotent — it never removes an existing entry, so a hermit hatched Hardened keeps its hard blocks and a hermit already seeded at hatch gets nothing new. Risky ops such as docker/ssh/kubectl land as `permissions.ask`, so future host sessions prompt on them rather than hard-block.)

Tell the operator: "Added safety deny rules for always-on operation — protects against destructive commands and casual credential dumps. Risky ops (docker, ssh, kubectl, git push, settings edits) prompt for approval. Written to {.claude/settings.local.json | .claude/settings.json}."

### 9. Verify

**Enable the Docker watchdog.** Docker hermits run the watchdog from the entrypoint loop, so turn it on now:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json set watchdog.enabled true
```

This only flips `.watchdog.enabled` — the other watchdog tuning keys (`stale_factor`, `wedge_floor`, `escalate_after`, `operator_grace`) are preserved, the whole config is validated, and the change lands in the settings ledger. Never write `config.json` with Edit/Write or a shell redirect; direct `Edit` calls raise an approval prompt (seeded ask rule) and skip validation and the ledger.

Run `.hermit/bin/hermitd-status` and show output. The table reports transport, execution and its age, open and waiting task counts, and the first runnable task. Transport `up` means the `hermit` service is running; a sidecar alone reports `down`. Execution can be `unknown` until the first execution stamp appears. Do **not** add `sleep` before the status check.

If healthy:
```
You're all set! Your hermit is live and running autonomously.

  hermitd start               — start container
  hermitd stop                — graceful stop (--force to skip)
  hermitd attach              — connect to tmux session
  hermitd docker bash         — shell into container
  hermitd docker login        — subscription login (first boot)
  hermitd docker setup-token  — (optional) mint/renew the long-lived login token
  hermitd docker logs -f      — follow logs
  hermitd restart             — restart container
  hermitd update              — update host core, rebuild image, update plugins and auto-evolve
  hermitd status              — quick check
```

If something looks wrong, help diagnose — suggest concrete next steps.

---

## Notes

**Why `.hermit` suffix?** The project may already have its own `Dockerfile` / `docker-compose.yml`. Hermit-namespaced files avoid conflicts.

**Customizing the boot: `docker-entrypoint.hermit-local.sh`.** `docker-entrypoint.hermit.sh` is hermit-managed — `hermit-evolve` replaces it whenever upstream changes, so edits there are lost on upgrade (parked as a `.bak`, and re-homed into the sidecar automatically when a baseline is available). The supported place is `<project-root>/docker-entrypoint.hermit-local.sh`, which upgrades never touch. It is **sourced** at two points, with `HERMIT_ENTRY_PHASE` naming which: `pre-boot` (channel dirs exist, env resolved, before plugins install — extra packages, env, mounts) and `pre-launch` (immediately before `hermitd-start` — side services, last-second overrides). It inherits `set -euo pipefail`, so a failing command aborts the boot exactly as an in-file edit would: guard anything optional with `|| true`. It lives on the project bind mount, so edits apply on `hermitd restart` with no rebuild.

**Channel state: `*_STATE_DIR` env vars and bind-mounts.** Why MCP servers need OS env rather than `settings.local.json`, and why the channel state dir is bind-mounted rather than symlinked, are in [Always-On — channel state](../../docs/always-on.md). The one thing to carry while running this skill: pre-create each `.claude.local/channels/<plugin>/` on the host **before** `docker compose up`, or Docker creates it root-owned and the `claude` user can't write to it.

**Why a named volume for config?** The container gets its own `/home/claude/.claude` instead of sharing the host's, so container state (onboarding, auto-memory, plugin cache) never leaks into host interactive sessions. It persists across restarts; first run is slower while it populates.

**Want shared config instead?** Replace the `claude-config` named volume with a bind-mount in `docker-compose.hermit.yml`: `- ${HOME}/.claude:${HOME}/.claude` and set `CLAUDE_CONFIG_DIR=${HOME}/.claude`. Not recommended — changes in either direction leak.

**Domain-plugin apt dependencies.** Declare system packages your plugin needs in a `## Docker apt dependencies` section in the plugin's hatch SKILL.md or a `DOCKER.md` at the plugin root. See step 7b.packages and [Creating Your Own Hermit — Docker dependencies](../../docs/creating-your-own-hermit.md#docker-dependencies).

**Why the three hardening stanzas (`no-new-privileges`, `cap_drop`, `pids_limit`)?** Full per-stanza weighting is in [Security — Container Hardening](../../docs/security.md#container-hardening). The only operational consequence while running this skill: an operator extending the container with services on privileged ports (<1024), setuid helpers, or high-PID workloads has to relax the relevant stanza explicitly.

**Want stronger isolation?** `/hermitd:docker-security` is an opt-in wizard that adds LAN containment with DNS policy (firewall + DNS sidecar with port-53 redirect for actual enforcement), a read-only root filesystem with smoke test, resource bounds with kernel hygiene sysctls, and a boot-time plugin-install audit log. Each toggle is verified against the live container and is fully reversible. **Note:** the LAN containment toggle is hard-skipped when `docker.network_mode: "host"` is in use — bridge networking required. See [Docker Security](../../docs/docker-security.md).
