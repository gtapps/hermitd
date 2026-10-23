---
name: commit
description: Changelog and commit — lightweight motion for day-to-day plugin dev work in the monorepo. One commit per plugin scope; CHANGELOG and staging routed by detected slug. Trigger when the user says "commit", "commit this", "save this", "wrap this up", "let's commit", or finishes a change and wants to capture it. NOT for releases, version bumps, or pushing — defer to /release for those.
---

# Commit

Detect which plugin's scope this change belongs to, append a changelog line in that plugin's CHANGELOG, then commit. No push, no tag, no version bump — that's `/release`'s job.

## Guardrails (check before starting)

- Clean tree (`git status` shows nothing) → stop and say so, nothing to commit.
- Detached HEAD, mid-rebase, or mid-merge → stop and ask the user to resolve that first.
- Never `--amend`, `--no-verify`, force-push, or create tags here.
- Never use `git add -A` or `git add .` — staging is path-scoped per step 0.
- If a pre-commit hook fails, fix the root cause and create a new commit — don't bypass the hook.
- **`main` is the default base for everyday work.** Claude Code's `/plugin update` only fires when `version` in `plugin.json` changes, so commits merged to `main` between releases are invisible to operators on the standard install path — `[Unreleased]` accumulates until `/release` ships them.

## Steps

### 0. Detect scope

First, two Bash calls: `git rev-parse --show-toplevel`, then `cd` to the path it printed, typed as a literal. The cwd persists across Bash calls, so a `cd` left by a plugin test run (they end inside `plugins/<slug>/`) makes the path-scoped `git add` in step 5 fail with a pathspec error. Do not fold the two into one command with a `$(git …)` substitution: in a worktree session the checker rejects any command that names git inside a substitution.

Then run `git status --porcelain` and partition the changed paths:

- Paths matching `plugins/<X>/...` → group by `<X>` (the slug).
- Paths outside `plugins/` (root README, `.github/`, `.claude/`, `.claude-plugin/marketplace.json`, root configs) → "root-scope" paths.

Then decide:

- **Single plugin slug, no root-scope paths** → set `$PLUGIN_DIR = plugins/<slug>/`, set `$SCOPE = plugin`. Continue.
- **Multiple plugin slugs touched** → stop. Print the per-slug file groups and ask the user to split the change into separate `/commit` runs (one per plugin). Do not stage anything.
- **Single plugin slug + a few root-scope paths** → ask the user via AskUserQuestion: "Bundle the root-scope files (`<list>`) into the `<slug>` commit, or split them out as a separate root-scope commit?" Default to splitting if uncertain.
- **Root-scope only (no `plugins/<X>/...`)** → set `$SCOPE = root`, `$PLUGIN_DIR = none`. Continue.

The rest of this skill branches on `$SCOPE`.

### 1. Review the diff

Run `git status` and `git diff HEAD` (or `git diff` if nothing staged yet). Scan for:
- Secrets or credentials (`.env`, API keys, tokens)
- Large binaries or generated files that shouldn't be versioned
- Unrelated files that shouldn't be bundled in this commit

If anything suspicious appears, pause and ask the user before continuing.

### 2. Run /simplify on the change

Invoke native `/simplify`, scoped to the paths from step 0 (the change about to be committed). Wait for completion before continuing.

This is not optional and has no diff-size or file-type exemption: a markdown-only change, a one-line fix, and a 300-line refactor all get the pass. Skip it only when the user explicitly passes `--no-simplify` or says in so many words to skip the cleanup — never on your own judgement that the diff looks too small or too trivial to be worth it.

If simplify applied edits, re-read them before continuing: they are auto-applied changes to the code you are about to commit, and they belong in the same commit as the work itself. Surface its report (or note that it found nothing) when you get to step 4.

### 3. Update CHANGELOG.md (skip for `$SCOPE = root`)

For `$SCOPE = root`: skip this step entirely. Root-scope edits (CI tweaks, root README, `.github/`) never ship to operators, so there is no operator-facing changelog to update.

For `$SCOPE = plugin`: open `$PLUGIN_DIR/CHANGELOG.md`. Find the `## [Unreleased]` section at the top. Under the correct sub-section (`### Added`, `### Changed`, or `### Fixed`), append one or more bullets that describe what changed and why. Create the sub-section header if it's missing. If `[Unreleased]` itself is missing, prepend it immediately after the `# Changelog` header.

Follow the changelog-bullet format defined canonically in root `CLAUDE.md` §Commits: a plain sentence-case line under the category header (`### Added`/`### Changed`/`### Fixed`), with no `**component:**` prefix and no leading Fixed/Added verb — the header carries the category. Backticks for commands/paths/flags; 1–2 lines each. Content that doesn't obviously affect operator behavior belongs in the commit message body, not here. Upgrade Instructions accumulate in `[Unreleased]` with the change, following `/release` step 3; `hermit-evolve` executes the steps and collects leftover-check declarations.

**One header per section.** `[Unreleased]` contains at most one each of `### Added`, `### Changed`, `### Fixed` (and `### Removed`/`### Security` when used). Append bullets under the existing header — never create a second copy of a header that already exists. Parallel worktree branches each adding their own headers is how the section fragments at merge time; if you find duplicate headers already present (left by earlier merges), consolidate them into one while you're in the file — same for a duplicated `### Upgrade Instructions` list (merge, dedupe, renumber). `/release-status` flags this as `fragmented changelog`.

Do not create a new version header (`## [X.Y.Z]`). That belongs to `/release`.

### 4. Draft the commit message

Write a short imperative first line (≤72 chars). Add a body only if the why isn't obvious from the diff. Show the proposed message to the user and wait for approval.

### 5. Commit

Once approved, stage path-scoped (never `-A`):

- `$SCOPE = plugin`: `git add $PLUGIN_DIR` (plus any root-scope paths the user opted to bundle in step 0).
- `$SCOPE = root`: `git add` each root-scope path explicitly enumerated from step 0.

Then commit:

```bash
git commit -m "$(cat <<'EOF'
<message here>
EOF
)"
```

Report the resulting commit hash. Do not push, do not tag.
