# Changelog

## [Unreleased]

### Fixed
- Domain brainstorm reports have a declared knowledge-schema type, avoiding schema drift findings.

### Upgrade Instructions
1. If `.hermit/knowledge-schema.md` exists and its `## Work Products` section has neither a `- domain-brainstorm:` nor a `- **domain-brainstorm**:` bullet, append the `domain-brainstorm` bullet from `${CLAUDE_PLUGIN_ROOT}/skills/hatch/SKILL.md` to that section. Otherwise skip. Preserve all existing content.

## [0.4.20] - 2026-10-07

### Changed
- Minimum Claude Code version is now 2.1.292, matching the one-step `claude plugin install --marketplace` install command.

## [0.4.19] - 2026-10-02

### Changed
- The plugin is named `hermitd-dev` in the `hermitd` marketplace, with namespaced skills and core commands updated to match.

## [0.4.18] - 2026-09-25

### Fixed
- `git-push-guard` no longer blocks commands where "git" and "push" only appear inside a file path or quoted argument (e.g. a proposal filename containing `git-push-guard`); it now requires an actual `git ... push` invocation.

## [0.4.17] - 2026-09-16

### Changed

- Core 1.4.0 is required for task records and resident startup.
- Development progress notes attach to the open task record for the current turn.

## [0.4.16] - 2026-09-14

### Removed
- `/dev-test`, `/dev-pr`, and `/dev-quality` skills and their scripts.
- Test-recording hook and cached test results.
- Standard/safety template mode split.
- `hatch_mode`, `commands`, `pr_base_branch`, and `pr_template_path` configuration keys.

### Changed
- Feature-branch pushes only when publishing is authorized, with PRs through the project's own workflow or forge CLI and the PR URL in the Progress Log.
- Mode-free hatch configures protected branches and hook profile, and offers Context7.

### Upgrade Instructions
- Core `hermit-evolve`'s sibling block sync re-syncs the dev instruction block. No manual block edits are needed.
- The `claude-code-dev-hermit.hatch_mode`, `claude-code-dev-hermit.commands`, `claude-code-dev-hermit.pr_base_branch`, and `claude-code-dev-hermit.pr_template_path` keys in `.claude-code-hermit/config.json` are inert and may be removed. `.claude-code-hermit/state/last-test.json` and `.claude-code-hermit/state/bindings.json` are also inert and may be removed.

## [0.4.15] - 2026-09-10

### Fixed
- `unknown keys "description" ... ignored` warning printed at every session start. `description` is not part of Claude Code's hook schema on a matcher group; the prose now lives in each hook script's header, with one legal root-level `description` in `hooks.json`.

## [0.4.14] - 2026-09-07

### Changed
- Resident duties are installed in RESIDENT.md while shared rules remain in the CLAUDE file.
- Native `/simplify` supplies the cleanup pass for `/dev-quality`, followed by the configured tests and a brief outcome summary.

