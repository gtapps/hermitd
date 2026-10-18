---
<!-- hermitd-dev: Development Workflow -->

## Git Safety (always applies)

These rules apply to every agent doing dev work in this project — the native `Agent` tool, custom subagents, the main session. The `git-push-guard` hook backs them at strict profile.

- **Push only feature branches, and only when publishing is authorized.** Open PRs through the project's own workflow or the forge CLI. Never push to a branch in `hermitd-dev.protected_branches` (hook-enforced at strict profile).
- **Never use `--no-verify`** on any git command (commit, push, merge, rebase). Pre-commit hooks exist for a reason.
- **Never commit to a branch in `hermitd-dev.protected_branches`** (defaults to `main`/`master` if unset). Always work on a feature branch.
- **Never force-push from agent context.** No bare `--force` or `-f`. `--force-with-lease` is allowed only to a non-protected branch with an explicit refspec (the safe rebase-recovery case); ambiguous-target leases and leases to protected branches are blocked. When in doubt, surface the divergence and let the operator resolve.
- **Stay in your worktree.** When the session runs in a git worktree, never edit files in the original checkout or a sibling worktree — that's another session's territory. The `worktree-boundary-guard` hook hard-blocks edits that escape the worktree.

If a task would require violating these rules, stop and ask the operator. Do not attempt workarounds (alternate commands, env vars, manual git plumbing).

## Branch Discipline

If the project's own CLAUDE.md or skills define a branch-naming convention (e.g. `<short-slug>/vX.Y.Z` for plugin releases, ticket-prefixed branches, or anything else), follow that. The rules below are the fallback for projects without one.

Before starting code changes:

1. Inspect `git status --porcelain` and preserve unrelated changes. Reuse the task's existing feature branch, or isolate new work in a worktree when changes cannot safely coexist. Ask only when ownership or separation is unclear.
2. If a new branch is needed, branch from the first entry of `hermitd-dev.protected_branches` (defaults to `main`), using the fetched `origin/<base>`. Do not switch branches through unrelated changes.
3. Name it `<prefix>/<kebab-slug>`, prefix from {feature, fix, chore, hotfix} matched at the start of the input, default `feature`.
4. When you create a branch inside an open record's turn, pipe a progress line into `.hermit/bin/hermitd-run task note .hermit <id>`; otherwise skip the note: `[HH:MM] created branch <name> from <base>`.

## Technical Constraints

Execution state lives in `.hermit/state/execution.json`; commitments live in task records. Use core task commands to read or update records.

Files in the operator's project follow that project's conventions; hermit knowledge and proposals follow their owning skills.

<!-- resident-only -->
## Before Archiving a Task

- If the task includes publishing a PR: PR opened, URL in the Progress Log.
- If committing is authorized and required by the task: intended changes committed on the feature branch. Otherwise, record the uncommitted handoff without staging unrelated work.
- If partial: Session Summary describes what remains.

## Dev Session Hygiene

Record multi-step work as ordered steps in the Progress Log, one timestamped entry per step; trivial single-step work needs none. Keep the Progress Log compact — summarize older entries once it grows long.

## Dev Knowledge

Durable dev artifacts (architecture decisions, health assessments, review-pattern summaries, dependency audits) go to `compiled/`; ephemeral inputs (CI logs, snapshots under analysis) go to `raw/`. Lessons and patterns go to auto-memory — don't duplicate them into `compiled/`. Consult the project's `knowledge-schema.md` before writing any `compiled/` artifact.

## Dev Proposal Categories

Use these prefixes in proposal titles for consistent sorting:
- **[missing-tests]** — Uncovered code paths
- **[tech-debt]** — Code that works but should be refactored
- **[dependency]** — Stale, vulnerable, or unnecessary deps
- **[tooling]** — Missing linter rules, CI checks, dev scripts
- **[architecture]** — Structural improvements

All dev proposals must pass the core three-condition gate (repeated pattern, meaningful consequence, operator-actionable); `/hermitd-dev:domain-brainstorm` ideas are single-pass, so the recurrence condition is waived.

Tier mapping:
- **Tier 2** (micro-approval): `[tech-debt]`, `[tooling]`, `[dependency]` updates
- **Tier 3** (full PROP-NNN): `[missing-tests]`, `[architecture]`, `[dependency]` removals

## Dev Quick Reference

- One-time setup / re-config: `/hermitd-dev:hatch`
- Cleanup pass: `/simplify` (parallel reviewers, applies its own edits)
<!-- /resident-only -->
<!-- /hermitd-dev: Development Workflow -->
