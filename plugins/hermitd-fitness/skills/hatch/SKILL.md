---
name: hatch
description: One-time fitness hermit setup. Configures Strava MCP access, wires domain skills as routines into config.json. Run once per project after /hermitd:hatch.
disable-model-invocation: true
---

# Hatch — hermitd-fitness

Idempotent setup wizard for the fitness plugin. Run **after** `/hermitd:hatch` has already been completed.

---

## Step 1 — Prerequisite check

Check whether `.hermit/config.json` exists.

If it does not:

Print this block and stop:

```markdown
## ▶ Next step — type this now

    /hermitd:hatch

I can't run setup wizards for you (they're operator-run by design).
After it finishes, come back and type `/hermitd-fitness:hatch`.
```

If it does exist, run `.hermit/bin/hermitd-run domain-hatch preflight hermitd-fitness` and parse the JSON verdict. Branch on `action`:

- **`bootstrap_core` / `upgrade_core_package` / `upgrade_core_applied`** → tell the operator to run the `next_steps` commands in order, then stop. An older core prints the dashed form of these with a `remedy` instead: relay `remedy` and stop.
- **`verify`** → say:

  > "hermitd-fitness {self_version} is already installed. Skip to Step 6 to re-verify the installation, or reply 'full' to re-run the full wizard."

  Use `AskUserQuestion`: "(verify / full)" — **verify** → skip to Step 6; **full** → continue from Step 2.
- **`full`** → continue from Step 2.
- **`error`**, or any `domain-hatch` command in this skill that prints `error` → tell the operator in plain words what its token means, then stop.

---

## Step 2 — .env verification

**IMPORTANT: Do NOT read `.env` yourself (no `Read`, `grep`, `cat` or `echo`): the values would land in the transcript, and `Bash(cat .env*)` is a seeded native deny. Use `fitness-lab.ts env-check` only.**

Tell the operator:

> "This plugin needs four Strava OAuth credentials in `.env`. If you haven't done this yet:
>
> 1. Create `.env` at the project root
> 2. Open `.env` and fill in all four values from your Strava developer app:
>    - `STRAVA_CLIENT_ID` — numeric app ID
>    - `STRAVA_CLIENT_SECRET` — app secret
>    - `STRAVA_ACCESS_TOKEN` — initial access token
>    - `STRAVA_REFRESH_TOKEN` — refresh token
>
> See https://developers.strava.com/docs/authentication/ to create a Strava app if you haven't.
> Reply 'done' when the file is filled in, or 'abort' to stop."

Use `AskUserQuestion`: "(done / abort)"

- **abort** → stop.
- **done** → continue.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/fitness-lab.ts env-check
```

It prints `OK` when every key is set, or `{"status":"missing_keys","missing":[...]}` with key names only, never values. A key counts as missing when it is absent, empty, or still `replace_me`. On `missing_keys`, report those names and loop back to the `AskUserQuestion` above. Do not proceed until it prints `OK`.

---

## Step 3 — MCP registration

**Step 3.0 — Detect an ambient Strava MCP server.** The operator may already run a Strava MCP server (user-scoped, or configured by another tool). Run `claude mcp list` (Bash) and scan for a server that talks to Strava — a name containing `strava`, or an entry whose command/args reference a Strava MCP package (e.g. `strava-mcp-server`). 

- **None found** → proceed to install the bundled server below (the default path).
- **One found** → ask with `AskUserQuestion` (header: "Strava MCP"): **Reuse the existing `<name>` server** (recommended — no duplicate) / **Install the bundled `@r-huijts/strava-mcp-server`**. 
  - **Reuse** → skip the `.mcp.json` write entirely. Record which server key the skills should target (if it is not `strava`, note in the final report that skill/settings matchers assume the key `strava`, so the operator should either rename their server to `strava` or accept that the fitness skills call `mcp__strava__*`). Continue to Step 4.
  - **Install bundled** → proceed below.

This is a local reuse-vs-install choice only — do not attempt to reconcile or edit the operator's other MCP configs.

Write the Strava MCP server entry into the project's `.mcp.json` with:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/fitness-lab.ts mcp-config
```

It reads `.env` itself, so the credentials never enter the conversation. Do not Read `.env` or `.mcp.json` to write this entry by hand. It prints JSON with no secret:
- `action: "added"` → entry written.
- `action: "replaced"` → an old entry with `${...}` placeholders was rewritten with literal values (Claude Code passes MCP `env` blocks literally; it does not expand shell variable syntax).
- `action: "updated"` → an existing literal entry had different credentials than `.env`; only the four credential values were refreshed.
- `action: "skipped"` → the existing `strava` entry already matches `.env`.
- `status: "missing_keys"` → relay `missing` (key names), go back to Step 2, then re-run.
- `{"error":"invalid_mcp_json"}` (exit 1) → `.mcp.json` is not a JSON object with an `mcpServers` object. Ask the operator to fix or remove it, then re-run.

