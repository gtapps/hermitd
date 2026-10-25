# Changelog

## [Unreleased]

### Changed
- Hatch matches existing routines by full skill string or namespaced id and assigns new rows `hermitd-feed:` ids, preserving existing operator fields. Requires hermitd 1.4.21.

### Upgrade Instructions
1. Run `.hermit/bin/hermitd-run settings-edit .hermit/config.json migrate plugin-routine-ids --plugin hermitd-feed --ids feed-brief-morning,feed-brief-evening,weekly-digest,source-scout` and report the receipt.

**Leftover check:** The operator's own files may still refer to the routine ids `feed-brief-morning`, `feed-brief-evening`, `weekly-digest` and `source-scout`, which this release renamed to `hermitd-feed:<id>`. Find those references, ask once before changing anything, and update each to the new id.

## [0.2.6] - 2026-10-19

### Changed
- Hatch no longer writes an instruction block into `CLAUDE.md`; the plugin's skills, agents and hooks carry its guidance. Requires hermitd 1.4.17.

## [0.2.5] - 2026-10-17

### Changed
- Requires core `>=1.4.16`, whose `domain-hatch` prints one JSON object.
- `source-fetch-result.ts` and `reddit-fetch.ts` print one JSON object; a rejected verify and an unavailable subreddit exit 0 with `status` and `reason`.

### Fixed
- `/hatch` relays `next_steps` when core needs bootstrapping and the `remedy` when core is below the floor. A refused block sync names the file with the duplicate marker.
- Briefs no longer skip every web and RSS source after one oversized fetch result; the previous `tmp/feed-source-items-<slot>.json` is deleted before each fetch.
- `feed-sources.md` table violations now reach Claude: the `validate-sources` hook returns a PostToolUse block decision instead of exiting 1.

### Upgrade Instructions

1. **Offer to migrate operator skills to the helper-output convention.** Look only in the project root's `.claude/skills/` and `.claude/commands/`; skip `.claude/worktrees/`, nested project repositories, backups and plugin directories. List each skill line that runs a `hermitd-feed` helper through this plugin's install path and branches on its old output: `source-fetch-result.ts new-run` read as a bare UUID, `verify` read by a non-zero exit on a rejected payload, or `reddit-fetch.ts` read as a bare array or by exit 1 when Reddit is unavailable. A line about the project's own script output, a placeholder, or a call that only checks the exit code of a real failure is not a hit. Skip silently when there are none. Otherwise show them with file and line, and **defer per SKILL.md Step 10** with `options: ["Migrate them to the convention", "Keep them as they are"]`, no `on_resolve`; the chosen branch is applied in attended Step 10 only:
   - *Migrate them to the convention*: update each line to the shape the `hermitd-feed` skill running the same command describes, per core's `docs/creating-your-own-hermit.md` § Helper-script output. Report each file changed.
   - *Keep them as they are*: change nothing, and tell the operator that these lines misread `hermitd-feed` output until they are updated.

## [0.2.4] - 2026-10-02

### Changed
- The plugin is named `hermitd-feed` in the `hermitd` marketplace, with namespaced skills and core commands updated to match.

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
- Progress notes (added sources, injection attempts, source-scout findings) write to the open task record instead of SHELL.md.

### Upgrade Instructions

In `.claude-code-hermit/config.json`, inspect each routine id below. Only when its `skill` is still `claude-code-hermit:session-start`, set `skill` to the mapped value and remove `prompt_file`. Preserve every other field. Leave entries with any other skill untouched.

| Routine id | Skill |
|---|---|
| `feed-brief-morning` | `feed-hermit:feed-brief --morning` |
| `feed-brief-evening` | `feed-hermit:feed-brief --evening` |
| `weekly-digest` | `feed-hermit:weekly-digest` |

Leave installed `compiled/routine-*.md` copies on disk. Run `/claude-code-hermit:hermit-routines load` after updating the registrations.

## [0.1.8] - 2026-09-10

### Fixed
- Earlier-run fetch output is rejected before brief scoring when a new collection fails to replace it.
- `unknown keys "description" ... ignored` warning printed at every session start. `description` is not part of Claude Code's hook schema on a matcher group; the prose now lives in each hook script's header, with one legal root-level `description` in `hooks.json`.

## [0.1.7] - 2026-09-07

### Changed
- Resident duties are installed in RESIDENT.md while shared rules remain in the CLAUDE file.
- Monthly source discovery runs as an unattended routine, with candidates queued for operator review. Core 1.3.3 is required.

### Upgrade Instructions

Run `.claude-code-hermit/bin/hermit-run domain-hatch sync-block feed-hermit` from the project root to install the resident section in `.claude-code-hermit/RESIDENT.md`. Then restart with `.claude-code-hermit/bin/hermit-start --resume`.

1. Complete core's periodic-check conversion first.
2. Re-read `.claude-code-hermit/config.json`. If the `source-scout` routine's skill carries the `claude-code-hermit:reflect` wrapper, replace only its `skill` with `feed-hermit:source-scout --scheduled`. Preserve its schedule, model, enabled state, and other operator fields. Leave an existing custom skill unchanged.
3. Run `/claude-code-hermit:hermit-routines load`.