### Upgrade Instructions

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/render-append.ts <mode> | .claude-code-hermit/bin/hermit-run domain-hatch sync-block claude-code-dev-hermit --rendered-stdin` from the project root to install the resident section in `.claude-code-hermit/RESIDENT.md`. Use the installed `standard` or `safety` mode for `<mode>`. Then restart with `.claude-code-hermit/bin/hermit-start --resume`.

Run `/claude-code-dev-hermit:hatch` to refresh the managed Dev instruction block. Preserve custom guidance outside that block. Replace `/claude-code-hermit:simplify` calls in operator-authored workflows with `/simplify`.

## [0.4.13] - 2026-09-06

### Changed
- The pre-code-change checklist in CLAUDE-APPEND no longer requires a clean working tree or a fresh branch before starting work: it now preserves unrelated changes, reuses the task's existing feature branch, and isolates new work in a worktree only when changes can't safely coexist. Commit and PR steps under §Before Archiving a Task are conditioned on the task actually authorizing them, instead of assumed.

### Upgrade Instructions

Run `/claude-code-dev-hermit:hatch` to re-render `CLAUDE-APPEND.md` with the updated checklist.

No `config.json` changes required.

## [0.4.12] - 2026-08-31

### Changed
- `hatch` is operator-invoked only through `disable-model-invocation`. If core is not initialized, it prints `/claude-code-hermit:hatch` for the operator to type instead of offering to run it.

## [0.4.11] - 2026-08-28

### Changed
- Hatch now offers only `context7` as a companion plugin (single yes/no); `feature-dev` is retired — Claude Code's native `Plan`/`Explore` agents cover the same research-and-planning ground. The standard-mode `§Implementation Flow` no longer suggests `/feature-dev:feature-dev` for unfamiliar code paths.

### Upgrade Instructions
- The CLAUDE.md dev block is re-synced by `hermit-evolve`'s existing block sync — nothing to do by hand. If `feature-dev` is installed and no longer wanted, core's own upgrade step (this release's `claude-code-hermit` CHANGELOG) offers to remove it alongside the other retired plugins.

## [0.4.10] - 2026-08-17

### Changed
- Dev session hygiene tracks multi-step work in the SHELL.md Progress Log instead of the native task tools, which Claude Code 2.1.233 withdrew on Opus 4.8, Sonnet 5, Fable 5 and newer.

### Upgrade Instructions

1. **Session-discipline block** — no manual edit. The `§Dev Session Hygiene` rule is replaced by the CLAUDE-APPEND block refresh that `hermit-evolve` performs for this plugin's block.

## [0.4.9] - 2026-08-14

### Fixed
- `git-push-guard`, `worktree-boundary-guard`, and `record-test-result` exited mid-stream on stdin past their 1MB cap, leaving the pipe half-read; they now stop buffering but keep consuming to EOF before failing open.
- `record-test-result` crashed with exit 1 on a valid-JSON payload that is not an object (`null`), instead of failing open.
- `worktree-boundary-guard` exited on `WORKTREE_GUARD=off` before reading stdin, so disabling the guard broke the pipe on any payload larger than the pipe buffer; the drain now runs before the switch is honored.
- All three hooks exited 1 on an unhandled stdin stream error; `main()` now catches and exits 0.
- `findHermitDir` honors `CLAUDE_PROJECT_DIR` (existence-checked against `.claude-code-hermit/config.json`, falling through to the walk when it doesn't name a hatched project). A session that had `cd`-ed out of the project dropped operator-configured `protected_branches` back to the built-in `main`/`master` list and skipped `last-test.json` writes.
- `findHermitDir` walks past a worktree's projected `.claude-code-hermit/` (the config.json sentinel with no `state/`) to the main checkout. Core now copies `config.json` into `claude --worktree` worktrees so `/dev-pr` Gate 0 can read `commands.pr_create`; without this, resolving to that copy would hand the guard an empty config and silently drop operator `protected_branches` in every worktree session. Update this plugin alongside a core that carries the copy.

## [0.4.8] - 2026-07-26

### Fixed
- `domain-brainstorm` no longer writes its own `brainstorm-emit` event — the call pointed at core's `append-metrics.ts`, unreachable from this plugin, so nothing was ever recorded. Proposals now carry `tags: [capability-brainstorm]` instead, counting toward the brainstorm kill-criteria segment rather than `reflect`'s.
- The `hatch` summary described `/dev-quality` as running code-review; it runs a cleanup pass and only suggests code-review.
- `hatch`'s CLAUDE-APPEND version gate said to "extract the stamped version from the existing block", but no template or renderer ever wrote a version into the block — the gate degenerated to marker-present-only, so a plugin version bump alone never refreshed an already-hatched install. It now reads the stamp from `_hermit_versions["claude-code-dev-hermit"]` in `config.json`, which `hatch` itself already writes on every run.

### Changed
- `hatch` reads the required core version from `.claude-plugin/hermit-meta.json` at runtime via `domain-hatch preflight`, instead of the `>=1.0.22` floor its prose carried as the worked example. The manifest is the only place the requirement is stated now, so it cannot drift from what the plugin actually needs.
- Target resolution and CLAUDE-APPEND writing are delegated to core: `domain-hatch preflight claude-code-dev-hermit` resolves the target, `ensure-target` records an operator override, and the mode-specific `render-append.ts` output is piped into `sync-block ... --rendered-stdin`. The skill no longer detects install scope, stamps `hatch-options.json`, or tracks `prior_hatch_mode` to decide on a replacement.
- Requires core `>=1.2.34`. Core absorbed its proposal satellites into `proposal.ts` verbs, so the shared route this plugin calls through `bin/hermit-run` is now `proposal metrics …`. `bin/hermit-run` resolves a script by bare filesystem probe, so pairing this version with an older core fails with a misleading "plugin may predate this command" error.
- The CLAUDE-APPEND template gained a closing marker (`<!-- /claude-code-dev-hermit: Development Workflow -->`), placed outside both mode regions so it survives both renderings. Lets core's `hermit-evolve` bound the block exactly instead of a heuristic that used to mistake the template's own `<!-- mode:standard-only -->` annotation for the block marker.
- `domain-brainstorm` reads core's proposal-metrics report via `.claude-code-hermit/bin/hermit-run` (a path relative to this plugin can't reach core's install), and a kill-criteria breach now escalates to the operator as a class-level signal instead of instructing the skill to self-retire (the shared segment can't attribute noise to one skill).
- §Tests Before PR folded into §Implementation Flow (both stated one ordering, and `dev-pr` Gate 0 enforces the test-freshness half mechanically), the slug algorithm and its worked examples became one naming line, and the harness built-ins left §Dev Quick Reference. Rendered standard block 9,330 B → ~6,158 B, safety 6,338 B → ~4,703 B. No git-safety rule was removed.
- The background-session recovery advice ("re-attempt the edit") moved out of §Git Safety into `worktree-boundary-guard`'s block message, where it appears at the moment it is actionable instead of in every session's context.

### Upgrade Instructions
- Re-run `/claude-code-dev-hermit:hatch` to refresh the CLAUDE-APPEND block. Core's `hermit-evolve` cannot sync this plugin's block on its own: the template carries `mode:` annotations that only this plugin's renderer can resolve, so evolve reports the refresh as deferred rather than writing raw template text.

## [0.4.7] - 2026-07-03

### Changed

- `CLAUDE-APPEND-SAFETY.md` is deleted; `CLAUDE-APPEND.md` carries mode markers and is rendered per mode by the new `scripts/render-append.ts` (both renderings byte-identical to the pre-collapse files, golden-tested). `/hatch` now captures the render script's stdout instead of picking a file. The render CLI writes to stdout and returns without an early `process.exit(0)`, so large renders can't be truncated at the pipe buffer.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Re-render the dev CLAUDE-APPEND block from the single source.** Read `claude-code-dev-hermit.hatch_mode` from `.claude-code-hermit/config.json` (default `standard`). Capture the stdout of `bun ${plugin_root}/scripts/render-append.ts <hatch_mode>`. In the operator's dev CLAUDE target file (`CLAUDE.md` or `CLAUDE.local.md` per `hatch-options.json` `target`), replace the block delimited by the `<!-- claude-code-dev-hermit: Development Workflow -->` marker with that rendered output. The rendering is byte-identical to the operator's existing block for their mode, so this is a no-op refresh — safety-mode operators see no visible change. If the marker is absent, leave the file untouched.

No `config.json` changes required.
### Fixed
- The guard now resolves the current branch via `git symbolic-ref` when a push carries no destination ref, closing the hole where a bare push to `main` slipped through (only explicit refspecs were checked before). Handles `git -C <path> push`; a bare push behind `cd … &&` remains a documented fail-open limit.
- Emit one stderr line on a `git push` when `AGENT_HOOK_PROFILE` is not `strict`, so a non-strict session no longer silently runs with the guard disabled.
- `-f` inside a short-flag cluster (e.g. `git push -fu origin feature`) now matches, closing a force-push bypass that the standalone `-f` check missed.

## [0.4.6] - 2026-06-29

### Added
- Adapted from mattpocock/skills (MIT); fills the gap between static code review (`feature-dev:code-reviewer`) and running actual repros. Reads `.claude-code-hermit/compiled/` for architectural context; drops diagnostic artifacts in `.claude-code-hermit/raw/`.
- Adapted from mattpocock/skills (MIT); unattended rebase/PR work had no conflict guardrail.

### Fixed
- `/debug` enables Claude Code session debug logging, not code diagnostics; listing it alongside `/code-review` and `/batch` was misleading.

## [0.4.5] - 2026-06-24

### Fixed
- Writes a state marker before delegating to core; core terminus invokes this skill via the Skill tool automatically. Removes the manual re-run. Requires `claude-code-hermit` ≥1.2.11.

## [0.4.4] - 2026-06-23

### Fixed

- Step 1 now prints the re-run instruction before invoking core as the terminal action, so the operator sees it. Removes the "then continue" assumption that silently dropped Step 2.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the dev hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated skill.

No `config.json` changes required.

## [0.4.3] - 2026-06-20

### Fixed

- §Git Safety in both templates appends a note to "Stay in your worktree": background dev agents should let the harness auto-isolate on first edit instead of proactively calling `EnterWorktree`, which fails in daemon-spawned pinned-cwd sessions.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update §Git Safety "Stay in your worktree" rule** — in `CLAUDE.local.md` (or `CLAUDE.md`), find the line ending with `The \`worktree-boundary-guard\` hook hard-blocks edits that escape the worktree.` and append: ` In a **background** session the harness moves you into a worktree automatically on your first edit, so don't proactively call \`EnterWorktree\`, and don't treat an "isolate first" message as a rule violation or a reason to stop and ask: just re-attempt the edit.`

