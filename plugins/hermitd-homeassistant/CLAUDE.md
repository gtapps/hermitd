# hermitd-homeassistant

A Home Assistant domain layer for `hermitd`: skills, subagents, a safety hook, and a TypeScript CLI (run by bun) for bulk work.

## Structure

- `skills/ha-*/`: workflow skills (`/hermitd-homeassistant:ha-*`); `ha-boot` is the single entry point (starts the hermit session, checks HA connectivity). `skills/domain-brainstorm/` is operator-invoked only.
- `agents/`: `ha-safety-reviewer`, `ha-automation-builder`, `ha-pattern-analyst`
- `hooks/mcp-safety-gate.ts` + `hooks.json`: PreToolUse on `mcp__homeassistant__.*`, the whole server namespace; read-only tools are allow-listed inside the gate
- `bin/ha-agent-lab` + `src/*.ts`: the CLI (REST client, WebSocket client, policy engine, simulation, apply). `src/policy.ts` is shared by the CLI and the hook.
- Permissions: native asks are installed by hatch via `scripts/native-permissions.ts`
- `state-templates/CLAUDE-APPEND.md`: block injected into the target project by `hatch`
- `.claude-plugin/hermit-meta.json`: `required_core_version`, `requires`, `hermit.boot_skill`
- `SAFETY.md`: the safety model; `docs/cli-reference.md`: command usage examples

## Rules

