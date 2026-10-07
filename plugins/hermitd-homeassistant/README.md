<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.4.21-green.svg" alt="Version 0.4.21" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# hermitd-homeassistant

Turn Claude Code into a 24/7 personal AI for your Home Assistant. **HA-aware**, **Read-first**, **Safe-by-default**, **Built on `hermitd`**.

<p align="center">
  <img src="../hermitd/assets/cover.png" alt="Always-on Claude Code Home Assistant Agent" width="720" />
</p>

Understands your house, spots the patterns, drafts automations, catches things breaking while you sleep — and never flips a switch without your say-so. Wires the official Home Assistant [MCP Server](https://www.home-assistant.io/integrations/mcp_server/) and [REST API](https://www.home-assistant.io/integrations/api/) into the [`hermitd`](https://github.com/gtapps/hermitd) loop with a fail-closed safety hook in front of every actuation call.

```
# Install
claude plugin install hermitd-homeassistant --marketplace gtapps/hermitd --scope local

# Setup wizard
/hermitd-homeassistant:hatch

# Go always-on
/hermitd:docker-setup
```

---

## What you get

**Knows your house.** Hatch points the hermit at HA, then learns your entities, areas, automations, and patterns — your house becomes the context it reasons from. `daily-ha-context` keeps it fresh.

**Drive it from anywhere.** Ask what's on, draft an automation, or ask why the porch light fired at 3am. Reach it from the Claude app or claude.ai/code on your phone (handy if you run several hermits), and optionally DM it on Discord or Telegram. Replies are conversational; YAML drafts get isolated, simulated, and only applied after you approve.

**Builds and maintains — not just drafts.** Beyond automations, the hermit works the whole structural side of your setup so you rarely need the HA UI: dashboards, scripts, scenes, helpers, areas/floors/labels, entity metadata and Assist exposure, blueprints, energy preferences, core config, backups, and config-entry reloads. It also runs the dev/maintain loop — render a template, check config, tail the error log and logbook — to test and troubleshoot changes. Every structural write is gated by your safety mode; runtime device control stays with HA Assist.

**It watches the house for you.** Daily `ha-integration-health` and `ha-update-check` routines, silence detection (dead automations, sensors that stopped triggering, long-unavailable entities); weekly `ha-patterns` and `ha-safety-audit` routines, plus history-backed automation suggestions. Anomalies surface as proposals you can act on — never silent edits.

**Safety is the default.** `lock`, `alarm_control_panel`, and security-tagged `cover`/`button`/`switch` domains are blocked outright. Vague targets (an area or device with no resolvable entity) fail closed. Every block becomes a proposal — never a surprise.

**Routines that respect your day.** Morning and evening briefs (morning off until you confirm the house profile; evening confirms security before night), daily context refresh, weekly `ha-patterns` and `ha-safety-audit`, daily `ha-integration-health` and `ha-update-check`. Need a different cadence or a new routine? Just ask — hermit sets it up.

**Everything is searchable.** HA sessions, proposals, pattern findings, and cost tracking land in your hermit's compiled knowledge and auto-memory — surfaceable on demand via `/hermit-health`, greppable from the state tree.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.292+, a paid Claude plan (Pro, Max, Teams, or Enterprise), [Bun](https://bun.sh) 1.4+, and a running [Home Assistant](https://www.home-assistant.io/) instance with the official [MCP Server](https://www.home-assistant.io/integrations/mcp_server/) integration enabled and a Long-Lived Access Token (create one under `/profile/security` on your HA instance).

### 1. Install

```bash
cd /path/to/your/project   # any folder — empty is fine
claude plugin install hermitd-homeassistant --marketplace gtapps/hermitd --scope local
```

### 2. Initialize

```
/hermitd-homeassistant:hatch
```

The wizard triggers `hermitd:hatch` if the core hermit isn't ready, prompts for your `.env` (HA URL + Long-Lived Access Token), wires up the official Home Assistant MCP server, and registers the routines.

> **Just trying it?** After `hatch`, run `hermitd start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Ctrl+C exits cleanly. Run `/hermitd:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-On

```
/hermitd:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). For LAN containment + DNS allowlisting + resource bounds, follow up with [`/hermitd:docker-security`](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/docker-security.md).

See [Always-On Setup](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update hermitd@hermitd --scope local
claude plugin update hermitd-homeassistant@hermitd --scope local
/hermitd:hermit-evolve
```

---

## The Learning Loop

The hermit watches your house every day — integration drops, automation errors, safety drift, usage patterns you haven't automated yet. When something crosses the three-condition rule (repeated + meaningful + actionable), it writes a proposal:

```
/hermitd:proposal-list                   # see what it found
/hermitd:proposal-act accept PROP-003    # make it the next thing to work on
```

Accept one and the hermit picks it up during idle time. Reject, defer, dismiss — you're always in control.

---

## Safety

Every actuation call is pre-screened by a safety hook before it reaches Home Assistant.

- **Blocked outright** — `lock`, `alarm_control_panel`, security-tagged `cover` / `button` / `switch` domains
- **Fail closed** — area-only or device-only targets where no concrete entity ID can be resolved
- **Blocked ≠ silent** — every block becomes a proposal for human review

Policy overrides (allow-lists, extra sensitive domains/keywords) are configured through `.env`. See [SAFETY.md](SAFETY.md) for the full policy and override reference.

---

## Configure it

| Key | Default / options (default **bold**) |
|-----|--------------------------------------|
| `HOMEASSISTANT_URL` | `.env` — HA instance URL (required) |
| `HOMEASSISTANT_LOCAL_URL` | `.env` — optional LAN URL |
| `HOMEASSISTANT_REMOTE_URL` | `.env` — optional remote URL (e.g. Nabu Casa) |
| `HOMEASSISTANT_TOKEN` | `.env` — Long-Lived Access Token (required) |
| `HOMEASSISTANT_TIMEOUT_SECONDS` | `.env` — request timeout — **`15`** |
| `HOMEASSISTANT_RETRY_COUNT` | `.env` — request retries — **`2`** |
| `HOMEASSISTANT_USER_AGENT` | `.env` — optional custom User-Agent |
| `ha_safety_mode` | actuation gate (`config.json`) — **`strict`** (never actuate autonomously; blocked work becomes a proposal) / `ask` (prompt before any sensitive actuation) |
| `HA_SAFE_ENTITIES` | `.env` — per-entity allow-list, exact IDs (always allowed) |
| `HA_EXTRA_SENSITIVE_DOMAINS` | `.env` — block additional domains entirely (e.g. `cover`) |

Full policy in [SAFETY.md](SAFETY.md). Everything else — model, heartbeat, idle behavior, per-routine model — is core, tuned with `/hermit-settings`: see core's [Configure it](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/README.md#configure-it) and [Tips & tuning](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/README.md#tips--tuning).

---

## Architecture

```
hermitd-homeassistant (this plugin)
  ├── skills/             HA workflow skills
  ├── agents/             HA subagents (safety-reviewer, automation-builder, pattern-analyst)
  ├── hooks/              mcp-safety-gate.ts + hooks.json
  ├── bin/ha-agent-lab    CLI launcher (runs src/cli.ts with bun)
  ├── src/*.ts            TypeScript modules (REST client, policy, simulation, apply, history, silence)
  └── state-templates/    CLAUDE-APPEND.md (injected by hatch)

hermitd (core, required ≥ 1.3.3)
  └── Session lifecycle, proposals, reflect, memory, cost tracking
```

**MCP vs CLI.** MCP handles live ops — light/cover/fan control, live context queries. The CLI (`bin/ha-agent-lab`) handles bulk and structural work — context refresh, YAML simulation, policy checks, audits, apply, plus dashboards, scenes, helpers, areas/floors/labels, blueprints, backups, energy prefs, core config, config-entry reloads, and the render/check/log dev-maintain loop. See [CLAUDE.md](CLAUDE.md#cli-commands) for the full command list.

---

## Credits

- Built on [`hermitd`](https://github.com/gtapps/hermitd) — session discipline, proposals, memory, reflect pipeline
- Uses the official Home Assistant [API](https://www.home-assistant.io/integrations/api/) & [MCP Server](https://www.home-assistant.io/integrations/mcp_server/)

## License

[MIT](LICENSE)
