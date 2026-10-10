<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.5-green.svg" alt="Version 0.2.5" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# hermitd-fitness

Turn Claude Code into a 24/7 personal fitness assistant. **Strava-aware**, **Read-only**, **Plans + flags**, **Built on `hermitd`**.

<p align="center">
  <img src="../hermitd/assets/cover.png" alt="Always-on Claude Code Fitness Agent" width="720" />
</p>

Reads your Strava, spots load anomalies, drafts weekly plans, and flags recovery. Wires the community Strava [MCP Server](https://github.com/r-huijts/strava-mcp-server) and the [Strava REST API](https://developers.strava.com/docs/reference/) into the [`hermitd`](https://github.com/gtapps/hermitd) loop.

```
# Install
claude plugin install hermitd-fitness --marketplace gtapps/hermitd --scope local

# Setup wizard
/hermitd-fitness:hatch

# Go always-on
/hermitd:docker-setup
```

---

## What you get

**Knows your training.** Hatch wires the Strava MCP server, drops in routine prompt templates, and registers them with the core hermit. Your training history becomes the context it reasons from.

**Drive it from anywhere.** Ask about last week's load, request an activity deep-dive, or get tomorrow's session suggestion. Reach it from the Claude app or claude.ai/code on your phone (handy if you run several hermits), and optionally DM it on Discord or Telegram. `activity-deep-dive` produces a coaching artifact (zone breakdown, pace/HR efficiency, cardiac drift, recovery estimate) you can skim in seconds.

**It watches your training for you.** Daily checks for new activities and Strava connectivity; weekly load review on Sundays; Monday planning suggestions. Anomalies — skipped recovery, ramp-rate spikes, missing data — get flagged by push notification, or in your channel if you've paired one.

**Routines that match a training week:**

- `morning-brief` — daily 07:30 — readiness read + today's plan; checks Strava connectivity
- `evening-brief` — daily 21:30 — today's training recap + tomorrow's setup; syncs new activities, invites RPE
- `weekly-load-review` — Sunday 18:00 — week-over-week load summary with trend flag
- `monday-planning` — Monday 09:30 — weekly training structure suggestion
- `weekly-coaching-patterns` — Monday 09:05 — cardiac-drift trend; pre-wake gate skips when there is no upward trend

Need a different cadence or a new routine? Just ask — hermit sets it up.

**Tracks how it felt.** After each synced activity, reply with your RPE (1–10) in the channel — `capture-activity-rpe` binds it to the activity. Use `/hermitd-fitness:set-rpe` for manual or retroactive entries. Subjective load surfaces in `activity-deep-dive` output and weekly summaries.

**Everything is searchable.** Activity notes, weekly summaries, and load baselines land in your hermit's compiled knowledge and auto-memory — accessible across sessions and surfaceable on demand via `/hermit-health`.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.292+, a paid Claude plan (Pro, Max, Teams, or Enterprise), Node.js (for `npx` to launch the Strava MCP server), and a [Strava developer app](https://www.strava.com/settings/api) with four OAuth credentials — `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_ACCESS_TOKEN`, `STRAVA_REFRESH_TOKEN` — and scopes `read,activity:read_all,profile:read_all`. The default `read` scope alone is not enough; activity and stream reads will return 401. See the [Strava OAuth guide](https://developers.strava.com/docs/authentication/) for the full flow.

### 1. Install

```bash
cd /path/to/your/project   # any folder — empty is fine
claude plugin install hermitd-fitness --marketplace gtapps/hermitd --scope local
```

> Use `--scope local` (writes to the gitignored `.claude/settings.local.json`) to keep the hermit out of a shared repo's committed config. Use `--scope project` only when the folder is a fresh directory dedicated to the assistant.

### 2. Initialize

```
/hermitd-fitness:hatch
```

The wizard triggers `hermitd:hatch` if the core hermit isn't ready, prompts you to fill in `.env` with your four Strava credentials, writes `.mcp.json` with the Strava MCP server entry, drops the four routine prompt templates into `.hermit/compiled/`, injects the Fitness Workflow block into your `CLAUDE.md`, and registers the routines.

> **Just trying it?** After `hatch`, restart Claude Code (required to pick up the new `.mcp.json`), approve the `strava` MCP server, then run `hermitd start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/hermitd:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-On

```
/hermitd:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`). For LAN containment + DNS allowlisting + resource bounds, follow up with [`/hermitd:docker-security`](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/docker-security.md).

See [Always-On Setup](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update hermitd@hermitd --scope local
claude plugin update hermitd-fitness@hermitd --scope local
/hermitd:hermit-evolve
```

---

## Safety

- **Strava writes require approval:** `star-segment`, `connect-strava`, `disconnect-strava`.
- **Credentials stay local** — `.env` and `.mcp.json` are gitignored. The four Strava credentials in `.env` are written as literal values into `.mcp.json` (required for the MCP server's child process) and never committed.
- **No token leakage** — never logs, prints, or writes token values to session files, proposals, or memory.
- **`.env` stays off the shell** — there is no `Bash(*TOKEN*)` substring deny. `Bash(cat .env*)` is a seeded native deny, and credential values must not land in the transcript. Hatch reads `.env` via the `Read` tool, not shell commands.

---

## Configure it

Strava credentials live in the gitignored `.env` (read-only; scopes `read,activity:read_all,profile:read_all`):

| Key | Description |
|-----|-------------|
| `STRAVA_CLIENT_ID` | Strava OAuth app client ID |
| `STRAVA_CLIENT_SECRET` | Strava OAuth app secret |
| `STRAVA_ACCESS_TOKEN` | OAuth access token |
| `STRAVA_REFRESH_TOKEN` | OAuth refresh token |

Everything else — model, heartbeat, idle behavior, per-routine model — is core, tuned with `/hermit-settings`: see core's [Configure it](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/README.md#configure-it) and [Tips & tuning](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/README.md#tips--tuning).

---

## Architecture

```
hermitd-fitness (this plugin)
  ├── skills/             hatch, fitness-brief, activity-deep-dive, capture-activity-rpe, set-rpe
  ├── agents/             strava-data-cruncher (Haiku bulk aggregator)
  ├── state-templates/    CLAUDE-APPEND.md + gate scripts (installed by hatch)
  └── docs/               knowledge-schema.md

hermitd (core, required ≥ 1.3.3)
  └── Session lifecycle, routines, channels, memory, cost tracking
```

**MCP-only.** Fitness uses the Strava MCP server (registered as `strava` in `.mcp.json`, installed via `npx` on first use) for all data access. The `strava-data-cruncher` Haiku subagent caps at 30 API calls per invocation to stay under Strava's 100/15min and 1000/day rate limits.

Extension points: Garmin, Apple Health, Polar, and other fitness integrations are not included but can be added by registering additional MCP server entries in `.mcp.json`.

---

## Credits

- Built on [`hermitd`](https://github.com/gtapps/hermitd) — session discipline, routines, channels, memory, cost tracking
- Uses the community [Strava MCP Server](https://github.com/r-huijts/strava-mcp-server) and the official Strava [REST API](https://developers.strava.com/docs/reference/)

## License

[MIT](LICENSE)