No `config.json` changes required.

## [0.4.2] - 2026-06-16

### Changed

- §Technical Constraints in `CLAUDE-APPEND.md` and `CLAUDE-APPEND-SAFETY.md` no longer claims "subagents cannot invoke skills" (false). It now states the delegation contract: subagents can invoke skills and nest, but a delegated sub-step returns a verdict + optional `operator_message`, and the main session owns `AskUserQuestion` and operator notification. `/dev-quality` and the `HOW-TO-USE` parallel-work note keep their main-session rule without the false rationale.
- Aligns the dev-hermit install gate with core (core #389); the corrected CLAUDE-APPEND framing references nested-subagent dispatch, which requires it.

### Fixed

- The absolute "Never `git push`" rule made auto-mode agents refuse `/dev-pr`'s Gate 1 push; carve-out scopes the prohibition to ad-hoc pushes (#404).

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin** — run `claude plugin update claude-code-dev-hermit` to get the refreshed templates.
2. **Re-inject CLAUDE-APPEND** — run `/claude-code-dev-hermit:hatch` in any dev hermit project to re-inject the updated template with the carve-out.

No `config.json` changes required.

## [0.4.1] - 2026-06-13

### Fixed

- Short-form `/dev-quality` and `/dev-pr` in prose left the model with an ambiguous name; updated all occurrences in §Implementation Flow, §Tests Before PR, and §Dev Quick Reference to the namespaced form so injected templates are internally consistent.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin** — run `claude plugin update claude-code-dev-hermit` to get the refreshed CLAUDE-APPEND template.
2. **Re-inject CLAUDE-APPEND** — run `/claude-code-dev-hermit:hatch` in any dev hermit project to re-inject the updated template with the fully-qualified skill names.

No `config.json` changes required.

## [0.4.0] - 2026-06-12

### Changed

- Hooks.json command strings and the test runner invoke `bun`; `git-push-guard`, `worktree-boundary-guard`, `record-test-result` and all tests renamed `.js` → `.ts` (typed ESM, no build step). Bun >=1.3 requirement comes with the core plugin (core #18).
- Aligns `required_core_version`, `requires`, and `dependencies` with the bun-enabled core release.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin.** Run `claude plugin update claude-code-dev-hermit --scope local` (or the scope you used at install).
2. **Ensure bun is installed.** Run `bun --version` — if missing, install from https://bun.sh.

No `config.json` changes required.

**Note:** The core hermit plugin must be at v1.2.0+ for the bun runtime to be available.

## [0.3.14] - 2026-06-05

### Changed

- `Code-review@claude-plugins-official` is built into Claude Code since v2.1.150; removed it from hatch's companion picker and the `/dev-quality` install guard (#279).

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin.** Run `claude plugin update claude-code-dev-hermit --scope local` (or the scope you used at install).

No `config.json` changes required.

**Note:** If you have `code-review@claude-plugins-official` installed, it still works — the native `/code-review` is also available and no longer requires the companion plugin.

## [0.3.13] - 2026-06-04

### Fixed

- On a clean tree on a protected branch, point to §Branch Discipline instead of the generic nested-repo hint (#267).
- When `git push` fails with `cannot run ssh`, retry over HTTPS via the forge's git-credential helper instead of a generic FAIL. Covers GitHub (`gh`, #234) and GitLab (`glab`, #246); other forges get a tailored message naming the manual recovery path. Makes `/dev-pr` work in Docker hermit containers without an `ssh` binary.
- Aligns `required_core_version`, `requires`, and `dependencies` with the latest core release.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the plugin.** Run `claude plugin update claude-code-dev-hermit --scope local` (or the scope you used at install).

No `config.json` changes required.

## [0.3.12] - 2026-06-01

### Added

- On-demand codebase friction brainstorm. Reads git churn, last test signal (`state/last-test.json`), manifest↔lockfile drift, and README coverage to emit at most 2 `[prefix]`-tagged improvement PROPs per invocation. Operator-invoked only; per-skill kill criteria (cut if triage-survival < 25% or PROP-acceptance < 30% after ≥8 runs).

### Changed

- README and HOW-TO-USE corrected from `--scope project` (now invalid in recent Claude Code releases).
- `CLAUDE-APPEND.md` and `CLAUDE-APPEND-SAFETY.md` note that condition (1) of the three-condition gate is waived for ideas surfaced by `/claude-code-dev-hermit:domain-brainstorm`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the CLAUDE-APPEND block.** Re-run `/claude-code-dev-hermit:hatch` in each target project (or `/claude-code-hermit:hermit-evolve` which sibling-syncs all hermit plugin blocks). The updated template adds the single-pass exception to `§Dev Proposal Categories`.

No `config.json` changes required.

## [0.3.11] - 2026-05-31

### Added

- When a session runs in a linked git worktree, blocks `Edit`/`Write` whose target escapes into the main checkout. Self-limiting (inert outside worktrees, so no profile gate); carve-out for shared `.claude-code-hermit/` state; disable with `WORKTREE_GUARD=off`.

### Changed

- Aligns `required_core_version`, `requires`, and `dependencies` with the latest core release.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the CLAUDE-APPEND block.** Re-run `/claude-code-dev-hermit:hatch` in each target project (or `/claude-code-hermit:hermit-evolve` which sibling-syncs all hermit plugin blocks). The updated template includes the worktree boundary rules in §Git Safety.

No `config.json` changes required.

## [0.3.10] - 2026-05-23

### Changed

- Requires core v1.1.2+. Reframes from bug-finding to cleanup; skill applies its own edits and reports a totals line. Gate 0 extended to accept untracked-only trees via `git status --porcelain`. Docs and state-templates realigned.

### Upgrade Instructions

1. **Refresh the CLAUDE-APPEND block.** Re-run `/claude-code-dev-hermit:hatch` in each target project (or `/claude-code-hermit:hermit-evolve` which sibling-syncs all hermit plugin blocks). The injected `§Implementation Flow`, `§Tests Before PR`, `§Technical Constraints`, and `§Dev Quick Reference` sections previously named `/code-review` as the wrapped skill; the canonical template now names `/claude-code-hermit:simplify`.

2. **Bump core hermit alongside this release.** Existing dev-hermit installs do not auto-update their core dependency on `/plugin update`. Operators on dev-hermit 0.3.10+ must also run `/plugin update claude-code-hermit` to land core 1.1.2+ which ships `/claude-code-hermit:simplify`. Without the core bump, `/dev-quality` Gate 1 will fail at the simplify invocation.

## [0.3.9] - 2026-05-21

### Fixed

- When core migrated to `CLAUDE.local.md`, the dev-hermit block remained in `CLAUDE.md` and a second was appended, producing duplicates. Upgrade Instructions run a one-shot migration to remove the stray block.

### Changed

- Reads `hatch-options.json` to write to `CLAUDE.local.md` or `CLAUDE.md`. Falls back to `claude plugin list --json` scope detection when core hatch hasn't run yet. Stamps 5-field schema on first run.
- Captures `prior_hatch_mode` before Step 5 overwrites it; Upgrade Step 3 is now fully unattended. Test coverage extended with 15 structural-lint assertions.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill executes the following steps automatically (via Step 7's sibling upgrade flow, which runs every plugin's `### Upgrade Instructions` before its CLAUDE-APPEND sync). The migration is unattended — no operator prompts. `hermit-evolve` Step 7 re-syncs the canonical block to `hatch_target` afterwards.

1. **Resolve `hatch_target`.** Use the same fallback chain `hermit-evolve` Step 2a uses, substituting the dev marker: read `.claude-code-hermit/state/hatch-options.json` and use the `"target"` field; else check `CLAUDE.local.md` for `<!-- claude-code-dev-hermit: Development Workflow -->` → `hatch_target = "local"`; else check `CLAUDE.md` for the same marker → `hatch_target = "committed"`; else stop — the dev block is in neither file, nothing to migrate.

2. **Identify the non-target file.** `non_target = (hatch_target == "local") ? "CLAUDE.md" : "CLAUDE.local.md"`.

3. **If the marker is present in `non_target`, silently strip the marked block.** Per `/hatch`'s single-source-of-truth contract, the CLAUDE-APPEND template is authoritative and operator overrides belong outside the marked block, so no hand-edit preservation is needed. Step 7's sync re-appends the canonical block to `hatch_target` afterwards.

4. **If the marker is only in `hatch_target`:** no-op. Steady state — Step 7's normal sync handles routine version-bump replacement.

No `config.json` changes required.

## [0.3.8] - 2026-05-21

### Changed

- All runtime invocations, state templates, and docs updated. `min_claude_code_version: ">=2.1.146"` added to `hermit-meta.json`. Requires Claude Code 2.1.146+.
- Fixes missed `simplify` ref in `WORKFLOW.md`; re-pads output block labels to 13-col width; disambiguates marketplace vs built-in `/code-review` in docs where both appear.
- Reads `hatch-options.json` to write to `CLAUDE.local.md` or `CLAUDE.md`; prompts for Visibility on first run and stamps the file.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update Claude Code** to version 2.1.146 or newer — `/code-review` is a built-in available from that version.
2. **Refresh the CLAUDE-APPEND block** — re-run `/claude-code-dev-hermit:hatch` in each target project to pick up the updated `/code-review` references and the target-aware routing fix.

No `config.json` changes required.

## [0.3.7] - 2026-05-16

### Changed

- Ends the "Never git push" rule with a pointer to `/claude-code-dev-hermit:dev-pr`; softens "The operator pushes" to "Stop and ask."
- Aligns `required_core_version`, `requires`, and `dependencies` with the latest core release.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the CLAUDE-APPEND block** — re-run `/claude-code-dev-hermit:hatch` in each target project to pick up the updated §Git Safety rule in the injected CLAUDE.md block.

No `config.json` changes required.

## [0.3.6] - 2026-05-13

### Changed

- `Git-push-guard` + CLAUDE-APPEND template are now the headline product; workflow skills (`/dev-pr`, `/dev-quality`, `/dev-test`) moved to "Optional workflow scaffolding." `/hatch` default flipped to `safety` for greenfield projects.
- Converted `git-push-guard` and `record-test-result` to exec form. Aligns with core's exec-form sweep. Fixes path-with-spaces fragility on installs whose plugin dir contains a space.
- Aligns `required_core_version`, `requires`, and `dependencies` with the latest core release.

### Fixed

- `Git push origin feature/main` was blocked because `/` was not treated as a word boundary. Guard now extracts the destination ref per refspec and uses exact-match regexes for non-glob patterns.
- Both previously claimed it was blocked unconditionally; code has allowed it on non-protected branches with an explicit refspec since v0.3.0.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update Claude Code** to version 2.1.139 or newer before pulling this release — the exec hook form requires it.
2. **Refresh hooks** — the updated `hooks.json` exec-form entries are installed on plugin update.

No `config.json` changes required.

## [0.3.5] - 2026-05-07

### Removed

- Strict profile unconditionally blocked all commits; standard profile duplicated CLAUDE-APPEND guidance. PR-time enforcement via `/dev-pr` Gate 0 SHA check is unchanged. Resolves [#39](https://github.com/gtapps/claude-code-hermit/issues/39).

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh hook registration** — the removed hook is deregistered automatically on plugin update.

No `config.json` changes required.

## [0.3.4] - 2026-05-07

### Added

- Standard profile injects an `additionalContext` reminder; strict profile hard-blocks the commit (exit 2). Tokenizer parses `git -C <path> commit` and avoids false positives. Resolves [#30](https://github.com/gtapps/claude-code-hermit/issues/30).
- Scopes git ops, test runner, `/simplify`, and PR creation to a nested working tree (submodule, path workspace). Hermit state still lives under the parent's `.claude-code-hermit/`. Resolves [#32](https://github.com/gtapps/claude-code-hermit/issues/32).
- Validates path is a git tree, spawns test command from `<path>`, captures child HEAD SHA. PostToolUse hook entry-point unchanged.

### Changed

- Aligns `required_core_version`, `requires`, and `dependencies` with the upcoming core release.
- Adds a `hint:` line pointing operators at `--cwd <path>` for nested-repo workflows. Hint suppressed when `--cwd` was already passed.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill picks up the new hook and skill prose automatically via plugin update — no `config.json` changes and no `/hatch` re-run required.

## [0.3.3] - 2026-05-03

### Added

- Classifies signal exits: `137` → `"oom"`, `124` → `"timeout"`, `130` → `"user-interrupt"`. Surfaced in `/dev-pr` Gate 0 and `/dev-quality` Gate 2 failure messages.
- Emits the correct ordering (`/dev-quality → commit → /dev-pr`) and points to `/dev-test` for post-commit verification.
- Detects common base branches from remote during capability scan. Writes `pr_base_branch` automatically when one candidate is found; prompts when multiple are detected.

### Changed

- Appends a `session-close` pointer after a successful PR create to reduce stale-session heartbeat alerts.
- `Pr_base_branch` added to the list of keys not written in safety mode (these feed `/dev-pr` which is not prescribed in that mode).
- Adds an "intentionally empty" Docker domains/LAN block explaining why the plugin cannot pre-declare DNS allowlist entries.
- Was `>=1.0.22` / `^1.0.22`. `required_core_version` + `requires` (in `hermit-meta.json`) and `dependencies[0].version` (in `plugin.json`) all bumped together. Updated `CLAUDE.md`, `CONTRIBUTING.md`, `docs/HOW-TO-USE.md`.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh skill files** — picks up updated `/dev-pr`, `/dev-quality`, and `/hatch` behavior.

No `config.json` changes required.

## [0.3.2] - 2026-04-29

### Added

- `"safety"` | `"standard"`. Persists the operator's hatch mode across re-runs for CLAUDE-APPEND template selection.
- New safety-mode template: §Git Safety, §Branch Discipline, §Technical Constraints, §Dev Knowledge, §Dev Proposal Categories, trimmed §Dev Quick Reference. Excludes §Implementation Flow, §Tests Before PR, and workflow skill references.

### Changed

- Added to §Branch Discipline, §Implementation Flow, §Tests Before PR to avoid overriding existing commit/PR/release skills.
- Scans `.claude/skills/` for existing commit/PR/release skills; defaults mode prompt to `safety` if found, `standard` otherwise.
- Safety mode skips workflow-key prompts (`commands.test`, `lint`, `format`, `pr_create`, `pr_template_path`); standard mode unchanged.
- Injects `CLAUDE-APPEND-SAFETY.md` in safety mode, `CLAUDE-APPEND.md` in standard mode.

### Fixed

- `RunRaw` resolved the guard's CWD to the monorepo root, which has a config listing only `main`, overriding the `["main","master"]` default. Fixed by spawning tests in a fresh tmpdir with no hermit config.

### Upgrade Instructions

1. Ask the operator (`AskUserQuestion`): "Does this project already have its own `/commit`, `/create-pr`, or `/release` skills? Choose `safety` to keep dev-hermit's workflow sections out of CLAUDE.md, or `standard` for the full workflow (recommended for greenfield projects)." Options: `safety` / `standard`.
2. Write the chosen value to `.claude-code-hermit/config.json` under `claude-code-dev-hermit.hatch_mode`.
3. Tell the operator: "After this evolve completes, re-run `/claude-code-dev-hermit:hatch` to refresh your CLAUDE.md with the chosen mode. (hermit-evolve's CLAUDE-APPEND sync writes the standard template at the end of this run — that's expected; one `/hatch` re-run resolves it.)"

## [0.3.1] - 2026-04-29

### Added

- Runs the configured test suite and records the result to `last-test.json`. Useful for mid-task verification and warming the `/dev-pr` cache.
- Re-introduced in leaner form: runs `/simplify` on the working-tree diff and re-runs `commands.test`. Surfaces failures; suggests `code-review:code-review` to the operator when installed (never invokes it autonomously).

### Changed

- Runs `record-test-result.js run` instead of blocking; fresh `status:"pass"` at current HEAD is a cache hit. Fixes #12.
- `Run` executes `commands.test` and records exit code + duration; `write` is for direct callers and CI. Silently skips on missing exit code; skips interrupted runs.
- Calls `record-test-result.js run` so the result is cached (SHA is pre-commit; `/dev-pr` re-runs after commit).
- Operators must re-run `/hatch` to refresh.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Re-run `/claude-code-dev-hermit:hatch`** in each project using this plugin to refresh the injected `CLAUDE.md` with the updated §Implementation Flow and §Tests Before PR sections.

No `config.json` changes required.

## [0.3.0] - 2026-04-28

**v0.3.0 — language-agnostic safety layer.** Dropped ~6,000 lines (~70%) to reframe dev-hermit as a thin safety layer. Now ships 2 skills (`hatch`, `dev-pr`), 1 hook (`git-push-guard`), and a CLAUDE-APPEND template. Implementer agent removed — operators use the native `Agent` tool or `feature-dev` agents governed by the injected rules.

### Changed

- New §Git Safety, §Branch Discipline, §Implementation Flow, §Tests Before PR sections. Dropped Dev Agent table, 7-step workflow, Local Dev Environment, Watchdog, Always-on Worktree Topology.
- Subsumes `/dev-adapt` wizard prompts; idempotent; defaults to strict push-guard profile with explicit opt-out; detects GitLab vs GitHub for `commands.pr_create`.
- Inline LLM body assembly replaces 240-line template-merge engine; dropped `--force` flag, alert-check gate, and `check-protected-branch.js` shell-out (replaced with inline bash glob).
- Tokenizer replaced with regex chains; inlined `loadProtectedBranches`; walks up from cwd to find `.claude-code-hermit/`. `--force-with-lease` to non-protected branches with explicit refspec now allowed.
- `CLAUDE.md`, `README.md`, `HOW-TO-USE.md`, `WORKFLOW.md` rewritten; `GIT-SAFETY.md`, `RECOMMENDED-PLUGINS.md` trimmed.

### Removed

- Implementer agent (`agents/` directory) — safety rules now live in CLAUDE-APPEND; operators switch to native `Agent` or `feature-dev`. `hermit-evolve` surfaces this on next run.
- Skills : `dev-branch`, `dev-quality`, `dev-cleanup`, `dev-doctor`, `dev-adapt` (folded into `hatch`), `dev-up`, `dev-down`, `dev-log-watch`, `dev-status` — all removed; rules moved to CLAUDE-APPEND or left to operators.
- Scripts : watchdog pipeline (`watchdog-health.js`, `watchdog-errors.js`, `check-protected-branch.js`, ~1,370 lines) — Monitor's stderr-on-exit covers the use case.
- `Scripts/lib/` : entire directory (~1,300 lines) — helpers inlined into `git-push-guard.js` and `/dev-pr` prose; thin wrappers removed.
- Tests : 10 test files whose subjects were deleted; 55 tests survive (9 structural lints + 46 push-guard cases).
- Docs : `docs/DEV-LOG-WATCH.md` removed; §Dev Agent table, §Watchdog, §Always-on Worktree Topology in CLAUDE.md replaced by safety rules on `hermit-evolve`.

### Migration (operators upgrading from v0.2.x)

- Calls with `subagent_type: implementer` fall back to general-purpose; use native `Agent` or `feature-dev:code-architect` / `code-explorer`.
- Inert but removable config keys include `dev_health_url`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_watchdog.*`, `commands.dev_start/stop`, `dev_port_agent`, `dev_required_ports`, `dev_auth_check`, `dev_expected_listeners`, `pr_title_format`, and `pr_body_sections`. Workflow keys such as `commands.test`, `lint`, `format`, `pr_create`, and `protected_branches` remain.
- Removed skills such as `/dev-up`, `/dev-down`, and `/dev-status` now return "skill not found"; use `tmux` or `Bash run_in_background` for dev servers, while agents run test-then-simplify through `CLAUDE-APPEND`.
- `required_core_version` remains `>=1.0.22`.

### Upgrade Instructions

Executed by `/claude-code-hermit:hermit-evolve` Step 2b in oldest-first order. v0.3.0 is a breaking redesign — surface every change loudly to the operator before letting the upgrade complete.

1. **Announce the redesign.** Tell the operator: "claude-code-dev-hermit v0.3.0 is a breaking redesign — the plugin dropped ~70% of its surface to become a language-agnostic safety layer. The CLAUDE.md dev block, the implementer agent, and many skills are gone. Read the v0.3.0 CHANGELOG entry below before continuing." Show the `### Removed`, `### Changed`, and `### Migration` sections from this CHANGELOG entry.
2. **Re-run `/claude-code-dev-hermit:hatch`.** The plugin's CLAUDE-APPEND template is a full rewrite, so the marker block in the project's CLAUDE.md will be silently replaced by `hermit-evolve` Step 5 — but `/hatch` is what writes the new operator-facing config keys (`commands.test`, `commands.lint`, etc.) and installs the `git-push-guard` hook at strict profile. Ask the operator: "Re-run `/claude-code-dev-hermit:hatch` now? (Recommended — captures the new config keys and confirms strict hook profile.)" `Yes — run now` / `No — I'll do it later`. If yes, invoke `/claude-code-dev-hermit:hatch`.
3. **Surface the implementer-agent removal.** If `.claude/settings.json` (project or user scope), `OPERATOR.md`, any file under `.claude-code-hermit/sessions/`, or any project doc references `subagent_type: implementer` or `claude-code-dev-hermit:implementer`, list the files to the operator with the message: "These files reference the removed implementer agent. Switch to the native `Agent` tool or `feature-dev:code-architect` / `code-explorer` for planning. The native `Agent` tool reads CLAUDE.md (including the new dev-hermit safety rules) and follows them; you don't need a custom subagent for the safety layer." Use `grep -rln "implementer" <paths>` to detect.
4. **Inert config keys (advisory).** Read the operator's `.claude-code-hermit/config.json` and check for any of these keys under `claude-code-dev-hermit.`: `dev_health_url`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_watchdog`, `commands.dev_start`, `commands.dev_stop`, `dev_port_agent`, `dev_required_ports`, `dev_auth_check`, `dev_expected_listeners`, `pr_title_format`, `pr_body_sections`. If any exist, tell the operator: "These keys are inert in v0.3.0 (harmless but unused). Remove at your convenience: <list>." Do NOT remove them automatically — operators may want to keep them as documentation.
5. **Force-with-lease policy change.** Tell the operator: "v0.3.0 changes the `git-push-guard` policy: bare `--force` and `-f` are still blocked, but `--force-with-lease` to a non-protected branch with an explicit refspec is now ALLOWED (the safe rebase-recovery case). `--force-with-lease` to protected branches and ambiguous-target leases remain blocked. See docs/GIT-SAFETY.md."
6. **Test-result recording is now automatic.** Tell the operator: "v0.3.0 ships a new `PostToolUse` hook (`record-test-result.js`) that captures the configured test command's exit code and HEAD sha into `.claude-code-hermit/state/last-test.json` whenever you run it. `/dev-pr` now refuses if no recent passing test result exists for the current HEAD. If `commands.test` was not configured by `/hatch` in step 2, configure it now or `/dev-pr` will refuse with 'no test result recorded'."

## [0.2.3] - 2026-04-28

### Added

- Shared protected-branch helpers (load, normalize, glob-match, isProtected) extracted from `git-push-guard.js`.
- CLI wrapper; exit 0 = not protected, exit 1 = protected. Used by implementer, `/dev-branch`, `/dev-cleanup`, and `/dev-pr` gates.
- Structural lint for `agents/*.md`: frontmatter, `isolation: worktree` absence, Step 0a/0b refusal language.
- Shared `parseFrontmatter` helper used by both structural test files.

### Changed

- Removed `isolation: worktree`; caller must run `/dev-branch` first and pass its `Worktree:` token verbatim. Step 0a/0b gates refuse on missing token or protected branch.
- Gate 6 creates the worktree and emits `Worktree:`/`Branch:` tokens; Gate 0 short-circuits when already on a feature branch. Gate 4b adds slug-path guard.
- Checks `git worktree list` for a managed worktree before branch deletion; removes it non-force first.
- Replaced inline glob-match with `check-protected-branch.js` shell-out.
- `Worktree:` token must be copied verbatim; worktree cleanup delegated to `/dev-cleanup`.
- Destructures `{ branches }` from the new return shape.

### Fixed

- Unquoted `Worktree:`/`Branch:` colons caused YAML parser to silently drop all frontmatter fields; both descriptions are now quoted strings.
- `ExecSync` resolved the script path against the caller's CWD; now sets `cwd` to plugin root so the test passes from repo root.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Copy** `scripts/lib/protected-branches.js` and `scripts/check-protected-branch.js` into the hermit's scripts directory.
2. **Refresh** `agents/implementer.md` from the updated plugin (replaces the prior `isolation: worktree` agent).
3. **Refresh** `skills/dev-branch/SKILL.md`, `skills/dev-cleanup/SKILL.md`, and `skills/dev-pr/SKILL.md` from the updated plugin.
4. **Refresh** `scripts/git-push-guard.js` so it imports the new shared helpers.
5. **Append** the updated implementer-caller-contract section from `state-templates/CLAUDE-APPEND.md` to the hermit's `CLAUDE.md`.

No `config.json` changes required.

**Note:** Callers that previously invoked the implementer directly must now run `/dev-branch` first and copy its `Worktree:` line verbatim into the implementer's prompt. The implementer refuses without that token.

## [0.2.2] - 2026-04-28

### Added

- Opens a PR from the current feature branch with assembled title + body. Gates: protected-branch, clean tree, commits-ahead, fresh quality report, no unresolved alerts. Writes PR URL to `state/bindings.json`.
- `Watchdog-health.js` polls `dev_health_url`; `watchdog-errors.js` tails the dev-server log and emits alerts on error spikes. Registered by `/dev-up` Gate 5b in always-on mode.
- Atomic `state/alerts.json` helpers with MAX_ALERTS=50 pruning and deduplication. Shared by both watchdog processes and `/dev-status`.
- Pure function assembling PR title + body from commits, quality report, binding, screenshots, and project template.

### Changed

- When `$HERMIT_AGENT_WORKTREE` is set, Monitor pipeline runs from the worktree so the server runs on the agent's branch. `cd` failure emits a `[dev-up] Fatal:` sentinel.
- Registers `dev-watchdog-health` and `dev-watchdog-errors` after server start in always-on mode; both shut down on `/dev-down`.
- When `$HERMIT_AGENT_WORKTREE` is set, resolves the port from `dev_port_agent` instead of `dev_required_ports[0]`, so the agent's server doesn't collide with the operator's.
- Reads `.github/PULL_REQUEST_TEMPLATE.md` / `docs/pull_request_template.md` during discovery; detects `.gitlab-ci.yml` and sets `commands.pr_create` default for GitLab remotes.
- Surface watchdog alerts in status output; `/dev-down` shuts down watchdog entries.
- `/dev-pr` usage rules and watchdog alert acknowledgement flow added.
- Replaced hardcoded cron times with a pointer to `config.json → routines[]` so the context stays in sync with config.
- Worktree cwd support depends on `$HERMIT_AGENT_WORKTREE` set by hermit-start.py v1.0.22.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** all `skills/dev-*.md` files from the updated plugin.
2. **Copy** `scripts/lib/alerts-store.js`, `scripts/watchdog-health.js`, `scripts/watchdog-errors.js`, and `scripts/lib/pr-body-builder.js` into the hermit's scripts directory.
3. **Append** the `/dev-pr` usage rules and watchdog alert acknowledgement section to the hermit's `CLAUDE.md` (from `state-templates/CLAUDE-APPEND.md`).

No `config.json` changes required.

**Note:** Two new optional config keys: `dev_port_agent` (integer, port for the agent-worktree dev server) and `dev_watchdog` (object with `enabled`, `log_error_alert_threshold`, `poll_interval_ms`). Watchdog is enabled by default when `dev_health_url` is set.

### Internal

- Watchdog scripts now live in `scripts/`, `tests/run-all.sh` is the central runner, and `skill-structure.test.js` lives in `tests/`. Empty `.claude/` and personal `.vscode/` artifacts were removed, and CONTRIBUTING now requires `scripts/lib/` to remain pure.
- Prerequisite references now require `v1.0.22+`; redundant `docs/SKILLS.md` was removed, the `dev-pr` skill list was refreshed, and CONTRIBUTING documents the current project structure and test runner.

## [0.2.1] - 2026-04-27

### Fixed

- Gate 5 wraps dev start in a `tee | grep --line-buffered` pipeline; Monitor receives only error-matched lines. Full stdout is preserved in `state/dev-server.log`; override pattern via `dev_error_pattern`.

### Added

- Builds the Monitor pipeline for `/dev-up` Gate 5; handles shell-escaping via `shellQuote` and ships the anchored default error regex. 18 tests cover validation, escaping, and runtime behavior.

### Changed

- Dropped `local:dev` from the `package.json#scripts` priority list; swapped worked-example output to `npm run dev` / `direnv status`. Detection logic unchanged.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh** `skills/dev-up/SKILL.md` from the plugin.

No `config.json` changes required.

**Note:** `/dev-up` now writes full dev-server stdout to `.claude-code-hermit/state/dev-server.log` each session (truncated at each boot). Only error-matched lines appear as Monitor notifications. To tune the error pattern, set `claude-code-dev-hermit.dev_error_pattern` in `.claude-code-hermit/config.json`.

## [0.2.0] - 2026-04-27

### Added

- Feature-branch creation gate. 8 checks: prerequisites, clean tree, fetch, base resolve, worktree/name collision, checkout from `origin/<base>`.
- Boot a session-scoped dev server in a Monitor entry; gated on ports, optional auth probe, optional HTTP health-poll until 2xx.
- Stop the dev-server Monitor entry; runs `commands.dev_stop` if configured, else SIGTERM-drain-SIGKILL via `/watch`.
- Generator emitting a Monitor entry that tails the dev log; rotating-vs-fixed pattern detection per stack.
- Three-line read-only status: branch, dev-server, worktree refs. Fail-soft per section, no setup required.
- `Resolve-command`, `port-check`, `health-poll`, `log-watch-builder`, `shell-utils`, each with a co-located `.test.js`.
- Recipe for tailing rotating dev logs into a `/watch` monitor. Cross-linked from `/dev-log-watch`.

### Changed

- Missing/empty `protected_branches` now hard-fails; required by `/dev-branch` base resolution.
- Env-leakage scan flags credential-like keys in auto-loaded `.env*` files; framework-public prefixes excluded.
- `Commands.dev_start` reachable; `dev_log_path_pattern` parent exists; `dev_required_ports` range and `dev_expected_listeners ⊆ dev_required_ports`.
- Same behaviour as before; single source of truth shared with check #15.
- New "Dev environment" proposal block detects `commands.dev_start`, ports, health URL, auth, log pattern. Skipped on mobile/desktop/library projects.
- Main session runs `/dev-branch` first when on a protected branch.
- Frames `/dev-up`/`/dev-down`/`/dev-log-watch` as operator-invoked, session-scoped (Monitor stops at `/session-close`).
- Backfilled `dev-adapt`/`dev-branch`/`dev-doctor`; added `dev-up`/`dev-down`/`dev-log-watch`/`dev-status`.
- Discoverable post-install. README "How It Works" Implement step names `/dev-branch` explicitly; lifecycle-skills preamble added.
- Enables Claude Code's native resolver to auto-install core; `required_core_version` and `requires` stay `>=` for runtime gating.
- Move hermit-internal fields to `hermit-meta.json` sidecar. `required_core_version` and `requires` removed from `plugin.json` so `claude plugin tag --push` passes the native validator cleanly.
- Required by `claude plugin tag` and the dep resolver. Updated `docs/HOW-TO-USE.md`, `CONTRIBUTING.md`.
- Root `/release claude-code-dev-hermit` covers the full validation suite; per-plugin skill was a lower-fidelity duplicate.
- Was `>=1.0.18`; bumped in `hermit-meta.json`, `plugin.json`, README, CLAUDE.md, and CONTRIBUTING.md together.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Run `/claude-code-dev-hermit:dev-adapt`** to populate `protected_branches` (now FAIL if missing) and the new `dev_*` config block.
2. **Refresh `state-templates/CLAUDE-APPEND.md`** so projects pick up the `/dev-branch` Implement step and the Local Dev Environment subsection.

**Note:** `/dev-up`, `/dev-down`, `/dev-log-watch`, and `/dev-status` ship enabled but the new `dev_*` keys are individually optional — configs without them are unaffected, and the lifecycle skills refuse cleanly when their fields are unset. `dev-doctor` check count: 13 → 17.

`config.json` schema additions (all under `claude-code-dev-hermit.*`, all optional): `commands.dev_start`, `commands.dev_stop`, `dev_required_ports`, `dev_expected_listeners`, `dev_health_url`, `dev_health_timeout_secs`, `dev_auth_check`, `dev_log_path_pattern`, `dev_error_pattern`, `dev_noise_pattern`. `commands.dev_start` is the minimum for `/dev-up`.

## [0.1.9] - 2026-04-27

### Changed

- Plugin source moved into `plugins/claude-code-dev-hermit/`; `required_core_version` reconciled to semver-range form; inner `marketplace.json` removed; README links updated.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No operator action required — internal manifest cleanup only.

No `config.json` changes required.

## [0.1.8] - 2026-04-24

### Changed
- Adapts to the `/doctor` → `/hermit-doctor` rename in claude-code-hermit v1.0.18; `dev-doctor` manual mode composition and the hatch prereq gate are updated accordingly.

### Added
- End-to-end task lifecycle reference (what fires, in what order, what state it writes); linked from README Documentation.

---

## [0.1.7] - 2026-04-24

### Added
- `create-pr` skill — push, draft title/body, open PR via `gh`
- `dev-doctor` skill — manual + scheduled modes, composes core validators
- `dev-adapt` skill — project profiling, config persistence, compiled artifact
- Implementer stop conditions + config-driven test command
- Config-driven `git-push-guard` with tokenizer parser + propagate protected branches

### Fixed
- Hardened implementer worktree isolation — branch-handoff, safety rails, `.worktreeinclude`
- Implementer handoff, dev-quality bugs, commit-format detection

### Changed
- Rewrote `/dev-quality` — deterministic commands, surgical undo, judgment risk assessment
- Namespaced dev-hermit config keys under `claude-code-dev-hermit`

---

## [0.1.6] - 2026-04-22

### Changed

- Non-obvious load-bearing choices must include a `Rejected alternatives:` sub-bullet; caller-provided architectures (e.g. from `feature-dev`) treated as hard constraints.
- CLAUDE-APPEND step 3 instructs the main session to run implementer tests before overriding a non-obvious choice; trace before replacing if no tests exist.
- Step 4 now specifies `/dev-quality` as the end-of-task gate; direct `/simplify` reserved for mid-task cleanup and post-`/batch` follow-up.
- New optional step suggests `/feature-dev:feature-dev` when the task touches unfamiliar code paths (trigger: unfamiliarity, not urgency).
- `/simplify` already covers reuse/quality/efficiency review; pass is now tests → `/simplify` → tests. `code-review` plugin remains an optional companion.
- No longer in any default code path; `docker.recommended_plugins` still records it when selected.

---

## [0.1.5] - 2026-04-22

### Changed

- Requires `claude-code-hermit` v1.0.16+ to guarantee the `scheduled-checks` routine is present.

---

## [0.1.4] - 2026-04-22

### Changed

- Reflects the `scheduled_checks` rename and other protocol changes in core.
- Five references updated; `RECOMMENDED-PLUGINS.md` and `CLAUDE.md` updated likewise.
- `< 1.0.12` version guard redundant now that floor is v1.0.15; cleanup routine question shown unconditionally.
- Added to "Other core skills" block.
- Reflect note now lists structured suppression codes (`no-evidence`, `weak-recurrence`, etc.).
- Dev Knowledge section points at `knowledge-schema.md` if present.
- Validation now runs between file updates and commit.
- Added `author`, `license`, `homepage`, `repository`, `keywords` fields.

---

## [0.1.3] - 2026-04-21

### Changed

- `Dev-` prefix redundant given the plugin namespace. Invoke as `/claude-code-dev-hermit:hatch`.

---

## [0.1.2] - 2026-04-20

### Added

- Phase 3 wizard now offers an optional weekly branch cleanup routine (`0 10 * * 1`); requires hermit v1.0.12+. Routine is written to `config.json` and registered via `hermit-routines load` immediately.
- "Other core skills" section now surfaces `/claude-code-hermit:hermit-routines` for managing the reflect routine and dev-cleanup.

### Changed

- Step 6 (task boundary) now notes that reflect runs as a daily routine and that `newborn`-phase hermits (<3 days) produce fewer proposals — expected behaviour, not a gap.
- Added entry with schedule details (reflect 9am daily, dev-cleanup weekly if enabled).

### Fixed

- Stray closing `}` removed.

---

## [0.1.1] - 2026-04-15

### Fixed

- Bare names replaced with canonical forms (`claude-code-dev-hermit:implementer`, `/claude-code-dev-hermit:dev-quality`, `code-review:code-review`) in all skill and template files.

## [0.1.0] - 2026-04-15

Initial public release.
