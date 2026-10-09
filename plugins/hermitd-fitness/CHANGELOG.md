# Changelog

## [Unreleased]

### Fixed
- Domain brainstorm reports have a declared knowledge-schema type, avoiding schema drift findings.

### Upgrade Instructions
1. If `.hermit/knowledge-schema.md` exists and its `## Work Products` section has neither a `- domain-brainstorm:` nor a `- **domain-brainstorm**:` bullet, append the `domain-brainstorm` bullet from `${CLAUDE_PLUGIN_ROOT}/skills/hatch/SKILL.md` to that section. Otherwise skip. Preserve all existing content.

## [0.2.4] - 2026-10-02

### Changed
- The plugin is named `hermitd-fitness` in the `hermitd` marketplace, with namespaced skills and core commands updated to match.

## [0.2.3] - 2026-09-29

### Changed
- Hatch's host next step uses `hermit start` and requires core 1.4.8 or newer.

## [0.2.2] - 2026-09-28

### Fixed

- Installed documentation pointers no longer contain unresolved plugin-root tokens; briefing schema reads use the loaded plugin path.

## [0.2.1] - 2026-09-25

### Removed

- Plugin-root `settings.json` permission list, which Claude Code never applied; native rules are installed into project settings.

## [0.2.0] - 2026-09-16

### Changed

- Core 1.4.0 is required for task records and resident startup.
- Scheduled routines invoke domain skills directly.
- Coaching artifacts link to an open task when present, and progress notes use task records.

### Upgrade Instructions

In `.claude-code-hermit/config.json`, inspect each routine id below. Only when its `skill` is still `claude-code-hermit:session-start`, set `skill` to the mapped value and remove `prompt_file`. Preserve every other field. Leave entries with any other skill untouched.

| Routine id | Skill |
|---|---|
| `morning-brief` | `claude-code-fitness-hermit:fitness-brief --morning` |
| `evening-brief` | `claude-code-fitness-hermit:fitness-brief --evening` |
| `weekly-load-review` | `claude-code-fitness-hermit:weekly-load-review` |
| `monday-planning` | `claude-code-fitness-hermit:monday-planning` |

Leave installed `compiled/routine-*.md` copies on disk. Run `/claude-code-hermit:hermit-routines load` after updating the registrations.

## [0.1.4] - 2026-09-12

### Changed

- The native-permissions installer accepts only a project settings path.
- Hatch no longer seeds `autoMode.environment`; Claude Code does not read it from project settings. Existing marker files and `autoMode` blocks in project settings are unread and left in place.

## [0.1.3] - 2026-09-10

### Changed

- Write-class Strava tools (`star-segment`, `connect-strava`, `disconnect-strava`) request native approval instead of being denied outright.

### Upgrade Instructions

Resolve the project settings target with domain-hatch preflight claude-code-fitness-hermit: local maps to .claude/settings.local.json; committed maps to .claude/settings.json. Run `bun <plugin_root>/scripts/native-permissions.ts <resolved-settings-file>`. Refresh the installed CLAUDE-APPEND block and notify the operator that existing guarded actions now use Claude Code native approval instead of the prior refusal or conversational confirmation.

## [0.1.2] - 2026-09-07

### Changed
- Weekly coaching analysis runs as a routine with a pre-wake trend gate. Core 1.3.3 is required.
- Briefing composition uses existing voice preferences without a dedicated sign-off setting.

### Upgrade Instructions

1. Complete core's periodic-check conversion first.
2. From the consumer project root, install the shipped gate, always overwriting the previous copy. `<fitness-plugin-root>` is this plugin's own installed root — the `install_path` the upgrade plan reports for `claude-code-fitness-hermit`, not core's plugin root and not `${CLAUDE_PLUGIN_ROOT}` (that token is not substituted in this file and is empty as a shell variable):
   ```bash
   install -m 755 "<fitness-plugin-root>/state-templates/bin/fitness-weekly-patterns-gate" .claude-code-hermit/bin/fitness-weekly-patterns-gate
   ```
   If the source file is not there, stop and report it — do not continue to step 3, which would point the routine at a gate that was never installed.
3. Re-read `.claude-code-hermit/config.json`. On the `weekly-coaching-patterns` routine, set `precheck` to `.claude-code-hermit/bin/fitness-weekly-patterns-gate` and `precheck_timeout_s` to `60`. Preserve its schedule, skill, model, enabled state, and other operator fields. If absent, append the routine from hatch Step 7c without changing any other routine.
4. Run `/claude-code-hermit:hermit-routines load`.

## [0.1.1] - 2026-08-31

