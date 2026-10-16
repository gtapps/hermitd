# hermitd (monorepo)

This repo is a multi-plugin Claude Code marketplace. Seven plugins ship from `plugins/<slug>/`, each with its own `CLAUDE.md`, `CHANGELOG.md`, and `tests/`. `.claude-plugin/marketplace.json` is the only marketplace; the root README is the canonical hermit pitch.

Always launch Claude Code from this repo's root. A plugin dir's own `.claude-plugin/` would load the plugin under test as the project plugin.

## Conventions

- **Model-facing prose:** Follow Anthropic's [skill authoring guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). After compaction Claude Code [re-attaches only a skill's first 5,000 tokens](https://code.claude.com/docs/en/skills), so the rules every run needs come first and conditional detail goes in supporting files linked directly from `SKILL.md`. Evaluate skills on every model intended to use them.
- **Repository-wide tests:** use `bun run test` from the root with Bun 1.4 or newer. It handles plugin working directories, bounded parallelism, and shared root tests. For narrower changes, run the documented suite inside the plugin dir (`bun test` for core, HA, and Feed; `bash tests/run-all.sh` for Dev, Fitness, Forge, and Scribe).
- **Independent versioning, tag `<slug>--v<X.Y.Z>`.** Domain plugins declare core compat as `required_core_version: ">=X.Y.Z"` in `.claude-plugin/hermit-meta.json`, mirrored by `requires` there and `dependencies` in `plugin.json`; `required_core_version` is what `doctor-check.ts` reads. Update all three together. All hermit-internal manifest extensions (`hermit.*`) live in hermit-meta.json.
- **CC-version-gated work bumps the floor, never shims around it.** When a change depends on Claude Code behavior introduced at a version, raise that plugin's `min_claude_code_version` in hermit-meta.json; no feature detection or fallback paths for older CC.
- **Dependency direction is one-way**: domain plugins depend on core; core never imports a sibling, hardcodes a sibling slug in logic, or branches on one being installed. It discovers siblings generically (name-contains-`hermit`) and consumes only what they declare in `hermit-meta.json`. Siblings can't import core either: shared logic ships as a `hermitd-run` verb behind a `required_core_version` floor.
- **Reuse native Claude Code features before building.** Check the docs (https://code.claude.com/docs) and plugin catalog for a feature that already covers a capability; on overlap, link to it instead of reimplementing.
- **Ship mechanism, not policy (all plugins)**: contracts stay strict, content stays loose. An installed hermit belongs to its operator, so give skills data + goal + voice and let the model compose, and anything operator-editable must survive `hermit-evolve`. Contract list, extension points, and how skill text is written: `plugins/hermitd/CLAUDE.md` § Authorship layers.
- **Ship standard: default-on, research preview.** Default off only for features needing an operator credential/config, real per-invocation spend, or that are destructive.
- **Agent references in skill text use the full namespaced form** (`<plugin>:<agent-name>`). The harness namespaces bare names at load, so a bare name in skill text fails with "Agent type not found".
- **Domain plugins carry core-facing wording** in `skills/`, `agents/`, `state-templates/`, and `docs/`; when core terminology changes, sweep all of them.
- **Token discipline (all plugins)**: hook stdout, skill-driven `Read`s, helper-script output, and native tool results all land in the operator's context, and every tool call re-reads that context from cache, so cache traffic dominates an always-on hermit's spend. Print verdict-sized digests; front unbounded surfaces (JSONL logs, DBs) with a script that returns a bounded summary. Always-loaded files (this one, plugin `CLAUDE.md`s, `CLAUDE-APPEND` blocks) are paid every session and re-seeded into every subagent, so a new bullet has to change behavior often enough to earn its place. Pattern and examples: `plugins/hermitd/CLAUDE.md` § Development.
- **Helper-script output follows Claude Code's conventions (all plugins)**: exit 0 for every expected outcome, exit 1 only for a real failure (the Bash tool reports any other exit 1 as a failure). Data is one whole-stdout JSON object; keys, `status` values and `reason`/`error` tokens are snake_case. An alternative outcome is `{"status":"<value>","reason":"<token>"}`; a verb with nothing to report prints bare `OK`; a failure prints `{"error":"<token>[:detail]"}`. No positional pipe lines. Hooks keep the hook contract; Monitor and shell-parsed lines and operator-script protocols (routine gate `SKIP`/`WAKE`, expiry probes) keep their grammar.

## Commits

- `/commit` accumulates `[Unreleased]` CHANGELOG entries; `/release <slug>` promotes them and is the ship event. Root-scope edits and docs-only changes (README, `docs/`, `CLAUDE.md`, comments) get no CHANGELOG bullet; a bundled docs correction goes in the commit message instead.
- **Changelog style: terse like [Claude Code's CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).** `### Added / Changed / Fixed` headers, plain sentence-case bullets with no leading verb or component prefix, backticks for commands and paths, no `### Files affected` tables. Rationale goes in the commit and PR. Only `### Upgrade Instructions` is verbose: `hermit-evolve` executes it step by step.
- **`/release` and `/fleet-release` are operator-initiated.** Never suggest them in plans, summaries, or next steps. `/release-status` is read-only and fine to suggest.
- **Proposals (`PROP-NNN`) are local bookkeeping.** Never mention one in a CHANGELOG entry, commit, PR, or branch name; describe the change on its own terms.
- **Never publish Claude Code session URLs** (session, share, or session-tied artifact links) in any externally visible surface. This is a public repo.

## Branching

- **PR `fix/<N>-<slug>` / `feat/<N>-<slug>` / `chore/<slug>` branches to `main`**, `<N>` the GH issue number (omit if none). Regular merge.
- **Main is safe as staging.** `/plugin update` only fires when `version` in `plugin.json` changes ([docs](https://code.claude.com/docs/en/plugins-reference#version-management)), so commits on `main` between releases are invisible to installed operators. Brand-new installers and `--plugin-dir` testers get `main` HEAD, so don't leave it knowingly broken for long.
- **Worktree discipline (`claude --worktree`).** The repo root is the worktree (`git rev-parse --show-toplevel`). Never `cd` into, edit, or `git -C` the main checkout or a sibling worktree. The one shared main-rooted path is `.hermit/` (gitignored hermit state). The dev-hermit `worktree-boundary-guard` hook hard-blocks escapes.

## Layout gotchas

- **Sibling-scan pattern**: `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` resolves to `plugins/*/...` and finds every fleet plugin.
- **Old standalone repos are redirect-only zombies**: `gtapps/claude-code-dev-hermit` and `gtapps/claude-code-homeassistant-hermit` redirect here via `git-subdir`. Do not push code there.

## graphify

- **Single-plugin questions (most) pass `--graph plugins/<name>/graphify-out/graph.json`.** The root graph is dominated by core's test harness and never reaches a single-plugin answer. Use the root graph only for `scripts/`, `tests/cross-plugin/`, `marketplace.json`, or cross-plugin questions.
- **Refresh with `bun run graph`** after a pull or when the graph predates the last commit: a stale graph answers confidently about deleted code.
- **Worktrees start with no graph on purpose** (a copied graph would predate the branch work); `hook-guard` no-ops and grep is always correct. `graphify update .` inside a long-lived worktree builds one that includes the branch. `bun run graph` refuses to run in a worktree.

## Environment quirks

- **Secrets:** env vars → `.env`; secret files (`.pem` etc.) → `.claude.local/`. Both gitignored. Never `.claude/`, which is checked in.
- **Docker paths mirror the host** (`${PWD}:${PWD}` mount): absolute paths are identical inside the container.
- **`rm -rf` is a native deny.** Use `rm -r` for scratch cleanup. Obfuscated forms are classifier-watched, not a second permission engine.
- **Subtree imports are unsquashed**: `git log --first-parent` for the monorepo-only view.
- **CI is path-filtered per plugin** under `.github/workflows/`; root-file changes (`package.json`, `bun.lock`, `tsconfig.json`) trigger every suite.
- **Shell `cd` persists across Bash calls.** Plugin test runners end inside `plugins/<slug>/`, and CWD-relative scripts like `heartbeat-precheck.ts .hermit` then fail silently. Use absolute paths or prefix `cd "$(git rev-parse --show-toplevel)" && …` (never a hardcoded path).

## Verification

- **Confirm Claude Code's own behavior empirically before building on it**, with `/probe`: it owns the tmux session, the sentinel-verdict protocol, and the model choice. Live behavior wins over docs, memory, or assumption; a contradiction is the finding. Under `--plugin-dir`, skills load at session start (relaunch or `/reload-plugins` to test edited skill text).
- **Auto mode suspends wildcarded-interpreter `permissions.allow` rules** (e.g. `Bash(bun */scripts/*.ts*)`), so a hermit's sealed script allow-list buys nothing there. Details: `plugins/hermitd/docs/security.md` § Auto-mode Classifier.

## Rules

- Always use Context7 for library/API documentation, code generation, and setup/configuration steps, without waiting for an explicit request.
- Don't overengineer: the minimum change that solves the task, nothing speculative.
- **This hermit is the plugin-dev special case.** When judging the utility of a feature in `plugins/hermitd/`, don't use this hermit's session history as evidence; target users are downstream operators on Discord/Telegram who don't open feature branches.