The entry it writes has this shape:

```json
{
  "strava": {
    "command": "npx",
    "args": ["-y", "@r-huijts/strava-mcp-server"],
    "env": {
      "STRAVA_CLIENT_ID": "<literal from .env>",
      "STRAVA_CLIENT_SECRET": "<literal from .env>",
      "STRAVA_ACCESS_TOKEN": "<literal from .env>",
      "STRAVA_REFRESH_TOKEN": "<literal from .env>"
    }
  }
}
```

**Add `.mcp.json` and `.env` to `.gitignore`** if not already present. Read the project `.gitignore`, check for each entry; append any that are missing on new lines using Edit.

---

## Step 4: Install the weekly patterns gate

Install the shipped gate into the consumer project, always overwriting the previous gate:

```bash
install -m 755 "${CLAUDE_PLUGIN_ROOT}/state-templates/bin/fitness-weekly-patterns-gate" .hermit/bin/fitness-weekly-patterns-gate
```

This read-only gate calls `fitness-lab.ts weekly-patterns` through core's `hermitd-run sibling-run`. It translates the reported trend into `SKIP` or `WAKE`; the trend rule remains in `fitness-lab.ts`. Invalid output or a failed child returns non-zero, so the routine monitor records the gate error and wakes normally.

## Step 5 — Knowledge-schema extension

Read `.hermit/knowledge-schema.md`.

Check if `activity-streams:` is present in the file. This string only appears in the Raw Captures section, which is the last thing written — so its presence means both blocks were fully written on a prior run.

If **absent**, append the following block under `## Work Products` (create the section header if the base schema only has a template stub):

```
- weekly-plan: weekly training structure suggestion (7-day breakdown). Triggered by the `hermitd-fitness:monday-planning` routine (Mon 09:30). location: compiled/weekly-plan-<YYYY-MM-DD>.md
- weekly-summary: week-over-week training load review. Triggered by the `hermitd-fitness:weekly-load-review` routine (Sun 18:00). location: compiled/weekly-summary-<YYYY-MM-DD>.md
- recovery-assessment: recovery indicators from recent activity data. Triggered by operator request or an evening brief flag. location: compiled/recovery-assessment-<YYYY-MM-DD>.md
- fitness-snapshot: current fitness state snapshot. Triggered by operator request. location: compiled/fitness-snapshot-<YYYY-MM-DD>.md
- activity-note: per-activity coaching analysis. Triggered by activity-deep-dive skill. location: compiled/activity-<id>-<YYYY-MM-DD>.md
- domain-brainstorm: report from a domain plugin's `domain-brainstorm` skill, written only when the run created at least one proposal. location: compiled/domain-brainstorm-<YYYY-MM-DD-HHMM>.md
```

And under `## Raw Captures` (create if absent):

```
- activity-fetch: raw activity list from Strava. Feeds weekly-plan, weekly-summary, recovery-assessment. Retention: 3 days. location: raw/activity-fetch-<date>.json
- activity-streams: HR/pace/power time-series for a specific activity. Feeds recovery-assessment, activity-note, fitness-snapshot. Retention: 7 days. location: raw/activity-streams-<id>-<date>.json
```

