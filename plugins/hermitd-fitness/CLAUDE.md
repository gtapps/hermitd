# hermitd-fitness

A fitness/training domain layer for `hermitd`: skills, a Strava data subagent, Strava MCP wiring, and routine prompt templates for an autonomous training assistant. A Claude Code plugin, not a standalone project: install from the marketplace (README), then run `/hermitd-fitness:hatch` in a project where core is already hatched; `hatch` checks the required core version from `.claude-plugin/hermit-meta.json`.

## Structure

- `skills/`: `hatch`, `fitness-brief` (`--morning|--evening|--slot <name>`; owns Strava connectivity, activity sync, RPE binding, and the Run deep-dive), `activity-deep-dive`, `capture-activity-rpe` (auto-triggered from channel replies), `set-rpe`, `weekly-coaching-patterns`, `weekly-load-review` (weekly training load vs. rolling baseline), `monday-planning` (weekly training plan suggestion), `domain-brainstorm` (operator-invoked only)
- `agents/strava-data-cruncher.md`: Haiku bulk-aggregation subagent; owns the per-invocation API-call cap
- Permissions: native asks are installed by hatch via `scripts/native-permissions.ts`
- `docs/knowledge-schema.md`: work-product types, state-file owners and shapes, retention

## Rules

- Never commit real Strava OAuth credentials; `.env` and `.mcp.json` are gitignored. The hatch skill never reads `.env` itself: `fitness-lab.ts env-check` and `mcp-config` check it and write `.mcp.json`, so credential values never land in the transcript (`Bash(cat .env*)` is also a seeded native deny).
- The MCP server key is `strava` (written to `.mcp.json` by `hatch`, tool IDs `mcp__strava__*`); skill text and `state-templates/native-permissions.json` depend on that name. Provided by `@r-huijts/strava-mcp-server` via `npx`, unpinned; operators can pin in their own `.mcp.json`.
- Every Strava workflow calls `mcp__strava__check-strava-connection` first.
- No persona or agent name copy ships here; those come from the consumer's `config.json`.

## Routines and state

The `weekly-coaching-patterns` routine invokes `reflect --check-id weekly-coaching-patterns --check hermitd-fitness:weekly-coaching-patterns`. Hatch installs its pre-wake gate from `state-templates/bin/fitness-weekly-patterns-gate`.

- Routines invoke domain skills directly through `config.json.routines[].skill`; keep the registered skill names and arguments aligned with `skills/`.
- Routine entries use the no-leading-slash form `"hermitd-fitness:<skill>"`. Startup skill selection belongs to the operator; this plugin never declares or sets it.
- `raw/` holds ephemeral Strava pulls (aged out by `knowledge.raw_retention_days`), `compiled/` durable outputs (weekly plans and summaries, activity notes; injected at session start within `compiled_budget_chars`), `state/` machine files. Both `raw/` and `compiled/` are flat, per core's storage contract. Owners, shapes, and retention of `strava-last-activity-id.txt`, `strava-weekly-baselines.json`, `activity-notes.json` (durable, keyed by Strava activity ID), and `strava-pending-rpe.json` (written by the evening brief only after a confirmed channel send; consumed once by `capture-activity-rpe` within 24h) are in `docs/knowledge-schema.md`.
- `MEMORY.md` (auto-memory) carries the athlete profile, training preferences, and notes.

## Hatch target routing

Core's `scripts/domain-hatch.ts` owns target resolution and `hatch-options.json`. `/hatch` Step 1 runs `.hermit/bin/hermitd-run domain-hatch preflight hermitd-fitness`; its Native approval rules step asks Visibility only when `needs_target_question` says so and records the choice with `domain-hatch ensure-target hermitd-fitness --target <choice>`.

## Strava API

- Reference: https://developers.strava.com/docs/reference/ ; OAuth: https://developers.strava.com/docs/authentication/
- Rate limits are tight (per 15 minutes and per day; current numbers on the reference page). `strava-data-cruncher` caps calls per invocation for that reason, and `get-all-activities` is paginated, so large histories can hit the limit.
- `get-activity-streams` needs explicit `keys` (e.g. `heartrate,velocity_smooth,altitude,cadence`).
- HR zone boundaries come from `get-athlete-zones`, never hardcoded thresholds.

## Development

From the repo root, `bun run dev <target-project>`, hatch core, then `/hermitd-fitness:hatch`. Tests: `bash tests/run-all.sh`.

