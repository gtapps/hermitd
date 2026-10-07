# Changelog

## [Unreleased]

### Fixed
- `file-issue.ts` honours `HTTPS_PROXY` and `NO_PROXY`, so GitHub API calls no longer time out on hosts whose only egress is a proxy.

## [0.1.8] - 2026-10-02

### Changed
- The plugin is named `hermitd-scribe` in the `hermitd` marketplace, with namespaced skills and core commands updated to match.

## [0.1.7] - 2026-09-28

### Fixed

- Issue commands resolve the bundled script through the skill directory.

## [0.1.6] - 2026-09-16

### Changed

- Core 1.4.0 is required for task records and resident startup.

## [0.1.5] - 2026-09-12

### Changed

- Hatch no longer seeds `autoMode.environment`; Claude Code does not read it from project settings. Existing `autoMode` blocks in project settings are unread and left in place.

## [0.1.4] - 2026-09-10

### Changed

- Issue filing and commenting request native approval after the sanitized preview, replacing the in-chat yes/edit/cancel loop.
- Filing an issue takes an explicit `--publish` verb: `file-issue.ts --publish <title-file> <body-file> [label...]`. It was previously the unnamed fallthrough, which no permission rule could distinguish from the read modes.

### Fixed

- Publication approval rules are installed into project settings during hatch and upgrades, where Claude Code enforces them.

### Upgrade Instructions

Resolve the project settings target with `.claude-code-hermit/bin/hermit-run domain-hatch preflight hermit-scribe`: `target` (or `target_default` when absent) maps `local` to `.claude/settings.local.json` and `committed` to `.claude/settings.json`. Run `bun <plugin_root>/scripts/native-permissions.ts <resolved-settings-file>` before refreshing the installed instruction block. If installation fails, stop the upgrade.

Refresh the installed CLAUDE-APPEND block. Any operator script calling `file-issue.ts` with bare positional arguments must add `--publish`; without it the script now exits 1 with usage rather than filing.

## [0.1.3] - 2026-09-06

### Added
- The operator preview now notes when the target repo defines issue templates under `.github/ISSUE_TEMPLATE/`, via a new `file-issue.ts --templates` mode. Informational only — the body still follows hermit-scribe's fixed shape.

### Fixed
- The `issue-sanitizer` subagent redacted the `proposal={id}` dedup anchor as operator-project detail before it ever reached GitHub, so `--check` could never match a filed issue back to its proposal. The footer is now appended after sanitization instead of before it.
- `issue-sanitizer` now refuses (`TITLE: (refused)`) instead of fabricating an issue when handed a file reference instead of an inline draft.

## [0.1.2] - 2026-08-31

### Changed
- `hatch` is operator-invoked only through `disable-model-invocation`, so it runs only when the operator types `/hermit-scribe:hatch`.

## [0.1.1] - 2026-07-26

### Fixed
- `hatch` wrote no `config.json` at all, so its CLAUDE-APPEND block was invisible to `hermit-evolve`'s registry-driven sync, and re-running `hatch` skipped unconditionally whenever the marker was already present — contradicting its own frontmatter promise ("re-run to refresh after an upgrade"). `hatch` now stamps `_hermit_versions["hermit-scribe"]` in `config.json` and version-gates the block refresh the same way the other domain hatches do.

### Changed
- Requires core `>=1.2.34`; upgrade core with `/claude-code-hermit:hermit-evolve` before installing or running this release.
- The CLAUDE-APPEND template gained a closing marker (`<!-- /hermit-scribe: Issue Filing -->`), so `hermit-evolve`'s block bounds are exact instead of heuristic.
- The block names "the configured target repo" instead of the `HERMIT_GH_REPO` env var, and states sanitization as a rule rather than naming the subagent that performs it. Filing-through-the-skill and the operator-confirmation rule are unchanged.

## [0.1.0] - 2026-07-06

### Added
- First `hatch` skill appends an Issue Filing block to `CLAUDE.md` or `CLAUDE.local.md` and scopes `api.github.com` to `HERMIT_GH_REPO` in `autoMode.environment`.
  Filing still requires the skill's in-session preview and confirmation gate.

## [0.0.6] - 2026-07-03

### Changed

- Issue type, scope, labels, and Conventional Commits title derivation now run through the deterministic, unit-tested `file-issue.ts classify` subcommand instead of `SKILL.md` prose.

## [0.0.5] - 2026-06-12

### Added

- Issue labels now derive from proposal `category` (`bug`, `chore`, or `enhancement`) and a resolved single-plugin scope, alongside the existing `hermit-filed` label.

### Changed

- `file-issue.js` became typed ESM in `file-issue.ts`, run with Bun; related usage, skill, documentation, and test references now use Bun.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` and `file-issue.ts` (renamed from `file-issue.js`; now runs with `bun`).

No `config.json` changes required.

---

## [0.0.4] - 2026-05-31

### Added

- `node file-issue.js --comment <issue-number> <body-file>` posts through the same App identity and prints the comment URL on success.
- Comment requests now sanitize content, show an operator preview, post, and report the URL; they skip deduplication and proposal back-writes.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` with the comment activation patterns and comment flow.

No `config.json` changes required.

---

## [0.0.3] - 2026-05-14

### Changed

- Proposal-backed issues now use Conventional Commits titles (`feat(scope):`, `fix(scope):`, or `chore(scope):`) derived from `category` and inferred scope; ad-hoc titles remain unchanged.
- Operator previews now inline the full body and end with the confirmation prompt, including when content requires split messages.
- `edit` confirmations now enter a loop that applies requested changes, re-renders the preview, and asks again.

### Added

- Issue titles and bodies are translated to English before filing while preserving technical identifiers, code, frontmatter, and proper nouns; local proposals remain untouched.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Update the skill** — pulls the revised `SKILL.md` with the new title format and preview flow.

No `config.json` changes required.

---

## [0.0.2] - 2026-05-14

### Fixed

- Invalid `HERMIT_GH_APP_KEY_FILE` paths now produce a labeled, actionable error instead of a raw JWT-signing `ENOENT`.

### Added

- `file-issue.js --check <proposal-id>` now finds open `hermit-filed` issues by their `proposal={id}` footer before filing, returning `0` and a URL when found or `2` otherwise.
- The `issue-sanitizer` agent now redacts personal and project-specific content, secrets, `.env` data, connection strings, internal hosts, and private URLs before filing, using `haiku` with low effort and two turns.
- Filing now shows the sanitized title and body for the operator to confirm, edit, or cancel.
- Successful filings now write `gh_issue: <url>` into proposal frontmatter for `/proposal-list` and cortex views.
- `hermit-meta.json` and `plugin.json` now declare the required `claude-code-hermit ^1.0.38` core dependency.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No config.json changes required.

---

## [0.0.1] - 2026-05-13

### Added

- Initial public release.

### Upgrade Instructions

No previous version; first install. See README for GitHub App setup prerequisites.