## [0.1.6] - 2026-09-06

### Fixed
- `feed-brief` passes the absolute project root and output path to `source-fetcher`, so the subagent's own inherited working directory can no longer redirect its write away from `tmp/feed-source-items-<slot>.json`.

## [0.1.5] - 2026-08-31

### Changed
- `hatch` is operator-invoked only through `disable-model-invocation`. If core is not initialized, it prints `/claude-code-hermit:hatch` for the operator to type instead of offering to run it.

## [0.1.4] - 2026-08-28

### Fixed
- `feed-brief` Phase 1 classifies each `web`/`rss` source from `tmp/feed-source-items-<slot>.json`, not the `source-fetcher` reply, so a fabricated success summary no longer hides a failed fetch.
- `source-fetcher` reads its output file back before reporting, reports per-source status instead of an aggregate count, and never writes to a suffixed variant path.

## [0.1.3] - 2026-08-14

### Fixed
- `fetch-guard` resolves `feed-sources.md` from the project root (`CLAUDE_PROJECT_DIR`, else a walk up to `.claude-code-hermit/config.json`) instead of the session's cwd. A `cd` earlier in the session made the allowlist unreadable, and the hook fails open — so the domain guard silently stopped enforcing.
- `validate-sources` validates the file the hook reports, not a same-named `feed-sources.md` under the current cwd.

## [0.1.2] - 2026-07-26

### Fixed
- No-op `Write(path)` settings rules no longer trigger a boot warning; `Write(tmp/**)` is now `Edit(tmp/**)` so tmp fetch-scratch writes are auto-approved.

### Changed
- `hatch` reads the required core version from `.claude-plugin/hermit-meta.json` at runtime via `domain-hatch preflight`, instead of the hardcoded `1.2.22` floor its prose carried. That floor sat below what the manifest declared, so the wizard proceeded against a core too old for it.
- Target resolution and CLAUDE-APPEND writing are delegated to core: `domain-hatch preflight feed-hermit` resolves the target, `ensure-target` records an operator override, `sync-block` writes the block. The skill no longer detects install scope from `claude plugin list --json` or stamps `hatch-options.json`.
- `hatch` re-reads `config.json` immediately before writing the feed block, routines, scheduled check and archive registration, instead of reusing the copy it loaded before the wizard ran. Anything written to the file during the wizard is no longer clobbered.
- Requires core `>=1.2.34` for the shared `domain-hatch` protocol. `bin/hermit-run` resolves a script by bare filesystem probe, so pairing this version with an older core fails with a misleading "plugin may predate this command" error.
- The CLAUDE-APPEND block dropped the per-type fetch dispatch detail and the routine/scheduled-check tables, and no longer carries fetch-cost numbers — `docs/schema.md` owns them as the `tokens_approx` defaults, so the two copies can no longer drift. 3,203 B → ~2,384 B. The untrusted-content rule stays verbatim; the allowlist line now states that `fetch-guard` fails open when `feed-sources.md` is unreadable.
- `feed-brief` § Security points at the CLAUDE-APPEND rule instead of restating it in different words.

## [0.1.1] - 2026-07-21

### Fixed
- The `briefs` archive is now in `storage_drift.ignore`, preventing core session-start and reflect checks from reporting the canonical archive as layout drift.

### Upgrade Instructions

1. **Read `.claude-code-hermit/config.json`.**
2. **Ensure `storage_drift` is an object** — create it if absent or malformed, preserving any valid sibling keys.
3. **Ensure `storage_drift.ignore` is an array** — create it as an empty array if absent or malformed, preserving any existing entries.
4. **Append `"briefs"` to `storage_drift.ignore`** if it is not already present.
5. **Write the updated `config.json`.**

**Note:** `.claude-code-hermit/briefs/` is feed-hermit's own archive — nothing under it is moved or rewritten.

---

## [0.1.0] - 2026-07-20

### Added
- A feed-to-brief pipeline extracted from a standalone feed hermit, with a brief engine (`feed-brief`, `weekly-digest`, the `source-fetcher` Haiku agent, `FEEDS.md`, archive-frontmatter analytics, and `pending-delivery` recovery), source curation (`feed-sources.md`/`feed-categories.md`, `validate-sources`, `add-source`, `source-scout`, and `source-health`), fetch adapters (`reddit-fetch.ts` and graceful Chrome-source skips), and `story-arcs`/`deep-dive` follow-ups.
- The `fetch-guard` PreToolUse hook derives a WebFetch domain allowlist from `feed-sources.md` and infrastructure sources, blocking off-allowlist fetches while failing open when the registry is unreadable.
- `hatch` seeds an opt-in `feed-sources.md`/`feed-categories.md`/`FEEDS.md` starter pack, registers feed routines and the monthly `source-scout` check, and adds the Feed Workflow block to the consumer `CLAUDE.md`.

### Upgrade Instructions
No manual steps. New plugin — run `/feed-hermit:hatch` in a project that already has the core hermit hatched.