### Changed
- `hatch` is operator-invoked only through `disable-model-invocation`. If core is not initialized, it prints `/claude-code-hermit:hatch` for the operator to type instead of offering to run it.

## [0.1.0] - 2026-07-26

### Added
- `fitness-brief` skill — daily morning/evening brief (`--morning|--evening|--slot <name>`), composed in the operator's configured voice. Morning is forward-looking (readiness + today's plan); evening is backward-looking (today's training, or an earned-rest note, + tomorrow's setup) and takes over `strava-sync`'s activity sync, RPE binding, and Run deep-dive. Flagging is intent-driven prose, not `strava-sync`'s fixed anomaly/fatigue thresholds.
- Two new routines, `morning-brief` and `evening-brief`, registered by `hatch`.

### Fixed
- `domain-brainstorm` no longer writes its own `brainstorm-emit` event — core's triage gate already records every verdict. Proposals now carry `tags: [capability-brainstorm]` instead of `[domain-brainstorm, ideation]`, so they count toward the brainstorm kill-criteria segment rather than `reflect`'s.
- `hatch` no longer tells the operator to `cp .env.example .env`; a `.env.example` does not ship with the plugin.

### Changed
- `hatch` reads the required core version from `.claude-plugin/hermit-meta.json` at runtime via `domain-hatch preflight`, instead of the hardcoded `1.0.26` floor its prose carried. That floor sat many minor versions below what the manifest declared, so the wizard proceeded against a core too old for it.
- Target resolution and CLAUDE-APPEND writing are delegated to core: `domain-hatch preflight claude-code-fitness-hermit` resolves the target, `ensure-target` records an operator override, `sync-block` writes the block. The skill no longer detects install scope from `claude plugin list --json` or stamps `hatch-options.json`.
- `hatch` re-reads `config.json` immediately before merging its routines, scheduled checks and version stamp, instead of reusing the copy it loaded before the wizard ran. Anything written to the file during the wizard is no longer clobbered.
- Requires core `>=1.2.34`. Core absorbed its proposal satellites into `proposal.ts` verbs, so the shared route this plugin calls through `bin/hermit-run` is now `proposal metrics …`. `bin/hermit-run` resolves a script by bare filesystem probe, so pairing this version with an older core fails with a misleading "plugin may predate this command" error.
- `domain-brainstorm` reads core's proposal-metrics report via `.claude-code-hermit/bin/hermit-run` (a path relative to this plugin can't reach core's install), and a kill-criteria breach now escalates to the operator as a class-level signal instead of instructing the skill to self-retire (the shared segment can't attribute noise to one skill).
- `strava-sync` and `strava-health-check` routines removed — `fitness-brief` (morning + evening) now owns Strava connectivity, activity sync, RPE binding, and Run deep-dive as the plugin's two daily beats.
- Activity notes carry `cardiac_drift_bpm` in frontmatter; `weekly-patterns` reads it there and falls back to the rendered line for older notes.
- The CLAUDE-APPEND block dropped the routine and scheduled-check tables (schedules and `enabled` state live in `config.json`) and the five-file state map, which now points at `docs/knowledge-schema.md`. ~3,852 B → ~2,881 B. Connection-first, the secrets rules, the settings-blocked write tools, the `fitness-lab.ts` mediation boundary, the zones rule, and the full-history grounding gotcha are unchanged.

### Upgrade Instructions
For already-installed hermits, `hermit-evolve` should:
1. Copy `state-templates/compiled/routine-fitness-brief-morning.md` and `routine-fitness-brief-evening.md` into `.claude-code-hermit/compiled/` (skip if already present).
2. Add `morning-brief` and `evening-brief` to `config.json routines[]` (same entries as hatch Step 7b), `enabled: true`.
3. Remove the `strava-sync` and `strava-health-check` entries from `config.json routines[]`, and delete `.claude-code-hermit/compiled/routine-strava-sync.md` and `routine-strava-health-check.md` — `fitness-brief` replaces both. This is the one non-additive step; it consolidates the daily channel sends into the two briefs and avoids a double notification.

## [0.0.15] - 2026-07-21

### Fixed
- No-op `Write(<path>)` rules are gone from `settings.json`; their `Edit(...)` equivalents already cover file-editing tools and avoid the boot warning.

## [0.0.14] - 2026-07-12

### Fixed
- `getAccessToken` now prefers the unexpired Strava MCP token in `~/.config/strava-mcp/config.json`, falling back to `.env`'s `STRAVA_ACCESS_TOKEN`.

## [0.0.13] - 2026-07-06

### Added
- Hatch Step 8d seeds `www.strava.com` in `autoMode.environment` through `scripts/automode-env.ts` for nightly `strava-sync` fetches.