Omit the `domain-brainstorm` bullet when `## Work Products` already declares it (another domain plugin's hatch may have added it).

If already present: skip (idempotent).

Use Edit to make the changes.

---

## Step 6 — Stamp and register in config.json

Re-read `.hermit/config.json` now — the wizard has been running since Step 1 and the on-disk file may have changed. Apply the merges below to that fresh copy.

### 6a — Stamp version

Set `_hermit_versions["hermitd-fitness"]` to `self_version` from Step 1's preflight.

If the key already exists: update the value. If absent: add it alongside the existing `_hermit_versions["hermitd"]` entry.

### 6b — Merge routines

In the `routines` array: A row matches a seeded entry when its full skill string (including arguments) or its `id` equals the seeded one's; preserve every field on a matching row. Add an entry below only when no row matches.

```json
{
  "id": "hermitd-fitness:morning-brief",
  "schedule": "30 7 * * *",
  "skill": "hermitd-fitness:fitness-brief --morning",
  "enabled": true
},
{
  "id": "hermitd-fitness:evening-brief",
  "schedule": "30 21 * * *",
  "skill": "hermitd-fitness:fitness-brief --evening",
  "enabled": true
},
{
  "id": "hermitd-fitness:weekly-load-review",
  "schedule": "0 18 * * 0",
  "skill": "hermitd-fitness:weekly-load-review",
  "enabled": true
},
{
  "id": "hermitd-fitness:monday-planning",
  "schedule": "30 9 * * 1",
  "skill": "hermitd-fitness:monday-planning",
  "enabled": true
}
```

### 6c: Merge the weekly patterns routine

Merge this entry into `config.routines` by the same matching rule. Create the array if absent. Append the entry only when no row matches and leave all other config fields unchanged. No prompt is needed for these read-only analyses.

```json
{"id": "hermitd-fitness:weekly-coaching-patterns", "schedule": "5 9 * * 1", "skill": "hermitd:reflect --check-id weekly-coaching-patterns --check hermitd-fitness:weekly-coaching-patterns", "enabled": true, "precheck": ".hermit/bin/fitness-weekly-patterns-gate", "precheck_timeout_s": 60}
```

The weekly routine checks for a trend before waking. Findings pass through reflection gates into the proposal pipeline.

Write the updated `config.json` using Write tool (full file replacement to ensure valid JSON).

## Native approval rules

If `needs_target_question` is true, ask with `AskUserQuestion` (header: "Visibility") — `target_default` at position 0 with `(recommended)`: **`.local` files** (gitignored — operator-personal) / **Committed files** (shared with teammates). Then record it:

```bash
.hermit/bin/hermitd-run domain-hatch ensure-target hermitd-fitness --target <choice>
```


Resolve the project settings target through `.hermit/bin/hermitd-run domain-hatch preflight hermitd-fitness`. Map `target` (or `target_default` when absent): `local` to `.claude/settings.local.json`, `committed` to `.claude/settings.json`.

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/native-permissions.ts <resolved-settings-file>`. Name any `deny_conflicts` it prints in the final report. On `error`, relay it and stop.

## Step 7 — Final report

Print a structured summary:

```
hermitd-fitness {version} setup complete.

Installation summary:
  ✓ Prerequisite: hermitd {base_version} confirmed
  ✓ .env: all four Strava credentials present
  ✓ .mcp.json: strava server entry written (or was already present)
  ✓ .gitignore: .mcp.json and .env covered
  ✓ knowledge-schema.md: fitness types added (or were already present)
  ✓ config.json: _hermit_versions stamped, {K}/4 routines added, `hermitd-fitness:weekly-coaching-patterns` routine registered with precheck

Manual steps remaining:
  - Restart Claude Code so the `strava` MCP server loads from .mcp.json
  - Approve the `strava` server when prompted on first use
  - Run /mcp to confirm `strava` is connected
  - Verify connectivity: call mcp__strava__check-strava-connection

Go always-on (recommended):
  - Docker:     /hermitd:docker-setup
      Builds the container and walks you through channel pairing in one go.
  - Bare tmux:  hermitd start
      For channels (Discord/Telegram) with tmux, run
      /hermitd:channel-setup first.

Prefer to test interactively first? After restarting, run:
  /hermitd:hermit-routines load
    — activates the fitness routines in the current Claude session.

The always-on runtime activates routines automatically — the interactive
steps are only for a test drive before handing over to the runtime.

Installed skills:
  /hermitd-fitness:fitness-brief             — daily morning/evening brief (--morning|--evening|--slot)
  /hermitd-fitness:activity-deep-dive        — per-activity coaching analysis
  /hermitd-fitness:weekly-coaching-patterns  — weekly cardiac-drift trend check (weekly routine)

Installed subagent:
  @hermitd-fitness:strava-data-cruncher — bulk Strava data aggregation (Haiku)

Security reminder: .env and .mcp.json contain real Strava credentials. Both are gitignored — verify before any git push.
```

---

## Docker network requirements

Read by `/hermitd:docker-security` when the operator enables LAN containment + DNS policy. Each entry is surfaced as a per-entry confirmation prompt; nothing here is auto-applied.

### Domains (DNS allowlist)

- strava.com

`server=/strava.com/...` matches both `www.strava.com` (web) and `api.strava.com` (API) via dnsmasq's subdomain-match semantics. The Strava MCP server (`@r-huijts/strava-mcp-server` via `npx`) also needs `npmjs.org`, but that's already in the wizard's seed allowlist for npm/plugin installs.

### LAN allowlist suggestions

(none — Strava is a cloud service)
