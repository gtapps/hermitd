# Repository guidelines

Before changing a plugin, read its `plugins/<slug>/AGENTS.md`. Load only the guides for the work in scope. Local guides add constraints to these repository rules; detailed inventories and procedures belong in READMEs, docs, or skills. Keep AGENTS.md and CLAUDE.md independently readable, with no extra instruction-file hop between harnesses.

## Repository and architecture

- Seven independently versioned Claude Code plugins live under `plugins/<slug>/`, each owning its manifest, code, templates, tests, and changelog. `.claude-plugin/marketplace.json` is the sole catalog; `README.md` is the marketplace overview.
- Hermit runs continuously inside Claude Code. Evaluate features for downstream chat operators, not only this repository's development workflow. Do not use this development hermit's session history as evidence of core feature utility. Check Claude Code documentation and the plugin catalog before adding a capability; when one already covers it, link to it instead of reimplementing.
- Domain plugins depend on core. Core discovers siblings generically from metadata; it must not import siblings, hardcode their slugs in logic, or branch on their installation. Siblings use core commands with an appropriate version floor instead of importing core code. Preserve `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/plugin.json` discovery.
- Domain plugin `skills/`, `agents/`, `state-templates/`, and `docs/` carry core-facing terminology; sweep them when core wording changes.
- Keep `required_core_version` and `requires` in `.claude-plugin/hermit-meta.json` synchronized with `plugin.json` dependencies. Internal `hermit.*` extensions belong in hermit-meta.json. Raise `min_claude_code_version` when relying on newer host behavior; do not add old-host shims.

## Authoring contracts

- **Model-facing prose:** Follow Anthropic's [skill authoring guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). After compaction Claude Code [re-attaches only a skill's first 5,000 tokens](https://code.claude.com/docs/en/skills), so the rules every run needs come first and conditional detail goes in supporting files linked directly from `SKILL.md`. Evaluate skills on every model intended to use them.
- Keep schemas, permissions, hook protocols, and command interfaces strict; keep operator-authored content flexible and upgrade-safe. Features default on except those requiring credentials/configuration, real per-invocation spend, or destructive actions. Cover new and existing installations.
- Skills state the present inputs, goal, workflow, and result. Keep history in changelogs or code comments and branch-specific detail in referenced sibling files. Use fully namespaced plugin agent references.
- Hook stdout, tool output, and skill-driven reads enter operator context. Use scripts for deterministic work and bounded log/database summaries; do not ask the model to read unbounded state or reproduce calculations. Print verdict-sized digests, and add always-loaded instructions only when their recurring behavioral value justifies the context cost.
- Core's `scripts/domain-hatch.ts` and `lib/domain-hatch/` own target resolution and `state/hatch-options.json`. Consumers use `domain-hatch preflight` and `ensure-target`; read those contracts before changing routing.
- Before changing plugin storage or routine registration, read [the storage contract](plugins/hermitd/docs/plugin-hermit-storage.md) or [routine authoring](plugins/hermitd/docs/routine-authoring.md), respectively.

## Development and verification

Use strict TypeScript targeting Bun, two-space indentation, single quotes, and semicolons. Shipped TypeScript uses standard-library/Bun APIs without runtime `node_modules` imports or a build step; root dependencies are development tooling. Hooks drain stdin fully and preserve their own failure contract, including intentional fail-closed safety gates.

From the root: `bun install --frozen-lockfile` installs tooling; `bunx tsc` checks TypeScript. For repository-wide verification, use `bun run test` with Bun 1.4 or newer. It handles plugin working directories, bounded parallelism, and shared root tests. For narrower changes, run the documented plugin suite inside `plugins/<slug>/`:

| Plugins | Suite |
|---|---|
| Core, Home Assistant, Feed | `bun test` |
| Dev, Fitness, Scribe, Forge | `bash tests/run-all.sh` |

Local guides cover special prerequisites. Behavior changes need regression coverage, the affected plugin's complete suite, and `bunx tsc`. Shared contract changes also need root `bun test tests/cross-plugin/ tests/lib/`. CI is path-filtered under `.github/workflows/`; root toolchain changes affect every suite. For docs-only changes, check references, effective scope, and applicable documentation contracts.

Use Context7 for library/API documentation, code generation, and setup/configuration guidance. Verify harness-dependent behavior with an isolated empirical probe before building on it, and report verification gaps. For Claude Code probes, use the installed `probe` skill for the procedure and model choice; live evidence takes precedence over documentation, memory, or assumptions. Consult [Auto-mode Classifier](plugins/hermitd/docs/security.md#auto-mode-classifier) when working on Claude Code permissions. Preserve unrelated work and choose the smallest demonstrated fix.

## Commits and releases

- Use Conventional Commit subjects and `fix/<issue>-<slug>`, `feat/<issue>-<slug>`, or `chore/<slug>` branches targeting `main` with regular merges. Omit the issue number when none exists.
- Shipped behavior gets a terse plugin `[Unreleased]` entry under `### Added`, `### Changed`, or `### Fixed`: plain sentence-case bullets, no component prefixes, leading verbs, or file tables; backtick commands and paths. Root-only and docs-only changes get no changelog entry; their rationale belongs in the commit/PR instead. Use plain technical language without em dash punctuation.
- `### Upgrade Instructions` contains executable migration steps for installed project state, never edits to the plugin tree. Preserve operator edits.
- Releases/version bumps are operator-initiated; do not suggest or start them without a request. Tags use `<slug>--vX.Y.Z`. Installed users update when `plugin.json`'s version changes; new installs and direct-source tests can see `main` immediately, so keep it working.
- PRs explain behavior and rationale, affected plugins, the public issue, and verification. Keep local proposal IDs out of changelogs, commits, PRs, and branch names. Keep private session/transcript content and Claude Code session, share, or session-tied artifact URLs out of all externally visible surfaces.

## Worktrees and environment

- Launch Claude Code from the repository root.
- `git rev-parse --show-toplevel` is the editing boundary. From a linked worktree, do not `cd` into, edit, or use `git -C` on the main checkout or sibling worktrees. The shared main-rooted `.hermit/` path is the exception: it is ignored live state, not a test fixture; touch it only for authorized operational work.
- Old standalone Dev and Home Assistant repositories are redirect-only; do not push code there. Use `git log --first-parent` for monorepo history because subtree imports are unsquashed.
- Credentials belong in ignored `.env` or `.claude.local/` files, never checked-in `.claude/` configuration or diagnostic output. Docker mounts preserve the host's absolute repository path. Use explicit working directories for commands and tests.
- Use `rm -r`, never `rm -rf`, for scratch cleanup.

## Graphify

- Use the installed graphify skill for `/graphify`. For codebase questions, query the relevant graph first when present; use `path` for relationships and `explain` for concepts. Verify answers against current source.
- Single-plugin queries pass `--graph plugins/<slug>/graphify-out/graph.json`. The root graph covers root scripts, cross-plugin tests, and marketplace metadata. Dirty generated graphs are expected; use `wiki/index.md` for navigation and `GRAPH_REPORT.md` for broad architecture work.
- After code changes, a pull, or when the graph predates the last commit, run `bash scripts/graphify-refresh.sh` (`bun run graph` is an alias). Inspect per-target failures because the wrapper continues. It refreshes root/plugin AST graphs and skips linked worktrees.
- Worktrees start without graphs. Use source search there, or `graphify update .` when a branch-local graph is needed.