## [0.0.12] - 2026-07-03

### Added
- `scripts/fitness-lab.ts` provides deterministic `analyze`, `weekly-load`, `weekly-patterns`, and `rpe` commands, reproducible Strava reductions, and hard auth-failure recovery.

### Changed
- `activity-deep-dive`, RPE, and coaching skills now delegate calculations to `fitness-lab.ts`; `strava-data-cruncher` falls back to MCP only for unsupported shapes.
- CLAUDE-APPEND now routes load analysis through `fitness-lab.ts`, with MCP stream and detail tools reserved for ad-hoc questions.
- Hatch Step 4 now offers to reuse an existing Strava MCP server instead of writing a duplicate `.mcp.json` entry.
- README references now use `/hermit-health` after the `hermit-brain` merge.
- `weekly-coaching-patterns` now invokes `reflect --scheduled-checks` after the scheduled-check runner merged into `reflect`.
- Reduced CLAUDE-APPEND from 5.3 KB to about 3.9 KB by removing catalog tables while retaining the all-time-totals guidance.

### Fixed
- `weekly-load` now propagates the exit-1 `strava_auth` recovery signal for `/athlete/zones` 401s instead of degrading zone load.
- `weekly-load --weeks` now rejects non-positive values, and `analyze` fetches activity details within its batch.

### Upgrade Instructions
- No manual steps. The Fitness CLAUDE-APPEND block is synced automatically via `hermit-evolve` Step 7's sibling-upgrade flow when this version's gap is processed.

## [0.0.11] - 2026-06-29

### Changed
- `strava-data-cruncher` no longer sets `maxTurns`; its internal 30-API-call governor remains the limit.

## [0.0.10] - 2026-06-24

### Fixed
- Hatch now writes a state marker before core delegation so the core terminus resumes the domain skill automatically.

## [0.0.9] - 2026-06-23

### Fixed

- Hatch Step 1 now prints its re-run instruction before terminal core invocation so subsequent steps are not dropped.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the fitness hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated skill.

No `config.json` changes required.

## [0.0.8] - 2026-06-12

### Changed

- Tests now use Bun and TypeScript, including the test runner and domain-brainstorm inline evaluation.
- `strava-data-cruncher` now uses the forward-compatible `haiku` model alias.
- Raised the core dependency floor to `>=1.2.0`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core version** — confirm the installed `claude-code-hermit` core is >=1.2.0. If not, run `claude plugin update claude-code-hermit` first.

No `config.json` changes required.

---

## [0.0.7] - 2026-06-04

### Added

- `strava-sync` and `weekly-load-review` now surface strength-session recovery signals and persist `strength_minutes` to `strava-weekly-baselines.json`.
- An on-demand `domain-brainstorm` skill now surfaces up to two Strava-backed training coverage or imbalance proposals.
- Training-history facts now require full-history Strava queries rather than memory; recent-activity questions are unchanged.
- `activity-deep-dive` now supports trail running with terrain-aware metrics, observations, recovery windows, and artifact frontmatter.

### Changed

- `routine-weekly-load-review` now uses elevation-weighted `adjusted_km` for load flags while retaining raw-distance output.
- Raised the core dependency floor to `>=1.1.9`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Sync the CLAUDE-APPEND block** — Step 7 re-appends the updated canonical block to the hatch target, adding `domain-brainstorm` to the quick-reference skills table and the new Fitness Proposal Categories section.
2. **Overwrite the routine template** — copy `state-templates/compiled/routine-weekly-load-review.md` from the plugin into `.claude-code-hermit/compiled/` so the weekly review picks up load-adjusted distance. This is a bot-owned prompt; overwriting is safe.

No `config.json` changes required.

---

## [0.0.6] - 2026-05-31

### Added

- A weekly `weekly-coaching-patterns` check now detects four-session rising cardiac-drift trends through `reflect-scheduled-checks`.
- `strava-sync` now triggers coaching deep dives for up to three new runs and logs non-retried failures.
- `activity-deep-dive` now reports cadence, coefficient of variation, and over-striding or variability flags for runs.

### Changed

- `capture-activity-rpe` now reruns `activity-deep-dive` for `Run` activities so artifacts include RPE.
- `activity-deep-dive` now identifies interval and steady-state sessions, recording `session_kind` with tailored metrics.
- `activity-deep-dive` now appends deduplicated labeled coaching observations to `SHELL.md` findings.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Sync the CLAUDE-APPEND block** — Step 7 re-appends the updated canonical block to the hatch target, adding `weekly-coaching-patterns` to the quick-reference skills table.

