---
name: hatch
description: One-time Home Assistant setup for this hermit. Configures HA access, connects to the official Home Assistant MCP Server integration, and verifies both the CLI and HA MCP. Run once per project after /hermitd:hatch.
disable-model-invocation: true
---

# Home Assistant Hatch

Set up the Home Assistant layer for this project. Idempotent — safe to re-run; will skip completed steps and offer re-verify only.

## Plan

### 1. Prereq check

Check whether `.hermit/config.json` exists.

- If it is missing, print this block and stop:

  ```markdown
  ## ▶ Next step — type this now

      /hermitd:hatch

  I can't run setup wizards for you (they're operator-run by design).
  After it finishes, come back and type `/hermitd-homeassistant:hatch`.
  ```
- If it is present: run `.hermit/bin/hermitd-run domain-hatch preflight hermitd-homeassistant` and parse the JSON verdict. Branch on `action`:
  - `upgrade-core-package` / `upgrade-core-applied` → relay the `remedy` string verbatim to the operator and stop.
  - `verify` → `AskUserQuestion`: "Already set up. Re-verify HA access only (skip setup wizard)?". Yes → skip to §5. No → continue.
  - `full` → continue with setup.
  - `ok: false` → relay `message` and stop.

### 2. Verify .env

Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status` and inspect the JSON output.

> **Important**: do NOT use `grep`, `cat`, or `echo` on `.env` — the deny-pattern hook blocks any Bash command whose arguments contain the literal string `TOKEN`. Always use the CLI to check credential state.

- `token_configured: true` and `local_url` non-null → proceed.
- **If either is missing**:
  1. Tell the user:
     ```
     .env is missing or incomplete. Please create `.env` at the project root with:

       HOMEASSISTANT_URL=http://homeassistant.local:8123   # or your remote URL
       HOMEASSISTANT_TOKEN=<your long-lived access token>

     Long-Lived Access Tokens: Home Assistant → Profile → Long-Lived Access Tokens.
     ```
  2. `AskUserQuestion`: "When your `.env` is ready, type **done** to continue (or **abort** to stop)."
     - **done** → re-run `boot status` and re-check. If still missing, repeat from step 1. If valid, proceed.
     - **abort** → stop.
  Do not write or modify `.env` — it is the user's responsibility.

Also check locale:

- Read `.hermit/OPERATOR.md`. If a `## HA hermit` section has a `- Language:` entry, use it silently — do not re-ask.
- If absent, ask: **Language / locale**: What language should the agent use for HA-facing output? (e.g. `en`, `pt`, `es`) Save it via `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot store --language <locale>` (writes to OPERATOR.md under `## HA hermit`).

Do not collect or store the token — it stays in `.env` only.

### 3. CLI check

The CLI runs on bun, which the core hermit requirement guarantees — no runtime deps to install.

Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status` (read-only, no `--probe`) to confirm the launcher resolves correctly. If it fails with "bun not found", stop and tell the user to install bun (https://bun.sh) — it is required by `hermitd` core.

### 4. Home Assistant MCP Server setup

**Step A — Enable the integration in Home Assistant**

Tell the user: go to Home Assistant → Settings → Devices & Services → Add Integration → search "Model Context Protocol Server". Enable it. This exposes the MCP endpoint at `<your HA URL>/api/mcp`.

Reference: https://www.home-assistant.io/integrations/mcp_server/

**Step B — Write `.mcp.json`**

Read the HA URL from the `boot status` JSON (`active_url` field, already fetched in §2). Read the token from `.env` using:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status
```

For the token value, use the **Read** tool on `.env` (not Bash — the deny-pattern hook blocks any Bash argument containing the literal string `TOKEN`, including via `bun -e`). Parse the `HOMEASSISTANT_TOKEN=...` line in-memory and use the value directly when writing `.mcp.json`. Do not echo the token to the conversation or log it.

Check the project root for `.mcp.json`:
- If absent → write it with literal values substituted.
- If present → read it and check the `homeassistant` entry:
  - If absent → merge it in with literal values.
  - If present **and** the `url` or `Authorization` value contains `${` (old placeholder format) → rewrite that entry with literal values and tell the user the stale entry was replaced.
  - If present and already contains literal values → skip.

```json
{
  "mcpServers": {
    "homeassistant": {
      "type": "http",
      "url": "<HOMEASSISTANT_URL>/api/mcp",
      "headers": { "Authorization": "Bearer <HOMEASSISTANT_TOKEN>" }
    }
  }
}
```

Replace `<HOMEASSISTANT_URL>` with the `active_url` from `boot status` (resolves to `HOMEASSISTANT_URL`, or `HOMEASSISTANT_LOCAL_URL` for existing installs) and `<HOMEASSISTANT_TOKEN>` with the literal values read above.

