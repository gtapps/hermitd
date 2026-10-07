# Changelog

## [Unreleased]

### Fixed
- `ha-morning-brief` takes pending tasks only from the live task list, never from an earlier brief or the session's context.
- `ha-integration-health` and long-unavailable silence findings no longer count `unknown` entities (never-pressed buttons, `notify`, `update` before its first check) as unavailable; a sensor stuck at `unknown` is no longer reported as long-unavailable.
- Home Assistant 2026.9+ domain-prefixed MCP tool names: `homeassistant__GetLiveContext` and `llm__GetDateTime` are allowed as read-only again, and prefixed `Hass*` intent tools honor `ha_assist_control_enabled`.

## [0.4.20] - 2026-10-02

### Changed
- The plugin is named `hermitd-homeassistant` in the `hermitd` marketplace, with namespaced skills and core commands updated to match.

## [0.4.19] - 2026-09-29

### Changed
- Hatch's host next step uses `hermit start` and requires core 1.4.8 or newer.

## [0.4.18] - 2026-09-28

### Fixed

- Installed instructions use `ha-agent-lab` on the plugin PATH with existing approval checks.
- `ha validate-apply` updates scripts: the `id` is no longer sent in the script body, and alias- or filename-derived script ids follow Home Assistant's lowercase slug rules.

## [0.4.17] - 2026-09-25

### Removed

- Plugin-root `settings.json` permission list, which Claude Code never applied; native rules are installed into project settings.

## [0.4.16] - 2026-09-16

### Changed

- Core 1.4.0 is required for task records and resident startup.
- HA startup uses `resident-start`; skill artifacts and progress notes attach to open task records.

## [0.4.15] - 2026-09-12

### Changed

- The native-permissions installer accepts only a project settings path.
- Hatch no longer seeds `autoMode.environment`; Claude Code does not read it from project settings. Existing `autoMode` blocks in project settings are unread and left in place.

## [0.4.14] - 2026-09-10

### Changed

- CLI writes use native approval without confirmation flags or confirmation-only retry responses.
- Policy results use `decision: allow | ask | deny` consistently.
- `ha_safety_mode` defaults to `ask` when absent from valid configuration.

### Fixed

- Unsupported hook matcher metadata no longer produces session-start warnings.
- CLI approval recognizes leading assignments, `bun run`, and redirections while preserving target denials.

### Upgrade Instructions

Before using the updated write commands, set `DOMAIN_PLUGIN_ROOT` to this installed plugin's absolute directory and run the following from the project root. Prepare `NATIVE_APPROVAL_BLOCK` as a temporary Markdown file containing the updated `state-templates/CLAUDE-APPEND.md` block merged with any operator edits from the installed block (`target_file` in preflight). Preserve those edits and the marker pair; the refresh replaces only this marked block, leaving surrounding project instructions intact. The installer preserves operator settings and denies.

```bash
native_settings=$(.claude-code-hermit/bin/hermit-run domain-hatch preflight claude-code-homeassistant-hermit | bun -e 'const p = await Bun.stdin.json(); if (!p.ok || !["local", "committed"].includes(p.target)) throw new Error("Resolve the domain hatch target first"); console.log(p.target === "local" ? ".claude/settings.local.json" : ".claude/settings.json");') &&
bun "${DOMAIN_PLUGIN_ROOT:?Set the installed plugin directory}/scripts/native-permissions.ts" "$native_settings" &&
.claude-code-hermit/bin/hermit-run domain-hatch sync-block claude-code-homeassistant-hermit --rendered-stdin < "${NATIVE_APPROVAL_BLOCK:?Set the merged temporary block file}"
```

Remove obsolete confirmation flags from operator-maintained command examples. Direct CLI execution outside Claude Code has no confirmation-only checkpoint. Validation and policy denials remain. Policy-check output now uses `decision` with `allow`, `ask`, or `deny`; update operator-maintained consumers of the former `severity` field.

## [0.4.13] - 2026-09-07

### Fixed
- `ha-pattern-analyst` and `ha-safety-reviewer` only let a memory that records an operator decision suppress a finding or change a verdict: frontmatter `type` `feedback` or `project`, or the `feedback_`/`project_` filename prefix where auto-injected memory hides the frontmatter. A `reference` memory recording an observed fact no longer silences the finding it describes. The safety carve-out is unchanged: memory still cannot move `ha_safety_mode`.

### Changed
- Pattern analysis and safety audits run as weekly routines; integration and update checks run as daily routines. Core 1.3.3 is required.

### Upgrade Instructions

1. Complete core's periodic-check conversion first.
2. Re-read `.claude-code-hermit/config.json`. Append each of the following routines only when its id is absent from `config.routines`. Preserve every existing routine, including custom schedules, model pins, and disabled entries.
   ```json
   {"id": "ha-patterns", "schedule": "5 9 * * 1", "skill": "claude-code-hermit:reflect --check-id ha-patterns --check claude-code-homeassistant-hermit:ha-analyze-patterns", "run_during_waiting": true, "enabled": true}
   {"id": "ha-safety-audit", "schedule": "5 9 * * 1", "skill": "claude-code-hermit:reflect --check-id ha-safety-audit --check claude-code-homeassistant-hermit:ha-safety-audit", "run_during_waiting": true, "enabled": true}
   {"id": "ha-integration-health", "schedule": "5 9 * * *", "skill": "claude-code-hermit:reflect --check-id ha-integration-health --check claude-code-homeassistant-hermit:ha-integration-health", "run_during_waiting": true, "enabled": true}
   {"id": "ha-update-check", "schedule": "5 9 * * *", "skill": "claude-code-hermit:reflect --check-id ha-update-check --check claude-code-homeassistant-hermit:ha-update-check", "run_during_waiting": true, "enabled": true}
   ```
3. Save the config and run `/claude-code-hermit:hermit-routines load`.

## [0.4.12] - 2026-09-06

### Changed
- `ha-apply-change` merges the `ask`-mode policy confirmation into the single operator confirmation before applying, instead of prompting twice. An approval covering the same artifact and reload domain is reused within the task; changed content or targets require a new confirmation.

### Fixed
- A test now pins the ordering of `ha-apply-change`'s steps (policy check before approval, approval before the write) so a future edit can't silently reorder them.

## [0.4.11] - 2026-08-31

### Changed
- `hatch` is operator-invoked only through `disable-model-invocation`. If core is not initialized, it prints `/claude-code-hermit:hatch` for the operator to type instead of offering to run it.

## [0.4.10] - 2026-08-17

### Changed
- `ha-morning-brief` renders its `Cost:` section only when `reflect` flags a cost spike, and omits it otherwise. The spike line is no longer droppable under the 25-line cap.

## [0.4.9] - 2026-08-14

### Changed
- `ha-agent-lab` keeps one record per command in `src/cli.ts` — parser spec, `--help` block and handler together. The command list, the `ha --help` body and the dispatch all derive from that table, so a command can no longer be declared without a spec (previously a runtime crash rather than a type error). No command behavior changed and `--help` output is byte-identical, now pinned by a fixture test.