No `config.json` changes required.

---

## [0.0.5] - 2026-05-21

### Fixed

- Removed duplicate Fitness blocks left in `CLAUDE.md` after the core 1.1.1 target migration.

### Changed

- Hatch Step 6 now writes the CLAUDE-APPEND block to the target selected in `hatch-options.json`.
- Upgrade Instructions Step 3 now runs unattended because marked blocks are template-authoritative.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following steps automatically (via Step 7's sibling upgrade flow, which runs every plugin's `### Upgrade Instructions` before its CLAUDE-APPEND sync). The migration is unattended — no operator prompts. `hermit-evolve` Step 7 re-syncs the canonical block to `hatch_target` afterwards.

1. **Resolve `hatch_target`.** Use the same fallback chain `hermit-evolve` Step 2a uses, substituting the Fitness marker: read `.claude-code-hermit/state/hatch-options.json` and use the `"target"` field; else check `CLAUDE.local.md` for `<!-- claude-code-fitness-hermit: Fitness Workflow -->` → `hatch_target = "local"`; else check `CLAUDE.md` for the same marker → `hatch_target = "committed"`; else stop — the Fitness block is in neither file, nothing to migrate.

2. **Identify the non-target file.** `non_target = (hatch_target == "local") ? "CLAUDE.md" : "CLAUDE.local.md"`.

3. **If the marker is present in `non_target`, silently strip the marked block** (everything from the opening `<!-- claude-code-fitness-hermit: Fitness Workflow -->` through the matching closing `<!-- /claude-code-fitness-hermit: Fitness Workflow -->`, inclusive). Per `/hatch`'s single-source-of-truth contract, the CLAUDE-APPEND template is authoritative and operator overrides belong outside the marked block, so no hand-edit preservation is needed. Step 7's sync re-appends the canonical block to `hatch_target` afterwards.

4. **If the marker is only in `hatch_target`:** no-op. Steady state — Step 7's normal sync handles routine version-bump replacement.

No `config.json` changes required.

## [0.0.4] - 2026-05-21

### Changed

- Raised the core dependency floor to `>=1.1.1`.
- README now lists `capture-activity-rpe` and `set-rpe` in its skills overview and features.
- Raised the minimum tested Claude Code version to v2.1.140+.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core version** — confirm the installed `claude-code-hermit` core is >=1.1.1. If not, run `claude plugin update claude-code-hermit` first.

No `config.json` changes required.

---

## [0.0.3] - 2026-05-14

### Added

- `capture-activity-rpe` now captures channel-reply RPE in `activity-notes.json`.
- `/claude-code-fitness-hermit:set-rpe` now supports manual and retroactive RPE entry.
- `strava-sync` now writes `strava-pending-rpe.json` and adds an RPE prompt to daily summaries.
- `activity-deep-dive` now includes subjective RPE notes in output and compiled artifact frontmatter.
- `weekly-load-review` now adds an average RPE summary when the week has at least two activity notes.
- Added `knowledge-schema.md` documentation for `activity-notes.json` and `strava-pending-rpe.json`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Overwrite routine templates** — copy `state-templates/compiled/routine-strava-sync.md` and `state-templates/compiled/routine-weekly-load-review.md` from the plugin into `.claude-code-hermit/compiled/`. These are bot-owned prompts; overwriting is safe.
2. **Seed activity notes store** — create `.claude-code-hermit/state/activity-notes.json` as `{}` if the file does not exist.
3. **Update Fitness Workflow block** — in the project `CLAUDE.md`, between the `<!-- claude-code-fitness-hermit: Fitness Workflow -->` markers, append to the Conventions section:
   - `Subjective notes: state/activity-notes.json (written by capture-activity-rpe + set-rpe, read by activity-deep-dive + weekly-load-review)`
   - `Pending RPE: state/strava-pending-rpe.json (written by strava-sync after a successful channel send, read and deleted by capture-activity-rpe)`

No `config.json` changes required.

---

## [0.0.2] - 2026-05-03

### Changed

- Raised the core dependency floor to `>=1.0.26`; Hatch now warns and stops on older installations.
- Added `strava.com` to Docker network requirements for `/claude-code-hermit:docker-security`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Verify core hermit version** — run `/claude-code-hermit:hermit-doctor` and confirm it reports `claude-code-hermit ≥1.0.26`. If not, run `/claude-code-hermit:hermit-evolve` on the core plugin first.

No `config.json` changes required.

---

## [0.0.1] — 2026-04-28

### Added

- Initial public release.

### Upgrade Instructions

No previous version — first install; run `/claude-code-fitness-hermit:hatch`.