The name `homeassistant` is required — skills and the safety hook match on `mcp__homeassistant__*` tool IDs.

> **Note**: `.mcp.json` now contains a live bearer token. Claude Code reads MCP env vars from the process environment, **not** from `.env`, so literal values are required here.

After writing `.mcp.json`, check the project's `.gitignore`:
- If `.mcp.json` is absent from it → append `.mcp.json` on a new line.
- If already present → skip.

**Step C — Activate and verify**

Tell the user: **restart Claude Code** in this project directory. On first use, Claude Code will prompt you to trust the `homeassistant` server — approve it. Then run `/mcp` to confirm `homeassistant` appears as connected. The next `ha-boot` will verify live HA connectivity.

### 5. Verify CLI (full probe)

Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status --probe` and present the result. If it fails:

- bun not found → tell the user to install bun (https://bun.sh), then re-run this check.
- Connection refused → check `HOMEASSISTANT_LOCAL_URL` in `.env`.
- Auth error → check `HOMEASSISTANT_TOKEN`.

### 6. Append to CLAUDE.md / CLAUDE.local.md

**Resolve target file:** Step 1's preflight already returned `target`, `target_file`, `target_default` and `needs_target_question`.

If `needs_target_question` is true, ask with `AskUserQuestion` (header: "Visibility") — `target_default` at position 0 with `(recommended)`: **`.local` files** (gitignored — operator-personal) / **Committed files** (shared with teammates). Then record it:

```bash
.hermit/bin/hermitd-run domain-hatch ensure-target hermitd-homeassistant --target <choice>
```

Then write the block:

```bash
.hermit/bin/hermitd-run domain-hatch sync-block hermitd-homeassistant
```

It appends the `<!-- hermitd-homeassistant: Home Assistant Workflow -->` block when the marker is absent and skips when it is already present. Refreshing an existing block on a version bump is `hermit-evolve`'s job, not hatch's.

Stray-block migration (block stranded in the non-target file after a target flip) is handled one-shot by the Upgrade Instructions in this version's CHANGELOG entry, executed by `hermit-evolve` Step 7. Hatch itself stays focused on target-aware setup and steady-state refresh.

### 6.5 Safety mode

Read `ha_safety_mode` from `.hermit/config.json`.

- **If the key is already set**: `AskUserQuestion`: "Current safety mode is `<value>`. Change it?" Yes → re-prompt. No → skip this step.
- **If absent**: ask the operator which safety mode to use for sensitive domains (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`):
  - `strict` blocks autonomous actuation entirely; work goes through a proposal instead.
  - `ask` (recommended) prompts the operator before any actuation of a sensitive entity. Build/validate normally; both YAML apply and direct MCP calls require an explicit operator confirmation before execution.

Write the chosen value to `config.json` as `ha_safety_mode`. Default to `ask` if the operator skips or is unsure.

### 6.55 HA Assist control (optional)

Read `ha_assist_control_enabled` from `.hermit/config.json`.

- **If the key is already set**: skip (idempotent).
- **If absent**: ask — "Enable HA Assist as the runtime device-control path? When enabled, HA Assist intent tools (`HassTurnOn`, `HassLightSet`, etc.) pass through the safety gate and HA's expose-to-Assist setting controls which devices the agent can reach. Requires the HA MCP Server's control tools to be enabled and each entity exposed in HA (Settings → Voice assistants → Expose)."
  - **Yes** → write `ha_assist_control_enabled: true` to `config.json`.
  - **No / skip** → leave the key absent (fail-closed default; CLI remains available for automation triggering).

### 6.56 HA update one-tap apply (optional)

Read `ha_update_auto_apply` from `.hermit/config.json`.

- **If the key is already set**: skip (idempotent).
- **If absent**: ask — "Enable one-tap update handling? The daily `ha-update-check` always proposes pending Home Assistant updates for your review. With this on, accepting an **add-on or HACS** update installs it immediately (HA backs it up first, and rolls back on failure). Core, OS, and Supervisor updates always wait for your explicit go-ahead in chat, even with this enabled — those can affect dashboard access and have no software undo."
  - **Yes** → write `ha_update_auto_apply: true` to `config.json`.
  - **No / skip** → leave the key absent (fail-closed default; every pending update stays a proposal you apply yourself in the HA UI).

### 6.6 Knowledge-schema extension

Read `.hermit/knowledge-schema.md`.

Check if either `- analysis:` or `- **analysis**:` is present in the file. This string only appears as the last Raw Captures bullet written — so its presence means both blocks were fully written on a prior run.
If **absent**, append the following block under `## Work Products` (create the section header if the base schema only has a template stub):