### Fixed
- `projectRoot()` walks past a worktree's projected `.claude-code-hermit/` (the `config.json` sentinel with no `state/`) to the main checkout, matching core and dev. Core now copies `config.json` into `claude --worktree` worktrees, which would otherwise have anchored HA snapshots, audits and staged YAML to the partial copy in a worktree session.

## [0.4.8] - 2026-07-30

### Fixed
- `ha-morning-brief` now recognizes the `dropped` entries core's `proposal micro brief-cycle` verdict can return (micro-proposals already resolved elsewhere) and excludes them from the brief instead of leaving the new field unhandled.

## [0.4.7] - 2026-07-26

### Added
- `ha updates --digest` emits tier-sorted, top-3-collapsed lines; both briefs consume it instead of rendering the list themselves. Default output is unchanged.

### Fixed
- `domain-brainstorm` no longer writes its own `brainstorm-emit` event — core's triage gate already records every verdict. Proposals now carry `tags: [capability-brainstorm]` instead of `[domain-brainstorm, ideation]`, so they count toward the brainstorm kill-criteria segment rather than `reflect`'s.
- `ha-boot` and `SAFETY.md` no longer point the operator at a `.env.example` that does not ship; replaced with a direct "create `.env`" instruction.
- `ha-morning-brief`'s micro-proposal lifecycle now runs in one `.claude-code-hermit/bin/hermit-run proposal micro .claude-code-hermit brief-cycle` call through core's writer (one atomic round-trip that re-nudges, expires, and records expiries), instead of two inline `bun -e` re-implementations of that writer — so a nudge, an expiry, or a crash mid-write can no longer corrupt the queue.

### Changed
- `hatch` reads the required core version from `.claude-plugin/hermit-meta.json` at runtime via `domain-hatch preflight`, instead of the hardcoded `1.0.16` floor its prose carried. That floor sat many minor versions below what the manifest declared, so the wizard proceeded against a core too old for it.
- Target resolution and CLAUDE-APPEND writing are delegated to core: `domain-hatch preflight claude-code-homeassistant-hermit` resolves the target, `ensure-target` records an operator override, `sync-block` writes the block. The skill no longer detects install scope from `claude plugin list --json` or stamps `hatch-options.json`.
- `hatch` no longer re-renders the CLAUDE-APPEND block when the stamped version changes; it appends when the marker is absent and skips otherwise. `hermit-evolve` owns version-driven block refresh, so the two writers no longer race on the same block.
- Requires core `>=1.2.34`. Core absorbed its proposal satellites into `proposal.ts` verbs, so the shared route this plugin calls through `bin/hermit-run` is now `proposal micro …` / `proposal metrics …`. `bin/hermit-run` resolves a script by bare filesystem probe, so pairing this version with an older core fails with a misleading "plugin may predate this command" error.
- `domain-brainstorm` reads core's proposal-metrics report via `.claude-code-hermit/bin/hermit-run` (a path relative to this plugin can't reach core's install), and a kill-criteria breach now escalates to the operator as a class-level signal instead of instructing the skill to self-retire (the shared segment can't attribute noise to one skill).

- The CLAUDE-APPEND block dropped §Environment (hatch owns `.env` setup and validates it via `boot status`), §Entry Flow, the channel-routing utterance examples, and the unified-vs-legacy routine narrative — per-install config state that drifts the moment an operator edits `config.json`. 9,565 B originally, 5,076 B after the first trim, now ~2,814 B.
- The actuation, structural-write, and safety-mode statements merged into one rule that states the real boundary: unresolvable or malformed targets hard-block in **both** modes, and `ask` prompts only for a concrete sensitive target. Uncertain-entities-default-sensitive and explicit approval before applying automations or changing safety policy are unchanged.

## [0.4.6] - 2026-07-21

### Fixed
- Dropped no-op `Write(<path>)` allow rules — Claude Code only matches file-permission checks against `Edit(path)` rules (Edit covers all file-editing tools, including Write), so the `Write(.claude-code-hermit/**)`, `Write(**/.claude-code-hermit/OPERATOR.md)`, and `Write(.env)` entries were dead and triggered a boot warning. Their `Edit(...)` twins still grant the same access.

## [0.4.5] - 2026-07-15

### Added
- Pending-updates section — surfaces Core/OS/Supervisor/add-on version bumps (HACS as a count) from `ha updates`; morning links the matching `[ha-update]` proposal and drops it from the generic Pending list.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No further action needed — the brief changes live in `ha-morning-brief`/`ha-evening-brief` SKILL.md, picked up from the plugin install path on the next session.

No config.json changes required.

## [0.4.4] - 2026-07-12

### Added
- `ha updates` + `ha-update-check` scheduled check — daily check surfaces pending Home Assistant updates (Core, OS, Supervisor, add-ons, HACS) from the `update.*` domain as `[ha-update]` proposals, tiered (Core/OS/Supervisor/add-ons individual, HACS aggregated), native fields only (no web fetch), honoring HA's own `skipped_version`.
- Opt-in one-tap update handling — new `ha_update_auto_apply` config flag (default off, prompted at hatch Step 7.56) plus `/claude-code-homeassistant-hermit:ha-apply-update` lets accepted add-on/HACS proposals auto-install (HA backs up first); Core/OS/Supervisor always wait for an explicit operator confirm regardless of the flag.
- `gateServiceCall` update-domain carve-out — `update.install` (and other `update.*` services) are now gated independently of `ha_safety_mode`: blocked outright with the flag off (closing a previously ungated actuation path — `update` was never in `SENSITIVE_DOMAINS`), require `--confirm` on every call with the flag on. Calls also referencing a genuinely sensitive entity are unaffected.

### Upgrade Instructions

Run `/claude-code-homeassistant-hermit:hatch` to register the `ha-update-check` scheduled check and be prompted for `ha_update_auto_apply` (Step 7.56). No action needed to keep the previous (advisory-only) behavior — the flag defaults to off.

## [0.4.3] - 2026-07-12