- Never commit real HA URLs, tokens, or device inventories. Check credential state with `bin/ha-agent-lab boot status`, never `cat .env` or `echo $HOMEASSISTANT_TOKEN` (core's seeded rules deny `cat .env*`, and expanding a credential var puts the value in the transcript).
- Actuation of sensitive domains (`lock`, `alarm_control_panel`, security-related `cover`/`button`/`switch`) is gated by `ha_safety_mode` in `.hermit/config.json` (absent in valid config = `ask`). Under `strict`, never actuate autonomously; blocked work becomes a proposal. Under `ask`, the operator is prompted before any sensitive actuation, YAML apply or direct MCP call alike. Uncertain entities and new domains default to sensitive. Full model: `SAFETY.md`.
- Use the language stored in OPERATOR.md's `## HA hermit` section for all user-facing output. That section is operator-curated config (locale today); auto-memory holds Claude-derived house knowledge.
- Prefer the CLI over ad-hoc reasoning when a helper exists.

## MCP vs CLI

- **MCP server `homeassistant`**: read-only live ops by default (`GetLiveContext`, `GetDateTime`; HA 2026.9+ prefixes every tool with its integration domain, e.g. `homeassistant__GetLiveContext`, `llm__GetDateTime`). `Hass*` intent tools (`HassTurnOn`, `intent__HassTurnOn`, `light__HassLightSet`, ...) are hard-blocked unless `ha_assist_control_enabled: true` in `config.json` (set during hatch); when enabled, HA's own expose-to-Assist gate is the control boundary and the hook defers to it. The server name `homeassistant` is required: the hook matches on it.
- **CLI `bin/ha-agent-lab`**: build and analysis operations: context refresh, YAML simulation, policy checks, apply, audits, structural writes (helpers, areas, registries, dashboards), `ha trigger-automation`. Invoke as `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha <command>`; `--help` and `src/cli.ts` are the command surface, `docs/cli-reference.md` has examples. Writes are gated by `ha_safety_mode` and Claude Code native approval.

## HA API gotchas

REST docs: https://developers.home-assistant.io/docs/api/rest/ ; WebSocket docs: https://developers.home-assistant.io/docs/api/websocket/ . Before changing endpoint usage, verify against upstream or probe a live instance with `./bin/ha-agent-lab ha probe <path>`; do not assume an endpoint exists.

- Automations have no bulk REST listing: enumerate via `/api/states` (filter `domain=automation`), then fetch each config from `/api/config/automation/config/{automation_id}`. YAML-packaged automations with a slug `id` carry it in state attributes and are retrievable the same way. The `config/automation/list` WebSocket command returns "Unknown command" on real instances.
- `POST /api/config/{automation|script}/config/{id}` upserts; the URL `id` is what counts. An automation body `id` is ignored, but a script body must not carry one (HA's script schema rejects it) and script ids must be lowercase slugs. Returns `{"result":"ok"}`, or 403 when HA is in YAML config mode. `GET` reflects the change synchronously; no retry needed.
- `DELETE .../config/{id}` on a missing id returns 400 (not 404) with `{"message":"Resource not found"}`. All HA error responses carry `{"message":"..."}`; surface it verbatim.
- `--reload {automation|script|scene}` in `ha validate-apply` controls both the REST push endpoint and the reload service call; there is no push-only mode. Scenes use the same REST config API and `scene.reload`.
- `POST /api/template` and `GET /api/error_log` return raw text, not JSON; use `client.postText()`/`client.getText()` in `src/ha-api.ts`. `GET /api/error_log` 404s on deployments where HA never registered `DATA_LOGGING` (a deployment characteristic; the command surfaces the 404 verbatim); `ha logbook`/`ha system-log` have no such dependency.
- `GET /api/logbook/<timestamp>` filters by one entity only (`?entity=<id>`), unlike `filter_entity_id` on `/api/history/period/`; hence `ha logbook --entity` is singular.
- `ha call-service` is gated per entity/service by `gateServiceCall` in `policy.ts`, not by the structural gate: concrete sensitive targets block as a proposal under `strict` and request native approval under `ask`; unresolvable selectors and malformed target shapes hard-block in both modes; non-sensitive maintenance calls (reloads, `recorder.purge`, `notify.*`) proceed. It reuses the hook's fail-closed entity extraction (`extractEntityIds`/`hasUnresolvableTarget`/`isWellFormedEntityId`) plus a `hasMalformedTargetShape` guard for wrong-shaped `--data`.
- The `update` domain has its own carve-out in `gateServiceCall`, independent of `ha_safety_mode` and `SENSITIVE_DOMAINS`: with `ha_update_auto_apply` unset, any `update.*` call is blocked (surface as a proposal); with it `true`, every call requires native approval before execution. A call that also touches a lock/alarm entity still hard-blocks under strict. The Core/OS/Supervisor tier rule lives in `skills/ha-apply-update/SKILL.md`.

### WebSocket commands (`src/ha-ws.ts` + `src/structure.ts`)

- Helpers, areas, and entity/device registries have no REST endpoint; they are reachable only over `wss://<host>/api/websocket`. `HomeAssistantWsClient` opens one connection per CLI invocation (auth handshake, commands, close), reusing the REST client's URL selection and token.
- Command types: helpers `<type>/create|list|delete` (`input_boolean|input_number|input_text|input_select|input_datetime|timer|counter|schedule`); areas `config/area_registry/*`; registries `config/entity_registry/list|update`, `config/device_registry/list|update`; dashboards `lovelace/dashboards/list|create|delete`, `lovelace/config`, `lovelace/config/save`. The docs index documents only the auth/result envelope, so confirm a new command's exact `type` and payload against a live instance.
- All WS mutations are gated by `ha_safety_mode` via `gateStructuralMutation` in `policy.ts`; reads never are. Under `strict` a mutation is refused (`blocked: true`) and surfaced as a proposal; under `ask` Claude Code requests native approval before execution. Every mutation writes an `audit-ha-ws-*` report to `.hermit/raw/`.

## Routines

`hatch` registers routines (`daily-ha-context`, `morning-brief`, `evening-brief`; unified vs legacy brief mode is decided at hatch time) and proposal-producing routines (`ha-patterns`, `ha-safety-audit`, `ha-integration-health`, `ha-update-check`, each invoking `reflect --check-id <id> --check <namespaced skill>`) in `.hermit/config.json`. Schedules live there, not here. Core's `hermit-routines load` activates them.

## Hatch target routing

Core's `scripts/domain-hatch.ts` owns target resolution and `hatch-options.json`. `/hatch` Step 1 runs `.hermit/bin/hermitd-run domain-hatch preflight hermitd-homeassistant`; Step 6 asks the Visibility question only when `needs_target_question` says so, records it with `domain-hatch ensure-target hermitd-homeassistant --target <choice>`, and writes the block with `domain-hatch sync-block hermitd-homeassistant`. Hatch appends when the marker is absent and skips otherwise; refreshing the block on a version bump is `hermit-evolve`'s job.

## Development

From the repo root, `bun run dev <target-project>`, hatch core, then `/hermitd-homeassistant:hatch`. Tests: `bun test` from this directory.

- The CLI and both hooks are TypeScript run directly by bun with zero runtime dependencies. Python is test-only: `tests/gate-corpus.test.ts` replays the retired Python hooks from git history and `tests/yaml-parity.test.ts` compares against PyYAML. The suite needs full git history and Python with `python-dotenv` and `PyYAML`; set `GATE_PARITY_PYTHON` when that interpreter is outside PATH.
- The safety hook fails closed: an MCP call whose target cannot be resolved to concrete entity IDs is blocked. Changes to `hooks/mcp-safety-gate.ts` or `src/policy.ts` must keep `tests/gate-corpus.test.ts` (golden byte-equivalence with the retired gate) and `tests/gate-fuzz.test.ts` (fail-closed property) green.
- When using `tmpPath()` from `tests/helpers.ts`, register `afterAll(cleanupTmp)`. Cleanup after each test can delete fixtures still used by concurrent tests. Keep independent corpus and fuzz subprocess work asynchronous.

Static `permissions.ask` rules cover structural writes through `bin/ha-agent-lab`, not the `bun <root>/src/cli.ts` development form. `cli-approval.ts` covers `call-service` and `restore-states` in both forms because their policy depends on the target entities.