```
- brief: morning/evening house brief. location: compiled/brief-<morning|evening>-<date>.md
- context: foundational house/system profile. location: compiled/context-house-profile-<date>.md
- presence-report: presence history and tracker diagnostics. location: compiled/presence-report-<date>.md
- domain-brainstorm: report from `/hermitd-homeassistant:domain-brainstorm`, written only when the run created at least one proposal. location: compiled/domain-brainstorm-<YYYY-MM-DD-HHMM>.md
```

And under `## Raw Captures` (create if absent):

```
- audit: HA operational audit (safety, integration-health, context-refresh). location: raw/audit-ha-<type>-<date>.md
- simulation: HA automation simulation result. location: raw/audit-ha-simulation-<slug>-<date>.md
- apply: HA automation apply result. location: raw/audit-ha-apply-<slug>-<date>.md
- remove: HA automation/script delete audit. location: raw/audit-ha-remove-<slug>-<date>.md
- analysis: HA pattern analysis. location: raw/patterns-<date>.md
```

If already present: skip (idempotent).

Use Edit to make the changes.

---

### 7. Stamp version and register routines

Write `_hermit_versions["hermitd-homeassistant"]` into `.hermit/config.json`, set to `self_version` from Step 1's preflight.

**Compiled templates**: Copy `${CLAUDE_PLUGIN_ROOT}/state-templates/compiled/acknowledged-violations.md` to `.hermit/compiled/acknowledged-violations.md` if that file does not already exist. Set `created` in the frontmatter to today's ISO date. This gives the operator a ready-to-use suppression list for the safety audit.

**Boot skill registration**: Read `config.boot_skill` from `config.json`.

The skill name format is `/<plugin-id>:<skill-id>`. Parse the plugin-id as the text between `/` and `:`.