### Fixed
- Routine fires now notify the operator — delivery is keyed on routine invocation / `config.always_on` via the core Operator Notification protocol; previously channel delivery only fired when `session_state` was `waiting`, so routines firing on idle always-on hermits wrote the brief to `compiled/` but never notified (#581)

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No further action needed — the delivery fix lives in `ha-morning-brief`/`ha-evening-brief` SKILL.md, picked up from the plugin install path on the next session.

No config.json changes required.

## [0.4.2] - 2026-07-06

### Added
- Auto-mode environment seed — new Step 7.7 runs `scripts/automode-env.ts`, naming the operator's Home Assistant instance (read from `.env`) as a trusted `autoMode.environment` entry in `.claude/settings.local.json`, so Claude Code's auto-mode classifier stops treating the hermit's nightly unattended reads (briefs, audits, context refresh) as unrecognized outbound calls. Environment-only — no `autoMode.allow` exception is seeded.
### Fixed
- CLAUDE-APPEND CLI pointer — dropped the bare `docs/cli-reference.md` pointer (unresolvable from the operator's project cwd); `ha-agent-lab --help` is the resolvable catalog pointer, `src/cli.ts` the source of truth. The doc still ships under the plugin root.

## [0.4.1] - 2026-07-03

### Changed
- `/hermit-brain` → `/hermit-health` — the core `hermit-brain` skill merged into `hermit-health`; the docs now point at the surviving skill.
- `reflect-scheduled-checks` → `reflect --scheduled-checks` — the core scheduled-check runner merged into `reflect`; the HA scheduled-check skills and `CLAUDE.md` now name the surviving invocation (no behavior change — the `scheduled-checks` routine still consumes their stdout).
- CLAUDE-APPEND slimmed 9.6KB → ~5.1KB — the Skills table, Subagents table, and inline CLI-command catalog were removed; skills and subagents already self-advertise through their SKILL.md/agent descriptions, and the CLI catalog is documented in `docs/cli-reference.md` (core commands) and the plugin `CLAUDE.md` (full list), with `ha-agent-lab --help` / `src/cli.ts` as the source of truth. The block is re-paid on every session load and subagent dispatch, so this cuts recurring context cost.

### Upgrade Instructions
- No manual steps. The HA CLAUDE-APPEND block is synced automatically via `hermit-evolve` Step 7's sibling-upgrade flow when this version's gap is processed.

## [0.4.0] - 2026-07-02

### Added
- `ha list-dashboards` / `get-dashboard` / `apply-dashboard` / `create-dashboard` / `delete-dashboard` — read and gated-write Lovelace dashboards via WebSocket (`lovelace/dashboards/*`, `lovelace/config`, `lovelace/config/save`). Completes Phase 1.
- `ha render-template <file|->` / `ha check-config` — render a Jinja2 template (`POST /api/template`) and validate the HA config (`POST /api/config/core/check_config`). Read-only, not gated.
- `ha call-service <domain.service> [--data json]` — call any HA service (`POST /api/services/...`), gated per-entity/service by the new `gateServiceCall` (in `policy.ts`). Sensitive domains/entities follow strict/ask; non-sensitive calls proceed in both modes. Sensitive entities are detected even in service-specific fields (e.g. `scene.apply`'s `entities` map), and malformed/unresolvable targets fail closed.
- `ha set-core-config` — partial update of HA's core config (location, unit system, currency, timezone, country) via WebSocket (`config/core/update`, gated); only provided fields are sent.
- `ha error-log` / `ha logbook [--window-days N] [--entity <id>]` / `ha system-log` — raw error log (`GET /api/error_log`), logbook entries (`GET /api/logbook/<ts>`), and structured system log (WS `system_log/list`). All read-only, not gated. Completes Phase 3.
- `ha list-floors` / `create-floor` / `delete-floor` and `ha list-labels` / `create-label` / `delete-label` — WebSocket registry CRUD (`config/floor_registry/*`, `config/label_registry/*`), gated by `ha_safety_mode` like areas/helpers. First slice of Phase 4's organization primitives.
- `ha rename-area` / `set-area-icon` / `set-area-floor` / `set-area-labels` — a new generic `updateArea` (mirroring `updateEntity`/`updateDevice`) over `config/area_registry/update`, gated. `--labels` accepts multiple values (`--labels a b c`).
- `ha set-entity-icon` / `set-entity-hidden` / `set-entity-labels` / `set-entity-categories` / `set-entity-aliases` — extends the existing `updateEntity` (no new function, just new callers) over `config/entity_registry/update`'s remaining fields. `set-entity-hidden true|false` maps to `hidden_by` `"user"`/`null`, mirroring `set-entity-enabled`'s `disabled_by` convention; `set-entity-categories` takes a JSON scoped mapping (`--categories '{"automation":"config"}'`).
- `ha list-exposed-entities` / `expose-entity` — read and set HA's expose-to-Assist boundary (WS `homeassistant/expose_entity/list`, `homeassistant/expose_entity`), gated. Config, not control — directly supports the "runtime control defers to HA Assist" boundary from `SAFETY.md`. Completes Phase 4.
- `ha list-backups` / `create-backup` — list backups and generate a new one (WS `backup/info`, `backup/generate`), gated. `create-backup` exposes the full schema (`--agent-ids`, `--name`, `--password`, `--include-addons`, `--include-all-addons`, `--include-database`, `--include-folders`, `--include-homeassistant`). Completes Phase 5.
- `ha list-scenes` / `get-scene-config` / `delete-scene` — scene CRUD parity with the automation/script commands (`/api/states`, `/api/config/scene/config/{id}`), reusing the domain-generic `listDomain`/`readConfig`/`removeConfig`. First slice of Phase 6.
- `ha list-blueprints <domain>` / `import-blueprint <domain> <url>` — list blueprints and import+save one from a URL (WS `blueprint/list`, `blueprint/import` then `blueprint/save`), gated. Stops after import without saving if HA reports validation errors.
- `ha get-energy-prefs` / `set-energy-prefs <json>` — read/replace the energy dashboard configuration (WS `energy/get_prefs`, `energy/save_prefs`), gated. Takes the full nested preferences object as JSON.
- `ha reload-entry <entry_id>` / `disable-entry <entry_id> --disabled true|false` — config-entry actions (REST reload, WS `config_entries/disable`), gated. Completes Phase 6 (config-entry helpers are deferred — see Boundary in the roadmap doc).

### Changed
- `HomeAssistantClient.postText()` / `getText()` — new raw-response GET/POST variants; `/api/template` and `/api/error_log` return plain text, not JSON, which the existing `post()`/`get()`'s unconditional `JSON.parse` would reject as malformed.
- `extractEntityIds`/`hasUnresolvableTarget`/`isWellFormedEntityId` relocated to `policy.ts` — moved out of the MCP safety hook so `call-service` can reuse the same fail-closed entity-resolution logic. Hook behavior is unchanged (`tests/gate-corpus.test.ts`/`tests/gate-fuzz.test.ts` verify byte-identical output).
- `check-config` reuses `apply.ts`'s `isConfigCheckOk` instead of a narrower inline check.
- `time-utils.daysAgo()` — extracted shared "N days before now" arithmetic, reused by `logbook`'s window-start computation.

### Security
- `gateServiceCall` now deep-scans `--data`, so sensitive entities in service-specific fields such as `scene.apply`'s `entities` map cannot bypass classification.

### Fixed
- `set-core-config` rejects non-numeric lat/long instead of silently sending `null`.
- `apply-dashboard` / `render-template` report missing or malformed input files cleanly instead of throwing past the `HomeAssistantError`-only catch (and no longer open a WebSocket connection before validating input).

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the HA hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated CLI and skills.

No `config.json` changes required.

## [0.3.1] - 2026-06-29

### Changed
- Removed `maxTurns` cap — workload grows with accumulated entity inventory and historical snapshots; a fixed cap silently truncates analysis on mature deployments.

## [0.3.0] - 2026-06-26

### Added
- `ha trigger-automation <automation_id>` — fires an automation on demand via `automation.trigger`; provides the fire-to-test step in the build → simulate → apply → fire → observe → restore loop. No policy gate (triggering an automation you've already applied is not a sensitive actuation path).
- `ha_assist_control_enabled` config flag — opt-in that passes HA Assist intent tools (`HassTurnOn`, `HassLightSet`, `HassSetPosition`, `HassFanSetSpeed`, etc.) through the MCP safety gate; HA's own expose-to-Assist setting becomes the control boundary. Disabled by default (fail-closed). Set via hatch Step 7.55 or write `ha_assist_control_enabled: true` to `.claude-code-hermit/config.json`.
- Helper provisioning step — step 3 scans drafted YAML for missing `input_*/timer/counter/schedule` entities and creates them via `ha create-helper` before validation. Gate-respecting: strict → proposal, ask → operator prompt then `--confirm`. Runs `ha refresh-context --incremental` after creation so simulate sees the new helpers. (#471)
- `/ha-setup-house` skill — guided house build-out: create areas, assign entities and devices, provision helpers, scaffold starter automations. Thin orchestration of existing `ha-agent-lab` commands; all structural writes gated by `ha_safety_mode`.
- `ha automation-diff` — change memory across sessions: reports automations added/removed/edited/enabled/disabled since the last snapshot, including UI edits that bypass the plugin. Read-only; complements `ha-safety-audit` (policy drift vs. change drift). (#472)
- `ha snapshot-states` / `ha restore-states` — capture an entity set's state to a named artifact and restore it via `scene.apply`. Restore gated by `ha_safety_mode`: sensitive entities block under strict and require `--confirm` under ask. (#472)
- `ha-automation-diff`, `ha-snapshot-restore` skills — thin skill wrappers over the new CLI subcommands.
- `scene` config domain — `validate-apply --reload scene`, plus scene create/remove via `/api/config/scene/config/{id}` + `scene.reload`. (#466)
- WebSocket client (`src/ha-ws.ts`) — single-shot `wss://<host>/api/websocket` client; auth handshake + id-correlated commands. Reaches HA surfaces REST cannot. (#466)
- Helpers, areas, registries — `list/create/delete-helper` (8 helper types), `list/create/delete-area`, `list-entities --registry`, `rename-entity`, `set-entity-area`, `set-entity-enabled`, `list-devices`, `set-device-area`, `rename-device`. (#466)
- WS mutations gated by `ha_safety_mode` — reads always allowed; under `strict` writes surface as proposal, under `ask` require `--confirm`. Each mutation writes an `audit-ha-ws-*` report. (#466)

### Changed
- `Hass*` intent tools conditionally allowed — when `ha_assist_control_enabled: true` is set, `Hass*` tools are passed through; HA's expose-to-Assist gate is the control boundary. Default (opt-in absent) is unchanged: hard-block.
- CLI REST control surface removed — `ha actuate`, `ha actuate-area`, `ha resolve-entity`, `ha-command-router`, `src/actuate.ts`, and `src/resolve.ts` deleted; these were unreleased and never reached operators via `/plugin update`. Runtime device control now routes through HA Assist intent tools.
- Confirmation-token bridge removed — `consumeConfirmationToken`, `canonicalJson`, and `TOKEN_TTL_MS` deleted; the ask-tier path now emits `permissionDecision:"ask"` JSON directly.
- Keyword heuristic removed — `CONDITIONALLY_SENSITIVE_DOMAINS`, `SENSITIVE_KEYWORDS`, and `HA_EXTRA_SENSITIVE_KEYWORDS` removed; `classifyEntity` now uses domain-only matching. Cover/button/switch entities are no longer flagged by keyword.
- Domain auto-resume — writes a state marker before delegating to core; core terminus invokes this skill via the Skill tool automatically. Removes the manual re-run. Requires `claude-code-hermit` ≥1.2.12.

### Fixed
- Cover script-derived MCP tools — widened the PreToolUse matcher from `mcp__homeassistant__Hass.*` to `mcp__homeassistant__.*` so exposed HA scripts (which surface as MCP tools with no `Hass` prefix) reach the gate instead of actuating ungated (#469). Read-only `GetLiveContext`/`GetDateTime` are allowlisted in-gate; bare-named script tools with no classifiable target block under `strict` and prompt under `ask`.

### Security
- The MCP safety gate now covers the full `mcp__homeassistant__.*` namespace, preventing script-derived actuation tools such as `armar_alarme` from bypassing it. Read-only tools are explicitly allow-listed; other non-entity tools fail closed. Intent tools such as `HassTurnOn` fail closed because they cannot carry `entity_id`. (G4)

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Restore keyword-sensitive entity blocking if you relied on it.** Check whether you set `HA_EXTRA_SENSITIVE_KEYWORDS` in `.claude-code-hermit/.env`. If so, identify the domains those keywords targeted (e.g. `cover`, `switch`, `button`) and add them to `HA_EXTRA_SENSITIVE_DOMAINS` in `.env` instead (`HA_EXTRA_SENSITIVE_DOMAINS=cover,switch`). Remove the now-inert `HA_EXTRA_SENSITIVE_KEYWORDS` line.

**Note:** `ha_assist_control_enabled` defaults to `false`; HA Assist intent tools remain blocked unless you explicitly opt in via hatch Step 7.55 or by writing `ha_assist_control_enabled: true` to `.claude-code-hermit/config.json`.

No other `config.json` changes required.

## [0.2.2] - 2026-06-23

### Fixed

- Domain resume after core hatch — Step 1 now prints the re-run instruction before invoking core as the terminal action, so the operator sees it. Removes the "then continue" assumption that silently dropped Step 2.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the HA hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated skill.

No `config.json` changes required.

## [0.2.1] - 2026-06-13

### Fixed

- Operator-defined sensitivity restored under drifted cwd — `projectRoot()` added to `src/config.ts` resolves the project root via `CLAUDE_PROJECT_DIR`+`existsSync` → cwd walk-up → fail-open, so `HA_EXTRA_SENSITIVE_*` overrides in `.env` are found even when hook cwd has drifted inside `.claude-code-hermit/`. Before this fix the gate failed open for those operator-configured domains. Fixes #384.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin** — run `claude plugin update claude-code-homeassistant-hermit` to get the fixed hook.

No `config.json` changes required.

## [0.2.0] - 2026-06-12

### Fixed

- CRITICAL — mcp-safety-gate was fail-open on all standard installs — the Python hook's import never resolved without `pip install -e` (PYTHONPATH was never set by hooks.json), so the gate crashed with exit 1 on every call; Claude Code treats non-2 exits as non-blocking, so lock/alarm MCP calls were ALLOWED for the hook's entire shipped life. The TypeScript port fixes this and additionally fails closed on non-object JSON payloads.
- Three more bypass holes closed — mixed safe/selector calls now blocked (selectors fan out server-side); sensitive-domain matching is case-insensitive; malformed empty-domain ids rejected. All pinned in the 80-case golden corpus.
- Write-path error handling — defensive body reads so 403/400 handling survives mid-stream failures; verify-GET errors reported as unverified rather than rethrowing after POST landed.

### Changed

- Full TypeScript port; plugin is Python-free (bun migration, core #18) — `src/ha_agent_lab/` Python package, `pyproject.toml`, `.venv`/pip hatch wizard, and both Python hooks deleted; `bin/ha-agent-lab` execs `bun src/cli.ts`, both gates run as `.ts` on bun. CLI argv, stdout shapes, and exit codes verified byte-identical to CPython via an 80-case golden corpus. 478 bun tests replace the pytest suite.
- Bumped to >=1.2.0 — tracks core 1.2.0 release.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core version** — confirm installed `claude-code-hermit` is >=1.2.0. If not, run `claude plugin update claude-code-hermit` first.
2. **Delete the Python venv** — remove `.venv/` from the HA hermit project directory if it exists; Python is no longer required.

No `config.json` changes required.

## [0.1.9] - 2026-06-04

### Changed

- Core requirement raised to >=1.1.9 — tracks core 1.1.9 release.

### Fixed

- Refresh stale/missing snapshot before analysis — the daily check used to skip and exit 0 when `snapshot-ha-normalized-latest.json` was stale or missing, so in always-on deployments (where `daily-ha-context` doesn't run during waiting) it never produced output and `reflect-scheduled-checks` filed a backwards proposal to lengthen the interval. It now self-heals by running `refresh-context` first; if HA is unreachable it skips with a distinct `refresh failed` message so the backoff counter isn't tripped.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`.

1. **Ensure core is at least 1.1.9.** Run `/plugin update claude-code-hermit` if not already on 1.1.9 or later.

No `config.json` changes required.

## [0.1.8] - 2026-06-01

### Added

- New operator-invoked skill — reads entity inventory, automation/script listings, and operator intent to surface at most 2 capability-gap proposals (`[automation-gap]` / `[coverage-asymmetry]` / `[unbuilt-intent]`), each gated by `proposal-triage`. Health/reliability findings act as suppression filters only, never idea sources. Never runs autonomously.

### Fixed

- Knowledge-schema.md now seeded with HA artifact types — weekly-review Knowledge Health no longer flags HA `.md` artifacts as `undeclared-type`. Covers `brief`, `context`, `presence-report` (Work Products) and `audit`, `simulation`, `apply`, `remove`, `analysis` (Raw Captures).
- Foundational pinning spec — `foundational: true` frontmatter was never detected by `startup-context.js` (which checks `tags`); updated spec to `tags: [..., foundational]` with `injection_stub` for large-profile injection.
- Install scope — `--scope project` corrected to `--scope local` in install and upgrade commands.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following step automatically (via Step 7's sibling upgrade flow).

1. **Extend knowledge-schema.md with HA types.** Read `.claude-code-hermit/knowledge-schema.md`. Check if either `- analysis:` or `- **analysis**:` is present — if so, skip (already up to date). If absent, append the following under `## Work Products`:

   ```
   - brief: morning/evening house brief. location: compiled/brief-<morning|evening>-<date>.md
   - context: foundational house/system profile. location: compiled/context-house-profile-<date>.md
   - presence-report: presence history and tracker diagnostics. location: compiled/presence-report-<date>.md
   ```

   And under `## Raw Captures`:

   ```
   - audit: HA operational audit (safety, integration-health, context-refresh). location: raw/audit-ha-<type>-<date>.md
   - simulation: HA automation simulation result. location: raw/audit-ha-simulation-<slug>-<date>.md
   - apply: HA automation apply result. location: raw/audit-ha-apply-<slug>-<date>.md
   - remove: HA automation/script delete audit. location: raw/audit-ha-remove-<slug>-<date>.md
   - analysis: HA pattern analysis. location: raw/patterns-<date>.md
   ```

   Use Edit to append.

2. **Sync the CLAUDE-APPEND block** — re-writes the HA section with the updated skills table including `domain-brainstorm`.

No `config.json` changes required.

**Note:** Existing house profiles written with `foundational: true` will not be auto-pinned until re-generated via `/claude-code-homeassistant-hermit:ha-refresh-context`.

---

## [0.1.7] - 2026-05-31

### Added

- New on-demand skill — presence history, tracker-health, arrival/departure transitions, and activity patterns for `person.*` / `device_tracker.*` entities. Gives operators a direct diagnostic path when presence-dependent automations misbehave.

### Changed

- Glob expansion — tokens containing `*` are now expanded against `entity_index` via `fnmatch`; exact IDs still pass through. Fixes the documented `--entities <glob> …` contract, which previously passed patterns verbatim to HA's REST API and returned empty data.
- Fetch-history `--include-transitions` — new flag; each entity aggregate in the snapshot includes a `transitions` list of ordered `{ts, state}` dicts with consecutive duplicates collapsed. Default off; existing callers unaffected.
- Browse and explain active automations — read-only skill with three modes: list all automations grouped by inferred topic (Mode 1), explain a keyword-filtered automation's YAML in plain language (Mode 2), sort by last-fired using snapshot data (Mode 3). Dead/stale detection reuses `silence_summary` from the context snapshot.
- New skill and routine — end-of-day security check (locks, alarm, open covers), device status (robovac, lights), and energy snapshot at 22:30; subsumes core `evening` routine when both plugins are installed.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Sync the CLAUDE-APPEND block** — re-writes the HA section in your target CLAUDE file with the updated skills table and CLI reference.

No `config.json` changes required.

## [0.1.6] - 2026-05-21

### Fixed

- Duplicate HA block after core 1.1.1 target migration — block stranded in old file; Upgrade Instructions run a one-shot migration via `hermit-evolve` Step 7 to remove it.

### Changed

- Step 7 is now target-aware — writes CLAUDE-APPEND block to `CLAUDE.local.md` or `CLAUDE.md` based on `hatch-options.json`; stamps canonical 5-field schema; three-branch marker logic (absent/match/stale).
- Upgrade Instructions Step 3 is fully unattended — dropped hand-edit detection; stamped-version source pinned to `config.json`; absent-stamp case folded into stale branch. Tests added via `tests/test_hatch_skill.py`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following steps automatically (via Step 7's sibling upgrade flow, which runs every plugin's `### Upgrade Instructions` before its CLAUDE-APPEND sync). The migration is unattended — no operator prompts. `hermit-evolve` Step 7 re-syncs the canonical block to `hatch_target` afterwards.

1. **Resolve `hatch_target`.** Use the same fallback chain `hermit-evolve` Step 2a uses, substituting the HA marker: read `.claude-code-hermit/state/hatch-options.json` and use the `"target"` field; else check `CLAUDE.local.md` for `<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->` → `hatch_target = "local"`; else check `CLAUDE.md` for the same marker → `hatch_target = "committed"`; else stop — the HA block is in neither file, nothing to migrate.

2. **Identify the non-target file.** `non_target = (hatch_target == "local") ? "CLAUDE.md" : "CLAUDE.local.md"`.

3. **If the marker is present in `non_target`, silently strip the marked block** (everything from the opening `<!-- claude-code-homeassistant-hermit: Home Assistant Workflow -->` through the matching closing `<!-- /claude-code-homeassistant-hermit: Home Assistant Workflow -->`, inclusive). Per `/hatch`'s single-source-of-truth contract, the CLAUDE-APPEND template is authoritative and operator overrides belong outside the marked block, so no hand-edit preservation is needed. Step 7's sync re-appends the canonical block to `hatch_target` afterwards.

4. **If the marker is only in `hatch_target`:** no-op. Steady state — Step 7's normal sync handles routine version-bump replacement.

No `config.json` changes required.

## [0.1.5] - 2026-05-21

### Changed

- Bump core requirement to `>=1.1.1` / `^1.1.1` — was `>=1.0.40`; aligns with core v1.1.1 release.

### Fixed

- ha fetch-history: fix Cloudflare HTTP 520 on large entity sets (gh #107) — chunks entity IDs at 50 to keep `filter_entity_id` short enough for Nabu Casa proxy; dedupes IDs before chunking.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update core** — run `/plugin update` and confirm `claude-code-hermit` is at v1.1.1 or later before this plugin's features are used.

No `config.json` changes required.

## [0.1.4] - 2026-05-16

### Added

- New CLI commands — fetch a single automation or script config from HA REST and print as JSON; exits 1 with structured error on 400/403.

### Changed

- Subsumes core `brief --morning` — eliminates duplicate-notification UX issue (#78); adds micro-proposals lifecycle and `Awaiting decision:` section; routine id fixed (`morning` → `morning-brief`).
- Morning-brief routine offers unified mode — fresh installs choose unified (08:30, disables core `morning`) or legacy (09:00, disabled); re-hatch detects old schedule and offers upgrade.
- Skill output translated to English — section headers and examples changed from Portuguese; runtime language still adapts to operator locale.
- Bump core requirement to `>=1.0.40` / `^1.0.40` — was `>=1.0.38`; aligns with core v1.0.40 release.

### Fixed

- Backfill previously shipped CLI commands — `list-automations`, `list-scripts`, `delete-*`, `integration-health`, `fetch-history`, `probe`, and the two new `get-*-config` commands were missing from the hatch-injected template.

### Upgrade Instructions

1. In `.claude-code-hermit/config.json`, locate `routines[id=morning-brief]`. If `enabled: true` and `schedule: "0 9 * * *"`: rewrite to `schedule: "30 8 * * *"` and `run_during_waiting: true`.
2. In the same array, locate `routines[id=morning]` (core). If both it and the updated `morning-brief` are enabled: set `morning.enabled = false`.
3. Report the changes to the operator; do not prompt — these are deterministic.

No `config.json` schema changes beyond the routine values above.

## [0.1.3] - 2026-05-14

### Added

- New CLI command and `integration_health.py` module — promotes skill from arithmetic pass to Python-backed command; writes `state/integration-health-degraded-domains.json` for `silence.py` cross-reference; thresholds centralized in `compute_degraded_domains()`.
- Silence_summary block in normalized snapshot — new `silence.py` module adds four finding categories (`dead_automations`, `silent_event_sensors`, `inactive_candidates_by_domain`, `long_unavailable`) to every `refresh-context` run; suppresses domains already flagged by integration-health.
- Surfaces silence findings — step 4 maps `silence_summary` categories to stdout buckets; `ha-pattern-analyst` Data Sources and output schema updated; `docs/knowledge-schema.md` updated.
- New REST client method — fetches `/api/history/period`; rejects empty entity_ids; maps by `entity_id` for reorder resilience; absent entities omitted from result dict.
- New CLI command and `history.py` aggregator — produces per-entity `event_count`, `hour_histogram`, `state_durations`; synthesizes zero-count rows for absent entities; writes `raw/snapshot-ha-history-{N}d-<date>.json` and `latest` alias.
- History wiring — analyze-patterns fetches 7d history as step 3; morning-brief fetches 1d and renders an overnight section; fetch failures log silently.

### Changed

- Extract shared `parse_iso` / `days_since` helpers — deduplicates the private helpers from `silence.py` and `history.py` into a shared module.
- Gate `never_fired` on `last_changed` age — avoids false positive on freshly-added automations; only fires once `last_changed` is ≥30d old.
- Explicit None-aware sort key — replaces falsy-chain fallback with `is None` checks to prevent silent wrong-key fallthrough.
- Document refresh fallback in `--help` — triggers `refresh-context` when no normalized snapshot exists; drops lazy import in favor of top-level `cli.py` import.

### Removed

- `stuck_for_days` field from `entity_aggregates` rows — the field was always `None` for both synthesized and returned entries and had no consumer. Removed from the schema to avoid downstream code relying on a value that never materialized.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Run `ha refresh-context`** — regenerates the normalized snapshot with the new `silence_summary` block. Required for `ha-analyze-patterns` and `ha-integration-health` to read silence data.
2. **Run `ha integration-health`** — seeds the `integration-health-degraded-domains.json` state file consumed by `silence.py`. Required before the first `ha-analyze-patterns` run that cross-references degraded domains.

No `config.json` changes required.

## [0.1.2] - 2026-05-12

### Fixed

- ASK-severity reasons no longer block apply — regression from v0.1.1 `ask` tier; adds `policy_blocked` field (True only for BLOCK); threads `root` into `evaluate_references`. Remove `alarm_control_panel.*` from `HA_SAFE_ENTITIES` if added as workaround.
- Honor project `ha_safety_mode` — `evaluate_yaml_policy` was missing `root`, silently falling back to `Path.cwd()` and defaulting to `strict` from subdirectories.

### Changed

- Converted `mcp-safety-gate` and `curl-host-gate` to exec form — aligns with core's exec-form sweep; fixes path-with-spaces fragility on installs whose plugin dir contains a space.
- Bump core requirement to `>=1.0.38` / `^1.0.38` — was `>=1.0.37`; aligns with core v1.0.38 release.

### Upgrade Instructions

1. **Update Claude Code to 2.1.139 or newer** — the exec-form hook syntax (`args: []`) was introduced in this version; hooks will fail to register on older clients.
2. **Run `/claude-code-hermit:hermit-evolve`** — pulls the plugin update and applies the new hook configuration.

No `config.json` changes required.

## [0.1.1] - 2026-05-11

### Added

- New CLI command — mirrors `audit-automations` for `script.*`; writes artifacts to `raw/audit-ha-script-safety-*`; `ha-safety-audit` skill updated to concatenate both.
- Acknowledgement scaffold — `_load_acknowledged` reads ids from `compiled/acknowledged-violations.md` frontmatter; matched violations route to `acknowledged` bucket instead of `violations`; `hatch` copies the template.
- State-templates/compiled/acknowledged-violations.md — new per-project suppression list template copied by `hatch`.
- Two-tier dial for sensitive-domain actuation — `strict` (default): always block via proposal; `ask`: prompt operator before actuation (both YAML apply and MCP); unknown values fall back to `strict`. Set via hatch §7.5 or `config.json`.
- policy.py: Severity enum (`block`/`ask`/`allow`) — replaces `bool` return from `classify_entity()`; `is_sensitive_entity()` kept as backward-compatible shim; `PolicyDecision` gains `severity` field.
- Add `severity` field to JSON output — callers can distinguish `block`, `ask`, and `allow` without re-implementing policy logic.

### Changed

- Migrate MEMORY.md references to platform auto memory — house profile, patterns, and suppression signals now live in `~/.claude/projects/<key>/memory/`; agent body instructions updated to match existing `memory: project` frontmatter.
- Move from auto memory to OPERATOR.md — locale is operator config, not Claude-derived knowledge; `boot status` reports language again; `boot store --language` writes to `OPERATOR.md` `## HA hermit` section.
- Bump core requirement to `>=1.0.37` / `^1.0.37` — was `>=1.0.32`; aligns with core v1.0.37 release.

### Design notes

- The dial is deliberately two-tier. A third `permissive` level (no block, no prompt) was considered and rejected — sensitive-domain actuation has no software undo, and a set-and-forget "owner takes the risk" mode is a footgun across long-running sessions. Both surviving tiers route through explicit operator approval.
- The hook switched from a leaky `exit 0 + stderr warning` convention to harness-enforced `permissionDecision: "ask"` so YAML apply and direct MCP calls have the same enforcement model.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. After updating the plugin:

1. If `ha_safety_mode` is absent from `.claude-code-hermit/config.json`, merge it in with the default value: `"ha_safety_mode": "strict"`. No behaviour change.
2. Optional: re-run `/claude-code-homeassistant-hermit:hatch` to step through the new §7.5 question interactively.

## [0.1.0] - 2026-05-07

### Changed

- Add Memory Cross-Check — consults auto-memory before verdict; returns `covered-by-memory` approval if memory records an operator decision; sensitive-domain blocks immune to memory override.
- Add Memory Cross-Reference — covered candidates move to `suppressed[]` array with `{code, reason, quoted_line, memory_ref}`; mirrors `covered-by-memory` code from core v1.0.32.
- Bump core requirement to `>=1.0.32` / `^1.0.32` — `covered-by-memory` code introduced in core v1.0.32.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin** — install `claude-code-homeassistant-hermit` v0.1.0 to activate the memory cross-reference in both subagents.

No `config.json` changes required.

## [0.0.9] - 2026-05-05

### Added

- Push config to HA via REST before reload — fixes silent failure where reload succeeded but automation was never pushed; derives `id` from alias/filename if absent.
- New CLI commands — remove automation or script via `DELETE /api/config/{domain}/config/{id}`; output includes `ok`, `message`, report path.
- New CLI commands — enumerate live automations/scripts with `deletable` flag; sorted by entity_id; quick lookup before delete.
- New skill — operator workflow for discovering, confirming, and deleting an automation/script config.
- Surface HA error messages verbatim — extracts `{"message":"..."}` from all HA error responses into apply/remove reports.

### Changed

- New output fields — `config_id`, `creation_attempted`, `creation_ok` distinguish a pushed-and-verified config from a reload-only YAML-mode fallback.
- Extended with `config_id`, `domain`, `creation_attempted`, `creation_ok`.
- Bump core requirement to `>=1.0.30` / `^1.0.30` — was `>=1.0.29`.

### Fixed

- No longer silently succeeds when config was never pushed — reports `creation_ok: false` in YAML-mode fallback instead of returning success after reload-only.
- Remove erroneous `validate-apply` post-delete advice — step 5 now points to HA Developer Tools → Services.
- Require `id:` as first field in generated YAML — without it, `validate-apply` derives a fragile alias-based ID that breaks on rename.
- Consolidate `_make_config` into shared `make_mock_config` fixture — used by `test_cli_probe.py` and `test_cli_delete.py`; test renamed to `test_delete_automation_not_found_exits_nonzero`.
- Run `can_reload_domain` check before REST POST — prevents pushing config that would then return `reload-blocked`.
- Rename `alias` → `friendly_name` — matches HA's `attributes.friendly_name`; results sorted by `entity_id`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skill files** — replace `skills/ha-apply-change/SKILL.md`, `skills/ha-build-automation/SKILL.md`, and `skills/ha-delete-config/SKILL.md` from this release.
2. **Add `ha-delete-config` to the injected skills table** — in the operator project's `CLAUDE.md`, find the `### Skills` table under `## Home Assistant Workflow` and append: `| /claude-code-homeassistant-hermit:ha-delete-config | Discover and delete an automation/script config from HA |`

No `config.json` changes required.

## [0.0.8] - 2026-05-04

### Added

- Add `READ_FROM_ENV:HOMEASSISTANT_URL` to docker network requirements — allows `/docker-security` step 3a to resolve custom HA hostnames dynamically; requires core `>=1.0.29`.

### Changed

- Bump core requirement to `>=1.0.29` / `^1.0.29` — was `>=1.0.26`; required by `READ_FROM_ENV:HOMEASSISTANT_URL` allowlist entry (resolver in core 1.0.29's `/docker-security`).

### Fixed

- Read token via Read tool instead of Python subprocess — `python -c "from dotenv…"` was blocked by the `TOKEN` deny-pattern hook; Read tool is hook-safe.
- Remove non-existent `.env.example` copy step — no such file ships with the plugin; replaced with direct "create `.env`" instruction.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the `hatch` skill content** — replace `plugins/claude-code-homeassistant-hermit/skills/hatch/SKILL.md` with the new file from this release.

**Note:** The `READ_FROM_ENV:HOMEASSISTANT_URL` entry only takes effect when the operator runs `/claude-code-hermit:docker-security` and the fleet scan reads this plugin's `## Docker network requirements` section. Until then, the change is inert.

No `config.json` changes required.

## [0.0.7] - 2026-05-03

### Added

- Add Docker network requirements section — declares `nabu.casa` and `ASK_OPERATOR_FOR_HA_IP` for `/docker-security` step 3a fleet scan; operators are prompted per-entry.

### Changed

- Bump core requirement to `>=1.0.26` / `^1.0.26` — was `>=1.0.21`; required by `## Docker network requirements` section (parsed by core 1.0.26's `/docker-security`).

### Removed

- Scheduled check retired end-to-end — `/api/error_log` unreliable on current HA installs (404 or unparseable plain-text); `/api/logbook` rejected as replacement (state changes, not errors). Removed audit function, CLI subcommand, skill, hatch registration, and docs.
- ha automation-errors CLI subcommand (`./bin/ha-agent-lab ha automation-errors [--min-hits N]`).
- ha-automation-error-review skill (`/claude-code-homeassistant-hermit:ha-automation-error-review`).

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. It will execute the steps below.

1. **Detect leftover references.** Check each location independently:
   - `.claude-code-hermit/config.json` — is there an entry whose `id == "ha-automation-errors"` in `scheduled_checks`?
   - `.claude-code-hermit/state/reflection-state.json` — does `scheduled_checks["ha-automation-errors"]` exist?

   If both are absent, print `ha-automation-errors not present in config or runtime state — nothing to retire.` and do not execute steps 2 or 3.

2. **Ask the operator using `AskUserQuestion`:**
   - Question: `"The 'ha-automation-errors' daily check has been retired — its skill and CLI are gone in this release. Clean up any leftover references from config and runtime state?"`
   - Header: `"Retire check"`
   - Options:
     1. Label: `"Remove (Recommended)"` — Description: `"Drop the entry from scheduled_checks and prune the matching runtime-state key. Cleanest end state. A replacement may be added in a future release."`
     2. Label: `"Skip — handle manually"` — Description: `"Do nothing. The entry will point at a missing skill; the next scheduled-checks pass will log a 'skill not found' warning until you remove it."`
   - `multiSelect`: `false`
   - (AskUserQuestion also auto-injects an `Other` option for free-text input.)

3. **If the operator picked `Remove`, apply the cleanup:**
   - In `.claude-code-hermit/config.json` (if `scheduled_checks` contains the entry): filter it out. Preserve every other entry, key ordering, and 2-space indentation. Write back.
   - In `.claude-code-hermit/state/reflection-state.json` (if the key exists): delete `scheduled_checks["ha-automation-errors"]`. Preserve every sibling key. Write back.
   - Print `Retired ha-automation-errors check: removed from config and runtime state.` Omit whichever location was already clean.

   If the operator picked `Skip — handle manually`, print `Left ha-automation-errors references in place — expect a 'skill not found' warning on the next scheduled-checks pass.` and do not modify any files.

   If the operator picked `Other`, ask them what specifically they want done before modifying anything.

No template, CLAUDE-APPEND, or settings changes required for this release.

---

## [0.0.6] - 2026-04-27

### Changed

- Migrate hermit-internal fields to `hermit-meta.json` — `required_core_version`, `requires`, and `hermit.boot_skill` removed from `plugin.json` so native validator passes.
- Bump core requirement to `>=1.0.21` / `^1.0.21` — was `>=1.0.17`.
- Add native `dependencies` field — enables Claude Code's dependency resolver to auto-install core.
- Raise Claude Code prerequisite to v2.1.110+ — required by dep resolver and `claude plugin tag`.
- Tighten CLAUDE.md for contributor audience — remove duplicate install block; promote dev constraints to top-level section.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No file changes required for this release.

**Note:** Operators on core `<1.0.21` should upgrade core first; `hermit-doctor` will flag the version gap.

No `config.json` changes required.

## [0.0.5] — 2026-04-27

### Added

- Add GitHub Actions workflow `Test HA Hermit` — runs pytest on every PR touching HA-hermit; path-filtered to `plugins/claude-code-homeassistant-hermit/`.

### Changed

- Monorepo housekeeping — plugin moved into `plugins/claude-code-homeassistant-hermit/`; inner marketplace.json removed; `required_core_version` set to `>=1.0.17`; URLs updated to monorepo paths.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No operator action required — internal manifest cleanup plus CI-only addition.

No `config.json` changes required.

---

## [0.0.4] — 2026-04-24

### Fixed

- Fix 404 on non-existent bulk endpoint — replaced with two-step fetch (`/api/states` enumerate + per-id parallel GET); YAML-packaged automations counted in `unmanaged`.

### Added

- New CLI subcommand — GETs a raw HA REST path and pretty-prints JSON; safe alternative to `curl` when the `TOKEN` deny-pattern hook is active.
- Add HA API references — links to REST/WebSocket docs; verification rule and known-gotchas section.

### Changed

- Align naming to core 1.0.17 convention — produces `<slug>-<YYYY-MM-DD>.<ext>` filenames; adds `standard_metadata()` and `current_session_id()` helpers; all reports now carry full frontmatter with `session:` field.
- Write to `raw/` not `compiled/` — pattern analyses are weekly snapshots, not durable work-products; output path corrected to `raw/patterns-<date>.md`.
- Write to `compiled/` and cite in SHELL.md — briefs are durable; writes `compiled/brief-morning-<date>.md` and appends wikilink to SHELL.md for session-close archival.
- Document house-profile compiled/ write path — Output section now describes when to write `compiled/context-house-profile-<date>.md`.
- Rename `source: "plugin-check"` → `"scheduled-check"` — aligns with v1.0.15 terminology rename missed in artifact frontmatter.
- Update frontmatter requirements and filename patterns.
- Expand bucket list — document four canonical buckets (`raw/`, `compiled/`, `state/`, `proposals/`) with purpose descriptions.
- Bump core requirement to `>=1.0.17` — requires `## Artifacts` section, `hermit-attach`, and `prompt-context` hook.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Rename legacy artifacts under `.claude-code-hermit/raw/`.** For each file whose name matches the pattern `<YYYYMMDD>T<HHMMSS>Z__<slug>.<ext>` (old double-underscore format):
   - Compute new name `<slug>-<YYYY-MM-DD>.<ext>` (date is the first 8 characters of the timestamp, reformatted as `YYYY-MM-DD`).
   - If the target name already exists in the same directory, append the time portion to disambiguate: `<slug>-<YYYY-MM-DD>-<HHMMSS>.<ext>`.
   - Use `git mv` if the file is tracked by git; otherwise use `mv`.
   - Do not rewrite file bodies.

2. **Move pattern-analysis files from `compiled/` to `raw/`.** For each file matching `compiled/<YYYYMMDD>T<HHMMSS>Z__pattern-analysis.md` (legacy misbucketed writes):
   - Compute target: `raw/patterns-<YYYY-MM-DD>.md` (date from timestamp prefix, reformatted).
   - Apply the same collision rule as step 1 (`raw/patterns-<YYYY-MM-DD>-<HHMMSS>.md`).
   - If the file's YAML frontmatter lacks a `type:` field, insert `type: analysis` after the opening `---` line. Do not touch the body.
   - Use `git mv` if the file is tracked; otherwise `mv`.

3. **Backfill `session: null` frontmatter.** For each `.md` file renamed in steps 1–2 whose YAML frontmatter lacks a `session:` field, insert `session: null` after the last existing frontmatter key (before the closing `---`). Do not synthesize historical session IDs.

4. **Do not touch** files whose names already match `<slug>-<YYYY-MM-DD>.<ext>`, any `-latest.{md,json}` siblings, `automation-<slug>-<date>.yaml`, `script-<slug>-<date>.yaml`, `snapshot-ha-normalized-latest.json`, `compiled/context-house-profile-*.md`, or `compiled/brief-morning-*.md` — these are already correct shape or are intentional fixed-name caches.

5. **Prune if `compiled/` is now empty** — if `.claude-code-hermit/compiled/` contains no files after step 2, no action is needed; the directory remains and core hermit may write to it in future sessions.

No `config.json` changes required. Core hermit v1.0.17 is handled independently by core's own `hermit-evolve` pass; these instructions cover only this plugin's local artifact renames and frontmatter backfill.

---

## [0.0.3] — 2026-04-22

### Changed

- Scheduled-checks decoupled from reflect — all `"plugin_check via reflect"` references updated to `"scheduled check via reflect-scheduled-checks"` across skills, hatch, and docs.
- Bump core requirement to `>=1.0.16` — ensures `scheduled-checks` routine is registered; on 1.0.15 it is absent and checks silently never fire.

---

## [0.0.2] — 2026-04-22

### Fixed

- Rename config key `plugin_checks` → `scheduled_checks` — prior installs used the old key, which reflect silently ignored after core 1.0.15 upgrade.
- Write `config.boot_skill` on fresh installs — field was handled by `hermit-evolve` for upgrades but never written on first setup, causing always-on mode to boot with generic session skill.

### Changed

- Minimum core hermit requirement bumped to ≥ 1.0.15 — required for `scheduled_checks` key support and `boot_skill` config field.

## [0.0.1] — 2026-04-21

Initial public release.
