# Contributing to hermitd

## Filing an Issue

Bugs and ideas go through the [issue forms](https://github.com/gtapps/hermitd/issues/new/choose). Questions and install help are faster in [Discord](https://discord.gg/54sJqAxhUh).

The rest of this guide is for code changes.

## Design Constraints

These are non-negotiable. Read them before making any changes.

- **No runtime dependencies.** Nothing under `plugins/` may import from `node_modules` outside `*.test.ts` — shipped code uses Bun built-ins and `node:*` stdlib only. The repo-root `package.json` exists for the dev toolchain (`bunx tsc`, test-only fuzzing); it is not an opening to add runtime deps.
- **No build step.** Skills are plain markdown. Hooks are standalone `.ts` / `.sh` scripts.
- **Hooks fail open.** A hook must never block Claude Code. Catch errors, `process.exit(0)`. Never exit non-zero on transient failures.
- **Consume stdin.** Every hook must read stdin to completion even if unused, to avoid broken pipe errors from Claude Code.
- **No third-party test framework.** Tests run on Bun's built-in runner (`bun test`) or a plain bash script. Don't add Jest, Vitest, or anything else.

## Repo Layout Note

The `.claude/` directory contains repo-local development agents and skills (release automation, validation, test runners). These are maintainer tooling for this repo — separate from the plugin's deliverable `agents/` and `skills/` directories that get installed into user projects.

## Local Development

Test the plugin against a target project using `--plugin-dir`:

```bash
cd /path/to/your-project
claude --plugin-dir /path/to/hermitd
```

Then run `/hermitd:hatch` to create the state directory. Edits to skills, hooks, and scripts take effect immediately — no restart needed.

### Testing a branch via marketplace install

`--plugin-dir` bypasses the marketplace resolver entirely. If you need to verify that a plugin surfaces correctly through the normal install path (e.g. when onboarding a new plugin that doesn't exist on `main` yet), point a project-scoped marketplace at your local checkout instead:

```bash
# In the target project — your monorepo checkout must be on the branch under test
claude plugin marketplace add /path/to/hermitd --scope project
claude plugin install hermitd-fitness@hermitd --scope project
```

The `@hermitd` suffix disambiguates when both a user-scoped and a project-scoped marketplace share the same name. Remove the project marketplace when done (`claude plugin marketplace remove hermitd --scope project`).

## Testing

Run all eight plugin suites and the shared root tests with Bun 1.4 or newer:

```bash
bun run test
```

The runner uses bounded, isolated file workers for core alongside the other
plugins. Each plugin's result appears when it finishes. Failures retain the full
logs at the printed path; successful runs remove their temporary logs. Home
Assistant's historical safety corpus requires Python with `python-dotenv` and
`PyYAML`; set `GATE_PARITY_PYTHON` if that interpreter is outside PATH.

For a core-only change:

```bash
( cd plugins/hermitd && bun test )
```

For HA-hermit changes:

```bash
( cd plugins/hermitd-homeassistant && bun test )
```

See [Testing](plugins/hermitd/docs/testing.md) for hook test details, fixtures, manual testing, and how to write new tests.

## PR Workflow

### Branching

- **Default: PR feature branches to `main`.** Use Conventional-Commits prefixes — `fix/<N>-<slug>`, `feat/<N>-<slug>`, or `chore/<slug>` (`<N>` is the GH issue number, omit if no issue; `<slug>` is a short kebab-case descriptor). Examples: `fix/44-self-update-race`, `feat/57-cortex-tagging`, `chore/upgrade-node-24`. Regular merge to `main`.
- **`main` is safe as staging.** Claude Code's `/plugin update` only fires when `version` in `plugin.json` changes ([docs](https://code.claude.com/docs/en/plugins-reference#version-management)) — and `version` only bumps when a maintainer runs `/release <slug>`. Commits merged to `main` between releases are not pushed to operators on the standard install path. Each plugin's `CHANGELOG.md` accumulates entries under `## [Unreleased]` until release time.
- **Exception — plugin-scoped batching branch.** For explicit multi-commit features where `main` HEAD shouldn't sit half-built, branch as `<short-slug>/vX.Y.Z` (e.g. `hermit/v1.0.36`). Most contributions don't need this — when in doubt, target `main`.

### Steps

1. Create a feature branch off **fresh** `origin/main`: `git fetch origin && git switch -c fix/<N>-<slug> origin/main`. A stale local `main` is the usual cause of a conflicting PR. If `main` moves while your PR is open, rebase onto it.
2. Run `/release-status` for a read-only pipeline snapshot (flags stale `required_core_version`, shows what's awaiting tag)
3. Make changes — one concern per PR. An unrelated fix riding along turns a clean merge into a conflict resolution.
4. Run the affected plugin's suite to completion and `bunx tsc --noEmit` from the repo root. Both green before you push. If you couldn't finish a run, say so in the PR rather than leaving it out.
5. Add a bullet to the affected plugin's `CHANGELOG.md` under `## [Unreleased]` — the maintainer promotes it to a real version at release time. See [Changelog Entries](#changelog-entries). (If you're using Claude Code with the repo's local skills, `/commit` does this automatically.)
6. Push — CI runs the same tests

### Changelog Entries

Terse, like [Claude Code's own CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).

- Keep the `### Added` / `### Changed` / `### Fixed` headers. The header supplies the category, so the bullet doesn't repeat it — no leading "Fixed", no `- **component:**` prefix.
- One or two lines, sentence case, describing what changed for an operator. Backticks for commands, paths, and flags.
- Rationale, debugging notes, and design tradeoffs go in the commit message and PR description, not the bullet. No "Files affected" tables.
- **Docs-only changes get no bullet.** README, `docs/`, `CLAUDE.md`, and comment edits aren't something an operator experiences as a shipped change. When a PR bundles a code fix with a docs correction, only the code fix earns a bullet.
- Root-scope edits (CI, root README, `.claude/`, the marketplace manifest) skip the changelog entirely — they don't ship to operators.

### Stale and Conflicting PRs

- **A PR that goes conflicting gets a rebase request.** Rebase onto current `main` rather than merging `main` into your branch, so the PR stays a clean set of commits.
- **A conflicting PR with no movement may be closed.** That isn't a rejection of the change. If the work is still wanted, a maintainer opens a superseding PR that preserves your commits and authorship, and both PRs link to each other.
- **Check that your base didn't drift under you.** A PR branched weeks ago can merge cleanly and still revert newer work. Rebasing surfaces that; a green CI run on a stale base does not.

## Adding a New Hermit

This repo is a multi-plugin marketplace. The catalog lives at the repo root in `.claude-plugin/marketplace.json`; each entry's `source` field tells Claude Code where to find the plugin. Three patterns are supported:

1. **In-repo, first-party** — `"source": "./plugins/<name>"`. Plugin code lives under `plugins/<name>/`. Use when you have direct push access and want coordinated releases with the rest of the fleet (the existing core, dev-, and HA-hermits all use this).
2. **In-repo, vendored** — `"source": "./external_plugins/<name>"`. Contributor's code, kept in-repo as a synced copy for distribution stability. Use when someone else owns the upstream but you want a known-good version pinned in this marketplace.
3. **Remote git ref** — `{"source": {"source": "github", "repo": "<owner>/<repo>"}, ...}`. Contributor owns their own repo and ships on their own cadence; this monorepo merely catalogs the entry. Use when the plugin author wants to keep ownership and release independently.

To add a first-party (pattern 1) hermit:

1. Create `plugins/<your-hermit>/` with `.claude-plugin/plugin.json` (set `name`, `version`, `description`, `author`) and `.claude-plugin/hermit-meta.json` (set `required_core_version`, `requires`).
2. Add the matching entry to the root `.claude-plugin/marketplace.json` `plugins[]` array — keep `name`, `version`, and the URL fields in sync.
3. Add tests under `tests/` (bun test `*.test.ts` files, or a `tests/run-all.sh` runner — see the per-plugin pattern below).
4. Cut releases via `/release <your-hermit>` — the skill bumps versions in both manifest and marketplace, tags as `<your-hermit>-vX.Y.Z`, and pushes.

## The `required_core_version` Convention

Every plugin in this fleet that depends on the core hermit declares three version fields that must stay in sync:

**`.claude-plugin/hermit-meta.json`** (hermit-internal; not validated by `claude plugin tag`):
```json
"required_core_version": ">=1.0.21",
"requires": { "hermitd": ">=1.0.21" }
```

**`.claude-plugin/plugin.json`** (native Claude Code resolver field):
```json
"dependencies": [{ "name": "hermitd", "version": "^1.0.21" }]
```

`required_core_version` is the canonical fleet contract. It is read by the core plugin's `hermit-doctor` (the `dependencies` check) and `hermit-evolve`, and by external/third-party hermits that live outside this monorepo. The parallel `requires.hermit` field mirrors it — the two must agree, and `tests/hooks.contract.test.ts` enforces this on every CI run (test `sibling manifests: required_core_version vs requires consistency`). When you bump one, bump all three.

When releasing core and a domain plugin together, use `/fleet-release` — it updates all three fields automatically after the core prep commit, before the domain plugin's release runs.

## Per-Plugin Test Runner Pattern

Each plugin owns its own test entry point. Two conventions ship:

- **`bun test`** (core and HA) — run from the plugin dir; auto-discovers `tests/*.test.ts`, no runner script. `plugins/hermitd/` and `plugins/hermitd-homeassistant/`. See [`docs/testing.md`](plugins/hermitd/docs/testing.md) for fixtures and how to write new tests.
- **`bash tests/run-all.sh`** (dev, fitness, scribe, forge) — a bash entry point that returns non-zero on any failure. Forge's runner also installs the PHP/composer deps its suite needs.

CI runs each plugin's suite from its own directory (paths-filtered so unrelated plugin edits don't trigger every workflow). New plugins should follow one of the two conventions above, plus a paths-filtered GitHub Actions workflow under `.github/workflows/`.