- If `null` or absent → set it to `/hermitd-homeassistant:ha-boot`.
- If the value starts with `/hermitd-homeassistant:` → no-op (report "already set").
- Otherwise (another plugin's namespace) → leave it unchanged and warn: "boot_skill is already set to `<value>` from another plugin — skipping to avoid conflict. Run `/hermitd:hermit-settings boot-skill` to update it manually."

**HA routine registration**: `config.routines` is an array of objects with `{id, schedule, skill, enabled}`. For each HA routine below, check whether an entry with that `id` already exists in the array. If it does, skip. If not, prompt and merge it in.

1. **Context refresh** — "Add daily HA context-refresh routine (08:30 every day)? Keeps entity snapshots fresh automatically."
   ```json
   {"id": "daily-ha-context", "schedule": "30 8 * * *", "skill": "hermitd-homeassistant:ha-refresh-context", "enabled": true}
   ```

2. **Morning brief** — three paths based on the current `config.routines` state:

   **Fresh install** (no entry with `id: "morning-brief"` exists): prompt — "Add morning house brief routine? Delivers a unified morning summary combining house state and hermit context."
   - If yes: follow-up: "Use unified mode (08:30, replaces core `morning` routine)? Recommended for always-on setups."
     - Unified yes: merge `{"id": "morning-brief", "schedule": "30 8 * * *", "skill": "hermitd-homeassistant:ha-morning-brief", "enabled": true}`. If `config.routines` contains an entry with `id: "morning"` and `enabled: true`, set its `enabled` to `false` and emit: "Disabled core `morning` routine: `morning-brief` subsumes it."
     - Unified no (legacy): merge `{"id": "morning-brief", "schedule": "0 9 * * *", "skill": "hermitd-homeassistant:ha-morning-brief", "enabled": false}`.
   - If no: skip.

   **Re-hatch upgrade** (entry with `id: "morning-brief"` exists but has `schedule: "0 9 * * *"`): prompt: "Your `morning-brief` routine uses the old schedule (09:00). Upgrade to unified mode (08:30, always-on)?"
   - If yes: update in-place to `schedule: "30 8 * * *"`, `enabled: true`. Then disable core `morning` if present and enabled (same logic as fresh install unified path).
   - If no: leave unchanged.

   **Already current** (entry exists with `schedule: "30 8 * * *"`): skip (no-op, report "config is current: check `enabled` flag if the routine isn't firing").

   **Non-standard config** (entry exists but matches none of the above conditions — e.g. custom schedule): skip (no-op, report "non-standard `morning-brief` config detected — skipping upgrade prompt").

3. **Evening brief** — "Add evening house-check routine (22:30 every day)? Delivers a brief end-of-day security and device confirmation."
   - If yes: merge `{"id": "evening-brief", "schedule": "30 22 * * *", "skill": "hermitd-homeassistant:ha-evening-brief", "enabled": true}`. If `config.routines` contains an entry with `id: "evening"` and `enabled: true`, set its `enabled` to `false` and emit: "Disabled core `evening` routine: `evening-brief` subsumes it."
   - If no: skip.

After adding or updating any entries, remind the operator: "Run `/hermitd:hermit-routines load` to activate routines in the current session."

**Analysis routine registration**

Merge these entries into `config.routines` by id. Create the array if absent. Append each missing id; skip any existing id, preserving operator edits and all other config fields. No prompt is needed for these read-only analyses.

```json
{"id": "ha-patterns", "schedule": "5 9 * * 1", "skill": "hermitd:reflect --check-id ha-patterns --check hermitd-homeassistant:ha-analyze-patterns", "enabled": true}
{"id": "ha-safety-audit", "schedule": "5 9 * * 1", "skill": "hermitd:reflect --check-id ha-safety-audit --check hermitd-homeassistant:ha-safety-audit", "enabled": true}
{"id": "ha-integration-health", "schedule": "5 9 * * *", "skill": "hermitd:reflect --check-id ha-integration-health --check hermitd-homeassistant:ha-integration-health", "enabled": true}
{"id": "ha-update-check", "schedule": "5 9 * * *", "skill": "hermitd:reflect --check-id ha-update-check --check hermitd-homeassistant:ha-update-check", "enabled": true}
```

Each routine owns its cadence and passes findings through reflection gates into the proposal pipeline.

## Native approval rules

Resolve the project settings target through `.hermit/bin/hermitd-run domain-hatch preflight hermitd-homeassistant`. Map `target` (or `target_default` when absent): `local` to `.claude/settings.local.json`, `committed` to `.claude/settings.json`. Its `target_file` is the instruction destination, not the settings file.

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/native-permissions.ts <resolved-settings-file>`.

### 8. Final report

Summarize:

```
hatch complete
  ✓  .env verified (user-managed)
  ✓  CLI: bin/ha-agent-lab boot status --probe → OK / FAILED
  ✓  .mcp.json: homeassistant entry written / already present
  ✓  CLAUDE.md updated
  ✓  config.json stamped v<version>
  ✓  boot_skill: /hermitd-homeassistant:ha-boot (set | already set | operator override preserved)
  ✓  Routines registered: daily-ha-context, morning-brief, evening-brief, ha-patterns, ha-safety-audit, ha-integration-health, ha-update-check
  ✓  knowledge-schema.md: HA types added (or already present)

Manual steps remaining:
  - Enable 'Model Context Protocol Server' integration in Home Assistant (if not done)
    Settings → Devices & Services → Add Integration → search "MCP"
  - Restart Claude Code and approve the 'homeassistant' server on first use
  - Run /mcp to confirm 'homeassistant' is connected

Go always-on (recommended):
  - Docker:     /hermitd:docker-setup
      Builds the container and walks you through channel pairing in one go.
  - Bare tmux:  hermitd start
      For channels (Discord/Telegram) with tmux, run
      /hermitd:channel-setup first.

Prefer to test interactively first?
  1. /hermitd-homeassistant:ha-boot
       — single entry point: starts the hermit session, probes HA,
         and auto-refreshes the context snapshot if stale/missing.
  2. /hermitd:hermit-routines load
       — activates scheduled routines in the current Claude session.

The always-on runtime does both of these automatically — the interactive
steps are only for a test drive before handing over to the runtime.

Ready to organize your house?
  /hermitd-homeassistant:ha-setup-house
       — create areas, assign entities and devices, provision helpers,
         and scaffold starter automations.
```

---

## Docker network requirements

Read by `/hermitd:docker-security` when the operator enables LAN containment + DNS policy. Each entry is surfaced as a per-entry confirmation prompt; nothing here is auto-applied.

### Domains (DNS allowlist)

- nabu.casa
- home-assistant.io
- READ_FROM_ENV:HOMEASSISTANT_URL

### LAN allowlist suggestions

- ASK_OPERATOR_FOR_HA_IP

The `nabu.casa` entry covers Nabu Casa Cloud (`<id>.ui.nabu.casa`) since dnsmasq's `server=/nabu.casa/...` pattern matches subdomains. `home-assistant.io` covers integration docs (`www.home-assistant.io`) and the developer API reference (`developers.home-assistant.io`) that skills consult when verifying REST/WebSocket endpoints. `READ_FROM_ENV:HOMEASSISTANT_URL` resolves to the hostname of the operator's configured HA instance — covers custom remote domains (e.g. `ha.mydomain.com`) that are not under `nabu.casa`. Operators on a self-hosted local HA instance should accept `ASK_OPERATOR_FOR_HA_IP` and provide the LAN IP of their HA box. mDNS / `homeassistant.local` does not work through dnsmasq — use the IP directly.
